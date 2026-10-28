"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { StartupSync, latestSync } = require("../desktop/startup-sync.cjs");

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function setup(options = {}) {
  const events = [], calls = [], stored = { startupSync: { enabled: options.enabled !== false } };
  const platforms = {};
  for (const name of options.includeSteam ? ["buff", "uu", "steam"] : ["buff", "uu"]) {
    const spec = options[name] || {};
    const orders = { ready: Promise.resolve(), running: null, checking: false, verified: false,
      account: Object.hasOwn(spec, "account") ? spec.account : { id: `${name}:7`, nickname: "测试账户" }, job: { status: "idle" }, runs: spec.runs || [], sellProbe: { status: spec.sell || "unverified" },
      snapshot() { return { account: this.account, verified: this.verified, job: this.job, count: 1, runs: this.runs, sellProbe: this.sellProbe }; },
      async check() {
        calls.push(`${name}:check`); this.checking = true;
        try { if (spec.check) await spec.check(this); this.verified = spec.verified !== false; return this.snapshot(); }
        finally { this.checking = false; }
      },
      async start(value) {
        calls.push({ name, value }); this.job = { status: "running" };
        this.running = Promise.resolve().then(async () => {
          if (spec.run) await spec.run(value, this);
          if (value.probe && spec.probeResult) this.sellProbe.status = spec.probeResult;
          if (this.job.status === "running") this.job = { status: "completed" };
          if (!value.probe && this.job.status === "completed") this.runs = [{ channel: "history", syncedAt: "2026-10-21T01:00:00.000Z", complete: true }];
        }).finally(() => { this.running = null; });
        return this.snapshot();
      },
      stop() { calls.push(`${name}:stop`); this.job = { status: "cancelled" }; spec.stop?.(); },
    };
    platforms[name] = { orders, session: { close: () => calls.push(`${name}:close`), hasSession: async () => { calls.push(`${name}:session`); return spec.present !== false; }, open: () => assert.fail("启动同步不能打开登录窗口") } };
  }
  const state = { get: async () => structuredClone(stored), set: async value => Object.assign(stored, value) };
  const coordinator = new StartupSync({ state, platforms, notify: value => events.push(value), enabled: options.allowed !== false });
  return { coordinator, platforms, calls, stored, events };
}
async function run(coordinator, value) { await coordinator.start(value); await coordinator.running; return coordinator.snapshot(); }

test("启动关闭登录页面后校验，再增量同步；重复启动幂等且保留真实同步时间", async () => {
  const env = setup({ uu: { sell: "verified" } });
  await Promise.all([env.coordinator.start(), env.coordinator.start()]); await env.coordinator.running;
  const jobs = env.calls.filter(value => typeof value === "object");
  assert.deepEqual(jobs.filter(job => job.name === "buff").map(job => job.value), [{ appid: "all", direction: "all", channel: "history", mode: "incremental" }]);
  assert.deepEqual(jobs.filter(job => job.name === "uu").map(job => job.value), [{ direction: "buy", mode: "incremental" }, { direction: "sell", probe: true }, { direction: "sell", mode: "incremental" }]);
  for (const name of ["buff", "uu"]) assert(env.calls.indexOf(`${name}:close`) < env.calls.indexOf(`${name}:check`));
  const snapshot = env.coordinator.snapshot(); assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.platforms.buff.lastSyncedAt, "2026-10-21T01:00:00.000Z");
  await env.coordinator.start(); assert.equal(env.calls.filter(value => typeof value === "object").length, 4);
  await run(env.coordinator, { force: true }); assert.equal(env.calls.filter(value => typeof value === "object").length, 8);
});

test("Steam 启动先销毁登录页再检查与增量，未登录和 smoke 不访问实站",async()=>{
  const env=setup({includeSteam:true});await run(env.coordinator);
  assert(env.calls.indexOf("steam:close")<env.calls.indexOf("steam:check"));
  assert.deepEqual(env.calls.filter(c=>c?.name==="steam").map(c=>c.value),[{mode:"incremental"}]);
  assert.equal(env.coordinator.snapshot().platforms.steam.phase,"completed");
  const absent=setup({includeSteam:true,steam:{present:false,account:null}});await run(absent.coordinator);
  assert.equal(absent.coordinator.snapshot().platforms.steam.phase,"login-required");assert(!absent.calls.includes("steam:check"));
  const smoke=setup({includeSteam:true,allowed:false});await run(smoke.coordinator);assert.equal(smoke.calls.length,0);
});

