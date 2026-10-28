"use strict";

// An order-derived, read-only view. Archive rows are never changed or treated as
// confirmed transactions in the separate manually maintained ledger.
const { createHash } = require("node:crypto");
const { resolveOrderNames } = require("./buff-analysis.cjs");
const Pricing = require("./pricing.js");
const Common = require("../common.js");
const DAY = 86400000, CD_MS = 7 * DAY;
const CASH_PLATFORMS = new Set(["buff", "uu"]);
const safeAmount = value => Number.isSafeInteger(value) && value >= 0;
const amount = value => safeAmount(value) ? value : null;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fullName = value => typeof value === "string" && value.length <= 500 && /[A-Za-z]/.test(value) && !/[\u3400-\u9fff]/.test(value) ? value : "";
function identityName(value, row) {
  // Community cards and other Steam items can have a genuinely Chinese full
  // market name. Preserve that original exact identity within Steam; CS2/Dota
  // cross-market matching still requires an English name or a verified alias.
  if (row.platform === "steam" && ![730, 570].includes(Number(row.appid))) {
    return typeof value === "string" && value.trim() && value.length <= 500 && !/[\u0000-\u001f]/.test(value) ? value : "";
  }
  return fullName(value);
}
const accountKey = (source, platform, accountId) => JSON.stringify([source, platform, accountId]);
const sourceId = (source, key) => JSON.stringify([source, key]);

