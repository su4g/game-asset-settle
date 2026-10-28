"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { JSDOM } = require("jsdom"), { OrderLedgerService } = require("../desktop/order-ledger-service.cjs");
const root = path.resolve(__dirname, "..");
const tick = async () => { for (let i=0;i<6;i++) await new Promise(resolve => setImmediate(resolve)); };
const change = async (d,id,value) => { d.getElementById(id).value=value; d.getElementById(id).dispatchEvent(new d.defaultView.Event(id.includes("Search") ? "input" : "change")); await tick(); };
async function ui(t, prepare = () => {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root,"desktop/index.html"),"utf8"), {runScripts:"outside-only",url:"https://local.test/"}); t.after(() => dom.window.close());
  dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;}; dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new dom.window.Event("close"));};
  const raw=(key,hash,side,cents,date="2020-01-01")=>({key,name:hash==="Gap" ? '<img src=x onerror="alert(1)">' : hash,marketHashName:hash,appid:730,category:"武器箱",accountId:"buff:me",direction:side,quantity:1,currencyCode:"CNY",channel:"history",completed:true,paidTotalCents:side==="buy"?cents:null,netTotalCents:side==="sell"?cents:null,tradedAt:date+"T00:00:00+08:00"});
  const input={buff:{accounts:{a:{records:[raw("a","Knife","buy",70),raw("b","Hold","buy",100),raw("c","Gap","sell",100,"2020-01-04"),raw("d","Loss","buy",200),raw("e","Loss","sell",100,"2020-01-04")]}}},uu:{accounts:{}},csv:{rows:[{key:"s",scope:"me",platform:"steam",appid:730,marketHashName:"Knife",itemName:"Knife",type:"sale",quantity:1,currency:"CNY",totalCents:100,date:"2020-01-02",sourceFormat:"steam-market-history",amountSemantics:"actual"}]},names:{}};
  prepare(input, raw);
  let storage={}, fail=false; const requests=[];
  const state={get:async keys=>Object.fromEntries(keys.filter(k=>k in storage).map(k=>[k,structuredClone(storage[k])])),set:async value=>{if(fail)throw Error("保存失败");storage={...storage,...structuredClone(value)};}};
  const service=new OrderLedgerService({state,scope:"ui",request:async route=>{const key=route.split("/").at(-1);return structuredClone(["buff","uu","steam"].includes(key)?{data:input[key] || {accounts:{}}}:input[key]);}});
  dom.window.buffDesktop={request:async(action,payload)=>{requests.push(action);return service[({"profit-report:load":"reportLoad","profit-report:save":"reportSave","profit-report:toggle":"reportToggle"})[action]](payload);},onChange:()=>()=>{}};
  for(const file of ["common.js","desktop/pricing.js","desktop/report-analytics.js","desktop/report-charts.js","desktop/profit-report-ui.js"])dom.window.eval(fs.readFileSync(path.join(root,file),"utf8"));
  await dom.window.BuffProfitReport.refresh();
  return {dom,service,input,requests,fail(){fail=true;}};
}
test("收益报告导航、负收益和持仓/净卖出分离，筛选合计与安全文本",async t=>{
  const e=await ui(t),d=e.dom.window.document;
  assert(d.querySelector('[data-page="report"]')); assert.match(d.getElementById("reportRows").textContent,/-¥1\.00/); assert.equal(d.querySelectorAll("#reportRows tr[data-report-id]").length,1);
  d.querySelector('[data-report-view="net"]').click(); assert.equal(d.querySelectorAll("#reportRows img").length,0); assert.match(d.getElementById("reportRows").textContent,/img src=x/); assert.match(d.getElementById("reportListNote").textContent,/不计利润/);
  d.querySelector('[data-report-view="holdings"]').click(); assert.match(d.getElementById("reportRows").textContent,/Hold/); assert.doesNotMatch(d.getElementById("reportRows").textContent,/Loss/);
  await change(d,"reportSearch","absent"); assert.match(d.getElementById("reportRows").textContent,/暂无/);
});
test("持仓卖价核对产生带正号的收益，可撤回恢复并保持原始订单",async t=>{
  const e=await ui(t),d=e.dom.window.document,before=structuredClone(e.input); d.querySelector('[data-report-view="holdings"]').click();
  d.querySelector('[data-report-action="sell"]').click(); assert(d.getElementById("reportEntryDialog").open); assert.equal(d.getElementById("reportEntryPrice").value,"");
  d.getElementById("reportEntryPrice").value="2.50"; d.getElementById("reportEntryDate").value="2020-01-05";
  d.getElementById("reportEntryForm").dispatchEvent(new e.dom.window.Event("submit",{bubbles:true,cancelable:true}));await tick();
  assert.equal(d.getElementById("reportEntryDialog").open,false); assert.equal(e.dom.window.BuffProfitReport.data().currencies[0].profitCents,50);
  d.querySelector('[data-report-view="profit"]').click(); assert.match(d.getElementById("reportRows").textContent,/\+¥1\.50/);
  await change(d,"reportProfit","positive"); assert.equal(d.querySelectorAll("#reportRows tr[data-report-id]").length,1);
  await change(d,"reportProfit","all"); d.querySelector('[data-report-view="entries"]').click(); d.querySelector('[data-report-action="toggle"]').click();await tick();assert.equal(e.dom.window.BuffProfitReport.data().currencies[0].profitCents,-100);
  d.querySelector('[data-report-action="toggle"]').click();await tick();assert.equal(e.dom.window.BuffProfitReport.data().currencies[0].profitCents,50);assert.deepEqual(e.input,before);
});
test("净卖出买价可补录，保存失败保留表单与旧结果，不把空价格当零",async t=>{
  const e=await ui(t),d=e.dom.window.document;d.querySelector('[data-report-view="net"]').click();d.querySelector('[data-report-action="buy"]').click();
  const form=d.getElementById("reportEntryForm"); form.dispatchEvent(new e.dom.window.Event("submit",{cancelable:true}));await tick();assert.match(d.getElementById("reportEntryError").textContent,/价格|金额|数字/);
  d.getElementById("reportEntryPrice").value="0.20";d.getElementById("reportEntryDate").value="2020-01-03";e.fail();form.dispatchEvent(new e.dom.window.Event("submit",{cancelable:true}));await tick();
  assert.match(d.getElementById("reportEntryError").textContent,/保存失败/);assert(d.getElementById("reportEntryDialog").open);assert.equal(e.dom.window.BuffProfitReport.data().currencies[0].netSaleQuantity,1);
});
const visibleNames = d => [...d.querySelectorAll("#reportRows tr[data-report-id]")].map(row => row.firstChild.querySelector("strong").textContent);
test("全量结果按数值排序再分页，负收益正确排列，未知值双向置后，刷新保留顺序", async t => {
  const e = await ui(t, (input, raw) => {
    for (let i = 0; i < 55; i++) input.buff.accounts.a.records.push(raw(`b${i}`, `Sort ${i}`, "buy", 1000), raw(`s${i}`, `Sort ${i}`, "sell", i * 100, "2020-01-04"));
    input.buff.accounts.a.records.push(raw("ub", "Unknown", "buy", null), raw("us", "Unknown", "sell", 100, "2020-01-04"));
  });
  const d = e.dom.window.document, before = structuredClone(e.input), totals = structuredClone(e.dom.window.BuffProfitReport.data().currencies);
  assert.equal(visibleNames(d).length, 50); assert.equal(visibleNames(d)[0], "Sort 54");
  d.getElementById("reportNext").click(); assert.equal(visibleNames(d).at(-1), "Unknown");
  d.querySelector('[data-report-sort="profit"]').click(); assert.equal(d.getElementById("reportPageInfo").textContent, "1 / 2");
  assert.equal(visibleNames(d)[0], "Sort 0"); assert.equal(d.querySelector("th[aria-sort]").getAttribute("aria-sort"), "ascending");
  assert.equal(d.activeElement.dataset.reportSort, "profit");
  d.getElementById("reportNext").click(); assert.equal(visibleNames(d).at(-1), "Unknown");
  await e.dom.window.BuffProfitReport.refresh(); assert.equal(d.getElementById("reportSortDirection").textContent, "升序 ↑");
  await change(d, "reportSearch", "Sort"); assert.equal(visibleNames(d)[0], "Sort 0");
  assert.deepEqual(e.dom.window.BuffProfitReport.data().currencies, totals); assert.deepEqual(e.input, before);
});
test("各列表按来源或路线筛选，可组合搜索并分别保留设置，金额按币种分组排序", async t => {
  const e = await ui(t, (input, raw) => {
    const s = input.csv.rows[0];
    input.csv.rows.push({ ...s, key: "sh", marketHashName: "Steam Hold", itemName: "Steam Hold", type: "purchase", quantity: 2, totalCents: 200 },
      { ...s, key: "sg", marketHashName: "Steam Gap", itemName: "Steam Gap", quantity: 3, totalCents: 300 },
      { ...s, key: "usd", marketHashName: "USD Hold", itemName: "USD Hold", type: "purchase", totalCents: 10000, currency: "USD" },
      { ...s, key: "co", marketHashName: "Cashout", itemName: "Cashout", type: "purchase", totalCents: 100 });
    input.buff.accounts.a.records.push(raw("co", "Cashout", "sell", 90, "2020-01-04"));
  });
  const d = e.dom.window.document, totals = d.getElementById("reportMetrics").textContent;
  await change(d, "reportListFilter", "cashout"); assert.deepEqual(visibleNames(d), ["Cashout"]); assert.equal(d.getElementById("reportMetrics").textContent, totals);
  d.querySelector('[data-report-view="holdings"]').click(); await change(d, "reportListFilter", "steam"); await change(d, "reportSort", "steamFace");
  assert.deepEqual(visibleNames(d), ["Steam Hold", "USD Hold"]); // No cross-currency monetary comparison.
  await change(d, "reportSearch", "USD"); assert.deepEqual(visibleNames(d), ["USD Hold"]); await change(d, "reportSearch", "");
  d.querySelector('[data-report-view="net"]').click(); await change(d, "reportListFilter", "steam"); assert.deepEqual(visibleNames(d), ["Steam Gap"]);
  d.querySelector('[data-report-view="holdings"]').click(); assert.equal(d.getElementById("reportSort").value, "steamFace"); assert.equal(d.getElementById("reportListFilter").value, "steam");
  d.querySelector('[data-report-view="profit"]').click(); assert.deepEqual(visibleNames(d), ["Cashout"]);
  d.getElementById("reportReset").click(); await tick(); assert.equal(d.getElementById("reportListFilter").value, "all"); assert.equal(visibleNames(d).length, 2);
});
test("价格核对状态筛选随撤回更新，空结果可重置，买卖方向与日期可排序", async t => {
  const e = await ui(t), d = e.dom.window.document;
  let r = await e.service.reportLoad();
  r = await e.service.reportSave({ revision: r.revision, groupId: r.groups.find(g => g.name === "Hold").id, direction: "sell", platform: "uu", date: "2020-01-05", quantity: 1, unitPriceCents: 250 });
  await e.service.reportSave({ revision: r.revision, groupId: r.groups.find(g => g.marketHashName === "Gap").id, direction: "buy", platform: "buff", date: "2020-01-03", quantity: 1, unitPriceCents: 50 });
  await e.dom.window.BuffProfitReport.refresh(); d.querySelector('[data-report-view="entries"]').click();
  assert.equal(visibleNames(d)[0], "Hold"); assert(d.getElementById("reportProfit").disabled);
  await change(d, "reportSort", "direction"); assert.match(d.querySelector("#reportRows tr").textContent, /买入/);
  await change(d, "reportListFilter", "active"); d.querySelector('[data-report-action="toggle"]').click(); await tick(); assert.equal(visibleNames(d).length, 1);
  await change(d, "reportListFilter", "withdrawn"); assert.equal(visibleNames(d).length, 1);
  await change(d, "reportListFilter", "paused"); assert.equal(visibleNames(d).length, 0);
  d.getElementById("reportTableReset").click(); assert.equal(visibleNames(d).length, 2); assert.equal(d.getElementById("reportSort").value, "date");
});
