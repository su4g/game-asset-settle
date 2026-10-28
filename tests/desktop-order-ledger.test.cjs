"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const L = require("../desktop/order-ledger.cjs"), P = require("../desktop/pricing.js");
const now = Date.parse("2026-10-30T08:00:00Z");
const at = day => `2026-10-${String(day).padStart(2, "0")}T08:00:00.000Z`;
function cash(platform, direction, id, day, cents, patch = {}) {
  return { key: `${platform}:${id}`, accountId: `${platform}:owner`, appid: 730, direction, channel: "history", orderId: id,
    goodsId: "123", name: "测试物品", marketHashName: "Test Case", quantity: 1, currencyCode: "CNY", completed: true,
    paidTotalCents: direction === "buy" ? cents : null, netTotalCents: direction === "sell" ? cents : null,
    grossTotalCents: cents, tradedAt: at(day), ...patch };
}
function steam(direction, id, day, cents, patch = {}) {
  return { key: `steam:${id}`, scope: "Steam 主号", platform: "steam", platformName: "Steam", appid: "730",
    type: direction === "buy" ? "purchase" : "sale", orderId: id, itemName: "Test Case", marketHashName: "Test Case",
    quantity: 1, currency: "CNY", totalCents: cents, date: at(day).slice(0, 10), sourceTime: at(day), ...patch };
}
function sequencedSteam(direction, id, day, cents, row, patch = {}) {
  return steam(direction, id, day, cents, { sourceTime: at(day).slice(0, 10), sourceRow: row,
    sourceFormat: "steam-market-history", amountSemantics: "actual",
    sourceSequence: { format: "steam-market-history", documentHash: "a".repeat(64), row, direction: "newest-first" }, ...patch });
}
function linked(input, options = {}) {
  const accounts = L.listAccounts(input);
  return { now, accountLinks: [{ id: "main", accountKeys: accounts.map(row => row.key) }],
    csvAmountSemantics: Object.fromEntries(accounts.filter(row => row.source === "csv").map(row => [row.key, "actual"])), ...options };
}
const build = (input, options) => L.buildOrderLedger(input, linked(input, options));

test("引擎按调用方传入的组合匹配；同名 CSV scope 与原生账号保持不同身份", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 80)], csv: [steam("sell", "s", 9, 100)] };
  const standalone = L.buildOrderLedger(input, { now });
  assert.equal(standalone.matches.length, 0); assert.equal(standalone.holdings.length, 1);
  assert.equal(build(input).matches[0].route, "knife");
  const accounts = L.listAccounts({ buff: input.buff, csv: [{ ...input.csv[0], platform: "buff", scope: "buff:owner" }] });
  assert.equal(accounts.length, 2); assert.notEqual(accounts[0].key, accounts[1].key);
  assert.throws(() => build(input, { accountLinks: [{ id: "a", accountKeys: [accounts[0].key] }, { id: "b", accountKeys: [accounts[0].key] }] }), /多个账户组合/);
});

test("跨 Steam 七天边界精确到毫秒，日精度不会假定已满 CD", () => {
  const buy = cash("buff", "buy", "b", 1, 80);
  const early = steam("sell", "s", 8, 100, { sourceTime: "2026-10-08T07:59:59.999Z" });
  assert.equal(build({ buff: [buy], csv: [early] }).matches.length, 0);
  assert.equal(build({ buff: [buy], csv: [steam("sell", "s", 8, 100)] }).matches.length, 1);
  const dayOnly = steam("sell", "s", 8, 100, { sourceTime: "2026/10/08" });
  const r = build({ buff: [buy], csv: [dayOnly] });
  assert.equal(r.matches.length, 0); assert.ok(r.anomalies.some(row => row.code === "unmatched_sale_cd"));
  assert.equal(build({ buff: [buy], csv: [{ ...dayOnly, date: "2026-10-09" }] }).matches.length, 1);
});

test("FIFO 分批数量及整数余分守恒，不按最有利买价选择", () => {
  const input = { buff: [cash("buff", "buy", "b1", 1, 1001, { quantity: 3 }), cash("buff", "buy", "b2", 2, 100)],
    uu: [cash("uu", "sell", "s1", 3, 701, { quantity: 2 }), cash("uu", "sell", "s2", 4, 800, { quantity: 2 })] };
  const r = build(input);
  assert.deepEqual(r.matches.map(row => [row.quantity, row.costCents, row.proceedsCents]), [[2, 667, 701], [1, 334, 400], [1, 100, 400]]);
  assert.equal(r.summary.realizedProfitCents, 400); assert.equal(r.holdings.length, 0);
  assert.ok(r.matches.every(row => row.inferred && row.matchingMethod === "fifo" && row.route === "direct"));
  assert.equal(r.profitCurve.at(-1).realizedProfitCents, 400);
});

