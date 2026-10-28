"use strict";
const test=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {Client}=require('pg');
const {Store}=require('../server/store.cjs');
const {project}=require('../server/accounting.cjs');
const {createServer}=require('../server/index.cjs');
const day=n=>new Date(Date.UTC(2025,0,n)).toISOString();
const input=(platform='buff',extra={})=>({id:randomUUID(),platform,appid:730,name:'测试物品',marketHashName:'Test Item (Factory New)',quantity:2,buyTotalCents:80000,boughtAt:day(1),deliveredAt:day(1),confirmed:true,...extra});
const sale=(version=1,extra={})=>({requestKey:randomUUID(),version,quantity:1,netTotalCents:50000,soldAt:day(2),receivedAt:day(2),...extra});

test('isolated PostgreSQL ledger, persistence and authenticated API', {skip:process.env.PG_INTEGRATION!=='1'},async t=>{
  const name=`buff_goods_test_${process.pid}_${Date.now()}`;
  assert.match(name,/^buff_goods_test_\d+_\d+$/);
  const config={host:process.env.PGHOST||'127.0.0.1',port:Number(process.env.PGPORT||5432),user:process.env.PGUSER||os.userInfo().username,password:process.env.PGPASSWORD};
  const admin=new Client({...config,database:'postgres'});await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  let store=new Store({...config,database:name}),server;
  t.after(async()=>{if(server)await new Promise(r=>server.close(r));await store.close();await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();});
  await store.migrate();await store.migrate();
  const reset=()=>store.pool.query('TRUNCATE ledger_sale_imports,ledger_audit,ledger_refunds,ledger_settlements,ledger_trades,ledger_wallet_events,ledger_purchase_tasks,ledger_price_snapshots,ledger_meta CASCADE');
  await t.test('800 → 1000 → 860 survives service restart; pending receipt never completes',async()=>{
    const a=await store.createTrade(input());
    const first=await store.settle(a.id,sale(1,{receivedAt:null}));
    let state=project(await store.snapshot());assert.equal(state.rows[0].status,'partial');assert.equal(state.wallets.length,0);
    await store.settle(a.id,sale(2));
    state=project(await store.snapshot());assert.equal(state.rows[0].status,'pending_receipt');assert.equal(state.wallets[0].balanceCents,50000);
    await store.amendSettlement(first.id,{version:first.version,receivedAt:day(2)});
    const b=await store.createTrade(input('steam',{quantity:1,buyTotalCents:100000,boughtAt:day(3),deliveredAt:day(3)}));
    state=project(await store.snapshot());assert.equal(state.totals.realizedCents,0);
    await store.settle(b.id,sale(1,{netTotalCents:86000,soldAt:day(4),receivedAt:day(4)}));
    await store.close();store=new Store({...config,database:name});
    state=project(await store.snapshot());assert.equal(state.totals.realizedCents,6000);assert.equal(state.wallets[0].balanceCents,0);
    const current=state.rows.find(x=>x.id===a.id);
    await store.amendTrade(a.id,{version:current.version,buyTotalCents:70000});
    assert.equal(project(await store.snapshot()).totals.realizedCents,16000);
    assert.ok((await store.pool.query('SELECT 1 FROM ledger_audit WHERE action=$1',['amend_purchase'])).rows.length);
  });
  await t.test('concurrent refills serialize; retries are idempotent and edits require versions',async()=>{
    await reset();const a=await store.createTrade(input('buff',{quantity:1}));const payload=sale();
    const attempts=await Promise.allSettled([store.settle(a.id,payload),store.settle(a.id,sale())]);
    assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(attempts.find(x=>x.status==='rejected').reason.status,409);
    const saved=await store.settle(a.id,payload);assert.equal(saved.id,attempts[0].value.id);
    await assert.rejects(store.settle(a.id,{...payload,netTotalCents:200}),{status:409});
    await assert.rejects(store.amendTrade(a.id,{buyTotalCents:2}),{status:400});
    assert.equal((await store.snapshot()).settlements.length,1);
  });
  await t.test('sync preview never writes; editable confirmation merges manual entries and deduplicates',async()=>{
    await reset();const a=await store.createTrade(input());const manual=await store.settle(a.id,sale());
    const source={platform:'steam',sourceId:'history_synthetic_1',appid:730,marketHashName:a.marketHashName,name:a.name,quantity:1,netTotalCents:50000,soldAt:day(2),receivedAt:null};
    const preview=await store.syncPreview([source]);assert.equal(preview.persisted,false);assert.equal(preview.rows[0].status,'possible_duplicate');
    assert.equal((await store.pool.query('SELECT count(*) FROM ledger_sale_imports')).rows[0].count,'0');
    const entry={source,confirmed:true,allocations:[{tradeId:a.id,version:2,existingSettlementId:manual.id,settlementVersion:manual.version,quantity:1,netTotalCents:49999,soldAt:day(2),receivedAt:day(3)}]};
    await assert.rejects(store.syncConfirm([{...entry,confirmed:false}]),{status:400});
    await store.syncConfirm([entry]);let data=await store.snapshot();assert.equal(data.settlements.length,1);assert.equal(data.settlements[0].netTotalCents,49999);
    const retry=await store.syncConfirm([entry]);assert.equal(retry.count,0);assert.equal(retry.skipped.length,1);
    assert.equal((await store.syncPreview([source])).rows[0].duplicate,true);
  });
  await t.test('multiple synchronized sales on one batch use one base version; an invalid row rolls back all',async()=>{
    await reset();const a=await store.createTrade(input());
    const entry=n=>({source:{platform:'steam',sourceId:`row-${n}`},confirmed:true,tradeId:a.id,version:1,quantity:1,netTotalCents:n,soldAt:day(2),receivedAt:day(2)});
    await assert.rejects(store.syncConfirm([entry(1),{...entry(2),quantity:99}]),{status:409});
    assert.equal((await store.snapshot()).settlements.length,0);
    await store.syncConfirm([entry(1),entry(2)]);assert.equal((await store.snapshot()).settlements.length,2);
  });
  await t.test('unknown opening basis stays unknown and refunds/voids restore inventory',async()=>{
    await reset();const w=await store.walletEvent({kind:'opening',amountCents:1000,cashCostCents:null,occurredAt:day(1),requestKey:randomUUID()});
    await store.amendWallet(w.id,{version:1,amountCents:2000});assert.equal(project(await store.snapshot()).wallets[0].costCents,null);
    const a=await store.createTrade(input('steam',{quantity:3,buyTotalCents:1000,boughtAt:day(2),deliveredAt:day(2)}));
    const s=await store.settle(a.id,sale(1,{soldAt:day(3),receivedAt:day(3),netTotalCents:300}));
    assert.equal(project(await store.snapshot()).totals.realizedComplete,false);
    await store.amendSettlement(s.id,{version:1,voided:true});
    await store.refund(a.id,{requestKey:randomUUID(),version:3,quantity:3,amountCents:1000,occurredAt:day(4)});
    const state=project(await store.snapshot());assert.equal(state.rows[0].status,'refunded');assert.equal(state.wallets[0].balanceCents,2000);assert.equal(state.wallets[0].costCents,null);
  });
  await t.test('legacy migration repeats safely, preserves invalid data and never approves a candidate',async()=>{
    await reset();const records=[{store:'storage',record:{id:'old-1',appid:730,name:'Old item',marketHashName:'Old item',buyPriceCents:100,quantity:2,boughtAt:day(1),source:'buff'}},{store:'storage',record:{id:'bad',quantity:-1}}];
    const a=await store.importLegacy(records);assert.equal(a.count,1);assert.equal(a.rejected,1);
    await store.importLegacy(records);const data=await store.snapshot();assert.equal(data.trades.length,1);assert.equal(data.trades[0].confirmed,false);assert.equal(project(data).totals.buffBuyCents,0);
    assert.equal((await store.pool.query("SELECT count(*) FROM ledger_meta WHERE key LIKE 'rejected-legacy:%'")).rows[0].count,'1');
    const malformed=await store.importLegacy([null,42]);assert.equal(malformed.rejected,2);assert.equal((await store.snapshot()).trades.length,1);
  });
  await t.test('price replay is idempotent; quote history uses exact 7-day bounds',async()=>{
    await reset();const a=await store.createTrade(input());const p=offset=>({appid:730,marketHashName:a.marketHashName,observedAt:new Date(new Date(day(1)).getTime()+offset).toISOString(),steamPriceCents:115,steamNetCents:100,requestKey:`p${offset}`});
    const prices=[p(0),p(7*86400000),p(7*86400000+1)];await store.addPrices(prices);await store.addPrices(prices);assert.equal((await store.snapshot()).prices.length,3);
    server=createServer({store,token:'integration-only',extensionOrigins:['chrome-extension://test']});await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const url=`http://127.0.0.1:${server.address().port}/v1`;
    const get=(path,headers={Authorization:'Bearer integration-only'})=>fetch(url+path,{headers});
    assert.equal((await get('/health',{})).status,401);
    assert.equal((await get('/health',{Authorization:'Bearer integration-only',Origin:'https://evil.example'})).status,403);
    const response=await get('/trades/'+a.id+'?window=purchase');const body=await response.json();assert.equal(body.result.prices.length,2);
    assert.equal((await get('/trades?limit=1')).status,200);
    // Database outage is reported honestly; no in-memory fallback invents a save.
    await store.pool.end();const failed=await get('/summary');assert.equal(failed.status,500);
    store=new Store({...config,database:name});
    await new Promise(r=>server.close(r));server=null;
  });
});
