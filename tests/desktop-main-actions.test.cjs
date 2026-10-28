"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path"), { createRequire } = require("node:module");
const { AccountRuntime } = require("../desktop/account-runtime.cjs");
const { initialProfiles } = require("../desktop/account-profiles.cjs");

const mainFile = path.resolve(__dirname, "../desktop/main.cjs"), localRequire = createRequire(mainFile);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function appHarness() {
  const calls = [], writes = [], ready = Promise.resolve();
  const fsApi = {};
  const stored = { accountProfiles: initialProfiles() }; stored.accountProfiles.activeProfileId = "account-1";
  const identity = { buff: "buff:1", uu: "uu:1", steam: "steam:76561198000000001" };
  const session = name => ({ close() { calls.push(`${name}:close`); }, async open() { calls.push(`${name}:open`); return { opened: true }; }, async clear() { calls.push(`${name}:clear`); } });
  const orders = name => ({ ready, running: null, checking: false, verified: false, account: null,
    async load() {},
    snapshot() { return { verified: this.verified, account: this.account, runs: [], job: { status: "idle" } }; },
    async check() { calls.push(`${name}:check`); const account = { id: identity[name] }; this.accountGuard(account); this.account = account; this.verified = true; return this.snapshot(); }, async start() { calls.push(`${name}:start`); return this.snapshot(); },
    stop() { calls.push(`${name}:stop`); return this.snapshot(); },
    async invalidate() { calls.push(`${name}:invalidate`); }, async disconnect() { calls.push(`${name}:disconnect`); },
  });
  const mocks = { buffOrders: orders("buff"), uuOrders: orders("uu"), steamOrders: orders("steam"), buffSession: session("buff"), uuSession: session("uu"), steamSession: session("steam"),
    startup: { ready, snapshot: () => ({ enabled: true, status: "idle" }), async cancel(name) { calls.push(`startup:cancel:${name || "all"}`); }, async configure(value) { calls.push("startup:configure"); return value; }, async start() { calls.push("startup:start"); return { status: "running" }; } } };
  mocks.cloudSync = { ready, running: null, pending: null, snapshot: () => ({ configured: false }), schedule() { calls.push("cloud:schedule"); }, async sync() { calls.push("cloud:sync"); return { profileId: "account-1" }; } };
  mocks.scheduler = { snapshot: () => ({ status: "idle", enabled: true }) };
  const dialog = { async showOpenDialog() { calls.push("dialog"); return { canceled: true }; } };
  const runtime = {
    APP_URL: "buff-desktop://app/desktop/index.html", assetForUrl: () => null,
    readConfig: async () => { calls.push("readConfig"); return {}; },
    ledgerRequest: async () => { calls.push("ledgerRequest"); return { database: "isolated-vm" }; },
    LocalState: class { constructor() {} async get(key) { return { [key]: structuredClone(stored[key]) }; } async set(value) { writes.push(value); Object.assign(stored, structuredClone(value)); return {}; } },
    BackgroundProbe: class { snapshot() { return { status: "idle" }; } },
  };
  const electron = { app: { getPath: () => "/virtual/isolated-profile", setName() {}, setPath() {}, requestSingleInstanceLock: () => false, quit() { calls.push("quit-without-init"); } },
    protocol: { registerSchemesAsPrivileged() {} }, dialog,
  };
  const context = vm.createContext({ module: { exports: {} }, __dirname: path.dirname(mainFile),
    process: { argv: ["node", mainFile], pid: process.pid, platform: "darwin", versions: { electron: "test", chromium: "test", node: process.versions.node } },
    require(name) {
      if (name === "electron") return electron;
      if (name === "./runtime.cjs") return runtime;
      if (name === "node:fs/promises") return new Proxy(fsApi, { get: (target, key) => target[key] || (() => assert.fail(`主进程隔离测试不应访问文件：${String(key)}`)) });
      return localRequire(name);
    }, setTimeout, clearTimeout, console,
  });
  vm.runInContext(fs.readFileSync(mainFile, "utf8") + `\nmodule.exports = { handle, accountProfiles, inject(value) { ({ buffOrders, uuOrders, steamOrders, buffSession, uuSession, steamSession, startup, accountRuntime, scheduler, cloudSync } = value); }, counters() { return { pendingPlatformActions, connectionChanging }; } };`, context, { filename: mainFile });
  const exported = context.module.exports;
  mocks.accountRuntime = new AccountRuntime({ profiles: exported.accountProfiles, createPlatform({ platform, accountGuard }) { const orders = mocks[platform + "Orders"]; orders.accountGuard = accountGuard; return { orders, session: mocks[platform + "Session"] }; } });
  exported.inject(mocks);
  assert.deepEqual(calls, ["quit-without-init"]); calls.length = 0;
  return { ...exported, mocks, calls, writes, dialog, fsApi, runtime };
}