test("同平台转卖是直接盈利，超量卖出单独报告且不产生负持仓", () => {
  const r = build({ buff: [cash("buff", "buy", "b", 1, 100), cash("buff", "sell", "s", 2, 300, { quantity: 2 })] });
  assert.equal(r.matches[0].route, "direct"); assert.equal(r.matches[0].cashProfitCents, 50);
  assert.equal(r.unmatchedSales[0].unmatchedQuantity, 1); assert.equal(r.unmatchedSales[0].unmatchedAmountCents, 150);
  assert.equal(r.holdings.length, 0); assert.ok(r.anomalies.some(row => row.code === "unmatched_sale"));
});

test("UU 未知实付或净到账保留数量，不用标价或零填充利润", () => {
  const r = build({ uu: [cash("uu", "buy", "b", 1, null, { grossTotalCents: 100 })], csv: [steam("sell", "s", 9, 150)] });
  assert.equal(r.matches.length, 1); assert.equal(r.summary.knifeQuantity, 1);
  assert.equal(r.matches[0].costCents, null); assert.equal(r.matches[0].cashProfitCents, null);
  assert.equal(r.summary.knifeEstimatedCashProfitCents, null);
  assert.equal(r.summary.knownKnifeEstimatedCashProfitCents, 0);
});

test("CSV 金额含义须按明确账户确认，实际金额补录只作用于派生视图", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, null)], csv: [steam("sell", "s", 9, 150)] }, before = JSON.stringify(input);
  const initial = build(input, { csvAmountSemantics: {} });
  assert.equal(initial.matches[0].proceedsCents, null);
  const id = L.sourceId("buff", input.buff[0].key), options = { overrides: { [id]: { actualTotalCents: 100 } } };
  const r = build(input, options);
  assert.equal(r.matches[0].costCents, 100); assert.equal(r.matches[0].proceedsCents, 150);
  assert.equal(r.summary.knifeEstimatedCashProfitCents, 20); assert.equal(JSON.stringify(input), before);
  assert.throws(() => build(input, { overrides: { [id]: { actualTotalCents: 0.5 } } }), /非负整数分/);
  assert.equal(build(input, { overrides: { [id]: { actualTotalCents: 0 } } }).matches[0].costCents, 0);
});

test("标准 Steam 历史自动采用真实钱包收支，显式未知优先且不重复扣费", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 80)], csv: [steam("sell", "s", 9, 100,
    { sourceFormat: "steam-market-history", amountSemantics: "actual" })] };
  const automatic = build(input, { csvAmountSemantics: {} });
  assert.equal(automatic.matches[0].proceedsCents, 100);
  assert.equal(automatic.wallets[0].receivedCents, 100);
  assert.equal(automatic.anomalies.filter(row => row.code === "unknown_amount").length, 0);
  const key = L.listAccounts(input).find(row => row.source === "csv").key;
  assert.equal(build(input, { csvAmountSemantics: { [key]: "unknown" } }).matches[0].proceedsCents, null);
  const id = L.sourceId("csv", input.csv[0].key);
  assert.equal(build(input, { csvAmountSemantics: { [key]: "unknown" }, overrides: { [id]: { actualTotalCents: 95 } } }).matches[0].proceedsCents, 95);
  for (const patch of [{ sourceFormat: undefined }, { amountSemantics: undefined }, { sourceFormat: "generic-csv" }]) {
    assert.equal(build({ ...input, csv: [{ ...input.csv[0], ...patch }] }, { csvAmountSemantics: {} }).matches[0].proceedsCents, null);
  }
  const cashCsv = { csv: [{ ...input.csv[0], platform: "buff", platformName: "BUFF" }] };
  assert.equal(build(cashCsv, { csvAmountSemantics: {} }).orders[0].actualTotalCents, null);
  assert.equal(build({ csv: [{ ...input.csv[0], totalCents: 0, type: "purchase" }] }, { csvAmountSemantics: {} }).orders[0].actualTotalCents, 0);
});

