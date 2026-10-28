"use strict";
const { buildAggregateLedger, listAccounts, accountKey } = require("./order-ledger.cjs");
const { buildOrderTrends } = require("./order-trends.cjs");
const { enrichLedger } = require("./order-ledger-insights.cjs");
const Pricing = require("./pricing.js");
const { randomUUID } = require("node:crypto");
const { buildProfitReport, buildProfitProjection, reportRevision, originalQuantity } = require("./profit-report.cjs");
const { reconcileInput } = require("./steam-reconcile.cjs");
const Analytics = require("./report-analytics.js");
const { scopeInput, scopeOptions } = require("./account-data.cjs");

// Share the read/modify/write queue between services using the same preference
// store, including when the selected local database changes during a session.
const writeQueues = new WeakMap();
const clone = value => structuredClone(value);
const object = value => value && typeof value === "object" && !Array.isArray(value);
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error("订单账本请求包含未开放的字段");
}
function identifier(value, label, max = 2000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label}无效`);
  return value;
}
function latest(values) {
  const times = values.map(value => typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}
function sourceStatus(input) {
  const native = source => {
    const accounts = Object.entries(input[source]?.accounts || {}).map(([accountId, value]) => ({
      accountId, recordCount: value.records?.length || 0,
      lastSyncedAt: latest((value.runs || []).filter(run => run.channel === "history").map(run => run.syncedAt)),
      runs: (value.runs || []).filter(run => run.channel === "history").map(run => ({ appid: run.appid, direction: run.direction, channel: run.channel,
        complete: run.complete === true, pages: run.pages, stopReason: run.stopReason, syncedAt: latest([run.syncedAt]) })),
    }));
    return { lastSyncedAt: latest(accounts.map(account => account.lastSyncedAt)),
      recordCount: accounts.reduce((total, account) => total + account.recordCount, 0), accounts };
  };
  const imports = (input.csv?.imports || []).map(item => ({ fileName: item.fileName, scope: item.scope,
    importedAt: latest([item.importedAt]), inserted: item.inserted, updated: item.updated, skipped: item.skipped }));
  return { buff: native("buff"), uu: native("uu"), steam: native("steam"), csv: { lastImportedAt: latest(imports.map(item => item.importedAt)),
    recordCount: input.csv?.archiveRowCount ?? input.csv?.rows?.length ?? 0, suppressedCount: input.csv?.suppressedCount || 0, bindings: input.csv?.bindings || [], imports } };
}
function automaticLinks(input) {
  return [{ id: "self", name: "本人账户", accountKeys: listAccounts(input).map(account => account.key) }];
}
function savedOptions(value, input) {
  if (value != null && !object(value)) throw new Error("订单账本偏好格式无效");
  const accountLinkMode = value?.accountLinkMode ?? (value && Object.hasOwn(value, "accountLinks") ? "manual" : "auto");
  if (!["auto", "manual"].includes(accountLinkMode) || accountLinkMode === "manual" && !Array.isArray(value?.accountLinks)) throw new Error("订单账本账户分组偏好无效");
  const accountLinks = accountLinkMode === "auto" ? automaticLinks(input) : clone(value.accountLinks);
  if (accountLinkMode === "manual") {
    // A fully reconciled native account replaces its CSV source in the same
    // user-selected portfolio. Explicit native grouping always takes priority.
    const candidates = new Map();
    for (const binding of input.csv?.bindings || []) {
      const nativeKey = accountKey("steam", "steam", binding.accountId);
      if (accountLinks.some(link => link.accountKeys.includes(nativeKey))) continue;
      const prior = accountLinks.find(link => link.accountKeys.includes(accountKey("csv", "steam", binding.scope)));
      if (prior) { if (!candidates.has(nativeKey)) candidates.set(nativeKey, new Set()); candidates.get(nativeKey).add(prior.id); }
    }
    for (const [key, groups] of candidates) if (groups.size === 1) accountLinks.find(link => link.id === [...groups][0]).accountKeys.push(key);
  }
  return { accountLinkMode, accountLinks, csvAmountSemantics: clone(value?.csvAmountSemantics || {}),
    excludedHoldingIds: clone(value?.excludedHoldingIds || []), watchlistIds: clone(value?.watchlistIds || []), reportEntries: clone(value?.reportEntries || []), overrides: clone(value?.overrides || {}) };
}

class OrderLedgerService {
  constructor({ state, request, scope, profile }) {
    if (!state || typeof state.get !== "function" || typeof state.set !== "function" || typeof request !== "function") throw new Error("订单账本服务配置无效");
    this.state = state; this.request = request; this.scope = identifier(scope, "账本偏好范围", 300); this.profile = profile;
  }
  async read() {
    const [saved, buff, uu, steam, csv, names] = await Promise.all([
      this.state.get(["orderLedger", "priceWorkspace"]),
      this.request("/history/buff"), this.request("/history/uu"), this.request("/history/steam"), this.request("/history/csv"), this.request("/history/names"),
    ]);
    if (!object(buff?.data) || !object(uu?.data) || !object(steam?.data) || !object(csv) || !Array.isArray(csv.rows) || !object(names)) throw new Error("订单历史返回格式无效");
    const scopes = saved.orderLedger || {};
    if (!object(scopes)) throw new Error("订单账本偏好格式无效");
    const profile = this.profile ? await this.profile() : null;
    if (this.profile && !profile) throw new Error("请先选择当前终端关联账户，再查看订单与收益");
    const rawInput = this.profile ? scopeInput({ buff: buff.data, uu: uu.data, steam: steam.data, csv, names }, profile) : { buff: buff.data, uu: uu.data, steam: steam.data, csv, names };
    const input = reconcileInput(rawInput);
    const options = savedOptions(Object.hasOwn(scopes, this.scope) ? scopes[this.scope] : undefined, input);
    return { input, rawInput, scopes,
      options: this.profile ? scopeOptions(options, rawInput, profile) : options,
      quotes: saved.priceWorkspace?.rows || [], pricingSettings: Pricing.normalizeSettings(saved.priceWorkspace?.settings || {}) };
  }
  async alchemyLoad(value = {}) {
    fields(value, ["page", "search", "dateFrom", "dateTo"]);
    if (!Number.isSafeInteger(value.page ?? 1) || (value.page ?? 1) < 1 || value.search != null && (typeof value.search !== "string" || value.search.length > 500)) throw new Error("炼金查询条件无效");
    for (const key of ["dateFrom", "dateTo"]) if (value[key] && (typeof value[key] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value[key]) || !Number.isFinite(Date.parse(value[key])) || new Date(value[key]).toISOString().slice(0,10) !== value[key])) throw new Error("炼金日期无效");
    if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) throw new Error("开始日期不能晚于结束日期");
    const snapshot = await this.read();
    return require("./alchemy.cjs").buildAlchemy(snapshot.input, { ...snapshot.options, ...value });
  }
  project(snapshot, portfolioId, range = {}) {
    if (portfolioId != null) identifier(portfolioId, "账户组合");
    const buildOptions = { ...snapshot.options, quotes: snapshot.quotes,
      pricingSettings: snapshot.pricingSettings, portfolioId, dateFrom: range.dateFrom, dateTo: range.dateTo };
    const { report, prepared } = buildProfitProjection(snapshot.input, buildOptions);
    // All desktop financial views consume the same report policy and the same
    // reversible confirmations. The archive and legacy manual ledger stay intact.
    const ledgerOptions = { ...buildOptions, ...prepared.options, dateFrom: range.dateFrom, dateTo: range.dateTo };
    const result = enrichLedger(buildAggregateLedger(prepared.input, ledgerOptions), prepared.input, ledgerOptions);
    // Confirmation overlays are virtual report rows, never selectable accounts.
    result.accounts = report.accounts;
    const reports = new Map(report.groups.map(g => [g.id, g]));
    for (const g of result.groups) {
      const r = reports.get(g.id); g.report = r;
      for (const key of ["direct", "cashout"]) Object.assign(g[key], { profitCents: r[key].profitCents, knownProfitCents: r[key].knownProfitCents,
        knownProfitQuantity: r[key].includedQuantity, allocatedCostCents: r[key].costCents });
      Object.assign(g.instrument, { realizedProfitCents: r.profitCents, totalProfitCents: r.profitCents,
        knownRealizedProfitCents: r.knownProfitCents, knownRealizedQuantity: r.includedQuantity });
      g.activity = r.activity;
    }
    for (const s of [result.summary, ...result.summary.currencies]) {
      const r = Analytics.summary(report.groups.filter(g => g.currencyCode === s.currencyCode), report);
      Object.assign(s, { realizedProfitCents: r.profitCents, knownRealizedProfitCents: r.knownProfitCents, knownRealizedProfitQuantity: r.includedQuantity,
        cashoutCycleProfitCents: r.cashout.profitCents, knownCashoutCycleProfitCents: r.cashout.knownProfitCents, knownCashoutProfitQuantity: r.cashout.includedQuantity,
        cashoutAllocatedCostCents: r.cashout.costCents, directRealizedProfitCents: r.direct.profitCents, knownDirectRealizedProfitCents: r.direct.knownProfitCents,
        knownDirectProfitQuantity: r.direct.includedQuantity, netSaleQuantity: r.netSaleQuantity });
    }
    result.accountingMethod = report.method; result.accountingLabel = report.scopeNote;
    result.profitCurve = Analytics.analyze(report, report.groups, { currencyCode: "CNY", interval: "day" }).daily.map(d => ({
      date: d.date, currencyCode: "CNY", dailyRealizedProfitCents: d.profitCents,
      realizedProfitCents: d.cumulativePending ? null : d.cumulativeProfitCents,
      knownRealizedProfitCents: d.cumulativeProfitCents,
    }));
    const autoAmounts = new Map();
    for (const row of snapshot.input.csv.rows) if (row.platform === "steam" && row.sourceFormat === "steam-market-history" && row.amountSemantics === "actual") {
      const key = accountKey("csv", "steam", String(row.scope || "")); autoAmounts.set(key, (autoAmounts.get(key) || 0) + 1);
    }
    for (const account of result.accounts) if (account.source === "csv") account.autoAmountCount = autoAmounts.get(account.key) || 0;
    if (portfolioId && portfolioId !== "all" && !result.accounts.some(account => account.portfolioId === portfolioId)
      && !snapshot.options.accountLinks.some(link => link.id === portfolioId)) throw new Error("所选账户组合已不存在，请重新选择");
    return { ...result, report, profileScoped: Boolean(this.profile), options: clone(snapshot.options), pricingSettings: clone(snapshot.pricingSettings), sourceStatus: sourceStatus(snapshot.input) };
  }
  async load(payload = {}) {
    fields(payload, ["portfolioId", "dateFrom", "dateTo"]);
    await (writeQueues.get(this.state) || Promise.resolve());
    return this.project(await this.read(), payload.portfolioId, payload);
  }
  async trends(payload) {
    fields(payload, ["appid", "marketHashName", "direction", "currencyCode", "portfolioId", "accountKeys", "asOf"]);
    if (payload.portfolioId === "all") throw new Error("成交走势请明确选择一个账户组合");
    await (writeQueues.get(this.state) || Promise.resolve());
    const snapshot = await this.read(), result = this.project(snapshot, payload.portfolioId);
    if (payload.accountKeys != null && (!Array.isArray(payload.accountKeys) || payload.accountKeys.some(key => !result.accounts.some(account => account.key === key)))) throw new Error("成交走势账户不存在");
    return buildOrderTrends(result.orders, payload);
  }
  mutate(payload, update, project = snapshot => this.project(snapshot)) {
    const copy = clone(payload);
    const run = async () => {
      const snapshot = await this.read();
      const next = update(copy, snapshot);
      const result = project({ ...snapshot, options: next });
      const persisted = clone(next);
      // Automatic ownership is a rule, not a frozen list. Later synced/imported
      // accounts join on the next read, including additional same-platform accounts.
      if (persisted.accountLinkMode === "auto") delete persisted.accountLinks;
      await this.state.set({ orderLedger: { ...snapshot.scopes, [this.scope]: persisted } });
      return result;
    };
    const task = (writeQueues.get(this.state) || Promise.resolve()).then(run);
    writeQueues.set(this.state, task.catch(() => {}));
    return task;
  }
  reportProject(snapshot, range = {}) {
    if (range.portfolioId != null) identifier(range.portfolioId, "账户组合");
    return { ...buildProfitReport(snapshot.input, { ...snapshot.options, ...range }), revision: reportRevision(snapshot), sourceStatus: sourceStatus(snapshot.input) };
  }
  async reportLoad(payload = {}) {
    fields(payload, ["portfolioId", "dateFrom", "dateTo"]);
    await (writeQueues.get(this.state) || Promise.resolve());
    return this.reportProject(await this.read(), payload);
  }
  reportEntry(value, snapshot, existing) {
    identifier(value.groupId, "物品标识");
    if (!["buy", "sell"].includes(value.direction) || !["buff", "uu", "steam"].includes(value.platform)) throw new Error("买卖方向或平台无效");
    if (!Number.isSafeInteger(value.quantity) || value.quantity < 1) throw new Error("核对数量必须是正整数");
    if (!Number.isSafeInteger(value.unitPriceCents) || value.unitPriceCents < 0 || !Number.isSafeInteger(value.quantity * value.unitPriceCents)) throw new Error("核对价格必须是非负整数分，合计不能超出安全范围");
    const today = new Date(Date.now() + 28800000).toISOString().slice(0, 10);
    if (typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date) || !Number.isFinite(Date.parse(value.date)) || new Date(Date.parse(value.date)).toISOString().slice(0, 10) !== value.date || value.date > today) throw new Error("请填写有效且不晚于今天的成交日期");
    if (value.note != null && (typeof value.note !== "string" || value.note.length > 500)) throw new Error("说明不能超过 500 字");
    const entries = snapshot.options.reportEntries.filter(e => e.id !== existing?.id);
    const without = { ...snapshot.options, reportEntries: entries };
    const before = buildProfitReport(snapshot.input, without), group = before.groups.find(g => g.id === value.groupId);
    if (!group) throw new Error("物品已不存在，请刷新报告");
    if (group.portfolioId.startsWith("account:")) throw new Error("此独立账户需先在交易账本设置账户组合，再核对跨平台买卖");
    if (value.quantity > (value.direction === "buy" ? group.netSaleQuantity : group.holding.quantity)) throw new Error("核对数量超过当前净卖出或持仓数量，请刷新后重试");
    const original = buildAggregateLedger(snapshot.input, { ...snapshot.options, quotes: [] });
    const now = new Date().toISOString();
    const entry = { id: existing?.id || randomUUID(), groupId: group.id, portfolioId: group.portfolioId, appid: group.appid,
      marketHashName: group.marketHashName, name: group.name, currencyCode: group.currencyCode,
      direction: value.direction, platform: value.platform, quantity: value.quantity, unitPriceCents: value.unitPriceCents,
      date: value.date, note: value.note || "", enabled: true, createdAt: existing?.createdAt || now, updatedAt: now,
      originalQuantityOnDate: 0, history: existing ? [...(existing.history || []), { ...existing, history: undefined }] : [] };
    entry.originalQuantityOnDate = originalQuantity(original.orders, entry);
    const after = buildProfitReport(snapshot.input, { ...without, reportEntries: [...entries, entry] }).groups.find(g => g.id === group.id);
    if (value.direction === "buy" && group.netSaleQuantity - after.netSaleQuantity !== value.quantity) throw new Error("这笔买入无法覆盖相应净卖出；请检查来源平台、日期和数量");
    if (value.direction === "sell" && (group.holding.quantity - after.holding.quantity !== value.quantity || after.uncoveredQuantity > group.uncoveredQuantity)) throw new Error("这笔卖出无法由已有持仓覆盖；请检查成交日期和数量");
    return { ...snapshot.options, reportEntries: [...entries, entry] };
  }
  reportSave(payload) {
    return this.mutate(payload, (value, snapshot) => {
      fields(value, ["entryId", "revision", "groupId", "direction", "platform", "quantity", "unitPriceCents", "date", "note"]);
      if (value.revision !== reportRevision(snapshot)) throw new Error("数据已更新，请刷新收益报告后重新核对");
      const existing = value.entryId == null ? null : snapshot.options.reportEntries.find(e => e.id === value.entryId);
      if (value.entryId != null && !existing) throw new Error("核对记录已不存在");
      return this.reportEntry(value, snapshot, existing);
    }, snapshot => this.reportProject(snapshot));
  }
  reportToggle(payload) {
    return this.mutate(payload, (value, snapshot) => {
      fields(value, ["id", "enabled", "revision"]);
      if (value.revision !== reportRevision(snapshot)) throw new Error("数据已更新，请刷新收益报告后重试");
      if (typeof value.enabled !== "boolean") throw new Error("核对记录启用状态无效");
      const existing = snapshot.options.reportEntries.find(e => e.id === value.id);
      if (!existing) throw new Error("核对记录已不存在");
      if (value.enabled) return this.reportEntry(existing, snapshot, existing);
      return { ...snapshot.options, reportEntries: snapshot.options.reportEntries.map(e => e.id === value.id ? { ...e, enabled: false, updatedAt: new Date().toISOString() } : e) };
    }, snapshot => this.reportProject(snapshot));
  }
  configure(payload) {
    if (this.profile && payload && (Object.hasOwn(payload, "accountLinks") || Object.hasOwn(payload, "accountLinkMode"))) throw new Error("账户归属由当前终端关联管理，请在工作台选择账户；账本不再另行拆分平台来源");
    return this.mutate(payload, (value, snapshot) => {
      fields(value, ["accountLinks", "accountLinkMode", "csvAmountSemantics"]);
      const next = clone(snapshot.options), accounts = listAccounts(snapshot.input), known = new Map(accounts.map(account => [account.key, account]));
      if (Object.hasOwn(value, "accountLinkMode") && !["auto", "manual"].includes(value.accountLinkMode)) throw new Error("账户分组模式无效");
      if (value.accountLinkMode === "auto" && Object.hasOwn(value, "accountLinks")) throw new Error("默认同一人模式不能同时指定手动分组");
      if (value.accountLinkMode === "manual" && !Object.hasOwn(value, "accountLinks")) throw new Error("手动分组需要账户组合列表");
      if (value.accountLinkMode === "auto") { next.accountLinkMode = "auto"; next.accountLinks = automaticLinks(snapshot.input); }
      if (Object.hasOwn(value, "accountLinks")) {
        if (!Array.isArray(value.accountLinks) || value.accountLinks.length > accounts.length) throw new Error("账户组合格式无效");
        next.accountLinkMode = "manual";
        const ids = new Set(), used = new Set();
        next.accountLinks = value.accountLinks.map(link => {
          fields(link, ["id", "name", "accountKeys"]);
          const id = identifier(link.id, "账户组合标识", 200);
          if (id === "all" || id.startsWith("account:") || ids.has(id)) throw new Error("账户组合标识重复或为保留值");
          ids.add(id);
          if (!Array.isArray(link.accountKeys) || !link.accountKeys.length) throw new Error("每个账户组合至少需要一个账户");
          for (const key of link.accountKeys) {
            const account = known.get(key);
            if (!account) throw new Error("账户组合包含未知账户");
            if (used.has(key)) throw new Error("同一账户不能重复或属于多个组合");
            used.add(key);
          }
          return { id, ...(link.name == null ? {} : { name: identifier(link.name, "账户组合名称", 100) }), accountKeys: [...link.accountKeys] };
        });
      }
      if (Object.hasOwn(value, "csvAmountSemantics")) {
        if (!object(value.csvAmountSemantics)) throw new Error("CSV 金额口径格式无效");
        next.csvAmountSemantics = {};
        for (const [key, semantics] of Object.entries(value.csvAmountSemantics)) {
          if (known.get(key)?.source !== "csv") throw new Error("CSV 金额口径只能设置已知 CSV 账户");
          if (!["actual", "unknown"].includes(semantics)) throw new Error("CSV 金额口径仅支持 actual 或 unknown");
          next.csvAmountSemantics[key] = semantics;
        }
      }
      return next;
    });
  }
  exclude(payload) {
    return this.mutate(payload, (value, snapshot) => {
      fields(value, ["id", "excluded"]); identifier(value.id, "持仓标识");
      if (typeof value.excluded !== "boolean") throw new Error("持仓移除状态无效");
      const result = this.project(snapshot);
      if (!result.groups.some(group => group.id === value.id)) throw new Error("物品分组不存在，请刷新后重试");
      const excluded = new Set(snapshot.options.excludedHoldingIds);
      if (value.excluded) excluded.add(value.id); else excluded.delete(value.id);
      return { ...snapshot.options, excludedHoldingIds: [...excluded] };
    });
  }
  watch(payload) {
    return this.mutate(payload, (value, snapshot) => {
      fields(value, ["id", "watched"]); identifier(value.id, "物品标识");
      if (typeof value.watched !== "boolean") throw new Error("自选状态无效");
      if (!this.project(snapshot).groups.some(group => group.id === value.id)) throw new Error("物品分组不存在，请刷新后重试");
      const ids = new Set(snapshot.options.watchlistIds);
      if (value.watched) ids.add(value.id); else ids.delete(value.id);
      return { ...snapshot.options, watchlistIds: [...ids] };
    });
  }
  override(payload) {
    return this.mutate(payload, (value, snapshot) => {
      fields(value, ["id", "actualTotalCents"]); identifier(value.id, "原始订单标识");
      if (!Object.hasOwn(value, "actualTotalCents") || value.actualTotalCents !== null && (!Number.isSafeInteger(value.actualTotalCents) || value.actualTotalCents < 0)) throw new Error("实际金额必须是非负整数分或空值");
      if (!this.project(snapshot).orders.some(order => order.sourceId === value.id)) throw new Error("可核对的原始订单不存在，请刷新后重试");
      const overrides = { ...snapshot.options.overrides };
      // A cleared correction restores the archive/confirmed CSV amount. Unknown
      // source amounts remain unknown without persisting a synthetic null value.
      if (value.actualTotalCents === null) delete overrides[value.id];
      else overrides[value.id] = { actualTotalCents: value.actualTotalCents };
      return { ...snapshot.options, overrides };
    });
  }
}

module.exports = { OrderLedgerService, sourceStatus };
