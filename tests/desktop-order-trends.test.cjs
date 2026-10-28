"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { buildOrderTrends } = require("../desktop/order-trends.cjs");
const asOf = Date.parse("2026-10-21T12:00:00+08:00");
const account = platform => JSON.stringify([platform === "steam" ? "csv" : platform, platform, "owner"]);
const scope = { appid: 730, marketHashName: "Exact Item (Factory New)", direction: "buy", currencyCode: "CNY", portfolioId: "mine", asOf };
function order(patch = {}) {
  const row = { completed: true, platform: "buff", accountKey: account("buff"), portfolioId: "mine", appid: 730,
    marketHashName: scope.marketHashName, direction: "buy", currencyCode: "CNY", quantity: 1,
    actualTotalCents: 100, timeStart: Date.parse("2026-10-20T12:00:00+08:00"), timePrecision: "instant", ...patch };
  return row;
}
const platformPoint = (result, platform, date = "2026-10-20") => result.series.find(item => item.platform === platform).points.find(point => point.date === date);

test("三平台按总实付除以总数量，保留分的小数，缺日不插值", () => {
  const result = buildOrderTrends([
    order({ quantity: 2, actualTotalCents: 201 }), order({ quantity: 1, actualTotalCents: 100 }),
    order({ platform: "steam", accountKey: account("steam"), quantity: 4, actualTotalCents: 501 }),
    order({ platform: "uu", accountKey: account("uu"), actualTotalCents: 97 }),
  ], scope);
  assert.equal(result.start, "2026-10-15"); assert.equal(result.end, "2026-10-21");
  assert.equal(result.points.length, 7); assert.equal(result.kind, "personal-trade-average");
  assert.equal(result.points[5].buff, 301 / 3); assert.equal(result.points[5].steam, 501 / 4); assert.equal(result.points[5].uu, 97);
  assert.equal(platformPoint(result, "buff").totalCents, 301);
  assert.equal(platformPoint(result, "buff").quantity, 3);
  assert.equal(platformPoint(result, "buff").orderCount, 2);
  assert.equal(platformPoint(result, "buff").complete, true);
  assert.deepEqual(result.points.map(point => point.buff), [null, null, null, null, null, 301 / 3, null]);
});

test("游戏、完整名、买卖、币种、账户组合不混算", () => {
  const rows = [order(), ...[
    { appid: 570 }, { marketHashName: "Exact Item (Minimal Wear)" }, { direction: "sell" }, { currencyCode: "USD" },
    { portfolioId: "other", accountKey: "other-owner" }, { completed: false }, { platform: "other" },
  ].map(patch => order({ actualTotalCents: 999999, ...patch }))];
  const result = buildOrderTrends(rows, scope);
  assert.equal(platformPoint(result, "buff").totalCents, 100);
  assert.equal(platformPoint(result, "buff").orderCount, 1);
  const narrowed = buildOrderTrends([order(), order({ accountKey: "another-buff-account" })], { ...scope, accountKeys: [account("buff")] });
  assert.equal(platformPoint(narrowed, "buff").orderCount, 1);
  assert.deepEqual(narrowed.series.find(row => row.platform === "buff").accountKeys, [account("buff")]);
});

test("必须明确账户范围；可跨三平台选定账户，不默认聚合全部历史", () => {
  const options = { ...scope }; delete options.portfolioId;
  assert.throws(() => buildOrderTrends([], options), /账户组合或账户范围/);
  assert.throws(() => buildOrderTrends([], { ...scope, direction: "all" }), /买入或卖出/);
  assert.throws(() => buildOrderTrends([], { ...scope, currencyCode: "" }), /币种/);
  assert.throws(() => buildOrderTrends([], { ...scope, marketHashName: "" }), /完整市场名称/);
  assert.throws(() => buildOrderTrends([], { ...options, accountKeys: [] }), /选择账户/);
  const result = buildOrderTrends([order(), order({ portfolioId: "another", accountKey: "another" })], { ...options, accountKeys: [account("buff")] });
  assert.equal(platformPoint(result, "buff").orderCount, 1);
});

test("未知净到账不以挂价代替，也不把已知部分展示成完整日均价", () => {
  const result = buildOrderTrends([order({ direction: "sell", actualTotalCents: 70 }),
    order({ direction: "sell", actualTotalCents: null, grossTotalCents: 100, paidTotalCents: 90 })], { ...scope, direction: "sell" });
  const point = platformPoint(result, "buff");
  assert.equal(result.amountLabel, "卖出净到账均价"); assert.equal(result.amountBasis, "actual");
  assert.equal(point.averageCents, null); assert.equal(point.totalCents, null); assert.equal(point.complete, false);
  assert.equal(point.knownTotalCents, 70); assert.equal(point.quantity, 2); assert.equal(point.knownQuantity, 1); assert.equal(point.unknownAmountCount, 1);
  assert.equal(result.points[5].buff, null);
});

test("上海零点、七天窗口边界与未来精确成交时间正确隔离", () => {
  const result = buildOrderTrends([
    order({ timeStart: Date.parse("2026-10-14T23:59:59.999+08:00"), actualTotalCents: 9 }),
    order({ timeStart: Date.parse("2026-10-15T00:00:00+08:00"), actualTotalCents: 11 }),
    order({ timeStart: Date.parse("2026-10-19T16:00:00Z"), actualTotalCents: 13 }),
    order({ timeStart: asOf, actualTotalCents: 17 }),
    order({ timeStart: asOf + 1, actualTotalCents: 19 }),
  ], scope);
  assert.equal(result.points[0].buff, 11); assert.equal(result.points[5].buff, 13); assert.equal(result.points[6].buff, 17);
  const dayPrecision = buildOrderTrends([order({ timeStart: Date.parse("2026-10-21T00:00:00+08:00"), timePrecision: "day" })], scope);
  assert.equal(platformPoint(dayPrecision, "buff", "2026-10-21").dayPrecisionCount, 1);
});

test("零净到账是有效观察，异常整数与汇总溢出不产生假曲线", () => {
  assert.equal(platformPoint(buildOrderTrends([order({ actualTotalCents: 0 })], scope), "buff").averageCents, 0);
  for (const actualTotalCents of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => buildOrderTrends([order({ actualTotalCents })], scope), /金额无效/);
  assert.throws(() => buildOrderTrends([order({ actualTotalCents: Number.MAX_SAFE_INTEGER }), order()], scope), /安全计算范围/);
  assert.throws(() => buildOrderTrends([order({ quantity: 1.5 })], scope), /数量或成交时间/);
  assert.throws(() => buildOrderTrends([], { ...scope, asOf: NaN }), /截止时间/);
});

test("读取趋势不改变原始订单金额、成交时间或账户身份", () => {
  const rows = [Object.freeze(order())], before = JSON.stringify(rows);
  buildOrderTrends(Object.freeze(rows), scope);
  assert.equal(JSON.stringify(rows), before);
});