test("持仓排除在匹配后生效，仅移除剩余数量并能恢复", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 1001, { quantity: 3 })], uu: [cash("uu", "sell", "s", 2, 400)] };
  const initial = build(input), id = initial.holdings[0].id;
  const r = build(input, { excludedHoldingIds: [id] });
  assert.equal(r.holdings.length, 0); assert.equal(r.excludedHoldings[0].remainingQuantity, 2);
  assert.equal(r.excludedHoldings[0].inventoryCostCents, 668); assert.equal(r.summary.excludedQuantity, 2);
  assert.deepEqual(r.matches, initial.matches); assert.equal(r.summary.realizedProfitCents, initial.summary.realizedProfitCents);
  assert.equal(build(input, { excludedHoldingIds: [] }).holdings[0].remainingQuantity, 2);
});

test("Steam 余额现金来源闭环：挂刀估计不重复计入最终提现实现利润", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 80)],
    csv: [steam("sell", "s", 8, 100), steam("buy", "b2", 9, 100, { marketHashName: "Other Case" })],
    uu: [cash("uu", "sell", "s2", 16, 90, { marketHashName: "Other Case" })] };
  const r = build(input), cashout = r.matches.find(row => row.route === "cashout");
  assert.equal(cashout.costCents, 100); assert.equal(cashout.cashCostCents, 80); assert.equal(cashout.cashProfitCents, 10);
  assert.equal(r.summary.knifeEstimatedCashProfitCents, 0);
  assert.equal(r.summary.realizedProfitCents, 10); assert.equal(r.summary.directRealizedProfitCents, 0);
  assert.equal(r.summary.cashoutRatio, 0.9); assert.equal(r.profitCurve.at(-1).realizedProfitCents, 10);
  assert.deepEqual(r.wallets.map(row => [row.receivedCents, row.spentCents, row.changeCents]), [[100, 100, 0]]);
});

test("Steam 开场余额来源未知，不能以面值冒充现金成本或盈利", () => {
  const input = { csv: [steam("buy", "b", 1, 100)], uu: [cash("uu", "sell", "s", 9, 90)] };
  const r = build(input), match = r.matches[0];
  assert.equal(match.route, "cashout"); assert.equal(match.cashCostCents, null); assert.equal(match.cashProfitCents, null);
  assert.equal(r.summary.realizedProfitCents, null); assert.equal(r.summary.knownRealizedProfitCents, 0);
  assert.equal(r.summary.cashoutCashReceivedCents, 90);
  const held = build({ csv: [steam("buy", "b", 1, 100)] }).holdings[0];
  assert.equal(held.inventorySteamCostCents, 100); assert.equal(held.inventoryCostCents, null);
  assert.equal(held.theoretical.bestProfitCents, null);
});

test("Steam 钱包分批分配现金余分守恒，来自另一物品的已知余额可复用", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 101)],
    csv: [steam("sell", "s", 8, 300), steam("buy", "b1", 9, 100, { marketHashName: "A Case" }), steam("buy", "b2", 10, 200, { marketHashName: "B Case" })] };
  const r = build(input), values = r.holdings.map(row => row.inventoryCostCents);
  assert.deepEqual(values, [33, 68]); assert.equal(r.summary.holdingCostCents, 101);
  assert.equal(r.summary.steamHoldingCostCents, 300);
});

test("未知 Steam 流量及同日不明时序不能推定现金来源", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 80)], csv: [steam("sell", "s", 9, 100, { sourceTime: "2026/10/09" }), steam("buy", "b2", 9, 100, { marketHashName: "Other Case" })] };
  assert.equal(build(input).holdings.find(row => row.platform === "steam").inventoryCostCents, null);
  input.csv[0].sourceTime = at(8); input.csv.unshift(steam("buy", "unknown", 2, null, { marketHashName: "Old Case" }));
  assert.equal(build(input).holdings.find(row => row.marketHashName === "Other Case").inventoryCostCents, null);
});