test("无会话且无有效历史账户不访问平台、不弹窗；报告需登录并保留最后同步时间", async () => {
  const env = setup({ buff: { present: false, account: null, runs: [{ channel: "history", syncedAt: "2026-10-10T01:00:00Z" }] }, uu: { present: false, account: { id: "uu:" } } });
  const value = await run(env.coordinator);
  assert.equal(value.platforms.buff.phase, "login-required"); assert.equal(value.platforms.uu.phase, "login-required");
  assert.equal(value.platforms.buff.lastSyncedAt, "2026-10-10T01:00:00Z"); assert.equal(value.platforms.uu.lastSyncedAt, null);
  assert(!env.calls.some(value => typeof value === "object" || value.endsWith(":check")));
});

test("Cookie预检未发现会话但有历史账户时执行只读验证，成功后才增量同步", async () => {
  const env = setup({ buff: { present: false }, uu: { present: false, account: null } });
  const value = await run(env.coordinator);
  assert.equal(value.platforms.buff.phase, "completed"); assert.equal(value.platforms.buff.verified, true);
  assert.equal(env.calls.filter(call => call === "buff:check").length, 1);
  assert(env.calls.indexOf("buff:close") < env.calls.indexOf("buff:check"));
  assert.deepEqual(env.calls.filter(call => call?.name === "buff").map(call => call.value), [{ appid: "all", direction: "all", channel: "history", mode: "incremental" }]);
  assert.equal(value.platforms.uu.phase, "login-required"); assert(!env.calls.includes("uu:check"));
});

test("Cookie预检未发现会话时缓存账户不能替代验证，登录失败或未验证均不启动同步", async () => {
  for (const failure of [{ check: async () => { throw new Error("请先登录"); } }, { verified: false }]) {
    const env = setup({ buff: { present: false, ...failure }, uu: { present: false, account: null } });
    const value = await run(env.coordinator);
    assert.equal(value.platforms.buff.phase, "login-required"); assert.equal(value.platforms.buff.verified, false); assert.equal(value.platforms.buff.checkedAt, null);
    assert.equal(env.calls.filter(call => call === "buff:check").length, 1); assert(!env.calls.some(call => call?.name === "buff"));
  }
});

test("悠悠旧验证未通过不自动开放卖出；旧验证通过也必须本次样本通过", async () => {
  for (const options of [{ sell: "empty" }, { sell: "verified", probeResult: "empty" }]) {
    const env = setup({ uu: options }); const value = await run(env.coordinator);
    assert.equal(value.platforms.uu.phase, "attention");
    assert(!env.calls.some(call => call?.name === "uu" && call.value.direction === "sell" && !call.value.probe));
    assert.equal(env.calls.filter(call => call?.name === "uu" && call.value.probe).length, options.sell === "verified" ? 1 : 0);
  }
});

test("取消正在校验的启动任务后，不再进入同步；其他平台仍正常完成", async () => {
  const gate = deferred(), entered = deferred();
  const env = setup({ buff: { check: async () => { entered.resolve(); await gate.promise; }, stop: () => gate.resolve() }, uu: { sell: "verified" } });
  await env.coordinator.start(); await entered.promise;
  await env.coordinator.cancel("buff"); await env.coordinator.running;
  const value = env.coordinator.snapshot();
  assert.equal(value.platforms.buff.phase, "cancelled"); assert.equal(value.platforms.uu.phase, "completed");
  assert(!env.calls.some(call => call?.name === "buff"));
  assert.equal(env.calls.filter(call => call === "buff:stop").length, 1);
});

test("取消悠悠买入同步后不会启动卖出验证或卖出同步", async () => {
  const gate = deferred(), entered = deferred();
  const env = setup({ uu: { sell: "verified", run: async value => { if (value.direction === "buy") { entered.resolve(); await gate.promise; } }, stop: () => gate.resolve() } });
  await env.coordinator.start(); await entered.promise; await env.coordinator.cancel("uu"); await env.coordinator.running;
  assert.equal(env.coordinator.snapshot().platforms.uu.phase, "cancelled");
  assert.deepEqual(env.calls.filter(call => call?.name === "uu").map(call => call.value), [{ direction: "buy", mode: "incremental" }]);
});

test("已有手动任务不抢占；启动设置持久化，smoke 不能启用网络", async () => {
  const busy = setup(); busy.platforms.buff.orders.checking = true;
  assert.equal((await run(busy.coordinator)).platforms.buff.phase, "busy");
  assert(!busy.calls.includes("buff:check")); assert(!busy.calls.includes("buff:stop"));
  const disabled = setup({ enabled: false }); assert.equal((await run(disabled.coordinator)).status, "disabled"); assert.equal(disabled.calls.length, 0);
  await disabled.coordinator.configure({ enabled: true }); assert.equal(disabled.stored.startupSync.enabled, true);
  await run(disabled.coordinator); assert(disabled.calls.includes("buff:check"));
  await disabled.coordinator.configure({ enabled: false }); assert.equal(disabled.stored.startupSync.enabled, false); assert.equal(disabled.coordinator.snapshot().status, "disabled");
  const smoke = setup({ allowed: false }); assert.equal((await run(smoke.coordinator)).status, "disabled"); assert.equal(smoke.calls.length, 0);
  await assert.rejects(smoke.coordinator.configure({ enabled: true }), /验收模式/);
});

