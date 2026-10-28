"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { SteamOrders, normalizePage, pageInfo, identifyHtml, terminal } = require("../desktop/steam-orders.cjs");
const { readAllowed, backgroundReadAllowed, resourceAllowed, navigationAllowed, createSteamSession, ORIGIN } = require("../desktop/steam-session.cjs");
const { bindCsv, reconcileInput } = require("../desktop/steam-reconcile.cjs");
const { normalizeOrders, buildAggregateLedger } = require("../desktop/order-ledger.cjs");
const F = require("./fixtures/desktop-steam-orders.cjs");
const at = "2026-10-22T00:00:00.000Z", normalize = (...ts) => normalizePage(F.page(ts),F.account.id,at);
const clone = structuredClone;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("Steam 实付采用买家币种与费用，卖出采用本人收到金额，不套用对手币种/挂单价", () => {
  const [buy,sell] = normalize(F.trade(0),F.trade(1));
  assert.equal(buy.paidTotalCents,4467); assert.equal(buy.currencyCode,"CNY"); assert.equal(buy.grossTotalCents,4467);
  assert.equal(sell.netTotalCents,203); assert.equal(sell.currencyCode,"CNY"); assert.equal(sell.grossTotalCents,null);
  assert.equal(sell.saleProceedsCents,203); assert.equal(sell.feeCents,null);
  for (const row of [buy,sell]) { assert.equal(row.quantity,1); assert.equal(row.receivedAt,null); assert.equal(row.tradedAt,new Date((1792555200-(row===sell?1:0))*1000).toISOString());assert.equal(row.eventAt,new Date((1792555200-(row===sell?1:0))*1000+123).toISOString()); }
  assert.equal(buy.marketHashName,"Test Case"); assert.match(buy.orderId,/^90071992547410000_91071992547410000$/);
  assert.equal(normalize(F.trade(0,{purchase:{added_tax:1}}))[0].paidTotalCents,4468);
  assert.equal(normalize(F.trade(1,{purchase:{currencyid:2023}}))[0].grossTotalCents,4467);
});

test("未知金额/数量/币种不填零；身份、时间或费用矛盾拒绝整页", () => {
  for (const key of ["paid_amount","paid_fee"]) assert.equal(normalize(F.trade(0,{purchase:{[key]:undefined}}))[0].paidTotalCents,null);
  assert.equal(normalize(F.trade(1,{purchase:{received_amount:undefined}}))[0].netTotalCents,null);
  assert.equal(normalize(F.trade(0,{purchase:{currencyid:9999}}))[0].paidTotalCents,null);
  const missing=F.trade(0);delete missing.purchase.asset.amount;assert.equal(normalize(missing)[0].quantity,null);
  assert.equal(normalize(F.trade(0,{event:{time_event:0},purchase:{time_sold:0}}))[0].tradedAt,null);
  for (const patch of [{purchase:{paid_fee:500}},{purchase:{steamid_purchaser:F.other}},{description:{original_amount:"2"}}]) assert.throws(()=>normalize(F.trade(0,patch)));
  const delayed=normalize(F.trade(0,{purchase:{time_sold:1792555200-28577}}))[0];
  assert.equal(delayed.tradedAt,new Date((1792555200-28577)*1000).toISOString());assert.equal(delayed.eventAt,new Date(1792555200000+123).toISOString());assert.equal(delayed.evidence.timeSold,1792555200-28577);
  assert.equal(normalize(F.trade(0,{purchase:{time_sold:undefined}}))[0].tradedAt,null);
  const broken=F.page([F.trade(1)]);broken.purchases={};assert.throws(()=>normalizePage(broken,F.account.id,at),/身份/);
  assert.throws(()=>identifyHtml("<html>登录</html>"),/登录/);
  assert.throws(()=>identifyHtml(F.html()+F.html(F.other)),/登录/);
  assert.throws(()=>pageInfo({...F.page([F.trade(1)]),events:[]},0),/分页中断/);
  assert.throws(()=>normalize(F.trade(1,{event:{event_type:99}})),/未知市场事件/);
});

test("交割后的物品 ID 只经官方 unowned_id 关联，不凭同名跨资产拼接",()=>{
  const t=F.trade(1);t.description.unowned_id="99999";t.purchase.asset.id="99999";
  assert.equal(normalize(t)[0].assetId,"99999");
  const mismatched=F.trade(1);mismatched.purchase.asset.id="99999";
  assert.throws(()=>normalize(mismatched),/身份/);
});