test("精确名称/游戏/币种隔离；冲突中文别名不进行猜测", () => {
  const buy = cash("buff", "buy", "b", 1, 80, { marketHashName: "", name: "箱子" });
  const names = { items: { "730:Test Case": { appid: 730, marketHashName: "Test Case", name: "箱子" } } };
  const input = { buff: [buy], csv: [steam("sell", "s", 9, 100)], names };
  assert.equal(build(input).matches.length, 1);
  for (const patch of [{ marketHashName: "test case" }, { appid: "570" }, { currency: "USD" }]) {
    assert.equal(build({ ...input, csv: [{ ...input.csv[0], ...patch }] }).matches.length, 0);
  }
  names.items["730:Other Case"] = { appid: 730, marketHashName: "Other Case", name: "箱子" };
  const r = build(input); assert.equal(r.matches.length, 0); assert.ok(r.anomalies.some(row => row.code === "unresolved_name"));
});

test("缺失成交时间、数量、账户与未完成记录不会被模拟补齐", () => {
  const rows = [cash("buff", "buy", "time", 1, 100, { tradedAt: null, observedAt: at(1), createdAt: at(1) }),
    cash("buff", "buy", "quantity", 1, 100, { quantity: null }), cash("buff", "buy", "account", 1, 100, { accountId: "" }),
    cash("buff", "buy", "open", 1, 100, { completed: false }), cash("buff", "buy", "pending", 1, 100, { channel: "pending" })];
  const r = build({ buff: rows });
  assert.equal(r.orders.length, 0); assert.equal(r.ignoredCount, 2);
  assert.deepEqual(r.anomalies.map(row => row.code), ["missing_trade_time", "invalid_quantity", "missing_account"]);
});

test("持仓预期收益复用现有手续费/报价时效，未知价格不填零", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 346)] };
  const quote = P.normalizeRow({ appid: 730, marketHashName: "Test Case", goodsId: "123", source: "manual", buffPriceCents: 408,
    buffBuyPriceCents: 380, steamLowestSellCents: 625, buffUpdatedAt: now, buffBuyUpdatedAt: now, steamUpdatedAt: now });
  const before = JSON.stringify(quote), r = build(input, { quotes: [quote], pricingSettings: { targetCashoutRatio: 0.8 } });
  assert.equal(r.holdings[0].theoretical.steamNetCents, 544); assert.equal(r.summary.theoreticalProfitCents, 89);
  assert.equal(r.summary.realizedProfitCents, 0); assert.equal(JSON.stringify(quote), before);
  assert.equal(build(input, { quotes: [{ ...quote, buffUpdatedAt: now - P.TTL, buffBuyUpdatedAt: now - P.BUY_TTL, steamUpdatedAt: now - P.TTL }] }).summary.theoreticalProfitCents, null);
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("组合筛选只汇总所选数据，未组合账户使用稳定独立 ID", () => {
  const input = { buff: [cash("buff", "buy", "a", 1, 100), cash("buff", "buy", "b", 1, 200, { accountId: "buff:second" })] };
  const accounts = L.listAccounts(input), first = accounts.find(row => row.accountId === "buff:owner");
  const r = L.buildOrderLedger(input, { now, portfolioId: `account:${first.key}` });
  assert.equal(r.holdings.length, 1); assert.equal(r.summary.holdingCostCents, 100); assert.equal(r.accounts.length, 2);
});

test("不同币种各自汇总且保持现金与 Steam 面值分离", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 100), cash("buff", "sell", "s", 2, 150),
    cash("buff", "buy", "u1", 1, 1000, { currencyCode: "USD" }), cash("buff", "sell", "u2", 2, 1300, { currencyCode: "USD" })] };
  const r = build(input);
  assert.equal(r.summary.realizedProfitCents, 50);
  assert.equal(r.summary.currencies.find(row => row.currencyCode === "USD").realizedProfitCents, 300);
});

test("未知盈利使完整曲线留空，已知子集单独显示，零成本保留为零", () => {
  const input = { buff: [cash("buff", "buy", "b1", 1, null), cash("buff", "buy", "b2", 2, 0),
    cash("buff", "sell", "s1", 3, 100), cash("buff", "sell", "s2", 4, 50)] };
  const r = build(input);
  assert.equal(r.summary.realizedProfitCents, null); assert.equal(r.summary.knownRealizedProfitCents, 50);
  assert.equal(r.profitCurve.at(-1).realizedProfitCents, null); assert.equal(r.profitCurve.at(-1).knownRealizedProfitCents, 50);
});

