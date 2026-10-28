"use strict";
const { PRODUCT_NAME, APP_VERSION } = require("./brand.cjs");
const { app, BrowserWindow, ipcMain, protocol, session, Menu, dialog, Notification, utilityProcess, Tray, nativeImage, powerMonitor } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { OrderLedgerService } = require("./order-ledger-service.cjs");
const { APP_URL, assetForUrl, readConfig, ledgerRequest, LocalState, BackgroundProbe } = require("./runtime.cjs");
const { saveExport } = require("./history-export.cjs");
const { BuffOrders } = require("./buff-orders.cjs");
const { createBuffSession } = require("./buff-session.cjs");
const { UuOrders } = require("./uu-orders.cjs");
const { createUuSession } = require("./uu-session.cjs");
const { SteamOrders } = require("./steam-orders.cjs");
const { createSteamSession } = require("./steam-session.cjs");
const { HistoryRepository } = require("./history-repository.cjs");
const { AccountProfiles, AccountScopedRepository } = require("./account-profiles.cjs");
const { AccountRuntime } = require("./account-runtime.cjs");
const { SyncScheduler } = require("./sync-scheduler.cjs");
const { profileScope, scopeOptions } = require("./account-data.cjs");
const { CloudSync } = require("./cloud-sync.cjs");

const root = path.resolve(__dirname, "..");
const smoke = process.argv.includes("--smoke-test");
const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const dataDir = arg("--profile-dir") || path.join(app.getPath("appData"), "buff-goods-desktop");
app.setName(PRODUCT_NAME);
app.setPath("userData", dataDir);
protocol.registerSchemesAsPrivileged([{ scheme: "buff-desktop", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let window, configFile = null, managedService = null, serviceTask = null, initialized = false;
let generation = 0, connectionChanging = false;
let pendingWrites = 0, pendingPlatformActions = 0, exportPending = false;
let buffSession, buffOrders, uuSession, uuOrders, steamSession, steamOrders, startup, orderLedger;
let accountRuntime, scheduler, cloudSync, tray;
let usingBuffFixture = false;
const startedAt = Date.now();
const state = new LocalState(path.join(dataDir, "preferences.json"));
const logs = [];
function changed(value) {
  if (window && !window.isDestroyed()) window.webContents.send("buff-desktop:change", value);
  if (["history", "order-ledger", "account-profiles"].includes(value.kind) || value.kind === "storage" && value.changes?.priceWorkspace) cloudSync?.schedule();
}
const accountProfiles = new AccountProfiles({ state, notify: changed });
const notifiedLogins = new Set();
function runtimeChanged(value) {
  changed(value);
  if (value.kind === "account-runtime") {
    const item = value.value?.platforms?.[value.platform], key = `${value.profileId}:${value.platform}`;
    if (item?.needsLogin && !notifiedLogins.has(key)) {
      notifiedLogins.add(key);
      const label = { buff: "BUFF", uu: "悠悠", steam: "Steam" }[value.platform];
      const message = `${accountProfiles.get(value.profileId).name} · ${label} 登录需要重新认证，请在本机打开对应平台登录窗口`;
      log(message, "error");
      if (!smoke && Notification.isSupported()) new Notification({ title: "BUFF 助手 · 登录已失效", body: message }).show();
    } else if (item && !item.needsLogin) notifiedLogins.delete(key);
    if (!["checking", "syncing"].includes(item?.phase)) cloudSync?.schedule();
  }
  if (["account-runtime", "sync-schedule"].includes(value.kind) && startup) changed({ kind: "startup-sync", value: startup.snapshot() });
}
function log(message, level = "info") { logs.push({ at: Date.now(), message, level }); if (logs.length > 100) logs.shift(); changed({ kind: "log" }); if (smoke) console.log(`[desktop-check] ${message}`); }
const probe = new BackgroundProbe(() => ledgerRequest(configFile, { path: "/health" }), value => {
  changed({ kind: "probe", value });
  if (value.status === "completed" || value.status === "failed") {
    const message = `本机后台检查完成：${value.successes}/${value.total} 次连接成功`;
    log(message, value.status === "failed" ? "error" : "info");
    if (!smoke && Notification.isSupported()) new Notification({ title: PRODUCT_NAME, body: message }).show();
  }
});

async function ensureService() {
  if (!configFile) return;
  if (serviceTask) return serviceTask;
  serviceTask = (async () => {
    try { await ledgerRequest(configFile, { path: "/health" }); return; }
    catch (error) { if (error.code !== "LEDGER_UNREACHABLE") { log(error.message, "error"); return; } }
    log("正在启动本机账本服务");
    const child = utilityProcess.fork(path.join(__dirname, "ledger-service.cjs"), [configFile], { stdio: "ignore", serviceName: "BUFF 本机账本" });
    managedService = child;
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 9000);
      child.once("message", message => { clearTimeout(timer); log(message.ready ? "本机账本服务已启动" : message.error, message.ready ? "info" : "error"); resolve(); });
      child.once("exit", code => { clearTimeout(timer); if (managedService === child) managedService = null; if (code) log(`本机账本进程已退出（${code}）`, "error"); resolve(); });
    });
  })();
  try { await serviceTask; } finally { serviceTask = null; }
}

