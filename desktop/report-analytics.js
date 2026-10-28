"use strict";
// Shared pure report aggregation for all three desktop views. No writes, FX,
// funding estimates or chart-specific profit recalculation.
(function (root, factory) {
  const api = factory(); if (typeof module === "object" && module.exports) module.exports = api;
  else root.BuffReportAnalytics = api;
})(typeof self === "object" ? self : globalThis, () => {
  const DAY = 86400000;
  const sum = values => { const n = values.reduce((a, b) => a + b, 0); if (!Number.isSafeInteger(n)) throw new Error("报表合计超出安全范围"); return n; };
  const complete = values => values.some(v => v == null) ? null : sum(values);
  const shown = (value, known, count) => value ?? (count > 0 ? known : null);
  const scope = g => JSON.stringify([g.portfolioId, g.currencyCode]);
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  function dateRange(dates) {
    let firstDate = "", lastDate = "";
    for (const date of dates) if (date) {
      if (!firstDate || date < firstDate) firstDate = date;
      if (!lastDate || date > lastDate) lastDate = date;
    }
    return { firstDate, lastDate };
  }
  function tradeDates(groups, routes = ["direct", "cashout", "knife", "netCash", "netSteam"]) {
    // Report dates already use actual Beijing trading days. Historical buys
    // include opening stock; sale dates follow the selected period and routes.
    // These ranges describe a name group, never an individual lot pairing.
    return {
      buy: dateRange(groups.flatMap(g => [g.firstBuyDate, g.lastBuyDate])),
      sell: dateRange(groups.flatMap(g => routes.flatMap(route => [g[route]?.firstDate, g[route]?.lastDate]))),
    };
  }
  function period(date, interval) {
    if (interval === "month") return date.slice(0, 7) + "-01";
    if (interval === "week") { const ms = Date.parse(date), offset = (new Date(ms).getUTCDay() + 6) % 7; return day(ms - offset * DAY); }
    return date;
  }
  function summary(groups, report) {
    const route = name => {
      const rows = groups.map(g => g[name]);
      return { quantity: sum(rows.map(r => r.quantity)), proceedsCents: complete(rows.map(r => r.proceedsCents)), costCents: complete(rows.map(r => r.costCents)),
        steamCostCents: complete(rows.map(r => r.steamCostCents)), profitCents: complete(rows.map(r => r.profitCents)), knownProfitCents: sum(rows.map(r => r.knownProfitCents)),
        includedQuantity: sum(rows.map(r => r.includedQuantity)), pendingQuantity: sum(rows.map(r => r.pendingQuantity)) };
    };
    const keys = new Set(groups.map(scope)), samples = report.samples.filter(s => keys.has(scope(s))), face = sum(samples.map(s => s.steamCents));
    const direct = route("direct"), cashout = route("cashout");
    return { profitCents: complete(groups.map(g => g.profitCents)), knownProfitCents: sum(groups.map(g => g.knownProfitCents)), includedQuantity: sum(groups.map(g => g.includedQuantity)),
      pendingQuantity: sum(groups.map(g => g.pendingQuantity)), cashInvestmentCents: complete(groups.map(g => g.cashInvestmentCents)), knownCashInvestmentCents: sum(groups.map(g => g.knownCashInvestmentCents)),
      direct, cashout, knife: route("knife"), netCash: route("netCash"), netSteam: route("netSteam"),
      holdingQuantity: sum(groups.map(g => g.holding.quantity)), excludedHoldingQuantity: sum(groups.filter(g => g.excluded).map(g => g.holding.quantity)),
      cashHoldingCents: complete(groups.map(g => g.holding.cashCostCents)), steamHoldingFaceCents: complete(groups.map(g => g.holding.steamFaceCents)),
      netSaleQuantity: sum(groups.map(g => g.netSaleQuantity)), buyQuantity: sum(groups.map(g => g.buyQuantity)), saleQuantity: sum(groups.map(g => g.saleQuantity)),
      historicalKnifeRatio: face > 0 ? sum(samples.map(s => s.cashCents)) / face : null,
      cashoutRatio: cashout.steamCostCents > 0 && cashout.proceedsCents != null ? cashout.proceedsCents / cashout.steamCostCents : null };
  }
  const fields = ["cashInvestmentCents", "cashReceiptsCents", "directProfitCents", "cashoutProfitCents", "profitCents", "knownCashInvestmentCents", "knownCashReceiptsCents", "knownDirectProfitCents", "knownCashoutProfitCents", "knownProfitCents", "includedQuantity", "pendingQuantity", "directIncludedQuantity", "cashoutIncludedQuantity", "directPendingQuantity", "cashoutPendingQuantity", "buyQuantity", "saleQuantity", "buffQuantity", "uuQuantity", "steamQuantity", "knifeQuantity", "cashoutQuantity", "directQuantity", "netQuantity"];
  const blank = date => Object.fromEntries([["date", date], ...fields.map(k => [k, 0])]);
  function analyze(report, groups, { currencyCode, interval = "week", range = "all" } = {}) {
    const currencies = [...new Set(groups.map(g => g.currencyCode))].sort();
    const currency = currencyCode || currencies[0] || "CNY", gs = groups.filter(g => g.currencyCode === currency), map = new Map();
    const get = date => { if (!map.has(date)) map.set(date, blank(date)); return map.get(date); };
    for (const g of gs) {
      for (const t of g.trades || []) {
        const d = get(t.date); d[t.direction === "buy" ? "buyQuantity" : "saleQuantity"] += t.quantity;
        if (["buff", "uu", "steam"].includes(t.platform)) d[t.platform + "Quantity"] += t.quantity;
        if (t.direction === "buy" && t.platform !== "steam") { d.cashInvestmentCents = complete([d.cashInvestmentCents, t.totalCents]); d.knownCashInvestmentCents += t.knownTotalCents; }
        if (t.direction === "sell" && t.platform !== "steam") { d.cashReceiptsCents = complete([d.cashReceiptsCents, t.totalCents]); d.knownCashReceiptsCents += t.knownTotalCents; }
      }
      for (const e of g.activity) {
        const d = get(e.date), name = e.route === "direct" ? "direct" : e.route === "cashout" ? "cashout" : null;
        const quantityKey = e.route === "knife" ? "knifeQuantity" : name ? name + "Quantity" : "netQuantity";
        d[quantityKey] += e.quantity;
        if (!name) continue;
        d[name + "ProfitCents"] = complete([d[name + "ProfitCents"], e.profitCents]); d.profitCents = complete([d.profitCents, e.profitCents]);
        if (e.profitCents == null) { d.pendingQuantity += e.quantity; d[name + "PendingQuantity"] += e.quantity; }
        else { d["known" + name[0].toUpperCase() + name.slice(1) + "ProfitCents"] += e.profitCents; d.knownProfitCents += e.profitCents; d.includedQuantity += e.quantity; d[name + "IncludedQuantity"] += e.quantity; }
      }
    }
    const dates = [...map.keys()].sort(), end = report.dateTo || day(Date.parse(report.computedAt) + 28800000), start = report.dateFrom || dates[0] || end;
    const daily = [], totals = { profit: 0, direct: 0, cashout: 0, cost: 0, receipts: 0, included: 0, pending: 0, directIncluded: 0, directPending: 0, cashoutIncluded: 0, cashoutPending: 0, missingCost: false };
    for (let at = Date.parse(start), finish = Date.parse(end); at <= finish; at += DAY) {
      const date = day(at), d = map.get(date) || blank(date);
      d.openCents = totals.pending && !totals.included ? null : totals.profit;
      totals.profit = sum([totals.profit, d.knownProfitCents]); totals.direct = sum([totals.direct, d.knownDirectProfitCents]); totals.cashout = sum([totals.cashout, d.knownCashoutProfitCents]);
      totals.cost = sum([totals.cost, d.knownCashInvestmentCents]); totals.receipts = sum([totals.receipts, d.knownCashReceiptsCents]);
      totals.included += d.includedQuantity; totals.pending += d.pendingQuantity; totals.missingCost ||= d.cashInvestmentCents == null;
      for (const name of ["direct", "cashout"]) { totals[name + "Included"] += d[name + "IncludedQuantity"]; totals[name + "Pending"] += d[name + "PendingQuantity"]; }
      Object.assign(d, { cumulativeProfitCents: totals.pending && !totals.included ? null : totals.profit, cumulativeDirectProfitCents: totals.directPending && !totals.directIncluded ? null : totals.direct, cumulativeCashoutProfitCents: totals.cashoutPending && !totals.cashoutIncluded ? null : totals.cashout,
        cumulativeCostCents: totals.cost, cumulativeReceiptsCents: totals.receipts, cumulativePending: totals.pending, cumulativeMissingCost: totals.missingCost });
      daily.push(d);
    }
    const cutoff = range === "all" ? start : day(Date.parse(end) - (Number(range) - 1) * DAY), visible = daily.filter(d => d.date >= cutoff);
    const aggregate = unit => {
      const buckets = new Map();
      for (const d of visible) {
        const key = period(d.date, unit);
        if (!buckets.has(key)) buckets.set(key, { ...blank(key), from: d.date, to: d.date, openCents: d.openCents, highCents: d.openCents, lowCents: d.openCents, days: 0 });
        const b = buckets.get(key); b.to = d.date; b.days++;
        for (const f of fields) b[f] = complete([b[f], d[f]]);
        b.closeCents = d.cumulativeProfitCents;
        const values = [b.highCents, b.lowCents, d.cumulativeProfitCents].filter(Number.isFinite);
        b.highCents = values.length ? Math.max(...values) : null; b.lowCents = values.length ? Math.min(...values) : null;
        for (const k of ["cumulativeProfitCents", "cumulativeDirectProfitCents", "cumulativeCashoutProfitCents", "cumulativeCostCents", "cumulativeReceiptsCents", "cumulativePending", "cumulativeMissingCost"]) b[k] = d[k];
      }
      return [...buckets.values()].map(b => ({ ...b, displayProfitCents: shown(b.profitCents,b.knownProfitCents,b.includedQuantity), displayDirectProfitCents: shown(b.directProfitCents,b.knownDirectProfitCents,b.directIncludedQuantity), displayCashoutProfitCents: shown(b.cashoutProfitCents,b.knownCashoutProfitCents,b.cashoutIncludedQuantity) }));
    };
    const categories = [...new Set(gs.map(g => g.category))].map(category => {
      const selected = gs.filter(g => g.category === category), s = summary(selected, report);
      return { date: category, profitCents: shown(s.profitCents, s.knownProfitCents, s.includedQuantity), pendingQuantity: s.pendingQuantity, holdingQuantity: s.holdingQuantity, saleQuantity: s.saleQuantity };
    }).sort((a, b) => Math.abs(b.profitCents ?? 0) - Math.abs(a.profitCents ?? 0));
    return { currencyCode: currency, currencies, summary: summary(gs, report), daily: visible, points: aggregate(interval), weekly: aggregate("week"), categories, start, end, cutoff, partial: totals.pending > 0 };
  }
  return { sum, complete, shown, summary, analyze, period, tradeDates };
});
