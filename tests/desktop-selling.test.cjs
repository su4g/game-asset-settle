"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const P = require("../desktop/pricing.js"), C = require("../common.js");
const now = Date.parse("2026-10-21T08:00:00Z");
const holding = patch => ({ id: "purchase-1", appid: 730, marketHashName: "Test Case", name: "已购测试物品", goodsId: "123", confirmed: true,
  remainingQuantity: 1, inventoryCostCents: 346, inventoryBuyCents: 346, buyTotalCents: 346, quantity: 1, direction: "knife", boughtAt: "2026-10-01T00:00:00Z", ...patch });
const quote = (patch = {}, at = now) => P.normalizeRow({ appid: 730, marketHashName: "Test Case", goodsId: "123", source: "manual", buffPriceCents: 408, buffBuyPriceCents: 380, steamLowestSellCents: 625, buffUpdatedAt: at, buffBuyUpdatedAt: at, steamUpdatedAt: at, ...patch });
const compare = (ratio, h = holding(), q = quote()) => P.compareHolding(h, [q], { ...P.DEFAULTS, targetCashoutRatio: ratio }, now);

test("3.46 成本的三种门槛、7 折挂售最高、7.3 折并列、7.5 折 Steam 最高", () => {
  const r = compare(0.7);
  assert.equal(r.steamNetCents, 544);
  assert.deepEqual(r.routes.map(x => [x.proceedsCents, x.profitCents]), [[397, 51], [370, 24], [380, 34]]);
  assert.equal(r.breakEvenCashoutRatio, 346 / 544);
  assert.equal(r.beatBuffAskCashoutRatio, 398 / 544); assert.equal(r.beatBuffBidCashoutRatio, 371 / 544);
  assert.deepEqual([r.breakEvenCashoutRatio, r.beatBuffAskCashoutRatio, r.beatBuffBidCashoutRatio].map(x => C.formatDiscount(x, { roundUp: true })), ["6.361 折", "7.317 折", "6.820 折"]);
  assert.deepEqual(r.bestRoutes, ["buffAsk"]); assert.equal(r.advantageCents, 17);
  assert.deepEqual(compare(0.73).bestRoutes, ["buffAsk", "steam"]);
  assert.deepEqual(compare(0.75).bestRoutes, ["steam"]); assert.equal(compare(0.75).advantageCents, 11);
  assert.equal(compare(0.8).routes[2].profitCents, 89);
});

test("向上展示的门槛确实达标，比它低 0.001 折不能达标", () => {
  const r = compare(0.8);
  for (const [threshold, target] of [[r.breakEvenCashoutRatio, 346], [r.beatBuffAskCashoutRatio, 398], [r.beatBuffBidCashoutRatio, 371]]) {
    const rounded = Number(C.formatDiscount(threshold, { roundUp: true }).split(" ")[0]) / 10;
    assert.ok(compare(rounded).routes[2].proceedsCents >= target);
    assert.ok(compare(rounded - 0.0001).routes[2].proceedsCents < target);
  }
});

test("分批出售剩余成本保留余分，手续费逐件、提现整批取分", () => {
  const r = compare(0.7, holding({ quantity: 5, remainingQuantity: 3, buyTotalCents: 1668, inventoryCostCents: 1001 }));
  assert.equal(r.costCents, 1001); assert.equal(r.steamNetCents, 1632);
  assert.deepEqual(r.routes.map(x => x.proceedsCents), [1191, 1110, 1142]);
  assert.equal(r.routes[2].profitCents, 141); assert.equal(r.breakEvenCashoutRatio, 1001 / 1632);
  assert.equal(r.beatBuffAskCashoutRatio, 1192 / 1632);
});

test("报价失效按路线隔离，不用过期、错误、未来或异币种报价", () => {
  const bid = compare(0.8, holding(), quote({ buffBuyUpdatedAt: now - P.BUY_TTL }));
  assert.equal(bid.routes[1].profitCents, null); assert.equal(bid.beatBuffBidCashoutRatio, null);
  assert.equal(bid.complete, false); assert.deepEqual(bid.bestRoutes, ["steam"]);
  const ask = compare(0.8, holding(), quote({ buffUpdatedAt: now - P.TTL }));
  assert.equal(ask.routes[0].proceedsCents, null); assert.equal(ask.breakEvenCashoutRatio, 346 / 544);
  const steam = compare(0.8, holding(), quote({ steamUpdatedAt: now - P.TTL }));
  assert.equal(steam.routes[2].proceedsCents, null); assert.equal(steam.breakEvenCashoutRatio, null); assert.deepEqual(steam.bestRoutes, ["buffAsk"]);
  for (const patch of [{ steamError: "失败" }, { steamUpdatedAt: null }, { steamUpdatedAt: now + 1 }, { steamLowestSellCents: 2 }, { steamExpiresAt: now }, { steamCurrencyInvalid: true }]) {
    assert.equal(compare(0.8, holding(), quote(patch)).routes[2].proceedsCents, null, JSON.stringify(patch));
  }
  assert.ok(compare(0.8, holding({ currencyCode: "USD" }), quote({ currencyCode: "USD" })).routes.every(x => x.proceedsCents == null));
});

test("未知成本、未确认、已售完、模拟报价或身份不符不产生有效利润结论", () => {
  for (const patch of [{ inventoryCostCents: null }, { inventoryCostCents: -1 }, { inventoryCostCents: 346.5 }, { confirmed: false }, { remainingQuantity: 0 }]) {
    const r = compare(0.8, holding(patch)); assert.deepEqual(r.bestRoutes, []); assert.equal(r.breakEvenCashoutRatio, null);
  }
  for (const patch of [{ source: "example" }, { appid: 570 }, { marketHashName: "Different" }, { goodsId: "456" }]) assert.deepEqual(compare(0.8, holding(), quote(patch)).bestRoutes, []);
  assert.equal(compare(0.8, holding({ inventoryCostCents: 0 })).breakEvenCashoutRatio, 0);
  const losing = compare(0.7, holding({ inventoryCostCents: 600 })); assert.equal(losing.bestProfitCents, -203); assert.deepEqual(losing.bestRoutes, ["buffAsk"]);
});

test("账本与本机报价逐平台取较新时间，按新手续费重算而不刷新时间", () => {
  const h = holding({ quote: { buffPriceCents: 500, buffNetCents: 999999, buffObservedAt: new Date(now - 10).toISOString(), steamPriceCents: 650, steamNetCents: 999999, steamObservedAt: new Date(now - 20).toISOString() } });
  const q = quote({ buffUpdatedAt: now - 30 }), before = JSON.stringify([h, q]), r = compare(0.8, h, q);
  assert.equal(r.quote.buffPriceCents, 500); assert.equal(r.quote.steamLowestSellCents, 625);
  assert.equal(r.quote.buffUpdatedAt, now - 10); assert.equal(r.quote.steamUpdatedAt, now);
  assert.equal(r.routes[0].proceedsCents, 487); assert.equal(r.steamNetCents, 544); assert.equal(JSON.stringify([h, q]), before);
  const fee = P.compareHolding(h, [q], { ...P.DEFAULTS, buffCsgoSellFeePercent: 0 }, now);
  assert.equal(fee.routes[0].proceedsCents, 500); assert.equal(fee.beatBuffAskCashoutRatio, 501 / 544);
});
