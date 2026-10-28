"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { buildProfitReport } = require("../desktop/profit-report.cjs");
const { OrderLedgerService } = require("../desktop/order-ledger-service.cjs");
const { accountKey } = require("../desktop/order-ledger.cjs");
const native = (key, name, direction, quantity, cents, date = "2020-01-01", platform = "buff") => ({ key, accountId: platform + ":me", appid: 730,
  name, marketHashName: name, category: "武器箱", direction, channel: "history", completed: true, quantity, currencyCode: "CNY",
  paidTotalCents: direction === "buy" ? cents : null, netTotalCents: direction === "sell" ? cents : null, tradedAt: date + "T00:00:00+08:00" });
const steam = (key, name, direction, quantity, cents, date = "2020-01-02") => ({ key, scope: "me", appid: 730, platform: "steam", marketHashName: name,
  itemName: name, type: direction, quantity, totalCents: cents, currency: "CNY", date, sourceFormat: "steam-market-history", amountSemantics: "actual" });
const options = { accountLinks: [{ id: "self", name: "本人", accountKeys: [accountKey("buff", "buff", "buff:me"), accountKey("uu", "uu", "uu:me"), accountKey("csv", "steam", "me")] }] };
function fixture() { return { buff: { accounts: { a: { records: [native("knife-buy", "Knife", "buy", 1, 700), native("cash-buy", "Mixed", "buy", 3, 900),
  native("mixed-sale", "Mixed", "sell", 4, 2000, "2020-01-04"), native("cash-net", "Missing", "sell", 2, 600, "2020-01-04"), native("loss-buy", "Loss", "buy", 1, 500), native("loss-sale", "Loss", "sell", 1, 200, "2020-01-04")] } } }, uu: { accounts: {} },
  csv: { rows: [steam("knife-sell", "Knife", "sale", 1, 1000), steam("steam-buy", "Mixed", "purchase", 2, 1200, "2020-01-03"), steam("steam-net", "Unknown", "sale", 2, 300),
    steam("return-buy", "Return", "purchase", 1, 100, "2020-01-03"), steam("return-sell", "Return", "sale", 1, 120, "2020-01-04")] }, names: {} }; }
