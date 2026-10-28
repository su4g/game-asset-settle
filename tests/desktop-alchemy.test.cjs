"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const F=require("./fixtures/steam-inventory.cjs"),{buildAlchemy}=require("../desktop/alchemy.cjs"),{accountKey}=require("../desktop/order-ledger.cjs");
const {parseInventoryPage,validateInventory,mergeEvent}=require("../desktop/steam-inventory.cjs");
const {SteamOrders}=require("../desktop/steam-orders.cjs"),{readAllowed}=require("../desktop/steam-session.cjs");
function order(n,{platform="buff",direction="buy",quantity=10,amount=1000,name="Input (Minimal Wear)",at="2026-10-20T00:00:00.000Z",...extra}={}){const accountId=platform==="steam"?F.accountId:platform+":test";return {platform,key:`${accountId}:730:${direction}:history:${n}`,accountId,appid:730,channel:"history",direction,orderId:String(n),goodsId:String(n),quantity,currencyCode:"CNY",name,marketHashName:name,completed:true,tradedAt:at,paidTotalCents:direction==="buy"?amount:null,netTotalCents:direction==="sell"?amount:null,...extra};}
function input(rows,events=[F.event()],coverage){const x={buff:{accounts:{}},uu:{accounts:{}},steam:{accounts:{[F.accountId]:{account:{id:F.accountId},records:[],runs:[],inventoryHistory:F.archive(events,coverage)}}},csv:{rows:[]}};for(const row of rows){x[row.platform].accounts[row.accountId]||={account:{id:row.accountId},records:[],runs:[]};x[row.platform].accounts[row.accountId].records.push(row);}return x;}
const options={accountLinks:[{id:"self",accountKeys:[accountKey("buff","buff","buff:test"),accountKey("uu","uu","uu:test"),accountKey("steam","steam",F.accountId)]}],now:Date.parse("2026-10-29T00:00:00Z")};
const sell=(n=2,extra={})=>order(n,{direction:"sell",quantity:1,amount:1400,name:"Output (Minimal Wear)",at:"2026-10-28T00:00:00Z",...extra});

