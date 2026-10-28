"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), { JSDOM } = require("jsdom");
const P = require("../desktop/pricing.js"), { OrderLedgerService } = require("../desktop/order-ledger-service.cjs");
const { accountKey } = require("../desktop/order-ledger.cjs");
const root = path.resolve(__dirname, "..");
const native = (patch = {}) => ({ key: "buff-order-1", orderId: "order-1", accountId: "buff:7", appid: 730, platform: "buff", direction: "buy", channel: "history", name: '<img src=x onerror=alert(1)> 测试物品', marketHashName: "Test Case", goodsId: "123", quantity: 1, currencyCode: "CNY", completed: true, paidTotalCents: 346, grossTotalCents: 346, tradedAt: "2026-09-01T00:00:00Z", ...patch });
const csv = (patch = {}) => ({ key: "csv-order-1", orderId: "steam-1", scope: "Steam 测试账号", appid: 730, platform: "steam", type: "sale", itemName: "测试物品", marketHashName: "Test Case", quantity: 1, currencyCode: "CNY", sourceFormat: "steam-market-history", amountSemantics: "actual", totalCents: 544, date: "2026-09-10", ...patch });
const quote = (patch = {}, at = Date.now() - 10) => P.normalizeRow({ appid: 730, marketHashName: "Test Case", goodsId: "123", source: "manual", buffPriceCents: 408, buffBuyPriceCents: 380, steamLowestSellCents: 625, buffUpdatedAt: at, buffBuyUpdatedAt: at, steamUpdatedAt: at, ...patch });
const tick = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
async function ui(t, { rows = [native()], csvRows = [], quotePatch = {}, startup = { enabled: false, status: "disabled", platforms: {} } } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "desktop/index.html"), "utf8"), { runScripts: "outside-only", url: "https://desktop.test/" });
  t.after(() => dom.window.close());
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const storage = { priceWorkspace: { rows: [quote(quotePatch)], settings: { ...P.DEFAULTS, targetCashoutRatio: 0.7 } } };
  const archives = { buff: { data: { version: 1, accounts: { "buff:7": { records: structuredClone(rows), runs: [] } } } }, uu: { data: { version: 1, accounts: {} } }, steam: { data: { version: 1, accounts: {} } }, csv: { rows: structuredClone(csvRows), imports: [] }, names: { items: {} } };
  let saveFailure = false;
  const state = { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in storage).map(key => [key, structuredClone(storage[key])])), set: async value => { if (saveFailure) throw new Error("保存失败"); Object.assign(storage, structuredClone(value)); } };
  const service = new OrderLedgerService({ state, scope: "ui-test", request: async route => structuredClone(archives[route.split("/").at(-1)]) }), requests = [];
  dom.window.buffDesktop = { request: async (action, value) => {
    requests.push({ action, value: value && JSON.parse(JSON.stringify(value)) });
    if (action === "storage:get") return state.get(value);
    if (action === "storage:set") return state.set(value);
    if (action === "startup:status") return startup;
    if (action.startsWith("order-ledger:")) return service[action.split(":")[1]](value);
    assert.fail(`未预期请求：${action}`);
  }, onChange() { return () => {}; } };
  for (const file of ["common.js", "desktop/pricing.js", "desktop/price-state.js", "desktop/report-analytics.js", "desktop/report-charts.js", "desktop/order-ledger-ui.js"]) dom.window.eval(fs.readFileSync(path.join(root, file), "utf8"));
  await dom.window.BuffPriceWorkspace.ready; await dom.window.BuffOrderLedgerWorkspace.refresh(); await tick();
  return { dom, storage, archives, requests, service, failSave(value = true) { saveFailure = value; }, setRows(value) { archives.buff.data.accounts["buff:7"].records = structuredClone(value); } };
}
const submit = async (d, id) => { d.getElementById(id).dispatchEvent(new d.defaultView.Event("submit", { bubbles: true, cancelable: true })); await tick(); };