test("失败、退款、回滚与撤回不当成交；本人暂扣款不计净到账，买家的卖家暂扣不抹掉实付", () => {
  for (const [patch,state] of [[{failed:1},"FAILED"],[{funds_returned:1},"REFUNDED"],[{funds_revoked:1},"REVOKED"],[{needs_rollback:1},"ROLLBACK"],[{failed:undefined},"UNKNOWN"],[{funds_held:2},"UNKNOWN"]]) {
    const row=normalize(F.trade(1,{purchase:patch}))[0];assert.equal(row.state,state);assert.equal(row.completed,false);assert.equal(row.netTotalCents,null);
    assert.equal(normalizeOrders({steam:{accounts:{a:{records:[row]}}}}).orders.length,0);
  }
  const [buy,sell]=normalize(F.trade(0,{purchase:{funds_held:1,time_funds_held_until:1792558800}}),F.trade(1,{purchase:{funds_held:1}}));
  assert.equal(buy.paidTotalCents,4467);assert(terminal(buy));assert.equal(sell.netTotalCents,null);assert.equal(sell.saleProceedsCents,203);assert(!terminal(sell));
  const ledger=normalizeOrders({steam:{accounts:{a:{records:[buy,sell]}}}});assert.equal(ledger.orders.length,2);assert.equal(ledger.orders.find(r=>r.direction==="sell").actualTotalCents,null);
});

function harness(trades, { saved, pageSize=2, transform, identify, saveError=false } = {}) {
  let data=clone(saved||{version:1,accounts:{}}),writes=0,ids=0,requests=[];
  const repository={load:async()=>clone(data),save:async next=>{if(saveError)throw Error("模拟存储失败");data=clone(next);writes++;}};
  const orders=new SteamOrders({repository,interval:()=>0,fetcher:async(url,init)=>{
    const u=new URL(url);assert.equal(init.method,"GET");assert(readAllowed(url,init));requests.push(u.pathname+u.search);
    if(u.pathname==="/market/")return new Response(F.html(identify?identify(++ids):F.owner));
    const start=Number(u.searchParams.get("start")),value=F.page(trades,start,pageSize);
    const result=transform?await transform(value,{start,orders,init,requests}):value;
    return result instanceof Response?result:new Response(JSON.stringify(result));
  }});
  return {orders,repository,requests,data:()=>clone(data),writes:()=>writes};
}
async function sync(env, mode="incremental") { await env.orders.start({mode});await env.orders.running;return env.orders.snapshot(); }

test("首次无页数上限到末页、保存后重启与 JSONB 重排不重复，增量连续两页边界", async()=>{
  const trades=Array.from({length:45},(_,i)=>F.trade(i)),env=harness(trades);
  assert.equal((await sync(env)).job.status,"completed");assert.equal(env.orders.job.pages,23);assert.equal(env.orders.job.inserted,45);assert.equal(env.writes(),1);
  const saved=JSON.parse(JSON.stringify(env.data()),(_key,value)=>value&&typeof value==="object"&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).reverse()):value);
  const next=harness(trades,{saved});await sync(next);assert.equal(next.orders.job.status,"completed");assert.equal(next.orders.job.pages,2);assert.equal(next.orders.job.updated,0);assert.equal(next.data().accounts[F.account.id].records.length,45);
  assert(next.data().accounts[F.account.id].runs.every(r=>r.complete&&r.stopReason==="known"));
  await sync(next,"full");assert.equal(next.orders.job.pages,23);assert.equal(next.orders.job.updated,0);
});

test("旧范围未补齐不能停边界；旧暂扣必须复查，退款终态不阻塞边界", async()=>{
  const trades=Array.from({length:9},(_,i)=>F.trade(i)),initial=harness(trades);await sync(initial);
  const saved=initial.data();saved.accounts[F.account.id].coverage.complete=false;
  let env=harness(trades,{saved});await sync(env);assert.equal(env.orders.job.pages,5);
  const held=initial.data(),row=held.accounts[F.account.id].records.find(r=>r.direction==="sell"&&r.orderId.startsWith(trades[7].event.listingid));
  Object.assign(row,{fundsStatus:"held",netTotalCents:null});env=harness(trades,{saved:held});await sync(env);assert.equal(env.orders.job.pages,5);assert.equal(env.orders.job.updated,1);
  const refund=initial.data();Object.assign(refund.accounts[F.account.id].records.at(-1),{state:"REFUNDED",completed:false,fundsStatus:"returned"});
  env=harness(trades,{saved:refund});await sync(env);assert.equal(env.orders.job.pages,2);
});

