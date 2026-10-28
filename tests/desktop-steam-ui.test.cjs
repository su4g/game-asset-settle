"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),{JSDOM}=require("jsdom");
const {analyzeOrders}=require("../desktop/buff-analysis.cjs"),{normalizePage}=require("../desktop/steam-orders.cjs");
const F=require("./fixtures/desktop-steam-orders.cjs");
const tick=()=>new Promise(r=>setTimeout(r,0));
async function setup(t){
  const dom=new JSDOM(fs.readFileSync("desktop/index.html","utf8"),{runScripts:"outside-only"});t.after(()=>dom.window.close());
  const w=dom.window,calls=[];let listener;
  const rows=normalizePage(F.page([F.trade(0,{description:{name:'物品 <img src=x onerror="alert(1)">'}}),F.trade(1,{purchase:{funds_held:1}}),F.trade(2,{purchase:{currencyid:2001}})]),F.account.id,"2026-10-22T00:00:00Z");
  let state={account:F.account,verified:false,job:{status:"idle"},count:3,runs:[],csvBindings:[{matchedCount:3}]};
  w.buffDesktop={onChange:fn=>{listener=fn;},request:async(action,payload)=>{
    calls.push({action,payload});if(action==="steam:list")return {...analyzeOrders(rows,payload),...state};
    if(action==="steam:start"){state.job={status:"running",message:"正在读取历史"};return state;}
    if(action==="steam:stop"){state.job={status:"cancelled",message:"原历史保留"};listener({kind:"steam-orders",value:state});return state;}
    if(action==="steam:check"){state.verified=true;return state;}
    if(action==="steam:login")return {opened:true};
    throw new Error(action);
  }};
  for(const file of ["common.js","desktop/market-history.js","desktop/steam-orders-ui.js"])w.eval(fs.readFileSync(file,"utf8"));
  await w.SteamOrdersWorkspace.ready;
  return {w,$:id=>w.document.getElementById(id),calls,emit:value=>{state={...state,...value};listener({kind:"steam-orders",value:state});}};
}
test("Steam 页面离线读档、中文入口、文本安全，实付/暂扣/币种清楚且 CSV 去重可见",async t=>{
  const {$,w,calls}=await setup(t);assert(calls.every(c=>c.action==="steam:list"));
  assert.equal($("steamRows").children.length,3);assert.equal($("steamRows").querySelector("img"),null);
  assert.match($("steamRows").textContent,/实付 ¥44.67/);assert.match($("steamRows").textContent,/成交净额 ¥2.03，款项暂扣/);
  assert.match($("steamRows").textContent,/非人民币（USD）/);assert.match($("steamCoverage").textContent,/3 条 CSV 重复来源/);
  assert.equal($("historyTitle").textContent,"CSV 归档");assert.equal($("steamTitle").textContent,"Steam 订单");
  $("steamSummaryView").click();await tick();assert.equal($("steamRows").children.length,3);
  $("steamView").value="sell";$("steamView").dispatchEvent(new w.Event("change"));await tick();assert.equal($("steamRows").children.length,1);
});
test("进度有明确标签、可停止；同步选项无页数限制，筛选不改变完整读取范围",async t=>{
  const {$,w,calls,emit}=await setup(t);$("steamGame").value="570";$("steamView").value="buy";
  $("steamSyncMode").value="full";$("steamSync").click();await tick();
  assert.equal(JSON.stringify(calls.find(c=>c.action==="steam:start").payload),JSON.stringify({mode:"full"}));
  assert.equal($("steamLogin").disabled,true);assert.equal($("steamStop").disabled,false);
  assert.equal($("steamSyncProgress").hidden,false);assert.equal($("steamSyncProgress").hasAttribute("value"),false);
  emit({job:{status:"running",pages:3,count:300,total:7304,events:300}});assert.equal($("steamSyncProgress").value,300);assert.equal($("steamSyncProgress").max,7304);
  $("steamStop").click();await tick();assert.equal($("steamSyncProgress").hidden,true);assert.equal($("steamSync").disabled,false);
  $("steamCheck").click();await tick();assert.equal($("steamConnection").textContent,"登录已验证");
  $("steamLogin").click();await tick();assert.equal(calls.find(c=>c.action==="steam:login").payload,undefined);
  assert.match($("steamMessage").textContent,/新窗口完成 Steam 登录/);
});
