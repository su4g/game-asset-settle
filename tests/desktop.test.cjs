"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { assetForUrl, validateRequest, ledgerRequest, LocalState, BackgroundProbe } = require("../desktop/runtime.cjs");

test("桌面资源只开放打包界面，不暴露配置、源码后台或远程页面", async () => {
  assert.equal(assetForUrl("buff-desktop://app/ledger.html"), "ledger.html");
  const html = await fs.readFile(path.join(__dirname, "../desktop/index.html"), "utf8");
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)) {
    const url = new URL(match[1], "buff-desktop://app/desktop/index.html");
    assert.ok(assetForUrl(url.href), `桌面入口依赖必须可加载：${url.pathname}`);
  }
  for (const url of ["https://buff.163.com/", "file:///etc/passwd", "buff-desktop://other/ledger.html", "buff-desktop://app/.ledger/config.json", "buff-desktop://app/ledger-config.js", "buff-desktop://app/desktop/main.cjs", "buff-desktop://app/server/store.cjs", "buff-desktop://user@app/ledger.html"]) assert.equal(assetForUrl(url), null, url);
});

test("仅允许本机账本读写，不开放购买任务执行、任意地址或导入副作用", () => {
  assert.equal(validateRequest({ path: "/trades?q=test&page=1" }).method, "GET");
  assert.equal(validateRequest({ path: "/trades", method: "POST", body: { quantity: 1 } }).body, '{"quantity":1}');
  for (const message of [{ path: "https://buff.163.com/" }, { path: "//localhost/trades" }, { path: "/tasks", method: "POST", body: {} }, { path: "/migrate", method: "POST", body: {} }, { path: "/prices", method: "POST", body: {} }, { path: "/health", method: "DELETE" }, { path: "/trades", method: "POST", body: [] }]) assert.throws(() => validateRequest(message));
});

test("账本请求将令牌留在后台，只连接回环地址且不跟随重定向", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "buff-desktop-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, "config.json");
  let redirected = false, requestCount = 0, posted;
  const server = http.createServer(async (req, res) => {
    requestCount++;
    assert.equal(req.headers.authorization, "Bearer test-desktop-token-123456789");
    if (req.url === "/v1/health") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, result: { connected: true } })); }
    else if (req.url === "/v1/trades") {
      assert.equal(req.method, "POST");
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      posted = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, result: { id: "local-record" } }));
    }
    else if (req.url === "/v1/summary") { res.writeHead(302, { Location: "/redirect-target" }); res.end(); }
    else { redirected = true; res.end("{}"); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  await fs.writeFile(config, JSON.stringify({ port: server.address().port, token: "test-desktop-token-123456789" }));
  assert.deepEqual(await ledgerRequest(config, { path: "/health" }), { connected: true });
  assert.deepEqual(await ledgerRequest(config, { path: "/trades", method: "POST", body: { quantity: 2, buyTotalCents: 1234 } }), { id: "local-record" });
  assert.deepEqual(posted, { quantity: 2, buyTotalCents: 1234 });
  await assert.rejects(ledgerRequest(config, { path: "/summary" }), /连接失败/);
  assert.equal(redirected, false);
  await assert.rejects(ledgerRequest(config, { path: "/tasks", method: "POST", body: {} }));
  assert.equal(requestCount, 3);
});

test("并发偏好保存不丢字段，重启可恢复，未知键不落盘", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "buff-desktop-state-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json"), store = new LocalState(file);
  await Promise.all([store.set({ calculatorDraft: { buffPrice: "12.34" } }), store.set({ ledgerTargetRatio: "8.6" })]);
  assert.deepEqual(await new LocalState(file).get(["calculatorDraft", "ledgerTargetRatio"]), { calculatorDraft: { buffPrice: "12.34" }, ledgerTargetRatio: "8.6" });
  await assert.rejects(store.set({ token: "not-allowed" }));
  await assert.rejects(store.get(["token"]));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("损坏偏好保留原文件，不静默覆盖", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "buff-desktop-broken-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  await fs.writeFile(file, "incomplete{");
  await assert.rejects(new LocalState(file).set({ ledgerTargetRatio: "8.6" }), /原文件已保留/);
  assert.equal(await fs.readFile(file, "utf8"), "incomplete{");
});

test("后台检查串行执行，重复开始不增开任务，异常不会报全部成功", async () => {
  let calls = 0, inFlight = 0, maximum = 0, complete;
  const finished = new Promise(resolve => { complete = resolve; });
  const probe = new BackgroundProbe(async () => {
    calls++; inFlight++; maximum = Math.max(maximum, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5)); inFlight--;
    if (calls === 2) throw new Error("服务断开");
  }, state => { if (state.status === "failed") complete(state); }, { interval: 1, steps: 3 });
  probe.start(); probe.start();
  const result = await finished;
  assert.equal(calls, 3); assert.equal(maximum, 1); assert.equal(result.successes, 2); assert.equal(result.completed, 3);
});

test("停止后台检查时丢弃正在返回的旧结果", async () => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const probe = new BackgroundProbe(() => { entered(); return new Promise(resolve => { release = resolve; }); }, () => {}, { interval: 1, steps: 1 });
  probe.start(); await ready; probe.stop(); release();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(probe.snapshot().status, "cancelled"); assert.equal(probe.snapshot().completed, 0);
});
