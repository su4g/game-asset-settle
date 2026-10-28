"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../desktop/pricing.js");
const C = require("../common.js");
const now = Date.parse("2026-10-14T07:00:00Z");

test("持仓可比较悠悠已扣费净报价，不猜测费用或使用过期报价", () => {
  const holding = { appid: 730, marketHashName: "UU net sample", confirmed: true, remainingQuantity: 2, inventoryCostCents: 600, currencyCode: "CNY" };
  const rows = [P.normalizeRow({ appid: 730, marketHashName: holding.marketHashName, source: "manual", uuNetSellCents: 400, uuUpdatedAt: now })];
  const result = P.compareHolding(holding, rows, P.DEFAULTS, now);
  assert.equal(result.routes.find(route => route.id === "uu").proceedsCents, 800);
  assert.equal(result.routes.find(route => route.id === "uu").profitCents, 200);
  assert.deepEqual(result.bestRoutes, ["uu"]);
  assert.equal(P.compareHolding(holding, rows, P.DEFAULTS, now + P.TTL).routes.find(route => route.id === "uu").profitCents, null);
  const updated = P.mergeRows(rows, [P.normalizeRow({ ...rows[0], uuUpdatedAt: now - 1, uuNetSellCents: 999 })]);
  assert.equal(updated[0].uuNetSellCents, 400);
  assert.equal(updated[0].uuUpdatedAt, now);
});
const quote = patch => ({ ...P.examples(now)[0], ...patch });

test("桌面沿用分位手续费：3 分买家总价净到 1 分，求购与在售折扣分别计算", () => {
  const row = P.analyzeRow(quote({ buffPriceCents: 1, buffBuyPriceCents: 2, steamLowestSellCents: 3, steamHighestBuyCents: 3 }), P.DEFAULTS, now);
  assert.equal(row.steamNetSellCents, 1);
  assert.equal(row.steamFeeCents, 2);
  assert.equal(row.knifeRatio, 1);
  assert.equal(row.buffNetSellCents, 0);
  assert.equal(row.cashoutRatio, 0);
  assert.equal(row.buffBuyNetCents, 1);
  assert.equal(row.buyOrderCashoutRatio, 1 / 3);
  assert.equal(row.instantKnifeRatio, 1);
});

test("分游戏手续费重算原始报价，忽略导入的旧折扣和旧手续费结果", () => {
  const rows = P.examples(now).map(row => P.analyzeRow({ ...row, knifeRatio: 0.01, buffNetSellCents: 99999 }, { ...P.DEFAULTS, buffCsgoSellFeePercent: 0, buffDota2SellFeePercent: 10 }, now));
  assert.equal(rows[0].buffNetSellCents, 5000);
  assert.equal(rows[1].buffNetSellCents, 2700);
  assert.equal(rows[0].knifeRatio, 5000 / 6958);
  assert.equal(rows[0].buffUpdatedAt, now);
});

test("BUFF 求购五分钟失效，在售与 Steam 十五分钟失效，不延长显式有效期", () => {
  const afterBid = P.analyzeRow(quote(), P.DEFAULTS, now + P.BUY_TTL);
  assert.equal(afterBid.buyOrderCashoutRatio, null);
  assert.equal(afterBid.ready, true);
  const afterAsk = P.analyzeRow(quote(), P.DEFAULTS, now + P.TTL);
  assert.equal(afterAsk.knifeRatio, null);
  assert.equal(afterAsk.cashoutRatio, null);
  assert.equal(afterAsk.candidate, false);
  assert.equal(P.analyzeRow(quote({ steamExpiresAt: now + 1 }), P.DEFAULTS, now + 1).ready, false);
});

test("缺失、未来时间、异币种和显式美元旧缓存均不产生有效折扣", () => {
  for (const patch of [
    { steamUpdatedAt: null }, { buffUpdatedAt: null }, { steamUpdatedAt: now + 1 }, { currencyCode: "USD" },
    { priceoverview: { lowest_price: "$80.00" } }, { steamError: "查询失败" }, { steamLowestSellCents: 2 },
  ]) {
    const row = P.analyzeRow(quote(patch), P.DEFAULTS, now);
    assert.equal(row.ready, false, JSON.stringify(patch)); assert.equal(row.knifeRatio, null); assert.equal(row.candidate, false);
  }
  assert.equal(P.analyzeRow(quote({ currencyCode: "USD" }), P.DEFAULTS, now).buffBuyNetCents, null);
  const belowMinimum = P.analyzeRow(quote({ steamLowestSellCents: 2 }), P.DEFAULTS, now);
  assert.equal(belowMinimum.cashoutRatio, null); assert.equal(belowMinimum.buyOrderCashoutRatio, null);
});

test("筛选沿用成交量除以十，未知或过期成交量不能冒充达到门槛", () => {
  const row = P.analyzeRow(quote(), P.DEFAULTS, now);
  assert.equal(row.liquidityCoefficient, 24); assert.equal(row.candidate, true);
  for (const patch of [{ steamVolume24h: null }, { steamVolumeCheckedAt: null }, { steamVolumeCheckedAt: now - P.TTL }]) assert.equal(P.analyzeRow(quote(patch), P.DEFAULTS, now).candidate, false);
  assert.equal(P.analyzeRow(quote(), { ...P.DEFAULTS, maxBuffPriceCents: 4999 }, now).candidate, false);
  assert.equal(P.analyzeRow(quote(), { ...P.DEFAULTS, maxKnifeRatio: 0.7 }, now).candidate, false);
});