test("校验和同步失败不重试、不伪造最后同步时间", async () => {
  const env = setup({ buff: { check: async () => { throw new Error("BUFF 请求受限"); } }, uu: { run: async (_value, orders) => { orders.job = { status: "failed", message: "悠悠查询失败" }; } } });
  const value = await run(env.coordinator); assert.equal(value.status, "partial");
  assert.equal(value.platforms.buff.phase, "failed"); assert.equal(value.platforms.buff.lastSyncedAt, null);
  assert.equal(value.platforms.uu.phase, "failed"); assert.equal(value.platforms.uu.lastSyncedAt, null);
  assert.equal(env.calls.filter(call => call?.name === "uu").length, 1);
  assert.equal(latestSync([{ channel: "pending", syncedAt: "2026-10-22T00:00:00Z" }, { channel: "history", syncedAt: "bad" }]), null);
});

test("真实订单客户端的账户校验可取消，迟到账户响应不会重新标记已验证", async () => {
  const { BuffOrders } = require("../desktop/buff-orders.cjs"), { UuOrders } = require("../desktop/uu-orders.cjs");
  for (const Client of [BuffOrders, UuOrders]) {
    const entered = deferred(); let hold = true, aborted = false;
    const orders = new Client({ repository: { load: async () => ({ version: 1, accounts: {} }) }, interval: () => 0, fetcher: async (_url, init) => {
      entered.resolve();
      if (hold) await new Promise(resolve => init.signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
      return new Response(JSON.stringify(Client === BuffOrders ? { code: "OK", data: { user_id: "7" } } : { code: 0, data: { UserId: "7" } }));
    } });
    const checking = orders.check(), rejected = assert.rejects(checking, /停止/);
    await entered.promise; await orders.invalidate(); await rejected;
    assert(aborted); assert.equal(orders.verified, false); assert.equal(orders.checking, false); assert.equal(orders.account, null);
    hold = false; await orders.check(); assert.equal(orders.verified, true);
  }
});

test("会话存在检查只返回布尔，过期或歧义悠悠令牌不触发平台请求", async () => {
  const { createBuffSession } = require("../desktop/buff-session.cjs"), { createUuSession } = require("../desktop/uu-session.cjs");
  for (const create of [createBuffSession, createUuSession]) {
    let cookies = [];
    const ses = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, webRequest: { onBeforeRequest() {}, onBeforeSendHeaders() {} }, cookies: { on() {}, get: async () => cookies }, fetch: () => assert.fail("检测会话不应访问平台") };
    const client = create({ session: { fromPartition: () => ses }, parent: () => null, BrowserWindow() {}, onSessionChange() {} });
    assert.equal(await client.hasSession(), false);
    cookies = [{ value: "private-test-value", expirationDate: Date.now() / 1000 - 1 }]; assert.equal(await client.hasSession(), false);
    cookies = [{ value: "private-test-value" }]; assert.equal(await client.hasSession(), true);
    if (create === createUuSession) {
      cookies = [{ value: "one" }, { value: "two" }]; assert.equal(await client.hasSession(), false);
      cookies = [{ value: "bad%0Atoken" }]; assert.equal(await client.hasSession(), false);
    }
  }
});

test("悠悠后台只读响应正常续期不中断，网页登录变更与真正删除仍失效", () => {
  const { createUuSession } = require("../desktop/uu-session.cjs");
  let changed, invalidations = 0;
  const ses = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, webRequest: { onBeforeRequest() {}, onBeforeSendHeaders() {} }, cookies: { on(_name, handler) { changed = handler; } } };
  class Window extends require("node:events").EventEmitter {
    constructor() { super(); this.destroyed = false; this.webContents = { setWindowOpenHandler() {}, on() {} }; }
    isDestroyed() { return this.destroyed; } loadURL() { return Promise.resolve(); } show() {} focus() {}
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const client = createUuSession({ session: { fromPartition: () => ses }, BrowserWindow: Window, parent: () => null, onSessionChange: () => invalidations++ });
  const cookie = { name: "uu_token", domain: ".youpin898.com" };
  changed({}, cookie, "overwrite", true); changed({}, cookie, "inserted", false); changed({}, cookie, "inserted-no-value-change-overwrite", false);
  assert.equal(invalidations, 0);
  client.open(); changed({}, cookie, "inserted", false); assert.equal(invalidations, 1);
  client.close(); changed({}, cookie, "inserted", false); assert.equal(invalidations, 1);
  changed({}, cookie, "expired", true); assert.equal(invalidations, 2);
});
