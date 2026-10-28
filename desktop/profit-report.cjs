"use strict";
// A separate report policy. It never writes imported orders, confirmed trades,
// wallet cost bases or the existing ledger's reconciliation preferences.
const { createHash } = require("node:crypto");
const { buildAggregateLedger, accountKey, sourceId } = require("./order-ledger.cjs");
const { itemCategory } = require("./order-ledger-insights.cjs");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const keyOf = r => JSON.stringify([r.portfolioId, r.appid, r.marketHashName, r.currencyCode]);
const scopeOf = r => JSON.stringify([r.portfolioId, r.currencyCode]);
const dayOf = r => r.timePrecision === "day" ? r.tradedAt : new Date(r.timeStart + 28800000).toISOString().slice(0, 10);
const sum = values => { const n = values.reduce((a, b) => a + b, 0); if (!Number.isSafeInteger(n)) throw new Error("报告金额或数量超出安全范围"); return n; };
const complete = values => values.some(v => v == null) ? null : sum(values);
const ratioCost = (face, cash, received) => {
  const n = Number(BigInt(face) * BigInt(cash) / BigInt(received));
  if (!Number.isSafeInteger(n)) throw new Error("报告折扣成本超出安全范围");
  return n;
};
function reportRevision(snapshot) {
  // The CSV archive's importedAt envelope is its read time, not a data revision.
  // Guard the order content used by the report, so a fresh GET alone cannot
  // invalidate a price confirmation. Actual order/name/option changes still do.
  const input = { ...snapshot.input, csv: { rows: snapshot.input.csv?.rows || [] } };
  return hash([input, snapshot.options]);
}
function originalQuantity(orders, entry) {
  return sum(orders.filter(r => keyOf(r) === keyOf(entry) && r.platform === entry.platform && r.direction === entry.direction && dayOf(r) === entry.date).map(r => r.quantity));
}
function prepareInput(input, options, base) {
  const entries = options.reportEntries || [], groups = new Map(base.groups.map(g => [g.id, g]));
  const next = { ...input, csv: { ...(input.csv || {}), rows: [...(input.csv?.rows || [])] } };
  const links = structuredClone(options.accountLinks || []), overrides = { ...options.overrides };
  const states = entries.map(entry => {
    const group = groups.get(entry.groupId);
    let issue = !group || keyOf(entry) !== keyOf(group) ? "账户组合或名称已变化，请重新核对" : "";
    if (!issue && originalQuantity(base.orders, entry) > entry.originalQuantityOnDate) issue = "同名同日新增平台记录，已暂停计入，避免重复计算；请重新核对";
    const active = entry.enabled !== false && !issue;
    if (active) {
      const scope = `profit-report:${entry.portfolioId}`, key = `profit-report:${entry.id}`, ak = accountKey("csv", entry.platform, scope);
      let link = links.find(l => l.id === entry.portfolioId);
      if (!link) { link = { id: entry.portfolioId, name: entry.portfolioId, accountKeys: [] }; links.push(link); }
      if (!link.accountKeys.includes(ak)) link.accountKeys.push(ak);
      next.csv.rows.push({ key, scope, platform: entry.platform, appid: entry.appid, marketHashName: entry.marketHashName, itemName: entry.name,
        category: group.category, type: entry.direction === "buy" ? "purchase" : "sale", quantity: entry.quantity, currency: entry.currencyCode,
        totalCents: entry.unitPriceCents * entry.quantity, date: entry.date, sourceTime: entry.date, sourceFormat: "profit-report-confirmation" });
      overrides[sourceId("csv", key)] = { actualTotalCents: entry.unitPriceCents * entry.quantity };
    }
    return { ...entry, active, issue };
  });
  return { input: next, options: { ...options, accountLinks: links, overrides }, entries: states };
}
function route(events) {
  const profits = events.filter(e => e.profitCents != null);
  return { quantity: sum(events.map(e => e.quantity)), proceedsCents: complete(events.map(e => e.totalCents)), knownProceedsCents: sum(events.map(e => e.knownTotalCents)),
    costCents: complete(events.map(e => e.reportCostCents)), steamCostCents: complete(events.map(e => e.steamCostCents)),
    profitCents: complete(events.map(e => e.profitCents)), knownProfitCents: sum(profits.map(e => e.profitCents)),
    includedQuantity: sum(profits.map(e => e.quantity)), pendingQuantity: sum(events.filter(e => e.profitCents == null).map(e => e.quantity)),
    firstDate: events.map(e => e.date).sort()[0] || "", lastDate: events.map(e => e.date).sort().at(-1) || "" };
}
function buildProfitProjection(input, options = {}) {
  // Build the original all-date registry before adding report-only confirmations.
  // No confirmation is ever made into a source archive row.
  const base = buildAggregateLedger(input, { ...options, dateFrom: "", dateTo: "", portfolioId: undefined, quotes: [] });
  const prepared = prepareInput(input, options, base);
  const full = buildAggregateLedger(prepared.input, { ...prepared.options, dateFrom: "", quotes: [] });
  // Validate the start date with the same date contract as the ledger.
  const from = options.dateFrom || "", to = options.dateTo || "";
  if (from && (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(Date.parse(from)) || new Date(Date.parse(from)).toISOString().slice(0, 10) !== from)) throw new Error("开始日期无效");
  if (from && to && from > to) throw new Error("开始日期不能晚于结束日期");
  const inPeriod = e => !from || e.date >= from;
  const rowsByKey = new Map();
  for (const r of full.orders) { const key = keyOf(r); if (!rowsByKey.has(key)) rowsByKey.set(key, []); rowsByKey.get(key).push(r); }
  const samples = new Map();
  for (const g of full.groups) for (const e of g.activity) if (e.route === "knife" && e.allocatedCostCents != null && e.totalCents != null) {
    const key = scopeOf(g), s = samples.get(key) || { portfolioId: g.portfolioId, currencyCode: g.currencyCode, cashCents: 0, steamCents: 0, quantity: 0 };
    s.cashCents = sum([s.cashCents, e.allocatedCostCents]); s.steamCents = sum([s.steamCents, e.totalCents]); s.quantity += e.quantity; samples.set(key, s);
  }
  for (const s of samples.values()) s.ratio = s.steamCents > 0 ? s.cashCents / s.steamCents : null;
  // Cumulative integer allocation makes the sum exact, including split exports
  // and tiny trades. Run before the date-from filter to preserve opening cents.
  const cumulative = new Map(), events = full.groups.flatMap(g => g.activity.map(e => ({ ...e, groupId: g.id, scope: scopeOf(g) })))
    .sort((a, b) => a.date.localeCompare(b.date) || a.groupId.localeCompare(b.groupId) || a.route.localeCompare(b.route));
  for (const e of events) {
    e.reportCostCents = null; e.profitCents = null;
    if (e.route === "direct") {
      e.reportCostCents = e.allocatedCostCents;
      if (e.totalCents != null && e.reportCostCents != null) e.profitCents = e.totalCents - e.reportCostCents;
    }
    if (e.route === "knife") e.reportCostCents = e.allocatedCostCents;
    if (e.route === "cashout") {
      const s = samples.get(e.scope), prior = cumulative.get(e.scope) || { face: 0, cost: 0 };
      if (e.steamCostCents === 0) e.reportCostCents = 0;
      else if (e.steamCostCents != null && s?.ratio != null) {
        const face = sum([prior.face, e.steamCostCents]), cost = ratioCost(face, s.cashCents, s.steamCents);
        e.reportCostCents = cost - prior.cost; cumulative.set(e.scope, { face, cost });
      }
      if (e.totalCents != null && e.reportCostCents != null) e.profitCents = e.totalCents - e.reportCostCents;
    }
  }
  const eventsByGroup = new Map();
  for (const e of events) if (inPeriod(e)) { if (!eventsByGroup.has(e.groupId)) eventsByGroup.set(e.groupId, []); eventsByGroup.get(e.groupId).push(e); }
  const groups = full.groups.map(g => {
    const history = rowsByKey.get(keyOf(g)) || [], period = history.filter(r => inPeriod({ date: dayOf(r) }));
    const activity = eventsByGroup.get(g.id) || [], select = names => activity.filter(e => names.includes(e.route));
    const direct = route(select(["direct"])), cashout = route(select(["cashout"])), knife = route(select(["knife"]));
    const netCash = route(select(["uncoveredCash"])), netSteam = route(select(["uncoveredSteam", "steamReturn"]));
    const cashBuys = period.filter(r => r.direction === "buy" && r.platform !== "steam"), sample = samples.get(scopeOf(g));
    const buyDates = history.filter(r => r.direction === "buy").map(dayOf).sort();
    const tradeDays = new Map();
    for (const r of period) {
      const date = dayOf(r), key = JSON.stringify([date, r.platform, r.direction]);
      if (!tradeDays.has(key)) tradeDays.set(key, { date, platform: r.platform, direction: r.direction, quantity: 0, totalCents: 0, knownTotalCents: 0 });
      const d = tradeDays.get(key); d.quantity = sum([d.quantity, r.quantity]);
      d.totalCents = complete([d.totalCents, r.actualTotalCents]); d.knownTotalCents = sum([d.knownTotalCents, r.actualTotalCents ?? 0]);
    }
    return { id: g.id, portfolioId: g.portfolioId, appid: g.appid, name: g.name, marketHashName: g.marketHashName, currencyCode: g.currencyCode,
      category: itemCategory(history, g), direct, cashout, knife, netCash, netSteam, cashInvestmentCents: complete(cashBuys.map(r => r.actualTotalCents)),
      knownCashInvestmentCents: sum(cashBuys.map(r => r.actualTotalCents || 0)), buyQuantity: sum(period.filter(r => r.direction === "buy").map(r => r.quantity)),
      holding: { quantity: g.remainingQuantity, cashQuantity: g.cashHolding.quantity, cashCostCents: g.cashHolding.costCents, steamQuantity: g.steamHolding.quantity, steamFaceCents: g.steamHolding.faceCostCents },
      excluded: g.excluded, trades: [...tradeDays.values()].sort((a, b) => a.date.localeCompare(b.date)),
      saleQuantity: sum(activity.map(e => e.quantity)), steamSaleQuantity: knife.quantity + netSteam.quantity,
      netSaleQuantity: netCash.quantity + netSteam.quantity, uncoveredQuantity: g.uncoveredSaleQuantity,
      steamReturnQuantity: sum(select(["steamReturn"]).map(e => e.quantity)), firstBuyDate: buyDates[0] || "", lastBuyDate: buyDates.at(-1) || "",
      profitCents: complete([direct.profitCents, cashout.profitCents]), knownProfitCents: sum([direct.knownProfitCents, cashout.knownProfitCents]),
      pendingQuantity: direct.pendingQuantity + cashout.pendingQuantity, includedQuantity: direct.includedQuantity + cashout.includedQuantity,
      basisRatio: sample?.ratio ?? null, knifeRatio: knife.proceedsCents > 0 && knife.costCents != null ? knife.costCents / knife.proceedsCents : null,
      cashoutRatio: cashout.steamCostCents > 0 && cashout.proceedsCents != null ? cashout.proceedsCents / cashout.steamCostCents : null,
      manualEntryCount: prepared.entries.filter(e => e.active && e.groupId === g.id && (!to || e.date <= to)).length, activity };
  });
  const currencies = [...new Set(groups.map(g => g.currencyCode))].sort().map(currencyCode => {
    const gs = groups.filter(g => g.currencyCode === currencyCode), es = gs.flatMap(g => g.activity), direct = route(es.filter(e => e.route === "direct")), cashout = route(es.filter(e => e.route === "cashout"));
    const ss = [...samples.values()].filter(s => s.currencyCode === currencyCode), cash = sum(ss.map(s => s.cashCents)), steam = sum(ss.map(s => s.steamCents));
    return { currencyCode, cashInvestmentCents: complete(gs.map(g => g.cashInvestmentCents)), knownCashInvestmentCents: sum(gs.map(g => g.knownCashInvestmentCents)), direct, cashout,
      profitCents: complete([direct.profitCents, cashout.profitCents]), knownProfitCents: sum([direct.knownProfitCents, cashout.knownProfitCents]),
      pendingQuantity: direct.pendingQuantity + cashout.pendingQuantity, holdingQuantity: sum(gs.map(g => g.holding.quantity)), netSaleQuantity: sum(gs.map(g => g.netSaleQuantity)),
      netCashCents: complete(gs.map(g => g.netCash.proceedsCents)), netSteamCents: complete(gs.map(g => g.netSteam.proceedsCents)),
      steamSaleQuantity: sum(gs.map(g => g.steamSaleQuantity)), coveredKnifeQuantity: sum(gs.map(g => g.knife.quantity)),
      historicalKnifeRatio: steam > 0 ? cash / steam : null,
      cashoutRatio: cashout.steamCostCents > 0 && cashout.proceedsCents != null ? cashout.proceedsCents / cashout.steamCostCents : null };
  });
  const report = { version: 2, method: "confirmed-knife-discount-spread", dateFrom: from, dateTo: to, computedAt: full.computedAt, groups, currencies, samples: [...samples.values()],
    wallets: full.wallets.map(w => ({ portfolioId: w.portfolioId, currencyCode: w.currencyCode, faceBalanceCents: w.faceBalanceCents, cashBasisCents: w.cashBasisCents })),
    entries: prepared.entries, accounts: base.accounts, accountLinks: options.accountLinks || [], ignoredCount: full.ignoredCount,
    quality: { unknownAmountCount: full.quality.unknownAmountCount, missingTimeCount: full.quality.missingTimeCount, unresolvedNameCount: full.quality.unresolvedNameCount },
    scopeNote: "总收益 = 直接盈亏 + 提现折扣差收益。持仓、净卖出和未提现余额不计利润。挂刀仅形成余额，不重复记收益。",
    formula: "提现收益 = Steam 买入金额 ×（现金净到账 / Steam 买入金额 − 同账户组合、同币种截至结束日的历史加权挂刀折扣）。" };
  return { report, prepared };
}
function buildProfitReport(input, options = {}) { return buildProfitProjection(input, options).report; }
module.exports = { buildProfitReport, buildProfitProjection, reportRevision, originalQuantity, keyOf };
