"use strict";
const { buildAggregateLedger } = require("./order-ledger.cjs");
const { category: inferCategory } = require("./buff-analysis.cjs");

const day = row => row.timePrecision === "day" ? row.tradedAt : new Date(row.timeStart + 8 * 3600000).toISOString().slice(0, 10);
const keyOf = row => JSON.stringify([row.portfolioId, row.appid, row.marketHashName, row.currencyCode]);
const scopeOf = row => JSON.stringify([row.portfolioId, row.currencyCode]);
const total = values => values.reduce((a, b) => a + b, 0);
const complete = values => values.some(v => v == null) ? null : total(values);
const scaled = (cents, quantity, denominator) => {
  if (cents == null || !denominator) return null;
  const value = Number((BigInt(cents) * BigInt(quantity) + BigInt(denominator) / 2n) / BigInt(denominator));
  return Number.isSafeInteger(value) ? value : null;
};
const reasonLabels = { no_buy: "无同名买入记录", later_buy: "买入晚于卖出", exhausted: "此前买入数量不足" };
const gameLabels = { 730: "CS2", 570: "Dota 2", 753: "Steam 社区物品", 578080: "PUBG" };
const folded = value => String(value || "").normalize("NFC").replace(/\s+/g, " ").trim();

function itemCategory(rows, group) {
  const categories = new Map();
  for (const row of rows) if (row.category) {
    const name = ({ "箱子 / 容器": "箱子 / 容器", "匕首": "刀", "刀具": "刀", "冲锋枪": "微型冲锋枪" })[row.category] || row.category;
    categories.set(name, (categories.get(name) || 0) + row.quantity);
  }
  if (categories.size) return [...categories].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))[0][0];
  if (group.appid === 753) return "Steam 社区物品";
  if (group.appid === 578080) return "PUBG 饰品";
  const inferred = inferCategory(group);
  return inferred === "未分类" && group.appid === 570 ? "Dota 2 饰品" : inferred;
}

function sourceCoverage(input, orders) {
  const ranges = new Map();
  for (const row of orders) {
    const key = JSON.stringify([row.accountKey, row.appid, row.direction]);
    const date = day(row), range = ranges.get(key) || { platform: row.platform, appid: row.appid, direction: row.direction, accountKey: row.accountKey, firstDate: date, lastDate: date, quantity: 0, complete: null };
    range.firstDate = range.firstDate < date ? range.firstDate : date; range.lastDate = range.lastDate > date ? range.lastDate : date; range.quantity += row.quantity; ranges.set(key, range);
  }
  for (const source of ["buff", "uu", "steam"]) {
    const value = input[source]?.data || input[source];
    for (const account of Object.values(value?.accounts || {})) for (const run of account.runs || []) {
      if (run.channel !== "history") continue;
      const id = account.account?.id || account.records?.[0]?.accountId;
      const key = JSON.stringify([JSON.stringify([source, source, id]), Number(run.appid), run.direction]);
      if (ranges.has(key)) Object.assign(ranges.get(key), { complete: run.complete === true, lastSyncedAt: run.syncedAt });
    }
  }
  return [...ranges.values()];
}