test("错误、重复页、换号、末页后状态变化及保存失败均不提交半份历史", async()=>{
  const trades=Array.from({length:5},(_,i)=>F.trade(i)),seed=harness(trades);await sync(seed);const saved=seed.data();
  const cases=[
    {transform:(p,{start})=>start===2?{...p,events:F.page(trades,0,2).events}:p},
    {transform:(p,{start})=>start===2?{...p,total_count:p.total_count+1}:p},
    {transform:(p,{start})=>{if(start===2)throw Error("模拟网络失败");return p;}},
    {identify:n=>n===1?F.owner:F.other},
    {saveError:true},
    {transform:(p,{requests})=>{if(requests.length>4&&p.start===0)Object.values(p.purchases)[0].failed=1;return p;}},
    {transform:(p,{requests})=>requests.length>4&&p.start===0?{...F.page(trades,2,2),start:0}:p},
  ];
  for(const options of cases){const env=harness(trades,{saved,...options});const status=await sync(env,"full");assert.equal(status.job.status,"failed");assert.equal(env.writes(),0);assert.deepEqual(env.data(),saved);}
});

test("停止后迟到响应不写库；限流冷却持久化且重启后不继续请求", async()=>{
  const entered=deferred(),release=deferred(),trades=[F.trade(0)];
  const env=harness(trades,{transform:async(p)=>{entered.resolve();await release.promise;return p;}});
  await env.orders.start();await entered.promise;env.orders.stop();release.resolve();await env.orders.running;assert.equal(env.orders.job.status,"cancelled");assert.equal(env.writes(),0);
  const limited=harness(trades,{transform:()=>new Response("",{status:429,headers:{"Retry-After":"60"}})});await sync(limited);
  assert.equal(limited.orders.job.status,"failed");assert(limited.data().cooldownUntil>Date.now());assert.equal(limited.data().activeAccount,undefined);
  const reload=harness(trades,{saved:limited.data()});await sync(reload);assert.equal(reload.requests.length,0);assert.match(reload.orders.job.message,/冷却/);
});

test("请求串行到响应体完成；重新登录可取消正在进行的账号检查",async()=>{
  const entered=deferred(),release=deferred();let calls=0;
  const orders=new SteamOrders({repository:{load:async()=>({version:1,accounts:{}})},interval:()=>0,fetcher:async()=>{
    calls++;return new Response(new ReadableStream({async start(c){entered.resolve();await release.promise;c.enqueue(new TextEncoder().encode(F.html()));c.close();}}));
  }});
  const first=orders.check();await entered.promise;const second=orders.identify();await new Promise(r=>setImmediate(r));assert.equal(calls,1);
  orders.stop();release.resolve();await assert.rejects(first,/停止/);await second;assert.equal(orders.verified,false);assert.equal(calls,2);
});

const csvFor = (r,key) => ({key,scope:"本人导入",platform:"steam",sourceFormat:"steam-market-history",amountSemantics:"actual",appid:String(r.appid),marketHashName:r.marketHashName,date:"2026-10-21",type:r.direction==="buy"?"purchase":"sale",quantity:r.quantity,currency:r.currencyCode,totalCents:r.direction==="buy"?r.paidTotalCents:r.saleProceedsCents});
test("CSV 完整多重集核对后去重，不吞同价多笔；金额/日期不符及部分重叠不绑定",()=>{
  const rows=normalize(F.trade(1),F.trade(3)),account={account:F.account,coverage:{complete:true,syncedAt:at},records:rows},csv={rows:rows.map((r,i)=>csvFor(r,String(i)))};
  const bindings=bindCsv(account,csv);assert.equal(bindings[0].pairs.length,2);assert.equal(new Set(bindings[0].pairs.map(p=>p[1])).size,2);
  assert.equal(bindCsv(account,{rows:csv.rows.map((r,i)=>({...r,assetId:rows[i].assetAliases[0]}))})[0].pairs.length,2);
  assert.equal(bindCsv(account,{rows:csv.rows.map(r=>({...r,assetId:"9999999"}))}).length,0);
  for(const copy of [{rows:csv.rows.slice(0,1)},{rows:[csv.rows[0],{...csv.rows[1],totalCents:204}]},{rows:[csv.rows[0],{...csv.rows[1],date:"2026-10-20"}]}])assert.equal(bindCsv(account,copy).length,0);
  account.csvBindings=bindings;const input={steam:{accounts:{[F.account.id]:account}},csv},reconciled=reconcileInput(input);
  assert.equal(input.csv.rows.length,2);assert.equal(reconciled.csv.rows.length,0);assert.equal(reconciled.csv.suppressedCount,2);
  Object.assign(rows[0],{state:"REFUNDED",completed:false,fundsStatus:"returned",netTotalCents:null});account.csvBindings=bindCsv(account,csv,bindings);
  const identifiedCsv={rows:csv.rows.map((r,i)=>({...r,assetId:rows[i].assetAliases[0]}))};
  assert.equal(bindCsv(account,identifiedCsv)[0].pairs.length,2,"同一物品、金额、日期的完整历史可识别旧 CSV 里已退款的交易");
  assert.equal(reconcileInput(input).csv.rows.length,0);assert.equal(normalizeOrders(reconcileInput(input)).orders.length,1);
  input.steam.accounts.second={...account,account:{id:"steam:"+F.other}};assert.equal(reconcileInput(input).csv.rows.length,2);
});

