"use strict";
const { createHash } = require("node:crypto");
const { accountKey, listAccounts } = require("../desktop/order-ledger.cjs");
const { reconcileInput } = require("../desktop/steam-reconcile.cjs");
const { validateInventory, mergeEvent } = require("../desktop/steam-inventory.cjs");

class CloudError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (message, code = "INVALID_SNAPSHOT", status = 400) => { throw new CloudError(status, code, message); };
const object = value => value != null && typeof value === "object" && !Array.isArray(value);
const platforms = ["buff", "uu", "steam"];
const identifier = (value, label) => { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail(label + "无效"); return value; };
const fields = (value, keys, label) => { if (!object(value) || Object.keys(value).some(k => !keys.includes(k))) fail(label + "包含未开放字段"); };
const text = (value, label, max = 500) => { if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) fail(label + "无效"); return value; };
function iso(value, label, nullable = false) {
  if (nullable && value == null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(label + "无效");
  return value;
}
function scan(value, depth = 0) {
  if (depth > 30) fail("同步数据嵌套过深");
  if (typeof value === "number" && !Number.isFinite(value)) fail("同步数据包含无效数字");
  if (typeof value === "string" && value.length > 100000) fail("同步数据字段过长");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key) || /cookie|password|authorization|secret|token|private.?key|api.?key|sessionid|headers|csrf/i.test(key)) fail("同步数据不能包含登录凭据或请求头", "CREDENTIAL_FIELD");
    scan(child, depth + 1);
  }
}
function stable(value) {
  return JSON.stringify(value, (_key, child) => object(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
}
const digest = value => createHash("sha256").update(stable(value)).digest("hex");
function validateRecord(row, kind, id) {
  if (!object(row) || row.accountId !== id || !Number.isSafeInteger(row.appid) || row.appid < 1 || !["buy", "sell"].includes(row.direction) || !["history", "pending"].includes(row.channel)) fail("订单与绑定账号不一致", "ACCOUNT_MISMATCH");
  text(row.orderId, "订单号", 200); text(row.key, "订单身份", 1000);
  const expected = [id, row.appid, row.direction, row.channel, row.orderId, ...(kind === "uu" ? [row.lineId] : [])].join(":");
  if (row.key !== expected || kind === "uu" && (typeof row.lineId !== "string" || !row.lineId)) fail("订单身份与账号不一致", "ACCOUNT_MISMATCH");
  if (row.quantity != null && (!Number.isSafeInteger(row.quantity) || row.quantity < 1)) fail("订单数量无效");
  if (typeof row.completed !== "boolean") fail("订单完成状态无效");
  for (const key of ["tradedAt", "createdAt", "observedAt", "eventAt", "fundsHeldUntil", "receivedAt"]) if (row[key] != null && (typeof row[key] !== "string" || !Number.isFinite(Date.parse(row[key])))) fail("订单时间无效");
  if (row.currencyCode != null && (typeof row.currencyCode !== "string" || !/^(?:[A-Z]{3})?$/.test(row.currencyCode))) fail("订单币种无效");
  for (const [key, value] of Object.entries(row)) if (/Cents$/.test(key) && value != null && (!Number.isSafeInteger(value) || value < 0)) fail("订单金额必须为非负整数分或空值");
}
function validateProfile(profile) {
  fields(profile, ["id", "name", "bindings", "input", "options", "quotes", "pricingSettings", "status", "csvScopes"], "账户资料");
  identifier(profile.id, "账户组标识"); text(profile.name, "账户组名称", 80);
  fields(profile.bindings, platforms, "平台关联");
  fields(profile.input, [...platforms, "csv", "names"], "订单来源");
  const knownKeys = new Set(), ownership = [];
  for (const platform of platforms) {
    const bound = profile.bindings[platform] ?? null, data = profile.input[platform];
    if (bound != null && (typeof bound !== "string" || !new RegExp(`^${platform}:[A-Za-z0-9_-]{1,100}$`).test(bound))) fail("平台账号标识无效");
    profile.bindings[platform] = bound;
    if (!object(data) || !object(data.accounts)) fail("平台存档格式无效");
    if (Object.keys(data.accounts).some(id => id !== bound)) fail("存档含其他账户的订单", "ACCOUNT_MISMATCH");
    if (data.activeAccount != null && data.activeAccount !== bound && data.activeAccount?.id !== bound) fail("活动账号与绑定不一致", "ACCOUNT_MISMATCH");
    if (bound) { ownership.push({ platform, accountId: bound }); knownKeys.add(accountKey(platform, platform, bound)); }
    for (const [id, account] of Object.entries(data.accounts)) {
      if (!object(account) || account.account?.id !== id || !Array.isArray(account.records) || !Array.isArray(account.runs)) fail("平台账户存档格式无效");
      if (account.inventoryHistory != null) {
        if (platform !== "steam") fail("库存历史仅属于绑定的 Steam 账号", "ACCOUNT_MISMATCH");
        try { validateInventory(account.inventoryHistory, id); } catch { fail("Steam 库存历史身份或事件格式无效", "INVALID_INVENTORY"); }
      }
      const seen = new Set();
      for (const row of account.records) { validateRecord(row, platform, id); if (seen.has(row.key)) fail("存档存在重复订单"); seen.add(row.key); }
    }
  }
  const csv = profile.input.csv;
  if (!object(csv) || !Array.isArray(csv.rows) || !object(profile.input.names)) fail("CSV 或名称存档格式无效");
  const scopes = new Set(profile.csvScopes || csv.rows.map(row => row.scope)), seenCsv = new Set();
  for (const scope of scopes) { text(scope, "CSV 账户标记", 200); ownership.push({ platform: "csv", accountId: JSON.stringify([profile.id, scope]) }); }
  for (const row of csv.rows) {
    if (!object(row) || !scopes.has(row.scope) || !platforms.includes(row.platform)) fail("CSV 账户归属无效", "ACCOUNT_MISMATCH");
    text(row.key, "CSV 记录身份", 1000);
    if (!Number.isSafeInteger(row.appid) && !/^\d+$/.test(String(row.appid)) || !["buy", "sell", "purchase", "sale"].includes(row.type) || !Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.totalCents != null && (!Number.isSafeInteger(row.totalCents) || row.totalCents < 0)) fail("CSV 订单格式无效");
    const key = JSON.stringify([row.scope, row.key]); if (seenCsv.has(key)) fail("CSV 存档存在重复记录"); seenCsv.add(key);
    knownKeys.add(accountKey("csv", row.platform, row.scope));
  }
  profile.csvScopes = [...scopes].sort();
  const options = profile.options || {};
  fields(options, ["accountLinkMode", "accountLinks", "csvAmountSemantics", "excludedHoldingIds", "watchlistIds", "reportEntries", "overrides"], "报表设置");
  const links = options.accountLinks || [{ id: profile.id, name: profile.name, accountKeys: [...knownKeys] }];
  if (!Array.isArray(links) || links.length !== 1 || !object(links[0]) || !Array.isArray(links[0].accountKeys) || typeof links[0].id !== "string" || !links[0].id || links[0].id.startsWith("account:")) fail("每组账户必须只有一个独立计算组合", "ACCOUNT_MISMATCH");
  const linked = new Set(links[0].accountKeys);
  if (linked.size !== links[0].accountKeys.length || [...linked].some(key => !knownKeys.has(key)) || listAccounts(reconcileInput(profile.input)).some(account => !linked.has(account.key))) fail("报表组合含未关联账号或遗漏来源", "ACCOUNT_MISMATCH");
  if (options.reportEntries != null && (!Array.isArray(options.reportEntries) || options.reportEntries.some(entry => !object(entry) || entry.portfolioId !== links[0].id))) fail("收益补录属于其他账户组合", "ACCOUNT_MISMATCH");
  profile.options = { ...options, accountLinkMode: "manual", accountLinks: links };
  if (profile.quotes != null && !Array.isArray(profile.quotes)) fail("报价存档格式无效");
  if (profile.pricingSettings != null && !object(profile.pricingSettings)) fail("报价设置格式无效");
  if (profile.status != null && !object(profile.status)) fail("同步状态格式无效");
  return { profile, ownership };
}
function validateEnvelope(value) {
  fields(value, ["schemaVersion", "deviceId", "sequence", "profiles", "collectedAt"], "同步请求");
  scan(value);
  if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || !Array.isArray(value.profiles) || value.profiles.length !== 1) fail("每次同步必须只包含当前终端关联的一个账户组");
  identifier(value.deviceId, "终端标识"); iso(value.collectedAt, "采集时间");
  const envelope = structuredClone(value), checked = validateProfile(envelope.profiles[0]);
  return { envelope, ...checked, hash: digest(envelope) };
}
function validateReplacement(previous, next) {
  if (!previous) return;
  for (const platform of platforms) {
    const before = previous.bindings[platform];
    if (before && before !== next.bindings[platform]) fail("已归档平台账号不能被同步任务重新绑定", "BINDING_CONFLICT", 409);
    if (platform === "steam") for (const [id, account] of Object.entries(previous.input.steam.accounts)) {
      const events = new Map((next.input.steam.accounts[id]?.inventoryHistory?.events || []).map(e => [e.key, e]));
      for (const event of account.inventoryHistory?.events || []) {
        if (!events.has(event.key)) fail("同步快照缺少已归档库存历史", "HISTORY_TRUNCATED", 409);
        try { mergeEvent(event, events.get(event.key)); } catch { fail("库存事件身份冲突", "INVENTORY_IDENTITY_CONFLICT", 409); }
      }
    }
    const oldRows = Object.values(previous.input[platform].accounts).flatMap(a => a.records), nextRows = new Map(Object.values(next.input[platform].accounts).flatMap(a => a.records).map(row => [row.key, row]));
    for (const row of oldRows) {
      const current = nextRows.get(row.key);
      if (row.channel === "history" && !current) fail("同步快照缺少已归档历史，已保留云端数据", "HISTORY_TRUNCATED", 409);
      if (current && (row.accountId !== current.accountId || row.marketHashName && current.marketHashName && row.marketHashName !== current.marketHashName || platform === "uu" && row.lineId !== current.lineId || platform !== "uu" && row.goodsId !== current.goodsId)) fail("订单物品身份冲突", "ORDER_IDENTITY_CONFLICT", 409);
    }
  }
  const csvKeys = new Set(next.input.csv.rows.map(row => JSON.stringify([row.scope, row.key])));
  if (previous.input.csv.rows.some(row => !csvKeys.has(JSON.stringify([row.scope, row.key])))) fail("同步快照缺少已归档 CSV 记录", "HISTORY_TRUNCATED", 409);
}
module.exports = { CloudError, fail, object, platforms, identifier, iso, digest, validateEnvelope, validateReplacement };
