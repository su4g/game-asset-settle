"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { AccountProfiles, AccountScopedRepository, initialProfiles, validateProfiles } = require("../desktop/account-profiles.cjs");
const { AccountRuntime } = require("../desktop/account-runtime.cjs");
const { SyncScheduler, SIX_HOURS } = require("../desktop/sync-scheduler.cjs");
const copy = structuredClone;
function state(initial = {}) { const saved = copy(initial); return { saved, get: async key => ({ [key]: copy(saved[key]) }), set: async value => Object.assign(saved, copy(value)) }; }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function profiles() { const storage = state(), manager = new AccountProfiles({ state: storage }); await manager.ready; return { manager, storage }; }
const savedAccount = (id, records = []) => ({ account: { id, nickname: "测试账号" }, records, runs: [] });
const record = (id, key, cents = 100) => ({ key, accountId: id, channel: "history", paidTotalCents: cents });

test("新终端默认未关联；首次绑定互斥且不可静默换号，失败不改配置", async () => {
  const { manager, storage } = await profiles();
  assert.equal(manager.snapshot().activeProfileId, null);
  assert.equal(storage.saved.accountProfiles, undefined);
  await manager.select("account-1"); await manager.bind("account-1", "buff", "buff:111");
  const before = copy(storage.saved);
  await assert.rejects(manager.bind("account-2", "buff", "buff:111"), { code: "ACCOUNT_IN_USE" });
  await assert.rejects(manager.bind("account-1", "buff", "buff:222"), { code: "ACCOUNT_MISMATCH" });
  assert.deepEqual(storage.saved, before);
  await manager.bind("account-2", "buff", "buff:222");
  assert.throws(() => manager.assertAccount("account-1", "buff", "buff:222"), { code: "ACCOUNT_IN_USE" });
  assert.throws(() => manager.assertAccount("account-1", "steam", "steam:123"));
  assert.throws(() => manager.assertAccount("account-1", "uu", "uu:1"), { code: "ACCOUNT_UNBOUND" });
  const restored = new AccountProfiles({ state: storage }); await restored.ready;
  assert.deepEqual(restored.snapshot(), manager.snapshot());
});

test("显式迁移只认每平台唯一账号；同平台多个账号保留未关联并报告候选", async () => {
  const { manager } = await profiles();
  const result = await manager.bootstrapExisting("account-1", {
    buff: { accounts: { "buff:11": savedAccount("buff:11") } },
    uu: { accounts: { "uu:21": savedAccount("uu:21"), "uu:22": savedAccount("uu:22") } },
    steam: { data: { accounts: { "steam:76561198000000001": savedAccount("steam:76561198000000001") } } },
  });
  assert.equal(result.activeProfileId, "account-1");
  assert.deepEqual(result.profiles[0].bindings, { buff: "buff:11", uu: null, steam: "steam:76561198000000001" });
  assert.deepEqual(result.ambiguous, [{ platform: "uu", accountIds: ["uu:21", "uu:22"] }]);
  assert.deepEqual(result.profiles[1].bindings, { buff: null, uu: null, steam: null });
});

