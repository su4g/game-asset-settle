"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const L = require("../desktop/order-ledger.cjs");
const now = Date.parse("2026-10-30T08:00:00Z");
const at = day => `2026-10-${String(day).padStart(2, "0")}T08:00:00.000Z`;
function cash(direction, id, day, cents, patch = {}) {
  return { key: `buff:${id}`, accountId: "buff:owner", appid: 730, direction, channel: "history", orderId: id,
    goodsId: "123", name: "测试物品", marketHashName: "A Case", quantity: 1, currencyCode: "CNY", completed: true,
    paidTotalCents: direction === "buy" ? cents : null, netTotalCents: direction === "sell" ? cents : null,
    grossTotalCents: cents, tradedAt: at(day), ...patch };
}
function steam(direction, id, day, cents, patch = {}) {
  return { key: `steam:${id}`, scope: "Steam 主号", platform: "steam", platformName: "Steam", appid: "730",
    type: direction === "buy" ? "purchase" : "sale", orderId: id, itemName: "A Case", marketHashName: "A Case",
    quantity: 1, currency: "CNY", totalCents: cents, date: at(day).slice(0, 10), sourceTime: at(day),
    sourceFormat: "steam-market-history", amountSemantics: "actual", ...patch };
}
function build(input, options = {}) {
  return L.buildAggregateLedger(input, { now, accountLinks: [{ id: "self", accountKeys: L.listAccounts(input).map(row => row.key) }], ...options });
}
const item = (result, name) => result.groups.find(row => row.marketHashName === name);
function weightedChain() {
  return { buff: [cash("buy", "a", 1, 80), cash("buy", "b", 1, 180, { marketHashName: "B Case" }),
    cash("buy", "d", 3, 50, { marketHashName: "D Case" }), cash("sell", "c-out", 4, 140, { marketHashName: "C Case" }),
    cash("sell", "d-out", 4, 65, { marketHashName: "D Case" })],
    csv: [steam("sell", "a-in", 2, 100), steam("sell", "b-in", 2, 200, { marketHashName: "B Case" }),
      steam("buy", "c", 3, 150, { marketHashName: "C Case" })] };
}

test("外部现金只在现金平台买入计入；挂刀不确认盈利，完整提现只减一次真实本金", () => {
  const input = { buff: [cash("buy", "a", 1, 80), cash("sell", "c", 4, 90, { marketHashName: "B Case" })],
    csv: [steam("sell", "s", 2, 100), steam("buy", "b", 3, 100, { marketHashName: "B Case" })] };
  const knifeOnly = build(input, { dateTo: "2026-10-02" });
  assert.equal(knifeOnly.summary.cashInvestedCents, 80); assert.equal(knifeOnly.summary.realizedProfitCents, 0);
  assert.equal(knifeOnly.summary.walletBalanceCents, 100); assert.equal(knifeOnly.summary.walletCashBasisCents, 80);
  const r = build(input);
  assert.equal(r.summary.cashInvestedCents, 80); assert.equal(r.summary.cashReceivedCents, 90);
  assert.equal(r.summary.knifeQuantity, 1); assert.equal(r.summary.cashoutQuantity, 1); assert.equal(r.summary.directQuantity, 0);
  assert.equal(r.summary.cashoutSteamSpentCents, 100); assert.equal(r.summary.cashoutAllocatedCostCents, 80);
  assert.equal(r.summary.cashoutCycleProfitCents, 10); assert.equal(r.summary.realizedProfitCents, 10);
  assert.equal(r.summary.walletBalanceCents, 0); assert.equal(r.summary.walletCashBasisCents, 0);
  assert.equal(r.holdings.length, 0);
});