test("真实 HTML 结构保留十件相同 class/instance 材料；英文时间固定北京时间，原始脚本不执行",()=>{
 const p=F.sample();p.html+='<script>throw new Error("external code")</script>';
 const r=parseInventoryPage(p,F.accountId).events[0];assert.equal(r.items.length,11);assert.equal(r.kind,"trade-up");assert.equal(r.at,"2026-10-27T12:05:00.000Z");assert.equal(r.items[1].assetId,"");validateInventory(F.archive([r]),F.accountId);
 const bad=structuredClone(p);bad.descriptions[730]["100_200"].classid="other";assert.throws(()=>parseInventoryPage(bad,F.accountId));
 const storage=F.page([F.event({action:"Moved to Storage Unit"})]);assert.equal(parseInventoryPage(storage,F.accountId).events[0].kind,"storage");
 const ordinary=F.page([F.event({action:"Traded"})]);assert.equal(parseInventoryPage(ordinary,F.accountId).events[0].kind,"other");
 assert.throws(()=>parseInventoryPage({...p,num:2},F.accountId));
 assert.throws(()=>validateInventory({...F.archive(),cookie:"secret"},F.accountId));
 assert.throws(()=>validateInventory(F.archive(),"steam:76561198000000002"));
 const old=F.event(),next=structuredClone(old);next.items[0].assetId="";assert.equal(mergeEvent(old,next).items[0].assetId,"900");next.items[1].quantity=9;assert.throws(()=>mergeEvent(old,next));
});
test("窄 GET 白名单仅开放 CS2 本人路径及完整数字游标",()=>{
 const base=`https://steamcommunity.com/profiles/${F.accountId.slice(6)}/inventoryhistory/?ajax=1&app[]=730&l=english`;
 assert.equal(readAllowed(base,{method:"GET"}),true);
 for(const url of [base.replace("730","570"),base+"&url=https://example.com",base+"&cursor[time]=1",base.replace("profiles","id")])assert.equal(readAllowed(url,{method:"GET"}),false);
 assert.equal(readAllowed(base+"&cursor[time]=1&cursor[time_frac]=0&cursor[s]=9223372036854775807",{method:"GET"}),true);
 assert.equal(readAllowed(base,{method:"POST"}),false);
});
test("现金配方按购买平均成本，实际净卖出才实现利润，原数据不改",()=>{
 const x=input([order(1),sell()]),before=structuredClone(x),r=buildAlchemy(x,options);assert.deepEqual(x,before);assert.equal(r.rows[0].cost.basis,1000);assert.equal(r.rows[0].cashProfitCents,400);assert.equal(r.rows[0].state,"sold");assert.equal(r.rows[0].inputs[0].sources.length,1);assert.equal(r.summary.currencies[0].cashProfitCents,400);
 const held=buildAlchemy(input([order(1)]),options).rows[0];assert.equal(held.state,"held");assert.equal(held.cashProfitCents,null);
});
test("Steam 余额盈亏单列；来源未知时不虚构现金成本",()=>{
 const r=buildAlchemy(input([order(1,{platform:"steam"}),sell(2,{platform:"steam"})]),options).rows[0];assert.equal(r.cost.steam,1000);assert.equal(r.cost.basis,null);assert.equal(r.steamProfitCents,400);assert.equal(r.cashProfitCents,null);
 const pending=buildAlchemy(input([order(1),sell(2,{platform:"steam",amount:null})]),options).rows[0];assert.equal(pending.state,"proceeds-pending");assert.equal(pending.steamProfitCents,null);assert.equal(pending.cashProfitCents,null);
});
test("挂刀余额按已知现金来源结转到炼金材料，再出售现金不重复算投入",()=>{
 const rows=[order(1,{name:"Case",quantity:1,amount:500}),order(2,{name:"Case",quantity:1,platform:"steam",direction:"sell",amount:1000,at:"2026-10-21T00:00:00Z"}),order(3,{platform:"steam",at:"2026-10-22T00:00:00Z"}),sell()];
 const r=buildAlchemy(input(rows),options).rows[0];assert.equal(r.cost.basis,500);assert.equal(r.cost.steam,1000);assert.equal(r.cashProfitCents,900);
});
test("连续炼金成本结转，前次合成不计卖出或重复利润",()=>{
 const second=F.event({eventId:"b".repeat(40),key:`${F.accountId}:inventory:${"b".repeat(40)}`,at:"2026-10-27T13:00:00.000Z",items:[F.item("Final (Minimal Wear)",{index:0,direction:"in",quantity:1}),F.item("Output (Minimal Wear)",{index:1,quantity:10})]});
 const r=buildAlchemy(input([order(1),order(2,{name:"Output (Minimal Wear)",quantity:9,amount:900}),sell(3,{name:"Final (Minimal Wear)",amount:2200})],[second,F.event()]),options);
 assert.equal(r.rows[0].cost.basis,1900);assert.equal(r.rows[0].cashProfitCents,300);assert.equal(r.rows[1].state,"reused");assert.equal(r.rows[1].cashProfitCents,null);assert.equal(r.summary.currencies[0].cashCount,1);
});
test("同名普通持仓并存，不能用同名出售冒充特定产出的出售；官方 asset ID 可确认去向",()=>{
 const rows=[order(1),order(2,{name:"Output (Minimal Wear)",quantity:1,amount:500}),sell(3)];
 let r=buildAlchemy(input(rows),options).rows[0];assert.equal(r.state,"ambiguous");assert.equal(r.cashProfitCents,null);
 rows[2].assetId="900";r=buildAlchemy(input(rows),options).rows[0];assert.equal(r.cashProfitCents,400);
});
test("缺价、缺数量、部分历史、分钟重叠不按零计利润，真实亏损可为负",()=>{
 for(const rows of [[order(1,{amount:null}),sell()],[order(1,{quantity:9}),sell()],[order(1,{at:"2026-10-27T12:05:10Z"}),sell()]]){const r=buildAlchemy(input(rows),options).rows[0];assert.equal(r.cashProfitCents,null);assert.equal(r.cost.basis,null);}
 assert.equal(buildAlchemy(input([order(1),sell()],undefined,{complete:false}),options).rows[0].cashProfitCents,null);
 assert.equal(buildAlchemy(input([order(1),sell(2,{amount:900})]),options).rows[0].cashProfitCents,-100);
});
test("不同账户与币种不合并；合成日期过滤保留期初买入",()=>{
 const r=buildAlchemy(input([order(1),sell()]),{...options,dateFrom:"2026-10-27",dateTo:"2026-10-27"});assert.equal(r.rows[0].cost.basis,1000);assert.equal(r.total,1);
 const split={...options,accountLinks:[{id:"a",accountKeys:[accountKey("buff","buff","buff:test")]},{id:"b",accountKeys:[accountKey("steam","steam",F.accountId)]}]};assert.equal(buildAlchemy(input([order(1)]),split).rows[0].cost.basis,null);
 const mixed=buildAlchemy(input([order(1,{quantity:5}),order(2,{quantity:5,currencyCode:"USD"}),sell()]),options).rows[0];assert.equal(mixed.currencyCode,"");assert.equal(mixed.cashProfitCents,null);
});
function runner(pages,{guard=()=>{},data={version:1,accounts:{},cooldownUntil:0},stopAfter=0}={}){
 let saved=structuredClone(data),index=0,writes=0,fetches=0;const requests=[];
 const instance=new SteamOrders({interval:()=>0,repository:{load:async()=>saved,save:async value=>{saved=structuredClone(value);writes++;}},accountGuard:guard,fetcher:async(url)=>{requests.push(url);fetches++;if(url.includes("/market/"))return new Response(`var g_steamID = "${F.accountId.slice(6)}";`);return new Response(JSON.stringify(pages[Math.min(index++,pages.length-1)]));},notify:({value})=>{if(stopAfter&&value.job.pages===stopAfter)instance.stop();}});
 return {instance,requests,saved:()=>saved,writes:()=>writes,fetches:()=>fetches};
}
test("库存同步读至末页、核对头页与账号，重复同步去重",async()=>{
 const r=runner([F.sample(),F.sample()]);await r.instance.startInventory();await r.instance.running;assert.equal(r.instance.job.status,"completed");assert.equal(r.saved().accounts[F.accountId].inventoryHistory.events.length,1);assert(r.saved().accounts[F.accountId].inventoryHistory.coverage.complete);await r.instance.startInventory();await r.instance.running;assert.equal(r.saved().accounts[F.accountId].inventoryHistory.events.length,1);assert.equal(r.writes(),2);
});
test("重复页、切号、停止都不提交未经核对的分页",async()=>{
 const c={time:1793100000,time_frac:0,s:"9223372036854775807"},p={...F.sample(),cursor:c};
 const repeat=runner([p,p]);await repeat.instance.startInventory();await repeat.instance.running;assert.equal(repeat.instance.job.status,"failed");assert.equal(repeat.writes(),0);
 let checks=0;const changed=runner([F.sample(),F.sample()],{guard:()=>{if(++checks>1)throw new Error("账号不一致");}});await changed.instance.startInventory();await changed.instance.running;assert.equal(changed.writes(),0);
 const stopped=runner([p,p],{stopAfter:1});await stopped.instance.startInventory();await stopped.instance.running;assert.equal(stopped.instance.job.status,"cancelled");assert.equal(stopped.writes(),0);
});
test("五页核对后保存可恢复游标；中断后补头页再从旧尾继续，不丢中间历史",async()=>{
 const pages=Array.from({length:7},(_,n)=>F.page([F.event({eventId:String(n+1).repeat(40)})],n===6?null:{time:1793102700,time_frac:0,s:String(n+1)}));
 const first=runner(pages,{stopAfter:6});await first.instance.startInventory();await first.instance.running;
 assert.equal(first.instance.job.status,"cancelled");const saved=first.saved();assert.equal(first.writes(),1);assert.equal(saved.accounts[F.accountId].inventoryHistory.events.length,5);assert.equal(saved.accounts[F.accountId].inventoryHistory.coverage.complete,false);
 const resume=runner([pages[0],pages[1],pages[5],pages[6],pages[0]],{data:saved});await resume.instance.startInventory();await resume.instance.running;assert.equal(resume.instance.job.status,"completed");assert.equal(resume.saved().accounts[F.accountId].inventoryHistory.events.length,7);
 const paths=resume.requests.filter(p=>p.includes("inventoryhistory"));assert.equal(new URL(paths[2]).searchParams.get("cursor[s]"),"5");
});
test("部分库存历史只有连续覆盖材料购买区间才可核算，旧材料不冒充已覆盖",()=>{
 const coverage={complete:false,fromAt:"2026-10-19T00:00:00.000Z"};
 assert.equal(buildAlchemy(input([order(1),sell()],undefined,coverage),options).rows[0].cashProfitCents,400);
 coverage.fromAt="2026-10-21T00:00:00.000Z";assert.equal(buildAlchemy(input([order(1),sell()],undefined,coverage),options).rows[0].cashProfitCents,null);
});
test("已全部消耗的旧未知成本不会污染下一批新买入，分位均摊不丢分",()=>{
 const rows=[order(1,{amount:null}),order(2,{direction:"sell",quantity:10,amount:500,at:"2026-10-21T00:00:00Z"}),order(3,{quantity:11,amount:1001,at:"2026-10-22T00:00:00Z"}),sell(4)];
 assert.equal(buildAlchemy(input(rows),options).rows[0].cost.basis,910);
});
test("库存请求 429 与市场查询共用持久冷却，失败不自动重放",async()=>{
 let calls=0,data={version:1,accounts:{},cooldownUntil:0};const steam=new SteamOrders({interval:()=>0,now:()=>1793102700000,repository:{load:async()=>data,save:async x=>{data=x;}},fetcher:async url=>{calls++;return url.includes("/market/")?new Response(`var g_steamID = "${F.accountId.slice(6)}";`):new Response("",{status:429,headers:{"Retry-After":"120"}});}});
 await steam.startInventory();await steam.running;assert.equal(steam.job.status,"failed");assert.equal(calls,2);assert.equal(data.cooldownUntil,1793102820000);await steam.startInventory();await steam.running;assert.equal(calls,2);
});
test("jsonb 重排对象属性不改变事件身份；补齐缺失描述但不覆盖已知证据",()=>{
 const source=F.event(),reorder=(_k,v)=>v&&typeof v==="object"&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).reverse()):v;
 const fromDb=JSON.parse(JSON.stringify(source,reorder));assert.deepEqual(mergeEvent(fromDb,source),source);
 const missing=structuredClone(source);missing.items[1].marketHashName="";missing.items[1].collection="";missing.items[1].rarity="";
 assert.equal(mergeEvent(missing,source).items[1].marketHashName,source.items[1].marketHashName);
 assert.equal(mergeEvent(source,missing).items[1].marketHashName,source.items[1].marketHashName);
 const conflict=structuredClone(source);conflict.items[1].marketHashName="Other (Field-Tested)";assert.throws(()=>mergeEvent(source,conflict));
});
test("普通库存销毁不是再次炼金；名称显示使用精确映射",()=>{
 const removed=F.event({eventId:"c".repeat(40),key:`${F.accountId}:inventory:${"c".repeat(40)}`,at:"2026-10-27T13:00:00.000Z",kind:"other",action:"other",items:[F.item("Output (Minimal Wear)",{quantity:1})]});
 const x=input([order(1)],[removed,F.event()]);x.names={items:{"730:Output (Minimal Wear)":{appid:"730",marketHashName:"Output (Minimal Wear)",name:"测试产出（略有磨损）",custom:true}}};
 const r=buildAlchemy(x,options).rows[0];assert.equal(r.state,"removed");assert.equal(r.output.name,"测试产出（略有磨损）");assert.equal(r.cashProfitCents,null);
});
test("分钟先后不明的材料成本不能在后续配方中重新变成已知",()=>{
 const later=F.event({eventId:"d".repeat(40),key:`${F.accountId}:inventory:${"d".repeat(40)}`,at:"2026-10-27T13:00:00.000Z"});
 const r=buildAlchemy(input([order(1),order(2,{at:"2026-10-27T12:05:10Z",amount:2000})],[later,F.event()]),options);assert.equal(r.rows[0].cost.basis,null);assert.equal(r.rows[1].cost.basis,null);
});
test("Steam 官方数字主页到别名的规范跳转只接受同参数同源库存地址",()=>{
 const {inventoryRedirectAllowed}=require("../desktop/steam-session.cjs"),from=`https://steamcommunity.com/profiles/${F.accountId.slice(6)}/inventoryhistory/?ajax=1&app[]=730&l=english&cursor[time]=1793102700&cursor[time_frac]=0&cursor[s]=9223372036854775807`;
 const target=from.replace(`/profiles/${F.accountId.slice(6)}/inventoryhistory/`,`/id/fixture/inventoryhistory`).replace('app[]','app[0]');
 assert.equal(inventoryRedirectAllowed(from,target),true);
 for(const bad of [target.replace('730','570'),target.replace('steamcommunity.com','example.com'),target+'&sessionid=x',target.replace('inventoryhistory','tradeoffer'),target+'#fragment',target.replace('9223372036854775807','9223372036854775808')])assert.equal(inventoryRedirectAllowed(from,bad),false);
 assert.equal(readAllowed(target,{method:'GET'}),false);
});