test("订单重复按可靠键处理，同名同价不同记录不丢失", () => {
  const buy = cash("buff", "buy", "b", 1, 100);
  const r = build({ buff: [buy, { ...buy }, { ...buy, key: "buff:other", orderId: "other" }] });
  assert.equal(r.holdings.length, 2); assert.equal(r.summary.holdingQuantity, 2);
  assert.throws(() => build({ buff: [buy, { ...buy, paidTotalCents: 101 }] }), /不同内容/);
});

test("归档对象输入兼容，纯计算不写入任何历史", () => {
  const row = cash("buff", "buy", "b", 1, 100), input = { buff: { data: { accounts: { "buff:owner": { records: [row] } } } } };
  const before = JSON.stringify(input), r = build(input);
  assert.equal(r.summary.holdingCostCents, 100); assert.equal(JSON.stringify(input), before);
});

test("分配大额乘法不丢分，汇总溢出明确拒绝", () => {
  const total = Number.MAX_SAFE_INTEGER, quantities = [1, 2, 3, 1000000];
  for (const quantity of quantities) {
    const first = L.portion(total, 0, quantity - 1, quantity), last = L.portion(total, quantity - 1, 1, quantity);
    assert.equal(first + last, total);
  }
  assert.throws(() => build({ buff: [cash("buff", "buy", "b1", 1, total), cash("buff", "buy", "b2", 1, total)] }), /超出安全计算范围/);
});

test("未匹配或无日期现金卖出使完整盈利待核对，保留已知盈利子集", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 100), cash("buff", "sell", "s", 2, 200), cash("buff", "sell", "extra", 3, 50)] };
  const r = build(input);
  assert.equal(r.summary.realizedProfitCents, null); assert.equal(r.summary.knownRealizedProfitCents, 100);
  assert.equal(r.summary.unknownRealizedProfitCount, 1);
  assert.equal(r.profitCurve.at(-1).realizedProfitCents, null); assert.equal(r.profitCurve.at(-1).knownRealizedProfitCents, 100);
  input.buff[2].tradedAt = null;
  const undated = build(input);
  assert.equal(undated.summary.realizedProfitCents, null); assert.equal(undated.profitCurve[0].realizedProfitCents, null);
  assert.equal(undated.profitCurve[0].knownRealizedProfitCents, 100);
});

test("无法识别物品与数量的 Steam 订单仍消耗真实钱包余额", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 80)], csv: [steam("sell", "s", 8, 100),
    steam("buy", "unresolved", 9, 100, { marketHashName: "中文未映射", itemName: "中文未映射", quantity: null }),
    steam("buy", "b2", 10, 100, { marketHashName: "Other Case" })] };
  const r = build(input), holding = r.holdings.find(row => row.marketHashName === "Other Case");
  assert.equal(holding.inventoryCostCents, null); assert.equal(r.wallets[0].spentCents, 200);
  assert.equal(r.walletEvents.length, 3); assert.equal(r.orders.length, 3);
  // With no possible chronological location, that transaction must invalidate
  // any apparently certain later allocation in the same wallet.
  input.csv[1].date = "";
  const undated = build(input);
  assert.equal(undated.unplacedWalletEvents.length, 1);
  assert.equal(undated.wallets[0].spentCents, 200); assert.equal(undated.wallets[0].cashBasisComplete, false);
  assert.equal(undated.holdings.find(row => row.marketHashName === "Other Case").inventoryCostCents, null);
});

test("同日时序不明的 Steam 余额不能在次日重复分配现金来源", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 80)], csv: [steam("sell", "s", 9, 100, { sourceTime: "2026/10/09" }),
    steam("buy", "sameDay", 9, 100, { marketHashName: "Same Day Case" }), steam("buy", "later", 10, 100, { marketHashName: "Later Case" })] };
  const r = build(input);
  assert.ok(r.holdings.every(row => row.inventoryCostCents == null));
  assert.ok(r.anomalies.some(row => row.code === "wallet_time_uncertain"));
  assert.equal(r.wallets[0].cashBasisComplete, false);
});

