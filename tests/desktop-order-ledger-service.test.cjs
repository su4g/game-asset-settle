"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { OrderLedgerService } = require("../desktop/order-ledger-service.cjs");
const { accountKey, sourceId } = require("../desktop/order-ledger.cjs");
const buffKey = accountKey("buff", "buff", "buff:owner"), uuKey = accountKey("uu", "uu", "uu:owner"), steamKey = accountKey("csv", "steam", "steam-owner");
const buyId = sourceId("buff", "buff-buy"), saleId = sourceId("csv", "steam-sale");
function archive() {
  const native = (platform, key, patch = {}) => ({ key, accountId: `${platform}:owner`, appid: 730,
    name: "测试物品", marketHashName: "Test Item", direction: "buy", channel: "history", completed: true,
    quantity: 2, currencyCode: "CNY", paidTotalCents: 200, netTotalCents: null,
    tradedAt: "2020-01-01T00:00:00.000Z", ...patch });
  return {
    buff: { data: { version: 1, accounts: { "buff:owner": { records: [native("buff", "buff-buy")],
      runs: [{ appid: 730, direction: "buy", channel: "history", complete: true, syncedAt: "2020-01-02T00:00:00.000Z" }] } } } },
    uu: { data: { version: 1, accounts: { "uu:owner": { records: [native("uu", "uu-buy", { marketHashName: "Other Item", quantity: 1, paidTotalCents: null })],
      runs: [{ appid: 730, direction: "buy", channel: "history", complete: true, syncedAt: "2020-01-03T00:00:00.000Z" }] } } } },
    steam: { data: { version: 1, accounts: {} } }, csv: { rows: [{ key: "steam-sale", scope: "steam-owner", platform: "steam", appid: "730", marketHashName: "Test Item", itemName: "测试物品",
      type: "sale", quantity: 1, currency: "CNY", totalCents: 200, date: "2020-01-10", sourceTime: "2020-01-10" }],
      imports: [{ fileName: "steam.csv", scope: "steam-owner", importedAt: "2020-01-11T00:00:00.000Z", inserted: 1 }], importedAt: Date.now() },
    names: { items: {} },
  };
}
function setup() {
  const data = archive(), calls = [], writes = [];
  let stored = { orderLedger: { untouched: { accountLinks: [], overrides: { keep: { actualTotalCents: 99 } } } },
    priceWorkspace: { rows: [], settings: { targetCashoutRatio: 0.75 } } }, failWrite = false;
  const state = { async get(keys) { await Promise.resolve(); return Object.fromEntries(keys.filter(key => Object.hasOwn(stored, key)).map(key => [key, structuredClone(stored[key])])); },
    async set(value) { if (failWrite) { failWrite = false; throw new Error("模拟写入失败"); } writes.push(structuredClone(value)); stored = { ...stored, ...structuredClone(value) }; } };
  const request = async path => { calls.push(path); assert.equal(typeof path, "string"); assert.match(path, /^\/history\/(buff|uu|steam|csv|names)$/); return structuredClone(data[path.split("/").at(-1)]); };
  return { service: new OrderLedgerService({ state, request, scope: "database-a" }), state, request, data, calls, writes,
    saved: () => structuredClone(stored), failWrite: () => { failWrite = true; } };
}
const configuration = { accountLinks: [{ id: "mine", name: "本人三平台", accountKeys: [buffKey, uuKey, steamKey] }], csvAmountSemantics: { [steamKey]: "actual" } };

test("Steam 原生历史替换已核对 CSV，保留手动账户组与退款状态，不二次计算现金来源",async()=>{
  const env=setup();await env.service.configure(configuration);
  const accountId="steam:76561198000000001", nativeKey=accountKey("steam","steam",accountId),csv=env.data.csv.rows[0];
  const row={key:"native-sell",accountId,appid:730,name:csv.itemName,marketHashName:csv.marketHashName,channel:"history",direction:"sell",state:"COMPLETED",completed:true,quantity:1,currencyCode:"CNY",netTotalCents:200,tradedAt:"2020-01-10T00:00:00.000Z"};
  env.data.steam.data.accounts[accountId]={account:{id:accountId},records:[row],runs:[],csvBindings:[{scope:csv.scope,matchedCount:1,pairs:[[csv.key,row.key]]}]};
  const result=await env.service.load();assert.equal(result.orders.length,3);assert.equal(result.sourceStatus.steam.recordCount,1);assert.equal(result.sourceStatus.csv.recordCount,1);assert.equal(result.sourceStatus.csv.suppressedCount,1);
  assert.equal(result.accounts.find(a=>a.key===nativeKey).portfolioId,"mine");assert.equal(result.groups.find(g=>g.marketHashName==="Test Item").knife.quantity,1);
  Object.assign(row,{completed:false,state:"REFUNDED",netTotalCents:null});const refunded=await env.service.load();assert.equal(refunded.orders.filter(r=>r.platform==="steam").length,0);assert.equal(refunded.sourceStatus.csv.suppressedCount,1);assert.equal(env.data.csv.rows.length,1);
});