test("并发首次绑定同一个平台账号时只能成功一个，名称和CSV标签验证失败保留原配置", async () => {
  const { manager } = await profiles();
  const results = await Promise.allSettled([manager.bind("account-1", "uu", "uu:44"), manager.bind("account-2", "uu", "uu:44")]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  await manager.assignCsvScopes("account-1", ["默认账户"]);
  await assert.rejects(manager.assignCsvScopes("account-2", ["默认账户"]), { code: "ACCOUNT_IN_USE" });
  assert.throws(() => manager.rename("account-1", "\n"));
  assert.throws(() => manager.rename("missing", "名称"));
  assert.equal(manager.get("account-1").name, "账户1");
  const wrong = initialProfiles(); wrong.profiles[1].id = "account-1"; assert.throws(() => validateProfiles(wrong));
});

test("云绑定只补齐并校验平台身份，跨终端同名CSV标签不造成错绑", async () => {
  const { manager } = await profiles();
  await manager.bind("account-1", "buff", "buff:11"); await manager.assignCsvScopes("account-1", ["默认账户"]);
  const remote = initialProfiles().profiles;
  remote[0].bindings.buff = "buff:11"; remote[1].bindings.buff = "buff:22";
  remote[0].csvScopes = ["默认账户"]; remote[1].csvScopes = ["默认账户"];
  await manager.reconcileRemoteProfiles(remote);
  assert.deepEqual(manager.get("account-2").csvScopes, []);
  assert.deepEqual(manager.get("account-1").csvScopes, ["默认账户"]);
  remote[0].bindings.buff = "buff:99";
  await assert.rejects(manager.reconcileRemoteProfiles(remote), { code: "ACCOUNT_MISMATCH" });
  assert.equal(manager.binding("account-1", "buff"), "buff:11");
});

test("两组旧快照同时保存时逐组重读合并，不覆盖另一组新增记录和冷却", async () => {
  const { manager } = await profiles();
  await manager.bind("account-1", "buff", "buff:11"); await manager.bind("account-2", "buff", "buff:22");
  let saved = { version: 1, accounts: { "buff:11": savedAccount("buff:11", [record("buff:11", "a")]), "buff:22": savedAccount("buff:22", [record("buff:22", "b")]) }, cooldownUntil: 100 }, revision = 0;
  const base = () => { let readRevision; return { load: async () => { readRevision = revision; await Promise.resolve(); return copy(saved); }, save: async value => { assert.equal(readRevision, revision, "scoped saves must serialize refresh+commit"); saved = copy(value); revision++; }, names: async () => ({ entries: [] }), csv: async () => ({ rows: [] }) }; };
  const key = Symbol("shared-database"), first = new AccountScopedRepository({ repository: base(), profiles: manager, profileId: "account-1", platform: "buff", lockKey: key });
  const second = new AccountScopedRepository({ repository: base(), profiles: manager, profileId: "account-2", platform: "buff", lockKey: key });
  const a = await first.load(), b = await second.load();
  assert.deepEqual(Object.keys(a.accounts), ["buff:11"]); assert.deepEqual(Object.keys(b.accounts), ["buff:22"]);
  a.accounts["buff:11"].records.push(record("buff:11", "new-a")); a.cooldownUntil = 500;
  b.accounts["buff:22"].records.push(record("buff:22", "new-b")); b.cooldownUntil = 200;
  await Promise.all([first.save(a), second.save(b)]);
  assert.equal(saved.accounts["buff:11"].records.length, 2); assert.equal(saved.accounts["buff:22"].records.length, 2); assert.equal(saved.cooldownUntil, 500);
  a.accounts["buff:22"] = savedAccount("buff:22");
  await assert.rejects(first.save(a), { code: "ACCOUNT_IN_USE" });
  delete a.accounts["buff:22"]; a.accounts["buff:11"].records[0].accountId = "buff:22";
  await assert.rejects(first.save(a), { code: "ACCOUNT_MISMATCH" }); assert.equal(revision, 2);
});

test("每个平台会话的第二组独立分区，第一组兼容已有登录且非法组不会创建会话", () => {
  for (const [platform, create] of [["buff", require("../desktop/buff-session.cjs").createBuffSession], ["uu", require("../desktop/uu-session.cjs").createUuSession], ["steam", require("../desktop/steam-session.cjs").createSteamSession]]) {
    const seen = [], ses = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, webRequest: { onBeforeRequest() {}, onBeforeSendHeaders() {} }, cookies: { on() {} } };
    const options = { session: { fromPartition: value => { seen.push(value); return ses; } }, BrowserWindow() {}, parent() {}, onSessionChange() {} };
    create(options); create({ ...options, profileId: "account-1" }); create({ ...options, profileId: "account-2" });
    assert.deepEqual(seen, [`persist:${platform}-orders`, `persist:${platform}-orders`, `persist:${platform}-orders-account-2`]);
    assert.throws(() => create({ ...options, profileId: "../../other" })); assert.equal(seen.length, 3);
  }
});