test("可信同一导出的逆行号决定同日钱包FIFO，日期及七天CD边界保持原样", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 80)], csv: [sequencedSteam("buy", "b2", 9, 100, 2, { marketHashName: "Other Case" }),
    sequencedSteam("sell", "s", 9, 100, 3)], uu: [cash("uu", "sell", "s2", 17, 90, { marketHashName: "Other Case" })] };
  const before = JSON.stringify(input), r = build(input, { csvAmountSemantics: {} });
  assert.equal(r.matches.find(row => row.route === "cashout").cashCostCents, 80);
  assert.equal(r.summary.realizedProfitCents, 10);
  assert.equal(r.anomalies.some(row => row.code === "wallet_time_uncertain"), false);
  assert.equal(r.wallets[0].sourceSequenceDays, 1);
  assert.ok(r.orders.filter(row => row.platform === "steam").every(row => row.timePrecision === "day" && row.tradedAt === "2026-10-09" && row.timeEnd - row.timeStart === L.DAY - 1));
  assert.equal(JSON.stringify(input), before);
  input.uu[0].tradedAt = at(16);
  assert.equal(build(input).matches.some(row => row.route === "cashout"), false);
});

test("可信顺序中的先买后卖不借用未来余额，次日可以使用剩余已知来源", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 80)], csv: [sequencedSteam("sell", "s", 9, 100, 3),
    sequencedSteam("buy", "earlier", 9, 100, 4, { marketHashName: "Earlier Case" }),
    sequencedSteam("buy", "later", 10, 100, 2, { marketHashName: "Later Case" })] };
  const r = build(input);
  assert.equal(r.holdings.find(row => row.marketHashName === "Earlier Case").inventoryCostCents, null);
  assert.equal(r.holdings.find(row => row.marketHashName === "Later Case").inventoryCostCents, 80);
});

test("同日不同文件指纹、缺证据、重复行号或混合精度均保守回退", () => {
  const base = { buff: [cash("buff", "buy", "b", 1, 80)], csv: [sequencedSteam("sell", "s", 9, 100, 3, { fileName: "same.csv" }),
    sequencedSteam("buy", "b2", 9, 100, 2, { marketHashName: "Other Case", fileName: "same.csv" })] };
  const metadata = base.csv[1].sourceSequence;
  const patches = [{ sourceSequence: { ...metadata, documentHash: "b".repeat(64) } }, { sourceSequence: null },
    { sourceSequence: { ...metadata, row: 3 }, sourceRow: 3 }, { sourceSequence: { ...metadata, row: 6 } },
    { sourceSequence: { ...metadata, direction: "oldest-first" } }, { sourceSequence: { ...metadata, documentHash: "invalid" } },
    { sourceFormat: "generic-csv" }, { sourceTime: at(9) }];
  for (const patch of patches) {
    const input = { ...base, csv: [base.csv[0], { ...base.csv[1], ...patch }] }, r = build(input);
    assert.equal(r.holdings[0].inventoryCostCents, null, JSON.stringify(patch));
    assert.ok(r.anomalies.some(row => row.code === "wallet_time_uncertain"), JSON.stringify(patch));
  }
  const crossDay = { ...base, csv: [base.csv[0], sequencedSteam("buy", "next", 10, 100, 2,
    { marketHashName: "Other Case", sourceSequence: { ...metadata, documentHash: "b".repeat(64) } })] };
  assert.equal(build(crossDay).holdings[0].inventoryCostCents, 80);
});

test("同日来源重排不改变原生现金事件次序，输入打乱也得到一致结果", () => {
  const input = { buff: [cash("buff", "buy", "old", 1, 80), cash("buff", "buy", "direct", 9, 100, { marketHashName: "Cash Case", tradedAt: "2026-10-09T01:00:00Z" })],
    uu: [cash("uu", "sell", "direct-sell", 9, 150, { marketHashName: "Cash Case", tradedAt: "2026-10-09T02:00:00Z" }),
      cash("uu", "sell", "cashout", 17, 90, { marketHashName: "Other Case" })],
    csv: [sequencedSteam("buy", "wallet-buy", 9, 100, 2, { marketHashName: "Other Case" }), sequencedSteam("sell", "wallet-sell", 9, 100, 3)] };
  const r = build(input), shuffled = build({ buff: [...input.buff].reverse(), uu: [...input.uu].reverse(), csv: [...input.csv].reverse() });
  assert.equal(r.summary.realizedProfitCents, 60);
  assert.deepEqual(shuffled.matches, r.matches); assert.deepEqual(shuffled.summary, r.summary);
});