test("钱包按合并余额平均现金成本结转，提现与直接盈利合计守恒", () => {
  const r = build(weightedChain()), s = r.summary;
  assert.equal(s.cashInvestedCents, 310); assert.equal(s.cashReceivedCents, 205);
  assert.equal(s.cashoutAllocatedCostCents, 130); assert.equal(s.cashoutCycleProfitCents, 10);
  assert.equal(s.directCashSpentCents, 50); assert.equal(s.directRealizedProfitCents, 15);
  assert.equal(s.realizedProfitCents, 25); assert.equal(s.walletBalanceCents, 150); assert.equal(s.walletCashBasisCents, 130);
  assert.equal(s.cashReceivedCents + s.walletCashBasisCents - s.cashInvestedCents, s.realizedProfitCents);
  assert.equal(item(r, "C Case").cashout.allocatedCostCents, 130); assert.equal(r.holdings.length, 0);
});

test("日期区间承接期初钱包和双来源持仓，不重复计算历史投入", () => {
  const input = weightedChain(), fromBuy = build(input, { dateFrom: "2026-10-03" });
  assert.equal(fromBuy.wallets[0].openingFaceBalanceCents, 300); assert.equal(fromBuy.wallets[0].openingCashBasisCents, 260);
  assert.equal(fromBuy.summary.cashInvestedCents, 50); assert.equal(fromBuy.summary.realizedProfitCents, 25);
  const fromSale = build(input, { dateFrom: "2026-10-04", dateTo: "2026-10-04" });
  assert.equal(fromSale.wallets[0].openingFaceBalanceCents, 150); assert.equal(fromSale.wallets[0].openingCashBasisCents, 130);
  assert.equal(item(fromSale, "C Case").opening.steam.cashBasisCents, 130);
  assert.equal(item(fromSale, "D Case").opening.cash.costCents, 50);
  assert.equal(fromSale.summary.cashInvestedCents, 0); assert.equal(fromSale.summary.cashReceivedCents, 205);
  assert.equal(fromSale.summary.realizedProfitCents, 25); assert.equal(fromSale.summary.walletCashBasisCents, 130);
  assert.equal(fromSale.profitCurve.at(-1).realizedProfitCents, 25);
});

test("Steam 买后再卖只回流钱包真实成本，不计第二次挂刀或已实现盈利", () => {
  const input = { buff: [cash("buy", "a", 1, 80), cash("sell", "c", 6, 50, { marketHashName: "C Case" })],
    csv: [steam("sell", "a-out", 2, 100), steam("buy", "b", 3, 100, { marketHashName: "B Case" }),
      steam("sell", "b-out", 4, 120, { marketHashName: "B Case" }), steam("buy", "c", 5, 60, { marketHashName: "C Case" })] };
  const internal = build(input, { dateTo: "2026-10-04" });
  assert.equal(internal.summary.realizedProfitCents, 0); assert.equal(internal.summary.walletBalanceCents, 120);
  assert.equal(internal.summary.walletCashBasisCents, 80); assert.equal(internal.summary.knifeQuantity, 1); assert.equal(internal.summary.steamReturnQuantity, 1);
  const r = build(input);
  assert.equal(r.summary.cashInvestedCents, 80); assert.equal(r.summary.realizedProfitCents, 10);
  assert.equal(r.summary.walletBalanceCents, 60); assert.equal(r.summary.walletCashBasisCents, 40);
  assert.equal(item(r, "B Case").steamReturn.allocatedCostCents, 80); assert.equal(r.holdings.length, 0);
});

test("同日 Steam 买卖缺少期初资金时净掉数量，但不凭面值创造现金成本", () => {
  const r = build({ csv: [steam("buy", "b", 1, 100), steam("sell", "s", 1, 120)] });
  assert.equal(r.summary.steamReturnQuantity, 1); assert.equal(r.summary.knifeQuantity, 0);
  assert.equal(item(r, "A Case").remainingQuantity, 0); assert.equal(r.holdings.length, 0);
  assert.equal(r.summary.walletBalanceCents, 120); assert.equal(r.summary.walletCashBasisCents, null);
  assert.equal(r.summary.minimumUnknownFundingCents, 100); assert.equal(r.summary.realizedProfitCents, 0);
});

