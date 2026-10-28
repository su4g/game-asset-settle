"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { JSDOM } = require("jsdom");
const root = path.resolve(__dirname, "..");
const tick = async () => { for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve)); };
function state(activeProfileId = "account-1") {
  return { activeProfileId, profiles: [
    { id: "account-1", name: "账户一", bindings: { buff: "buff:7", uu: "uu:8", steam: "76561198000000001" }, csvScopes: ["默认账户"] },
    { id: "account-2", name: "账户二", bindings: { buff: null, uu: null, steam: null }, csvScopes: [] }
  ], currentPlatformStates: { buff: { message: "等待同步" }, uu: { message: "等待同步" }, steam: { message: "等待同步" } },
  schedule: { enabled: true, status: "waiting", nextRunAt: Date.parse("2026-10-27T12:00:00Z") },
  cloud: { enabled: true, configured: true, profileId: "account-1", status: "synced", lastUploadedAt: "2026-10-27T06:00:00Z" } };
}
async function ui(t, initial = state()) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "desktop/index.html"), "utf8"), { runScripts: "outside-only", url: "https://desktop.test/" });
  t.after(() => dom.window.close());
  const requests = [], listeners = [], navigation = [];
  const env = { dom, requests, navigation, state: initial, handlers: {}, emit(event) { listeners.forEach(listener => listener(event)); } };
  dom.window.buffDesktop = { request: async (action, payload) => {
    requests.push({ action, payload: JSON.parse(JSON.stringify(payload)) });
    if (env.handlers[action]) return env.handlers[action](payload);
    if (action === "profiles:status") return structuredClone(env.state);
    if (action === "profiles:select") { env.state.activeProfileId = payload.profileId; return structuredClone(env.state); }
    if (action === "profiles:rename") { env.state.profiles.find(profile => profile.id === payload.profileId).name = payload.name; return structuredClone(env.state); }
    if (action === "profiles:adopt") return structuredClone(env.state);
    if (action === "cloud:import" || action === "cloud:export-mobile") return { cancelled: true };
    assert.fail(`未预期操作：${action}`);
  }, onChange(listener) { listeners.push(listener); return () => {}; } };
  dom.window.BuffDesktopNavigation = { navigate: page => navigation.push(page) };
  dom.window.eval(fs.readFileSync(path.join(root, "desktop/account-cloud-ui.js"), "utf8"));
  await dom.window.BuffAccountCloudWorkspace.ready;
  return env;
}
async function submit(env, id) { env.dom.window.document.getElementById(id).dispatchEvent(new env.dom.window.Event("submit", { bubbles: true, cancelable: true })); await tick(); }

test("新终端不默认归属，明确选择和提交后才关联一组，云连接不匹配时不可上传", async t => {
  const value = state(null); value.cloud = { enabled: true, configured: false };
  const env = await ui(t, value), d = env.dom.window.document;
  assert.equal(d.getElementById("terminalProfile").value, "");
  assert.equal(d.getElementById("terminalCloudImport").disabled, true);
  assert.match(d.getElementById("terminalProfileSummary").textContent, /尚未关联/);
  const selector = d.getElementById("terminalProfile"); selector.value = "account-2"; selector.dispatchEvent(new env.dom.window.Event("change"));
  assert.deepEqual(env.requests.map(request => request.action), ["profiles:status"]);
  await submit(env, "terminalProfileForm");
  assert.deepEqual(env.requests.find(request => request.action === "profiles:select").payload, { profileId: "account-2" });
  assert.match(d.getElementById("terminalProfileSummary").textContent, /账户二/);
  assert.equal(d.getElementById("terminalCloudUpload").disabled, true);
  assert.equal(d.getElementById("terminalCloudImport").disabled, false);
  assert.doesNotMatch(d.getElementById("terminalPlatformBindings").textContent, /buff:7|uu:8|76561198/);
});

test("绑定与失效状态按选定组显示，定时和上传时间使用北京时间，登录入口只导航", async t => {
  const value = state(); value.currentPlatformStates.uu = { needsLogin: true, phase: "login-required", message: "登录已失效，请重新登录" };
  const env = await ui(t, value), d = env.dom.window.document;
  assert.match(d.getElementById("terminalPlatformBindings").textContent, /buff:7/);
  assert.match(d.getElementById("terminalSchedule").textContent, /20:00.*北京时间/);
  assert.match(d.getElementById("terminalLastUpload").textContent, /14:00.*北京时间/);
  assert.match(d.getElementById("terminalAccountAttention").textContent, /其他平台继续同步/);
  const attention = d.querySelector(".account-cloud-binding.needs-attention"); assert.match(attention.textContent, /悠悠.*登录已失效/);
  attention.querySelector("button").click(); assert.deepEqual(env.navigation, ["uu"]);
  assert(env.requests.every(request => request.action === "profiles:status"));
  env.state.currentPlatformStates.uu = { message: "校验成功" }; env.state.schedule.enabled = false;
  env.emit({ kind: "account-runtime" }); env.emit({ kind: "sync-schedule" }); await tick();
  assert.equal(d.getElementById("terminalAccountAttention").hidden, true);
  assert.match(d.getElementById("terminalSchedule").textContent, /已关闭/);
});

