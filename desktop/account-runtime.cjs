"use strict";

const { PLATFORMS } = require("./account-profiles.cjs");
const { latestSync } = require("./startup-sync.cjs");
const cancelled = () => Object.assign(new Error("当前账户同步已停止，原历史保留"), { code: "SYNC_CANCELLED" });
const authFailure = error => ["ACCOUNT_MISMATCH", "ACCOUNT_IN_USE"].includes(error?.code) ? "account-mismatch"
  : /账号.*不一致|已关联另一个账户组/.test(error?.message || "") ? "account-mismatch"
  : /登录失效|登录已失效|重新登录|请先登录|先在 App.*登录|未识别到唯一|会话需要|登录窗口完成|登录.*需要验证|登录.*访问受限/.test(error?.message || "") ? "login-required" : "failed";

// One terminal owns one selected profile. Contexts are retained only to keep
// each profile's sessions and data isolated when the user explicitly switches.
class AccountRuntime {
  constructor({ profiles, createPlatform, notify = () => {}, onSaved = async () => {}, enabled = true, now = Date.now }) {
    this.profiles = profiles; this.createPlatform = createPlatform; this.notify = notify; this.onSaved = onSaved; this.enabled = enabled;
    this.now = now; this.contexts = new Map(); this.changing = false; this.disposed = false; this.syncing = null;
    this.ready = profiles.ready.then(() => this.ensureSelected());
  }
  async ensureSelected() {
    const id = this.profiles.snapshot().activeProfileId;
    if (!id) return null;
    if (!this.contexts.has(id)) {
      const context = { profileId: id, platforms: {} }; this.contexts.set(id, context);
      for (const platform of PLATFORMS) {
        const entry = { profileId: id, platform, phase: "idle", message: "等待同步", checkedAt: null, operation: null, control: null, needsLogin: false, allowBinding: false };
        context.platforms[platform] = entry;
        const instance = await this.createPlatform({ profileId: id, platform,
          accountGuard: account => this.profiles.assertAccount(id, platform, account.id, { allowUnbound: entry.allowBinding }),
          notify: event => this.notify({ ...event, profileId: id, platform }),
          onSessionChange: () => this.sessionChanged(id, platform) });
        Object.assign(entry, instance);
        if (!entry.orders || !entry.session) throw new Error("平台账户运行器缺少会话或订单模块");
        entry.orders.ready.catch(() => {});
      }
    }
    return this.contexts.get(id);
  }
  selectedPlatform(platform) {
    return this.contexts.get(this.profiles.snapshot().activeProfileId)?.platforms[platform] || null;
  }
  platformSnapshot(entry) {
    if (!entry?.orders) return { phase: "unbound", message: "请先关联本机所属账户", account: null, verified: false, count: 0, runs: [] };
    const snapshot = entry.orders.snapshot();
    return { ...snapshot, profileId: entry.profileId, binding: this.profiles.binding(entry.profileId, entry.platform),
      phase: entry.phase, message: entry.message, checkedAt: entry.checkedAt, lastSyncedAt: latestSync(snapshot.runs), needsLogin: entry.needsLogin };
  }
  snapshot() {
    const profiles = this.profiles.snapshot();
    const currentPlatformStates = Object.fromEntries(PLATFORMS.map(platform => [platform, this.platformSnapshot(this.selectedPlatform(platform))]));
    return { ...profiles, enabled: this.enabled && !this.disposed, status: this.syncing ? "running" : profiles.activeProfileId ? "idle" : "unbound",
      currentPlatformStates, platforms: currentPlatformStates };
  }
  update(entry, phase, message) {
    entry.phase = phase; entry.message = message;
    if (["login-required", "account-mismatch"].includes(phase)) entry.needsLogin = true;
    this.notify({ kind: "account-runtime", profileId: entry.profileId, platform: entry.platform, value: this.snapshot() });
  }
  assertActive(entry, control) {
    if (this.disposed || control.cancelled || entry.profileId !== this.profiles.snapshot().activeProfileId) throw cancelled();
  }
  async refresh(entry) {
    await entry.orders.ready;
    const verifiedAccount = entry.orders.verified ? entry.orders.account : null;
    await entry.orders.load();
    if (!entry.orders.account && verifiedAccount?.id === this.profiles.binding(entry.profileId, entry.platform)) entry.orders.account = verifiedAccount;
  }
  begin(entry, automatic, task) {
    if (entry.operation) throw new Error("此平台已有同步或登录操作，请稍后重试");
    const control = { automatic, cancelled: false }; entry.control = control;
    const operation = Promise.resolve().then(() => task(control)).catch(error => {
      this.update(entry, control.cancelled || error.code === "SYNC_CANCELLED" ? "cancelled" : authFailure(error), error.message);
      throw error;
    }).finally(() => { if (entry.operation === operation) { entry.operation = null; entry.control = null; } });
    entry.operation = operation; return operation;
  }
  async cancel(profileId, platform) {
    const entries = [...this.contexts.values()].filter(item => profileId == null || item.profileId === profileId)
      .flatMap(item => Object.values(item.platforms)).filter(item => platform == null || item.platform === platform);
    const tasks = [];
    for (const entry of entries) {
      if (entry.control) entry.control.cancelled = true;
      entry.orders?.stop();
      if (entry.operation) tasks.push(entry.operation.catch(() => {}));
    }
    await Promise.all(tasks);
    return this.snapshot();
  }
  sessionChanged(profileId, platform) {
    if (this.disposed) return;
    const entry = this.contexts.get(profileId)?.platforms[platform];
    if (!entry?.orders) return;
    if (entry.control) entry.control.cancelled = true;
    entry.orders.stop(); entry.orders.verified = false; entry.orders.emit();
    this.update(entry, "login-required", "登录状态已变化，请在本机重新检查登录认证");
  }
  async select(profileId) {
    await this.ready;
    if (this.changing) throw new Error("正在切换终端关联账户");
    this.changing = true;
    try {
      await this.cancel();
      for (const context of this.contexts.values()) for (const entry of Object.values(context.platforms)) entry.session?.close();
      await this.profiles.select(profileId); await this.ensureSelected();
      return this.snapshot();
    } finally { this.changing = false; }
  }
  async checked(entry, control, allowBinding) {
    this.assertActive(entry, control); entry.session.close();
    this.update(entry, "checking", "正在校验当前平台账号与账户关联");
    entry.allowBinding = allowBinding;
    let result;
    try { result = await entry.orders.check(); } finally { entry.allowBinding = false; }
    this.assertActive(entry, control);
    if (!result.verified || !result.account?.id) throw new Error("账户尚未通过登录认证，请重新登录");
    if (allowBinding) await this.profiles.bind(entry.profileId, entry.platform, result.account.id);
    this.profiles.assertAccount(entry.profileId, entry.platform, result.account.id);
    this.assertActive(entry, control); entry.checkedAt = this.now(); entry.needsLogin = false;
    await this.refresh(entry); this.update(entry, "ready", "账号已校验，账户关联正确");
    return this.platformSnapshot(entry);
  }
  async job(entry, control, options, inventory = false) {
    this.assertActive(entry, control); entry.session.close();
    this.profiles.assertAccount(entry.profileId, entry.platform, entry.orders.account?.id);
    this.update(entry, "syncing", "正在增量同步本人订单");
    await (inventory ? entry.orders.startInventory(options) : entry.orders.start(options)); await entry.orders.running;
    this.assertActive(entry, control);
    const result = entry.orders.snapshot();
    if (result.job.status !== "completed") throw new Error(result.job.message || "订单同步未完成，原历史保留");
    await this.onSaved({ profileId: entry.profileId, platform: entry.platform, snapshot: result });
    return result;
  }
  async syncPlatform(entry) {
    if (!this.profiles.binding(entry.profileId, entry.platform)) { this.update(entry, "unbound", "尚未关联平台账号，请在本机登录后检查认证"); return; }
    if (entry.operation) return;
    if (entry.session.isOpen?.()) { this.update(entry, "attention", "登录窗口正在使用，完成后检查登录再同步"); return; }
    if (entry.needsLogin) return;
    return this.begin(entry, true, async control => {
      await this.refresh(entry); await this.checked(entry, control, false);
      if (entry.platform === "buff") await this.job(entry, control, { appid: "all", direction: "all", channel: "history", mode: "incremental" });
      else if (entry.platform === "steam") {
        await this.job(entry, control, { mode: "incremental" });
        if (entry.orders.snapshot().inventory) await this.job(entry, control, { mode: "incremental" }, true);
      }
      else {
        let result = await this.job(entry, control, { direction: "buy", mode: "incremental" });
        if (result.sellProbe?.status !== "verified") { this.update(entry, "attention", "买入已同步；卖出尚需在本机验证完成样本"); return; }
        result = await this.job(entry, control, { direction: "sell", probe: true });
        if (result.sellProbe?.status !== "verified") { this.update(entry, "attention", "买入已同步；卖出样本未通过本次验证"); return; }
        await this.job(entry, control, { direction: "sell", mode: "incremental" });
      }
      this.update(entry, "completed", "本账户最新订单已同步");
    }).catch(() => {});
  }
  async syncSelected() {
    await this.ready;
    if (!this.enabled || this.disposed || this.changing || this.syncing) return this.snapshot();
    const task = Promise.resolve().then(async () => {
      const context = await this.ensureSelected();
      if (!context) return;
      for (const platform of PLATFORMS) {
        if (this.disposed || this.changing || context.profileId !== this.profiles.snapshot().activeProfileId) break;
        await this.syncPlatform(context.platforms[platform]);
      }
    }).finally(() => { if (this.syncing === task) this.syncing = null; });
    this.syncing = task; await task; return this.snapshot();
  }
  async manual(platform, action, payload) {
    await this.ready;
    if (this.disposed || this.changing) throw new Error("账户运行器正在切换或退出");
    const entry = (await this.ensureSelected())?.platforms[platform];
    if (!entry) throw new Error("请先选择本机终端关联的账户");
    if (action === "status") return this.platformSnapshot(entry);
    if (action === "list" || action === "collect") { await entry.orders.ready; return entry.orders[action](payload); }
    if (action === "stop") { await this.cancel(entry.profileId, platform); return this.platformSnapshot(entry); }
    if (!["login", "logout", "check", "start", "probe-sell", "inventory"].includes(action)) throw new Error("未开放的账户操作");
    if (!this.enabled && !["logout"].includes(action)) throw new Error("本机验收模式不访问真实交易平台");
    if (entry.operation && entry.control?.automatic) await this.cancel(entry.profileId, platform);
    let started;
    const launch = ["start", "probe-sell", "inventory"].includes(action);
    if (action === "inventory" && platform !== "steam") throw new Error("库存历史仅支持 Steam");
    const readyToReturn = launch ? new Promise((resolve, reject) => { started = { resolve, reject }; }) : null;
    const task = this.begin(entry, false, async control => {
      await this.refresh(entry); this.assertActive(entry, control);
      if (action === "login") { await entry.orders.invalidate(); this.update(entry, "login-required", "请在官方窗口登录，再返回检查认证"); return entry.session.open(payload); }
      if (action === "logout") { await entry.orders.disconnect(); await entry.session.clear(); this.update(entry, "login-required", "本机平台登录已退出，历史记录保留"); return this.platformSnapshot(entry); }
      if (action === "check") return this.checked(entry, control, true);
      const binding = this.profiles.binding(entry.profileId, platform);
      if (!binding) throw Object.assign(new Error("当前账户组尚未关联此平台，请先检查登录完成关联"), { code: "ACCOUNT_UNBOUND" });
      this.profiles.assertAccount(entry.profileId, platform, binding);
      entry.session.close();
      await this.checked(entry, control, false); this.assertActive(entry, control);
      const options = action === "probe-sell" ? { direction: "sell", probe: true } : platform === "uu" ? { ...payload, probe: false } : payload;
      await (action === "inventory" ? entry.orders.startInventory(options) : entry.orders.start(options)); this.update(entry, "syncing", action === "inventory" ? "正在同步已完成炼金与库存历史" : "正在同步本账户订单");
      started.resolve(this.platformSnapshot(entry));
      await entry.orders.running; this.assertActive(entry, control);
      const result = entry.orders.snapshot();
      if (result.job.status !== "completed") throw new Error(result.job.message || "订单同步未完成");
      await this.onSaved({ profileId: entry.profileId, platform, snapshot: result });
      this.update(entry, "completed", "本账户最新订单已同步"); return this.platformSnapshot(entry);
    });
    if (launch) { void task.catch(error => started.reject(error)); return readyToReturn; }
    return task;
  }
  async dispose() {
    this.disposed = true; await this.cancel(); await this.syncing;
    for (const context of this.contexts.values()) for (const entry of Object.values(context.platforms)) {
      if (entry.session?.dispose) entry.session.dispose();
      else entry.session?.close();
    }
  }
}

module.exports = { AccountRuntime, authFailure };
