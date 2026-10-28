"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const APP_URL = "buff-desktop://app/desktop/index.html";
const PUBLIC_FILES = new Set([
  "/desktop/index.html", "/desktop/app.css", "/desktop/app.js", "/desktop/ledger-bridge.js",
  "/desktop/pricing.js", "/desktop/price-state.js", "/desktop/order-ledger-ui.js", "/desktop/profit-report-ui.js", "/desktop/alchemy-ui.js", "/desktop/report-analytics.js", "/desktop/report-charts.js",
  "/desktop/market-history.js", "/desktop/market-history-ui.js", "/desktop/dota2-names.js",
  "/desktop/buff-orders-ui.js", "/desktop/uu-orders-ui.js", "/desktop/steam-orders-ui.js",
  "/desktop/account-cloud-ui.js",
  "/desktop/design-system.css", "/desktop/brand-ui.js",
  "/desktop/assets/brand/mark.png", "/desktop/assets/brand/app-icon.png",
  "/desktop/assets/platforms/buff.png", "/desktop/assets/platforms/uu.png", "/desktop/assets/platforms/steam.png",
  "/ledger.html", "/ledger.css", "/ledger-ui.js", "/buy-sync-ui.js", "/common.js", "/icon128.png",
]);
const STORAGE_KEYS = new Set(["ledgerViewCache", "ledgerTargetRatio", "calculatorDraft", "priceWorkspace", "historyNames", "orderLedger", "startupSync", "accountProfiles", "syncSchedule"]);
const LIMIT = 2 * 1024 * 1024;
const ID = "[0-9a-f-]{36}";
const ROUTES = {
  GET: [new RegExp(`^/(health|summary|series|trades|holdings|tasks|wallet-events|migration-issues)$`), new RegExp(`^/(trades|tasks)/${ID}$`), /^\/history\/(buff|uu|steam|csv|names)$/],
  POST: [/^\/(trades|wallet-events)$/, /^\/sync\/(?:buys\/)?(?:preview|confirm)$/, new RegExp(`^/trades/${ID}/(settlements|refunds)$`), /^\/history\/(buff|uu|steam|csv|names)$/],
  PATCH: [new RegExp(`^/(trades|settlements|wallet-events)/${ID}$`)],
};

function assetForUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "buff-desktop:" || url.host !== "app" || url.username || url.password) return null;
    return PUBLIC_FILES.has(url.pathname) ? url.pathname.slice(1) : null;
  } catch { return null; }
}

function validateRequest(message) {
  if (!message || typeof message.path !== "string" || !message.path.startsWith("/") || message.path.startsWith("//")) throw new Error("账本请求地址无效");
  const url = new URL(message.path, "http://127.0.0.1");
  const method = message.method || "GET";
  if (url.origin !== "http://127.0.0.1" || url.hash || !ROUTES[method]?.some(rule => rule.test(url.pathname))) throw new Error("此桌面预览未开放该操作");
  if (method !== "GET" && (!message.body || typeof message.body !== "object" || Array.isArray(message.body))) throw new Error("账本请求需要完整表单");
  const body = method === "GET" ? undefined : JSON.stringify(message.body);
  if (body && Buffer.byteLength(body) > (["/history/buff", "/history/uu", "/history/steam", "/history/csv"].includes(url.pathname) ? 40 * 1024 * 1024 : LIMIT)) throw new Error("账本请求过大");
  return { path: url.pathname + url.search, method, body };
}

async function readConfig(file) {
  if (!file) throw Object.assign(new Error("尚未连接账本，请选择现有 .ledger/config.json"), { code: "NO_CONFIG" });
  let config;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error();
    config = JSON.parse(await fs.readFile(file, "utf8"));
  } catch { throw new Error("账本配置无法读取，请重新选择现有配置文件"); }
  const port = config.port ?? 3217;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof config.token !== "string" || !/^[A-Za-z0-9_-]{16,256}$/.test(config.token)) throw new Error("账本配置中的本机端口或配对信息无效");
  return { ...config, port };
}