test("全天跨平台优先分配数量，现金池先挂刀、Steam 池先提现", () => {
  const input = { buff: [cash("buy", "b", 1, 200, { quantity: 2 }), cash("sell", "s", 1, 220, { quantity: 2 })],
    csv: [steam("buy", "b", 1, 200, { quantity: 2 }), steam("sell", "s", 1, 240, { quantity: 2 })] };
  const r = build(input), g = item(r, "A Case");
  assert.equal(g.knife.quantity, 2); assert.equal(g.cashout.quantity, 2);
  assert.equal(g.direct.quantity, 0); assert.equal(g.steamReturn.quantity, 0); assert.equal(g.remainingQuantity, 0);
  assert.equal(r.summary.cashInvestedCents, 200); assert.equal(r.summary.minimumUnknownFundingCents, 0);
  assert.equal(r.summary.walletBalanceCents, 40);
  assert.equal(r.summary.cashReceivedCents + r.summary.walletCashBasisCents - r.summary.cashInvestedCents, r.summary.realizedProfitCents);
});

test("各种日内买卖数量保持双来源池守恒，不靠逐笔 ID 选择路线", () => {
  for (const [cashBuy, steamBuy, cashSell, steamSell] of [[3, 2, 2, 2], [2, 3, 4, 2], [1, 1, 3, 3], [0, 2, 0, 2], [3, 0, 2, 0]]) {
    const input = { buff: [cashBuy && cash("buy", "b", 1, cashBuy * 100, { quantity: cashBuy }), cashSell && cash("sell", "s", 1, cashSell * 110, { quantity: cashSell })].filter(Boolean),
      csv: [steamBuy && steam("buy", "b", 1, steamBuy * 100, { quantity: steamBuy }), steamSell && steam("sell", "s", 1, steamSell * 120, { quantity: steamSell })].filter(Boolean) };
    const r = build(input), g = item(r, "A Case");
    const knife = Math.min(cashBuy, steamSell), cashout = Math.min(steamBuy, cashSell);
    const direct = Math.min(cashBuy - knife, cashSell - cashout), returned = Math.min(steamBuy - cashout, steamSell - knife);
    assert.deepEqual([g.knife.quantity, g.cashout.quantity, g.direct.quantity, g.steamReturn.quantity], [knife, cashout, direct, returned]);
    assert.equal(g.cashHolding.quantity, cashBuy - knife - direct); assert.equal(g.steamHolding.quantity, steamBuy - cashout - returned);
    assert.equal(g.remainingQuantity + knife + cashout + direct + returned, cashBuy + steamBuy);
    assert.equal(r.summary.uncoveredSaleQuantity, cashSell + steamSell - knife - cashout - direct - returned);
  }
});

test("无日期现金出售不从完整盈利中消失，合法记录已知收益仍可单独查看", () => {
  const input = weightedChain(); input.buff.push(cash("sell", "undated", 5, 200, { tradedAt: null }));
  const r = build(input);
  assert.equal(r.summary.realizedProfitCents, null); assert.equal(r.summary.knownRealizedProfitCents, 25);
  assert(r.quality.missingTimeCount > 0); assert.equal(r.profitCurve.at(-1).realizedProfitCents, null);
});

test("结束日期之后的异常买入不污染已结束期间的已知成本", () => {
  const input = { buff: [cash("buy", "b", 1, 100), cash("sell", "s", 2, 150),
    cash("buy", "later-invalid", 20, 100, { quantity: null })] };
  const r = build(input, { dateTo: "2026-10-02" });
  assert.equal(r.summary.cashInvestedCents, 100); assert.equal(r.summary.realizedProfitCents, 50);
  assert.equal(r.profitCurve.at(-1).realizedProfitCents, 50);
  assert.equal(build(input).summary.knownRealizedProfitCents, 50);
});

test("物品数量无效的 Steam 支出仍扣钱包，后续买入不能重复借用该笔本金", () => {
  const input = { buff: [cash("buy", "a", 1, 80)], csv: [steam("sell", "s", 2, 100),
    steam("buy", "invalid", 3, 100, { quantity: null, marketHashName: "Invalid Case" }),
    steam("buy", "new", 4, 100, { marketHashName: "New Case" })] };
  const r = build(input), g = item(r, "New Case");
  assert.equal(g.steamHolding.cashBasisCents, null); assert.equal(r.summary.minimumUnknownFundingCents, 100);
  assert(r.quality.invalidRecordCount > 0);
});

