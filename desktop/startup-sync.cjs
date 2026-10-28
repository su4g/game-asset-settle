"use strict";

const LABELS = { buff: "BUFF", uu: "悠悠", steam: "Steam" };
const interrupted = () => Object.assign(new Error("启动自动同步已停止"), { code: "STARTUP_CANCELLED" });
const latestSync = runs => (runs || []).filter(run => run.channel === "history" && Number.isFinite(Date.parse(run.syncedAt))).map(run => run.syncedAt).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;

// Coordinates the existing read-only importers. It never owns platform tokens,
// creates a login window, or writes confirmed ledger transactions.
class StartupSync {
  constructor({ state, platforms, notify = () => {}, enabled = true, now = Date.now }) {
    this.state = state; this.platforms = platforms; this.notify = notify; this.now = now;
    this.allowed = enabled !== false; this.enabled = this.allowed;
    this.status = this.allowed ? "idle" : "disabled";
    this.startedAt = null; this.endedAt = null; this.running = null; this.didStart = false; this.revision = 0;
    this.contexts = {}; this.progress = Object.fromEntries(Object.keys(platforms).map(name => [name, { phase: "idle", message: "等待启动校验", checkedAt: null }]));
    this.ready = this.load();
  }
  async load() {
    const saved = await this.state.get("startupSync");
    this.enabled = this.allowed && saved.startupSync?.enabled !== false;
    if (!this.enabled) this.status = "disabled";
  }
  snapshot() {
    const platforms = {};
    for (const [name, { orders }] of Object.entries(this.platforms)) {
      const value = orders.snapshot();
      platforms[name] = { ...this.progress[name], account: value.account, verified: value.verified,
        count: value.count, lastSyncedAt: latestSync(value.runs), runs: value.runs,
        cooldownUntil: value.cooldownUntil || 0, job: value.job, ...(name === "uu" ? { sellProbe: value.sellProbe } : {}) };
    }
    return { enabled: this.enabled, status: this.status, startedAt: this.startedAt, endedAt: this.endedAt, platforms };
  }
  emit() { this.notify({ kind: "startup-sync", value: this.snapshot() }); }
  update(name, changes) { this.progress[name] = { ...this.progress[name], ...changes }; this.emit(); }
  async configure(value) {
    if (!value || Object.keys(value).some(key => key !== "enabled") || typeof value.enabled !== "boolean") throw new Error("启动同步设置无效");
    if (!this.allowed && value.enabled) throw new Error("本机验收模式不允许启动平台同步");
    await this.ready;
    await this.state.set({ startupSync: { enabled: value.enabled } });
    this.enabled = this.allowed && value.enabled;
    if (!this.enabled) { await this.cancel(); this.status = "disabled"; }
    else if (this.status === "disabled") this.status = "idle";
    this.emit(); return this.snapshot();
  }
  async start({ force = false } = {}) {
    const revision = this.revision;
    await this.ready;
    if (revision !== this.revision || this.running || this.didStart && !force) return this.snapshot();
    if (!this.enabled) { this.status = "disabled"; this.emit(); return this.snapshot(); }
    this.didStart = true; this.status = "running"; this.startedAt = this.now(); this.endedAt = null;
    const names = Object.keys(this.platforms);
    for (const name of names) {
      this.contexts[name] = { cancelled: false, owned: false, task: null };
      this.progress[name] = { phase: "waiting", message: "等待账户校验", checkedAt: null };
    }
    // Publish the running promise before entering an importer, so cancellation
    // and repeated start calls always observe this same launch.
    this.running = Promise.resolve().then(async () => {
      await Promise.all(names.map(name => {
        const context = this.contexts[name];
        context.task = this.runPlatform(name, context);
        return context.task;
      }));
      const phases = names.map(name => this.progress[name].phase);
      this.status = phases.every(phase => phase === "completed") ? "completed" : phases.every(phase => phase === "cancelled") ? "cancelled" : "partial";
      this.endedAt = this.now();
    }).finally(() => { this.running = null; this.emit(); });
    this.emit(); return this.snapshot();
  }
  assertActive(context) { if (context.cancelled) throw interrupted(); }
  async runJob(name, context, options, phase, message) {
    this.assertActive(context);
    const { orders, session } = this.platforms[name];
    session.close();
    this.update(name, { phase, message });
    this.assertActive(context);
    context.owned = true;
    try { await orders.start(options); await orders.running; }
    finally { context.owned = false; }
    this.assertActive(context);
    const result = orders.snapshot();
    if (result.job.status !== "completed") throw new Error(result.job.message || `${LABELS[name]} 同步未完成`);
    return result;
  }
  async runPlatform(name, context) {
    const { orders, session } = this.platforms[name], label = LABELS[name];
    try {
      await orders.ready;
      this.assertActive(context);
      if (orders.running || orders.checking) { this.update(name, { phase: "busy", message: `${label} 已有手动查询，跳过本次自动同步` }); return; }
      session.close();
      const present = await session.hasSession();
      this.assertActive(context);
      const account = orders.snapshot().account;
      const knownAccount = typeof account?.id === "string" && account.id.startsWith(name + ":") && /^[^\s:]+$/.test(account.id.slice(name.length + 1));
      // Cookie presence is only a fast hint. A cached account may still have a
      // valid server session that this local precheck cannot identify.
      if (!present && !knownAccount) { this.update(name, { phase: "login-required", message: `请先在 App 中登录 ${label}，历史记录仍可查看` }); return; }
      this.update(name, { phase: "checking", message: `正在校验 ${label} 当前账户` });
      this.assertActive(context);
      context.owned = true;
      try { await orders.check(); }
      finally { context.owned = false; }
      this.assertActive(context);
      if (!orders.snapshot().verified) throw Object.assign(new Error(`${label} 账户尚未通过校验，请重新登录`), { code: "ACCOUNT_NOT_VERIFIED" });
      this.update(name, { checkedAt: this.now() });
      if (name === "buff") {
        await this.runJob(name, context, { appid: "all", direction: "all", channel: "history", mode: "incremental" }, "syncing", "正在增量同步 BUFF 买卖历史");
      } else if (name === "steam") {
        await this.runJob(name, context, { mode: "incremental" }, "syncing", "正在增量同步 Steam 市场买卖历史");
      } else {
        let value = await this.runJob(name, context, { direction: "buy", mode: "incremental" }, "syncing", "正在增量同步悠悠买入历史");
        if (value.sellProbe?.status !== "verified") { this.update(name, { phase: "attention", message: "买入历史已同步；当前悠悠账号的卖出历史待只读验证" }); return; }
        value = await this.runJob(name, context, { direction: "sell", probe: true }, "verifying-sell", "正在重新核对悠悠当前账号的卖出样本");
        if (value.sellProbe?.status !== "verified") { this.update(name, { phase: "attention", message: "买入历史已同步；本次未取得有效卖出样本，未执行卖出同步" }); return; }
        await this.runJob(name, context, { direction: "sell", mode: "incremental" }, "syncing", "正在增量同步悠悠卖出历史");
      }
      this.update(name, { phase: "completed", message: "账户已校验，最新历史已同步" });
    } catch (error) {
      this.update(name, context.cancelled || error.code === "STARTUP_CANCELLED"
        ? { phase: "cancelled", message: "已停止启动自动同步，原历史保留" }
        : { phase: error.code === "ACCOUNT_NOT_VERIFIED" || /登录失效|重新登录|请先登录|先在 App.*登录|未识别到唯一|需要验证/.test(error.message) ? "login-required" : "failed", message: error.message });
    }
  }
  async cancel(name) {
    if (name != null && !Object.hasOwn(this.platforms, name)) throw new Error("启动同步平台无效");
    this.revision++;
    const names = name == null ? Object.keys(this.platforms) : [name], tasks = [];
    for (const key of names) {
      const context = this.contexts[key];
      if (!context) continue;
      context.cancelled = true;
      if (context.owned) this.platforms[key].orders.stop();
      if (context.task) tasks.push(context.task);
    }
    await Promise.all(tasks);
    if (name == null && this.running) await this.running;
    return this.snapshot();
  }
}

module.exports = { StartupSync, latestSync };