test("自选按物品组持久化，与移出持仓独立；失败不写入，原始档案不变", async () => {
  const env = setup(), before = structuredClone(env.data), result = await env.service.load(), id = result.groups[0].id;
  await env.service.watch({ id, watched: true });
  assert.equal((await env.service.load()).groups.find(g => g.id === id).instrument.watched, true);
  await env.service.exclude({ id, excluded: true });
  assert.deepEqual(env.saved().orderLedger["database-a"].watchlistIds, [id]);
  env.failWrite(); await assert.rejects(env.service.watch({ id, watched: false }), /失败/);
  assert.equal((await env.service.load()).groups.find(g => g.id === id).instrument.watched, true);
  await env.service.watch({ id, watched: false }); assert.deepEqual(env.saved().orderLedger["database-a"].watchlistIds, []);
  assert.deepEqual(env.data, before); await assert.rejects(env.service.watch({ id, watched: "true" }), /无效/); await assert.rejects(env.service.watch({ id: "missing", watched: true }), /不存在/);
});

test("只读三方历史与 CSV、名称库，保留报价设置，最后同步时间取持久记录而非读取时间", async () => {
  const env = setup(), result = await env.service.load();
  assert.deepEqual(new Set(env.calls), new Set(["/history/buff", "/history/uu", "/history/steam", "/history/csv", "/history/names"]));
  assert.equal(env.writes.length, 0); assert.equal(result.pricingSettings.targetCashoutRatio, 0.75);
  assert.equal(result.sourceStatus.buff.lastSyncedAt, "2020-01-02T00:00:00.000Z");
  assert.equal(result.sourceStatus.uu.lastSyncedAt, "2020-01-03T00:00:00.000Z");
  assert.equal(result.sourceStatus.csv.lastImportedAt, "2020-01-11T00:00:00.000Z");
  assert.equal(result.sourceStatus.csv.recordCount, 1);
  assert.equal(result.groups.find(row => row.marketHashName === "Test Item").knife.quantity, 1); assert.equal(result.summary.knifeSteamReceivedCents, null);
  assert.equal(result.orders.find(row => row.source === "csv").actualTotalCents, null);
  assert.equal(result.options.accountLinkMode, "auto");
  assert.deepEqual(result.options.accountLinks, [{ id: "self", name: "本人账户", accountKeys: [buffKey, steamKey, uuKey] }]);
  assert.ok(result.accounts.every(account => account.portfolioId === "self"));
  const before = JSON.stringify(env.data); await env.service.load(); assert.equal(JSON.stringify(env.data), before);
  env.data.buff.data.accounts["buff:owner"].runs.push({ channel: "pending", syncedAt: "2021-01-01T00:00:00.000Z" });
  assert.equal((await env.service.load()).sourceStatus.buff.lastSyncedAt, "2020-01-02T00:00:00.000Z");
  env.data.buff.data.accounts["buff:owner"].runs = [{ channel: "pending", syncedAt: "2021-01-01T00:00:00.000Z" }];
  assert.equal((await env.service.load()).sourceStatus.buff.lastSyncedAt, null);
  env.data.csv.imports = []; assert.equal((await env.service.load()).sourceStatus.csv.lastImportedAt, null);
});

test("手动关联覆盖默认同人；CSV实付口径确认独立于账户归属", async () => {
  const env = setup(), result = await env.service.configure(configuration);
  const group = result.groups.find(row => row.marketHashName === "Test Item");
  assert.equal(group.knife.quantity, 1); assert.equal(group.knife.totalCents, 200); assert.equal(group.knife.allocatedCostCents, 100);
  assert.equal(group.remainingQuantity, 1);
  assert.deepEqual(result.options.accountLinks, configuration.accountLinks);
  assert.equal(result.options.accountLinkMode, "manual");
  assert.deepEqual(env.saved().orderLedger.untouched.overrides, { keep: { actualTotalCents: 99 } });
  assert.equal((await env.service.load({ portfolioId: "mine" })).orders.length, 3);
  await assert.rejects(env.service.load({ portfolioId: "unknown" }), /不存在/);
});