test("Steam CSV对应仅检查显式归属本组的导入，另一组同内容清单不被绑定", async () => {
  const { manager } = await profiles();
  await manager.assignCsvScopes("account-1", ["甲的CSV"]); await manager.assignCsvScopes("account-2", ["乙的CSV"]);
  const repository = { csv: async () => ({ rows: [{ scope: "甲的CSV", key: "a" }, { scope: "乙的CSV", key: "b" }], imports: [{ scope: "甲的CSV" }, { scope: "乙的CSV" }], archiveRowCount: 2 }) };
  const scoped = new AccountScopedRepository({ repository, profiles: manager, profileId: "account-2", platform: "steam" });
  const result = await scoped.csv();
  assert.deepEqual(result.rows, [{ scope: "乙的CSV", key: "b" }]); assert.deepEqual(result.imports, [{ scope: "乙的CSV" }]); assert.equal(result.archiveRowCount, 1);
});

test("重建平台运行器后移除旧会话监听，不把失效事件发给已废弃实例", () => {
  const { EventEmitter } = require("node:events");
  for (const [platform, cookieName, domain, create] of [["buff", "session", ".buff.163.com", require("../desktop/buff-session.cjs").createBuffSession], ["uu", "uu_token", ".youpin898.com", require("../desktop/uu-session.cjs").createUuSession], ["steam", "steamLoginSecure", ".steamcommunity.com", require("../desktop/steam-session.cjs").createSteamSession]]) {
    const ses = Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {}, onBeforeSendHeaders() {} }, cookies: new EventEmitter() });
    let oldEvents = 0, newEvents = 0;
    const options = { session: { fromPartition: () => ses }, BrowserWindow() {}, parent() {}, profileId: "account-1" };
    const old = create({ ...options, onSessionChange: () => oldEvents++ }); old.dispose();
    const next = create({ ...options, onSessionChange: () => newEvents++ });
    ses.cookies.emit("changed", {}, { name: cookieName, domain }, "expired", true);
    assert.equal(oldEvents, 0, platform); assert.equal(newEvents, 1, platform);
    assert.equal(ses.listenerCount("will-download"), 1); next.dispose();
    assert.equal(ses.cookies.listenerCount("changed"), 0); assert.equal(ses.listenerCount("will-download"), 0);
  }
});

test("真实采集器检查和同步前执行账户守卫，错误账号不能读取订单或保存", async () => {
  const { BuffOrders } = require("../desktop/buff-orders.cjs"), { UuOrders } = require("../desktop/uu-orders.cjs"), { SteamOrders } = require("../desktop/steam-orders.cjs"), F = require("./fixtures/desktop-steam-orders.cjs");
  for (const [Client, response, expected] of [[BuffOrders, () => new Response(JSON.stringify({ code: "OK", data: { user_id: "2" } })), "buff:2"], [UuOrders, () => new Response(JSON.stringify({ code: 0, data: { UserId: "2" } })), "uu:2"], [SteamOrders, () => new Response(F.html()), F.account.id]]) {
    let requests = 0, guards = 0;
    const orders = new Client({ repository: { load: async () => ({ version: 1, accounts: {} }), save: async () => assert.fail("wrong account must never save") }, interval: () => 0,
      fetcher: async () => { requests++; return response(); }, accountGuard: account => { guards++; assert.equal(account.id, expected); throw Object.assign(new Error("平台账号与已关联账号不一致"), { code: "ACCOUNT_MISMATCH" }); } });
    await assert.rejects(orders.check(), { code: "ACCOUNT_MISMATCH" }); assert.equal(orders.verified, false); assert.equal(orders.account, null);
    await orders.start({}); await orders.running;
    assert.equal(requests, 2); assert.equal(guards, 2); assert.equal(orders.job.status, "failed"); assert.equal(orders.account, null);
  }
});