test("物品自选、类目汇总、游戏与盈亏筛选联动，关闭的物品也能查看按日盈亏", async t => {
  const env = await ui(t, { rows: [native({ category: "武器箱", paidTotalCents: 100 }), native({ key: "sold", category: "武器箱", direction: "sell", netTotalCents: 140, tradedAt: "2026-09-03T00:00:00Z" }), native({ key: "holding", name: "另一物品", marketHashName: "Other Item", category: "手套", paidTotalCents: 300 })] }), d = env.dom.window.document;
  d.querySelector('[data-ledger-view="all"]').click(); assert.equal(d.querySelectorAll("#orderLedgerRows tr[data-order-id]").length, 2);
  d.getElementById("ledgerProfitFilter").value = "profit"; d.getElementById("ledgerProfitFilter").dispatchEvent(new env.dom.window.Event("change"));
  assert.equal(d.querySelectorAll("#orderLedgerRows tr[data-order-id]").length, 1); assert.match(d.getElementById("orderLedgerRows").textContent, /¥0.40/);
  d.querySelector('[data-ledger-action="detail"]').click(); assert.equal(d.getElementById("ledgerQuoteForm").hidden, true); assert.match(d.querySelector(".ledger-activity").textContent, /2026-09-03.*¥0.40/); d.getElementById("ledgerDetailDialog").close();
  const before = structuredClone(env.archives); d.querySelector('[data-ledger-action="watch"]').click(); await tick();
  d.querySelector('[data-ledger-view="watchlist"]').click(); assert.equal(d.querySelectorAll("#orderLedgerRows tr[data-order-id]").length, 1); assert.deepEqual(env.archives, before);
  d.getElementById("ledgerProfitFilter").value = "all"; d.getElementById("ledgerProfitFilter").dispatchEvent(new env.dom.window.Event("change"));
  d.querySelector('[data-ledger-view="categories"]').click(); assert.equal(d.querySelectorAll("#orderLedgerRows tr[data-order-id]").length, 2);
  d.getElementById("ledgerCategory").value = "手套"; d.getElementById("ledgerCategory").dispatchEvent(new env.dom.window.Event("change")); assert.equal(d.querySelectorAll("#orderLedgerRows tr[data-order-id]").length, 1);
  assert.match(d.getElementById("ledgerFilterSummary").textContent, /持仓 1 件/);
  d.querySelector('[data-ledger-action="category"]').click(); await tick(); assert.match(d.getElementById("orderLedgerRows").textContent, /另一物品/); assert.equal(d.getElementById("ledgerGame").value, "730");
});

test("来源缺口独立列示，提现统一采用报告挂刀折扣，不再切换旧估算利润", async t => {
  const env = await ui(t, { rows: [native({ paidTotalCents: 80 }), native({ key: "cashout", name: "提现标的", marketHashName: "Cashout Item", direction: "sell", netTotalCents: 140, tradedAt: "2026-09-04T00:00:00Z" })], csvRows: [csv({ date: "2026-09-02", totalCents: 100 }), csv({ key: "unknown", marketHashName: "Unknown Item", date: "2026-09-02", totalCents: 100 }), csv({ key: "steam-buy", marketHashName: "Cashout Item", type: "purchase", date: "2026-09-03", totalCents: 150 })] }), d = env.dom.window.document;
  assert.equal(d.getElementById("ledgerUseEstimate"), null);
  d.querySelector('[data-ledger-view="gaps"]').click(); assert.equal(d.querySelectorAll("#orderLedgerRows tr[data-order-id]").length, 1); assert.match(d.getElementById("orderLedgerRows").textContent, /无同名买入.*历史取得记录缺口/);
  d.getElementById("ledgerGapFilter").value = "mapping_candidate"; d.getElementById("ledgerGapFilter").dispatchEvent(new env.dom.window.Event("change")); assert.equal(d.querySelectorAll("#orderLedgerRows tr[data-order-id]").length, 0);
  d.getElementById("ledgerGapFilter").value = "all"; d.getElementById("ledgerGapFilter").dispatchEvent(new env.dom.window.Event("change")); d.querySelector('[data-ledger-view="all"]').click();
  d.getElementById("ledgerSearch").value = "Cashout Item"; d.getElementById("ledgerSearch").dispatchEvent(new env.dom.window.Event("input")); assert.match(d.getElementById("orderLedgerRows").textContent, /\+¥0.20/);
  const ledger = env.dom.window.BuffOrderLedgerWorkspace.data(); assert.equal(ledger.summary.cashoutCycleProfitCents, 20); assert.equal(ledger.report.currencies[0].profitCents, 20);
});

test("名称组持仓详情显示三门槛且隐藏订单ID和CD，恶意物品名只作文本；新导航无已购卖出或价格分析", async t => {
  const { dom } = await ui(t), d = dom.window.document;
  assert.equal(d.querySelectorAll("#orderLedgerRows tr[data-order-id]").length, 1);
  assert.equal(d.querySelectorAll("#orderLedgerRows img").length, 0);
  assert.doesNotMatch(d.getElementById("orderLedgerRows").textContent, /CD|order-1/); assert.equal(d.getElementById("ledgerAmountDialog"), null);
  assert.equal(d.querySelector("[data-page=selling]"), null); assert.equal(d.querySelector("[data-page=pricing]"), null);
  d.querySelector('[data-ledger-action="detail"]').click(); await tick();
  assert(d.getElementById("ledgerDetailDialog").open); assert.equal(d.querySelectorAll("#ledgerDetailDialog img").length, 0);
  for (const value of ["6.361 折", "7.317 折", "6.820 折"]) assert(d.getElementById("ledgerDetailContent").textContent.includes(value));
  assert.match(d.querySelector(".ledger-route.best").textContent, /BUFF 挂售.*0\.51/);
});