test("Steam 固定只读端点、登录隔离与续期：不向页面暴露凭据或开放任意请求",async()=>{
  const url=ORIGIN+"/market/myhistory?start=0&count=100&norender=1&l=schinese";
  assert(readAllowed(url,{method:"GET"}));
  for(const raw of [url.replace("count=100","count=101"),url+"&start=1",ORIGIN+"/market/buylisting/1",url.replace("steamcommunity.com","steamcommunity.com.evil.test"),url+"#x"])assert(!readAllowed(raw,{method:"GET"}));
  assert(!readAllowed(url,{method:"POST"}));assert(!readAllowed(url,{method:"GET",body:"x"}));
  assert(backgroundReadAllowed(ORIGIN+"/market/eligibilitycheck/?goto="+encodeURIComponent(ORIGIN+"/market/?l=english")));
  assert(!backgroundReadAllowed(ORIGIN+"/market/eligibilitycheck/?goto="+encodeURIComponent("https://evil.test/")));
  assert(navigationAllowed(ORIGIN+"/login/home/"));assert(!navigationAllowed("https://evil.test/"));assert(resourceAllowed("https://community.akamai.steamstatic.com/a.js"));assert(!resourceAllowed("http://steamcommunity.com/a"));
  let onCookie,beforeRequest,changes=0,options,allowed,resolveFetch;
  const ses={setPermissionRequestHandler(){},setPermissionCheckHandler(){},on(){},webRequest:{onBeforeRequest(fn){beforeRequest=fn;}},cookies:{on(_e,fn){onCookie=fn;},get:async()=>[{value:"test-secret"}]},fetch:async(_u,init)=>{assert.equal(init.credentials,"include");return new Promise(r=>{resolveFetch=r;});}};
  class Window extends require("node:events").EventEmitter {constructor(value){super();options=value;this.webContents={on(){},setWindowOpenHandler(){}};}isDestroyed(){return Boolean(this.destroyed);}loadURL(){return Promise.resolve();}show(){}focus(){}destroy(){this.destroyed=true;this.emit("closed");}}
  const client=createSteamSession({session:{fromPartition:p=>{assert.equal(p,"persist:steam-orders");return ses;}},BrowserWindow:Window,onSessionChange:()=>changes++});
  assert.equal(await client.hasSession(),true);client.open();assert.equal(options.webPreferences.sandbox,true);assert.equal(options.webPreferences.preload,undefined);assert.equal(options.webPreferences.nodeIntegration,false);
  await assert.rejects(client.fetch(url,{method:"GET"}),/关闭/);
  const cookie={name:"steamLoginSecure",domain:".steamcommunity.com"};onCookie({},cookie,"inserted",false);assert.equal(changes,1);client.close();
  onCookie({},cookie,"overwrite",true);onCookie({},cookie,"inserted",false);assert.equal(changes,1);onCookie({},cookie,"expired",true);assert.equal(changes,2);
  const task=client.fetch(url,{method:"GET"});beforeRequest({url:ORIGIN+"/market/buylisting/1",method:"GET"},r=>allowed=!r.cancel);assert.equal(allowed,false);resolveFetch(new Response("{}"));await task;
});