async function rejectsConnectionChange(env) {
  await assert.rejects(env.handle("service:connect"), /正在保存或处理账户操作/);
  await assert.rejects(env.handle("config:select"), /正在同步或保存历史/);
  assert(!env.calls.includes("dialog"), "挂起账户操作时不应打开选择连接对话框");
  assert(!env.calls.includes("ledgerRequest"), "挂起账户操作时不应重新连接服务");
}

test("主进程首个 await 之前保留账户操作，阻止重连和配置切换", async () => {
  for (const name of ["buff", "uu", "steam"]) {
    const env = appHarness(), gate = deferred(), initialized = env.mocks.accountRuntime.ready;
    env.mocks.accountRuntime.ready = Promise.all([initialized, gate.promise]);
    const task = env.handle(`${name}:check`);
    assert.equal(env.counters().pendingPlatformActions, 1);
    await rejectsConnectionChange(env);
    assert(!env.calls.includes(`${name}:check`));
    gate.resolve(); await task;
    assert.equal(env.counters().pendingPlatformActions, 0);
    assert(env.calls.indexOf(`${name}:close`) < env.calls.indexOf(`${name}:check`));
    assert.equal((await env.handle("config:select")).cancelled, true);
    assert.equal(env.counters().connectionChanging, false);
  }
});

test("账户校验、异步打开登录页和注销均完成后才释放切换保护", async () => {
  for (const [action, target, method] of [
    ["buff:check", "buffOrders", "check"], ["buff:login", "buffSession", "open"], ["buff:logout", "buffSession", "clear"],
    ["steam:check", "steamOrders", "check"], ["steam:login", "steamSession", "open"], ["steam:logout", "steamSession", "clear"],
    ["uu:check", "uuOrders", "check"], ["uu:login", "uuSession", "open"], ["uu:logout", "uuSession", "clear"],
  ]) {
    const env = appHarness(), entered = deferred(), gate = deferred();
    const original = env.mocks[target][method];
    env.mocks[target][method] = async function (...args) { entered.resolve(); await gate.promise; return original.apply(this, args); };
    const task = env.handle(action); await entered.promise;
    assert.equal(env.counters().pendingPlatformActions, 1, action); await rejectsConnectionChange(env);
    gate.resolve(); await task; assert.equal(env.counters().pendingPlatformActions, 0, action);
    await env.handle("config:select"); assert(env.calls.includes("dialog"), action);
  }
});

test("启动设置在准备与保存两个 await 阶段都阻止切换，失败后保护释放", async () => {
  const env = appHarness(), ready = deferred(), entered = deferred(), gate = deferred();
  env.mocks.startup.ready = ready.promise;
  env.mocks.startup.configure = async () => { entered.resolve(); await gate.promise; };
  const task = env.handle("startup:configure", { enabled: false }), failed = assert.rejects(task, /模拟保存失败/);
  await rejectsConnectionChange(env); ready.resolve(); await entered.promise;
  await rejectsConnectionChange(env); assert.equal(env.counters().pendingPlatformActions, 1);
  gate.reject(new Error("模拟保存失败")); await failed;
  assert.equal(env.counters().pendingPlatformActions, 0);
  assert.equal((await env.handle("config:select")).cancelled, true);
});

test("配置选择设锁后阻止新的平台和启动操作，取消后恢复", async () => {
  const env = appHarness(), entered = deferred(), gate = deferred();
  env.dialog.showOpenDialog = async () => { entered.resolve(); return gate.promise; };
  const selecting = env.handle("config:select"); await entered.promise;
  assert.equal(env.counters().connectionChanging, true);
  for (const action of ["buff:check", "buff:login", "uu:login", "startup:start", "startup:configure", "service:connect", "config:select", "profiles:select", "profiles:rename", "cloud:import", "cloud:upload"]) await assert.rejects(env.handle(action), /正在切换本机连接/);
  assert.equal(env.counters().pendingPlatformActions, 0);
  assert.equal((await env.handle("startup:status")).status, "idle");
  gate.resolve({ canceled: true }); await selecting;
  assert.equal(env.counters().connectionChanging, false);
  await env.handle("buff:check"); assert(env.calls.includes("buff:check"));
});

test("账户、调度、账本和启动偏好拒绝通用 storage:set，其他合法本机偏好仍可保存", async () => {
  const env = appHarness();
  for (const payload of [{ orderLedger: {} }, { startupSync: { enabled: true } }, { accountProfiles: initialProfiles() }, { syncSchedule: { lastStartedAt: 0 } }, { calculatorDraft: {}, orderLedger: {} }, { calculatorDraft: {}, accountProfiles: {} }, { calculatorDraft: {}, syncSchedule: {} }]) await assert.rejects(env.handle("storage:set", payload), /指定操作/);
  assert.equal(env.writes.length, 0);
  await env.handle("storage:set", { calculatorDraft: { buffPrice: "3.46" } });
  assert.deepEqual(env.writes, [{ calculatorDraft: { buffPrice: "3.46" } }]);
});

