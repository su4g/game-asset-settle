"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { buildProfitReport } = require("../desktop/profit-report.cjs");
const { accountKey } = require("../desktop/order-ledger.cjs");
const A = require("../desktop/report-analytics.js");
const options = { dateFrom: "2026-10-05", dateTo: "2026-10-18", accountLinks: [{ id: "self", accountKeys: [accountKey("buff","buff","buff:me"),accountKey("csv","steam","me")] }] };
function fixture() {
  const native = (key, name, direction, quantity, cents, date) => ({ key, name, marketHashName:name, accountId:"buff:me", appid:730, category:"武器箱", completed:true, channel:"history", direction, quantity, currencyCode:"CNY", paidTotalCents:direction==="buy"?cents:null, netTotalCents:direction==="sell"?cents:null, tradedAt:date+"T00:00:00+08:00" });
  const steam = (key,name,type,totalCents,date) => ({key,scope:"me",appid:730,platform:"steam",marketHashName:name,itemName:name,type,quantity:1,currency:"CNY",totalCents,date,sourceFormat:"steam-market-history",amountSemantics:"actual"});
  return { buff:{accounts:{a:{records:[native("k","K","buy",1,70,"2026-10-04"),native("a","A","buy",2,200,"2026-10-05"),native("a1","A","sell",1,150,"2026-10-05"),native("a2","A","sell",1,70,"2026-10-08"),native("s","S","sell",1,90,"2026-10-08"),native("b","B","buy",1,200,"2026-10-12"),native("b1","B","sell",1,50,"2026-10-14"),native("n","Net","sell",1,200,"2026-10-14")]}}},uu:{accounts:{}},csv:{rows:[steam("k1","K","sale",100,"2026-10-05"),steam("s1","S","purchase",100,"2026-10-06")]},names:{} };
}
test("图表日、周、月汇总与报告金额和数量守恒，净卖出回款不混为利润", () => {
  const input=fixture(), before=structuredClone(input), r=buildProfitReport(input,options), s=r.currencies[0];
  assert.equal(s.profitCents,-110); assert.equal(s.cashInvestmentCents,400); assert.equal(s.netSaleQuantity,1);
  for(const interval of ["day","week","month"]) {
    const a=A.analyze(r,r.groups,{currencyCode:"CNY",interval});
    assert.equal(a.points.at(-1).cumulativeProfitCents,s.profitCents); assert.equal(a.points.at(-1).cumulativeCostCents,400);
    assert.equal(A.sum(a.points.map(p=>p.saleQuantity)),6); assert.equal(A.sum(a.points.map(p=>p.buyQuantity)),4);
    assert.equal(A.sum(a.points.map(p=>p.knownProfitCents)),-110); assert.equal(A.sum(a.points.map(p=>p.knownCashReceiptsCents)),560);
    assert.equal(A.sum(a.points.map(p=>p.knifeQuantity+p.cashoutQuantity+p.directQuantity+p.netQuantity)),6);
    assert.equal(A.sum(a.categories.map(c=>c.profitCents)),-110);
  }
  assert.deepEqual(input,before);
});
test("周 K 线按周一对齐，以期初和日终计算 OHLC，负收益和无交易日保留", () => {
  const r=buildProfitReport(fixture(),options), a=A.analyze(r,r.groups);
  assert.equal(a.daily.length,14); assert.equal(a.weekly.length,2);
  const pick=b=>[b.date,b.openCents,b.highCents,b.lowCents,b.closeCents,b.knownProfitCents];
  assert.deepEqual(pick(a.weekly[0]),["2026-10-05",0,50,0,40,40]);
  assert.deepEqual(pick(a.weekly[1]),["2026-10-12",40,40,-110,-110,-150]);
  assert.equal(a.daily.find(p=>p.date==="2026-10-07").cumulativeProfitCents,50);
  const narrow=A.analyze(r,r.groups,{range:"7"}); assert.equal(narrow.daily[0].date,"2026-10-12"); assert.equal(narrow.weekly[0].openCents,40); assert.equal(narrow.weekly[0].closeCents,-110);
});
test("改变报告开始日保留挂刀样本与买入成本，曲线仅累计所选期间收益", () => {
  const r=buildProfitReport(fixture(),{...options,dateFrom:"2026-10-06"}), a=A.analyze(r,r.groups);
  assert.equal(r.currencies[0].historicalKnifeRatio,.7); assert.equal(a.summary.profitCents,-160); assert.equal(a.points.at(-1).cumulativeProfitCents,-160); assert.equal(a.points.at(-1).cumulativeCostCents,200);
  assert.equal(a.weekly[0].from,"2026-10-06"); assert.equal(a.weekly[0].openCents,0);
  const selected=r.groups.filter(g=>g.name==="S"), subset=A.analyze(r,selected); assert.equal(subset.summary.historicalKnifeRatio,.7); assert.equal(subset.summary.profitCents,20); assert.equal(subset.points.at(-1).cumulativeProfitCents,20);
});
test("无挂刀样本不把未知提现收益画成零；可计算的零利润仍保留", () => {
  const input=fixture(); input.csv.rows=input.csv.rows.filter(r=>r.key!=="k1"); const r=buildProfitReport(input,options), selected=r.groups.filter(g=>g.name==="S"), a=A.analyze(r,selected);
  assert.equal(a.summary.profitCents,null); assert.equal(a.partial,true); assert.equal(a.points.at(-1).cumulativeProfitCents,null);
  assert.equal(a.points[0].displayCashoutProfitCents,null); assert.equal(a.daily.find(p=>p.date==="2026-10-08").cumulativeCashoutProfitCents,null);
  const zero=fixture(); zero.buff.accounts.a.records.find(r=>r.key==="a1").netTotalCents=100; zero.buff.accounts.a.records.find(r=>r.key==="a2").netTotalCents=100;
  const zr=buildProfitReport(zero,options), za=A.analyze(zr,zr.groups.filter(g=>g.name==="A")); assert.equal(za.summary.profitCents,0); assert.equal(za.points.at(-1).cumulativeProfitCents,0);
});
test("不同币种不相加，按币种切换图表并保留类目和交易数量", () => {
  const input=fixture(); const native=input.buff.accounts.a.records.map(r=>({...r,key:r.key+"u",currencyCode:"USD",paidTotalCents:r.paidTotalCents==null?null:r.paidTotalCents*2,netTotalCents:r.netTotalCents==null?null:r.netTotalCents*2}));
  input.buff.accounts.a.records.push(...native); input.csv.rows.push(...input.csv.rows.map(r=>({...r,key:r.key+"u",currency:"USD",totalCents:r.totalCents*2})));
  const r=buildProfitReport(input,options), c=A.analyze(r,r.groups,{currencyCode:"CNY"}), u=A.analyze(r,r.groups,{currencyCode:"USD"});
  assert.deepEqual(c.currencies,["CNY","USD"]); assert.equal(c.summary.profitCents,-110); assert.equal(u.summary.profitCents,-220); assert.equal(u.points.at(-1).cumulativeCostCents,800);
  assert.equal(c.summary.saleQuantity,6); assert.equal(u.summary.saleQuantity,6);
});
