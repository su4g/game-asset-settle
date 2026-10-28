"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { CloudSync, validateConnection, DEFAULT_BASE_URL } = require("../desktop/cloud-sync.cjs");
const { fixture } = require("./cloud-fixture.cjs");
const connection = (profileId = "account-1", suffix = "a") => ({ version: 1, profileId, baseURL: DEFAULT_BASE_URL + "/", ingestToken: "ingest_" + suffix.repeat(40), readToken: "read_" + "r".repeat(40) });
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const receipt = envelope => ({ ok: true, result: { profileId: envelope.profiles[0].id, deviceId: envelope.deviceId, sequence: envelope.sequence, uploadedAt: "2026-10-27T01:00:00.000Z" } });
function timerControl() { const timers = []; return { timers, setTimer: (fn, ms) => { const timer = { fn, ms, cancelled: false, unref() {} }; timers.push(timer); return timer; }, clearTimer: timer => { timer.cancelled = true; } }; }
async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "buff-cloud-sync-test-"));
  await fs.writeFile(path.join(directory, "cloud-connection.json"), JSON.stringify(connection()), { mode: 0o600 });
  const timers = timerControl(), instances = []; let current = { id: "account-1", name: "账户一" };
  const create = extra => {
    const instance = new CloudSync({ directory, currentProfile: async () => current, buildSnapshot: async () => fixture().profiles[0],
      fetcher: async (_url, init) => response(receipt(JSON.parse(init.body))), now: () => Date.parse("2026-10-27T02:00:00.000Z"), ...timers, ...options, ...extra });
    instances.push(instance); return instance;
  };
  t.after(async () => { instances.forEach(instance => instance.close()); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, create, timers: timers.timers, select: id => { current = { id, name: id }; } };
}
test("只有完全匹配的回执才能删除待传批次，手机连接导出不包含写权限", async t => {
  const e = await setup(t), sync = e.create(); await sync.ready; await sync.sync();
  await assert.rejects(fs.stat(path.join(e.directory, "cloud-pending.json")), { code: "ENOENT" });
  assert.equal(sync.snapshot().lastUploadedAt, "2026-10-27T01:00:00.000Z"); assert.equal(sync.snapshot().lastSequence, 1);
  const mobile = await sync.mobileConnection(); assert.equal(mobile.accessToken, connection().readToken); assert.equal(mobile.ingestToken, undefined);
  assert(!JSON.stringify(sync.snapshot()).includes(connection().ingestToken));
  const state = JSON.parse(await fs.readFile(sync.stateFile, "utf8")); assert.equal(state.uploads["account-1"].sequence, 1);
  assert.equal((await fs.stat(sync.stateFile)).mode & 0o077, 0);
});
test("错误回执保留同批并持久暂停自动上传，重启不会继续发送", async t => {
  let calls = 0;
  const e = await setup(t, { fetcher: async (_url, init) => { calls++; const data = receipt(JSON.parse(init.body)); data.result.profileId = "account-2"; return response(data); } }), sync = e.create();
  await sync.ready; await assert.rejects(sync.sync(), /确认与待上传批次不一致/);
  const pending = await fs.readFile(sync.pendingFile, "utf8"); assert.equal(sync.snapshot().paused, true); sync.schedule(); assert.equal(e.timers.length, 0);
  sync.close(); const reopened = e.create(); await reopened.ready; reopened.schedule(); assert.equal(e.timers.length, 0); assert.equal(reopened.snapshot().status, "attention");
  await reopened.sync({ automatic: true }); assert.equal(calls, 1); assert.equal(await fs.readFile(sync.pendingFile, "utf8"), pending);
});
test("服务端已保存但应答丢失后，重启先原样重传相同设备和序号，再发送新快照", async t => {
  const posts = []; let lose = true;
  const fetcher = async (_url, init) => { posts.push(init.body); if (lose) { lose = false; throw new Error("simulated lost response"); } return response(receipt(JSON.parse(init.body))); };
  const e = await setup(t, { fetcher }), sync = e.create(); await sync.ready; await assert.rejects(sync.sync(), /留在本机/);
  assert.equal(e.timers[0].ms, 30000); const original = await fs.readFile(sync.pendingFile, "utf8"); sync.close();
  const reopened = e.create(); await reopened.ready; await reopened.sync(); assert.equal(posts[0], posts[1]); assert.equal(posts[1], original);
  assert.equal(JSON.parse(posts[2]).sequence, 2); assert.equal(JSON.parse(posts[2]).deviceId, JSON.parse(original).deviceId); assert.equal(reopened.snapshot().pending, false);
});
test("401 后允许同组换凭据且保留原批，不能把旧批改投另一账户", async t => {
  let unauthorized = true; const posts = [];
  const e = await setup(t, { fetcher: async (_url, init) => { posts.push(init); return unauthorized ? response({ ok: false, code: "UNAUTHORIZED" }, 401) : response(receipt(JSON.parse(init.body))); } }), sync = e.create();
  await sync.ready; await assert.rejects(sync.sync(), /凭据失效/); const original = await fs.readFile(sync.pendingFile, "utf8");
  e.select("account-2"); await assert.rejects(sync.importConnection(connection("account-2")), /另一账户/); assert.equal(await fs.readFile(sync.pendingFile, "utf8"), original);
  e.select("account-1"); await sync.importConnection(connection("account-1", "b")); assert.equal(await fs.readFile(sync.pendingFile, "utf8"), original);
  unauthorized = false; await sync.sync(); assert.equal(posts[1].body, original); assert.equal(posts[1].headers.Authorization, "Bearer " + connection("account-1", "b").ingestToken);
});
test("导出期间切换关联账户不会发送到任何账户，快照中的凭据也被阻止", async t => {
  let resolveBuild, entered, calls = 0; const building = new Promise(resolve => { entered = resolve; });
  const e = await setup(t, { buildSnapshot: async () => { entered(); return new Promise(resolve => { resolveBuild = resolve; }); }, fetcher: async () => { calls++; throw new Error(); } }), sync = e.create();
  await sync.ready; const run = sync.sync(); await building; e.select("account-2"); resolveBuild(fixture().profiles[0]); await assert.rejects(run, /关联已切换/); assert.equal(calls, 0);
  e.select("account-1"); const credentialSync = e.create({ buildSnapshot: async () => { const p = fixture().profiles[0]; p.status.cookie = "synthetic"; return p; } }); await credentialSync.ready;
  await assert.rejects(credentialSync.sync(), /登录凭据字段/); assert.equal(calls, 0); await assert.rejects(fs.stat(sync.pendingFile), { code: "ENOENT" });
});
test("设备状态丢失时保留待传原件，不生成新设备身份或静默丢弃批次", async t => {
  const e = await setup(t, { fetcher: async () => { throw new Error("offline"); } }), sync = e.create(); await sync.ready; await assert.rejects(sync.sync());
  const original = await fs.readFile(sync.pendingFile, "utf8"); sync.close(); await fs.unlink(sync.stateFile);
  const reopened = e.create(); await assert.rejects(reopened.ready, /设备状态缺失/); assert.equal(await fs.readFile(sync.pendingFile, "utf8"), original); await assert.rejects(fs.stat(sync.stateFile), { code: "ENOENT" });
});
test("退出会取消正在上传的请求但保留原批，不继续构建下一批", async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const e = await setup(t, { fetcher: async (_url, init) => { entered(); return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); } }), sync = e.create();
  await sync.ready; const run = sync.sync(); await started; sync.close(); await assert.rejects(run); assert.equal(sync.snapshot().pending, true); assert.equal(sync.snapshot().paused, false); assert.equal(e.timers.length, 0);
});
test("并发触发复用同一个上传任务，云端 Retry-After 决定退避下限", async t => {
  let entered, release, calls = 0; const started = new Promise(resolve => { entered = resolve; });
  const e = await setup(t, { fetcher: async (_url, init) => { calls++; entered(); await new Promise(resolve => { release = resolve; }); return response(receipt(JSON.parse(init.body))); } }), sync = e.create();
  await sync.ready; const a = sync.sync(); await started; const b = sync.sync(); assert.equal(a, b); release(); await a; assert.equal(calls, 1);
  const throttled = e.create({ fetcher: async () => response({ ok: false, code: "RATE_LIMIT" }, 429, { "Retry-After": "3600" }) }); await throttled.ready; await assert.rejects(throttled.sync()); assert.equal(e.timers.at(-1).ms, 3600000);
});
test("自建服务器地址由连接文件决定，拒绝明文、凭据、参数和路径穿越", () => {
  assert.equal(validateConnection(connection()).baseURL, DEFAULT_BASE_URL);
  const hosted = "https://self-hosted.example.org/buff-helper-api";
  assert.equal(validateConnection({ ...connection(), baseURL: hosted + "/" }).baseURL, hosted);
  for (const baseURL of ["http://ledger.example.com/buff-helper-api", "https://user:password@ledger.example.com/buff-helper-api", DEFAULT_BASE_URL + "?token=x", DEFAULT_BASE_URL + "#fragment", DEFAULT_BASE_URL + "/../other", "https://ledger.example.com:8443/buff-helper-api", "https://ledger.example.com/a/../buff-helper-api", "https://ledger.example.com/buff-helper-api%2f"]) assert.throws(() => validateConnection({ ...connection(), baseURL }));
});
test("自建服务器切换不能带走原服务器尚未确认的待上传批次", async t => {
  const e = await setup(t, { fetcher: async () => { throw new Error("offline"); } }), sync = e.create();
  await sync.ready; await assert.rejects(sync.sync());
  const original = await fs.readFile(sync.pendingFile, "utf8");
  await assert.rejects(sync.importConnection({ ...connection(), baseURL: "https://another.example.org/buff-helper-api" }), /原服务器/);
  assert.equal(await fs.readFile(sync.pendingFile, "utf8"), original);
  assert.equal(sync.connection.baseURL, DEFAULT_BASE_URL);
});
