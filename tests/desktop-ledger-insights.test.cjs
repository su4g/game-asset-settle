"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { buildAggregateLedger, listAccounts } = require("../desktop/order-ledger.cjs");
const { enrichLedger, holdingValue } = require("../desktop/order-ledger-insights.cjs");
const at = d => `2026-10-${String(d).padStart(2, "0")}T08:00:00.000Z`;
const cash = (id, direction, d, name, amount, quantity = 1) => ({ key: id, accountId: "buff:7", appid: 730, channel: "history", completed: true, direction, name, marketHashName: name, quantity, currencyCode: "CNY", category: "武器箱", tradedAt: at(d), paidTotalCents: direction === "buy" ? amount : null, netTotalCents: direction === "sell" ? amount : null });
const steam = (id, direction, d, name, amount, quantity = 1) => ({ key: id, scope: "owner", platform: "steam", appid: 730, type: direction === "buy" ? "purchase" : "sale", itemName: name, marketHashName: name, quantity, currencyCode: "CNY", date: at(d).slice(0, 10), totalCents: amount, sourceFormat: "steam-market-history", amountSemantics: "actual" });
const options = input => ({ now: Date.parse(at(30)), accountLinks: [{ id: "self", accountKeys: listAccounts(input).map(a => a.key) }] });
function project(input, extra = {}) { const o = { ...options(input), ...extra }; return enrichLedger(buildAggregateLedger(input, o), input, o); }
function chain() { return { buff: [cash("in", "buy", 1, "Knife Case", 80), cash("out", "sell", 4, "Cashout Case", 140)], csv: [steam("knife", "sell", 2, "Knife Case", 100), steam("missing", "sell", 2, "Unknown Case", 100), steam("buy", "buy", 3, "Cashout Case", 150)] }; }

test("缺口按名称说明无买入、晚买入与数量不足；不会用未来买入消除历史缺口", () => {
  const input = { buff: [cash("later-buy", "buy", 5, "Later Case", 50), cash("buy", "buy", 1, "Exhausted Case", 100), cash("sold", "sell", 2, "Exhausted Case", 300, 3)], csv: [steam("no-buy", "sell", 2, "Absent Case", 100), steam("late", "sell", 2, "Later Case", 100)] };
  const r = project(input), counts = Object.fromEntries(r.diagnostics.reasons.map(r => [r.code, r.quantity]));
  assert.deepEqual(counts, { no_buy: 1, later_buy: 1, exhausted: 2 }); assert.equal(r.diagnostics.quantity, r.quality.uncoveredSaleQuantity);
  assert.equal(r.diagnostics.groupCount, 3); assert.equal(r.diagnostics.mappingCandidateQuantity, 0);
  assert.equal(r.groups.find(g => g.marketHashName === "Later Case").remainingQuantity, 1);
  assert.equal(r.diagnostics.groups.find(g => g.marketHashName === "Later Case").firstBuy, "2026-10-05");
});

test("历史折扣仅生成独立估算：钱包混合结转且不补造买入或改写实际利润", () => {
  const input = chain(), before = structuredClone(input), r = project(input), e = r.fundingEstimate;
  assert.deepEqual(input, before); assert.equal(r.summary.cashoutCycleProfitCents, null); assert.equal(r.summary.walletRatio, null);
  assert.equal(r.summary.cashInvestedCents, 80); assert.equal(r.quality.uncoveredSaleQuantity, 1);
  assert.equal(e.assumptions[0].faceCents, 100); assert.equal(e.assumptions[0].costCents, 80);
  assert.equal(e.cashoutCycleProfitCents, 20); assert.equal(e.walletCashBasisCents, 40); assert.equal(e.walletRatio, 0.8);
  const item = r.groups.find(g => g.marketHashName === "Cashout Case");
  assert.equal(item.instrument.realizedProfitCents, null); assert.equal(item.instrument.modeledRealizedProfitCents, 20);
  assert.equal(item.instrument.totalProfitCents, null); assert.equal(item.instrument.modeledTotalProfitCents, 20);
  const modeled = buildAggregateLedger(input, options(input), new Map(e.samples.map(s => [s.key, s])));
  assert.equal(modeled.summary.knownCashInvestedCents + e.assumptions[0].costCents, modeled.summary.knownCashoutAllocatedCostCents + modeled.summary.knownDirectCashSpentCents + modeled.summary.knownHoldingCostCents + modeled.summary.knownWalletCashBasisCents);
});