test("估值折扣持久化并重算，失败回滚保持已保存结论，空输入不能覆盖设置", async t => {
  const env = await ui(t), d = env.dom.window.document;
  d.getElementById("ledgerSettings").click(); d.getElementById("ledgerDiscount").value = "7.5"; await submit(d, "ledgerSettingsForm");
  assert.equal(env.storage.priceWorkspace.settings.targetCashoutRatio, 0.75);
  assert.equal(env.dom.window.BuffOrderLedgerWorkspace.data().holdings[0].theoretical.bestProfitCents, 62); assert.match(d.getElementById("orderLedgerRows").textContent, /总收益 = 直接 \+ 提现/);
  env.failSave(); d.getElementById("ledgerSettings").click(); d.getElementById("ledgerDiscount").value = "6"; await submit(d, "ledgerSettingsForm");
  assert.match(d.getElementById("ledgerSettingsError").textContent, /保存失败/); assert.equal(env.storage.priceWorkspace.settings.targetCashoutRatio, 0.75);
  assert.equal(env.dom.window.BuffPriceWorkspace.settings().targetCashoutRatio, 0.75);
  assert.equal(env.dom.window.BuffOrderLedgerWorkspace.data().holdings[0].theoretical.bestProfitCents, 62); assert.match(d.getElementById("orderLedgerRows").textContent, /总收益 = 直接 \+ 提现/);
  env.failSave(false); d.getElementById("ledgerDiscount").value = ""; await submit(d, "ledgerSettingsForm");
  assert.equal(env.storage.priceWorkspace.settings.targetCashoutRatio, 0.75);
  assert(d.getElementById("ledgerSettingsError").textContent);
});

test("保存持仓报价保留独立原始时间与显式有效期，不改报价不续期，失败不修改本地状态", async t => {
  const at = Date.now(), env = await ui(t, { quotePatch: { steamExpiresAt: at + 30000, buffBuyExpiresAt: at + 20000, steamHighestBuyCents: 600 } }), d = env.dom.window.document;
  const before = structuredClone(env.storage.priceWorkspace.rows[0]);
  d.querySelector('[data-ledger-action="detail"]').click(); await submit(d, "ledgerQuoteForm");
  assert.deepEqual(env.storage.priceWorkspace.rows[0], before);
  d.getElementById("ledgerQuoteSteam").value = "6.26"; await submit(d, "ledgerQuoteForm");
  const after = env.storage.priceWorkspace.rows[0]; assert.equal(after.steamLowestSellCents, 626);
  for (const key of ["steamUpdatedAt", "steamExpiresAt", "buffBuyExpiresAt", "buffUpdatedAt", "buffBuyUpdatedAt", "steamHighestBuyCents"]) assert.equal(after[key], before[key], key);
  env.failSave(); d.getElementById("ledgerQuoteSteam").value = "6.27"; await submit(d, "ledgerQuoteForm");
  assert.match(d.getElementById("ledgerQuoteError").textContent, /保存失败/);
  assert.equal(env.storage.priceWorkspace.rows[0].steamLowestSellCents, 626); assert.equal(env.dom.window.BuffPriceWorkspace.rows()[0].steamLowestSellCents, 626);
});

test("过期和异常报价不生成利润，缺价范围、亏损和无持仓状态明确显示", async t => {
  const env = await ui(t, { quotePatch: { buffBuyError: "查询失败" } }), d = env.dom.window.document;
  d.querySelector('[data-ledger-action="detail"]').click(); await tick();
  assert.match(d.getElementById("ledgerDetailContent").textContent, /报价错误/);
  assert.match(d.getElementById("ledgerDetailContent").textContent, /已知路线中收益最高/);
  env.setRows([native({ paidTotalCents: 600 })]); await env.dom.window.BuffOrderLedgerWorkspace.refresh();
  env.dom.window.BuffOrderLedgerWorkspace.showDetail(env.dom.window.BuffOrderLedgerWorkspace.data().groups[0].id, false); assert.match(d.getElementById("ledgerDetailContent").textContent, /-¥2\.03/); assert.equal(env.dom.window.BuffOrderLedgerWorkspace.data().summary.realizedProfitCents, 0);
  env.setRows([]); await env.dom.window.BuffOrderLedgerWorkspace.refresh();
  assert.match(d.getElementById("orderLedgerRows").textContent, /暂无物品/);
  assert(env.requests.every(request => request.action !== "ledger"));
});