test("BUFF同步后再校验发现错误绑定时整批结果不入库，原正确账号保持隔离", async () => {
  const { BuffOrders } = require("../desktop/buff-orders.cjs"), { manager } = await profiles();
  await manager.bind("account-1", "buff", "buff:11");
  let checks = 0, writes = 0;
  const orders = new BuffOrders({ interval: () => 0, repository: { load: async () => ({ version: 1, accounts: {} }), save: async () => { writes++; } },
    accountGuard: account => manager.assertAccount("account-1", "buff", account.id),
    fetcher: async url => new Response(JSON.stringify({ code: "OK", data: url.includes("/account/api/") ? { user_id: ++checks === 1 ? "11" : "22" } : { items: [], goods_infos: {}, total_page: 1, page_num: 1 } })) });
  await orders.start({ appid: 730, direction: "buy" }); await orders.running;
  assert.equal(orders.job.status, "failed"); assert.match(orders.job.message, /不一致/); assert.equal(orders.verified, false); assert.equal(writes, 0);
  assert.equal(manager.binding("account-1", "buff"), "buff:11");
});

async function runtimeHarness({ selected = "account-1", bound = true, gatePlatform, failPlatform } = {}) {
  const { manager } = await profiles(), calls = [], events = [], clients = new Map();
  const identities = { buff: "buff:11", uu: "uu:22", steam: "steam:76561198000000001" };
  if (bound) for (const [platform, id] of Object.entries(identities)) await manager.bind("account-1", platform, id);
  if (selected) await manager.select(selected);
  const gate = deferred(), entered = deferred();
  const runtime = new AccountRuntime({ profiles: manager, notify: event => events.push(event), createPlatform: ({ profileId, platform, accountGuard, notify }) => {
    const orders = { ready: Promise.resolve(), verified: false, account: null, running: null, checking: false, job: { status: "idle" }, data: { accounts: {} },
      async load() { this.account = manager.binding(profileId, platform) ? { id: manager.binding(profileId, platform) } : null; },
      snapshot() { return { account: this.account, verified: this.verified, count: 0, runs: [], job: this.job, sellProbe: { status: "unverified" } }; },
      async check() { calls.push(`${profileId}:${platform}:check`); this.checking = true; try { if (failPlatform === platform) throw new Error("登录已失效，请重新登录"); const account = { id: identities[platform] }; await accountGuard(account); this.account = account; this.verified = true; return this.snapshot(); } finally { this.checking = false; } },
      async start(value) { calls.push(`${profileId}:${platform}:start`); await accountGuard(this.account); this.job = { status: "running" }; this.running = Promise.resolve().then(async () => { if (gatePlatform === platform) { entered.resolve(); await gate.promise; } if (this.job.status === "running") this.job = { status: "completed" }; }).finally(() => { this.running = null; }); return this.snapshot(); },
      stop() { if (this.running) { this.job = { status: "cancelled", message: "同步已停止" }; gate.resolve(); } },
      async invalidate() { this.stop(); await this.running; this.verified = false; },
      async disconnect() { await this.invalidate(); this.account = null; }, emit() { notify({ kind: `${platform}-orders`, value: this.snapshot() }); },
      async list() { return this.snapshot(); },
    };
    const session = { opened: false, close() { this.opened = false; }, isOpen() { return this.opened; }, open() { this.opened = true; return { opened: true }; }, async clear() { this.opened = false; } };
    clients.set(`${profileId}:${platform}`, { orders, session }); return { orders, session };
  } });
  await runtime.ready;
  return { runtime, manager, calls, events, clients, gate, entered };
}

test("未关联终端不访问平台；每次调度只同步本机选定的一组，重复触发不重入", async () => {
  const empty = await runtimeHarness({ selected: null }); await empty.runtime.syncSelected(); assert.deepEqual(empty.calls, []);
  const env = await runtimeHarness({ gatePlatform: "buff" });
  const first = env.runtime.syncSelected(); await env.entered.promise;
  await env.runtime.syncSelected(); env.gate.resolve(); await first;
  assert.equal(env.calls.filter(call => call.endsWith(":start")).length, 3);
  assert(env.calls.every(call => call.startsWith("account-1:"))); assert(env.events.every(event => event.profileId === "account-1"));
  await env.runtime.select("account-2"); await env.runtime.syncSelected();
  assert.equal(env.calls.filter(call => call.startsWith("account-2:")).length, 0);
  assert.equal(env.runtime.snapshot().currentPlatformStates.buff.phase, "unbound");
});

