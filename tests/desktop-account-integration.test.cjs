"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { AccountProfiles, initialProfiles } = require("../desktop/account-profiles.cjs");
const { OrderLedgerService } = require("../desktop/order-ledger-service.cjs");
const { profileScope, scopeOptions } = require("../desktop/account-data.cjs");
const { CloudSync, DEFAULT_BASE_URL } = require("../desktop/cloud-sync.cjs");
const { view } = require("../cloud/views.cjs");
const { fixture } = require("./cloud-fixture.cjs");

// Exercise the actual local aggregation → durable upload → phone query views
// with overlapping item names and order numbers. Every file is synthetic and
// every request uses the injected in-memory receiver; no server is contacted.
async function pipeline(t, { corrupt = false, canSync = () => true, beforeBuild = async () => {} } = {}) {
  const fixtures = [fixture("account-1", "one", 100).profiles[0], fixture("account-2", "two", 170).profiles[0]];
  const input = structuredClone(fixtures[0].input);
  Object.assign(input.buff.accounts, structuredClone(fixtures[1].input.buff.accounts));
  if (corrupt) input.buff.accounts["buff:one"].records[0].accountId = "buff:two";
  const saved = { accountProfiles: initialProfiles(), orderLedger: {} };
  saved.accountProfiles.profiles = fixtures.map((item, index) => ({ id: item.id, name: item.name,
    bindings: { ...item.bindings, uu: `uu:${index + 1}`, steam: `steam:7656119800000000${index + 1}` }, csvScopes: [] }));
  const state = { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(saved[key])])); },
    async set(values) { Object.assign(saved, structuredClone(values)); } };
  const profiles = new AccountProfiles({ state }); await profiles.ready;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "buff-account-pipeline-test-"));
  const uploads = [], clients = [], queried = [], timers = [];
  t.after(async () => { clients.forEach(client => client.close()); await fs.rm(directory, { recursive: true, force: true }); });
  function terminal(id) {
    const profile = () => profiles.get(id);
    const ledger = new OrderLedgerService({ state, scope: profileScope("isolated-test-connection", id), profile,
      request: async route => { queried.push({ id, route }); const key = route.replace("/history/", ""); return ["buff", "uu", "steam"].includes(key) ? { data: structuredClone(input[key]) } : structuredClone(input[key]); } });
    const cloud = new CloudSync({ directory: path.join(directory, id), currentProfile: profile, canSync,
      setTimer: (fn, ms) => { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; }, clearTimer() {},
      buildSnapshot: async owner => {
        await beforeBuild();
        const snapshot = await ledger.read();
        return { id: owner.id, name: owner.name, bindings: owner.bindings, csvScopes: owner.csvScopes,
          input: snapshot.rawInput, options: scopeOptions(snapshot.options, snapshot.rawInput, owner), quotes: snapshot.quotes, pricingSettings: snapshot.pricingSettings,
          status: { platforms: { buff: { phase: "completed" }, uu: { phase: "login-required" } } } };
      },
      fetcher: async (url, init) => {
        assert.equal(url, DEFAULT_BASE_URL + "/v1/sync"); assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
        const envelope = JSON.parse(init.body); assert.equal(envelope.profiles.length, 1); assert.equal(envelope.profiles[0].id, id);
        assert(!init.body.includes("synthetic-read-")); assert(!init.body.includes("synthetic-ingest-"));
        uploads.push(envelope);
        return new Response(JSON.stringify({ ok: true, result: { profileId: id, deviceId: envelope.deviceId, sequence: envelope.sequence, uploadedAt: "2026-10-27T01:00:00.000Z" } }), { headers: { "Content-Type": "application/json" } });
      } });
    clients.push(cloud); return { ledger, cloud };
  }
  return { terminal, uploads, queried, input, timers };
}
const connection = id => ({ version: 1, profileId: id, baseURL: DEFAULT_BASE_URL,
  ingestToken: "synthetic-ingest-" + "i".repeat(40), readToken: "synthetic-read-" + "r".repeat(40) });