test("移出与恢复只修改持仓偏好，原始历史完整保留；保存失败不假装移除", async t => {
  const env = await ui(t), d = env.dom.window.document, before = structuredClone(env.archives);
  env.failSave(); d.querySelector('[data-ledger-action="exclude"]').click(); await tick();
  assert.match(d.getElementById("orderLedgerError").textContent, /保存失败/); assert.equal(env.dom.window.BuffOrderLedgerWorkspace.data().holdings.length, 1);
  env.failSave(false); d.querySelector('[data-ledger-action="exclude"]').click(); await tick();
  assert.equal(env.dom.window.BuffOrderLedgerWorkspace.data().holdings.length, 0); assert.deepEqual(env.archives, before);
  d.querySelector('[data-ledger-view="excluded"]').click(); assert.equal(d.querySelectorAll('[data-ledger-action="restore"]').length, 1);
  d.querySelector('[data-ledger-action="restore"]').click(); await tick();
  assert.equal(env.dom.window.BuffOrderLedgerWorkspace.data().holdings.length, 1); assert.deepEqual(env.archives, before);
});

test("默认同人按完整名均价分池，现金来源挂刀与直接转卖分开，无CD与金额确认", async t => {
  const env = await ui(t, { rows: [native({ quantity: 1, paidTotalCents: 200 }), native({ key: "second-buy", quantity: 2, paidTotalCents: 700 }), native({ key: "cash-sale", direction: "sell", quantity: 1, paidTotalCents: null, netTotalCents: 500, tradedAt: "2026-09-03T00:00:00Z" })], csvRows: [csv({ totalCents: 1000, date: "2026-09-02" })] });
  const d = env.dom.window.document, page = env.dom.window.BuffOrderLedgerWorkspace, group = page.data().groups[0];
  assert.equal(page.data().groups.length, 1); assert.equal(page.data().options.accountLinkMode, "auto");
  assert.equal(group.buy.averageCostCents, 300); assert.equal(group.knife.quantity, 1); assert.equal(group.knife.totalCents, 1000);
  assert.equal(group.cashout.quantity, 0); assert.equal(group.direct.quantity, 1); assert.equal(group.direct.profitCents, 200);
  assert.equal(page.data().summary.realizedProfitCents, 200); assert.equal(page.data().summary.walletBalanceCents, 1000); assert.equal(page.data().summary.walletCashBasisCents, 300);
  assert.equal(group.remainingQuantity, 1); assert.equal(group.inventoryCostCents, 300);
  assert.equal(d.getElementById("ledgerAccountsDialog").open, false); assert.equal(d.querySelector('[data-ledger-action="amount"]'), null);
  d.querySelector('[data-ledger-view="knife"]').click(); assert.match(d.getElementById("orderLedgerRows").textContent, /Steam 净到账 ¥10.00/);
  assert.match(d.getElementById("orderLedgerMetrics").textContent, /历史加权挂刀折扣3.000 折/);
  d.querySelector('[data-ledger-view="direct"]').click(); assert.equal(d.querySelectorAll("#orderLedgerRows tr[data-order-id]").length, 1);
  assert(!env.requests.some(row => row.action === "order-ledger:configure"));
});

