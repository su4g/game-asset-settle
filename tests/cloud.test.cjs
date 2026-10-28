"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { once } = require("node:events");
const { gzipSync } = require("node:zlib");
const { validateEnvelope, validateReplacement } = require("../cloud/validation.cjs");
const { view } = require("../cloud/views.cjs");
const { createServer, validateConfig } = require("../cloud/index.cjs");
const { buildProfitReport } = require("../desktop/profit-report.cjs");
const { accountKey } = require("../desktop/order-ledger.cjs");

const READ = "read_" + "r".repeat(40), INGEST1 = "ingest1_" + "i".repeat(40), INGEST2 = "ingest2_" + "j".repeat(40);
const { fixture } = require("./cloud-fixture.cjs");
const rowFor = snapshot => ({ id: snapshot.id, name: snapshot.name, snapshot, collectedAt: "2026-10-27T00:00:00.000Z", uploadedAt: "2026-10-27T00:01:00.000Z" });
test("单终端快照只允许一个账户组，订单身份与绑定严格一致且拒绝凭据", () => {
  const input = fixture(), checked = validateEnvelope(input); assert.equal(checked.profile.id, "account-1"); assert.equal(checked.profile.options.accountLinks[0].id, "self");
  const both = fixture(); both.profiles.push(fixture("account-2", "two").profiles[0]); assert.throws(() => validateEnvelope(both), /一个账户组/);
  const mixed = fixture(); mixed.profiles[0].input.buff.accounts["buff:one"].records[0].accountId = "buff:two"; assert.throws(() => validateEnvelope(mixed), /绑定账号/);
  const falseKey = fixture(); falseKey.profiles[0].input.buff.accounts["buff:one"].records[0].key = "buff:two:730:buy:history:buy1"; assert.throws(() => validateEnvelope(falseKey), /订单身份/);
  const credentials = fixture(); credentials.profiles[0].input.buff.accounts["buff:one"].cookie = "not-a-real-credential"; assert.throws(() => validateEnvelope(credentials), /凭据/);
  const crossLinks = fixture(); crossLinks.profiles[0].options.accountLinks[0].accountKeys.push(accountKey("buff", "buff", "buff:two")); assert.throws(() => validateEnvelope(crossLinks), /未关联/);
});
test("同名同价的两组独立核算，整数分与桌面同口径，未知金额不当零利润", () => {
  const a = validateEnvelope(fixture()).profile, b = validateEnvelope(fixture("account-2", "two", 1000)).profile;
  const va = view(rowFor(a), "overview"), vb = view(rowFor(b), "overview");
  assert.equal(va.currencies[0].profitCents, 100); assert.equal(vb.currencies[0].profitCents, -800);
  assert.deepEqual(va.currencies, buildProfitReport(a.input, a.options).currencies);
  a.input.buff.accounts["buff:one"].records[0].paidTotalCents = null;
  assert.equal(view(rowFor(a), "overview").currencies[0].profitCents, null);
  const orders = view(rowFor(b), "orders", new URLSearchParams("limit=1&page=1")); assert.equal(orders.total, 2); assert.equal(orders.rows.length, 1); assert.equal(orders.rows[0].accountId, "buff:two");
});
test("空组可查询，缺失历史/绑定变化不覆盖云档案，CSV本地标签按组隔离", () => {
  const a = validateEnvelope(fixture()).profile, b = structuredClone(a); b.input.buff.accounts["buff:one"].records.pop(); assert.throws(() => validateReplacement(a, b), /缺少已归档/);
  b.bindings.buff = "buff:two"; assert.throws(() => validateReplacement(a, b), /重新绑定/);
  const empty = view({ id: "account-2", name: "账户二", snapshot: null, collectedAt: null, uploadedAt: null }, "overview"); assert.equal(empty.profile.state, "not-synced"); assert.deepEqual(empty.currencies, []);
  for (const e of [fixture(), fixture("account-2", "two")]) { const p = e.profiles[0]; p.csvScopes = ["默认账户"]; const checked = validateEnvelope(e); assert.equal(checked.ownership.find(o => o.platform === "csv").accountId, JSON.stringify([p.id, "默认账户"])); }
});
test("查询参数有边界，币种不混算，敏感状态不会泄露", () => {
  const p = validateEnvelope(fixture()).profile; p.status.configFile = "/secret/config"; p.status.platforms.buff.pid = 1234;
  const status = view(rowFor(p), "sync-status"); assert.equal(status.status.configFile, undefined); assert.equal(status.status.platforms.buff.pid, undefined); assert.equal(status.sourceStatus.buff.lastSyncedAt, "2026-10-26T00:00:00.000Z");
  for (const q of ["limit=101", "page=0", "platform=other", "currency=usd", "from=2026-02-30", "page=1&page=2", "extra=1"]) assert.throws(() => view(rowFor(p), "orders", new URLSearchParams(q)));
  const report = view(rowFor(p), "report", new URLSearchParams("currency=CNY&days=5")); assert.equal(report.daily.length, 5); assert.equal(report.summary.profitCents, 100); assert.equal(report.currency, "CNY");
});
test("完整在线历史已对应的原始 CSV 保留归档，组合仅关联在线账号也可同步且不重复计算", () => {
  const e = fixture(), p = e.profiles[0], id = "steam:76561198000000001", key = `${id}:730:buy:history:10_20`;
  p.bindings.steam = id;
  p.input.steam.accounts[id] = { account: { id }, records: [{ key, accountId: id, appid: 730, goodsId: "30", orderId: "10_20", name: "Steam 物品", marketHashName: "Steam Item", direction: "buy", channel: "history", completed: true, quantity: 1, currencyCode: "CNY", paidTotalCents: 300, netTotalCents: null, tradedAt: "2026-01-03T00:00:00.000Z" }], runs: [], csvBindings: [{ scope: "旧CSV", pairs: [["csv-key", key]], matchedCount: 1 }] };
  p.input.csv.rows = [{ key: "csv-key", scope: "旧CSV", appid: 730, platform: "steam", marketHashName: "Steam Item", itemName: "Steam 物品", type: "purchase", quantity: 1, currency: "CNY", totalCents: 300, date: "2026-01-03", amountSemantics: "actual", sourceFormat: "steam-market-history" }];
  p.options.accountLinks[0].accountKeys.push(accountKey("steam", "steam", id));
  const checked = validateEnvelope(e).profile; assert.equal(checked.input.csv.rows.length, 1);
  const listed = view(rowFor(checked), "orders"); assert.equal(listed.total, 3); assert.equal(listed.suppressedCsvCount, 1);
  assert.equal(view(rowFor(checked), "overview").currencies[0].holdingQuantity, 1);
  checked.input.steam.accounts[id].csvBindings = []; assert.throws(() => validateEnvelope({ ...e, profiles: [checked] }), /遗漏来源/);
});
test("HTTP 手机凭据只有读取权，每组同步凭据独立；gzip与无凭据健康检查", async t => {
  const accepted = [], a = rowFor(validateEnvelope(fixture()).profile), b = { id: "account-2", name: "账户二", snapshot: null, collectedAt: null, uploadedAt: null };
  const store = { health: async () => {}, list: async () => [a, b], get: async id => id === a.id ? a : b, save: async (data, profile) => { accepted.push({ data, profile }); return { profileId: profile, sequence: data.sequence, duplicate: false }; } };
  const server = createServer({ store, readToken: READ, ingestTokens: { "account-1": INGEST1, "account-2": INGEST2 } }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); }); const base = "http://127.0.0.1:" + server.address().port;
  const get = (route, token = READ) => fetch(base + route, { headers: { Authorization: "Bearer " + token } });
  assert.equal((await fetch(base + "/v1/health")).status, 200); assert.equal((await fetch(base + "/v1/profiles")).status, 401);
  assert.equal((await get("/v1/profiles", INGEST1)).status, 401); assert.equal((await (await get("/v1/profiles")).json()).result.profiles.length, 2);
  assert.equal((await fetch(base + "/v1/sync", { method: "POST", headers: { Authorization: "Bearer " + READ, "Content-Type": "application/json" }, body: JSON.stringify(fixture()) })).status, 403);
  assert.equal((await fetch(base + "/v1/profiles/account-1/orders", { method: "DELETE", headers: { Authorization: "Bearer " + READ } })).status, 405);
  const sync = await fetch(base + "/v1/sync", { method: "POST", headers: { Authorization: "Bearer " + INGEST2, "Content-Type": "application/json", "Content-Encoding": "gzip" }, body: gzipSync(JSON.stringify(fixture("account-2", "two"))) });
  assert.equal(sync.status, 200); assert.equal(accepted[0].profile, "account-2");
  assert.equal((await fetch(base + "/v1/profiles", { headers: { Authorization: "Bearer " + READ, Origin: "https://untrusted.invalid" } })).status, 403);
});
test("部署配置固定两个账户且查询/写入凭据不能共用", () => {
  const good = { port: 3327, profiles: [{ id: "account-1", name: "账户一" }, { id: "account-2", name: "账户二" }], readToken: READ, ingestTokens: { "account-1": INGEST1, "account-2": INGEST2 } };
  assert.equal(validateConfig(good), good); assert.throws(() => validateConfig({ ...good, readToken: INGEST1 }), /不能相同/);
});
