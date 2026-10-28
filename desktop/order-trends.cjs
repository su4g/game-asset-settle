"use strict";

// Personal completed trades only. These observations are not market quotations
// and must never feed a holding's market valuation or refresh its quote time.
const DAY_MS = 86400000, SHANGHAI_OFFSET_MS = 8 * 3600000;
const PLATFORMS = Object.freeze({ steam: "Steam", buff: "BUFF", uu: "悠悠" });

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`请明确选择${label}`);
  return value.trim();
}
function dayStart(at) { return Math.floor((at + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS; }
function dayLabel(at) { return new Date(at + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10); }
function safeAdd(left, right) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error("成交走势金额或数量超出安全计算范围");
  return result;
}

/**
 * Accepts normalized orders from order-ledger.cjs. A portfolio is an explicit
 * account link chosen by the user; otherwise accountKeys selects exact source /
 * platform / account identities. There is deliberately no all-accounts default.
 * All days use Asia/Shanghai; asOf limits instant-precision observations.
 */
function buildOrderTrends(orders, options = {}) {
  if (!Array.isArray(orders)) throw new Error("成交走势需要标准订单列表");
  const appid = Number(options.appid);
  if (!Number.isSafeInteger(appid) || appid <= 0) throw new Error("请明确选择游戏 App ID");
  const marketHashName = text(options.marketHashName, "完整市场名称");
  if (!["buy", "sell"].includes(options.direction)) throw new Error("请明确选择买入或卖出方向");
  const direction = options.direction, currencyCode = text(options.currencyCode, "币种");
  const portfolioId = options.portfolioId == null ? "" : text(options.portfolioId, "账户组合");
  let accountKeys = null;
  if (options.accountKeys != null) {
    if (!Array.isArray(options.accountKeys) || !options.accountKeys.length) throw new Error("请明确选择账户");
    accountKeys = new Set(options.accountKeys.map(value => text(value, "账户")));
  }
  if (!portfolioId && !accountKeys) throw new Error("成交走势需要明确的账户组合或账户范围");
  const asOf = options.asOf ?? Date.now();
  if (!Number.isSafeInteger(asOf) || asOf < 0 || asOf > 8640000000000000 - DAY_MS) throw new Error("成交走势截止时间无效");
  const end = dayStart(asOf), start = end - 6 * DAY_MS;
  const points = Array.from({ length: 7 }, (_, index) => {
    const at = start + index * DAY_MS;
    return { date: dayLabel(at), at, steam: null, buff: null, uu: null };
  });
  const series = Object.entries(PLATFORMS).map(([platform, label]) => ({
    platform, label, accountKeys: [], points: points.map(({ date, at }) => ({
      date, at, averageCents: null, totalCents: null, quantity: 0, orderCount: 0,
      knownTotalCents: 0, knownQuantity: 0, unknownAmountCount: 0, dayPrecisionCount: 0,
      complete: false,
    })),
  }));
  const byPlatform = new Map(series.map(item => [item.platform, item]));
  const usedAccounts = new Map(series.map(item => [item.platform, new Set()]));

  for (const order of orders) {
    if (!order || order.completed !== true || order.appid !== appid || order.marketHashName !== marketHashName
      || order.direction !== direction || order.currencyCode !== currencyCode
      || portfolioId && order.portfolioId !== portfolioId || accountKeys && !accountKeys.has(order.accountKey)) continue;
    const platform = byPlatform.get(order.platform);
    if (!platform) continue;
    if (!Number.isSafeInteger(order.quantity) || order.quantity <= 0 || !Number.isSafeInteger(order.timeStart)) throw new Error("标准订单数量或成交时间无效");
    const at = order.timeStart;
    if (at < start || at > asOf) continue;
    const index = Math.floor((dayStart(at) - start) / DAY_MS);
    if (index < 0 || index >= points.length) continue;
    const point = platform.points[index];
    point.orderCount = safeAdd(point.orderCount, 1);
    point.quantity = safeAdd(point.quantity, order.quantity);
    if (order.timePrecision === "day") point.dayPrecisionCount++;
    if (order.actualTotalCents == null) point.unknownAmountCount++;
    else {
      if (!Number.isSafeInteger(order.actualTotalCents) || order.actualTotalCents < 0) throw new Error("标准订单实付或净到账金额无效");
      point.knownTotalCents = safeAdd(point.knownTotalCents, order.actualTotalCents);
      point.knownQuantity = safeAdd(point.knownQuantity, order.quantity);
    }
    usedAccounts.get(order.platform).add(text(order.accountKey, "标准订单账户"));
  }

  for (const platform of series) {
    platform.accountKeys = [...usedAccounts.get(platform.platform)].sort();
    platform.points.forEach((point, index) => {
      point.complete = point.orderCount > 0 && point.unknownAmountCount === 0;
      if (point.complete) {
        point.totalCents = point.knownTotalCents;
        // Preserve the rational mean until presentation; never average unit prices.
        point.averageCents = point.totalCents / point.quantity;
      }
      points[index][platform.platform] = point.averageCents;
    });
  }
  return {
    kind: "personal-trade-average", title: "本人实际成交均价", amountBasis: "actual",
    amountLabel: direction === "buy" ? "买入实付均价" : "卖出净到账均价",
    timeZone: "Asia/Shanghai", start: points[0].date, end: points[6].date, asOf,
    scope: { appid, marketHashName, direction, currencyCode, portfolioId: portfolioId || null,
      accountKeys: accountKeys ? [...accountKeys].sort() : null },
    points, series,
    note: "按上海日期汇总本人已完成交易，均价为实付或净到账总额 ÷ 总数量；无成交或金额未核对的日期留空，不代表平台市场行情。",
  };
}

module.exports = { buildOrderTrends };
