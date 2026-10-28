"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), { JSDOM } = require("jsdom");
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const root = path.resolve(__dirname, "..");
const { analyzeOrders } = require("../desktop/buff-analysis.cjs");
const row = (extra = {}) => ({ key: "buff:123:730:buy:history:order-1", accountId: "buff:123", appid: 730, direction: "buy", channel: "history", orderId: "order-1", goodsId: "1", name: '<img src=x onerror="alert(1)">', marketHashName: "Test Name", quantity: 2, currencyCode: "CNY", status: "SUCCESS", completed: true, grossTotalCents: 246, paidTotalCents: 247, netTotalCents: null, tradedAt: "2026-10-20T17:00:00Z", observedAt: "2026-10-21T01:00:00Z", ...extra });
async function setup(t, rows = [row()]) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "desktop/index.html"), "utf8"), { runScripts: "outside-only", url: "https://desktop.invalid/" });
  const w = dom.window; w.TextEncoder = TextEncoder; t.after(() => w.close());
  const calls = [], navigation = []; let change;
  let state = { account: { id: "buff:123", nickname: "测试账号" }, verified: false, count: rows.length, runs: [], job: { status: "idle", pages: 0, count: 0 } };
  w.BuffDesktopNavigation = { navigate: page => navigation.push(page) };
  w.buffDesktop = { onChange: fn => { change = fn; }, request: async (action, payload) => {
    calls.push({ action, payload });
    if (action === "storage:get") return {};
    if (action === "history:load") return { rows: [] };
    if (action === "history:names") return { items: {} };
    if (action === "buff:list") {
      return { ...state, ...analyzeOrders(rows, payload) };
    }
    if (action === "buff:start") { state = { ...state, job: { status: "running", pages: 0, count: 0, message: "正在同步" } }; return state; }
    if (action === "buff:stop") { state = { ...state, job: { status: "cancelled", pages: 0, count: 0, message: "已停止" } }; change({ kind: "buff-orders", value: state }); return state; }
    if (action === "buff:check") { state.verified = true; return state; }
    if (action === "buff:login") return { opened: true };
    throw new Error("Unexpected " + action);
  } };
  for (const file of ["common.js", "desktop/dota2-names.js", "desktop/market-history.js", "desktop/market-history-ui.js", "desktop/buff-orders-ui.js"]) w.eval(fs.readFileSync(path.join(root, file), "utf8"));
  await w.BuffOrdersWorkspace.ready;
  return { w, $: id => w.document.getElementById(id), calls, navigation, emit: event => change(event) };
}

test("订单文本安全渲染，未知净到账不显示零元，进入页面不会自动访问平台", async t => {
  const { $, calls } = await setup(t);
  assert.match($("buffRows").textContent, /<img/); assert.equal($("buffRows").querySelector("img"), null);
  assert.match($("buffRows").textContent, /2\.47/); assert.match($("buffConnection").textContent, /缓存/);
  assert(calls.every(call => ["buff:list", "storage:get", "history:load", "history:names"].includes(call.action)));
  assert.equal($("buffLegacyReview").open, false); assert.match($("buffLegacyReview").textContent, /新交易账本已自动汇总/); assert.equal($("buffReviewBuys").disabled, false); assert.equal($("buffReviewSales").disabled, true);
});

test("同步有进度与停止入口，运行中阻止重复启动和切换账号", async t => {
  const { $, calls, w } = await setup(t);
  $("buffSync").click(); await tick();
  const start = calls.find(call => call.action === "buff:start"); assert.equal(start.payload.maxPages, undefined); assert.equal(start.payload.appid, 730);
  assert.equal($("buffSync").disabled, true); assert.equal($("buffLogin").disabled, true); assert.equal($("buffStop").disabled, false);
  $("buffStop").click(); await tick(); assert.equal($("buffSync").disabled, false); assert.equal($("buffStop").disabled, true);
  assert.equal($("buffMaxPages"), null);
  $("buffGame").value = "all"; $("buffGame").dispatchEvent(new w.Event("change")); await tick(); assert.equal($("buffReviewBuys").disabled, true);
});

test("BUFF 在本页汇总与钻取，未知实际金额显示缺项且不会注入 Steam 页", async t => {
  const { $, w, navigation, calls } = await setup(t, [row(), row({ key: "2", paidTotalCents: null }), row({ key: "3", completed: false })]);
  $("buffSummaryView").click(); await tick();
  assert.equal($("buffRows").children.length, 1);
  assert.match($("buffRows").textContent, /2\/3 笔已完成/);
  assert.match($("buffRows").textContent, /4 件/); assert.match($("buffRows").textContent, /1\.24/);
  assert.match($("buffRows").textContent, /1 笔平台收支或数量缺项/);
  w.document.querySelector("[data-buff-group]").click(); await tick();
  assert.equal($("buffRows").children.length, 3); assert.equal($("buffBack").hidden, false);
  assert.equal($("buffAnalyze"), null); assert.deepEqual(navigation, []);
  assert.equal(w.BuffHistoryWorkspace.result(), null); assert(!calls.some(call => call.action === "history:import"));
});
