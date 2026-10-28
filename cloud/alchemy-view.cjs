"use strict";
const { buildAlchemy } = require("../desktop/alchemy.cjs");
const { reconcileInput } = require("../desktop/steam-reconcile.cjs");
const { CloudError } = require("./validation.cjs");
const cost = value => ({ cash: value.cash, steam: value.steam, basis: value.basis });
const item = value => ({ name: value.name, marketHashName: value.marketHashName, quantity: value.quantity, collection: value.collection || "" });
function alchemyView(row, profile, params, period) {
  if ([...params.keys()].some(k => !["page", "limit", "q", "from", "to"].includes(k)) || params.has("limit") && params.get("limit") !== "20") throw new CloudError(400, "INVALID_QUERY", "炼金列表每页 20 条，仅支持合成日期与名称筛选");
  const report = buildAlchemy(reconcileInput(profile.input), { ...profile.options, ...period, page: Number(params.get("page") || 1), search: params.get("q") || "" });
  return {
    profileId: row.id, snapshotVersion: `${row.sequence || 0}:${row.hash || "empty"}`, uploadedAt: row.uploadedAt,
    total: report.total, page: report.page, pageSize: report.pageSize, summary: report.summary,
    archives: report.archives.map(a => ({ accountId: a.accountId, complete: a.coverage.complete, eventCount: a.coverage.eventCount, craftCount: a.craftCount, syncedAt: a.coverage.syncedAt })),
    rows: report.rows.map(r => ({ id: r.id, profileId: row.id, at: r.at, output: item(r.output), currencyCode: r.currencyCode, cost: cost(r.cost), state: r.state, complete: r.complete,
      cashProfitCents: r.cashProfitCents, steamProfitCents: r.steamProfitCents, reasons: r.reasons,
      inputs: r.inputs.map(i => ({ ...item(i), cost: cost(i.cost), reason: i.reason, parentCraftIds: i.parentCraftIds,
        sources: i.sources.map(s => ({ id: s.id, platform: s.platform, orderId: s.orderId, tradedAt: s.tradedAt, quantity: s.quantity, totalCents: s.totalCents, currencyCode: s.currencyCode })) })),
      sale: r.sale ? { platform: r.sale.platform, orderId: r.sale.orderId, tradedAt: r.sale.tradedAt, currencyCode: r.sale.currencyCode, netCents: r.sale.netCents } : null })),
    scopeNote: "只复盘已完成的炼金。现金收益与 Steam 余额盈亏分开；缺失成本和未确认出售不计利润。炼金结果独立展示，不与交易收益报告相加。",
  };
}
module.exports = { alchemyView };