test("账户分组默认自动加入新来源，手动分开与恢复自动可用，失败不修改旧分组", async t => {
  const env = await ui(t, { csvRows: [csv()] }), d = env.dom.window.document, page = env.dom.window.BuffOrderLedgerWorkspace;
  assert.equal(page.data().groups.length, 1); d.getElementById("ledgerAccounts").click();
  assert.equal(d.querySelector("[data-csv-actual]"), null);
  const toggle = d.getElementById("ledgerSamePerson"); toggle.checked = false; toggle.dispatchEvent(new env.dom.window.Event("change"));
  for (const input of d.querySelectorAll("[data-account-group]")) input.value = JSON.parse(input.dataset.accountGroup)[1] === "buff" ? "本人 BUFF" : "其他人的 Steam";
  env.failSave(); await submit(d, "ledgerAccountsForm"); assert.match(d.getElementById("ledgerAccountsError").textContent, /保存失败/); assert.equal(page.data().options.accountLinkMode, "auto");
  env.failSave(false); await submit(d, "ledgerAccountsForm");
  assert.equal(page.data().options.accountLinkMode, "manual"); assert.equal(page.data().groups.length, 2); assert.equal(page.data().quality.uncoveredSaleQuantity, 1);
  d.getElementById("ledgerAccounts").click(); toggle.checked = true; toggle.dispatchEvent(new env.dom.window.Event("change")); await submit(d, "ledgerAccountsForm");
  assert.equal(page.data().options.accountLinkMode, "auto"); assert.equal(page.data().groups.length, 1); assert.equal(page.data().quality.uncoveredSaleQuantity, 0);
  env.archives.uu.data.accounts["uu:new"] = { records: [native({ key: "uu-new", accountId: "uu:new", platform: "uu", marketHashName: "New Source Case" })], runs: [] };
  await page.refresh(); assert.equal(page.data().accounts.length, 3); assert.deepEqual([...new Set(page.data().accounts.map(row => row.portfolioId))], ["self"]);
});

test("终端固定账户的归属弹窗只读展示三平台与CSV，不能提交旧分组修改", async t => {
  const env = await ui(t, { csvRows: [csv()] }), d = env.dom.window.document, workspace = env.dom.window.BuffOrderLedgerWorkspace;
  env.archives.uu.data.accounts["uu:8"] = { records: [native({ key: "uu-source", accountId: "uu:8", platform: "uu" })], runs: [] };
  env.archives.steam.data.accounts["steam:76561198000000001"] = { records: [native({ key: "steam-source", accountId: "steam:76561198000000001", platform: "steam" })], runs: [] };
  const project = env.service.project.bind(env.service);
  env.service.project = (...args) => ({ ...project(...args), profileScoped: true });
  const navigations = []; env.dom.window.BuffDesktopNavigation = { navigate: page => navigations.push(page) };
  await workspace.refresh(); const options = JSON.stringify(workspace.data().options);
  d.getElementById("ledgerAccounts").click();
  assert.equal(d.getElementById("ledgerAccountsDialog").open, true);
  assert.equal(d.querySelectorAll("#ledgerAccountFields .ledger-account-row").length, 4);
  for (const source of ["BUFF", "悠悠", "Steam", "CSV"]) assert(d.getElementById("ledgerAccountFields").textContent.includes(source));
  assert.equal(d.querySelectorAll("#ledgerAccountFields input, #ledgerAccountFields select").length, 0);
  assert.equal(d.getElementById("ledgerSamePersonControl").hidden, true);
  assert.equal(d.getElementById("ledgerSamePerson").disabled, true);
  assert.equal(d.getElementById("ledgerAccountsSave").hidden, true);
  assert.equal(d.getElementById("ledgerAccountsSave").disabled, true);
  assert.match(d.getElementById("ledgerAccountsHelp").textContent, /工作台选择当前终端关联账户/);
  await submit(d, "ledgerAccountsForm");
  assert.match(d.getElementById("ledgerAccountsError").textContent, /仅供查看/);
  assert.equal(JSON.stringify(workspace.data().options), options);
  assert(!env.requests.some(row => row.action === "order-ledger:configure"));
  d.getElementById("ledgerAccountsGoOverview").click();
  assert.equal(d.getElementById("ledgerAccountsDialog").open, false); assert.deepEqual(navigations, ["overview"]);
});