async function status() {
  let ledger;
  try { const health = await ledgerRequest(configFile, { path: "/health" }); ledger = { connected: true, database: health.database, pid: health.pid, startedAt: health.startedAt }; }
  catch (error) { ledger = { connected: false, error: error.message }; }
  return { version: APP_VERSION, startedAt, uptimeMs: Date.now() - startedAt, pid: process.pid,
    electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node,
    dataDir, configFile, ledger, managedService: Boolean(managedService), probe: probe.snapshot(), platformConnected: Boolean(buffOrders?.verified) };
}

async function selectConfig() {
  if (cloudSync?.running || cloudSync?.pending) throw new Error("请先完成当前账本的云端上传，再切换连接");
  if (pendingWrites || pendingPlatformActions || buffOrders?.running || buffOrders?.checking || uuOrders?.running || uuOrders?.checking || steamOrders?.running || steamOrders?.checking) throw new Error("正在同步或保存历史，完成后再切换连接");
  if (probe.snapshot().status === "running") throw new Error("请先停止后台检查，再切换账本");
  connectionChanging = true;
  try {
  await startup?.cancel();
  const choice = await dialog.showOpenDialog(window, { title: "选择现有账本的 .ledger/config.json", properties: ["openFile", "showHiddenFiles"], filters: [{ name: "账本配置", extensions: ["json"] }] });
  if (choice.canceled) return { cancelled: true };
  const selected = choice.filePaths[0];
  await readConfig(selected);
  if (serviceTask) await serviceTask;
  if (cloudSync?.running || cloudSync?.pending) throw new Error("请先完成当前账本的云端上传，再切换连接");
  if (pendingWrites || pendingPlatformActions || buffOrders?.running || buffOrders?.checking || uuOrders?.running || uuOrders?.checking || steamOrders?.running || steamOrders?.checking) throw new Error("正在同步或保存历史，完成后再切换连接");
  await fs.writeFile(path.join(dataDir, "connection.json"), JSON.stringify({ configFile: selected }), { mode: 0o600 });
  await startup?.cancel();
  generation++;
  managedService?.kill(); managedService = null;
  configFile = selected;
  await state.set({ ledgerViewCache: {} });
  await ensureService();
  await createOrders();
  startup.start().catch(error => log(error.message, "error"));
  window.webContents.reload();
  return { cancelled: false };
  } finally { connectionChanging = false; }
}