function env(input = fixture()) {
  let saved = {}, fail = false;
  const state = { get: async keys => Object.fromEntries(keys.filter(k => k in saved).map(k => [k, structuredClone(saved[k])])), set: async value => { if (fail) throw new Error("写入失败"); saved = { ...saved, ...structuredClone(value) }; } };
  const request = async route => { const key = route.split("/").at(-1); return structuredClone(["buff", "uu", "steam"].includes(key) ? { data: input[key] || { accounts: {} } } : input[key]); };
  return { input, state, request, service: new OrderLedgerService({ state, request, scope: "test" }), saved: () => saved, fail: () => { fail = true; } };
}
test("提现优先、剩余直接盈亏，所有 Steam 卖出计入挂刀总数但无现金来源的净卖出不参与利润", () => {
  const input = fixture(), before = structuredClone(input), r = buildProfitReport(input, options), s = r.currencies[0], mixed = r.groups.find(g => g.marketHashName === "Mixed");
  assert.equal(mixed.cashout.quantity, 2); assert.equal(mixed.cashout.profitCents, 160); // 1000 - 1200 × 0.7
  assert.equal(mixed.direct.quantity, 2); assert.equal(mixed.direct.profitCents, 400); assert.equal(mixed.holding.quantity, 1);
  assert.equal(s.profitCents, 260); assert.equal(s.cashInvestmentCents, 2100); assert.equal(s.netSaleQuantity, 5);
  assert.equal(s.steamSaleQuantity, 4); assert.equal(s.coveredKnifeQuantity, 1); assert.equal(s.netSteamCents, 420);
  assert.equal(s.netCashCents, 600); assert.equal(s.holdingQuantity, 1); assert.equal(s.historicalKnifeRatio, 0.7);
  assert.equal(r.groups.find(g => g.marketHashName === "Loss").profitCents, -300);
  assert.equal(r.groups.find(g => g.marketHashName === "Return").profitCents, 0); assert.deepEqual(input, before);
});
test("无挂刀样本不借用固定折扣或其他账户，净卖出与持仓不污染可计算直接盈亏", () => {
  const input = fixture(); input.csv.rows = input.csv.rows.filter(r => r.key !== "knife-sell");
  const s = buildProfitReport(input, { ...options, pricingSettings: { targetCashoutRatio: .8 } }).currencies[0];
  assert.equal(s.cashout.profitCents, null); assert.equal(s.profitCents, null); assert.equal(s.knownProfitCents, 100); assert.equal(s.pendingQuantity, 2);
  const split = buildProfitReport(fixture(), { accountLinks: [] }); assert.equal(split.groups.find(g => g.marketHashName === "Mixed" && g.cashout.quantity)?.profitCents, undefined);
});
test("日期范围延续持仓和样本，未来卖出不影响过去折扣，整数分累计分摊", () => {
  const input = fixture(); input.buff.accounts.a.records.push(native("future-buy", "Future", "buy", 1, 10, "2020-02-01")); input.csv.rows.push(steam("future-sale", "Future", "sale", 1, 10000, "2020-02-02"));
  const r = buildProfitReport(input, { ...options, dateFrom: "2020-01-04", dateTo: "2020-01-04" });
  assert.equal(r.currencies[0].historicalKnifeRatio, .7); assert.equal(r.currencies[0].profitCents, 260); assert.equal(r.currencies[0].holdingQuantity, 1); assert.equal(r.currencies[0].cashInvestmentCents, 0);
  assert.throws(() => buildProfitReport(input, { ...options, dateFrom: "2020-02-30" }), /日期无效/);
  const tiny = { buff: { accounts: { a: { records: [native("k", "K", "buy", 1, 1), ...[1, 2, 3].map(n => native("s" + n, "S" + n, "sell", 1, 1, "2020-01-04"))] } } }, csv: { rows: [steam("k", "K", "sale", 1, 3), ...[1, 2, 3].map(n => steam("s" + n, "S" + n, "purchase", 1, 1, "2020-01-03"))] } };
  const s = buildProfitReport(tiny, options).currencies[0]; assert.equal(s.cashout.costCents, 1); assert.equal(s.cashout.profitCents, 2);
});
test("核对净卖出买价和持仓卖价只保存报告偏好，可修改、撤回、恢复，不改变原始订单或旧账本", async () => {
  const e = env(), initial = structuredClone(e.input), ledgerBefore = await e.service.load();
  let r = await e.service.reportLoad(); const missing = r.groups.find(g => g.name === "Missing"), mixed = r.groups.find(g => g.name === "Mixed");
  r = await e.service.reportSave({ revision: r.revision, groupId: missing.id, direction: "buy", platform: "buff", quantity: 2, unitPriceCents: 100, date: "2020-01-03" });
  assert.equal(r.currencies[0].profitCents, 660); assert.equal(r.currencies[0].netSaleQuantity, 3); const entry = r.entries[0];
  r = await e.service.reportSave({ revision: r.revision, entryId: entry.id, groupId: missing.id, direction: "buy", platform: "buff", quantity: 2, unitPriceCents: 150, date: "2020-01-03", note: "按名称均价核实" });
  assert.equal(r.currencies[0].profitCents, 560); assert.equal(r.entries[0].history.length, 1);
  r = await e.service.reportToggle({ id: entry.id, revision: r.revision, enabled: false }); assert.equal(r.currencies[0].profitCents, 260);
  r = await e.service.reportToggle({ id: entry.id, revision: r.revision, enabled: true }); assert.equal(r.currencies[0].profitCents, 560);
  r = await e.service.reportSave({ revision: r.revision, groupId: mixed.id, direction: "sell", platform: "uu", quantity: 1, unitPriceCents: 200, date: "2020-01-05" });
  assert.equal(r.currencies[0].holdingQuantity, 0); assert.equal(r.currencies[0].profitCents, 460);
  assert.deepEqual(e.input, initial); const ledgerAfter = await e.service.load(); assert.equal(ledgerAfter.summary.realizedProfitCents, 460); assert.equal(ledgerAfter.report.currencies[0].holdingQuantity, 0); assert.equal(ledgerBefore.report.currencies[0].profitCents, 260);
  const reopened = new OrderLedgerService({ state: e.state, request: e.request, scope: "test" }); assert.equal((await reopened.reportLoad()).currencies[0].profitCents, 460);
});
test("拒绝过量、错日期、陈旧视图、负价和并发重复保存；写入失败不返回假成功", async () => {
  const e = env(), r = await e.service.reportLoad(), g = r.groups.find(g => g.name === "Missing"), value = { revision: r.revision, groupId: g.id, direction: "buy", platform: "buff", quantity: 2, unitPriceCents: 100, date: "2020-01-03" };
  for (const patch of [{ quantity: 3 }, { date: "2020-01-05" }, { unitPriceCents: -1 }, { date: "2999-01-01" }, { date: "2020-02-30" }, { revision: "stale" }, { platform: "other" }]) await assert.rejects(e.service.reportSave({ ...value, ...patch }));
  const results = await Promise.allSettled([e.service.reportSave(value), e.service.reportSave(value)]); assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const fresh = await e.service.reportLoad(); e.fail(); await assert.rejects(e.service.reportToggle({ id: fresh.entries[0].id, revision: fresh.revision, enabled: false }), /写入失败/);
  assert.equal((await e.service.reportLoad()).entries[0].active, true);
});
test("后续同步出现同名同日平台记录时暂停相应核对，避免重复收益", async () => {
  const e = env(), r = await e.service.reportLoad(), g = r.groups.find(g => g.name === "Missing");
  await e.service.reportSave({ revision: r.revision, groupId: g.id, direction: "buy", platform: "buff", quantity: 2, unitPriceCents: 100, date: "2020-01-03" });
  e.input.buff.accounts.a.records.push(native("later-sync", "Missing", "buy", 2, 200, "2020-01-03"));
  const after = await e.service.reportLoad(); assert.equal(after.entries[0].active, false); assert.match(after.entries[0].issue, /暂停/); assert.equal(after.currencies[0].profitCents, 660); assert.equal(after.currencies[0].holdingQuantity, 1);
});
test("归档读取时间变化不使核对版本失效，真实订单变化仍拒绝旧视图", async () => {
  const e = env(); let reads = 0;
  const service = new OrderLedgerService({ state: e.state, scope: "test", request: async route => {
    const result = await e.request(route);
    return route === "/history/csv" ? { ...result, importedAt: ++reads, fileName: "已入库 CSV 历史" } : result;
  } });
  let r = await service.reportLoad(); const missing = r.groups.find(g => g.name === "Missing");
  assert.equal((await service.reportLoad()).revision, r.revision);
  r = await service.reportSave({ revision: r.revision, groupId: missing.id, direction: "buy", platform: "buff", quantity: 2, unitPriceCents: 100, date: "2020-01-03" });
  assert.equal(r.currencies[0].profitCents, 660);
  e.input.csv.rows[0].totalCents += 1;
  await assert.rejects(service.reportToggle({ id: r.entries[0].id, revision: r.revision, enabled: false }), /数据已更新/);
});
module.exports = { fixture, env };