test("账户与云操作从首个 await 起保护连接，初始化失败后完整释放保护", async () => {
  for (const [action, payload] of [["profiles:select", { profileId: "account-2" }], ["profiles:rename", { profileId: "account-1", name: "账户一" }], ["profiles:adopt", {}], ["cloud:import", {}], ["cloud:upload", {}], ["cloud:export-mobile", {}]]) {
    const env = appHarness(), gate = deferred(), cloudReady = deferred(), initialized = env.mocks.accountRuntime.ready;
    env.mocks.accountRuntime.ready = Promise.all([initialized, gate.promise]); env.mocks.cloudSync.ready = cloudReady.promise;
    const task = env.handle(action, payload), failed = assert.rejects(task, /模拟云初始化失败/);
    assert.equal(env.counters().pendingPlatformActions, 1, action);
    const selecting = action === "profiles:select" || action === "profiles:adopt";
    assert.equal(env.counters().connectionChanging, selecting, action);
    if (selecting) {
      await assert.rejects(env.handle("config:select"), /正在切换本机连接/);
      await assert.rejects(env.handle("buff:check"), /正在切换本机连接/);
    } else await rejectsConnectionChange(env);
    gate.resolve(); await initialized; await Promise.resolve();
    assert.equal(env.counters().pendingPlatformActions, 1, action);
    await assert.rejects(env.handle("profiles:rename", { profileId: "account-1", name: "并发名称" }), /正在切换|请先完成/);
    cloudReady.reject(new Error("模拟云初始化失败")); await failed;
    assert.equal(env.counters().pendingPlatformActions, 0, action); assert.equal(env.counters().connectionChanging, false, action);
    assert(!env.calls.includes("dialog")); assert(!env.calls.includes("cloud:sync")); assert.equal(env.writes.length, 0);
  }
});

test("账户和云端路由拒绝跨组目标与隐藏参数，不产生写入或打开文件选择", async () => {
  const env = appHarness(); await env.mocks.accountRuntime.ready;
  for (const [action, payload] of [
    ["profiles:rename", { profileId: "account-2", name: "不能改另一组" }],
    ["profiles:rename", { profileId: "account-1", name: "账户一", bindings: {} }],
    ["profiles:select", { profileId: "account-3" }], ["profiles:select", { profileId: "account-2", bindings: {} }],
    ["profiles:adopt", { profileId: "account-2" }], ["cloud:import", { profileId: "account-2" }],
    ["cloud:upload", { profileId: "account-2" }], ["cloud:export-mobile", { profileId: "account-2" }],
  ]) {
    await assert.rejects(env.handle(action, payload), /账户|参数/);
    assert.equal(env.counters().pendingPlatformActions, 0); assert.equal(env.counters().connectionChanging, false);
  }
  assert.equal(env.accountProfiles.snapshot().activeProfileId, "account-1");
  assert.equal(env.writes.length, 0); assert(!env.calls.includes("dialog")); assert(!env.calls.includes("cloud:sync"));
  await env.handle("profiles:rename", { profileId: "account-1", name: "甲终端" });
  assert.equal(env.accountProfiles.get("account-1").name, "甲终端"); assert.equal(env.accountProfiles.get("account-2").name, "账户2");
});

test("已有云端上传或待传批次时不能切换配置、账户或重新归属历史", async () => {
  for (const property of ["running", "pending"]) {
    const env = appHarness(); env.mocks.cloudSync[property] = {};
    for (const [action, payload] of [["config:select"], ["profiles:select", { profileId: "account-2" }], ["profiles:adopt", {}]]) await assert.rejects(env.handle(action, payload), /上传/);
    assert.equal(env.accountProfiles.snapshot().activeProfileId, "account-1");
    assert(!env.calls.includes("dialog")); assert.equal(env.writes.length, 0); assert.equal(env.counters().connectionChanging, false);
  }
});

test("配置选择对话框挂起期间产生待传批次，返回后仍须阻止切换", async () => {
  for (const property of ["running", "pending"]) {
    const env = appHarness(), entered = deferred(), gate = deferred();
    env.dialog.showOpenDialog = async () => { entered.resolve(); return gate.promise; };
    const selecting = env.handle("config:select"); await entered.promise;
    env.mocks.cloudSync[property] = {}; gate.resolve({ canceled: false, filePaths: ["/virtual/new-config.json"] });
    await assert.rejects(selecting, /上传/);
    assert.equal(env.writes.length, 0); assert.equal(env.counters().connectionChanging, false);
  }
});

test("平台只读列表在切换账户后不得返回旧组的异步结果", async () => {
  for (const platform of ["buff", "uu", "steam"]) {
    const env = appHarness(), entered = deferred(), gate = deferred(); await env.mocks.accountRuntime.ready;
    env.mocks[platform + "Orders"].list = async () => { entered.resolve(); await gate.promise; return { rows: [{ accountId: `${platform}:old` }] }; };
    const listing = env.handle(`${platform}:list`, { page: 1 }); await entered.promise;
    await env.handle("profiles:select", { profileId: "account-2" });
    gate.resolve(); await assert.rejects(listing, /切换|取消|重新/);
    assert.equal(env.accountProfiles.snapshot().activeProfileId, "account-2");
  }
});