test("标准 Steam 金额识别数量仅返回账户 metadata，历史范围保留未齐与分页依据", async () => {
  const env = setup();
  Object.assign(env.data.csv.rows[0], { sourceFormat: "steam-market-history", amountSemantics: "actual" });
  env.data.csv.rows.push({ ...env.data.csv.rows[0], key: "generic", orderId: "generic", sourceFormat: undefined, amountSemantics: undefined });
  Object.assign(env.data.buff.data.accounts["buff:owner"].runs[0], { complete: false, pages: 20, stopReason: "limit" });
  const result = await env.service.load();
  assert.equal(result.accounts.find(account => account.key === steamKey).autoAmountCount, 1);
  assert.equal(result.sourceStatus.buff.accounts[0].runs[0].complete, false);
  assert.equal(result.sourceStatus.buff.accounts[0].runs[0].pages, 20);
  assert.equal(result.sourceStatus.buff.accounts[0].runs[0].stopReason, "limit");
  await env.service.configure({ csvAmountSemantics: { [steamKey]: "unknown" } });
  assert.equal((await env.service.load()).accounts.find(account => account.key === steamKey).autoAmountCount, 1);
  await env.service.configure({ csvAmountSemantics: {} });
  assert.doesNotMatch(JSON.stringify(env.saved().orderLedger["database-a"]), /autoAmountCount|sourceFormat|amountSemantics/);
  assert.equal((await env.service.load()).orders.find(row => row.orderId === "generic").actualTotalCents, null);
});

test("日期范围带入期初均价成本，结束日以后买入不稀释期间成本，非法日期拒绝", async () => {
  const env = setup();
  const first = env.data.buff.data.accounts["buff:owner"].records[0];
  env.data.buff.data.accounts["buff:owner"].records.push({ ...first, key: "later", quantity: 1, paidTotalCents: 400, tradedAt: "2020-02-01T00:00:00Z" });
  Object.assign(env.data.csv.rows[0], { sourceFormat: "steam-market-history", amountSemantics: "actual" });
  const result = await env.service.load({ dateFrom: "2020-01-10", dateTo: "2020-01-10" });
  const group = result.groups.find(row => row.marketHashName === "Test Item");
  assert.equal(group.opening.quantity, 2); assert.equal(group.opening.costCents, 200);
  assert.equal(group.buy.quantity, 0); assert.equal(group.knife.allocatedCostCents, 100);
  assert.equal(group.inventoryCostCents, 100); assert.equal(result.summary.walletCashBasisCents, 100); assert.equal(result.summary.walletUnrealizedProfitCents, 50); assert.equal(result.summary.realizedProfitCents, 0);
  assert.equal(result.profitCurve[0].date, "2020-01-10");
  await assert.rejects(env.service.load({ dateFrom: "2020-02-30" }), /日期/);
  await assert.rejects(env.service.load({ dateFrom: "2020-01-11", dateTo: "2020-01-10" }), /日期|开始/);
  assert.equal(env.writes.length, 0);
});

test("规则只写当前scope，排除可恢复且不改原始档案或历史结转成本", async () => {
  const env = setup(), before = JSON.stringify(env.data);
  const configured = await env.service.configure(configuration);
  const groupId = configured.groups.find(row => row.marketHashName === "Test Item").id;
  const hidden = await env.service.exclude({ id: groupId, excluded: true });
  assert.equal(hidden.holdings.some(row => row.id === groupId), false);
  assert.equal(hidden.excludedHoldings.find(row => row.id === groupId).remainingQuantity, 1);
  assert.equal(hidden.summary.knifeQuantity, 1); assert.equal(JSON.stringify(env.data), before);
  const restored = await env.service.exclude({ id: groupId, excluded: false });
  assert.equal(restored.holdings.find(row => row.id === groupId).remainingQuantity, 1);
  await env.service.override({ id: saleId, actualTotalCents: 0 });
  assert.equal((await env.service.load()).orders.find(row => row.id === saleId).actualTotalCents, 0);
  await env.service.override({ id: saleId, actualTotalCents: null });
  assert.equal((await env.service.load()).orders.find(row => row.id === saleId).actualTotalCents, 200);
  assert.equal(Object.hasOwn(env.saved().orderLedger["database-a"].overrides, saleId), false);
  const unknownId = sourceId("uu", "uu-buy");
  await env.service.override({ id: unknownId, actualTotalCents: 123 });
  await env.service.override({ id: unknownId, actualTotalCents: null });
  assert.equal((await env.service.load()).orders.find(row => row.id === unknownId).actualTotalCents, null);
  assert(env.writes.every(value => Object.keys(value).length === 1 && Object.hasOwn(value, "orderLedger")));
  assert(env.calls.every(path => path.startsWith("/history/")));
});

