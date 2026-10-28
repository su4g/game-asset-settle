'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),os=require('node:os');
const {randomUUID}=require('node:crypto'),{Client}=require('pg');
const {Store}=require('../server/store.cjs'),{project}=require('../server/accounting.cjs'),{createServer}=require('../server/index.cjs');
const record=extra=>({platform:'buff',appid:730,goodsId:'921475',name:'测试物品（久经沙场）',marketHashName:'Test Item (Field-Tested)',orderId:'order-1',platformAccountId:'buff:123',quantity:2,buyTotalCents:199,currencyCode:'CNY',boughtAt:'2025-01-01T01:00:00.000Z',deliveredAt:null,status:'待发货',...extra});
const entry=(source=record(),patch={})=>({source,confirmed:true,reviewed:{...source,...patch}});
test('BUFF buy history isolated PostgreSQL confirmation and deduplication',{skip:process.env.PG_INTEGRATION!=='1'},async t=>{
  const name=`buff_goods_test_buys_${process.pid}_${Date.now()}`;
  const config={host:process.env.PGHOST||'127.0.0.1',port:Number(process.env.PGPORT||5432),user:process.env.PGUSER||os.userInfo().username,password:process.env.PGPASSWORD};
  const admin=new Client({...config,database:'postgres'});await admin.connect();await admin.query(`CREATE DATABASE "${name}"`);
  const store=new Store({...config,database:name});let server;
  t.after(async()=>{if(server)await new Promise(r=>server.close(r));await store.close();await admin.query(`DROP DATABASE "${name}" WITH(FORCE)`);await admin.end();});
  await store.migrate();await store.migrate();
  const reset=()=>store.pool.query('TRUNCATE ledger_purchase_receipts,ledger_purchase_tasks,ledger_trades,ledger_audit CASCADE');
  const count=async table=>Number((await store.pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count);
  async function receiptTask(r=record()) {
    const task=await store.task({...r,execute:true,maxUnitPriceCents:100,requestKey:randomUUID()});
    const {leaseToken}=await store.claimPurchase(task.id);
    const pending={listingId:'listing',requestKey:randomUUID(),quantity:r.quantity,maxTotalCents:r.quantity*100};
    await store.checkpointPurchase(task.id,{leaseToken,platformAccountId:r.platformAccountId,journal:{state:'executing',pending}});
    return {id:task.id,fill:{platform:'buff',accountId:r.platformAccountId,appid:r.appid,marketHashName:r.marketHashName,fillId:r.fillId||'fill-1',orderId:r.orderId,quantity:r.quantity,totalCents:r.buyTotalCents,boughtAt:r.boughtAt,requestKey:pending.requestKey}};
  }
  await t.test('reading and preview write nothing; only selected and confirmed rows become knife holdings',async()=>{
    const result=await store.buySyncPreview([record(),record({orderId:'order-2'})]);
    assert.equal(result.persisted,false);assert.equal(result.rows.length,2);
    for(const table of ['ledger_trades','ledger_buy_imports','ledger_audit'])assert.equal(await count(table),0);
    await assert.rejects(store.buySyncConfirm([{...entry(),confirmed:false}]),{status:400});
    const saved=await store.buySyncConfirm([entry(record(),{buyTotalCents:198})]);assert.equal(saved.count,1);
    const state=project(await store.snapshot()),r=state.rows[0];
    assert.equal(state.rows.length,1);assert.equal(r.direction,'knife');assert.equal(r.confirmed,true);assert.equal(r.status,'awaiting_delivery');
    assert.equal(state.totals.buffBuyCents,198);assert.equal(state.totals.steamReceivedCents,0);assert.equal(state.totals.realizedCents,0);
    assert.equal((await store.snapshot()).settlements.length,0);assert.equal(state.wallets.length,0);
    assert.equal(r.original.buyTotalCents,199);assert.equal(r.buyTotalCents,198);
    await store.migrate();assert.equal(await count('ledger_buy_imports'),1);
  });
  await t.test('concurrent confirmation, rereading and edited retries preserve one cash purchase',async()=>{
    await reset();const results=await Promise.all([store.buySyncConfirm([entry()]),store.buySyncConfirm([entry()])]);
    assert.equal(results.reduce((n,r)=>n+r.count,0),1);assert.equal(await count('ledger_trades'),1);
    const retry=await store.buySyncConfirm([entry(record(),{buyTotalCents:1000})]);assert.equal(retry.count,0);assert.equal(retry.skipped.length,1);
    assert.equal(project(await store.snapshot()).totals.buffBuyCents,199);
    assert.equal((await store.buySyncPreview([record({platformAccountId:'buff:/user-center/123'})])).rows[0].status,'duplicate');
    assert.equal((await store.buySyncPreview([record({platformAccountId:null})])).rows[0].status,'duplicate');
  });
  await t.test('invalid selected row rolls back the entire confirmation; cancelled and missing metadata reject',async()=>{
    await reset();
    await assert.rejects(store.buySyncConfirm([entry(),entry(record({orderId:'bad'}),{quantity:0})]),{status:400});
    for(const patch of [{status:'已取消'},{status:'待付款'},{quantity:null},{buyTotalCents:null},{orderId:null},{marketHashName:''},{boughtAt:null}])await assert.rejects(store.buySyncConfirm([entry(record(patch))]),{status:400});
    assert.equal(await count('ledger_trades'),0);assert.equal(await count('ledger_buy_imports'),0);
    const source=record({orderId:null,quantity:null,buyTotalCents:null,currencyCode:null,marketHashName:'',boughtAt:null});
    const result=await store.buySyncConfirm([entry(source,record())]);assert.equal(result.count,1);
  });
  await t.test('manual entry requires explicit association or distinct-purchase decision; linking preserves money and account',async()=>{
    await reset();const r=record();const manual=await store.createTrade({...r,orderId:null,confirmed:true,snapshot:{platformAccountId:'buff:123'}});
    const s=record({platformAccountId:null});let preview=await store.buySyncPreview([s]);assert.equal(preview.rows[0].status,'possible_duplicate');
    await assert.rejects(store.buySyncConfirm([entry(s)]),{status:409});
    await assert.rejects(store.buySyncConfirm([{...entry(s,{buyTotalCents:200}),existingTradeId:manual.id,version:1}]),{status:409});
    const linked=await store.buySyncConfirm([{...entry(s),existingTradeId:manual.id,version:1}]);assert.equal(linked.count,0);assert.equal(linked.linkedCount,1);
    const data=await store.snapshot();assert.equal(data.trades.length,1);assert.equal(data.trades[0].snapshot.platformAccountId,'buff:123');assert.equal(data.trades[0].orderId,r.orderId);
    assert.equal(project(data).totals.buffBuyCents,199);
  });
  await t.test('association rejects stale versions and a deliberate distinct order can add a second purchase',async()=>{
    await reset();const manual=await store.createTrade({...record(),orderId:null,confirmed:true});
    await store.amendTrade(manual.id,{version:1,buyTotalCents:199});
    await assert.rejects(store.buySyncConfirm([{...entry(),existingTradeId:manual.id,version:1}]),{status:409});
    assert.equal(await count('ledger_buy_imports'),0);
    await store.buySyncConfirm([{...entry(),decision:'new'}]);assert.equal(await count('ledger_trades'),2);
  });
  await t.test('known separate accounts stay separate and order partial quantity never adds a duplicate',async()=>{
    await reset();await store.buySyncConfirm([entry()]);
    await store.buySyncConfirm([entry(record({platformAccountId:'buff:456'}))]);assert.equal(await count('ledger_trades'),2);
    await reset();await store.createTrade({...record(),quantity:1,confirmed:true});
    assert.equal((await store.buySyncPreview([record()])).rows[0].status,'order_conflict');
    await assert.rejects(store.buySyncConfirm([entry()]),{status:409});assert.equal(await count('ledger_trades'),1);
  });
  await t.test('automated receipt first then history never adds its cost again',async()=>{
    await reset();const task=await receiptTask();await store.purchaseReceipt(task.id,{fill:task.fill});
    const preview=await store.buySyncPreview([record()]);assert.equal(preview.rows[0].status,'duplicate');
    const result=await store.buySyncConfirm([entry()]);assert.equal(result.count,0);assert.equal(await count('ledger_trades'),1);
  });
  await t.test('history first then late automated receipt links to the same purchase',async()=>{
    await reset();const task=await receiptTask();const imported=await store.buySyncConfirm([entry()]);
    const result=await store.purchaseReceipt(task.id,{fill:task.fill});assert.equal(result.tradeId,imported.saved[0].id);
    assert.equal(await count('ledger_trades'),1);assert.equal((await store.purchaseTask(task.id)).result.filledQuantity,2);
    assert.equal((await store.purchaseReceipt(task.id,{fill:task.fill})).duplicate,true);
    assert.equal(project(await store.snapshot()).totals.buffBuyCents,199);
  });
  await t.test('late receipt with conflicting cash amount stops reconciliation without recording another purchase',async()=>{
    await reset();const task=await receiptTask();await store.buySyncConfirm([entry(record(),{buyTotalCents:198})]);
    await assert.rejects(store.purchaseReceipt(task.id,{fill:task.fill}),{status:409});
    assert.equal(await count('ledger_trades'),1);assert.equal(await count('ledger_purchase_receipts'),0);
    assert.equal((await store.purchaseTask(task.id)).result.filledQuantity,0);
  });
  await t.test('new HTTP endpoints retain authentication and explicit confirmation',async()=>{
    await reset();server=createServer({store,token:'buy-sync-test',extensionOrigins:['chrome-extension://test']});await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const post=(route,body,headers={Authorization:'Bearer buy-sync-test',Origin:'chrome-extension://test'})=>fetch(`http://127.0.0.1:${server.address().port}/v1/sync/buys/${route}`,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
    assert.equal((await post('preview',{records:[]},{})).status,401);
    assert.equal((await post('preview',{records:[]},{Authorization:'Bearer buy-sync-test',Origin:'https://buff.163.com'})).status,403);
    assert.equal((await post('preview',{records:[record()]})).status,200);assert.equal(await count('ledger_trades'),0);
    assert.equal((await post('confirm',{rows:[{...entry(),confirmed:false}]})).status,400);
    const result=await (await post('confirm',{rows:[entry()]})).json();assert.equal(result.result.count,1);
  });
});