function sum(values) {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) throw new Error("账本金额汇总超出安全计算范围");
  }
  return total;
}
function completeSum(values) { return values.some(value => value == null) ? null : sum(values); }
// Allocate a total by cumulative fractions, keeping every cent even after many
// partial sales. BigInt prevents a safe total * safe quantity losing precision.
function portion(total, start, count, quantity) {
  if (total == null) return null;
  return Number(BigInt(total) * BigInt(start + count) / BigInt(quantity) - BigInt(total) * BigInt(start) / BigInt(quantity));
}
function platformOf(row, source) {
  if (source !== "csv") return source;
  const value = row.platform === "other" ? row.platformName : row.platform || row.platformName;
  if (/^(steam|steam社区市场)$/i.test(value || "")) return "steam";
  if (/^(buff|buff163|buff\.163\.com|网易buff)$/i.test(value || "")) return "buff";
  if (/^(uu|悠悠|悠悠有品|youpin898|youpin898\.com)$/i.test(value || "")) return "uu";
  return "other";
}
function rawRows(input = {}) {
  const result = [];
  for (const source of ["buff", "uu", "steam", "csv"]) {
    const value = input[source]?.data || input[source];
    const rows = Array.isArray(value) ? value : source === "csv" ? value?.rows || [] :
      Object.values(value?.accounts || {}).flatMap(account => account.records || []);
    for (const row of rows) result.push({ source, row });
  }
  return result;
}
function listAccounts(input = {}) {
  const accounts = new Map();
  for (const { source, row } of rawRows(input)) {
    const platform = platformOf(row, source), accountId = String(source === "csv" ? row.scope || "" : row.accountId || "");
    if (!accountId) continue;
    const key = accountKey(source, platform, accountId);
    if (!accounts.has(key)) accounts.set(key, { key, source, platform, accountId, label: `${platform === "steam" ? "Steam" : platform === "buff" ? "BUFF" : platform === "uu" ? "悠悠" : "其他"} · ${accountId}${source === "csv" ? "（CSV）" : ""}`, count: 0 });
    accounts.get(key).count++;
  }
  return [...accounts.values()].sort((a, b) => a.key.localeCompare(b.key));
}
function portfolioMap(accounts, links = []) {
  if (!Array.isArray(links)) throw new Error("账户组合格式无效");
  const known = new Set(accounts.map(row => row.key)), result = new Map(), ids = new Set();
  for (const link of links) {
    if (!link || typeof link.id !== "string" || !link.id || link.id.startsWith("account:") || ids.has(link.id) || !Array.isArray(link.accountKeys)) throw new Error("账户组合标识无效或重复");
    ids.add(link.id);
    for (const key of link.accountKeys) {
      if (result.has(key)) throw new Error("同一账户不能属于多个账户组合");
      // A saved account may temporarily have no archive rows. Keep that setting.
      result.set(key, link.id);
    }
  }
  for (const key of known) if (!result.has(key)) result.set(key, `account:${key}`);
  return result;
}
function dateRange(row, source) {
  if (source !== "csv") {
    const value = row.tradedAt;
    // Never fall back to sync, creation, cancellation, or import timestamps.
    if (typeof value !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    const at = Date.parse(value);
    return Number.isFinite(at) ? { tradedAt: new Date(at).toISOString(), timeStart: at, timeEnd: at, timePrecision: "instant" } : null;
  }
  if (typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
  const midnight = Date.parse(`${row.date}T00:00:00+08:00`);
  if (!Number.isFinite(midnight) || new Date(midnight + 8 * 3600000).toISOString().slice(0, 10) !== row.date) return null;
  const suffix = String(row.sourceTime || "").trim().match(/[ T]((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)$/)?.[1];
  if (suffix) {
    const at = Date.parse(`${row.date}T${suffix}${/(?:Z|[+-]\d{2}:\d{2})$/.test(suffix) ? "" : "+08:00"}`);
    if (!Number.isFinite(at)) return null;
    return { tradedAt: new Date(at).toISOString(), timeStart: at, timeEnd: at, timePrecision: "instant" };
  }
  return { tradedAt: row.date, timeStart: midnight, timeEnd: midnight + DAY - 1, timePrecision: "day" };
}
function sourceSequence(raw, row) {
  const sequence = raw.sourceSequence;
  return row.source === "csv" && row.platform === "steam" && raw.sourceFormat === "steam-market-history"
    && sequence?.format === "steam-market-history" && sequence.direction === "newest-first"
    && typeof sequence.documentHash === "string" && /^[a-f0-9]{64}$/.test(sequence.documentHash)
    && Number.isSafeInteger(sequence.row) && sequence.row >= 2 && sequence.row === raw.sourceRow
    ? { format: sequence.format, documentHash: sequence.documentHash, row: sequence.row, direction: sequence.direction } : null;
}
function anomaly(row, code, message, extra = {}) {
  return { code, message, sourceId: row.sourceId, accountKey: row.accountKey, portfolioId: row.portfolioId,
    platform: row.platform, name: row.name, marketHashName: row.marketHashName, quantity: row.quantity,
    appid: row.appid, orderId: row.orderId, direction: row.direction, currencyCode: row.currencyCode, ...extra };
}
function normalizeOrders(input = {}, options = {}) {
  const accounts = listAccounts(input), portfolios = portfolioMap(accounts, options.accountLinks);
  for (const row of accounts) row.portfolioId = portfolios.get(row.key);
  const prepared = rawRows(input).map(({ source, row }, index) => {
    const platform = platformOf(row, source), accountId = String(source === "csv" ? row.scope || "" : row.accountId || "");
    // Stored CSV keys retain the occurrence rank of identical rows; never dedupe
    // merely by item name, price or day. The fallback is only for in-memory data.
    const key = typeof row.key === "string" && row.key ? row.key : `unpersisted:${index}:${hash(row)}`;
    return { ...row, source, sourceId: sourceId(source, key), id: sourceId(source, key), platform, accountId,
      accountKey: accountKey(source, platform, accountId), name: row.name || row.itemName || row.marketHashName || "",
      marketHashName: identityName(row.marketHashName, { source, platform, appid: row.appid }), appid: Number(row.appid), _raw: row };
  });
  const resolved = resolveOrderNames(prepared, input.names || {}), orders = [], anomalies = [], seen = new Map(), walletRows = new Map(), cashRows = new Map(), unresolvedCashSales = [];
  let ignoredCount = 0;
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error("账本计算时间无效");
  for (const row of resolved) {
    row.portfolioId = portfolios.get(row.accountKey) || `account:${row.accountKey}`;
    if (options.portfolioId && options.portfolioId !== "all" && options.portfolioId !== row.portfolioId) continue;
    const raw = row._raw, direction = row.source === "csv" ? ({ purchase: "buy", sale: "sell", buy: "buy", sell: "sell" })[raw.type] : raw.direction;
    if (row.source !== "csv" && (raw.completed !== true || raw.channel !== "history")) { ignoredCount++; continue; }
    row.direction = direction;
    row.currencyCode = String(raw.currencyCode || raw.currency || "");
    row.quantity = raw.quantity;
    // Category accounting keeps an unmapped full original name as its own
    // exact category. It never guesses that a Chinese label is an English item.
    const originalFullName = [raw.marketHashName, raw.name, raw.itemName].find(value => typeof value === "string" && value.trim() && value.length <= 500 && !/[\u0000-\u001f]/.test(value));
    const originalNameCategory = Boolean(options.preserveFullNames && !identityName(row.marketHashName, row) && originalFullName);
    if (originalNameCategory) row.marketHashName = originalFullName;
    const time = dateRange(raw, row.source), override = options.overrides?.[row.sourceId];
    const sequence = sourceSequence(raw, row);
    const csvSemantics = options.csvAmountSemantics?.[row.accountKey];
    // The standard Steam history importer has verified wallet-flow semantics.
    // Generic mapped CSV remains unknown; a deliberate account-level unknown
    // setting can disable automatic semantics even for a standard import.
    const csvUsesActual = csvSemantics === "actual" || csvSemantics !== "unknown" && row.platform === "steam" && raw.sourceFormat === "steam-market-history" && raw.amountSemantics === "actual";
    let actualTotalCents = row.source === "csv" ? (csvUsesActual ? amount(raw.totalCents) : null) : amount(direction === "buy" ? raw.paidTotalCents : raw.netTotalCents);
    if (override && Object.hasOwn(override, "actualTotalCents")) {
      if (override.actualTotalCents != null && !safeAmount(override.actualTotalCents)) throw new Error("实际金额补录必须是非负整数分或空值");
      actualTotalCents = amount(override.actualTotalCents);
    }
    const financial = { id: row.id, sourceId: row.id, accountKey: row.accountKey, portfolioId: row.portfolioId, platform: row.platform,
      accountId: row.accountId, appid: row.appid, orderId: raw.orderId || "", direction, currencyCode: row.currencyCode, actualTotalCents, quantity: row.quantity,
      name: row.name, marketHashName: row.marketHashName, sourceSequence: sequence,
      ...(time || { tradedAt: "", timeStart: null, timeEnd: null, timePrecision: "unknown" }) };
    // An unrecognized item still spent or received wallet money. Item matching
    // validity must never silently erase that independent financial event.
    if (row.platform === "steam" && row.accountId && row.currencyCode && ["buy", "sell"].includes(direction) && (!time || time.timeStart <= now)) {
      const prior = walletRows.get(row.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(financial)) throw new Error("同一历史记录存在不同内容，请重新读取存档");
      walletRows.set(row.id, financial);
    }
    if (CASH_PLATFORMS.has(row.platform) && row.accountId && row.currencyCode && ["buy", "sell"].includes(direction) && (!time || time.timeStart <= now)) cashRows.set(row.id, financial);
    const unresolvedCashSale = () => { if (CASH_PLATFORMS.has(row.platform) && direction === "sell" && row.currencyCode && (!time || time.timeStart <= now)) unresolvedCashSales.push(financial); };
    const invalid = !row.accountId ? ["missing_account", "缺少账户标记，未纳入账本"] :
      !["buff", "uu", "steam"].includes(row.platform) ? ["unsupported_platform", "该 CSV 平台尚未定义账本路线"] :
      !Number.isSafeInteger(row.appid) || row.appid <= 0 ? ["invalid_appid", "缺少可靠 App ID"] :
      !identityName(row.marketHashName, row) && !originalNameCategory ? ["unresolved_name", "完整英文名或精确别名尚未核对"] :
      !["buy", "sell"].includes(direction) ? ["invalid_direction", "交易方向无效"] :
      !Number.isSafeInteger(row.quantity) || row.quantity < 1 ? ["invalid_quantity", "成交数量缺失或无效"] :
      !row.currencyCode ? ["missing_currency", "币种缺失"] : null;
    if (invalid) { anomalies.push(anomaly(row, ...invalid)); unresolvedCashSale(); continue; }
    if (!time) { anomalies.push(anomaly(row, "missing_trade_time", "成交时间缺失或无效，未用同步时间替代")); unresolvedCashSale(); continue; }
    if (time.timeStart > now) { anomalies.push(anomaly(row, "future_trade_time", "成交时间晚于当前时间")); continue; }
    const normalized = { id: row.id, sourceId: row.sourceId, source: row.source, accountKey: row.accountKey,
      portfolioId: row.portfolioId, accountId: row.accountId, platform: row.platform, appid: row.appid,
      name: row.name, marketHashName: row.marketHashName, category: row.category || "", direction, quantity: row.quantity,
      currencyCode: row.currencyCode, actualTotalCents, grossTotalCents: amount(raw.grossTotalCents ?? raw.totalCents),
      amountOverridden: Boolean(override && Object.hasOwn(override, "actualTotalCents")), originalNameCategory, completed: true,
      orderId: raw.orderId || "", assetId: raw.assetId || "", goodsId: raw.goodsId || "", sourceSequence: sequence, ...time };
    const duplicate = seen.get(row.id);
    if (duplicate) {
      if (JSON.stringify(duplicate) !== JSON.stringify(normalized)) throw new Error("同一历史记录存在不同内容，请重新读取存档");
      continue;
    }
    seen.set(row.id, normalized);
    orders.push(normalized);
    if (actualTotalCents == null) anomalies.push(anomaly(normalized, "unknown_amount", row.source === "csv" && !csvUsesActual ? "请确认 CSV 金额是买入实付 / 卖出净到账，或补录实际金额" : "实际支出 / 净到账未知；保留数量，利润待补全"));
  }
  orders.sort((a, b) => a.timeStart - b.timeStart || a.timeEnd - b.timeEnd || (a.direction === "buy" ? -1 : 1) - (b.direction === "buy" ? -1 : 1) || a.id.localeCompare(b.id));
  return { orders, accounts, anomalies, ignoredCount, unresolvedCashSales, cashEvents: [...cashRows.values()],
    walletEvents: [...walletRows.values()].filter(row => row.timeStart != null), unplacedWalletEvents: [...walletRows.values()].filter(row => row.timeStart == null) };
}
function routeFor(buy, sell) {
  if (CASH_PLATFORMS.has(buy.platform) && sell.platform === "steam") return "knife";
  if (buy.platform === "steam" && CASH_PLATFORMS.has(sell.platform)) return "cashout";
  return buy.platform === "steam" ? "steam" : "direct";
}
const groupingKey = row => JSON.stringify([row.portfolioId, row.appid, row.marketHashName, row.currencyCode, [730, 570].includes(row.appid) ? "" : row.platform]);
function matchOrders(orders, anomalies) {
  const buckets = new Map(), matches = [], lots = [], unmatchedSales = [];
  for (const order of orders) {
    const key = groupingKey(order);
    if (!buckets.has(key)) buckets.set(key, { first: null, last: null });
    const bucket = buckets.get(key);
    if (order.direction === "buy") {
      const lot = { order, used: 0, previous: bucket.last, next: null };
      if (bucket.last) bucket.last.next = lot; else bucket.first = lot;
      bucket.last = lot; lots.push(lot); continue;
    }
    let used = 0, blockedByCd = false, blockedByTime = false;
    // The active list omits consumed lots even when an earlier lot is still in
    // CD. Such a blocked prefix must not make a long archive quadratic.
    for (let lot = bucket.first; lot; lot = lot.next) {
      if (used === order.quantity) break;
      if (lot.used === lot.order.quantity) continue;
      const route = routeFor(lot.order, order), cd = ["knife", "cashout"].includes(route) ? CD_MS : 0;
      if (order.timeStart < lot.order.timeEnd + cd) {
        if (cd) blockedByCd = true; else blockedByTime = true;
        continue;
      }
      const quantity = Math.min(order.quantity - used, lot.order.quantity - lot.used);
      matches.push({ id: hash([lot.order.id, order.id, lot.used, used, quantity]), route,
        buyId: lot.order.id, sellId: order.id, buyPlatform: lot.order.platform, sellPlatform: order.platform,
        buyOrderId: lot.order.orderId, sellOrderId: order.orderId,
        buyAccountKey: lot.order.accountKey, sellAccountKey: order.accountKey, portfolioId: order.portfolioId,
        appid: order.appid, marketHashName: order.marketHashName, name: order.name, currencyCode: order.currencyCode,
        quantity, buyOffset: lot.used, sellOffset: used, costCents: portion(lot.order.actualTotalCents, lot.used, quantity, lot.order.quantity),
        proceedsCents: portion(order.actualTotalCents, used, quantity, order.quantity), cashCostCents: null, cashProfitCents: null,
        steamBalanceChangeCents: null, boughtAt: lot.order.tradedAt, soldAt: order.tradedAt,
        timeStart: order.timeStart, timeEnd: order.timeEnd, inferred: true, matchingMethod: "fifo", cdDays: cd ? 7 : 0 });
      lot.used += quantity; used += quantity;
      if (lot.used === lot.order.quantity) {
        if (lot.previous) lot.previous.next = lot.next; else bucket.first = lot.next;
        if (lot.next) lot.next.previous = lot.previous; else bucket.last = lot.previous;
      }
    }
    if (used < order.quantity) {
      const unmatched = { ...order, unmatchedQuantity: order.quantity - used, unmatchedAmountCents: portion(order.actualTotalCents, used, order.quantity - used, order.quantity), sellOffset: used };
      unmatchedSales.push(unmatched);
      anomalies.push(anomaly(order, blockedByCd ? "unmatched_sale_cd" : blockedByTime ? "unmatched_sale_time" : "unmatched_sale",
        blockedByCd ? "缺少已确认满 7 天的可匹配买入；仅有日期的边界需核对" : blockedByTime ? "买卖先后无法确认，未强行匹配" : "没有同组合、同物品、同币种的可匹配买入", { quantity: order.quantity - used }));
    }
  }
  return { matches, lots, unmatchedSales };
}

// Follow the cash basis through Steam wallet flows without counting a knife
// estimate and its later cashout as two realized profits. Opening wallet funds
// have unknown cash basis; unknown transaction amounts poison later allocation.
function allocateWalletCost(orders, matches, walletEvents, unplacedWalletEvents, anomalies) {
  const bySale = new Map(), basis = new Map(), wallets = new Map(), orderMap = ordersById(orders);
  const day = row => Math.floor((row.timeStart + 8 * 3600000) / DAY);
  const sequenceKey = row => JSON.stringify([row.accountKey, row.currencyCode, day(row)]);
  const dailyRows = new Map();
  for (const row of walletEvents) { const key = sequenceKey(row); if (!dailyRows.has(key)) dailyRows.set(key, []); dailyRows.get(key).push(row); }
  const sequences = new Map();
  for (const [key, rows] of dailyRows) {
    if (rows.every(row => row.timePrecision === "day" && row.sourceSequence)
      && new Set(rows.map(row => row.sourceSequence.documentHash)).size === 1
      && new Set(rows.map(row => row.sourceSequence.row)).size === rows.length) {
      sequences.set(key, [...rows].sort((a, b) => b.sourceSequence.row - a.sourceSequence.row));
    }
  }
  // A day-only source sequence cannot order its events against a different
  // wallet's precise event. Preserve any already accepted same-day dependency
  // instead of inventing a cross-source clock at midnight or at day end.
  for (const match of matches) {
    const buy = orderMap.get(match.buyId), sell = orderMap.get(match.sellId);
    if (day(buy) === day(sell) && sequenceKey(buy) !== sequenceKey(sell)) {
      sequences.delete(sequenceKey(buy)); sequences.delete(sequenceKey(sell));
    }
  }
  for (const row of matches) { if (!bySale.has(row.sellId)) bySale.set(row.sellId, []); bySale.get(row.sellId).push(row); }
  const walletFor = row => {
    // One person may own multiple Steam accounts. Sharing an item portfolio
    // does not transfer money between those wallets; CSV files with the same
    // account scope already share this exact accountKey.
    const key = JSON.stringify([row.accountKey, row.currencyCode]);
    if (!wallets.has(key)) wallets.set(key, { accountKey: row.accountKey, portfolioId: row.portfolioId, currencyCode: row.currencyCode, queue: [], incoming: [], outgoing: [], uncertainAt: Infinity, uncertainSeeded: false, latestBuy: null, latestSell: null, sourceSequenceDays: new Set() });
    return wallets.get(key);
  };
  for (const row of unplacedWalletEvents) {
    const wallet = walletFor(row); wallet.uncertainAt = -Infinity;
    wallet[row.direction === "buy" ? "outgoing" : "incoming"].push(row.actualTotalCents);
  }
  for (const row of [...walletEvents].sort((a, b) => a.timeStart - b.timeStart || a.timeEnd - b.timeEnd)) {
    const wallet = walletFor(row), other = wallet[row.direction === "buy" ? "latestSell" : "latestBuy"];
    const key = sequenceKey(row), sourceOrdered = sequences.has(key);
    if (sourceOrdered) wallet.sourceSequenceDays.add(day(row));
    if (other && other.timeEnd >= row.timeStart && !(sourceOrdered && sequenceKey(other) === key)) {
      wallet.uncertainAt = Math.min(wallet.uncertainAt, other.timeStart, row.timeStart);
      if (!wallet.timeWarning) {
        anomalies.push(anomaly(row, "wallet_time_uncertain", "Steam 同时段买卖先后不明，后续余额现金成本保持待核对"));
        wallet.timeWarning = true;
      }
    }
    const field = row.direction === "buy" ? "latestBuy" : "latestSell";
    if (!wallet[field] || wallet[field].timeEnd < row.timeEnd) wallet[field] = row;
  }
  // Day-only receipts become available at the end of their possible interval.
  const sortedEvents = [...orders.filter(row => row.platform !== "steam"), ...walletEvents].sort((a, b) => (a.direction === "sell" ? a.timeEnd : a.timeStart) - (b.direction === "sell" ? b.timeEnd : b.timeStart) || (a.direction === "buy" ? -1 : 1) - (b.direction === "buy" ? -1 : 1) || a.id.localeCompare(b.id));
  // Replace only the existing slots of a verified wallet/day with its original
  // export order. A conditional sort comparator would be non-transitive when
  // precise native events occur between these rows. This permutation leaves
  // every other event in its prior relative order and changes no timestamp.
  const cursors = new Map(), events = sortedEvents.map(row => {
    if (row.platform !== "steam") return row;
    const key = sequenceKey(row), sequence = sequences.get(key);
    if (!sequence) return row;
    const cursor = cursors.get(key) || 0; cursors.set(key, cursor + 1); return sequence[cursor];
  });
  for (const order of events) {
    if (order.platform === "steam") {
      const wallet = walletFor(order), at = order.direction === "sell" ? order.timeEnd : order.timeStart;
      if (!wallet.uncertainSeeded && at >= wallet.uncertainAt) { wallet.queue = [{ amount: null, cashCost: null, used: 0 }]; wallet.uncertainSeeded = true; }
    }
    if (order.direction === "buy") {
      if (order.platform !== "steam") { basis.set(order.id, order.actualTotalCents); continue; }
      const wallet = walletFor(order), spend = order.actualTotalCents;
      wallet.outgoing.push(spend);
      if (spend == null) { basis.set(order.id, null); wallet.queue = [{ amount: null, cashCost: null, used: 0 }]; continue; }
      let remaining = spend, cashCost = 0, complete = true;
      while (remaining && wallet.queue.length) {
        const lot = wallet.queue[0];
        if (lot.amount == null) { complete = false; remaining = 0; break; }
        const used = Math.min(remaining, lot.amount - lot.used), part = portion(lot.cashCost, lot.used, used, lot.amount);
        if (part == null) complete = false; else cashCost = sum([cashCost, part]);
        lot.used += used; remaining -= used;
        if (lot.used === lot.amount) wallet.queue.shift();
      }
      basis.set(order.id, complete && !remaining ? cashCost : null);
      continue;
    }
    const saleMatches = bySale.get(order.id) || [];
    for (const match of saleMatches) {
      const buy = orderMap.get(match.buyId);
      match.cashCostCents = portion(basis.get(match.buyId) ?? null, match.buyOffset, match.quantity, buy.quantity);
      if (["direct", "cashout"].includes(match.route) && match.cashCostCents != null && match.proceedsCents != null) match.cashProfitCents = match.proceedsCents - match.cashCostCents;
      match.steamBalanceChangeCents = match.route === "knife" ? match.proceedsCents : match.route === "cashout" ? (match.costCents == null ? null : -match.costCents) : match.route === "steam" ? (match.costCents == null || match.proceedsCents == null ? null : match.proceedsCents - match.costCents) : 0;
    }
    if (order.platform !== "steam") continue;
    const wallet = walletFor(order); wallet.incoming.push(order.actualTotalCents);
    if (order.actualTotalCents == null) { wallet.queue.push({ amount: null, cashCost: null, used: 0 }); continue; }
    for (const match of saleMatches) if (match.proceedsCents > 0) wallet.queue.push({ amount: match.proceedsCents, cashCost: match.cashCostCents, used: 0 });
    const unmatched = order.actualTotalCents - sum(saleMatches.map(row => row.proceedsCents));
    if (unmatched > 0) wallet.queue.push({ amount: unmatched, cashCost: null, used: 0 });
  }
  return { basis, wallets: [...wallets.values()].map(wallet => ({ accountKey: wallet.accountKey, portfolioId: wallet.portfolioId, currencyCode: wallet.currencyCode,
    sourceSequenceDays: wallet.sourceSequenceDays.size,
    receivedCents: completeSum(wallet.incoming), spentCents: completeSum(wallet.outgoing),
    changeCents: completeSum(wallet.incoming) == null || completeSum(wallet.outgoing) == null ? null : completeSum(wallet.incoming) - completeSum(wallet.outgoing),
    remainingKnownCashBasisCents: wallet.uncertainAt < Infinity ? null : sum(wallet.queue.filter(lot => lot.amount != null && lot.cashCost != null).map(lot => portion(lot.cashCost, lot.used, lot.amount - lot.used, lot.amount))),
    cashBasisComplete: wallet.uncertainAt === Infinity && wallet.queue.every(lot => lot.amount != null && lot.cashCost != null) })) };
}
function ordersById(orders) { return new Map(orders.map(row => [row.id, row])); }

function summarize(holdings, excludedHoldings, matches, unknownCashSales, settings, currencyCode) {
  const inventory = holdings.filter(row => row.currencyCode === currencyCode), rows = matches.filter(row => row.currencyCode === currencyCode);
  const knife = rows.filter(row => row.route === "knife"), cashout = rows.filter(row => row.route === "cashout"), direct = rows.filter(row => row.route === "direct"), realized = rows.filter(row => ["direct", "cashout"].includes(row.route));
  const values = (list, field) => list.map(row => row[field]), count = list => sum(list.map(row => row.quantity));
  const theoretical = inventory.map(row => row.theoretical?.bestProfitCents ?? null);
  const unknownSales = unknownCashSales.filter(row => row.currencyCode === currencyCode);
  return { currencyCode, holdingQuantity: sum(inventory.map(row => row.remainingQuantity)), holdingCount: inventory.length,
    excludedQuantity: sum(excludedHoldings.filter(row => row.currencyCode === currencyCode).map(row => row.remainingQuantity)),
    holdingCostCents: completeSum(values(inventory, "inventoryCostCents")), knownHoldingCostCents: sum(values(inventory, "inventoryCostCents").filter(value => value != null)),
    holdingUnknownCostCount: inventory.filter(row => row.inventoryCostCents == null).length,
    steamHoldingCostCents: completeSum(values(inventory.filter(row => row.platform === "steam"), "inventorySteamCostCents")),
    matchedQuantity: count(rows), knifeQuantity: count(knife), cashoutQuantity: count(cashout), directQuantity: count(direct),
    knifeCashSpentCents: completeSum(values(knife, "costCents")), knifeSteamReceivedCents: completeSum(values(knife, "proceedsCents")),
    knifeEstimatedCashProfitCents: completeSum(values(knife, "estimatedCashProfitCents")),
    knownKnifeEstimatedCashProfitCents: sum(values(knife, "estimatedCashProfitCents").filter(value => value != null)),
    cashoutSteamSpentCents: completeSum(values(cashout, "costCents")), cashoutCashReceivedCents: completeSum(values(cashout, "proceedsCents")),
    cashoutRatio: completeSum(values(cashout, "costCents")) > 0 && completeSum(values(cashout, "proceedsCents")) != null ? completeSum(values(cashout, "proceedsCents")) / completeSum(values(cashout, "costCents")) : null,
    directRealizedProfitCents: completeSum(values(direct, "cashProfitCents")), knownDirectRealizedProfitCents: sum(values(direct, "cashProfitCents").filter(value => value != null)),
    realizedProfitCents: unknownSales.length ? null : completeSum(values(realized, "cashProfitCents")), knownRealizedProfitCents: sum(values(realized, "cashProfitCents").filter(value => value != null)),
    unknownRealizedProfitCount: realized.filter(row => row.cashProfitCents == null).length + unknownSales.length,
    theoreticalProfitCents: completeSum(theoretical), knownTheoreticalProfitCents: sum(theoretical.filter(value => value != null)),
    theoreticalUnknownCount: theoretical.filter(value => value == null).length, targetCashoutRatio: settings.targetCashoutRatio };
}
function profitCurve(matches, unknownCashSales, currencyCode = "CNY") {
  const days = new Map();
  const unknown = unknownCashSales.filter(row => row.currencyCode === currencyCode);
  const undated = unknown.some(row => row.timeStart == null);
  for (const row of [...matches, ...unknown.filter(row => row.timeStart != null).map(row => ({ ...row, soldAt: row.tradedAt, route: "unmatched", cashProfitCents: null }))]) {
    if (row.currencyCode !== currencyCode || row.route === "steam") continue;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(row.soldAt) ? row.soldAt : new Date(row.timeStart + 8 * 3600000).toISOString().slice(0, 10);
    if (!days.has(date)) days.set(date, { date, realized: [], direct: [], knife: [] });
    const day = days.get(date);
    if (["direct", "cashout", "unmatched"].includes(row.route)) day.realized.push(row.cashProfitCents);
    if (row.route === "direct") day.direct.push(row.cashProfitCents);
    if (row.route === "knife") day.knife.push(row.estimatedCashProfitCents);
  }
  const realized = undated ? [null] : [], direct = [], knife = [];
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(day => {
    realized.push(...day.realized); direct.push(...day.direct); knife.push(...day.knife);
    return { date: day.date, currencyCode, dailyRealizedProfitCents: completeSum(day.realized), dailyDirectProfitCents: completeSum(day.direct),
      realizedProfitCents: completeSum(realized), knownRealizedProfitCents: sum(realized.filter(value => value != null)),
      directRealizedProfitCents: completeSum(direct), knownDirectRealizedProfitCents: sum(direct.filter(value => value != null)),
      knifeEstimatedCashProfitCents: completeSum(knife), knownKnifeEstimatedCashProfitCents: sum(knife.filter(value => value != null)) };
  });
}
function buildOrderLedger(input = {}, options = {}) {
  const normalized = normalizeOrders(input, options), { orders, accounts, anomalies, ignoredCount, walletEvents, unplacedWalletEvents, unresolvedCashSales } = normalized;
  const { matches, lots, unmatchedSales } = matchOrders(orders, anomalies);
  const { basis, wallets } = allocateWalletCost(orders, matches, walletEvents, unplacedWalletEvents, anomalies);
  const settings = Pricing.normalizeSettings(options.pricingSettings || Pricing.DEFAULTS), now = options.now ?? Date.now();
  for (const row of matches) {
    row.estimatedCashProfitCents = row.route === "knife" && row.costCents != null && row.proceedsCents != null ? Common.calculateCashoutScenario({ complete: true, totalNetCents: row.proceedsCents, totalSpentCents: row.costCents }, settings.targetCashoutRatio)?.profitCents ?? null : null;
  }
  const excluded = new Set(options.excludedHoldingIds || []), holdings = [], excludedHoldings = [];
  for (const lot of lots) {
    const row = lot.order, remainingQuantity = row.quantity - lot.used;
    if (!remainingQuantity) continue;
    const cost = portion(basis.get(row.id) ?? null, lot.used, remainingQuantity, row.quantity);
    const holding = { id: row.id, sourceId: row.id, accountKey: row.accountKey, portfolioId: row.portfolioId, platform: row.platform,
      accountId: row.accountId, appid: row.appid, name: row.name, marketHashName: row.marketHashName,
      // UU goods IDs belong to a separate catalogue and must not gate a BUFF quote.
      goodsId: row.platform === "buff" ? row.goodsId : "", currencyCode: row.currencyCode, boughtAt: row.tradedAt,
      quantity: row.quantity, remainingQuantity, inventoryCostCents: cost, inventoryKnownCostCents: cost,
      inventorySteamCostCents: row.platform === "steam" ? portion(row.actualTotalCents, lot.used, remainingQuantity, row.quantity) : null,
      originalCostCents: row.actualTotalCents, confirmed: true, excluded: excluded.has(row.id), inferred: true,
      cdUntil: new Date(row.timeEnd + CD_MS).toISOString(), cdReady: now >= row.timeEnd + CD_MS };
    holding.theoretical = Pricing.compareHolding(holding, options.quotes || [], settings, now);
    // compareHolding returns its input by reference; omit it in the serializable
    // result to avoid a cycle when assigning the comparison onto the holding.
    delete holding.theoretical.holding;
    (holding.excluded ? excludedHoldings : holdings).push(holding);
  }
  const unknownCashSales = [...unmatchedSales.filter(row => CASH_PLATFORMS.has(row.platform)), ...unresolvedCashSales];
  const currencies = [...new Set([...holdings, ...excludedHoldings, ...matches, ...unknownCashSales].map(row => row.currencyCode))].sort();
  const summary = summarize(holdings, excludedHoldings, matches, unknownCashSales, settings, "CNY");
  summary.currencies = currencies.map(currency => summarize(holdings, excludedHoldings, matches, unknownCashSales, settings, currency));
  summary.totalHoldingQuantity = sum(holdings.map(row => row.remainingQuantity));
  summary.totalMatchedQuantity = sum(matches.map(row => row.quantity));
  summary.anomalyCount = anomalies.length;
  return { version: 1, computedAt: new Date(now).toISOString(), accounts, orders, holdings, excludedHoldings, matches,
    anomalies, unmatchedSales, ignoredCount, wallets, walletEvents, unplacedWalletEvents, summary, profitCurve: profitCurve(matches, unknownCashSales),
    matchingMethod: "fifo", matchingLabel: "按完整物品名与时间 FIFO 推定，未核对实际资产流转" };
}


const localDay = row => row.timePrecision === "day" ? row.tradedAt : new Date(row.timeStart + 8 * 3600000).toISOString().slice(0, 10);
function periodDate(value, field) {
  if (value == null || value === "") return "";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field}日期无效`);
  const at = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) throw new Error(`${field}日期无效`);
  return value;
}
function discountedCents(value, ratio) {
  if (value == null) return null;
  if (value === 0) return 0;
  return Common.calculateCashoutScenario({ complete: true, totalNetCents: value, totalSpentCents: 0 }, ratio)?.proceedsCents ?? null;
}
const average = (total, quantity) => total == null || !quantity ? null : total / quantity;
function rawActivity(rows) {
  const quantity = sum(rows.map(row => row.quantity)), values = rows.map(row => row.actualTotalCents);
  const knownQuantity = sum(rows.filter(row => row.actualTotalCents != null).map(row => row.quantity)), knownTotalCents = sum(values.filter(value => value != null));
  return { quantity, totalCents: completeSum(values), knownTotalCents, knownQuantity,
    knownAveragePriceCents: average(knownTotalCents, knownQuantity),
    averagePriceCents: average(completeSum(values), quantity), grossTotalCents: completeSum(rows.map(row => row.grossTotalCents)),
    unknownAmountCount: values.filter(value => value == null).length };
}
function platformActivity(rows) {
  return ["buff", "uu", "steam"].filter(platform => rows.some(row => row.platform === platform))
    .map(platform => ({ platform, ...rawActivity(rows.filter(row => row.platform === platform)) }));
}

const moneyPart = (known = 0, complete = true) => ({ known, complete });
const moneyValue = part => part.complete ? part.known : null;
function mergeMoney(parts) { return moneyPart(sum(parts.map(part => part.known)), parts.every(part => part.complete)); }
function splitMoney(part, offset, quantity, total) { return moneyPart(total ? portion(part.known, offset, quantity, total) : 0, part.complete); }
function activityPart(activity) { return moneyPart(activity.knownTotalCents, activity.totalCents != null); }
function newPool() { return { quantity: 0, cost: moneyPart(), face: moneyPart(), poisoned: false }; }
function addPool(pool, quantity, cost, face = moneyPart()) {
  pool.quantity = sum([pool.quantity, quantity]); pool.cost = mergeMoney([pool.cost, cost]); pool.face = mergeMoney([pool.face, face]);
  if (pool.poisoned) pool.cost.complete = false;
}
function takePool(pool, quantity) {
  if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > pool.quantity) throw new Error("来源库存数量分配无效");
  const cost = splitMoney(pool.cost, 0, quantity, pool.quantity), face = splitMoney(pool.face, 0, quantity, pool.quantity);
  pool.cost.known -= cost.known; pool.face.known -= face.known; pool.quantity -= quantity;
  if (!pool.quantity) { pool.cost = moneyPart(0, !pool.poisoned); pool.face = moneyPart(); }
  return { cost, face };
}
function poolView(pool, steam = false) {
  return steam ? { quantity: pool.quantity, faceCostCents: moneyValue(pool.face), knownFaceCostCents: pool.face.known,
    cashBasisCents: moneyValue(pool.cost), knownCashBasisCents: pool.cost.known } :
    { quantity: pool.quantity, costCents: moneyValue(pool.cost), knownCostCents: pool.cost.known };
}
function recordOpening(record) {
  const cash = poolView(record.cash), steam = poolView(record.steam, true), cost = mergeMoney([record.cash.cost, record.steam.cost]);
  return { quantity: cash.quantity + steam.quantity, costCents: moneyValue(cost), knownCostCents: cost.known, cash, steam };
}
function spendWallet(wallet, spend) {
  if (spend.complete && spend.known === 0) return moneyPart();
  if (!spend.complete || !wallet.face.complete) {
    // An unknown withdrawal can consume every known cent. Keeping that basis
    // available for later purchases would count the same capital twice.
    wallet.face = moneyPart(0, false); wallet.cost = moneyPart(0, false);
    return moneyPart(0, false);
  }
  const covered = Math.min(spend.known, wallet.face.known);
  const cost = splitMoney(wallet.cost, 0, covered, wallet.face.known);
  wallet.face.known -= covered; wallet.cost.known -= cost.known;
  const deficit = spend.known - covered;
  wallet.minimumUnknownFundingCents = sum([wallet.minimumUnknownFundingCents, deficit]);
  if (!wallet.face.known) wallet.cost = moneyPart();
  return moneyPart(cost.known, cost.complete && !deficit);
}
function creditWallet(wallet, face, cost) {
  wallet.face = mergeMoney([wallet.face, face]); wallet.cost = mergeMoney([wallet.cost, cost]);
}
function sliceActivity(activity, offset, quantity) {
  const part = splitMoney(activityPart(activity), offset, quantity, activity.quantity);
  return { quantity, totalCents: moneyValue(part), knownTotalCents: part.known,
    knownQuantity: activity.quantity ? portion(activity.knownQuantity, offset, quantity, activity.quantity) : 0 };
}
function routeEvent(activity, offset, quantity, parts, meta, realized = false) {
  const receipt = sliceActivity(activity, offset, quantity), cost = parts.cost;
  return { ...receipt, ...meta, allocatedCostCents: moneyValue(cost), knownAllocatedCostCents: cost.known,
    steamCostCents: parts.face ? moneyValue(parts.face) : null, knownSteamCostCents: parts.face?.known || 0,
    profitCents: realized && receipt.totalCents != null && cost.complete ? receipt.totalCents - cost.known : null,
    knownProfitCents: realized && receipt.totalCents != null && cost.complete ? receipt.totalCents - cost.known : 0 };
}
function routeSummary(events, route) {
  const total = completeSum(events.map(event => event.totalCents)), cost = completeSum(events.map(event => event.allocatedCostCents));
  const quantity = sum(events.map(event => event.quantity)), knownQty = sum(events.map(event => event.knownQuantity));
  const knownTotal = sum(events.map(event => event.knownTotalCents));
  const realized = route === "cashout" || route === "direct";
  const knownCovered = events.filter(event => event.totalCents != null && event.allocatedCostCents != null);
  const knownProfit = realized ? events.filter(event => event.profitCents != null) : [];
  const result = { quantity, totalCents: total, knownTotalCents: knownTotal, knownQuantity: knownQty,
    averagePriceCents: average(total, quantity), knownAveragePriceCents: average(knownTotal, knownQty),
    allocatedCostCents: cost, knownAllocatedCostCents: sum(events.map(event => event.knownAllocatedCostCents)),
    profitCents: realized ? completeSum(events.map(event => event.profitCents)) : null,
    knownProfitCents: realized ? sum(events.map(event => event.knownProfitCents)) : 0,
    knownProfitQuantity: sum(knownProfit.map(event => event.quantity)), knownProfitCount: knownProfit.length,
    incompleteProfitCount: realized ? events.filter(event => event.profitCents == null).length : 0,
    knownCoveredQuantity: sum(knownCovered.map(event => event.quantity)),
    knownCoveredCashSpentCents: sum(knownCovered.map(event => event.allocatedCostCents)),
    knownCoveredSteamReceivedCents: sum(knownCovered.map(event => event.totalCents)) };
  if (route === "cashout") {
    result.steamCostCents = completeSum(events.map(event => event.steamCostCents));
    result.knownSteamCostCents = sum(events.map(event => event.knownSteamCostCents));
    result.ratio = result.steamCostCents > 0 && total != null ? total / result.steamCostCents : null;
  } else if (route === "knife") {
    result.ratio = total > 0 && cost != null ? cost / total : null;
    result.knownCoveredRatio = result.knownCoveredSteamReceivedCents > 0 ? result.knownCoveredCashSpentCents / result.knownCoveredSteamReceivedCents : null;
  }
  return result;
}
function weightedMoneyParts(part, weights) {
  const total = sum(weights); let offset = 0;
  return weights.map(weight => { const next = splitMoney(part, offset, weight, total); offset += weight; return next; });
}
function compareAtHistoricalRatio(holding, quotes, settings, now, valuation) {
  // Historical rates are observed statistics, not bounded user settings. A
  // profitable sale can legitimately exceed the settings form's 10x limit.
  const result = Pricing.compareHolding(holding, quotes, settings, now);
  const steam = result.routes.find(route => route.id === "steam");
  if (steam?.proceedsCents != null && result.steamNetCents > 0) {
    steam.proceedsCents = discountedCents(result.steamNetCents, valuation.estimatedCashoutRatio);
    steam.profitCents = steam.proceedsCents != null && result.costCents != null ? steam.proceedsCents - result.costCents : null;
    if (steam.proceedsCents == null) steam.issue = "金额超出计算范围";
  }
  const available = result.routes.filter(route => route.profitCents != null);
  result.bestProfitCents = available.length ? Math.max(...available.map(route => route.profitCents)) : null;
  result.bestRoutes = available.filter(route => route.profitCents === result.bestProfitCents).map(route => route.id);
  const next = available.filter(route => route.profitCents < result.bestProfitCents);
  result.advantageCents = result.bestRoutes.length === 1 && next.length ? result.bestProfitCents - Math.max(...next.map(route => route.profitCents)) : null;
  result.complete = available.length === result.routes.length;
  Object.assign(result, valuation); delete result.holding;
  return result;
}
function buildAggregateLedger(input = {}, options = {}, fundingScenario = null) {
  const dateFrom = periodDate(options.dateFrom, "开始"), dateTo = periodDate(options.dateTo, "结束");
  if (dateFrom && dateTo && dateFrom > dateTo) throw new Error("开始日期不能晚于结束日期");
  const normalized = normalizeOrders(input, { ...options, preserveFullNames: true });
  const settings = Pricing.normalizeSettings(options.pricingSettings || Pricing.DEFAULTS), now = options.now ?? Date.now();
  const beforeEnd = row => row.timeStart == null || !dateTo || localDay(row) <= dateTo;
  const inPeriod = row => row.timeStart != null && beforeEnd(row) && (!dateFrom || localDay(row) >= dateFrom);
  const orders = normalized.orders.filter(beforeEnd), periodOrders = orders.filter(inPeriod), orderIds = new Set(orders.map(row => row.id));
  const keyOf = row => JSON.stringify([row.portfolioId, row.appid, row.marketHashName, row.currencyCode]);
  const scopeOf = row => JSON.stringify([row.portfolioId, row.currencyCode]);
  const walletKey = row => JSON.stringify([row.accountKey, row.currencyCode]);
  // A separate scenario may value unrecorded Steam-sale sources at an observed
  // historical rate. It never changes archive orders or the actual projection.
  const assumedFunding = new Map();
  const records = new Map(), wallets = new Map(), days = new Map(), allCashouts = [], curveDays = [];
  const walletFor = row => {
    const key = walletKey(row);
    if (!wallets.has(key)) wallets.set(key, { key, accountKey: row.accountKey, portfolioId: row.portfolioId, currencyCode: row.currencyCode,
      face: moneyPart(), cost: moneyPart(), minimumUnknownFundingCents: 0, opening: { face: moneyPart(), cost: moneyPart(), minimumUnknownFundingCents: 0 } });
    return wallets.get(key);
  };
  const dayFor = date => { if (!days.has(date)) days.set(date, { items: new Map(), invalidSteam: [], invalidBuys: [] }); return days.get(date); };
  for (const order of orders) {
    const key = keyOf(order);
    if (!records.has(key)) records.set(key, { key, exemplar: order, goodsIds: new Set(), cash: newPool(), steam: newPool(), opening: null,
      buys: [], buyCosts: [], knife: [], cashout: [], direct: [], steamReturn: [], uncoveredCash: [], uncoveredSteam: [] });
    const record = records.get(key);
    if (order.platform === "buff" && order.goodsId) record.goodsIds.add(order.goodsId);
    if (order.platform === "steam") walletFor(order);
    const day = dayFor(localDay(order));
    if (!day.items.has(key)) day.items.set(key, []);
    day.items.get(key).push(order);
  }
  for (const row of normalized.walletEvents.filter(beforeEnd)) {
    walletFor(row);
    if (!orderIds.has(row.id)) dayFor(localDay(row)).invalidSteam.push(row);
  }
  for (const row of normalized.unplacedWalletEvents) {
    const wallet = walletFor(row); wallet.face.complete = false; wallet.cost.complete = false;
  }
  // A missing purchase cannot be placed before or after the observed stock.
  // Keep known monetary components, but do not call the resulting basis whole.
  const financialById = new Map([...normalized.cashEvents, ...normalized.walletEvents, ...normalized.unplacedWalletEvents].map(row => [row.id, row]));
  function poisonInventory(invalid) {
    for (const record of records.values()) {
      if (scopeOf(record.exemplar) !== scopeOf(invalid)) continue;
      if (invalid.marketHashName && invalid.appid && keyOf(record.exemplar) !== keyOf(invalid)) continue;
      const pool = invalid.platform === "steam" ? record.steam : record.cash;
      pool.poisoned = true; pool.cost.complete = false;
    }
  }
  const invalidBuys = normalized.anomalies.filter(row => row.direction === "buy" && row.code !== "unknown_amount" && row.code !== "future_trade_time");
  for (const invalid of invalidBuys) {
    const financial = financialById.get(invalid.sourceId);
    if (financial?.timeStart != null) {
      if (beforeEnd(financial)) dayFor(localDay(financial)).invalidBuys.push(invalid);
    } else poisonInventory(invalid);
  }
  const undatedCashSales = normalized.cashEvents.filter(row => row.timeStart == null && row.direction === "sell");
  const invalidCashSales = normalized.cashEvents.filter(row => beforeEnd(row) && row.direction === "sell" && !orderIds.has(row.id));
  // Keep an invalid sale's day on the curve even if no valid item transaction
  // happened then. Otherwise a later point could look complete while the
  // summary correctly reports that the missing sale cost is unknown.
  for (const row of invalidCashSales) if (row.timeStart != null) dayFor(localDay(row));
  let opened = false;
  function captureOpening() {
    for (const record of records.values()) record.opening = recordOpening(record);
    for (const wallet of wallets.values()) wallet.opening = { face: { ...wallet.face }, cost: { ...wallet.cost }, minimumUnknownFundingCents: wallet.minimumUnknownFundingCents };
    opened = true;
  }
  // Route quantities are computed for a whole item/day before any funds move.
  // This rule gives priority to knife/cashout, and cannot change when a source
  // exports one order as several rows. Steam returns arrive only at day end;
  // they never finance that same day's earlier buys or invent known capital.
  for (const [date, day] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
    const within = !dateFrom || date >= dateFrom;
    if (within && !opened) captureOpening();
    for (const invalid of day.invalidBuys) poisonInventory(invalid);
    const plans = [], dayRealized = [];
    for (const [key, rows] of [...day.items].sort(([a], [b]) => a.localeCompare(b))) {
      const record = records.get(key), cashBuys = rows.filter(row => row.direction === "buy" && row.platform !== "steam"), steamBuys = rows.filter(row => row.direction === "buy" && row.platform === "steam");
      const cashSales = rows.filter(row => row.direction === "sell" && row.platform !== "steam"), steamSales = rows.filter(row => row.direction === "sell" && row.platform === "steam");
      const cb = rawActivity(cashBuys), sb = rawActivity(steamBuys), cs = rawActivity(cashSales), ss = rawActivity(steamSales);
      addPool(record.cash, cb.quantity, activityPart(cb));
      if (within) { record.buys.push(...cashBuys, ...steamBuys); record.buyCosts.push(activityPart(cb)); }
      const cashAvailable = record.cash.quantity, steamAvailable = record.steam.quantity + sb.quantity;
      const knife = Math.min(cashAvailable, ss.quantity), cashout = Math.min(steamAvailable, cs.quantity);
      const direct = Math.min(cashAvailable - knife, cs.quantity - cashout);
      const steamReturn = Math.min(steamAvailable - cashout, ss.quantity - knife);
      const plan = { record, cashBuys, steamBuys, cashSales, steamSales, cb, sb, cs, ss, knife, cashout, direct, steamReturn,
        missingCash: cs.quantity - cashout - direct, missingSteam: ss.quantity - knife - steamReturn, date };
      plans.push(plan);
    }
    const meta = (plan, route) => ({ date, portfolioId: plan.record.exemplar.portfolioId, currencyCode: plan.record.exemplar.currencyCode, route });
    const keep = (plan, route, event) => {
      if (route === "cashout") allCashouts.push(event);
      if (!within || !event.quantity) return;
      plan.record[route].push(event);
      if (["cashout", "direct", "uncoveredCash"].includes(route)) dayRealized.push(event);
    };
    function receiptWallets(plan, offset, quantity, cost) {
      if (!quantity) return;
      const accountRows = [...new Set(plan.steamSales.map(row => row.accountKey))].sort().map(account => {
        const rows = plan.steamSales.filter(row => row.accountKey === account); return { row: rows[0], stats: rawActivity(rows) };
      });
      // Each account keeps its own observed wallet receipts. The transferred
      // item basis follows quantities, never each account's different sale
      // price. Otherwise selling dearer would manufacture a dearer cost basis.
      const faces = accountRows.map(item => splitMoney(activityPart(item.stats), offset, quantity, plan.ss.quantity));
      const costs = weightedMoneyParts(cost, accountRows.map(item => item.stats.quantity));
      accountRows.forEach((item, index) => creditWallet(walletFor(item.row), faces[index], costs[index]));
      return mergeMoney(faces);
    }
    // 1. Cash purchases already entered the pool. 2. Knife receipts and actual
    // source gaps fund the wallet; gap receipts carry an unknown cash basis.
    for (const plan of plans) {
      const taken = takePool(plan.record.cash, plan.knife);
      if (plan.knife) {
        const event = routeEvent(plan.ss, 0, plan.knife, taken, meta(plan, "knife"));
        const receipt = receiptWallets(plan, 0, plan.knife, taken.cost);
        event.totalCents = moneyValue(receipt); event.knownTotalCents = receipt.known; keep(plan, "knife", event);
      }
      if (plan.missingSteam) {
        const offset = plan.knife + plan.steamReturn;
        let cost = moneyPart(0, false);
        const receipt = sliceActivity(plan.ss, offset, plan.missingSteam);
        const scope = scopeOf(plan.record.exemplar), rate = fundingScenario?.get(scope)?.ratio;
        if (receipt.totalCents != null && Number.isFinite(rate) && rate >= 0) {
          const stats = assumedFunding.get(scope) || { portfolioId: plan.record.exemplar.portfolioId, currencyCode: plan.record.exemplar.currencyCode, quantity: 0, faceCents: 0, costCents: 0, ratio: rate };
          // Cumulative cent rounding avoids a bias for hundreds of cheap items.
          const nextFace = sum([stats.faceCents, receipt.totalCents]), nextCost = discountedCents(nextFace, rate);
          if (nextCost != null) {
            const assumed = nextCost - stats.costCents;
            cost = moneyPart(assumed);
            stats.quantity += plan.missingSteam; stats.faceCents = nextFace; stats.costCents = nextCost; assumedFunding.set(scope, stats);
          }
        }
        const event = routeEvent(plan.ss, offset, plan.missingSteam, { cost }, meta(plan, "uncoveredSteam"));
        const credited = receiptWallets(plan, offset, plan.missingSteam, cost);
        event.totalCents = moneyValue(credited); event.knownTotalCents = credited.known; keep(plan, "uncoveredSteam", event);
      }
    }
    for (const row of day.invalidSteam.filter(row => row.direction === "sell")) creditWallet(walletFor(row), moneyPart(row.actualTotalCents || 0, row.actualTotalCents != null), moneyPart(0, false));
    // 3. Spend each wallet once for all of its day's purchases, then distribute
    // basis by original Steam amounts. No item or source-row order chooses cost.
    const spending = new Map();
    for (const plan of plans) for (const account of [...new Set(plan.steamBuys.map(row => row.accountKey))].sort()) {
      const rows = plan.steamBuys.filter(row => row.accountKey === account), stats = rawActivity(rows), key = walletKey(rows[0]);
      if (!spending.has(key)) spending.set(key, { wallet: walletFor(rows[0]), parts: [] });
      spending.get(key).parts.push({ plan, stats, invalid: false });
    }
    for (const row of day.invalidSteam.filter(row => row.direction === "buy")) {
      const key = walletKey(row); if (!spending.has(key)) spending.set(key, { wallet: walletFor(row), parts: [] });
      spending.get(key).parts.push({ invalid: true, stats: { quantity: 0, knownTotalCents: row.actualTotalCents || 0, totalCents: row.actualTotalCents } });
    }
    for (const { wallet, parts } of spending.values()) {
      const spend = mergeMoney(parts.map(item => activityPart(item.stats))), basis = spendWallet(wallet, spend);
      const weights = parts.map(item => item.stats.knownTotalCents), costs = weightedMoneyParts(basis, weights);
      parts.forEach((item, index) => {
        if (item.invalid) return;
        const cost = spend.complete && sum(weights) > 0 ? costs[index] : item.stats.totalCents === 0 ? moneyPart() : moneyPart(0, false);
        addPool(item.plan.record.steam, item.stats.quantity, cost, activityPart(item.stats));
        if (within) item.plan.record.buyCosts.push(cost);
      });
    }
    // 4. Cashout takes priority over direct cash resale. 5. Steam-to-Steam
    // returns transfer the remaining basis back to the wallet at day end.
    for (const plan of plans) {
      const cashout = takePool(plan.record.steam, plan.cashout), direct = takePool(plan.record.cash, plan.direct);
      if (plan.cashout) keep(plan, "cashout", routeEvent(plan.cs, 0, plan.cashout, cashout, meta(plan, "cashout"), true));
      if (plan.direct) keep(plan, "direct", routeEvent(plan.cs, plan.cashout, plan.direct, direct, meta(plan, "direct"), true));
      if (plan.missingCash) keep(plan, "uncoveredCash", routeEvent(plan.cs, plan.cashout + plan.direct, plan.missingCash, { cost: moneyPart(0, false) }, meta(plan, "uncoveredCash"), true));
      const returned = takePool(plan.record.steam, plan.steamReturn);
      if (plan.steamReturn) {
        const event = routeEvent(plan.ss, plan.knife, plan.steamReturn, returned, meta(plan, "steamReturn"));
        const receipt = receiptWallets(plan, plan.knife, plan.steamReturn, returned.cost);
        event.totalCents = moneyValue(receipt); event.knownTotalCents = receipt.known; keep(plan, "steamReturn", event);
      }
    }
    if (within) curveDays.push({ date, events: dayRealized });
  }
  if (!opened) captureOpening();
  const ratios = new Map();
  for (const event of allCashouts) if (event.totalCents != null && event.steamCostCents > 0) {
    const key = scopeOf(event); if (!ratios.has(key)) ratios.set(key, { cash: 0, face: 0, quantity: 0 });
    const ratio = ratios.get(key); ratio.cash = sum([ratio.cash, event.totalCents]); ratio.face = sum([ratio.face, event.steamCostCents]); ratio.quantity += event.quantity;
  }
  const valuationFor = row => {
    const sample = ratios.get(scopeOf(row));
    return { estimatedCashoutRatio: sample ? sample.cash / sample.face : settings.targetCashoutRatio,
      valuationSource: sample ? "historical-cashout" : "configured-estimate", valuationSampleQuantity: sample?.quantity || 0 };
  };
  const excluded = new Set(options.excludedHoldingIds || []), groups = [];
  for (const record of records.values()) {
    if (!record.opening.quantity && !record.buys.length && !["knife", "cashout", "direct", "steamReturn", "uncoveredCash", "uncoveredSteam"].some(route => record[route].length)) continue;
    const row = record.exemplar, id = `category:${hash(record.key)}`, cashHolding = poolView(record.cash), steamHolding = poolView(record.steam, true);
    const cost = mergeMoney([record.cash.cost, record.steam.cost]), buy = rawActivity(record.buys), buyCost = mergeMoney(record.buyCosts), valuation = valuationFor(row);
    const steamValue = discountedCents(steamHolding.faceCostCents, valuation.estimatedCashoutRatio);
    Object.assign(steamHolding, valuation, { estimatedValueCents: steamValue, knownEstimatedValueCents: discountedCents(steamHolding.knownFaceCostCents, valuation.estimatedCashoutRatio),
      unrealizedProfitCents: steamValue != null && steamHolding.cashBasisCents != null ? steamValue - steamHolding.cashBasisCents : null });
    const group = { id, sourceId: id, portfolioId: row.portfolioId, appid: row.appid, marketHashName: row.marketHashName, name: row.name, currencyCode: row.currencyCode,
      goodsId: record.goodsIds.size === 1 ? [...record.goodsIds][0] : "", platform: "mixed", opening: record.opening,
      buy: { ...buy, byPlatform: platformActivity(record.buys), costCents: moneyValue(buyCost), knownCostCents: buyCost.known, averageCostCents: average(moneyValue(buyCost), buy.quantity) },
      cashHolding, steamHolding, knife: routeSummary(record.knife, "knife"), cashout: routeSummary(record.cashout, "cashout"), direct: routeSummary(record.direct, "direct"), steamReturn: routeSummary(record.steamReturn, "steamReturn"),
      uncoveredCash: routeSummary(record.uncoveredCash, "cashout"), uncoveredSteam: routeSummary(record.uncoveredSteam, "knife"),
      quantity: record.cash.quantity + record.steam.quantity, remainingQuantity: record.cash.quantity + record.steam.quantity,
      inventoryCostCents: moneyValue(cost), inventoryKnownCostCents: cost.known, confirmed: true, excluded: excluded.has(id),
      inferred: true, accountingMethod: "daily-source-pools", ...valuation,
      activity: ["knife", "cashout", "direct", "steamReturn", "uncoveredCash", "uncoveredSteam"].flatMap(route => record[route]).sort((a, b) => a.date.localeCompare(b.date) || a.route.localeCompare(b.route)) };
    group.uncoveredSaleQuantity = group.uncoveredCash.quantity + group.uncoveredSteam.quantity;
    group.averageCostCents = average(group.inventoryCostCents, group.remainingQuantity);
    group.theoretical = compareAtHistoricalRatio(group, options.quotes || [], settings, now, valuation);
    groups.push(group);
  }
  groups.sort((a, b) => a.appid - b.appid || a.marketHashName.localeCompare(b.marketHashName) || a.id.localeCompare(b.id));
  const financial = [...normalized.walletEvents, ...normalized.unplacedWalletEvents].filter(beforeEnd);
  const walletViews = [...wallets.values()].map(wallet => {
    const rows = financial.filter(row => walletKey(row) === wallet.key && inPeriod(row)), incoming = rows.filter(row => row.direction === "sell"), outgoing = rows.filter(row => row.direction === "buy");
    const valuation = valuationFor(wallet), value = discountedCents(moneyValue(wallet.face), valuation.estimatedCashoutRatio);
    return { accountKey: wallet.accountKey, portfolioId: wallet.portfolioId, currencyCode: wallet.currencyCode,
      openingFaceBalanceCents: moneyValue(wallet.opening.face), openingKnownFaceBalanceCents: wallet.opening.face.known,
      openingCashBasisCents: moneyValue(wallet.opening.cost), openingKnownCashBasisCents: wallet.opening.cost.known,
      faceBalanceCents: moneyValue(wallet.face), knownFaceBalanceCents: wallet.face.known, cashBasisCents: moneyValue(wallet.cost), knownCashBasisCents: wallet.cost.known,
      walletRatio: wallet.face.complete && wallet.cost.complete && wallet.face.known > 0 ? wallet.cost.known / wallet.face.known : null,
      receivedCents: completeSum(incoming.map(row => row.actualTotalCents)), knownReceivedCents: sum(incoming.map(row => row.actualTotalCents).filter(value => value != null)),
      spentCents: completeSum(outgoing.map(row => row.actualTotalCents)), knownSpentCents: sum(outgoing.map(row => row.actualTotalCents).filter(value => value != null)),
      minimumUnknownFundingCents: wallet.minimumUnknownFundingCents, periodMinimumUnknownFundingCents: wallet.minimumUnknownFundingCents - wallet.opening.minimumUnknownFundingCents,
      estimatedValueCents: value, knownEstimatedValueCents: discountedCents(wallet.face.known, valuation.estimatedCashoutRatio),
      unrealizedProfitCents: value != null && wallet.cost.complete ? value - wallet.cost.known : null, ...valuation };
  });
  const holdings = groups.filter(row => !row.excluded && row.remainingQuantity > 0), excludedHoldings = groups.filter(row => row.excluded && row.remainingQuantity > 0);
  const anomalies = normalized.anomalies.filter(row => row.code !== "unknown_amount" && row.code !== "unresolved_name");
  const cashFinancial = normalized.cashEvents.filter(beforeEnd);
  function summarizeCurrency(currency) {
    const rows = groups.filter(row => row.currencyCode === currency), inventory = holdings.filter(row => row.currencyCode === currency), ws = walletViews.filter(row => row.currencyCode === currency);
    const total = (items, get) => completeSum(items.map(get)), known = (items, get) => sum(items.map(get));
    const cashRows = cashFinancial.filter(row => row.currencyCode === currency && inPeriod(row));
    const investments = cashRows.filter(row => row.direction === "buy"), receipts = cashRows.filter(row => row.direction === "sell");
    const incompleteSales = invalidCashSales.some(row => row.currencyCode === currency && (row.timeStart == null || inPeriod(row)));
    const hasGaps = rows.some(row => row.uncoveredCash.quantity > 0) || incompleteSales;
    const directProfit = total(rows, row => row.direct.profitCents), cycleProfit = total(rows, row => row.cashout.profitCents);
    const knownDirect = known(rows, row => row.direct.knownProfitCents), knownCycle = known(rows, row => row.cashout.knownProfitCents);
    const knifeCash = total(rows, row => row.knife.allocatedCostCents), knifeFace = total(rows, row => row.knife.totalCents);
    const cashoutNet = total(rows, row => row.cashout.totalCents), cashoutFace = total(rows, row => row.cashout.steamCostCents);
    const historical = allCashouts.filter(event => event.currencyCode === currency && event.totalCents != null && event.steamCostCents > 0);
    const historyCash = sum(historical.map(event => event.totalCents)), historyFace = sum(historical.map(event => event.steamCostCents));
    const knownKnifeReceipt = known(rows, row => row.knife.knownCoveredSteamReceivedCents), knownKnifeCost = known(rows, row => row.knife.knownCoveredCashSpentCents);
    const cashIncomplete = direction => cashFinancial.some(row => row.currencyCode === currency && row.direction === direction && row.timeStart == null);
    const result = { currencyCode: currency, buyQuantity: known(rows, row => row.buy.quantity), buyCostCents: total(rows, row => row.buy.costCents), knownBuyCostCents: known(rows, row => row.buy.knownCostCents),
      cashInvestedCents: cashIncomplete("buy") ? null : completeSum(investments.map(row => row.actualTotalCents)), knownCashInvestedCents: sum(investments.map(row => row.actualTotalCents).filter(value => value != null)),
      cashReceivedCents: cashIncomplete("sell") ? null : completeSum(receipts.map(row => row.actualTotalCents)), knownCashReceivedCents: sum(receipts.map(row => row.actualTotalCents).filter(value => value != null)),
      openingQuantity: known(rows, row => row.opening.quantity), openingCostCents: total(rows, row => row.opening.costCents), knownOpeningCostCents: known(rows, row => row.opening.knownCostCents),
      holdingQuantity: known(inventory, row => row.remainingQuantity), holdingCount: inventory.length,
      cashHoldingQuantity: known(inventory, row => row.cashHolding.quantity), steamHoldingQuantity: known(inventory, row => row.steamHolding.quantity),
      holdingCostCents: total(inventory, row => row.inventoryCostCents), knownHoldingCostCents: known(inventory, row => row.inventoryKnownCostCents),
      cashHoldingCostCents: total(inventory, row => row.cashHolding.costCents), knownCashHoldingCostCents: known(inventory, row => row.cashHolding.knownCostCents),
      steamHoldingCashBasisCents: total(inventory, row => row.steamHolding.cashBasisCents), knownSteamHoldingCashBasisCents: known(inventory, row => row.steamHolding.knownCashBasisCents),
      steamHoldingFaceCostCents: total(inventory, row => row.steamHolding.faceCostCents), knownSteamHoldingFaceCostCents: known(inventory, row => row.steamHolding.knownFaceCostCents),
      holdingUnknownCostCount: inventory.filter(row => row.inventoryCostCents == null).length,
      excludedQuantity: known(excludedHoldings.filter(row => row.currencyCode === currency), row => row.remainingQuantity),
      knifeQuantity: known(rows, row => row.knife.quantity), knifeCashSpentCents: knifeCash, knownKnifeCashSpentCents: known(rows, row => row.knife.knownAllocatedCostCents),
      knifeSteamReceivedCents: knifeFace, knownKnifeSteamReceivedCents: known(rows, row => row.knife.knownTotalCents), knifeRatio: knifeFace > 0 && knifeCash != null ? knifeCash / knifeFace : null,
      knownKnifeCoveredRatio: knownKnifeReceipt > 0 ? knownKnifeCost / knownKnifeReceipt : null, knownKnifeCoveredQuantity: known(rows, row => row.knife.knownCoveredQuantity),
      knownKnifeCoveredCashSpentCents: knownKnifeCost, knownKnifeCoveredSteamReceivedCents: knownKnifeReceipt,
      averageKnifePriceCents: average(knifeFace, known(rows, row => row.knife.quantity)), knownKnifeQuantity: known(rows, row => row.knife.knownQuantity),
      knownAverageKnifePriceCents: average(known(rows, row => row.knife.knownTotalCents), known(rows, row => row.knife.knownQuantity)),
      cashoutQuantity: known(rows, row => row.cashout.quantity), cashoutCashReceivedCents: cashoutNet, knownCashoutCashReceivedCents: known(rows, row => row.cashout.knownTotalCents),
      cashoutSteamSpentCents: cashoutFace, knownCashoutSteamSpentCents: known(rows, row => row.cashout.knownSteamCostCents),
      cashoutAllocatedCostCents: total(rows, row => row.cashout.allocatedCostCents), knownCashoutAllocatedCostCents: known(rows, row => row.cashout.knownAllocatedCostCents),
      cashoutRatio: cashoutFace > 0 && cashoutNet != null ? cashoutNet / cashoutFace : null,
      averageCashoutPriceCents: average(cashoutNet, known(rows, row => row.cashout.quantity)), knownCashoutQuantity: known(rows, row => row.cashout.knownQuantity),
      knownAverageCashoutPriceCents: average(known(rows, row => row.cashout.knownTotalCents), known(rows, row => row.cashout.knownQuantity)),
      cashoutCycleProfitCents: cycleProfit, knownCashoutCycleProfitCents: knownCycle,
      knownCashoutProfitQuantity: known(rows, row => row.cashout.knownProfitQuantity), knownCashoutProfitCount: known(rows, row => row.cashout.knownProfitCount),
      directQuantity: known(rows, row => row.direct.quantity), directCashReceivedCents: total(rows, row => row.direct.totalCents), knownDirectCashReceivedCents: known(rows, row => row.direct.knownTotalCents),
      directCashSpentCents: total(rows, row => row.direct.allocatedCostCents), knownDirectCashSpentCents: known(rows, row => row.direct.knownAllocatedCostCents),
      directRealizedProfitCents: directProfit, knownDirectRealizedProfitCents: knownDirect,
      knownDirectProfitQuantity: known(rows, row => row.direct.knownProfitQuantity), knownDirectProfitCount: known(rows, row => row.direct.knownProfitCount),
      steamReturnQuantity: known(rows, row => row.steamReturn.quantity), steamReturnReceivedCents: total(rows, row => row.steamReturn.totalCents),
      realizedProfitCents: hasGaps ? null : completeSum([directProfit, cycleProfit]), knownRealizedProfitCents: sum([knownDirect, knownCycle]),
      unknownRealizedProfitCount: known(rows, row => row.direct.incompleteProfitCount + row.cashout.incompleteProfitCount + row.uncoveredCash.quantity) + Number(incompleteSales),
      walletBalanceCents: total(ws, row => row.faceBalanceCents), knownWalletBalanceCents: known(ws, row => row.knownFaceBalanceCents),
      walletCashBasisCents: total(ws, row => row.cashBasisCents), knownWalletCashBasisCents: known(ws, row => row.knownCashBasisCents),
      openingWalletBalanceCents: total(ws, row => row.openingFaceBalanceCents), openingWalletCashBasisCents: total(ws, row => row.openingCashBasisCents),
      minimumUnknownFundingCents: known(ws, row => row.minimumUnknownFundingCents),
      walletEstimatedValueCents: total(ws, row => row.estimatedValueCents), knownWalletEstimatedValueCents: known(ws, row => row.knownEstimatedValueCents),
      walletUnrealizedProfitCents: total(ws, row => row.unrealizedProfitCents), knownWalletUnrealizedProfitCents: sum(ws.map(row => row.unrealizedProfitCents).filter(value => value != null)),
      steamHoldingEstimatedValueCents: total(inventory, row => row.steamHolding.estimatedValueCents), knownSteamHoldingEstimatedValueCents: known(inventory, row => row.steamHolding.knownEstimatedValueCents),
      steamHoldingUnrealizedProfitCents: total(inventory, row => row.steamHolding.unrealizedProfitCents), knownSteamHoldingUnrealizedProfitCents: sum(inventory.map(row => row.steamHolding.unrealizedProfitCents).filter(value => value != null)),
      estimatedCashoutRatio: historyFace > 0 ? historyCash / historyFace : settings.targetCashoutRatio, valuationSource: historyFace > 0 ? "historical-cashout" : "configured-estimate",
      valuationSampleQuantity: sum(historical.map(event => event.quantity)), targetCashoutRatio: settings.targetCashoutRatio,
      theoreticalProfitCents: total(inventory, row => row.theoretical?.bestProfitCents ?? null), knownTheoreticalProfitCents: sum(inventory.map(row => row.theoretical?.bestProfitCents).filter(value => value != null)),
      theoreticalUnknownCount: inventory.filter(row => row.theoretical?.bestProfitCents == null).length,
      uncoveredSaleQuantity: known(rows, row => row.uncoveredSaleQuantity) };
    result.averageBuyCostCents = average(result.buyCostCents, result.buyQuantity);
    result.walletRatio = result.walletBalanceCents > 0 && result.walletCashBasisCents != null ? result.walletCashBasisCents / result.walletBalanceCents : null;
    result.knownRealizedProfitQuantity = result.knownCashoutProfitQuantity + result.knownDirectProfitQuantity;
    result.knownRealizedProfitCount = result.knownCashoutProfitCount + result.knownDirectProfitCount;
    return result;
  }
  const summary = summarizeCurrency("CNY");
  summary.currencies = [...new Set([...groups, ...walletViews, ...cashFinancial].map(row => row.currencyCode))].sort().map(summarizeCurrency);
  summary.totalHoldingQuantity = sum(holdings.map(row => row.remainingQuantity)); summary.totalBuyQuantity = sum(groups.map(row => row.buy.quantity));
  summary.totalSoldQuantity = sum(groups.map(row => row.knife.quantity + row.cashout.quantity + row.direct.quantity + row.steamReturn.quantity + row.uncoveredSaleQuantity));
  summary.anomalyCount = anomalies.length;
  const quality = { unknownAmountCount: periodOrders.filter(row => row.actualTotalCents == null).length,
    unresolvedNameCount: periodOrders.filter(row => row.originalNameCategory).length, missingTimeCount: anomalies.filter(row => row.code === "missing_trade_time").length,
    uncoveredSaleQuantity: sum(groups.map(row => row.uncoveredSaleQuantity)), ignoredCount: normalized.ignoredCount, invalidRecordCount: anomalies.length,
    openingUnknownCostCount: groups.filter(row => row.opening.costCents == null).length, minimumUnknownFundingCents: summary.minimumUnknownFundingCents,
    dailySettlement: true };
  let directKnown = 0, cycleKnown = 0, directKnownQuantity = 0, cycleKnownQuantity = 0, directComplete = true, cycleComplete = true, fullComplete = !undatedCashSales.some(row => row.currencyCode === "CNY");
  const invalidDates = new Set(invalidCashSales.filter(row => row.currencyCode === "CNY" && inPeriod(row)).map(localDay));
  const profitCurve = curveDays.map(day => {
    const events = day.events.filter(event => event.currencyCode === "CNY"), direct = events.filter(event => event.route === "direct"), cycle = events.filter(event => event.route === "cashout");
    const dailyDirect = completeSum(direct.map(event => event.profitCents)), dailyCycle = completeSum(cycle.map(event => event.profitCents));
    directKnown = sum([directKnown, ...direct.map(event => event.knownProfitCents)]); cycleKnown = sum([cycleKnown, ...cycle.map(event => event.knownProfitCents)]);
    directKnownQuantity += sum(direct.filter(event => event.profitCents != null).map(event => event.quantity));
    cycleKnownQuantity += sum(cycle.filter(event => event.profitCents != null).map(event => event.quantity));
    directComplete &&= dailyDirect != null; cycleComplete &&= dailyCycle != null;
    fullComplete &&= directComplete && cycleComplete && !events.some(event => event.route === "uncoveredCash") && !invalidDates.has(day.date);
    return { date: day.date, currencyCode: "CNY", dailyRealizedProfitCents: events.some(event => event.route === "uncoveredCash") || invalidDates.has(day.date) ? null : completeSum([dailyDirect, dailyCycle]),
      realizedProfitCents: fullComplete ? sum([directKnown, cycleKnown]) : null, knownRealizedProfitCents: sum([directKnown, cycleKnown]),
      directRealizedProfitCents: directComplete ? directKnown : null, knownDirectRealizedProfitCents: directKnown,
      cashoutCycleProfitCents: cycleComplete ? cycleKnown : null, knownCashoutCycleProfitCents: cycleKnown,
      knownDirectProfitQuantity: directKnownQuantity, knownCashoutProfitQuantity: cycleKnownQuantity, knownRealizedProfitQuantity: directKnownQuantity + cycleKnownQuantity };
  });
  return { version: 3, computedAt: new Date(now).toISOString(), dateFrom, dateTo, accounts: normalized.accounts, orders: periodOrders, groups, holdings, excludedHoldings,
    wallets: walletViews, summary, quality, anomalies, ignoredCount: normalized.ignoredCount, profitCurve,
    ...(fundingScenario ? { fundingScenario: { method: "historical-knife-rate", assumptions: [...assumedFunding.values()] } } : {}),
    accountingMethod: "daily-source-pools", accountingLabel: "按自然日与来源池均价核算；优先挂刀、提现，Steam 回卖余额日末入账", targetCashoutRatio: settings.targetCashoutRatio };
}

module.exports = { DAY, CD_MS, accountKey, sourceId, portion, listAccounts, normalizeOrders, buildOrderLedger, buildAggregateLedger };