function diagnoseGaps(result, rowsByKey, coverage) {
  // Similar spelling is only evidence to inspect. Wear, quality, StatTrak,
  // souvenir and game remain part of the full identity; never fuzzy-merge them.
  const aliases = new Map();
  for (const group of result.groups) {
    const rows = rowsByKey.get(keyOf(group)) || [];
    for (const name of new Set([group.name, ...rows.map(row => row.name)])) {
      const key = JSON.stringify([group.portfolioId, group.appid, group.currencyCode, folded(name)]);
      if (!aliases.has(key)) aliases.set(key, new Set());
      aliases.get(key).add(group);
    }
  }
  const groups = [];
  for (const group of result.groups) {
    if (!group.uncoveredSaleQuantity) continue;
    const rows = rowsByKey.get(keyOf(group)) || [], buys = rows.filter(r => r.direction === "buy"), sales = rows.filter(r => r.direction === "sell");
    const buyDates = buys.map(day).sort(), events = group.activity.filter(e => e.route === "uncoveredCash" || e.route === "uncoveredSteam");
    const counts = { no_buy: 0, later_buy: 0, exhausted: 0 };
    const daily = events.map(event => {
      const reason = !buys.length ? "no_buy" : buyDates[0] > event.date ? "later_buy" : "exhausted";
      counts[reason] += event.quantity;
      return { date: event.date, platform: event.route === "uncoveredSteam" ? "steam" : "cash", quantity: event.quantity, proceedsCents: event.totalCents, reason, label: reasonLabels[reason] };
    });
    const candidates = new Set();
    for (const name of new Set([group.name, ...rows.map(row => row.name)])) {
      const key = JSON.stringify([group.portfolioId, group.appid, group.currencyCode, folded(name)]);
      for (const other of aliases.get(key) || []) if (other.id !== group.id && (rowsByKey.get(keyOf(other)) || []).some(r => r.direction === "buy")) candidates.add(other.marketHashName);
    }
    // Exact full English names on both sides settle identity even when a
    // display translation is shared by different wear/quality variants.
    const mappingCandidates = rows.some(r => r.originalNameCategory) ? [...candidates] : [];
    const cashCoverage = coverage.filter(r => r.appid === group.appid && r.direction === "buy" && r.platform !== "steam");
    const gap = { id: group.id, name: group.name, marketHashName: group.marketHashName, appid: group.appid, portfolioId: group.portfolioId, currencyCode: group.currencyCode,
      category: group.category, quantity: group.uncoveredSaleQuantity, cashQuantity: group.uncoveredCash.quantity, steamQuantity: group.uncoveredSteam.quantity,
      cashProceedsCents: group.uncoveredCash.totalCents, steamProceedsCents: group.uncoveredSteam.totalCents,
      buyQuantity: total(buys.map(r => r.quantity)), saleQuantity: total(sales.map(r => r.quantity)), firstBuy: buyDates[0] || null, lastBuy: buyDates.at(-1) || null,
      firstMissingSale: daily[0]?.date || null, lastMissingSale: daily.at(-1)?.date || null, counts, events: daily,
      classification: mappingCandidates.length ? "mapping_candidate" : "source_history", mappingCandidates,
      mappingEvidence: mappingCandidates.length ? "原名有多个精确别名候选，未自动合并" : rows.some(r => r.originalNameCategory) ? "保留平台完整原名；未发现另一个同名买入组" : "完整市场名已一致；未发现名称拆组证据",
      coverageEvidence: ![730, 570].includes(group.appid) ? "当前 BUFF / 悠悠同步不覆盖该游戏的现金订单" : cashCoverage.some(r => r.complete === false) ? "现金平台历史尚未读完" : cashCoverage.length && cashCoverage.every(r => r.complete) ? "已读取平台当前可返回的历史；仍可能缺少更早取得、掉落、赠送或站外记录" : "现有记录无法证明所有买入来源均已覆盖" };
    group.gap = gap; groups.push(gap);
  }
  groups.sort((a, b) => b.quantity - a.quantity || a.marketHashName.localeCompare(b.marketHashName));
  return { quantity: total(groups.map(g => g.quantity)), groupCount: groups.length, mappingCandidateQuantity: total(groups.filter(g => g.classification === "mapping_candidate").map(g => g.quantity)),
    sourceHistoryQuantity: total(groups.filter(g => g.classification === "source_history").map(g => g.quantity)),
    reasons: Object.entries(reasonLabels).map(([code, label]) => ({ code, label, quantity: total(groups.map(g => g.counts[code])) })),
    games: [...new Set(groups.map(g => g.appid))].map(appid => ({ appid, label: gameLabels[appid] || `游戏 ${appid}`, quantity: total(groups.filter(g => g.appid === appid).map(g => g.quantity)) })),
    coverage, groups, automaticMergeCount: 0 };
}

function holdingValue(group, rows, dateTo = "") {
  if (!group.remainingQuantity || group.excluded) return { valueCents: 0, source: "none", label: group.excluded ? "已移出持仓统计" : "已清仓", asOf: null };
  const asOf = dateTo ? Date.parse(dateTo + "T23:59:59.999+08:00") : Infinity;
  const routes = (group.theoretical?.routes || []).filter(r => {
    const timeKey = { buffAsk: "buffUpdatedAt", buffBid: "buffBuyUpdatedAt", steam: "steamUpdatedAt", uu: "uuUpdatedAt" }[r.id];
    return r.proceedsCents != null && (group.theoretical.quote?.[timeKey] ?? Infinity) <= asOf;
  });
  if (routes.length) {
    const best = routes.reduce((a, b) => a.proceedsCents >= b.proceedsCents ? a : b);
    return { valueCents: best.proceedsCents, source: "quote", label: best.label + "报价估值", asOf: null };
  }
  for (const platform of ["cash", "steam"]) {
    const sales = rows.filter(r => r.direction === "sell" && (platform === "cash" ? r.platform !== "steam" : r.platform === "steam"));
    if (!sales.length) continue;
    const lastDay = sales.map(day).sort().at(-1), latest = sales.filter(r => day(r) === lastDay);
    if (latest.some(r => r.actualTotalCents == null)) continue;
    let value = scaled(total(latest.map(r => r.actualTotalCents)), group.remainingQuantity, total(latest.map(r => r.quantity)));
    if (platform === "steam") value = value == null ? null : Math.round(value * group.estimatedCashoutRatio);
    if (!Number.isSafeInteger(value)) continue;
    return { valueCents: value, source: platform === "cash" ? "historical-cash-sale" : "historical-steam-sale", label: platform === "cash" ? "最近现金成交日均价估值" : "最近 Steam 成交日均价 × 提现折扣", asOf: lastDay };
  }
  if (group.cashHolding.quantity === 0) return { valueCents: group.steamHolding.estimatedValueCents, source: "steam-face", label: "Steam 买入面值 × 历史提现折扣", asOf: null };
  return { valueCents: null, source: "missing", label: "暂无有效报价或同名成交估值", asOf: null };
}