test("首次手动检查才关联账号；失效平台暂停自动同步，其他平台继续", async () => {
  const unbound = await runtimeHarness({ bound: false }); await unbound.runtime.syncSelected(); assert.equal(unbound.calls.length, 0);
  await unbound.runtime.manual("buff", "check"); assert.equal(unbound.manager.binding("account-1", "buff"), "buff:11");
  const env = await runtimeHarness({ failPlatform: "buff" }); await env.runtime.syncSelected();
  assert.equal(env.runtime.snapshot().platforms.buff.phase, "login-required");
  assert.equal(env.runtime.snapshot().platforms.steam.phase, "completed");
  await env.runtime.syncSelected(); assert.equal(env.calls.filter(call => call === "account-1:buff:check").length, 1);
});

test("手动登录取消本平台自动任务，登录窗口打开时定时器不抢占；切换账户等任务停止", async () => {
  const env = await runtimeHarness({ gatePlatform: "buff" }); const syncing = env.runtime.syncSelected(); await env.entered.promise;
  assert.deepEqual(await env.runtime.manual("buff", "login"), { opened: true }); await syncing;
  const before = env.calls.filter(call => call.includes(":buff:")).length;
  await env.runtime.syncSelected(); assert.equal(env.calls.filter(call => call.includes(":buff:")).length, before);
  assert.equal(env.clients.get("account-1:buff").session.opened, true);
  await env.runtime.select("account-2"); assert.equal(env.clients.get("account-1:buff").session.opened, false);
  assert.equal(env.runtime.snapshot().activeProfileId, "account-2");
});

test("手动同步即时返回但持续占用操作锁直到完成", async () => {
  const env = await runtimeHarness({ gatePlatform: "buff" });
  const response = await env.runtime.manual("buff", "start", { appid: 730, direction: "buy" });
  assert.equal(response.job.status, "running");
  await assert.rejects(env.runtime.manual("buff", "check"), /已有同步/);
  await env.runtime.manual("buff", "stop"); assert.equal(env.runtime.selectedPlatform("buff").operation, null);
});

test("六小时调度在后台按截止时间运行，休眠错过多个周期仅补一次且不重入", async () => {
  let now = 1000, id = 0; const timers = new Map(), calls = [], gate = deferred(), entered = deferred(); let hold = false;
  const storage = state(), scheduler = new SyncScheduler({ state: storage, now: () => now,
    setTimer: (fn, ms) => { const key = ++id; timers.set(key, { fn, at: now + ms }); return key; }, clearTimer: key => timers.delete(key),
    run: async value => { calls.push(value.reason); if (hold) { entered.resolve(); await gate.promise; } } });
  await Promise.all([scheduler.start(), scheduler.start()]); assert.deepEqual(calls, ["startup"]);
  assert.equal(scheduler.snapshot().nextRunAt, 1000 + SIX_HOURS);
  now += SIX_HOURS - 1; await scheduler.resume(); assert.equal(calls.length, 1);
  now += SIX_HOURS * 4; hold = true; const resumed = scheduler.resume(); await entered.promise;
  const again = scheduler.resume(); gate.resolve(); await Promise.all([resumed, again]);
  assert.deepEqual(calls, ["startup", "resume"]); assert.equal(timers.size, 1);
  assert.equal(storage.saved.syncSchedule.nextRunAt, now + SIX_HOURS);
  scheduler.stop(); now += SIX_HOURS; await scheduler.resume(); assert.equal(calls.length, 2); assert.equal(timers.size, 0);
});

test("smoke关闭的调度不联网；失败保留状态并在下一周期再运行，不立即重放", async () => {
  const disabled = new SyncScheduler({ enabled: false, run: () => assert.fail("disabled must not run") }); await disabled.start(); await disabled.trigger(); assert.equal(disabled.snapshot().status, "disabled");
  let count = 0, now = 1000;
  const scheduler = new SyncScheduler({ now: () => now, setTimer: () => 1, clearTimer() {}, run: async () => { count++; throw new Error("模拟网络失败"); } });
  await scheduler.start(); assert.equal(count, 1); assert.equal(scheduler.snapshot().lastError, "模拟网络失败");
  await scheduler.resume(); assert.equal(count, 1); now += SIX_HOURS; await scheduler.resume(); assert.equal(count, 2); scheduler.stop();
});