async function handle(action, payload) {
  if (connectionChanging && !["status", "logs", "startup:status"].includes(action)) throw new Error("正在切换本机连接，请稍后重试");
  if (action?.startsWith("profiles:") || action?.startsWith("cloud:")) return accountCloudAction(action, payload);
  if (action?.startsWith("startup:")) {
    const mutation = action !== "startup:status";
    if (mutation) pendingPlatformActions++;
    try {
    await startup.ready;
    if (action === "startup:status") return startup.snapshot();
    if (action === "startup:configure") return await startup.configure(payload);
    if (action === "startup:start") return await startup.start({ force: true });
    if (action === "startup:stop") return await startup.cancel();
    throw new Error("未开放的启动操作");
    } finally { if (mutation) pendingPlatformActions--; }
  }
  if (action?.startsWith("order-ledger:") || action?.startsWith("profit-report:") || action === "alchemy:load") {
    const method = { "alchemy:load": "alchemyLoad", "order-ledger:load": "load", "order-ledger:trends": "trends", "order-ledger:configure": "configure", "order-ledger:exclude": "exclude", "order-ledger:override": "override", "order-ledger:watch": "watch", "profit-report:load": "reportLoad", "profit-report:save": "reportSave", "profit-report:toggle": "reportToggle" }[action];
    if (!method) throw new Error("未开放的订单账本操作");
    const run = generation, service = orderLedger, writing = !["load", "trends", "reportLoad", "alchemyLoad"].includes(method);
    if (writing) pendingWrites++;
    try {
      const result = await service[method](payload);
      if (run !== generation) throw new Error("账本连接已切换，请重新核算");
      if (writing) changed({ kind: "order-ledger" });
      return result;
    } finally { if (writing) pendingWrites--; }
  }
  const platformAction = typeof action === "string" && action.match(/^(buff|uu|steam):(status|list|collect|check|start|stop|login|logout|probe-sell|inventory)$/);
  if (platformAction) {
    const [, platform, operation] = platformAction;
    if (smoke && ["login", "check", "start", "probe-sell", "inventory"].includes(operation) && !(platform === "buff" && usingBuffFixture && operation !== "login")) throw new Error("本机验收模式不访问真实交易平台");
    const mutation = !["status", "list", "collect"].includes(operation);
    if (mutation) pendingPlatformActions++;
    const run = generation;
    try {
      const result = await accountRuntime.manual(platform, operation, payload);
      if (run !== generation) throw new Error("账户或账本连接已切换，请重新加载平台数据");
      return result;
    }
    finally { if (mutation) pendingPlatformActions--; }
  }
  if (action === "status") return status();
  if (action === "logs") return logs.slice();
  if (action === "config:select") return selectConfig();
  if (action === "service:connect") {
    if (cloudSync?.running) throw new Error("云端上传进行中，请稍后重新连接");
    if (pendingWrites || pendingPlatformActions) throw new Error("正在保存或处理账户操作，请稍后重连");
    connectionChanging = true;
    try {
      await startup?.cancel();
      if (pendingWrites || pendingPlatformActions || buffOrders?.running || buffOrders?.checking || uuOrders?.running || uuOrders?.checking || steamOrders?.running || steamOrders?.checking) throw new Error("正在同步或保存历史，完成后再重新连接");
      await ensureService(); await createOrders();
      startup.start().catch(error => log(error.message, "error"));
      return await status();
    } finally { connectionChanging = false; }
  }
  if (action === "storage:get") return state.get(payload);
  if (action === "storage:set") { if (payload && ["orderLedger", "startupSync", "accountProfiles", "syncSchedule"].some(key => Object.hasOwn(payload, key))) throw new Error("请使用账户、账本或同步设置的指定操作"); const changes = await state.set(payload); changed({ kind: "storage", changes }); return null; }
  if (action === "history:export") {
    if (exportPending) throw new Error("请先完成当前 CSV 保存");
    exportPending = true;
    try { return await saveExport(payload, options => dialog.showSaveDialog(window, options)); }
    finally { exportPending = false; }
  }
  if (action === "probe:start") { if (!configFile) throw new Error("请先连接本机账本"); return probe.start(); }
  const historyRoutes = { "history:load": ["GET", "/history/csv"], "history:import": ["POST", "/history/csv"], "history:names": ["GET", "/history/names"], "history:name-save": ["POST", "/history/names"] };
  if (historyRoutes[action]) {
    const [method, route] = historyRoutes[action], writing = method === "POST", run = generation;
    if (writing) pendingWrites++;
    try {
      if (smoke && writing && !/^buff_goods_test_/.test((await readConfig(configFile)).database?.database || "")) throw new Error("历史写入验收必须使用隔离测试数据库");
      if (action === "history:import") {
        const profile = activeProfile(), scope = (payload?.scope || "默认账户").trim();
        if (!profile) throw new Error("请先选择当前终端关联账户再导入 CSV");
        if (accountProfiles.snapshot().profiles.some(item => item.id !== profile.id && item.csvScopes.includes(scope))) throw new Error("此 CSV 账户标签已归属另一组，请使用当前账户的独立标签");
      }
      const result = await ledgerRequest(configFile, { method, path: route, body: payload });
      if (run !== generation) throw new Error("连接已切换，请重新加载历史");
      if (action === "history:import" && activeProfile()) {
        const profile = activeProfile(), scope = (payload.scope || "默认账户").trim();
        await accountProfiles.assignCsvScopes(profile.id, [...new Set([...profile.csvScopes, scope])]);
      }
      if (writing) changed({ kind: "history", action });
      if (action === "history:load") {
        const scopes = new Set(activeProfile()?.csvScopes || []);
        return { ...result, rows: result.rows.filter(row => scopes.has(row.scope)), imports: (result.imports || []).filter(item => scopes.has(item.scope)) };
      }
      return result;
    } finally { if (writing) pendingWrites--; }
  }
  if (action === "probe:stop") return probe.stop();
  if (action === "ledger") {
    if (payload?.path?.startsWith("/history/")) throw new Error("请使用历史模块的指定操作");
    const run = generation;
    const writing = payload?.method && payload.method !== "GET" && !["/sync/preview", "/sync/buys/preview"].includes(payload.path);
    if (writing) pendingWrites++;
    try {
      const result = await ledgerRequest(configFile, payload);
      if (run !== generation) throw new Error("账本连接已切换，请刷新后重试");
      if (writing) { log("已保存本机账本记录"); changed({ kind: "storage", changes: { ledgerChangedAt: { newValue: Date.now() } } }); }
      return result;
    } finally { if (writing) pendingWrites--; }
  }
  throw new Error("桌面预览未开放此功能");
}