test("真实挂刀提现循环与直接盈亏独立展示，历史提现率优先且备用折扣不改利润", async t => {
  const env = await ui(t, { rows: [
    native({ paidTotalCents: 700 }),
    native({ key: "direct-buy", marketHashName: "Direct Case", paidTotalCents: 300 }),
    native({ key: "cashout-sale", marketHashName: "Cashout Case", direction: "sell", netTotalCents: 500, tradedAt: "2026-09-04T00:00:00Z" }),
    native({ key: "direct-sale", marketHashName: "Direct Case", direction: "sell", netTotalCents: 400, tradedAt: "2026-09-04T00:00:00Z" }),
  ], csvRows: [csv({ totalCents: 1000, date: "2026-09-02" }), csv({ key: "steam-buy", orderId: "steam-buy", marketHashName: "Cashout Case", type: "purchase", totalCents: 600, date: "2026-09-03" })] });
  const d = env.dom.window.document, page = env.dom.window.BuffOrderLedgerWorkspace, summary = page.data().summary;
  assert.equal(summary.cashInvestedCents, 1000); assert.equal(summary.cashoutCycleProfitCents, 80); assert.equal(summary.directRealizedProfitCents, 100); assert.equal(summary.realizedProfitCents, 180);
  assert.equal(summary.walletBalanceCents, 400); assert.equal(summary.walletCashBasisCents, 280); assert.equal(summary.walletEstimatedValueCents, 333);
  assert.equal(summary.walletRatio, 0.7); assert.match(d.getElementById("orderLedgerMetrics").textContent, /历史加权挂刀折扣7.000 折/);
  assert.equal(summary.estimatedCashoutRatio, 5 / 6); assert.equal(summary.valuationSource, "historical-cashout");
  assert.match(d.getElementById("orderLedgerMetrics").textContent, /总已实现收益\+¥1.80/); assert.match(d.getElementById("orderLedgerMetrics").textContent, /提现折扣差收益\+¥0.80/);
  d.querySelector('[data-ledger-view="cashout"]').click(); assert.match(d.getElementById("orderLedgerRows").textContent, /1 件 · \+¥0.80.*对应 Steam 买入 ¥6.00/);
  d.querySelector('[data-ledger-view="direct"]').click(); assert.match(d.getElementById("orderLedgerRows").textContent, /\+¥1.00.*1 件 · 净回款 ¥4.00/);
  assert.match(d.querySelector('#ledgerCharts [data-chart="profit"] .chart-legend').textContent, /总收益直接盈亏提现收益/);
  d.getElementById("ledgerSettings").click(); d.getElementById("ledgerDiscount").value = "6"; await submit(d, "ledgerSettingsForm");
  assert.equal(page.data().summary.realizedProfitCents, 180); assert.equal(page.data().summary.walletEstimatedValueCents, 333); assert.equal(page.data().summary.estimatedCashoutRatio, 5 / 6);
});

test("未知钱包来源的收益显示横线，有可核实零利润时保留零值，曲线和工作台一致", async t => {
  const env = await ui(t, { rows: [native({ direction: "sell", netTotalCents: 500, tradedAt: "2026-09-04T00:00:00Z" })], csvRows: [csv({ type: "purchase", totalCents: 600, date: "2026-09-03" })] });
  const d = env.dom.window.document, page = env.dom.window.BuffOrderLedgerWorkspace;
  const metric = (container, label) => [...d.querySelectorAll(`#${container} .metric`)].find(card => card.querySelector(".metric-label").textContent === label);
  assert.equal(page.data().summary.cashoutCycleProfitCents, null); assert.equal(page.data().summary.knownCashoutCycleProfitCents, 0); assert.equal(page.data().summary.knownCashoutProfitQuantity, 0);
  for (const label of ["CNY · 总已实现收益", "提现折扣差收益", "历史加权挂刀折扣"]) assert.equal(metric("orderLedgerMetrics", label).querySelector("strong").textContent, "—");
  d.querySelector('[data-ledger-view="cashout"]').click(); assert.match(d.getElementById("orderLedgerRows").textContent, /1 件 · —.*提现.*挂刀 —/);
  const chart = d.querySelector('#ledgerCharts [data-chart="profit"]');
  assert.match(chart.querySelector("h3").textContent, /可计算部分/); assert.match(chart.querySelector(".chart-readout").textContent, /总收益 —/);
  // Execute the actual overview render functions without starting app services.
  const app = fs.readFileSync(path.join(root, "desktop/app.js"), "utf8"), render = new Function("document", "common", `const $ = id => document.getElementById(id), money = value => value == null ? '—' : common.formatCents(value); ${app.slice(app.indexOf("function metric("), app.indexOf("async function refreshOverview()"))}; return renderSummary;`)(d, env.dom.window.BuffHelperCommon);
  render(page.data()); assert.equal(metric("overviewMetrics", "CNY · 总已实现收益").querySelector("strong").textContent, "—");
  env.archives.buff.data.accounts["buff:7"].records.push(native({ key: "known-buy", marketHashName: "Known Zero", paidTotalCents: 300 }), native({ key: "known-sell", marketHashName: "Known Zero", direction: "sell", netTotalCents: 300, tradedAt: "2026-09-04T00:00:00Z" }));
  await page.refresh(); assert.equal(page.data().summary.realizedProfitCents, null); assert.equal(page.data().summary.knownRealizedProfitQuantity, 1);
  assert.equal(metric("orderLedgerMetrics", "CNY · 总已实现收益").querySelector("strong").textContent, "¥0.00");
  assert.match(metric("orderLedgerMetrics", "CNY · 总已实现收益").textContent, /可计算部分/);
  render(page.data()); assert.equal(metric("overviewMetrics", "CNY · 总已实现收益").querySelector("strong").textContent, "¥0.00");
});