test("并发配置、金额核对、移除与另一scope写入都不会丢失更新", async () => {
  const env = setup(), other = new OrderLedgerService({ state: env.state, request: env.request, scope: "database-b" });
  const configured = await env.service.configure(configuration), groupId = configured.groups.find(row => row.marketHashName === "Test Item").id;
  await Promise.all([
    env.service.configure(configuration), env.service.override({ id: buyId, actualTotalCents: 222 }),
    env.service.exclude({ id: groupId, excluded: true }), other.override({ id: buyId, actualTotalCents: 333 }),
  ]);
  const saved = env.saved();
  assert.deepEqual(saved.orderLedger["database-a"].accountLinks, configuration.accountLinks);
  assert.equal(saved.orderLedger["database-a"].overrides[buyId].actualTotalCents, 222);
  assert.deepEqual(saved.orderLedger["database-a"].excludedHoldingIds, [groupId]);
  assert.equal(saved.orderLedger["database-b"].overrides[buyId].actualTotalCents, 333);
  assert.equal(saved.priceWorkspace.settings.targetCashoutRatio, 0.75);
  assert.equal((await other.load()).groups.find(row => row.marketHashName === "Test Item").buy.costCents, 333);
});

test("未知账户/持仓/来源及任意写字段都被拒绝，失败写入不污染后续操作", async () => {
  const env = setup();
  for (const payload of [
    { accountLinks: [{ id: "mine", accountKeys: ["unknown"] }] },
    { accountLinks: [{ id: "mine", accountKeys: [buffKey, buffKey] }] },
    { accountLinks: [{ id: "all", accountKeys: [buffKey] }] },
    { accountLinks: [{ id: "mine", accountKeys: [buffKey] }, { id: "second", accountKeys: [buffKey] }] },
    { csvAmountSemantics: { [buffKey]: "actual" } }, { csvAmountSemantics: { [steamKey]: "gross" } },
    { accountLinkMode: "invalid" }, { accountLinkMode: "auto", accountLinks: [] }, { accountLinkMode: "manual" },
    { overrides: { unknown: { actualTotalCents: 1 } } }, { path: "/trades" },
  ]) await assert.rejects(env.service.configure(payload));
  await assert.rejects(env.service.exclude({ id: saleId, excluded: true }), /物品分组不存在/);
  await assert.rejects(env.service.exclude({ id: buyId, excluded: "true" }), /状态无效/);
  await assert.rejects(env.service.override({ id: "unknown", actualTotalCents: 1 }), /原始订单不存在/);
  for (const actualTotalCents of [-1, 1.2, undefined, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(env.service.override({ id: buyId, actualTotalCents }), /非负整数分或空值/);
  assert.equal(env.writes.length, 0);
  env.failWrite(); await assert.rejects(env.service.override({ id: buyId, actualTotalCents: 321 }), /模拟写入失败/);
  assert.equal((await env.service.load()).orders.find(row => row.id === buyId).actualTotalCents, 200);
  await env.service.override({ id: buyId, actualTotalCents: 432 });
  assert.equal((await env.service.load()).orders.find(row => row.id === buyId).actualTotalCents, 432);
});

test("同人多账号与同平台原生/CSV均可自动或手动同组，保留来源身份不盲目去重", async () => {
  const env = setup();
  const native = env.data.buff.data.accounts["buff:owner"].records[0];
  native.orderId = "same-order";
  env.data.csv.rows.push({ ...env.data.csv.rows[0], key: "buff-csv", scope: "buff-export", platform: "buff", type: "purchase", date: "2020-01-01", sourceTime: "2020-01-01", orderId: "same-order" });
  env.data.buff.data.accounts["buff:second"] = { records: [{ ...native, key: "buff-second", accountId: "buff:second", orderId: "same-order" }], runs: [] };
  const duplicate = accountKey("csv", "buff", "buff-export");
  const initial = await env.service.load();
  assert.equal(initial.options.accountLinkMode, "auto"); assert.ok(initial.accounts.every(account => account.portfolioId === "self"));
  assert.equal(initial.orders.filter(order => order.platform === "buff").length, 3);
  assert.equal(new Set(initial.orders.filter(order => order.platform === "buff").map(order => order.sourceId)).size, 3);
  const grouped = await env.service.configure({ accountLinks: [{ id: "mine", accountKeys: [buffKey, duplicate, accountKey("buff", "buff", "buff:second")] }] });
  assert.equal(grouped.accounts.filter(account => account.portfolioId === "mine").length, 3);
  const result = await env.service.configure({ accountLinks: [{ id: "single", accountKeys: [buffKey] }] });
  assert.equal(result.accounts.find(row => row.key === buffKey).portfolioId, "single");
  assert.equal(result.accounts.find(row => row.key === duplicate).portfolioId, `account:${duplicate}`);
});

test("金额核对与移除不固化自动同人组合；以后新来源仍自动加入", async () => {
  const env = setup();
  await env.service.configure({ csvAmountSemantics: { [steamKey]: "actual" } });
  await env.service.override({ id: buyId, actualTotalCents: 222 });
  const groupId = (await env.service.load()).groups.find(row => row.marketHashName === "Test Item").id;
  await env.service.exclude({ id: groupId, excluded: true });
  let saved = env.saved().orderLedger["database-a"];
  assert.equal(saved.accountLinkMode, "auto"); assert.equal(Object.hasOwn(saved, "accountLinks"), false);
  env.data.csv.rows.push({ ...env.data.csv.rows[0], key: "steam-second", scope: "another-steam", marketHashName: "Another Item" });
  const result = await env.service.load();
  assert.equal(result.options.accountLinkMode, "auto"); assert.equal(result.options.accountLinks[0].accountKeys.length, 4);
  assert.equal(result.accounts.find(account => account.accountId === "another-steam").portfolioId, "self");
  assert.equal(result.orders.find(order => order.accountId === "another-steam").actualTotalCents, null);
  saved = env.saved().orderLedger["database-a"];
  assert.equal(saved.overrides[buyId].actualTotalCents, 222); assert.deepEqual(saved.excludedHoldingIds, [groupId]);
});

test("显式空分组保持独立，手动分组可覆盖同人默认并可恢复动态默认", async () => {
  const env = setup();
  let result = await env.service.configure({ accountLinks: [] });
  assert.equal(result.options.accountLinkMode, "manual"); assert.equal(result.quality.uncoveredSaleQuantity, 1);
  assert.ok(result.accounts.every(account => account.portfolioId === `account:${account.key}`));
  assert.deepEqual(env.saved().orderLedger["database-a"].accountLinks, []);
  const reloaded = new OrderLedgerService({ state: env.state, request: env.request, scope: "database-a" });
  assert.equal((await reloaded.load()).quality.uncoveredSaleQuantity, 1);
  env.data.csv.rows.push({ ...env.data.csv.rows[0], key: "steam-second", scope: "another-steam" });
  result = await reloaded.load(); assert.equal(result.accounts.find(account => account.accountId === "another-steam").portfolioId, `account:${accountKey("csv", "steam", "another-steam")}`);
  result = await reloaded.configure({ accountLinkMode: "auto" });
  assert.equal(result.options.accountLinkMode, "auto"); assert.ok(result.accounts.every(account => account.portfolioId === "self"));
  assert.equal(result.summary.knifeQuantity, 2); assert.equal(result.summary.knifeSteamReceivedCents, null); assert.equal(result.quality.uncoveredSaleQuantity, 0);
  assert.equal(Object.hasOwn(env.saved().orderLedger["database-a"], "accountLinks"), false);
});

test("走势从同一订单规则产生，要求明确账户，不把金额覆盖用于修改历史", async () => {
  const env = setup(); await env.service.configure(configuration);
  const payload = { portfolioId: "mine", appid: 730, marketHashName: "Test Item", direction: "sell", currencyCode: "CNY", asOf: Date.parse("2020-01-10T20:00:00+08:00") };
  let result = await env.service.trends(payload);
  assert.equal(result.points.at(-1).steam, 200);
  await env.service.configure({ csvAmountSemantics: { [steamKey]: "unknown" } });
  result = await env.service.trends(payload); assert.equal(result.points.at(-1).steam, null);
  assert.equal(env.data.csv.rows[0].totalCents, 200);
  await assert.rejects(env.service.trends({ ...payload, portfolioId: "all" }), /一个账户组合/);
  await assert.rejects(env.service.trends({ ...payload, accountKeys: ["unknown"] }), /账户不存在/);
  await assert.rejects(env.service.trends({ ...payload, path: "/prices" }), /未开放/);
});