async function accountCloudAction(action, payload = {}) {
  const snapshot = () => ({ ...accountRuntime.snapshot(), schedule: scheduler.snapshot(), cloud: cloudSync.snapshot() });
  if (["profiles:status", "cloud:status"].includes(action)) {
    await accountRuntime.ready; await cloudSync.ready;
    return action === "profiles:status" ? snapshot() : cloudSync.snapshot();
  }
  if (!payload || Array.isArray(payload) || typeof payload !== "object") throw new Error("账户操作参数无效");
  if (pendingWrites || pendingPlatformActions || connectionChanging) throw new Error("请先完成当前保存或平台操作");
  pendingPlatformActions++;
  const changingProfile = ["profiles:select", "profiles:adopt"].includes(action);
  if (changingProfile) connectionChanging = true;
  try {
    await accountRuntime.ready; await cloudSync.ready;
    if (changingProfile && (cloudSync.running || cloudSync.pending)) throw new Error("请先完成当前账户待上传数据，再更改关联");
    if (action === "profiles:select") {
      if (Object.keys(payload).some(key => key !== "profileId") || !["account-1", "account-2"].includes(payload.profileId)) throw new Error("请选择有效的终端关联账户");
      if (cloudSync.running || cloudSync.pending) throw new Error("当前账户还有待上传数据，请先完成上传再切换终端归属");
      await accountRuntime.select(payload.profileId); generation++; updateSelectedPlatformAliases(); createOrderLedger();
      changed({ kind: "connection" }); window?.webContents.reload(); return snapshot();
    }
    if (action === "profiles:rename") {
      if (Object.keys(payload).some(key => !["profileId", "name"].includes(key)) || payload.profileId !== activeProfile()?.id) throw new Error("只能修改当前终端关联账户的名称");
      await accountProfiles.rename(payload.profileId, payload.name); cloudSync.schedule(); return snapshot();
    }
    if (action === "profiles:adopt") {
      if (Object.keys(payload).length || !activeProfile()) throw new Error("请先选择当前终端关联账户");
      await accountRuntime.cancel();
      const histories = Object.fromEntries(await Promise.all(["buff", "uu", "steam"].map(async platform => [platform, await ledgerRequest(configFile, { path: `/history/${platform}` })])));
      if (Object.values(histories).some(history => Object.keys(history.data.accounts).length > 1)) throw new Error("本机含多个同平台账号，不能自动归入一个账户，请先核对归属");
      const id = activeProfile().id, csv = await ledgerRequest(configFile, { path: "/history/csv" });
      await accountProfiles.bootstrapExisting(id, histories); await accountProfiles.assignCsvScopes(id, [...new Set(csv.rows.map(row => row.scope))]);
      await createOrders(); generation++; await scheduler.start({ runOnStartup: false }); window?.webContents.reload(); return snapshot();
    }
    if (action === "cloud:import") {
      if (Object.keys(payload).length || !activeProfile()) throw new Error("请先选择当前终端关联账户");
      const choice = await dialog.showOpenDialog(window, { title: `导入${activeProfile().name}的终端连接文件`, properties: ["openFile"], filters: [{ name: "BUFF 终端连接", extensions: ["buffdesktop", "json"] }] });
      if (choice.canceled) return { cancelled: true };
      const stat = await fs.stat(choice.filePaths[0]); if (!stat.isFile() || stat.size > 65536) throw new Error("终端连接文件无效");
      let value; try { value = JSON.parse(await fs.readFile(choice.filePaths[0], "utf8")); } catch { throw new Error("终端连接文件无法读取"); }
      await cloudSync.importConnection(value); await accountProfiles.reconcileRemoteProfiles(await cloudSync.remoteProfiles());
      cloudSync.schedule(); return cloudSync.snapshot();
    }
    if (action === "cloud:upload") { if (Object.keys(payload).length) throw new Error("云同步参数无效"); return await cloudSync.sync({ manual: true }); }
    if (action === "cloud:export-mobile") {
      if (Object.keys(payload).length) throw new Error("手机连接参数无效");
      const value = await cloudSync.mobileConnection();
      const choice = await dialog.showSaveDialog(window, { title: "保存手机只读连接文件", defaultPath: "BUFF-手机连接.buffconnection", filters: [{ name: "BUFF 手机连接", extensions: ["buffconnection"] }] });
      if (choice.canceled) return { cancelled: true };
      await fs.writeFile(choice.filePath, JSON.stringify(value), { mode: 0o600 }); await fs.chmod(choice.filePath, 0o600);
      return { saved: true };
    }
    throw new Error("未开放的账户或云同步操作");
  } finally { pendingPlatformActions--; if (changingProfile) connectionChanging = false; }
}

