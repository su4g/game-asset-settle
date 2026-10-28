"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { scopeInput, scopeOptions, profileScope } = require("../desktop/account-data.cjs");
const { accountKey, sourceId } = require("../desktop/order-ledger.cjs");
const { buildProfitReport } = require("../desktop/profit-report.cjs");
const { validateEnvelope } = require("../cloud/validation.cjs");
const { fixture } = require("./cloud-fixture.cjs");
const profile = (id = "account-1", suffix = "one") => ({ id, name: id, bindings: { buff: "buff:" + suffix, uu: null, steam: null }, csvScopes: [] });
function mixed() { const a = fixture().profiles[0].input, b = fixture("account-2", "two", 1000).profiles[0].input; a.buff.accounts["buff:two"] = b.buff.accounts["buff:two"]; a.buff.activeAccount = "buff:two"; return a; }
test("先按关联账号过滤原始档案和 CSV，当前活动账号不会泄漏到另一组", () => {
  const input = mixed(), before = structuredClone(input), a = scopeInput(input, profile()), b = scopeInput(input, profile("account-2", "two"));
  assert.deepEqual(Object.keys(a.buff.accounts), ["buff:one"]); assert.equal(a.buff.activeAccount, "buff:one"); assert.deepEqual(Object.keys(b.buff.accounts), ["buff:two"]); assert.equal(b.buff.activeAccount, "buff:two");
  const oa = scopeOptions({}, a, profile()), ob = scopeOptions({}, b, profile("account-2", "two")); assert.equal(buildProfitReport(a, oa).currencies[0].profitCents, 100); assert.equal(buildProfitReport(b, ob).currencies[0].profitCents, -800); assert.deepEqual(input, before);
  input.csv = { rows: [{ key: "a", scope: "本人" }, { key: "b", scope: "另一账户" }], imports: [{ scope: "本人" }, { scope: "另一账户" }], archiveRowCount: 2, suppressedCount: 2, bindings: ["stale"] };
  const scoped = scopeInput(input, { ...profile(), csvScopes: ["本人"] }); assert.equal(scoped.csv.rows.length, 1); assert.equal(scoped.csv.imports.length, 1); assert.equal(scoped.csv.suppressedCount, undefined); assert.equal(scoped.csv.bindings, undefined);
});
test("档案内 accountId 或编码订单身份不匹配立即失败，不改写为当前账号", () => {
  for (const field of ["accountId", "key"]) { const input = mixed(); input.buff.accounts["buff:one"].records[0][field] = "buff:two"; assert.throws(() => scopeInput(input, profile()), /归档账号/); }
  assert.throws(() => scopeInput(mixed(), null), /先配置/);
});
test("完整 CSV 已被在线历史抑制时仍保留旧自定义组合 id、原始CSV与核对记录", () => {
  const envelope = fixture(), input = envelope.profiles[0].input, p = profile(), id = "steam:76561198000000001", key = `${id}:730:buy:history:10_20`, csvKey = accountKey("csv", "steam", "原CSV");
  p.bindings.steam = id; p.csvScopes = ["原CSV"];
  input.steam.accounts[id] = { account: { id }, records: [{ key, accountId: id, appid: 730, orderId: "10_20", goodsId: "30", name: "Steam 物品", marketHashName: "Steam Item", direction: "buy", channel: "history", quantity: 1, completed: true, currencyCode: "CNY", paidTotalCents: 300, tradedAt: "2026-01-03T00:00:00.000Z" }], runs: [], csvBindings: [{ scope: "原CSV", pairs: [["csv1", key]], matchedCount: 1 }] };
  input.csv.rows = [{ key: "csv1", scope: "原CSV", appid: 730, platform: "steam", marketHashName: "Steam Item", itemName: "Steam 物品", type: "purchase", quantity: 1, currency: "CNY", totalCents: 300, date: "2026-01-03", sourceFormat: "steam-market-history", amountSemantics: "actual" }];
  const raw = scopeInput(input, p), options = scopeOptions({ accountLinks: [{ id: "custom-old", name: "原组", accountKeys: [accountKey("buff", "buff", "buff:one"), csvKey] }], reportEntries: [{ id: "old", portfolioId: "custom-old", groupId: "missing", enabled: false }] }, raw, p);
  assert.equal(options.accountLinks[0].id, "custom-old"); assert(!options.accountLinks[0].accountKeys.includes(csvKey)); assert(options.accountLinks[0].accountKeys.includes(accountKey("steam", "steam", id))); assert.equal(options.reportEntries.length, 1); assert.equal(raw.csv.rows.length, 1);
  assert.doesNotThrow(() => validateEnvelope({ ...envelope, profiles: [{ ...envelope.profiles[0], bindings: p.bindings, csvScopes: p.csvScopes, input: raw, options }] }));
});
test("旧组合混有外部账户的补录不能自动套入当前组，来源级覆盖只保留当前原始记录", () => {
  const input = scopeInput(mixed(), profile()), own = accountKey("buff", "buff", "buff:one"), foreign = accountKey("buff", "buff", "buff:two");
  const shared = { accountLinks: [{ id: "self", accountKeys: [own, foreign] }], reportEntries: [{ portfolioId: "self", groupId: "same-name" }] };
  assert.throws(() => scopeOptions(shared, input, profile()), /不能自动分配/);
  const key = input.buff.accounts["buff:one"].records[0].key, source = sourceId("buff", key);
  const result = scopeOptions({ accountLinks: [{ id: "self", accountKeys: [own] }], overrides: { [source]: { actualTotalCents: 100 }, '["buff","other"]': { actualTotalCents: 999 } }, csvAmountSemantics: { [own]: "actual", [foreign]: "actual" } }, input, profile());
  assert.deepEqual(Object.keys(result.overrides), [source]); assert.deepEqual(Object.keys(result.csvAmountSemantics), [own]);
});
test("没有可关联旧组合时不继承 self 补录或移除设置，新第二组使用独立标识", () => {
  const p = profile("account-2", "two"), input = scopeInput(mixed(), p), result = scopeOptions({ reportEntries: [{ portfolioId: "self" }], excludedHoldingIds: ["old"], watchlistIds: ["old"] }, input, p);
  assert.equal(result.accountLinks[0].id, "account-2"); assert.deepEqual(result.reportEntries, []); assert.deepEqual(result.excludedHoldingIds, []);
  assert.equal(profileScope("connection", "account-1"), "connection"); assert.equal(profileScope("connection", "account-2"), "connection:account-2");
});