test("没有实际挂刀样本时不采用设置折扣补成本，也不猜测未知现金卖出的盈利", () => {
  const input = { buff: [cash("out", "sell", 4, "Cashout Case", 140), cash("unknown", "sell", 4, "Other Case", 200)], csv: [steam("missing", "sell", 2, "Unknown Case", 200), steam("buy", "buy", 3, "Cashout Case", 150)] };
  const r = project(input, { pricingSettings: { targetCashoutRatio: 0.7 } });
  assert.equal(r.fundingEstimate.used, false); assert.equal(r.fundingEstimate.walletRatio, null); assert.equal(r.fundingEstimate.cashoutCycleProfitCents, null);
  assert.equal(r.groups.find(g => g.marketHashName === "Other Case").instrument.modeledRealizedProfitCents, null);
  const known = chain(); known.buff.push(cash("unknown", "sell", 4, "Other Case", 200));
  const estimate = project(known); assert.equal(estimate.fundingEstimate.cashoutCycleProfitCents, 20); assert.equal(estimate.fundingEstimate.realizedProfitCents, null);
});

test("时间筛选带入期初估算成本，取样不跨结束日期且估算独立于备用提现率", () => {
  const input = chain(), all = project(input), ranged = project(input, { dateFrom: "2026-10-04", dateTo: "2026-10-04" });
  assert.equal(ranged.fundingEstimate.walletCashBasisCents, all.fundingEstimate.walletCashBasisCents);
  assert.equal(ranged.fundingEstimate.cashoutCycleProfitCents, 20); assert.equal(ranged.summary.cashInvestedCents, 0);
  assert.equal(project(input, { dateTo: "2026-10-01" }).fundingEstimate.used, false);
  assert.equal(project(input, { pricingSettings: { targetCashoutRatio: 0.2 } }).fundingEstimate.cashoutCycleProfitCents, 20);
});

test("平均折扣取样隔离账户组合，不向其他人的未知余额传播成本", () => {
  const input = chain(); input.csv.push({ ...steam("other-in", "sell", 2, "Unknown Case", 100), scope: "other" });
  const links = [{ id: "self", accountKeys: listAccounts(input).filter(a => a.accountId !== "other").map(a => a.key) }];
  const r = project(input, { accountLinks: links });
  assert.equal(r.fundingEstimate.assumptions.length, 1); assert.equal(r.fundingEstimate.assumptions[0].portfolioId, "self");
  assert.equal(r.fundingEstimate.walletRatio, null);
});

test("最近成交日估值按数量加权净到账，不能混入未来行情或不同磨损", () => {
  const input = { buff: [cash("buy", "buy", 1, "A Case", 200, 4), cash("sell-old", "sell", 2, "A Case", 30), cash("sell-new", "sell", 3, "A Case", 100), cash("future", "sell", 8, "A Case", 500), cash("other", "buy", 1, "A Case (Minimal Wear)", 90)] };
  const r = project(input, { dateTo: "2026-10-03" }), item = r.groups.find(g => g.marketHashName === "A Case");
  assert.equal(item.remainingQuantity, 2); assert.equal(item.instrument.valuation.valueCents, 200); assert.equal(item.instrument.valuation.asOf, "2026-10-03");
  assert.equal(item.instrument.realizedProfitCents, 30); assert.equal(item.instrument.unrealizedProfitCents, 100); assert.equal(item.instrument.totalProfitCents, 130);
  assert.equal(r.groups.length, 2); assert.equal(item.category, "武器箱");
  const valuation = holdingValue({ ...item, theoretical: { routes: [{ id: "buffAsk", proceedsCents: 1000 }], quote: { buffUpdatedAt: Date.parse(at(10)) } } }, r.orders.filter(o => o.marketHashName === "A Case"), "2026-10-03");
  assert.equal(valuation.source, "historical-cash-sale"); assert.equal(valuation.valueCents, 200);
});

test("大量小额来源估算累计到分，拆分同日记录不影响合计且真实零成本保留", () => {
  const input = chain(); input.csv[1] = steam("missing", "sell", 2, "Unknown Case", 11, 11);
  const a = project(input); input.csv.splice(1, 1, ...Array.from({ length: 11 }, (_, i) => steam(`missing-${i}`, "sell", 2, "Unknown Case", 1)));
  const b = project(input); assert.deepEqual(a.fundingEstimate.assumptions, b.fundingEstimate.assumptions); assert.equal(a.fundingEstimate.assumptions[0].costCents, 8);
  const zero = chain(); zero.buff[0].paidTotalCents = 0; assert.equal(project(zero).fundingEstimate.walletRatio, 0);
});
