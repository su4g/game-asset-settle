"use strict";

// All balances are integer cents. BigInt is used only for proportional division
// so the final remainder stays in inventory/the wallet instead of disappearing.
function share(total, amount, remaining) {
  if (total == null) return null;
  if (amount === remaining) return total;
  return Number(BigInt(total) * BigInt(amount) / BigInt(remaining));
}
const ms = (value) => value == null ? null : new Date(value).getTime();
const key = (row) => `${row.appid}|${row.marketHashName}`;

function project(data, { asOf = Date.now(), targetRatioBps = 8600 } = {}) {
  const issues = [];
  const wallets = new Map();
  const wallet = (id) => {
    if (!wallets.has(id)) wallets.set(id, { accountId: id, balanceCents: 0, costCents: 0, missingFundingCents: 0 });
    return wallets.get(id);
  };
  function credit(id, amount, cost) {
    const w = wallet(id);
    w.costCents = w.balanceCents === 0 ? cost : w.costCents == null || cost == null ? null : w.costCents + cost;
    w.balanceCents += amount;
  }
  function debit(id, amount) {
    const w = wallet(id);
    const enough = amount <= w.balanceCents;
    const cost = enough && w.costCents != null ? (amount ? share(w.costCents, amount, w.balanceCents) : 0) : null;
    if (!enough) w.missingFundingCents += amount - w.balanceCents;
    if (w.costCents != null && cost != null) w.costCents -= cost;
    else w.costCents = null;
    w.balanceCents = Math.max(0, w.balanceCents - amount);
    if (!w.balanceCents) w.costCents = 0;
    return cost;
  }
  const rows = new Map();
  const events = [];
  for (const t of data.trades || []) {
    if (ms(t.boughtAt) > asOf) continue;
    const row = { ...t, remainingQuantity: t.quantity, soldQuantity: 0, refundedQuantity: 0,
      inventoryBuyCents: t.buyTotalCents, cashCostCents: null, inventoryCostCents: null,
      settledCostCents: 0, saleBuyCents: 0, receivedCents: 0, pendingCents: 0,
      pendingCashCostCents: 0, pendingQuantity: 0, realizedCents: 0, realizedComplete: true, settlements: [], refunds: [] };
    rows.set(t.id, row);
    if (t.confirmed) events.push({ type: "buy", at: ms(t.boughtAt), priority: t.platform === "buff" ? 1 : 4, id: t.id, row });
  }
  for (const w of data.walletEvents || []) {
    if (!w.voided && ms(w.occurredAt) <= asOf) events.push({ type: "wallet", at: ms(w.occurredAt), priority: w.kind === "spend" ? 8 : 0, id: w.id, value: w });
  }
  for (const s of data.settlements || []) {
    const row = rows.get(s.tradeId);
    if (!s.voided && row?.confirmed && ms(s.soldAt) <= asOf) {
      const sale = { ...s, costCents: null, buyCents: null };
      events.push({ type: "sale", at: ms(s.soldAt), priority: row.direction === "knife" ? 2 : 5, id: s.id, row, sale });
      if (s.receivedAt && ms(s.receivedAt) <= asOf) events.push({ type: "receipt", at: ms(s.receivedAt), priority: row.direction === "knife" ? 3 : 6, id: s.id, row, sale });
    }
  }
  for (const f of data.refunds || []) {
    const row = rows.get(f.tradeId);
    if (row?.confirmed && ms(f.occurredAt) <= asOf) events.push({ type: "refund", at: ms(f.occurredAt), priority: 7, id: f.id, row, value: f });
  }
  events.sort((a, b) => a.at - b.at || a.priority - b.priority || a.id.localeCompare(b.id));
  const totals = { buffBuyCents: 0, steamBuyCents: 0, buffReceivedCents: 0, steamReceivedCents: 0,
    buffRefundCents: 0, steamRefundCents: 0, realizedCents: 0, realizedComplete: true,
    inventoryCostCents: 0, unrealizedCents: 0, estimateComplete: true, quotedCount: 0, holdingCount: 0 };
  const realizedSeries = [];
  function realize(row, amount, at) {
    if (amount == null) { row.realizedComplete = false; totals.realizedComplete = false; }
    else { row.realizedCents += amount; totals.realizedCents += amount; }
    realizedSeries.push({ at, value: totals.realizedComplete ? totals.realizedCents : null, knownValue: totals.realizedCents });
  }
  for (const event of events) {
    const { row, sale, value: value, at } = event;
    if (event.type === "wallet") {
      if (value.kind === "spend") debit(value.accountId, value.amountCents);
      else credit(value.accountId, value.amountCents, value.cashCostCents);
    } else if (event.type === "buy") {
      row.cashCostCents = row.platform === "buff" ? row.buyTotalCents : debit(row.accountId, row.buyTotalCents);
      row.inventoryCostCents = row.cashCostCents;
      totals[row.platform === "buff" ? "buffBuyCents" : "steamBuyCents"] += row.buyTotalCents;
    } else if (event.type === "sale" || event.type === "refund") {
      const entry = sale || value;
      if (entry.quantity > row.remainingQuantity) { issues.push(`${row.id}：成交数量超过持仓`); totals.realizedComplete = false; continue; }
      const cash = share(row.inventoryCostCents, entry.quantity, row.remainingQuantity);
      const buy = share(row.inventoryBuyCents, entry.quantity, row.remainingQuantity);
      row.remainingQuantity -= entry.quantity;
      row.inventoryBuyCents -= buy;
      if (cash != null) row.inventoryCostCents -= cash;
      if (sale) {
        sale.costCents = cash; sale.buyCents = buy; sale.valid = true;
        row.soldQuantity += sale.quantity;
        row.pendingCents += sale.netTotalCents;
        row.pendingQuantity += sale.quantity;
        row.pendingCashCostCents = cash == null || row.pendingCashCostCents == null ? null : row.pendingCashCostCents + cash;
        row.settlements.push(sale);
      } else {
        row.refundedQuantity += value.quantity; row.refunds.push(value);
        if (row.platform === "steam") { credit(row.accountId, value.amountCents, cash); totals.steamRefundCents += value.amountCents; }
        else { totals.buffRefundCents += value.amountCents; realize(row, cash == null ? null : value.amountCents - cash, at); }
      }
    } else if (event.type === "receipt" && sale.valid) {
      row.pendingCents -= sale.netTotalCents;
      row.pendingQuantity -= sale.quantity;
      if (row.pendingCashCostCents != null) row.pendingCashCostCents -= sale.costCents;
      row.receivedCents += sale.netTotalCents; row.saleBuyCents += sale.buyCents;
      if (sale.costCents == null) row.settledCostCents = null;
      else if (row.settledCostCents != null) row.settledCostCents += sale.costCents;
      if (row.direction === "knife") { credit(row.accountId, sale.netTotalCents, sale.costCents); totals.steamReceivedCents += sale.netTotalCents; }
      else { totals.buffReceivedCents += sale.netTotalCents; realize(row, sale.costCents == null ? null : sale.netTotalCents - sale.costCents, at); }
    }
  }
  const quotes = new Map();
  for (const p of data.prices || []) {
    if (ms(p.observedAt) > asOf || p.metadata?.kind === "median") continue;
    const merged = quotes.get(key(p)) || {};
    for (const platform of ["buff", "steam"]) {
      if (p[`${platform}NetCents`] != null && (!merged[`${platform}ObservedAt`] || ms(merged[`${platform}ObservedAt`]) <= ms(p.observedAt))) {
        merged[`${platform}NetCents`] = p[`${platform}NetCents`];
        merged[`${platform}PriceCents`] = p[`${platform}PriceCents`];
        merged[`${platform}ObservedAt`] = p.observedAt;
      }
    }
    merged.observedAt = !merged.observedAt || ms(merged.observedAt) < ms(p.observedAt) ? p.observedAt : merged.observedAt;
    quotes.set(key(p), merged);
  }
  for (const row of rows.values()) {
    row.actualRatio = row.receivedCents > 0 && row.saleBuyCents > 0 ?
      row.direction === "knife" ? row.saleBuyCents / row.receivedCents : row.receivedCents / row.saleBuyCents : null;
    row.estimatedUnlockAt = row.deliveredAt ? new Date(ms(row.deliveredAt) + 7 * 86400000).toISOString() : null;
    const unlock = row.direction === "knife" ? row.marketableAt : row.tradableAt;
    row.unlockAt = unlock || row.estimatedUnlockAt;
    row.unlockConfirmed = !!unlock;
    row.status = !row.confirmed ? "unverified" : row.remainingQuantity === 0 ?
      (row.pendingQuantity ? "pending_receipt" : row.refundedQuantity === row.quantity ? "refunded" : "completed") :
      row.soldQuantity ? "partial" : !row.deliveredAt ? "awaiting_delivery" :
      unlock ? (ms(unlock) > asOf ? "cooling" : "ready") : "estimated_cooldown";
    row.quote = quotes.get(key(row)) || null;
    const quoteTime = row.quote?.[row.direction === "knife" ? "steamObservedAt" : "buffObservedAt"];
    const fresh = quoteTime && asOf - ms(quoteTime) <= 90 * 60000;
    row.estimatedNetUnitCents = fresh ? row.direction === "knife" ? row.quote.steamNetCents : row.quote.buffNetCents : null;
    row.unrealizedCents = null;
    if (!row.confirmed) continue;
    if (row.remainingQuantity) {
      totals.holdingCount += 1;
      if (row.inventoryCostCents != null) totals.inventoryCostCents += row.inventoryCostCents;
      if (row.estimatedNetUnitCents != null && row.inventoryCostCents != null) {
        const net = row.estimatedNetUnitCents * row.remainingQuantity;
        const value = row.direction === "knife" ? Number(BigInt(net) * BigInt(targetRatioBps) / 10000n) : net;
        row.unrealizedCents = value - row.inventoryCostCents;
        totals.unrealizedCents += row.unrealizedCents; totals.quotedCount += 1;
      } else totals.estimateComplete = false;
    }
    if (row.pendingQuantity) {
      if (row.pendingCashCostCents == null) totals.estimateComplete = false;
      else totals.unrealizedCents += (row.direction === "knife" ? Number(BigInt(row.pendingCents) * BigInt(targetRatioBps) / 10000n) : row.pendingCents) - row.pendingCashCostCents;
    }
  }
  for (const w of wallets.values()) {
    w.costRatio = w.balanceCents > 0 && w.costCents != null ? w.costCents / w.balanceCents : null;
    if (w.balanceCents && w.costCents == null) totals.estimateComplete = false;
    else if (w.balanceCents) totals.unrealizedCents += Number(BigInt(w.balanceCents) * BigInt(targetRatioBps) / 10000n) - w.costCents;
    if (w.missingFundingCents) issues.push(`有 ${w.missingFundingCents} 分 Steam 支出的来源成本待补全`);
  }
  totals.totalPnlCents = totals.estimateComplete && totals.realizedComplete ? totals.realizedCents + totals.unrealizedCents : null;
  return { rows: [...rows.values()].sort((a, b) => ms(b.boughtAt) - ms(a.boughtAt) || a.id.localeCompare(b.id)),
    wallets: [...wallets.values()], totals, realizedSeries, issues, asOf, targetRatioBps };
}

module.exports = { project, share };
