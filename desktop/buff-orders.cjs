"use strict";
// Read-only BUFF adapter. Endpoint references: Steamauto c759311, BuffApi.
// Independent implementation; never submits trades or copies Steam credentials.
const fs = require("node:fs/promises");
const path = require("node:path");
const { userId } = require("../buff-account.js");
const { analyzeOrders, resolveOrderNames } = require("./buff-analysis.cjs");
const ORIGIN = "https://buff.163.com";
const LIMIT = 4 * 1024 * 1024;
const { parsePlatformJson } = require("./platform-json.cjs");
const clean = (value, max = 500) => typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, max) : "";
function identity(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return "";
  const text = clean(value, 200);
  return /^[A-Za-z0-9_-]{1,100}$/.test(text) ? text : "";
}
function cents(value) {
  const m = String(value ?? "").match(/^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const result = Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
  return Number.isSafeInteger(result) ? result : null;
}
function instant(value) {
  if (value == null || value === "") return null;
  let n;
  if (/^\d{10}(?:\d{3})?$/.test(String(value))) n = Number(value) * (String(value).length === 10 ? 1000 : 1);
  else {
    const s = String(value).replace(" ", "T");
    if (!/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)?$/.test(s)) return null;
    const zoned = /(?:Z|[+-]\d\d:\d\d)$/.test(s) ? s : s + "+08:00";
    n = Date.parse(zoned);
    // Reject impossible calendar dates instead of Date.parse's rollover.
    const date = s.slice(0, 10), parsed = new Date(date + "T00:00:00Z");
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  }
  return Number.isFinite(n) && n >= Date.UTC(2000, 0) && n <= Date.now() + 86400000 ? new Date(n).toISOString() : null;
}
function firstMoney(item, keys) {
  for (const key of keys) if (item[key] != null && item[key] !== "") return cents(item[key]);
  return null;
}
function normalizeOrder(item, goods, { accountId, appid, direction, channel, observedAt }) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("BUFF 订单条目格式变化，未保存本次结果");
  const orderId = identity(item.id ?? item.bill_order_id ?? item.order_id), goodsId = identity(item.goods_id);
  if (!orderId || !/^\d+$/.test(goodsId)) throw new Error("BUFF 订单缺少可靠的订单号或商品 ID，未保存本次结果");
  const info = goods?.[goodsId] || item.goods_info || {};
  if (item.appid != null && Number(item.appid) !== appid || info.appid != null && Number(info.appid) !== appid) throw new Error("BUFF 返回了其他游戏的订单，已停止同步");
  const owner = item[direction === "buy" ? "buyer_id" : "seller_id"];
  if (owner != null && userId(owner) !== accountId.slice(5)) throw new Error("BUFF 订单账号不一致，已停止同步");
  const name = clean(info.name || item.name), marketHashName = clean(info.market_hash_name || item.market_hash_name);
  if (!name && !marketHashName) throw new Error("BUFF 订单缺少物品名称，未保存本次结果");
  const rawQuantity = item.quantity ?? item.num ?? (item.asset_info?.assetid || item.assetid ? 1 : null);
  const quantity = /^\d+$/.test(String(rawQuantity)) && Number(rawQuantity) > 0 && Number(rawQuantity) <= 1000000 ? Number(rawQuantity) : null;
  const currencyCode = clean(item.currency || item.currency_code || "CNY", 12).toUpperCase();
  const money = keys => currencyCode === "CNY" ? firstMoney(item, keys) : null;
  const unitPriceCents = money(["price"]);
  let grossTotalCents = money(["total_price"]);
  if (grossTotalCents == null && quantity && unitPriceCents != null && Number.isSafeInteger(quantity * unitPriceCents)) grossTotalCents = quantity * unitPriceCents;
  const state = clean(item.state, 100);
  const labels = { SUCCESS: "交易成功", DONE: "已完成", COMPLETED: "已完成", TO_DELIVER: "待发货", TO_CONFIRM: "待确认", TO_PAY: "待付款", WAITING_PAYMENT: "待付款", CANCELLED: "已取消", CANCELED: "已取消", REFUNDED: "已退款" };
  const status = clean(item.state_text || item.status_text, 100) || labels[state.toUpperCase()] || (/^[\u3400-\u9fff]+$/.test(state) ? state : "状态待核对");
  const completed = channel === "history" && ["SUCCESS", "DONE", "COMPLETED", "已完成", "交易成功", "交易完成"].includes(state.toUpperCase());
  let paidTotalCents = money(["pay_amount", "paid_amount", "paid_total"]);
  // Verified buy-history fields: real_price excludes the payment-channel fee.
  // Only single-asset orders have a verified total-price contract for these fields.
  if (paidTotalCents == null && completed && direction === "buy" && quantity === 1) {
    const real = money(["real_price"]), channelFee = money(["pay_channel_fee"]), withFee = money(["price_with_pay_fee"]);
    const calculated = real != null && channelFee != null && Number.isSafeInteger(real + channelFee) ? real + channelFee : null;
    if (withFee != null && calculated != null && withFee !== calculated) throw new Error("BUFF 实付金额字段不一致，原历史已保留");
    paidTotalCents = withFee ?? calculated;
  }
  const time = keys => { for (const key of keys) if (item[key] != null) { const date = instant(item[key]); if (date) return date; } return null; };
  return {
    key: [accountId, appid, direction, channel, orderId].join(":"), accountId, appid, direction, channel, orderId, goodsId,
    name: name || marketHashName, marketHashName, category: clean(info.tags?.type?.localized_name || info.tags?.category?.localized_name || info.category_name, 100), quantity, currencyCode, state, status: status || "状态待核对", completed,
    unitPriceCents, grossTotalCents,
    paidTotalCents,
    netTotalCents: money(["seller_income", "income", "net_income"]),
    feeCents: money(["fee"]),
    createdAt: time(["created_at", "create_time"]),
    tradedAt: time(direction === "buy" ? ["pay_time", "paid_at", "transact_time", "transacted_at"] : ["transact_time", "transacted_at", "sell_time"]),
    deliveredAt: time(["deliver_time", "delivered_at"]), receivedAt: time(["settle_time", "settled_at", "received_at"]),
    tradeOfferId: identity(item.tradeofferid), observedAt,
    sourceUrl: `${ORIGIN}/market/${direction === "buy" ? "buy" : "sell"}_order/${channel === "history" ? "history" : "to_deliver"}?game=${appid === 570 ? "dota2" : "csgo"}`,
  };
}
function options(value = {}) {
  const appids = value.appid === "all" || value.appid == null ? [730, 570] : [value.appid];
  if (appids.some(id => ![730, 570].includes(id))) throw new Error("请选择 CS2 或 Dota 2");
  const channel = value.channel || "history";
  if (!["history", "pending"].includes(channel)) throw new Error("同步范围无效");
  if (value.direction != null && !["buy", "sell", "all"].includes(value.direction)) throw new Error("买卖方向无效");
  const directions = channel === "pending" ? ["sell"] : value.direction === "buy" || value.direction === "sell" ? [value.direction] : ["buy", "sell"];
  if (value.mode != null && !["incremental", "full"].includes(value.mode)) throw new Error("同步模式无效");
  return { appids, directions, channel, mode: value.mode || "incremental" };
}
function pageInfo(data, page) {
  if (!data || !Array.isArray(data.items)) throw new Error("BUFF 列表格式无法识别，原历史已保留");
  if (data.items.length > 500) throw new Error("BUFF 单页记录过多");
  if (data.page_num != null && Number(data.page_num) !== page) throw new Error("BUFF 返回了错误页码，已停止同步");
  const total = data.total_page == null ? null : Number(data.total_page);
  if (total != null && (!Number.isSafeInteger(total) || total < 0 || total === 0 && data.items.length)) throw new Error("BUFF 分页信息无效");
  if (!data.items.length && total != null && page < total) throw new Error("BUFF 分页中断，原历史已保留");
  return { items: data.items, goods: data.goods_infos, hasMore: data.items.length > 0 && (total == null || page < total), totalPages: total };
}
function mergeOrder(target, row) {
  const old = target.get(row.key);
  if (old && (old.goodsId !== row.goodsId || old.marketHashName && row.marketHashName && old.marketHashName !== row.marketHashName)) throw new Error("同一 BUFF 订单的物品身份发生冲突，原历史已保留");
  target.set(row.key, row);
}
const abortError = () => new Error("同步已停止，原历史已保留");
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const abort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("BUFF 响应为空");
  const chunks = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > LIMIT) throw new Error("BUFF 响应过大"); chunks.push(Buffer.from(part.value)); }
    return parsePlatformJson(Buffer.concat(chunks).toString("utf8"));
  } catch { await reader.cancel().catch(() => {}); throw new Error("BUFF 返回了无法识别的数据，请检查登录或稍后重试"); }
  finally { reader.releaseLock(); }
}
function sameOrder(a, b) {
  if (!a) return false;
  return Object.keys(b).filter(key => key !== "observedAt").every(key => (a[key] ?? "") === (b[key] ?? ""));
}
// FAIL is the platform's final failed/refunded/cancelled trade state. It must
// not keep every incremental sync scanning years of settled failures.
const terminal = row => row.completed || /^(FAIL|CANCELLED|CANCELED|REFUNDED|CLOSED|已取消|已退款)$/i.test(row.state);
class BuffOrders {
  constructor({ file, repository, fetcher, notify = () => {}, interval = () => 2000 + Math.random() * 1000, now = Date.now, accountGuard = () => {} }) {
    this.repository = repository;
    this.file = file; this.fetcher = fetcher; this.notify = notify; this.interval = interval; this.now = now; this.accountGuard = accountGuard;
    this.data = { version: 1, accounts: {}, cooldownUntil: 0 }; this.account = null; this.verified = false;
    this.job = { status: "idle", pages: 0, count: 0 }; this.running = null; this.requestTail = Promise.resolve(); this.writeTail = Promise.resolve(); this.nextAt = 0;
    this.ready = this.load();
  }
  async load() {
    if (this.repository) {
      this.data = await this.repository.load(); this.account = this.data.accounts[this.data.activeAccount]?.account || null; return;
    }
    try {
      const stat = await fs.stat(this.file); if (stat.size > 40 * 1024 * 1024) throw new Error();
      const data = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (data.version !== 1 || !data.accounts || typeof data.accounts !== "object" || Array.isArray(data.accounts)) throw new Error();
      this.data = data; this.account = data.accounts[data.activeAccount]?.account || null;
    } catch (error) { if (error.code !== "ENOENT") throw new Error("BUFF 本机历史无法读取，原文件已保留"); }
  }
  save(next) {
    const run = async () => {
      if (this.repository) { await this.repository.save(next); this.data = next; return; }
      const serialized = JSON.stringify(next);
      if (Buffer.byteLength(serialized) > 40 * 1024 * 1024) throw new Error("BUFF 本机历史达到容量上限");
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await fs.writeFile(this.file + ".tmp", serialized, { mode: 0o600 });
      await fs.rename(this.file + ".tmp", this.file); this.data = next;
    };
    const result = this.writeTail.then(run); this.writeTail = result.catch(() => {}); return result;
  }
  snapshot() {
    const saved = this.data.accounts[this.account?.id];
    return { account: this.account, verified: this.verified, job: { ...this.job }, cooldownUntil: this.data.cooldownUntil || 0, count: saved?.records?.length || 0, runs: saved?.runs || [] };
  }
  emit() { this.notify({ kind: "buff-orders", value: this.snapshot() }); }
  request(route, params, signal) {
    const run = async () => {
      if (signal?.aborted) throw abortError();
      if (this.data.cooldownUntil > this.now()) throw new Error(`BUFF 请求冷却中，请在 ${new Date(this.data.cooldownUntil).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} 后重试`);
      await sleep(Math.max(0, this.nextAt - this.now()), signal);
      if (signal?.aborted) throw abortError();
      this.nextAt = this.now() + this.interval();
      const url = new URL(route, ORIGIN); for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));
      const controller = new AbortController(), abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 15000);
      try {
        const response = await this.fetcher(url.href, { method: "GET", credentials: "include", cache: "no-store", redirect: "error", signal: controller.signal, headers: { Accept: "application/json" } });
        if (response.status === 401 || response.status === 403) { this.verified = false; throw new Error("BUFF 登录失效或需要验证，请在登录窗口完成后重新检查"); }
        if ([429, 503].includes(response.status)) {
          const retry = response.headers.get("Retry-After");
          const retryMs = /^\d+$/.test(retry || "") ? Number(retry) * 1000 : Date.parse(retry) - this.now();
          await this.save({ ...this.data, cooldownUntil: this.now() + Math.max(60000, Number.isFinite(retryMs) ? retryMs : 0) });
          throw new Error("BUFF 请求受限，已停止同步并保存冷却时间，请稍后重试");
        }
        if (!response.ok) throw new Error(`BUFF 查询失败（HTTP ${response.status}），原历史已保留`);
        const body = await readJson(response);
        if (body?.code === "Login Required") { this.verified = false; throw new Error("请先在 App 中登录 BUFF，再检查登录状态"); }
        if (/频繁|繁忙|too.?many|rate.?limit/i.test(String(body?.error || body?.msg || body?.code || ""))) {
          await this.save({ ...this.data, cooldownUntil: this.now() + 60000 });
          throw new Error("BUFF 请求受限，已停止同步，请一分钟后重试");
        }
        if (body?.code !== "OK" || body.data == null) throw new Error("BUFF 查询未成功，请在登录窗口检查账号或稍后重试");
        return body.data;
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (controller.signal.aborted) throw new Error("BUFF 查询超时，原历史已保留");
        if (error instanceof TypeError) throw new Error("BUFF 网络连接失败，请检查网络与登录状态");
        throw error;
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
    };
    const result = this.requestTail.then(run); this.requestTail = result.catch(() => {}); return result;
  }
  async guardAccount(account, signal) {
    if (signal?.aborted) throw abortError();
    try { await this.accountGuard(account, { signal }); }
    catch (error) { this.verified = false; throw error; }
    if (signal?.aborted) throw abortError();
    return account;
  }
  async identify(signal) {
    const data = await this.request("/account/api/user/info", {}, signal);
    const ids = [...new Set([data.user_id, data.userid, data.uid, data.id].map(userId).filter(Boolean))];
    if (ids.length !== 1) { this.verified = false; throw new Error("未识别到唯一 BUFF 账号，暂不读取订单"); }
    return this.guardAccount({ id: "buff:" + ids[0], nickname: clean(data.nickname, 100) || "BUFF 用户" }, signal);
  }
  async check() {
    await this.ready;
    if (this.running || this.checking) throw new Error("同步或登录检查进行中，请稍后重试");
    this.checking = true;
    this.verified = false;
    const controller = new AbortController(); this.checkController = controller;
    this.checkTask = (async () => {
      try {
        const account = await this.identify(controller.signal);
        if (controller.signal.aborted) throw abortError();
        if (this.account?.id !== account.id) this.job = { status: "idle", pages: 0, count: 0 };
        this.account = account; this.verified = true; return this.snapshot();
      }
      finally { this.checking = false; this.checkController = null; this.emit(); }
    })();
    return this.checkTask;
  }
  async start(value) {
    await this.ready;
    if (this.running || this.checking) throw new Error("已有 BUFF 同步或登录检查进行中");
    const config = options(value), controller = new AbortController();
    this.controller = controller;
    this.job = { status: "running", pages: 0, count: 0, channel: config.channel, startedAt: this.now(), message: "正在核对 BUFF 账号" }; this.emit();
    this.running = this.sync(config, controller.signal).catch(error => {
      this.job = { ...this.job, status: controller.signal.aborted ? "cancelled" : "failed", message: error.message, endedAt: this.now() };
    }).finally(() => { this.running = null; this.controller = null; this.emit(); });
    return this.snapshot();
  }
  stop() { this.controller?.abort(); this.checkController?.abort(); return this.snapshot(); }
  async invalidate() {
    this.stop(); if (this.running) await this.running;
    if (this.checkTask) await this.checkTask.catch(() => {});
    await this.requestTail;
    this.verified = false; this.emit();
  }
  async disconnect() { await this.invalidate(); this.account = null; this.job = { status: "idle", pages: 0, count: 0 }; await this.save({ ...this.data, activeAccount: null }); this.emit(); }
  async sync(config, signal) {
    const account = await this.identify(signal); this.account = account; this.verified = true; this.emit();
    const records = new Map(), runs = [];
    const old = this.data.accounts[account.id] || { records: [], runs: [] }, known = new Map(old.records.map(row => [row.key, row]));
    const counts = { inserted: 0, updated: 0, skipped: 0 };
    for (const appid of config.appids) for (const direction of config.directions) {
      let more = true, page = 1, knownPages = 0, stopReason = "end";
      const previousRun = old.runs.find(run => run.appid === appid && run.direction === direction && run.channel === config.channel);
      const unresolved = new Set(old.records.filter(row => row.appid === appid && row.direction === direction && row.channel === config.channel && !terminal(row)).map(row => row.key));
      const seenPages = new Set();
      while (more) {
        this.job.message = `${appid === 730 ? "CS2" : "Dota 2"} ${config.channel === "pending" ? "待发货" : direction === "buy" ? "买入历史" : "卖出历史"} · 第 ${page} 页`; this.emit();
        const data = await this.request(`/api/market/${direction === "buy" ? "buy" : "sell"}_order/${config.channel === "history" ? "history" : "to_deliver"}`, { appid, game: appid === 570 ? "dota2" : "csgo", page_num: page, page_size: 20, ...(direction === "sell" && config.channel === "history" ? { mode: 1 } : {}) }, signal);
        const result = pageInfo(data, page), observedAt = new Date(this.now()).toISOString();
        const rows = result.items.map(item => normalizeOrder(item, result.goods, { accountId: account.id, appid, direction, channel: config.channel, observedAt }));
        const signature = rows.map(row => row.key).sort().join("|");
        if (rows.length && seenPages.has(signature)) throw new Error("BUFF 返回了重复页，已停止同步；原历史已保留");
        seenPages.add(signature);
        let unchanged = rows.length > 0;
        for (const row of rows) {
          const before = known.get(row.key), equal = sameOrder(before, row);
          unresolved.delete(row.key);
          unchanged &&= equal;
          if (!records.has(row.key)) { if (!before) counts.inserted++; else if (!equal) counts.updated++; else counts.skipped++; }
          mergeOrder(records, equal ? before : row);
        }
        // Steamauto's to_deliver endpoint also returns an unpaginated pending snapshot.
        more = result.hasMore && !(config.channel === "pending" && result.totalPages == null);
        this.job.pages++; this.job.count = records.size; this.emit(); page++;
        knownPages = unchanged ? knownPages + 1 : 0;
        // Revisit every known nonterminal order before accepting two unchanged pages.
        if (more && config.channel === "history" && config.mode === "incremental" && knownPages >= 2 && unresolved.size === 0 && previousRun?.complete) { stopReason = "known"; break; }
      }
      runs.push({ appid, direction, channel: config.channel, pages: page - 1, complete: !more || stopReason === "known" && Boolean(previousRun?.complete), stopReason, syncedAt: new Date(this.now()).toISOString() });
    }
    const endAccount = await this.identify(signal);
    if (endAccount.id !== account.id) { this.account = endAccount; throw new Error("同步期间 BUFF 账号已切换，本次结果未保存"); }
    if (signal.aborted) throw abortError();
    // Only replace a pending snapshot when its entire scope was fetched.
    const merged = new Map(old.records.filter(row => !runs.some(run => run.channel === "pending" && run.complete && row.channel === "pending" && row.appid === run.appid)).map(row => [row.key, row]));
    for (const row of records.values()) mergeOrder(merged, row);
    const nextRuns = old.runs.filter(oldRun => !runs.some(run => run.appid === oldRun.appid && run.direction === oldRun.direction && run.channel === oldRun.channel)).concat(runs);
    await this.save({ ...this.data, activeAccount: account.id, accounts: { ...this.data.accounts, [account.id]: { account, records: [...merged.values()], runs: nextRuns } } });
    this.job = { ...this.job, ...counts, status: "completed", endedAt: this.now(), message: `已入库：新增 ${counts.inserted}、更新 ${counts.updated}、跳过 ${counts.skipped} 条。` + (runs.some(run => run.stopReason === "known") ? "已到历史同步范围；可用完整复核补齐更早记录。" : "已读取到末页。") };
  }
  async list(value = {}) {
    await this.ready;
    const page = value.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1 || clean(value.query).length > 100) throw new Error("查询条件无效");
    const catalog = await this.repository?.names?.();
    const rows = resolveOrderNames(this.data.accounts[this.account?.id]?.records || [], catalog);
    return { ...analyzeOrders(rows, value), ...this.snapshot() };
  }
  async collect({ direction, appid, keys } = {}) {
    await this.ready;
    if (!["buy", "sell"].includes(direction)) throw new Error("请选择买入或卖出历史");
    if (keys != null && (!Array.isArray(keys) || keys.length > 500 || keys.some(key => typeof key !== "string"))) throw new Error("核对订单选择无效");
    const all = this.data.accounts[this.account?.id]?.records || [];
    const eligible = all.filter(row => row.channel === "history" && row.completed && row.currencyCode === "CNY" && row.direction === direction && (!appid || row.appid === appid) && (!keys || keys.includes(row.key)));
    if (eligible.length > 500) throw new Error("匹配订单超过 500 条，请在 BUFF 订单页筛选后核对当前页");
    const records = eligible.map(row => ({ platform: "buff", appid: row.appid, goodsId: row.goodsId, name: row.name, marketHashName: row.marketHashName, quantity: row.quantity,
      sourceId: row.orderId, orderId: row.orderId, sourceUrl: row.sourceUrl, currencyCode: row.currencyCode,
      rawText: `订单 ${row.orderId} · ${row.status} · ${row.quantity ?? "未知"} 件`, status: row.status, dateLabel: row.tradedAt || "时间待核对",
      ...(direction === "buy" ? { kind: "buy", platformAccountId: row.accountId, buyTotalCents: row.paidTotalCents, boughtAt: row.tradedAt, deliveredAt: row.deliveredAt } : { accountId: row.accountId, netTotalCents: row.netTotalCents, grossTotalCents: row.grossTotalCents, soldAt: row.tradedAt, receivedAt: row.receivedAt }),
      note: "来自桌面 BUFF 历史同步；未明确的实付、净到账或时间留空，请核对后入账。" }));
    return { records, notices: [`本机缓存：${this.account?.nickname || "未登录"}（${this.account?.id || "未识别账号"}），${records.length} 条已完成${direction === "buy" ? "买入" : "卖出"}。未完成、未知状态和异币种不导入；尚未写入账本。`] };
  }
}
module.exports = { ORIGIN, cents, instant, normalizeOrder, options, pageInfo, BuffOrders };
