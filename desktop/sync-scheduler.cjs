"use strict";

const SIX_HOURS = 6 * 60 * 60 * 1000;
// Deadline-based scheduling coalesces all missed ticks into one run on resume.
// The run callback owns platform/account locks and never opens login windows.
class SyncScheduler {
  constructor({ run, state, notify = () => {}, enabled = true, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, interval = SIX_HOURS }) {
    if (typeof run !== "function" || interval !== SIX_HOURS) throw new Error("后台同步必须使用六小时间隔");
    Object.assign(this, { run, state, notify, enabled, now, setTimer, clearTimer, interval });
    this.timer = null; this.running = null; this.started = false; this.stopped = false; this.nextRunAt = null;
    this.lastStartedAt = null; this.lastFinishedAt = null; this.lastError = null; this.ready = this.load();
  }
  async load() {
    if (!this.state) return;
    const saved = (await this.state.get("syncSchedule")).syncSchedule;
    if (!saved) return;
    for (const key of ["nextRunAt", "lastStartedAt", "lastFinishedAt"]) if (Number.isSafeInteger(saved[key]) && saved[key] >= 0) this[key] = saved[key];
  }
  snapshot() { return { enabled: this.enabled && !this.stopped, intervalMs: this.interval, status: this.running ? "running" : this.enabled && !this.stopped ? "waiting" : "disabled",
    nextRunAt: this.nextRunAt, lastStartedAt: this.lastStartedAt, lastFinishedAt: this.lastFinishedAt, lastError: this.lastError }; }
  async save() { if (this.state) await this.state.set({ syncSchedule: { nextRunAt: this.nextRunAt, lastStartedAt: this.lastStartedAt, lastFinishedAt: this.lastFinishedAt } }); }
  emit() { this.notify({ kind: "sync-schedule", value: this.snapshot() }); }
  arm() {
    if (this.timer) this.clearTimer(this.timer); this.timer = null;
    if (!this.started || this.stopped || !this.enabled || this.running) return;
    if (this.nextRunAt == null) this.nextRunAt = this.now() + this.interval;
    this.timer = this.setTimer(() => { this.timer = null; void this.tick("scheduled").catch(error => { this.lastError = error.message; this.emit(); }); }, Math.max(0, this.nextRunAt - this.now()));
    this.timer?.unref?.();
  }
  async start({ runOnStartup = true } = {}) {
    await this.ready;
    if (this.started || this.stopped) return this.snapshot();
    this.started = true;
    if (this.enabled && runOnStartup) return this.trigger("startup");
    this.arm(); this.emit(); return this.snapshot();
  }
  async trigger(reason = "manual") {
    await this.ready;
    if (!this.enabled || this.stopped) return this.snapshot();
    if (this.running) { await this.running; return this.snapshot(); }
    if (this.timer) this.clearTimer(this.timer); this.timer = null;
    this.lastStartedAt = this.now(); this.nextRunAt = this.lastStartedAt + this.interval; this.lastError = null;
    const task = Promise.resolve().then(async () => {
      await this.save();
      if (!this.stopped) await this.run({ reason });
    }).catch(error => { this.lastError = error.message; }).finally(async () => {
      this.lastFinishedAt = this.now();
      if (this.nextRunAt <= this.now()) this.nextRunAt = this.now() + this.interval;
      try { await this.save(); } catch (error) { this.lastError = error.message; }
      if (this.running === task) this.running = null;
      this.arm(); this.emit();
    });
    this.running = task; this.emit(); await task; return this.snapshot();
  }
  async tick(reason = "scheduled") {
    await this.ready;
    if (!this.started || this.stopped || !this.enabled) return this.snapshot();
    if (this.nextRunAt != null && this.now() >= this.nextRunAt) return this.trigger(reason);
    this.arm(); return this.snapshot();
  }
  resume() { return this.tick("resume"); }
  stop() { this.stopped = true; if (this.timer) this.clearTimer(this.timer); this.timer = null; this.emit(); return this.snapshot(); }
}

module.exports = { SIX_HOURS, SyncScheduler };