test("同日跨钱包的精确事件依赖优先保留，不用单一文件序列制造跨来源时刻", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 80)], csv: [steam("sell", "fund-B", 8, 100, { scope: "Steam 二号" }),
    steam("buy", "buy-B", 9, 100, { scope: "Steam 二号", marketHashName: "Other Case", sourceTime: "2026-10-09T00:00:00+08:00" }),
    sequencedSteam("sell", "sell-A", 9, 100, 3, { marketHashName: "Other Case" }),
    sequencedSteam("buy", "buy-A", 9, 100, 2, { marketHashName: "Third Case" })] };
  const r = build(input);
  assert.equal(r.matches.find(row => row.route === "steam").cashCostCents, 80);
  assert.equal(r.holdings.find(row => row.marketHashName === "Third Case").inventoryCostCents, null);
  assert.ok(r.anomalies.some(row => row.code === "wallet_time_uncertain"));
});

test("本人组合允许同平台多账户及原生与 CSV，保留每笔来源身份", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 100)], csv: [{ ...steam("sell", "s", 2, 120), platform: "buff", platformName: "BUFF" }] };
  const r = build(input);
  assert.equal(r.matches.length, 1); assert.equal(r.matches[0].route, "direct");
  assert.equal(r.summary.realizedProfitCents, 20);
  input.buff.push(cash("buff", "buy", "same-price", 1, 100, { accountId: "buff:second" }));
  const multi = build(input);
  assert.equal(multi.orders.length, 3); assert.equal(multi.holdings.length, 1);
  assert.equal(multi.holdings[0].inventoryCostCents, 100);
  assert.equal(new Set(multi.orders.map(row => row.sourceId)).size, 3);
});

test("同一人的多个 Steam 账户不互相借用余额，同 scope 不同文件可追踪现金来源", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 80)], csv: [steam("sell", "s", 8, 100, { fileName: "first.csv" }),
    steam("buy", "other-account", 9, 100, { scope: "Steam 二号", marketHashName: "Other Case" }),
    steam("buy", "same-account", 10, 100, { marketHashName: "Main Case", fileName: "second.csv" })] };
  const r = build(input);
  assert.equal(r.holdings.find(row => row.marketHashName === "Other Case").inventoryCostCents, null);
  assert.equal(r.holdings.find(row => row.marketHashName === "Main Case").inventoryCostCents, 80);
  assert.equal(r.wallets.length, 2); assert.equal(new Set(r.wallets.map(row => row.accountKey)).size, 2);
  assert.equal(r.summary.holdingCostCents, null); assert.equal(r.summary.knownHoldingCostCents, 80);
  input.csv[1].date = "";
  const unknownOther = build(input);
  assert.equal(unknownOther.holdings.find(row => row.marketHashName === "Main Case").inventoryCostCents, 80);
});

test("Steam社区物品保留中文完整原名，App ID和原名严格区分且不推断跨平台对应", () => {
  const input = { csv: [steam("buy", "card-buy", 1, 15, { appid: "753", marketHashName: "庄晓曼 (Trading Card)", itemName: "庄晓曼" }),
    steam("sell", "card-sell", 2, 20, { appid: "753", marketHashName: "庄晓曼 (Trading Card)", itemName: "庄晓曼" }),
    steam("buy", "chinese-card", 1, 10, { appid: "753", marketHashName: "媛媛2", itemName: "媛媛" }),
    steam("sell", "different-name", 2, 20, { appid: "753", marketHashName: "媛媛", itemName: "媛媛" }),
    steam("sell", "different-app", 2, 20, { appid: "999", marketHashName: "媛媛2", itemName: "媛媛" })] };
  const r = build(input);
  assert.equal(r.orders.length, 5); assert.equal(r.matches.length, 1); assert.equal(r.matches[0].route, "steam");
  assert.equal(r.holdings[0].marketHashName, "媛媛2"); assert.equal(r.unmatchedSales.length, 2);
  assert.equal(r.anomalies.filter(row => row.code === "unresolved_name").length, 0);
  assert.equal(r.holdings[0].theoretical.bestProfitCents, null);
  const cross = { csv: [steam("sell", "other-steam", 9, 20, { appid: "753", marketHashName: "Other Card" }),
    { ...steam("buy", "other-platform", 1, 10, { appid: "753", marketHashName: "Other Card" }), platform: "buff", platformName: "BUFF" }] };
  assert.equal(build(cross).matches.length, 0);
  assert.equal(build({ csv: [steam("buy", "untranslated-cs", 1, 100, { marketHashName: "AK-47 | 墨岩 (久经沙场)", itemName: "AK-47 | 墨岩 (久经沙场)" })] }).orders.length, 0);
});

