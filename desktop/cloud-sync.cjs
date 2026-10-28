"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const PROFILE_IDS = new Set(["account-1", "account-2"]);
const MAX_BYTES = 64 * 1024 * 1024;
const { normalizeBaseURL, DEFAULT_BASE_URL } = require("./cloud-endpoint.cjs");

function validateConnection(value) {
  if (!value || value.version !== 1 || !PROFILE_IDS.has(value.profileId)) throw new Error("终端连接文件的账户无效");
  const baseURL = normalizeBaseURL(value.baseURL);
  for (const key of ["ingestToken", "readToken"]) if (typeof value[key] !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(value[key])) throw new Error("终端连接凭据无效，请重新导入连接文件");
  if (value.ingestToken === value.readToken) throw new Error("查询与同步凭据必须不同");
  return { version: 1, profileId: value.profileId, baseURL, ingestToken: value.ingestToken, readToken: value.readToken };
}

async function atomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + ".tmp";
  const handle = await fs.open(temp, "w", 0o600);
  try { await handle.chmod(0o600); await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temp, file);
}
async function readJson(file, missing, maxBytes = 65536) {
  try { const stat = await fs.stat(file); if (!stat.isFile() || stat.size > maxBytes) throw new Error(); return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return missing; throw new Error("云同步本机状态无法读取，原文件已保留"); }
}
const object = value => value && typeof value === "object" && !Array.isArray(value);
function assertNoCredentials(value, depth = 0) {
  if (depth > 30) throw new Error("同步数据嵌套过深");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key) || /cookie|password|authorization|secret|token|private.?key|api.?key|sessionid|headers|csrf/i.test(key)) throw new Error("订单快照包含未允许的登录凭据字段，已停止上传");
    assertNoCredentials(child, depth + 1);
  }
}

