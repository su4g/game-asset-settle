"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),{JSDOM}=require("jsdom");
const {analyzeOrders}=require("../desktop/buff-analysis.cjs");
const {normalizeOrder}=require("../desktop/uu-orders.cjs");
const tick=()=>new Promise(r=>setTimeout(r,0));
async function setup(t){
 const dom=new JSDOM(fs.readFileSync("desktop/index.html","utf8"),{runScripts:"outside-only"});t.after(()=>dom.window.close());const w=dom.window,calls=[];let listener;
 const rows=normalizeOrder({orderId:"test",id:"10",orderType:1,saleOrderType:1,commodityAmount:203,orderStatus:340,orderStatusName:"已完成",commodityNum:2,finishOrderTime:"2026-10-21 12:00:00",productDetailList:[1,2].map((n)=>({commodityId:String(n),templateId:"3",price:n===1?101:102,commodityName:'测试箱 <img src=x onerror="alert(1)">',marketHashName:"Test Case"}))},{accountId:"uu:7",observedAt:"2026-10-21T04:00:00Z"});
 let state={account:{id:"uu:7",nickname:"测试"},verified:false,job:{status:"idle",pages:0,count:0},count:2,runs:[],sellProbe:{status:"unverified",message:"卖出历史待验证"}};
 w.buffDesktop={onChange:fn=>listener=fn,request:async(action,payload)=>{calls.push({action,payload});if(action==="uu:list")return {...analyzeOrders(rows,payload),...state};if(action==="uu:start"||action==="uu:probe-sell"){state.job={status:"running",message:"正在查询"};return state;}if(action==="uu:stop"){state.job={status:"cancelled",message:"已停止"};listener({kind:"uu-orders",value:state});return state;}throw new Error(action);}};
 for(const f of ["common.js","desktop/market-history.js","desktop/uu-orders-ui.js"])w.eval(fs.readFileSync(f,"utf8"));await w.UuOrdersWorkspace.ready;
 return {w,$:id=>w.document.getElementById(id),calls,emit:value=>{state={...state,...value};listener({kind:"uu-orders",value:state});}};
}
test("悠悠界面仅查本机库，逐笔两件不丢；文字安全，未知实际收支不当零",async t=>{
 const {$,calls}=await setup(t);assert(calls.every(c=>c.action==="uu:list"));assert.equal($("uuRows").children.length,2);assert.equal($("uuRows").querySelector("img"),null);assert.match($("uuRows").textContent,/实付 —平台未提供实际金额/);
 $("uuSummaryView").click();await tick();assert.equal($("uuRows").children.length,1);assert.match($("uuRows").textContent,/1\.02/);assert.match($("uuRows").textContent,/2\.03/);
});
test("未验证的卖出同步禁用，验证入口可用；同步中可停止并禁止重复启动",async t=>{
 const {$,w,calls,emit}=await setup(t);$("uuView").value="sell";$("uuView").dispatchEvent(new w.Event("change"));await tick();assert.equal($("uuSync").disabled,true);assert.equal($("uuProbeSell").disabled,false);
 $("uuProbeSell").click();await tick();assert(calls.some(c=>c.action==="uu:probe-sell"));assert.equal($("uuStop").disabled,false);assert.equal($("uuLogin").disabled,true);
 $("uuStop").click();await tick();emit({sellProbe:{status:"verified",message:"已验证"}});await tick();assert.equal($("uuSync").disabled,false);
 assert.equal($("uuMaxPages"),null);$("uuSync").click();await tick();assert.equal(calls.find(c=>c.action==="uu:start").payload.maxPages,undefined);
});