test("后台状态刷新保留未提交名称和账户选择，名称与绑定只作文本", async t => {
  const value = state(); value.profiles[0].name = '<img src=x onerror="alert(1)">';
  const env = await ui(t, value), d = env.dom.window.document;
  assert.equal(d.querySelectorAll("#accountCloudCard img").length, 0);
  const input = d.getElementById("terminalProfileName"); input.value = "交易账户甲"; input.dispatchEvent(new env.dom.window.Event("input"));
  d.getElementById("terminalProfile").value = "account-2"; env.emit({ kind: "cloud-sync" }); await tick();
  assert.equal(input.value, "交易账户甲"); assert.equal(d.getElementById("terminalProfile").value, "account-2");
  await submit(env, "terminalProfileRenameForm");
  assert.deepEqual(env.requests.find(request => request.action === "profiles:rename").payload, { profileId: "account-1", name: "交易账户甲" });
  assert.match(d.getElementById("terminalProfileSummary").textContent, /交易账户甲/);
});

test("连接文件使用原生桥接，取消不会误报成功， renderer 不呈现或发送连接凭据", async t => {
  const env = await ui(t), d = env.dom.window.document;
  env.state.cloud.ingestToken = "测试秘密不能渲染"; env.state.cloud.readToken = "只读秘密不能渲染";
  env.emit({ kind: "cloud-sync" }); await tick();
  d.getElementById("terminalCloudImport").click(); await tick();
  assert.match(d.getElementById("accountCloudMessage").textContent, /已取消/);
  d.getElementById("terminalMobileExport").click(); await tick();
  assert.match(d.getElementById("accountCloudMessage").textContent, /已取消/);
  for (const request of env.requests.filter(request => request.action.startsWith("cloud:"))) assert.deepEqual(request.payload, {});
  assert.doesNotMatch(d.getElementById("accountCloudCard").textContent, /测试秘密|只读秘密/);
  assert.equal(env.dom.window.localStorage.length, 0);
});

test("操作互斥，上传失败保留待上传提示，关联歧义在界面显示且不伪报成功", async t => {
  const env = await ui(t), d = env.dom.window.document; let finish;
  env.handlers["cloud:upload"] = () => new Promise(resolve => { finish = resolve; });
  d.getElementById("terminalCloudUpload").click(); d.getElementById("terminalCloudUpload").click();
  assert.equal(d.getElementById("terminalProfile").disabled, true);
  assert.equal(env.requests.filter(request => request.action === "cloud:upload").length, 1);
  env.state.cloud.pending = true; env.state.cloud.status = "pending"; env.state.cloud.error = "连接失败，数据保留等待重试"; finish(env.state.cloud); await tick();
  assert.match(d.getElementById("accountCloudMessage").textContent, /上传尚未完成/);
  assert.match(d.getElementById("terminalAccountAttention").textContent, /保留等待重试/);
  env.handlers["profiles:adopt"] = () => { throw new Error("本机含多个同平台账号，不能自动归属"); };
  d.getElementById("terminalProfileAdopt").click(); await tick();
  assert.equal(d.getElementById("accountCloudError").hidden, false);
  assert.match(d.getElementById("accountCloudError").textContent, /不能自动归属/);
  assert.equal(d.getElementById("accountCloudMessage").textContent, "");
});

test("过期状态响应不能覆盖较新的账户状态", async t => {
  const env = await ui(t), d = env.dom.window.document, responses = [];
  env.handlers["profiles:status"] = () => new Promise(resolve => responses.push(resolve));
  const earlier = env.dom.window.BuffAccountCloudWorkspace.refresh(), later = env.dom.window.BuffAccountCloudWorkspace.refresh();
  responses[1](state("account-2")); await later;
  responses[0](state("account-1")); await earlier;
  assert.match(d.getElementById("terminalProfileSummary").textContent, /账户二/);
  assert.equal(d.getElementById("terminalMobileExport").disabled, true);
});