test("本人不同 Steam 账户的钱包资金不互相借用", () => {
  const input = { buff: [cash("buy", "a", 1, 80)], csv: [steam("sell", "s", 2, 100),
    steam("buy", "b", 3, 100, { scope: "Steam 次号", marketHashName: "B Case" })] };
  const r = build(input);
  assert.equal(item(r, "B Case").steamHolding.cashBasisCents, null);
  assert(r.wallets.some(wallet => wallet.faceBalanceCents === 100 && wallet.cashBasisCents === 80));
  assert.equal(r.summary.minimumUnknownFundingCents, 100);
});

test("同类目跨钱包出售按物品均价结转本金，不按各钱包售价重分本金", () => {
  const input = { buff: [cash("buy", "a", 1, 200, { quantity: 2 }), cash("sell", "c", 4, 150, { marketHashName: "C Case" })],
    csv: [steam("sell", "s1", 2, 100), steam("sell", "s2", 2, 200, { scope: "Steam 次号" }),
      steam("buy", "b", 3, 100, { marketHashName: "C Case" })] };
  const r = build(input);
  assert.equal(r.summary.cashoutAllocatedCostCents, 100); assert.equal(r.summary.realizedProfitCents, 50);
  assert(r.wallets.some(wallet => wallet.faceBalanceCents === 200 && wallet.cashBasisCents === 100));
});

test("另一个钱包收入金额未知时不改变当前钱包的实际面值和均价本金", () => {
  const input = { buff: [cash("buy", "a", 1, 200, { quantity: 2 }), cash("sell", "c", 4, 150, { marketHashName: "C Case" })],
    csv: [steam("sell", "s1", 2, 100), steam("sell", "s2", 2, null, { scope: "Steam 次号" }),
      steam("buy", "b", 3, 100, { marketHashName: "C Case" })] };
  const r = build(input);
  assert.equal(r.summary.cashoutAllocatedCostCents, 100); assert.equal(r.summary.realizedProfitCents, 50);
  assert.equal(r.summary.minimumUnknownFundingCents, 0);
  assert(r.wallets.some(wallet => wallet.faceBalanceCents === null && wallet.cashBasisCents === 100));
});

test("未知买入本金可以转成已知钱包面值，但不能生成确定提现盈利", () => {
  const input = { buff: [cash("buy", "a", 1, null), cash("sell", "b", 4, 90, { marketHashName: "B Case" })],
    csv: [steam("sell", "s", 2, 100), steam("buy", "b", 3, 100, { marketHashName: "B Case" })] };
  const r = build(input);
  assert.equal(r.summary.cashInvestedCents, null); assert.equal(r.summary.knownCashInvestedCents, 0);
  assert.equal(r.summary.cashoutAllocatedCostCents, null); assert.equal(r.summary.realizedProfitCents, null);
  assert.equal(r.summary.minimumUnknownFundingCents, 0);
});

test("真实历史提现比例超过设置输入上限时仍可核算，历史比率不被当作非法用户设置", () => {
  const input = { buff: [cash("buy", "a", 1, 10), cash("sell", "b", 4, 200, { marketHashName: "B Case" })],
    csv: [steam("sell", "s", 2, 10), steam("buy", "b", 3, 10, { marketHashName: "B Case" })] };
  const r = build(input);
  assert.equal(r.summary.realizedProfitCents, 190); assert.equal(r.summary.cashoutRatio, 20);
  assert.equal(r.summary.estimatedCashoutRatio, 20);
});