test("持仓报价试算仅在详情展示，工作台与账本不把估值计入已实现收益", async t => {
  const env = await ui(t, { rows: [native({ paidTotalCents: 397 })] }), d = env.dom.window.document, page = env.dom.window.BuffOrderLedgerWorkspace;
  const app = fs.readFileSync(path.join(root, "desktop/app.js"), "utf8"), render = new Function("document", "common", `const $ = id => document.getElementById(id); ${app.slice(app.indexOf("function renderSummary("), app.indexOf("let overviewSequence"))}; return renderSummary;`)(d, env.dom.window.BuffHelperCommon);
  assert.equal(page.data().summary.theoreticalProfitCents, 0); render(page.data());
  assert.equal(d.querySelector("#overviewMetrics .metric strong").textContent, "¥0.00");
  assert.equal(d.querySelector("#orderLedgerMetrics .metric strong").textContent, "¥0.00");
  assert.match(d.getElementById("overviewMetrics").textContent, /期末持仓 · 不计收益1 件/);
  d.querySelector('[data-ledger-action="detail"]').click(); assert.match(d.getElementById("ledgerDetailContent").textContent, /持仓报价试算（不计报告收益）/);
});

test("真实未知金额和不足买入仅进质量摘要，完整中文名称保留且无逐笔金额纠错入口", async t => {
  const env = await ui(t, { rows: [native({ paidTotalCents: null, marketHashName: "Unknown Cost" }), native({ key: "chinese", name: "完整中文物品", marketHashName: "" })], csvRows: [csv({ marketHashName: "Missing Buy" })] });
  const d = env.dom.window.document, data = env.dom.window.BuffOrderLedgerWorkspace.data();
  assert.equal(data.quality.unknownAmountCount, 1); assert.equal(data.quality.uncoveredSaleQuantity, 1);
  assert.match(d.getElementById("ledgerDataQuality").textContent, /1 笔金额缺项.*1 件净卖出不计收益/);
  assert.match(d.getElementById("orderLedgerRows").textContent, /完整中文物品/);
  assert.doesNotMatch(d.getElementById("orderLedgerRows").textContent, /完整英文名待核对|核对金额/);
  assert.equal(d.querySelector('[data-ledger-view="anomalies"]'), null); assert.equal(d.querySelector('[data-ledger-action="amount"]'), null);
});

test("日期范围带入期初成本，七日曲线受日期限制，备用折扣仅改变未实现估值", async t => {
  const env = await ui(t, { rows: [native({ quantity: 2, paidTotalCents: 400 }), native({ key: "later", paidTotalCents: 900, tradedAt: "2026-10-01T00:00:00Z" })], csvRows: [csv({ date: "2026-09-10", totalCents: 1000 })] });
  const d = env.dom.window.document, page = env.dom.window.BuffOrderLedgerWorkspace;
  d.getElementById("ledgerStart").value = "2026-09-09"; d.getElementById("ledgerEnd").value = "2026-09-10"; d.getElementById("ledgerEnd").dispatchEvent(new env.dom.window.Event("change")); await tick();
  const group = page.data().groups[0]; assert.equal(group.opening.quantity, 2); assert.equal(group.opening.costCents, 400); assert.equal(group.buy.quantity, 0); assert.equal(group.inventoryCostCents, 200); assert.equal(page.data().summary.walletCashBasisCents, 200); assert.equal(page.data().summary.walletUnrealizedProfitCents, 500); assert.equal(page.data().summary.realizedProfitCents, 0);
  assert.match(d.getElementById("orderLedgerRows").textContent, /期初 2 件 · 来源成本 ¥4.00/);
  const select = d.querySelector('#ledgerCharts select[aria-label="统计粒度"]'); select.value = "day"; select.dispatchEvent(new env.dom.window.Event("change"));
  const detail = d.querySelector('#ledgerCharts [data-chart="profit"] details'); detail.open = true; detail.dispatchEvent(new env.dom.window.Event("toggle")); await tick();
  const dates = [...detail.querySelectorAll("tbody tr")].map(row => row.firstChild.textContent); assert.deepEqual(dates, ["2026-09-09", "2026-09-10"]);
  d.getElementById("trendDirection").value = "sell"; d.getElementById("trendDirection").dispatchEvent(new env.dom.window.Event("change")); await tick();
  assert.equal(env.requests.filter(row => row.action === "order-ledger:trends").at(-1).value.asOf, Date.parse("2026-09-10T23:59:59.999+08:00"));
  assert.deepEqual([...d.querySelectorAll("#orderTrendChart tbody tr")].map(row => row.firstChild.textContent), ["2026-09-09", "2026-09-10"]);
  d.getElementById("ledgerSettings").click(); d.getElementById("ledgerDiscount").value = "8"; await submit(d, "ledgerSettingsForm");
  assert.equal(page.data().summary.walletUnrealizedProfitCents, 600); assert.equal(page.data().summary.realizedProfitCents, 0); assert.match(d.getElementById("ledgerDataQuality").textContent, /估值均不计入总收益/);
  d.getElementById("ledgerAllDates").click(); await tick(); assert.equal(page.data().groups[0].buy.quantity, 3);
});

