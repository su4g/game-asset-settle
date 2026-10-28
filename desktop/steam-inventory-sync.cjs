"use strict";
const { parseInventoryPage, mergeEvent, validateInventory } = require("./steam-inventory.cjs");
const stopped = () => { throw new Error("Steam 库存历史同步已停止，已核对的分页保留"); };
async function startInventory(value = {}) {
  await this.ready;
  if (!value || Object.keys(value).some(k => k !== "mode") || value.mode != null && !["incremental","full"].includes(value.mode)) throw new Error("库存历史同步参数无效");
  if (this.running || this.checking) throw new Error("已有 Steam 同步或登录检查进行中");
  const controller = new AbortController(); this.controller = controller;
  this.job = { status: "running", kind: "inventory", pages: 0, count: 0, startedAt: this.now(), message: "正在核对 Steam 账号与库存历史" }; this.emit();
  this.running = syncInventory.call(this, value.mode || "incremental", controller.signal).catch(error => {
    this.job = { ...this.job, status: controller.signal.aborted ? "cancelled" : "failed", message: error.message, endedAt: this.now() };
  }).finally(() => { this.running = null; this.controller = null; this.emit(); });
  return this.snapshot();
}
async function syncInventory(mode, signal) {
  const account = await this.identify(signal); this.account = account; this.verified = true; this.emit();
  const old = this.data.accounts[account.id]?.inventoryHistory;
  validateInventory(old, account.id);
  const known = new Map((old?.events || []).map(e => [e.key, e])), collected = new Map(), seenPages = new Set(), seenCursors = new Set();
  let cursor = null, unchanged = 0, resumed = false, lastSavedPage = 0, firstSignature = null;
  const read = async next => {
    const params = { ajax: 1, "app[]": 730, l: "english" };
    if (next) for (const [key, value] of Object.entries(next)) params[`cursor[${key}]`] = value;
    return parseInventoryPage(await this.request(`/profiles/${account.id.slice(6)}/inventoryhistory/`, params, signal), account.id);
  };
  const commit = async (complete, next, stopReason) => {
    const end = await this.identify(signal);
    if (end.id !== account.id) { this.verified = false; throw new Error("库存同步期间 Steam 账号变化，本批分页未保存"); }
    if (signal.aborted) stopped();
    const map = new Map(collected); for (const [key, event] of known) if (!map.has(key)) map.set(key, event);
    const events = [...map.values()].sort((a,b) => b.at.localeCompare(a.at));
    const inventoryHistory = { version: 1, events, coverage: { complete, cursor: next, stopReason, syncedAt: new Date(this.now()).toISOString(), pages: (old?.coverage?.pages || 0) + this.job.pages, eventCount: events.length, fromAt: next ? new Date(Number(next.time) * 1000 + 60000).toISOString() : null } };
    validateInventory(inventoryHistory, account.id);
    const current = this.data.accounts[account.id] || { account, records: [], runs: [] };
    await this.save({ ...this.data, activeAccount: account.id, accounts: { ...this.data.accounts, [account.id]: { ...current, inventoryHistory } } });
    lastSavedPage = this.job.pages; this.emit();
  };
  while (true) {
    const page = await read(cursor);
    if (firstSignature == null) firstSignature = page.signature;
    if (page.events.length && seenPages.has(page.signature)) throw new Error("Steam 库存历史重复分页，已停止；已核对的历史保留");
    seenPages.add(page.signature);
    let same = page.events.length > 0;
    for (const event of page.events) {
      if (collected.has(event.key)) throw new Error("Steam 库存分页重叠，已停止；已核对的历史保留");
      const before = known.get(event.key); same &&= Boolean(before);
      collected.set(event.key, mergeEvent(before, event));
    }
    this.job = { ...this.job, pages: this.job.pages + 1, count: collected.size, message: `库存历史 · 已读取 ${collected.size} 条事件，发现 ${[...collected.values()].filter(e => e.kind === "trade-up").length} 次炼金` }; this.emit();
    unchanged = same ? unchanged + 1 : 0;
    if (!page.cursor || mode === "incremental" && old?.coverage?.complete && unchanged >= 2) {
      // Cursor pagination is stable, but the newest page must still be unchanged
      // before this traversal can claim the platform end/known boundary.
      const head = await read(null);
      if (head.signature !== firstSignature) throw new Error("库存历史在同步期间增加了事件，请再次增量同步；已核对分页保留");
      await commit(true, null, page.cursor ? "known" : "end"); break;
    }
    let next = page.cursor;
    if (mode === "incremental" && !old?.coverage?.complete && old?.coverage?.cursor && unchanged >= 2 && !resumed) {
      next = old.coverage.cursor; resumed = true; unchanged = 0;
    }
    const cursorKey = JSON.stringify(next);
    if (seenCursors.has(cursorKey)) throw new Error("Steam 库存历史游标重复，已停止");
    seenCursors.add(cursorKey);
    // The checkpoint cursor always ends this contiguous traversal from the
    // head. Keeping an older cursor before bridging its head would skip a gap.
    if (this.job.pages - lastSavedPage >= 5) await commit(false, next, "checkpoint");
    cursor = next;
  }
  this.job = { ...this.job, status: "completed", endedAt: this.now(), message: `库存历史已保存 · ${this.data.accounts[account.id].inventoryHistory.events.filter(e => e.kind === "trade-up").length} 次已完成炼金。${this.data.accounts[account.id].inventoryHistory.coverage.stopReason === "end" ? "已读至 Steam 返回的末页。" : "已到已知边界。"}` };
}
module.exports = { startInventory, syncInventory };