function activeProfile() {
  const id = accountProfiles.snapshot().activeProfileId;
  return id ? accountProfiles.get(id) : null;
}
function updateSelectedPlatformAliases() {
  const buff = accountRuntime.selectedPlatform("buff"), uu = accountRuntime.selectedPlatform("uu"), steam = accountRuntime.selectedPlatform("steam");
  buffOrders = buff?.orders; buffSession = buff?.session;
  uuOrders = uu?.orders; uuSession = uu?.session;
  steamOrders = steam?.orders; steamSession = steam?.session;
}
function createOrderLedger() {
  const connection = configFile, id = activeProfile()?.id;
  orderLedger = new OrderLedgerService({ state, scope: profileScope(createHash("sha256").update(connection || "disconnected").digest("hex"), id),
    profile: activeProfile, request: route => ledgerRequest(connection, { path: route }) });
}
function startupSnapshot() {
  const runtime = accountRuntime.snapshot(), schedule = scheduler.snapshot();
  const phases = Object.values(runtime.platforms).map(item => item.phase);
  const status = !schedule.enabled ? "disabled" : schedule.status === "running" ? "running"
    : phases.some(phase => ["login-required", "account-mismatch", "failed", "attention", "unbound"].includes(phase)) ? "partial"
    : phases.every(phase => phase === "completed") ? "completed" : "idle";
  return { ...runtime, enabled: schedule.enabled, status, startedAt: schedule.lastStartedAt, endedAt: schedule.lastFinishedAt, schedule };
}
async function initialAccountOnboarding() {
  await accountProfiles.ready;
  if (smoke) {
    if (!activeProfile() && process.argv.includes("--order-ledger-fixture")) {
      const histories = Object.fromEntries(await Promise.all(["buff", "uu", "steam"].map(async platform => [platform, await ledgerRequest(configFile, { path: `/history/${platform}` })])));
      await accountProfiles.bootstrapExisting("account-1", histories);
    } else if (!activeProfile()) await accountProfiles.select("account-1");
    return;
  }
  const file = path.join(dataDir, "account-onboarding.json");
  let value;
  try { value = JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return; throw new Error("本机账户初始关联文件无效"); }
  if (value.version !== 1 || !["account-1", "account-2"].includes(value.profileId) || value.adoptExisting !== true) throw new Error("本机账户初始关联请求无效");
  const histories = Object.fromEntries(await Promise.all(["buff", "uu", "steam"].map(async platform => [platform, await ledgerRequest(configFile, { path: `/history/${platform}` })])));
  if (Object.values(histories).some(history => Object.keys(history.data.accounts).length > 1)) throw new Error("本机含多个平台账号，需分别核对后再关联");
  await accountProfiles.bootstrapExisting(value.profileId, histories);
  const csv = await ledgerRequest(configFile, { path: "/history/csv" });
  await accountProfiles.assignCsvScopes(value.profileId, [...new Set(csv.rows.map(row => row.scope))]);
  await fs.rename(file, file + ".applied");
}
async function createOrders() {
  scheduler?.stop(); cloudSync?.close(); await accountRuntime?.dispose();
  await accountProfiles.ready;
  accountRuntime = new AccountRuntime({ profiles: accountProfiles, enabled: !smoke || usingBuffFixture, notify: runtimeChanged,
    onSaved: async () => { cloudSync?.schedule(); },
    createPlatform({ profileId, platform, accountGuard, notify, onSessionChange }) {
      const makeSession = { buff: createBuffSession, uu: createUuSession, steam: createSteamSession }[platform];
      const platformSession = makeSession({ session, BrowserWindow, profileId, parent: () => window, onSessionChange });
      const legacy = platform === "buff" ? path.join(dataDir, "buff-orders.json") : null;
      const repository = new AccountScopedRepository({ repository: new HistoryRepository(configFile, legacy, platform), profiles: accountProfiles, profileId, platform });
      const Constructor = { buff: BuffOrders, uu: UuOrders, steam: SteamOrders }[platform];
      const fixture = platform === "buff" && usingBuffFixture;
      const orders = new Constructor({ repository, file: legacy, accountGuard, notify,
        fetcher: fixture ? require("../tests/fixtures/desktop-buff-orders.cjs") : (url, init) => platformSession.fetch(url, init), ...(fixture ? { interval: () => 0 } : {}) });
      return { orders, session: platformSession };
    } });
  await accountRuntime.ready; updateSelectedPlatformAliases(); createOrderLedger();
  const saved = await state.get("startupSync");
  scheduler = new SyncScheduler({ state, enabled: !smoke && saved.startupSync?.enabled !== false, notify: runtimeChanged,
    run: async () => { if (connectionChanging) return; await accountRuntime.syncSelected(); cloudSync?.schedule(); } });
  await scheduler.ready;
  startup = {
    ready: accountRuntime.ready, snapshot: startupSnapshot,
    async configure(value) {
      if (!value || Object.keys(value).some(key => key !== "enabled") || typeof value.enabled !== "boolean" || smoke && value.enabled) throw new Error("自动同步设置无效");
      await state.set({ startupSync: { enabled: value.enabled } }); scheduler.enabled = value.enabled;
      if (!value.enabled) await accountRuntime.cancel(); else await scheduler.start({ runOnStartup: false });
      scheduler.arm(); changed({ kind: "startup-sync", value: startupSnapshot() }); return startupSnapshot();
    },
    async start({ force = false } = {}) { void (force ? scheduler.trigger() : scheduler.start()).catch(error => log(error.message, "error")); return startupSnapshot(); },
    async cancel(platform) { await accountRuntime.cancel(undefined, platform); return startupSnapshot(); },
  };
  cloudSync = new CloudSync({ directory: dataDir, enabled: !smoke, currentProfile: activeProfile, canSync: () => !connectionChanging, notify: changed,
    buildSnapshot: async profile => {
      const snapshot = await orderLedger.read();
      if (activeProfile()?.id !== profile.id) throw new Error("终端账户已切换，本次上传已取消");
      const platforms = Object.fromEntries(Object.entries(accountRuntime.snapshot().platforms).map(([platform, item]) => [platform, {
        phase: item.phase, message: item.message, needsLogin: Boolean(item.needsLogin), verified: Boolean(item.verified),
        checkedAt: item.checkedAt, lastSyncedAt: item.lastSyncedAt, cooldownUntil: item.cooldownUntil || 0, count: item.count || 0,
      }]));
      return { id: profile.id, name: profile.name, bindings: profile.bindings, csvScopes: profile.csvScopes,
        input: snapshot.rawInput, options: scopeOptions(snapshot.options, snapshot.rawInput, profile), quotes: snapshot.quotes,
        pricingSettings: snapshot.pricingSettings, status: { platforms, schedule: scheduler.snapshot() } };
    } });
  await cloudSync.ready;
  if (!smoke && cloudSync.connection) {
    const current = cloudSync;
    void current.remoteProfiles().then(profiles => { if (cloudSync === current && !current.closed) return accountProfiles.reconcileRemoteProfiles(profiles); })
      .catch(error => { if (!current.closed) log(error.message, "error"); }).finally(() => current.schedule());
  }
}