test("被 CD 阻挡的早期持仓不妨碍后续大量直接转卖的 FIFO", () => {
  const input = { csv: [steam("buy", "blocked", 1, 1)], buff: [] };
  for (let i = 0; i < 4000; i++) {
    const base = Date.parse(at(2)) + i * 2;
    input.buff.push(cash("buff", "buy", `b${i}`, 2, 100, { tradedAt: new Date(base).toISOString() }),
      cash("buff", "sell", `s${i}`, 2, 101, { tradedAt: new Date(base + 1).toISOString() }));
  }
  const r = build(input);
  assert.equal(r.matches.length, 4000); assert.equal(r.summary.knownRealizedProfitCents, 4000);
  assert.equal(r.holdings.length, 1); assert.equal(r.holdings[0].platform, "steam");
});

test("来源池曲线保留只有无效现金卖出的日期，完整累计与摘要一致", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 100), cash("buff", "sell", "s", 2, 150),
    cash("buff", "sell", "invalid", 3, 100, { quantity: null }), cash("buff", "buy", "later", 4, 100, { marketHashName: "Other Case" })] };
  const r = L.buildAggregateLedger(input, linked(input));
  assert.equal(r.summary.realizedProfitCents, null); assert.equal(r.summary.knownRealizedProfitCents, 50);
  assert.ok(r.profitCurve.some(row => row.date === "2026-10-03"));
  assert.equal(r.profitCurve.at(-1).realizedProfitCents, null); assert.equal(r.profitCurve.at(-1).knownRealizedProfitCents, 50);
});

test("当前钱包平均折扣与期间挂刀折扣分离，未知本金不能由已知子集冒充", () => {
  const input = { buff: [cash("buff", "buy", "b1", 1, 80, { marketHashName: "A Case" }), cash("buff", "buy", "b2", 1, 180, { marketHashName: "B Case" })],
    csv: [steam("sell", "s1", 2, 100, { marketHashName: "A Case" }), steam("buy", "p", 3, 50, { marketHashName: "C Case" }), steam("sell", "s2", 4, 200, { marketHashName: "B Case" })] };
  const r = L.buildAggregateLedger(input, linked(input, { dateFrom: "2026-10-04" }));
  assert.equal(r.summary.knifeRatio, 0.9); assert.equal(r.summary.walletBalanceCents, 250); assert.equal(r.summary.walletCashBasisCents, 220);
  assert.equal(r.summary.walletRatio, 0.88); assert.equal(r.wallets[0].walletRatio, 0.88);
  input.csv.push(steam("sell", "missing", 5, 100, { marketHashName: "No Source Case" }));
  const incomplete = L.buildAggregateLedger(input, linked(input));
  assert.equal(incomplete.summary.walletRatio, null); assert.equal(incomplete.wallets[0].walletRatio, null);
  assert.equal(incomplete.summary.knownWalletCashBasisCents, 220);
});

test("利润覆盖数量区分没有已知子集与真正零利润，曲线保留对应累计数量", () => {
  const input = { buff: [cash("buff", "buy", "b", 1, 100), cash("buff", "sell", "zero", 2, 100),
    cash("buff", "sell", "missing", 3, 100, { marketHashName: "Unknown Case" })],
    csv: [steam("buy", "unknown-basis", 1, 100, { marketHashName: "Steam Case" })],
    uu: [cash("uu", "sell", "unknown-cycle", 3, 150, { marketHashName: "Steam Case" })] };
  const r = L.buildAggregateLedger(input, linked(input));
  assert.equal(r.summary.realizedProfitCents, null); assert.equal(r.summary.knownRealizedProfitCents, 0);
  assert.equal(r.summary.knownCashoutProfitQuantity, 0); assert.equal(r.summary.knownCashoutProfitCount, 0);
  assert.equal(r.summary.knownDirectProfitQuantity, 1); assert.equal(r.summary.knownRealizedProfitCount, 1);
  assert.equal(r.groups.find(row => row.marketHashName === "Test Case").direct.knownProfitQuantity, 1);
  assert.equal(r.profitCurve.at(-1).knownRealizedProfitQuantity, 1);
  assert.equal(r.profitCurve.at(-1).knownCashoutProfitQuantity, 0);
});