class CloudSync {
  constructor({ directory, buildSnapshot, currentProfile, canSync = () => true, notify = () => {}, fetcher = fetch, now = Date.now, enabled = true, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { directory, buildSnapshot, currentProfile, canSync, notify, fetcher, now, enabled, setTimer, clearTimer });
    this.connectionFile = path.join(directory, "cloud-connection.json");
    this.stateFile = path.join(directory, "cloud-sync-state.json");
    this.pendingFile = path.join(directory, "cloud-pending.json");
    this.connection = null; this.pending = null; this.state = null; this.running = null; this.timer = null; this.closed = false; this.configuring = false; this.controllers = new Set();
    this.status = "idle"; this.error = ""; this.retryMs = 30000; this.requested = false;
    this.ready = this.load();
  }
  async load() {
    const connection = await readJson(this.connectionFile, null);
    if (connection) this.connection = validateConnection(connection);
    this.pending = await readJson(this.pendingFile, null, MAX_BYTES);
    this.state = await readJson(this.stateFile, null);
    if (!this.state && this.pending) throw new Error("设备状态缺失但仍有待上传记录，不能重新生成设备身份，请恢复原状态文件");
    this.state ||= { deviceId: randomUUID(), sequences: {}, uploads: {} };
    if (typeof this.state.deviceId !== "string" || !/^[a-f0-9-]{36}$/.test(this.state.deviceId) || !object(this.state.sequences) || !object(this.state.uploads)
      || Object.entries(this.state.sequences).some(([id, seq]) => !PROFILE_IDS.has(id) || !Number.isSafeInteger(seq) || seq < 0)
      || Object.entries(this.state.uploads).some(([id, upload]) => !PROFILE_IDS.has(id) || !object(upload) || !Number.isSafeInteger(upload.sequence) || upload.sequence < 1 || !Number.isFinite(Date.parse(upload.at)))) throw new Error("云同步设备状态无效，不能重置设备身份");
    if (this.pending && (this.pending.schemaVersion !== 1 || this.pending.deviceId !== this.state.deviceId || this.pending.profiles?.length !== 1 || !PROFILE_IDS.has(this.pending.profiles[0].id)
      || !Number.isSafeInteger(this.pending.sequence) || this.pending.sequence < 1 || !Number.isFinite(Date.parse(this.pending.collectedAt)))) throw new Error("待上传数据的设备、账户或序号不一致");
    if (this.pending) assertNoCredentials(this.pending);
    await atomic(this.stateFile, this.state);
    this.error = this.state.blocked?.message || "";
    this.status = this.connection ? this.state.blocked ? "attention" : this.pending ? "pending" : "idle" : "unconfigured";
  }
  snapshot() {
    const profileId = this.connection?.profileId || null, upload = this.state?.uploads?.[profileId];
    return { configured: Boolean(this.connection), enabled: this.enabled, profileId, baseURL: this.connection?.baseURL || DEFAULT_BASE_URL,
      status: this.status, pending: Boolean(this.pending), paused: Boolean(this.state?.blocked), lastUploadedAt: upload?.at || null,
      lastSequence: upload?.sequence || null, error: this.error, running: Boolean(this.running) };
  }
  emit() { this.notify({ kind: "cloud-sync", value: this.snapshot() }); }
  async importConnection(value) {
    if (this.configuring) throw new Error("正在导入云端连接，请稍后重试");
    this.configuring = true;
    try {
      await this.ready;
      if (this.running) throw new Error("请等待当前同步完成后更换连接凭据");
      const next = validateConnection(value), profile = await this.currentProfile();
      if (!profile || next.profileId !== profile.id) throw new Error("连接文件与当前终端关联账户不一致");
      if (this.pending && this.pending.profiles[0].id !== next.profileId) throw new Error("待上传记录属于另一账户，请先处理该批记录，不能切换归属");
      if (this.pending && this.connection && this.connection.baseURL !== next.baseURL) throw new Error("仍有待上传记录，请先在原服务器完成该批记录，再切换服务器");
      // Credential rotation is allowed for the same owner; its durable batch stays intact.
      await atomic(this.connectionFile, next); this.connection = next; delete this.state.blocked; await atomic(this.stateFile, this.state);
      this.error = ""; this.status = this.pending ? "pending" : "idle"; this.emit(); return this.snapshot();
    } finally { this.configuring = false; }
  }
  async remoteProfiles() {
    await this.ready;
    if (!this.connection) return null;
    const result = await this.request("/v1/profiles", { token: this.connection.readToken });
    return result.profiles;
  }
  async request(route, { token, body } = {}) {
    if (this.closed) throw new Error("云同步已停止");
    let response; const controller = new AbortController(); this.controllers.add(controller);
    try {
    try {
      response = await this.fetcher(this.connection.baseURL + route, { method: body ? "POST" : "GET", redirect: "error",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
        ...(body ? { body } : {}), signal: AbortSignal.any([AbortSignal.timeout(90000), controller.signal]) });
    } catch { throw Object.assign(new Error("云端连接失败，数据已留在本机等待重试"), { retryable: !this.closed }); }
    let data;
    try { data = await response.json(); } catch { if (response.ok) throw Object.assign(new Error("云端响应无法识别，待上传记录已保留"), { retryable: true }); }
    if (!response.ok || data?.ok !== true) {
      const safe = { 401: "云端连接凭据失效，请重新导入连接文件", 403: "该终端无权写入此账户，已停止上传", 409: "云端账户归属或数据版本冲突，已停止上传，请检查关联账户", 413: "归档超出本次上传上限，原数据保留", 429: "云端请求频繁，稍后自动重试" };
      const retry = response.headers?.get?.("Retry-After"), retryAfterMs = /^\d+$/.test(retry || "") ? Number(retry) * 1000 : Date.parse(retry) - this.now();
      throw Object.assign(new Error(safe[response.status] || "云端保存失败，待上传记录已保留"), { retryable: response.status >= 500 || response.status === 429,
        retryAfterMs: Number.isFinite(retryAfterMs) ? Math.max(0, Math.min(retryAfterMs, 86400000)) : 0, code: /^[A-Z0-9_]{1,80}$/.test(data?.code || "") ? data.code : "CLOUD_REQUEST_FAILED" });
    }
    return data.result;
    } finally { this.controllers.delete(controller); }
  }
  schedule(delay = 1500) {
    if (!this.enabled || this.closed || this.configuring || this.state?.blocked) return;
    this.requested = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; this.sync({ automatic: true }).catch(() => {}); }, delay);
    this.timer?.unref?.();
  }
  sync({ automatic = false } = {}) {
    if (this.running) { this.requested = true; return this.running; }
    this.running = this.run({ automatic }).finally(() => { this.running = null; this.emit(); });
    return this.running;
  }
  async assertCurrent(profileId) {
    if (this.closed) throw new Error("云同步已停止");
    if (!this.canSync()) throw Object.assign(new Error("本机连接正在切换，云同步稍后重试"), { retryable: true });
    const current = await this.currentProfile();
    if (current?.id !== profileId || this.connection?.profileId !== profileId) throw new Error("账户关联已切换，原待上传记录保留，未发送到其他账户");
  }
  async run({ automatic = false } = {}) {
    await this.ready;
    if (!this.enabled || this.closed || this.configuring || automatic && this.state.blocked) return this.snapshot();
    if (!this.canSync()) { this.schedule(5000); return this.snapshot(); }
    if (!automatic && this.state.blocked) { delete this.state.blocked; await atomic(this.stateFile, this.state); }
    this.requested = false;
    const profile = await this.currentProfile();
    if (!this.connection) { this.status = "unconfigured"; this.emit(); return this.snapshot(); }
    if (!profile || profile.id !== this.connection.profileId) { this.status = "account-mismatch"; this.error = "请为当前终端选择与云连接文件相同的账户"; this.emit(); return this.snapshot(); }
    try {
      this.status = "uploading"; this.error = ""; this.emit();
      // Recover the exact last batch first. A lost response never discards it.
      if (this.pending) await this.uploadPending();
      await this.assertCurrent(profile.id);
      const snapshot = await this.buildSnapshot(profile);
      if (!snapshot || snapshot.id !== profile.id) throw new Error("导出的账户与当前终端不一致");
      assertNoCredentials(snapshot); await this.assertCurrent(profile.id);
      const nextSequence = (this.state.sequences[profile.id] || 0) + 1;
      this.state.sequences[profile.id] = nextSequence;
      await atomic(this.stateFile, this.state);
      const envelope = { schemaVersion: 1, deviceId: this.state.deviceId, sequence: nextSequence, collectedAt: new Date(this.now()).toISOString(), profiles: [snapshot] };
      if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_BYTES) throw new Error("订单归档超过云同步上限，未截断或删除原始数据");
      await atomic(this.pendingFile, envelope); this.pending = envelope;
      await this.uploadPending();
      this.status = "synced"; this.retryMs = 30000; delete this.state.blocked;
      if (this.requested) this.schedule();
      return this.snapshot();
    } catch (error) {
      this.status = error.retryable || this.closed ? "pending" : "attention"; this.error = this.closed ? "" : error.message;
      if (!this.closed && !error.retryable) { this.state.blocked = { message: this.error, code: error.code || "SYNC_ATTENTION", at: new Date(this.now()).toISOString() }; await atomic(this.stateFile, this.state); }
      if (error.retryable && !this.closed) { this.schedule(Math.max(this.retryMs, error.retryAfterMs || 0)); this.retryMs = Math.min(this.retryMs * 2, 15 * 60000); }
      throw error;
    } finally { this.emit(); }
  }
  async uploadPending() {
    const pending = this.pending;
    if (pending.profiles[0].id !== this.connection.profileId) throw new Error("待上传记录属于另一账户，已停止上传");
    await this.assertCurrent(pending.profiles[0].id);
    const receipt = await this.request("/v1/sync", { token: this.connection.ingestToken, body: JSON.stringify(pending) });
    if (receipt?.profileId !== pending.profiles[0].id || receipt.deviceId !== pending.deviceId || receipt.sequence !== pending.sequence) throw Object.assign(new Error("云端确认与待上传批次不一致，原数据保留等待核对"), { retryable: false });
    this.state.uploads[this.connection.profileId] = { sequence: pending.sequence, at: typeof receipt.uploadedAt === "string" && Number.isFinite(Date.parse(receipt.uploadedAt)) ? receipt.uploadedAt : new Date(this.now()).toISOString() };
    this.state.sequences[this.connection.profileId] = Math.max(this.state.sequences[this.connection.profileId] || 0, pending.sequence);
    await atomic(this.stateFile, this.state);
    await fs.unlink(this.pendingFile); this.pending = null;
  }
  async mobileConnection() {
    await this.ready;
    if (!this.connection) throw new Error("请先导入本机云端连接文件");
    return { version: 1, baseURL: this.connection.baseURL, accessToken: this.connection.readToken };
  }
  close() { this.closed = true; if (this.timer) this.clearTimer(this.timer); for (const controller of this.controllers) controller.abort(); }
}

module.exports = { CloudSync, validateConnection, DEFAULT_BASE_URL };
