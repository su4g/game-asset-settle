"use strict";
const { buildProfitReport } = require("../desktop/profit-report.cjs");
const { reconcileInput } = require("../desktop/steam-reconcile.cjs");
const Analytics = require("../desktop/report-analytics.js");
const { CloudError } = require("./validation.cjs");
const { recordCount } = require("./store.cjs");
const platformNames = { buff: "BUFF", uu: "悠悠", steam: "Steam" };
const latest = list => list.filter(value => typeof value === "string" && Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
const knownStatusKeys = new Set(["phase", "status", "message", "enabled", "startedAt", "endedAt", "lastAttemptAt", "lastSyncedAt", "checkedAt", "nextRunAt", "lastRunAt", "lastSuccessAt", "completedAt", "cooldownUntil", "loginRequired", "intervalMs", "running", "paused", "online", "updatedAt", "platforms", "buff", "uu", "steam"]);
function safeStatus(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 4) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, child]) => knownStatusKeys.has(key) && (child == null || ["string", "number", "boolean"].includes(typeof child) || typeof child === "object" && !Array.isArray(child))).map(([key, child]) => [key, child && typeof child === "object" ? safeStatus(child, depth + 1) : child]));
}
function profileInfo(row) {
  return { id: row.id, name: row.name, bindings: row.snapshot?.bindings || { buff: null, uu: null, steam: null }, recordCount: row.snapshot ? recordCount(row.snapshot) : 0,
    collectedAt: row.collectedAt, uploadedAt: row.uploadedAt, state: row.snapshot ? "synced" : "not-synced", status: safeStatus(row.snapshot?.status) };
}
function sourceStatus(profile) {
  const result = {};
  for (const platform of ["buff", "uu", "steam"]) {
    const accounts = Object.entries(profile?.input[platform]?.accounts || {}).map(([accountId, value]) => {
      const runs = (value.runs || []).filter(run => run.channel === "history").map(run => ({ appid: run.appid, direction: run.direction, channel: run.channel, complete: run.complete === true,
        pages: run.pages, stopReason: run.stopReason, syncedAt: latest([run.syncedAt]) }));
      return { accountId, recordCount: value.records.length, lastSyncedAt: latest(runs.map(run => run.syncedAt)), runs };
    });
    result[platform] = { lastSyncedAt: latest(accounts.map(account => account.lastSyncedAt)), recordCount: accounts.reduce((count, account) => count + account.recordCount, 0), accounts };
  }
  return result;
}
const emptyProfile = row => ({ id: row.id, name: row.name, bindings: { buff: null, uu: null, steam: null }, input: { buff: { accounts: {} }, uu: { accounts: {} }, steam: { accounts: {} }, csv: { rows: [] }, names: {} }, options: { accountLinks: [{ id: row.id, name: row.name, accountKeys: [] }] } });
function range(params) {
  const result = {};
  for (const [name, key] of [["from", "dateFrom"], ["to", "dateTo"]]) if (params.has(name)) {
    const value = params.get(name);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new CloudError(400, "INVALID_QUERY", "成交日期无效");
    result[key] = value;
  }
  if (result.dateFrom && result.dateTo && result.dateFrom > result.dateTo) throw new CloudError(400, "INVALID_QUERY", "开始日期不能晚于结束日期");
  return result;
}
function pagination(params) {
  const page = Number(params.get("page") || 1), pageSize = Number(params.get("limit") || params.get("pageSize") || 50);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new CloudError(400, "INVALID_QUERY", "分页参数无效");
  return { page, pageSize };
}
const paginate = (rows, params) => { const { page, pageSize } = pagination(params); return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize }; };
function query(params) {
  const allowed = new Set(["from", "to", "page", "limit", "pageSize", "platform", "direction", "currency", "q", "days"]);
  const seen = new Set();
  for (const [key] of params) { if (!allowed.has(key) || seen.has(key)) throw new CloudError(400, "INVALID_QUERY", "查询包含未开放或重复参数"); seen.add(key); }
  if (params.has("platform") && !["buff", "uu", "steam"].includes(params.get("platform"))) throw new CloudError(400, "INVALID_QUERY", "平台筛选无效");
  if (params.has("direction") && !["buy", "sell"].includes(params.get("direction"))) throw new CloudError(400, "INVALID_QUERY", "买卖方向无效");
  if (params.has("currency") && !/^[A-Z]{3}$/.test(params.get("currency"))) throw new CloudError(400, "INVALID_QUERY", "币种筛选无效");
  if ((params.get("q") || "").length > 200) throw new CloudError(400, "INVALID_QUERY", "搜索内容过长");
  pagination(params); return range(params);
}
function orders(profile, params) {
  const input = reconcileInput(profile.input), rows = [], period = range(params);
  for (const platform of ["buff", "uu", "steam"]) for (const account of Object.values(input[platform].accounts)) for (const raw of account.records) rows.push({
    id: JSON.stringify([platform, raw.key]), platform, platformName: platformNames[platform], accountId: raw.accountId, appid: raw.appid, orderId: raw.orderId,
    name: raw.name || raw.marketHashName || "未命名物品", marketHashName: raw.marketHashName || "", direction: raw.direction, currencyCode: raw.currencyCode || "",
    quantity: raw.quantity ?? null, actualTotalCents: (raw.direction === "buy" ? raw.paidTotalCents : raw.netTotalCents) ?? null,
    tradedAt: raw.tradedAt || null, state: String(raw.state ?? "UNKNOWN"), completed: raw.completed, channel: raw.channel, source: platform,
  });
  for (const raw of input.csv.rows) rows.push({ id: JSON.stringify(["csv", raw.scope, raw.key]), platform: raw.platform, platformName: platformNames[raw.platform], accountId: raw.scope,
    appid: Number(raw.appid), orderId: raw.orderId || "", name: raw.itemName || raw.marketHashName || "未命名物品", marketHashName: raw.marketHashName || "",
    direction: ["purchase", "buy"].includes(raw.type) ? "buy" : "sell", currencyCode: raw.currency || "", quantity: raw.quantity ?? null,
    actualTotalCents: raw.amountSemantics === "actual" ? raw.totalCents ?? null : null, tradedAt: raw.date || null, state: "IMPORTED", completed: true, channel: "history", source: "csv" });
  const search = (params.get("q") || "").toLocaleLowerCase();
  const filtered = rows.filter(row => {
    const day = row.tradedAt && (row.tradedAt.length === 10 ? row.tradedAt : new Date(Date.parse(row.tradedAt) + 28800000).toISOString().slice(0, 10));
    return (!params.has("platform") || row.platform === params.get("platform")) && (!params.has("direction") || row.direction === params.get("direction"))
      && (!params.has("currency") || row.currencyCode === params.get("currency")) && (!period.dateFrom || day && day >= period.dateFrom) && (!period.dateTo || day && day <= period.dateTo)
      && (!search || `${row.name} ${row.marketHashName} ${row.orderId}`.toLocaleLowerCase().includes(search));
  }).sort((a, b) => (b.tradedAt || "").localeCompare(a.tradedAt || "") || a.id.localeCompare(b.id));
  return { ...paginate(filtered, params), suppressedCsvCount: input.csv.suppressedCount || 0 };
}
function view(row, name, params = new URLSearchParams(), reportCache = null) {
  const period = query(params), profile = row.snapshot || emptyProfile(row), info = profileInfo(row);
  if (name === "sync-status") return { profileId: row.id, collectedAt: row.collectedAt, uploadedAt: row.uploadedAt, status: info.status, sourceStatus: sourceStatus(profile) };
  if (name === "orders") return orders(profile, params);
  if (name === "alchemy") return require("./alchemy-view.cjs").alchemyView(row, profile, params, period);
  const report = reportCache ? reportCache.get(row, profile, period) : buildProfitReport(reconcileInput(profile.input), { ...profile.options, ...period, quotes: profile.quotes || [], pricingSettings: profile.pricingSettings || {} });
  if (name === "overview") return { profile: info, currencies: report.currencies, quality: report.quality, sourceStatus: sourceStatus(profile), scopeNote: report.scopeNote, method: report.method };
  const currency = params.get("currency") || report.currencies[0]?.currencyCode || "CNY", search = (params.get("q") || "").toLocaleLowerCase();
  const groups = report.groups.filter(group => group.currencyCode === currency && (!search || `${group.name} ${group.marketHashName}`.toLocaleLowerCase().includes(search)));
  if (name === "holdings") return { ...paginate(groups.filter(group => !group.excluded && group.holding.quantity > 0).map(group => ({ id: group.id, name: group.name, marketHashName: group.marketHashName,
    appid: group.appid, currencyCode: group.currencyCode, ...group.holding, excluded: group.excluded })), params), currency };
  const days = Number(params.get("days") || 180);
  if (!Number.isSafeInteger(days) || days < 1 || days > 2000) throw new CloudError(400, "INVALID_QUERY", "图表天数无效");
  const analysis = Analytics.analyze(report, groups, { currencyCode: currency, interval: "day" }), page = paginate(groups.map(({ activity, trades, ...group }) => group), params);
  return { method: report.method, currency, summary: analysis.summary, daily: analysis.daily.slice(-days), groups: page.rows, total: page.total,
    page: page.page, pageSize: page.pageSize, scopeNote: report.scopeNote, quality: report.quality, dateFrom: report.dateFrom, dateTo: report.dateTo };
}
module.exports = { profileInfo, sourceStatus, view };