test("工作台区分历史未齐与完成增量，账本已知成本可见且持仓明确为历史推算", async t => {
  const startup = { enabled: true, status: "partial", platforms: { buff: { account: { id: "buff:7" }, verified: false, count: 1600, message: "请先登录", job: {}, runs: [], lastSyncedAt: "2026-10-21T07:31:04Z" }, uu: { verified: true, count: 0, message: "账户已校验", runs: [], job: {} } } };
  const env = await ui(t, { rows: [native(), native({ key: "unknown-cost", marketHashName: "Other Case", paidTotalCents: null })], startup }), d = env.dom.window.document;
  env.archives.buff.data.accounts["buff:7"].runs = [{ appid: 730, direction: "buy", channel: "history", complete: false, pages: 20, stopReason: "limit" }, { appid: 730, direction: "sell", channel: "history", complete: true, pages: 2, stopReason: "known" }];
  await env.dom.window.BuffOrderLedgerWorkspace.refresh(); await env.dom.window.BuffOrderLedgerWorkspace.refreshStartup();
  assert.match(d.getElementById("accountCards").textContent, /CS2 买入：历史未齐（已读 20 页）/);
  assert.match(d.getElementById("accountCards").textContent, /CS2 卖出：历史已补齐，本次增量到已知边界/);
  assert.match(d.getElementById("accountCards").textContent, /历史完整性未知/);
  const metric = [...d.querySelectorAll("#orderLedgerMetrics .metric")].find(e => e.querySelector(".metric-label").textContent === "期间现金投入");
  assert.equal(metric.querySelector("strong").textContent, "¥3.46"); assert.match(metric.textContent, /仅已知部分/);
  assert.match(d.getElementById("ledgerListDescription").textContent, /期末持仓按历史推算/);
});

test("名称组列表 50 条分页、搜索重置页码与账户过滤保持一致", async t => {
  const rows = Array.from({ length: 53 }, (_, i) => native({ key: `item-${i}`, orderId: `id-${i}`, marketHashName: `Case ${String(i).padStart(2, "0")}`, name: i === 52 ? "唯一筛选目标" : `物品 ${i}` }));
  const env = await ui(t, { rows, csvRows: [csv({ marketHashName: "Different Item" })] }), d = env.dom.window.document;
  assert.equal(d.querySelectorAll("#orderLedgerRows tr[data-order-id]").length, 50); assert.equal(d.getElementById("ledgerPageInfo").textContent, "1 / 2");
  d.getElementById("ledgerNext").click(); assert.equal(d.querySelectorAll("#orderLedgerRows tr[data-order-id]").length, 3);
  d.getElementById("ledgerSearch").value = "唯一筛选"; d.getElementById("ledgerSearch").dispatchEvent(new env.dom.window.Event("input"));
  assert.equal(d.getElementById("ledgerPageInfo").textContent, "1 / 1"); assert.equal(d.querySelectorAll("#orderLedgerRows tr[data-order-id]").length, 1);
  d.getElementById("ledgerSearch").value = ""; d.getElementById("ledgerSearch").dispatchEvent(new env.dom.window.Event("input"));
  await env.service.configure({ accountLinks: [{ id: "CSV 账户", accountKeys: [accountKey("csv", "steam", "Steam 测试账号")] }] }); await env.dom.window.BuffOrderLedgerWorkspace.refresh();
  d.getElementById("ledgerPortfolio").value = "CSV 账户"; d.getElementById("ledgerPortfolio").dispatchEvent(new env.dom.window.Event("change")); await tick();
  assert.equal(env.dom.window.BuffOrderLedgerWorkspace.data().holdings.length, 0);
  d.querySelector('[data-ledger-view="all"]').click(); assert.match(d.getElementById("orderLedgerRows").textContent, /Different Item/);
  const last = env.requests.filter(row => row.action === "order-ledger:load").at(-1); assert.equal(last.value.portfolioId, d.getElementById("ledgerPortfolio").value);
});