function createWindow() {
  window = new BrowserWindow({ width: 1380, height: 900, minWidth: 1000, minHeight: 700, title: PRODUCT_NAME, backgroundColor: "#f5f7fc",
    titleBarStyle: "hiddenInset", trafficLightPosition: { x: 20, y: 23 }, icon: path.join(root, "desktop/assets/brand/app-icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (url !== APP_URL) event.preventDefault(); });
  window.webContents.on("will-frame-navigate", (event, details) => {
    const raw = typeof details === "string" ? details : event.url;
    if (!assetForUrl(raw)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.on("closed", () => { window = null; });
  window.loadURL(APP_URL);
  return window;
}

async function init() {
  if (process.argv.includes("--buff-orders-fixture") && (!smoke || app.isPackaged)) throw new Error("BUFF 模拟响应仅供未打包的本机 smoke 验收使用");
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  usingBuffFixture = smoke && !app.isPackaged && process.argv.includes("--buff-orders-fixture");
  const candidate = arg("--ledger-config");
  if (candidate) {
    configFile = path.resolve(candidate);
    await readConfig(configFile);
    await fs.writeFile(path.join(dataDir, "connection.json"), JSON.stringify({ configFile }), { mode: 0o600 });
  }
  else {
    try { configFile = JSON.parse(await fs.readFile(path.join(dataDir, "connection.json"), "utf8")).configFile; } catch {}
    if (!configFile && !app.isPackaged) {
      const local = path.join(root, ".ledger/config.json");
      try { await readConfig(local); configFile = local; await fs.writeFile(path.join(dataDir, "connection.json"), JSON.stringify({ configFile }), { mode: 0o600 }); } catch {}
    }
  }
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  // The main workspace remains offline. BUFF uses its own sandboxed session without a preload.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !assetForUrl(details.url) }));
  protocol.handle("buff-desktop", async request => {
    const file = assetForUrl(request.url);
    if (!file || request.method !== "GET") return new Response("未找到页面", { status: 404 });
    try {
      let body = await fs.readFile(path.join(root, file));
      if (file === "ledger.html") body = Buffer.from(body.toString().replace('<script src="common.js">', '<script src="desktop/ledger-bridge.js"></script><script src="common.js">'));
      const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png" }[path.extname(file)];
      return new Response(body, { headers: { "Content-Type": mime, "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" } });
    } catch { return new Response("页面加载失败", { status: 500 }); }
  });
  ipcMain.handle("buff-desktop:request", async (event, message) => {
    try {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== APP_URL) throw new Error("桌面请求来源无效");
      return { ok: true, result: await handle(message?.action, message?.payload) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: PRODUCT_NAME, submenu: [{ label: `关于${PRODUCT_NAME}`, role: "about" }, { type: "separator" }, { label: "隐藏窗口", role: "hide" }, { label: "退出", role: "quit" }] },
    { label: "编辑", submenu: [{ label: "撤销", role: "undo" }, { label: "重做", role: "redo" }, { type: "separator" }, { label: "剪切", role: "cut" }, { label: "复制", role: "copy" }, { label: "粘贴", role: "paste" }, { label: "全选", role: "selectAll" }] },
    { label: "窗口", submenu: [{ label: "最小化", role: "minimize" }, { label: "放大", role: "zoom" }, { label: "实际大小", role: "resetZoom" }, { label: "放大内容", role: "zoomIn" }, { label: "缩小内容", role: "zoomOut" }] },
  ]));
  app.setAboutPanelOptions({ applicationName: PRODUCT_NAME, applicationVersion: APP_VERSION, copyright: "交易有迹 · 收藏有数" });
  log("桌面后台已启动");
  if (smoke && !/^buff_goods_test_/.test((await readConfig(configFile)).database?.database || "")) throw new Error("界面验收需要隔离的 buff_goods_test_ 数据库");
  await ensureService();
  await initialAccountOnboarding();
  await createOrders();
  initialized = true;
  const win = createWindow();
  if (!smoke) {
    const icon = nativeImage.createFromPath(path.join(root, "desktop/assets/brand/trayTemplate.png")).resize({ width: 18, height: 18 });
    icon.setTemplateImage(true);
    tray = new Tray(icon); tray.setToolTip(`${PRODUCT_NAME} · 后台每六小时同步`);
    const show = () => { if (!window) createWindow(); if (window.isMinimized()) window.restore(); window.show(); window.focus(); };
    tray.setContextMenu(Menu.buildFromTemplate([{ label: `打开${PRODUCT_NAME}`, click: show }, { label: "立即同步当前账户", click: () => { void scheduler.trigger(); } }, { type: "separator" }, { label: "退出后台助手", click: () => app.quit() }]));
    tray.on("click", show);
    powerMonitor.on("resume", () => { void scheduler?.resume(); cloudSync?.schedule(); });
  }
  startup.start().catch(error => log(error.message, "error"));
  if (smoke) {
    let exitCode = 0;
    try { await require("./smoke.cjs").run(win, arg("--smoke-output") || path.join(root, ".desktop-output")); }
    catch (error) { console.error(error.stack); exitCode = 1; }
    probe.stop(); managedService?.kill(); app.exit(exitCode);
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (initialized) { if (!window) createWindow(); if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(init).catch(error => { dialog.showErrorBox("桌面助手启动失败", error.message); app.exit(1); });
  app.on("activate", () => { if (initialized && !window) createWindow(); });
  // Closing the workspace keeps the collector and menu-bar entry alive.
  app.on("window-all-closed", () => {});
  let quitting = false;
  app.on("before-quit", event => {
    if (quitting) return;
    event.preventDefault(); quitting = true; scheduler?.stop(); cloudSync?.close(); probe.stop();
    void (async () => { try { await accountRuntime?.dispose(); } finally { tray?.destroy(); managedService?.kill(); app.quit(); } })();
  });
}