function instrument(group, modeled, rows, watchlist, dateTo) {
  const realized = group.uncoveredCash.quantity ? null : complete([group.direct.profitCents, group.cashout.profitCents]);
  const modeledRealized = group.uncoveredCash.quantity ? null : complete([modeled.direct.profitCents, modeled.cashout.profitCents]);
  const valuation = holdingValue(group, rows, dateTo), cost = group.excluded ? 0 : group.inventoryCostCents, modeledCost = group.excluded ? 0 : modeled.inventoryCostCents;
  const unrealized = valuation.valueCents != null && cost != null ? valuation.valueCents - cost : null;
  const modeledUnrealized = valuation.valueCents != null && modeledCost != null ? valuation.valueCents - modeledCost : null;
  const dates = rows.map(day).sort();
  return { watched: watchlist.has(group.id), realizedProfitCents: realized,
    knownRealizedProfitCents: group.direct.knownProfitCents + group.cashout.knownProfitCents,
    knownRealizedQuantity: group.direct.knownProfitQuantity + group.cashout.knownProfitQuantity,
    modeledRealizedProfitCents: modeledRealized,
    knownModeledRealizedProfitCents: modeled.direct.knownProfitCents + modeled.cashout.knownProfitCents,
    modeledCycleProfitCents: modeled.cashout.profitCents, modeledInventoryCostCents: modeledCost,
    unrealizedProfitCents: unrealized, modeledUnrealizedProfitCents: modeledUnrealized,
    totalProfitCents: complete([realized, unrealized]), modeledTotalProfitCents: complete([modeledRealized, modeledUnrealized]),
    valuation, firstTradeDate: dates[0] || null, lastTradeDate: dates.at(-1) || null,
    platforms: [...new Set(rows.map(r => r.platform))],
    status: group.excluded ? "excluded" : group.remainingQuantity ? "holding" : "closed" };
}

function enrichLedger(result, input, options = {}) {
  const rowsByKey = new Map();
  for (const row of result.orders) { const key = keyOf(row); if (!rowsByKey.has(key)) rowsByKey.set(key, []); rowsByKey.get(key).push(row); }
  for (const group of result.groups) group.category = itemCategory(rowsByKey.get(keyOf(group)) || [], group);
  result.diagnostics = diagnoseGaps(result, rowsByKey, sourceCoverage(input, result.orders));
  // Samples stop at the selected end date; changing only dateFrom must not
  // change the opening wallet or its estimated cost. No configured rate is
  // allowed to masquerade as observed historical acquisition cost.
  const history = options.dateFrom ? buildAggregateLedger(input, { ...options, dateFrom: "" }) : result;
  const rates = new Map();
  for (const group of history.groups) if (group.knife.knownCoveredSteamReceivedCents > 0) {
    const key = scopeOf(group), rate = rates.get(key) || { cash: 0, face: 0, quantity: 0 };
    rate.cash += group.knife.knownCoveredCashSpentCents; rate.face += group.knife.knownCoveredSteamReceivedCents; rate.quantity += group.knife.knownCoveredQuantity; rates.set(key, rate);
  }
  for (const rate of rates.values()) rate.ratio = rate.cash / rate.face;
  const modeled = history.groups.some(g => g.uncoveredSteam.quantity) && rates.size ? buildAggregateLedger(input, options, rates) : result;
  const modelGroups = new Map(modeled.groups.map(g => [g.id, g])), watchlist = new Set(options.watchlistIds || []);
  for (const group of result.groups) group.instrument = instrument(group, modelGroups.get(group.id) || group, rowsByKey.get(keyOf(group)) || [], watchlist, options.dateTo);
  result.fundingEstimate = { method: "historical-knife-rate", label: "未知 Steam 卖出来源按截至日历史加权挂刀折扣估算",
    description: "仅对缺少买入来源的 Steam 卖出余额估算成本，再沿钱包与持仓均价结转；不补造买入，不估算来源不明的现金卖出利润。",
    assumptions: modeled.fundingScenario?.assumptions || [],
    samples: [...rates].map(([key, rate]) => ({ key, ...rate })),
    walletRatio: modeled.summary.walletRatio, walletCashBasisCents: modeled.summary.walletCashBasisCents,
    walletUnrealizedProfitCents: modeled.summary.walletUnrealizedProfitCents,
    cashoutCycleProfitCents: modeled.summary.cashoutCycleProfitCents,
    knownRealizedProfitCents: modeled.summary.knownRealizedProfitCents,
    realizedProfitCents: modeled.summary.realizedProfitCents,
    steamHoldingUnrealizedProfitCents: modeled.summary.steamHoldingUnrealizedProfitCents,
    used: Boolean(modeled.fundingScenario?.assumptions.length) };
  result.categories = [...new Set(result.groups.map(g => g.category))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  result.games = [...new Set(result.groups.map(g => g.appid))].map(appid => ({ appid, label: gameLabels[appid] || `游戏 ${appid}` }));
  return result;
}
module.exports = { enrichLedger, itemCategory, diagnoseGaps, holdingValue };