test("开始日期只筛选期间活动，期前历史提现比率继续用于剩余钱包和持仓估值", () => {
  const input = weightedChain(); input.csv.push(steam("buy", "e", 5, 60, { marketHashName: "E Case" }));
  const all = build(input), later = build(input, { dateFrom: "2026-10-06" });
  for (const r of [all, later]) {
    assert.equal(r.summary.estimatedCashoutRatio, 140 / 150); assert.equal(r.summary.valuationSource, "historical-cashout");
    assert.equal(r.summary.walletBalanceCents, 90); assert.equal(r.summary.walletCashBasisCents, 78);
    assert.equal(r.summary.walletEstimatedValueCents, 84);
    assert.equal(item(r, "E Case").steamHolding.cashBasisCents, 52);
    assert.equal(item(r, "E Case").steamHolding.estimatedValueCents, 56);
  }
  assert.equal(later.summary.cashInvestedCents, 0); assert.equal(later.summary.realizedProfitCents, 0);
  const beforeCashout = build(input, { dateTo: "2026-10-03", pricingSettings: { targetCashoutRatio: 0.7 } });
  assert.equal(beforeCashout.summary.valuationSource, "configured-estimate"); assert.equal(beforeCashout.summary.estimatedCashoutRatio, 0.7);
});

test("从持仓排除类目可恢复，历史成本分配、现金投入和已实现收益保持原值", () => {
  const input = { buff: [cash("buy", "b", 1, 100, { quantity: 2 }), cash("sell", "s", 2, 150)] }, before = structuredClone(input);
  const original = build(input), id = original.holdings[0].id;
  const excluded = build(input, { excludedHoldingIds: [id] });
  assert.equal(excluded.holdings.length, 0); assert.equal(excluded.excludedHoldings[0].inventoryCostCents, 50);
  assert.equal(excluded.summary.holdingCostCents, 0); assert.equal(excluded.summary.cashInvestedCents, 100);
  assert.equal(excluded.summary.realizedProfitCents, 100); assert.equal(excluded.groups[0].direct.allocatedCostCents, 50);
  assert.equal(build(input).holdings[0].id, id); assert.equal(build(input).summary.holdingCostCents, 50); assert.deepEqual(input, before);
});

test("同名同账户的不同币种不能串来源池或钱包成本", () => {
  const input = { buff: [cash("buy", "b", 1, 80)], csv: [steam("sell", "s", 2, 100, { currency: "USD" })] };
  const r = build(input), usd = r.summary.currencies.find(row => row.currencyCode === "USD");
  assert.equal(r.summary.cashInvestedCents, 80); assert.equal(r.summary.holdingCostCents, 80); assert.equal(r.summary.knifeQuantity, 0);
  assert.equal(r.summary.walletBalanceCents, 0); assert.equal(usd.walletBalanceCents, 100); assert.equal(usd.walletCashBasisCents, null);
  assert.equal(usd.uncoveredSaleQuantity, 1); assert.equal(r.groups.length, 2);
});

test("整批与拆成百笔同价交易的现金本金、钱包余分和总利润一致", () => {
  const start = [cash("buy", "a", 1, 8001, { quantity: 100 })], incoming = steam("sell", "s", 2, 9900, { quantity: 100 });
  const bulk = build({ buff: [...start, cash("sell", "s", 4, 9000, { quantity: 100, marketHashName: "B Case" })],
    csv: [incoming, steam("buy", "b", 3, 9900, { quantity: 100, marketHashName: "B Case" })] });
  const split = build({ buff: [...start, ...Array.from({ length: 100 }, (_, i) => cash("sell", `s${i}`, 4, 90, { marketHashName: "B Case" }))],
    csv: [incoming, ...Array.from({ length: 100 }, (_, i) => steam("buy", `b${i}`, 3, 99, { marketHashName: "B Case" }))] });
  for (const key of ["cashInvestedCents", "cashReceivedCents", "cashoutAllocatedCostCents", "realizedProfitCents", "walletBalanceCents", "walletCashBasisCents", "minimumUnknownFundingCents"])
    assert.equal(split.summary[key], bulk.summary[key], key);
  assert.equal(bulk.summary.realizedProfitCents, 999); assert.equal(bulk.summary.walletCashBasisCents, 0);
  assert.equal(split.holdings.length, 0);
});