async function ledgerRequest(configFile, message, fetcher = fetch) {
  const request = validateRequest(message);
  const config = await readConfig(configFile);
  let response;
  try {
    response = await fetcher(`http://127.0.0.1:${config.port}/v1${request.path}`, {
      method: request.method,
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(request.path.startsWith("/history/") ? 60000 : 8000), redirect: "error",
    });
  } catch (error) {
    const refused = error.cause?.code === "ECONNREFUSED";
    throw Object.assign(new Error(refused ? "本机账本服务尚未运行" : "本机账本连接失败或超时，请检查服务状态"), { code: refused ? "LEDGER_UNREACHABLE" : "LEDGER_CONNECTION" });
  }
  let data;
  try { data = await response.json(); } catch { throw new Error("本机账本返回了无法识别的数据"); }
  if (!response.ok || data?.ok !== true) throw new Error(data?.error || `账本请求失败（${response.status}）`);
  return data.result;
}

class LocalState {
  constructor(file) { this.file = file; this.pending = Promise.resolve(); }
  async read() {
    await this.pending;
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8"));
      return Object.fromEntries(Object.entries(data).filter(([key]) => STORAGE_KEYS.has(key)));
    } catch (error) { if (error.code === "ENOENT") return {}; throw new Error("桌面偏好无法读取，请检查本机数据文件"); }
  }
  async get(keys) {
    const names = typeof keys === "string" ? [keys] : keys;
    if (!Array.isArray(names) || names.some(key => !STORAGE_KEYS.has(key))) throw new Error("未开放的本机偏好");
    const saved = await this.read();
    return Object.fromEntries(names.filter(key => Object.hasOwn(saved, key)).map(key => [key, saved[key]]));
  }
  set(values) {
    if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).some(key => !STORAGE_KEYS.has(key))) return Promise.reject(new Error("未开放的本机偏好"));
    const copy = JSON.parse(JSON.stringify(values));
    if (Buffer.byteLength(JSON.stringify(copy)) > LIMIT) return Promise.reject(new Error("本机偏好数据过大"));
    const write = async () => {
      let saved = {};
      try { saved = JSON.parse(await fs.readFile(this.file, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw new Error("桌面偏好无法读取，原文件已保留"); }
      const next = { ...saved, ...copy };
      const serialized = JSON.stringify(next);
      if (Buffer.byteLength(serialized) > LIMIT) throw new Error("本机偏好数据过大");
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await fs.writeFile(this.file + ".tmp", serialized, { mode: 0o600 });
      await fs.rename(this.file + ".tmp", this.file);
      return Object.fromEntries(Object.entries(copy).map(([key, value]) => [key, { oldValue: saved[key], newValue: value }]));
    };
    const result = this.pending.then(write);
    this.pending = result.catch(() => {});
    return result;
  }
}

class BackgroundProbe {
  constructor(check, notify = () => {}, { interval = 5000, steps = 6 } = {}) {
    this.check = check; this.notify = notify; this.interval = interval; this.steps = steps;
    this.runId = 0; this.timer = null;
    this.state = { status: "idle", completed: 0, total: steps, successes: 0 };
  }
  snapshot() { return { ...this.state }; }
  start() {
    if (this.state.status === "running") return this.snapshot();
    const id = ++this.runId;
    this.state = { status: "running", completed: 0, total: this.steps, successes: 0, startedAt: Date.now(), issue: "" };
    this.notify(this.snapshot());
    const tick = async () => {
      let issue = "";
      try { await this.check(); } catch (error) { issue = error.message; }
      if (id !== this.runId) return;
      this.state.completed++;
      if (!issue) this.state.successes++;
      this.state.issue = issue;
      if (this.state.completed === this.steps) this.state.status = this.state.successes === this.steps ? "completed" : "failed";
      this.notify(this.snapshot());
      if (this.state.status === "running") this.timer = setTimeout(tick, this.interval);
    };
    this.timer = setTimeout(tick, this.interval);
    return this.snapshot();
  }
  stop() {
    this.runId++; clearTimeout(this.timer);
    if (this.state.status === "running") { this.state.status = "cancelled"; this.notify(this.snapshot()); }
    return this.snapshot();
  }
}

module.exports = { APP_URL, PUBLIC_FILES, assetForUrl, validateRequest, readConfig, ledgerRequest, LocalState, BackgroundProbe };