test("模拟组合按数量加权，保本门槛向上取整，回款向下取分", () => {
  const rows = P.examples(now).map(row => P.analyzeRow({ ...row, selected: true }, P.DEFAULTS, now));
  const { summary } = P.portfolio(rows, now);
  assert.equal(summary.quantity, 5);
  assert.equal(summary.totalSpentCents, 19000);
  assert.equal(summary.totalNetCents, 26963);
  assert.equal(summary.breakEvenCashoutRatio, 19000 / 26963);
  assert.equal(C.formatDiscount(summary.breakEvenCashoutRatio, { roundUp: true }), "7.047 折");
  assert.deepEqual(C.calculateCashoutScenario(summary, 0.8), { proceedsCents: 21570, profitCents: 2570, breaksEven: true });
  assert.equal(P.portfolio(rows.map(row => ({ ...row, selected: false })), now).summary.purchaseCount, 0);
});

test("组合有一条过期或币种不符时不提供全部保本和回款，缺价不按零", () => {
  for (const patch of [{ steamUpdatedAt: now - P.TTL }, { buffUpdatedAt: now - P.TTL }, { currencyCode: "USD" }, { steamLowestSellCents: null }]) {
    const rows = P.examples(now).map((row, i) => P.analyzeRow({ ...row, selected: true, ...(i ? patch : {}) }, P.DEFAULTS, now));
    const { summary } = P.portfolio(rows, now);
    assert.equal(summary.complete, false);
    assert.equal(summary.breakEvenCashoutRatio, null);
    assert.equal(C.calculateCashoutScenario(summary, 0.8), null);
  }
});

test("旧报价导入不覆盖较新平台报价，更新 BUFF 不倒退 Steam 时间，不改变试算数量", () => {
  const old = quote({ steamUpdatedAt: now + 200, quantity: 9, selected: true });
  const next = quote({ buffUpdatedAt: now + 100, buffPriceCents: 5500, steamUpdatedAt: now + 100, steamLowestSellCents: 9000, quantity: 1 });
  const [merged] = P.mergeRows([old], [next]);
  assert.equal(merged.buffPriceCents, 5500);
  assert.equal(merged.steamLowestSellCents, 8000);
  assert.equal(merged.steamUpdatedAt, now + 200);
  assert.equal(merged.quantity, 9); assert.equal(merged.selected, true);
  assert.equal(P.mergeRows([merged], [quote({ buffPriceCents: 100 })])[0].buffPriceCents, 5500);
  assert.throws(() => P.mergeRows([quote({ goodsId: "123" })], [quote({ goodsId: "456" })]), /ID 不一致/);
});

test("JSON/CSV 导入保留时间与整数分，正确处理带逗号与换行的名称，禁止自动选择组合", () => {
  const csv = '\uFEFFappid,marketHashName,buffPriceCents,steamLowestSellCents,buffUpdatedAt,steamUpdatedAt\r\n730,"A, \"\"B\"\"\nCase",5000,8000,2026-10-14T07:00:00Z,2026-10-14T07:00:00Z\r\n';
  const [row] = P.parseImport(csv);
  assert.equal(row.marketHashName, 'A, "B"\nCase'); assert.equal(row.buffUpdatedAt, now); assert.equal(row.buffPriceCents, 5000);
  const [json] = P.parseImport(JSON.stringify({ rows: [quote({ selected: true })], exportedAt: now + 999 }));
  assert.equal(json.selected, false); assert.equal(json.buffUpdatedAt, now);
  for (const source of ['[]broken', 'appid,appid\n730,730', 'appid,marketHashName\n730,"broken', 'appid,marketHashName,buffPriceCents\n730,Case,50.12']) assert.throws(() => P.parseImport(source));
});

test("排序保持缺价在末尾，类型与游戏筛选区分 CS2 武器箱、胶囊和 Dota 2", () => {
  const rows = [quote({ marketHashName: "Recoil Case" }), quote({ marketHashName: "Sticker Capsule" }), quote({ appid: 570, marketHashName: "Dota Case" }), quote({ marketHashName: "Missing", steamLowestSellCents: null })].map(row => P.analyzeRow(row, P.DEFAULTS, now));
  assert.deepEqual(P.filterRows(rows, { scope: "cases" }).map(row => row.marketHashName), ["Recoil Case"]);
  for (const direction of ["asc", "desc"]) assert.equal(P.filterRows(rows, { direction }).at(-1).marketHashName, "Missing");
  assert.equal(P.filterRows(rows, { scope: "570", search: "dota" }).length, 1);
});

test("金额输入和批量大小边界阻止浮点分、超大组合与负值", () => {
  assert.equal(P.cents("12.34"), 1234);
  assert.equal(P.cents("", true), null);
  for (const value of ["1.001", "-1", "1e4", "Infinity", "0"]) assert.throws(() => P.cents(value));
  for (const patch of [{ quantity: 10001 }, { quantity: 0 }, { buffPriceCents: 12.5 }, { steamVolume24h: -1 }]) assert.throws(() => P.normalizeRow(quote(patch)));
  assert.throws(() => P.normalizeRows(Array.from({ length: 501 }, () => quote())));
  assert.throws(() => P.parseImport(" ".repeat(1024 * 1024 + 1)));
});