test("两终端同名同订单号的归档经过本机账本、上传和手机查询后仍按账户独立计算", async t => {
  const env = await pipeline(t), results = [];
  for (const [id, accountId, expectedProfit] of [["account-1", "buff:one", 100], ["account-2", "buff:two", 30]]) {
    const { ledger, cloud } = env.terminal(id); await cloud.ready; await cloud.importConnection(connection(id));
    const local = await ledger.reportLoad(); await cloud.sync();
    const envelope = env.uploads.at(-1), snapshot = envelope.profiles[0];
    assert.deepEqual(Object.keys(snapshot.input.buff.accounts), [accountId]);
    assert(snapshot.input.buff.accounts[accountId].records.every(row => row.accountId === accountId));
    const row = { id, name: snapshot.name, snapshot, collectedAt: envelope.collectedAt, uploadedAt: cloud.snapshot().lastUploadedAt };
    const mobileOrders = view(row, "orders"), mobileOverview = view(row, "overview"), mobileReport = view(row, "report");
    assert.equal(mobileOrders.total, 2); assert(mobileOrders.rows.every(order => order.accountId === accountId));
    assert.equal(local.currencies[0].profitCents, expectedProfit);
    assert.equal(mobileOverview.currencies[0].profitCents, expectedProfit); assert.equal(mobileReport.summary.profitCents, expectedProfit);
    assert.equal(view(row, "sync-status").status.platforms.uu.phase, "login-required");
    assert.equal(cloud.snapshot().pending, false); assert.equal(cloud.snapshot().lastSequence, 1);
    results.push(envelope);
  }
  assert.notEqual(results[0].deviceId, results[1].deviceId);
  assert.deepEqual(results.map(item => item.profiles[0].id), ["account-1", "account-2"]);
  assert(env.queried.every(item => item.route.startsWith("/history/")));
});

test("原档案内订单账户与绑定不一致时整批停止，不能上传或产生待传快照", async t => {
  const env = await pipeline(t, { corrupt: true }), { ledger, cloud } = env.terminal("account-1");
  await cloud.ready; await cloud.importConnection(connection("account-1"));
  await assert.rejects(ledger.reportLoad(), /归档账号与当前账户关联不一致/);
  await assert.rejects(cloud.sync(), /归档账号与当前账户关联不一致/);
  assert.equal(env.uploads.length, 0); assert.equal(cloud.snapshot().pending, false);
  await assert.rejects(fs.stat(cloud.pendingFile), { code: "ENOENT" });
  assert.equal(env.input.buff.accounts["buff:one"].records[0].accountId, "buff:two", "失败不能改写原档案来掩盖错绑");
});

test("连接切换期间自动上传延后，恢复后才生成本账户批次", async t => {
  let allowed = false;
  const env = await pipeline(t, { canSync: () => allowed }), { cloud } = env.terminal("account-1");
  await cloud.ready; await cloud.importConnection(connection("account-1")); await cloud.sync({ automatic: true });
  assert.equal(env.uploads.length, 0); assert.equal(env.queried.length, 0); assert.equal(cloud.snapshot().lastSequence, null);
  assert.equal(env.timers.at(-1).ms, 5000); await assert.rejects(fs.stat(cloud.pendingFile), { code: "ENOENT" });
  allowed = true; await cloud.sync({ automatic: true }); assert.equal(env.uploads.length, 1); assert.equal(env.uploads[0].sequence, 1);
});

test("读取快照期间进入连接切换，不发送快照并安排重试", async t => {
  let allowed = true, entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const env = await pipeline(t, { canSync: () => allowed, beforeBuild: async () => { entered(); await gate; } }), { cloud } = env.terminal("account-1");
  await cloud.ready; await cloud.importConnection(connection("account-1"));
  const task = cloud.sync({ automatic: true }); await started; allowed = false; release();
  await assert.rejects(task, /正在切换/); assert.equal(env.uploads.length, 0); assert.equal(cloud.snapshot().paused, false);
  assert(env.timers.length > 0); await assert.rejects(fs.stat(cloud.pendingFile), { code: "ENOENT" });
  allowed = true; await cloud.sync({ automatic: true }); assert.equal(env.uploads.length, 1); assert.equal(env.uploads[0].sequence, 1);
});
