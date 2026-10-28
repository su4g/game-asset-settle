"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { JSDOM } = require("jsdom");
const H = require("../desktop/market-history.js");
const { csvRecords } = require("../server/history-store.cjs");
const root = path.resolve(__dirname, "..");
const header = "Item Name,Game Name,Listed On,Acted On,Display Price,Price in Cents,Type,Market Name,App Id,Asset Id\n";
const sample = header + "Relic Sword,Dota 2,2026/09/30,2026/10/01,¥ 0.62,62,purchase,Inscribed Relic Sword,570,1\nRelic Sword,Dota 2,2026/09/30,2026/10/31,¥ 0.63,63,purchase,Inscribed Relic Sword,570,2\nCase,Counter-Strike 2,2026/09/30,2026/10/21,¥ 1.00,100,sale,Case,730,3";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function setup(t, initial = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, "desktop/index.html"), "utf8"), { runScripts: "outside-only", url: "https://desktop.invalid/" });
  const w = dom.window, calls = [], saved = { ...initial }; w.TextEncoder = TextEncoder;
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event("close")); };
  w.buffDesktop = { request: async (action, payload) => {
    calls.push({ action, payload });
    if (action === "storage:get") return saved;
    if (action === "storage:set") { Object.assign(saved, payload); return null; }
    if (action === "history:load") return saved.archive || { fileName: "已入库 CSV 历史", rows: [] };
    if (action === "history:names") return { items: saved.nameMappings || {} };
    if (action === "history:name-save") { saved.nameMappings ||= {}; const key = `${payload.appid}:${payload.marketHashName}`; if (!payload.onlyIfMissing || !saved.nameMappings[key]) saved.nameMappings[key] = { ...payload, custom: true }; return saved.nameMappings[key]; }
    if (action === "history:import") {
      const data = H.parseImport(payload.text, payload.fileName, payload.mapping), before = new Map((saved.archive?.rows || []).map(row => [row.key,row]));
      let inserted = 0; for (const row of csvRecords(data, payload.scope)) { if (!before.has(row.key)) inserted++; before.set(row.key,row); }
      saved.archive = { ...data, fileName: "已入库 CSV 历史", rows: [...before.values()] };
      return { inserted, skipped: data.rows.length-inserted, updated: 0, total: before.size };
    }
    if (action === "history:export") return { cancelled: false };
    throw new Error("Unexpected API: " + action);
  } };
  for (const file of ["common.js", "desktop/dota2-names.js", "desktop/market-history.js", "desktop/market-history-ui.js"]) w.eval(fs.readFileSync(path.join(root, file), "utf8"));
  t.after(() => w.close());
  await w.BuffHistoryWorkspace.ready;
  const $ = id => w.document.getElementById(id);
  function change(id, value) { $(id).value = value; $(id).dispatchEvent(new w.Event("change")); }
  function submit(id) { $(id).dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true })); }
  return { w, $, calls, saved, change, submit, workspace: w.BuffHistoryWorkspace };
}

test("Steam 订单默认全部日期与买卖，日期和 CS2/Dota 可独立组合，中文名称保留原名", async t => {
  const { $, change, workspace } = await setup(t);
  workspace.importText(sample, "市场.csv");
  assert.equal($("historyTitle").textContent, "CSV 归档");
  assert.equal($("historyStart").value, ""); assert.equal($("historyGame").value, "all"); assert.equal($("historyType").value, "all");
  assert.equal($("historyPlatform").value, "steam"); assert.equal($("historyPlatform").disabled, true);
  assert.equal(workspace.result().quantity, 3);
  change("historyGame", "570"); change("historyType", "purchase"); change("historyStart", "2026-10-01"); change("historyEnd", "2026-10-31");
  assert.equal(workspace.result().quantity, 2);
  assert.match($("historyRows").textContent, /铭刻 圣者遗物/); assert.match($("historyRows").textContent, /Inscribed Relic Sword/);
  assert.match($("historyRows").textContent, /0\.63/); assert.match($("historyMetrics").textContent, /1\.25/);
  change("historyType", "sale"); assert.equal(workspace.result().quantity, 0); assert.equal($("historyExportSummary").disabled, true);
  change("historyEnd", "2026-09-30"); assert.equal(workspace.result(), null); assert.match($("historyError").textContent, /开始日期/);
  workspace.importText(sample, "重新上传.csv"); assert.equal(workspace.result().quantity, 3); assert.equal($("historyStart").value, "");
});

test("钻取、分页与导出使用全部筛选结果，不受当前页限制", async t => {
  const { $, w, calls, workspace } = await setup(t);
  workspace.importText(sample, "市场.csv");
  const target = [...w.document.querySelectorAll('[data-history-action="details"]')].find(button => button.getAttribute("aria-label").includes("铭刻")); target.click();
  assert.equal($("historyRows").children.length, 2); assert.equal($("historyDrill").hidden, false);
  $("historyExportDetails").click(); await tick();
  const exported = calls.find(call => call.action === "history:export").payload;
  assert.equal(w.BuffMarketHistory.parseCsv(exported.text).length, 3);
  $("historyBack").click(); assert.equal($("historyDrill").hidden, true);
  const many = header + Array.from({ length: 65 }, (_, i) => `Name${i},Dota 2,2026/10/01,2026/10/21,¥ 1.00,100,purchase,Name${i},570,${i}`).join("\n");
  workspace.importText(many, "分页.csv"); assert.equal($("historyRows").children.length, 50);
  $("historyNext").click(); assert.equal($("historyRows").children.length, 15);
  $("historyExportSummary").click(); await tick();
  assert.equal(w.BuffMarketHistory.parseCsv(calls.at(-1).payload.text).length, 66);
});

test("非标准 CSV 打开列映射并默认 Steam，预览首行，选 CS2 和总额后按数量计算", async t => {
  const { $, w, submit, change, workspace, calls } = await setup(t);
  const text = "日期,物品名称,成交金额,数量\n2026-10-21 12:00:00,武器箱,12.35,2";
  await workspace.loadFile({ name: "Steam.csv", size: text.length, text: async () => text });
  assert.equal($("historyMappingDialog").open, true); assert.equal(workspace.result(), null);
  assert.equal($("historyMapDate").value, "日期"); assert.equal($("historyMapPriceMode").value, "total");
  assert.match(w.document.querySelector('[data-history-sample="price"]').textContent, /12\.35/);
  assert.equal($("historyMapDefaultPlatform").value, "steam");
  change("historyMapDefaultGame", "730"); submit("historyMappingForm"); await tick();
  assert.equal($("historyMappingDialog").open, false);
  assert.equal(workspace.result().items[0].quantity, 2); assert.equal(workspace.result().items[0].totalCents, 1235);
  assert.equal(workspace.result().items[0].appid, "730"); assert.equal(workspace.result().items[0].platform, "steam");
  assert.match($("historyRows").textContent, /6\.18/); assert.match($("historyRows").textContent, /清单中文名/);
  assert.equal(calls.filter(call => call.action === "storage:set").length, 0);
});

test("混合归档只展示和导出 Steam，筛选账户、币种和最新月份不混入其他来源", async t => {
  const steam = csvRecords(H.parseImport(sample, "Steam.csv"), "Steam账户");
  const other = csvRecords(H.parseImport("日期,名称,金额,平台,游戏,方向,币种\n2027-01-10,不应显示的BUFF物品,20,BUFF,999,buy,USD\n2027-02-10,不应显示的UU物品,30,悠悠,888,sell,EUR", "其他.csv", {
    columns: { date: "日期", name: "名称", price: "金额", platform: "平台", game: "游戏", type: "方向", currency: "币种" }, unit: "major", priceMode: "total",
  }), "其他账户");
  const initial = { archive: { fileName: "已入库 CSV 历史", rows: [...steam, ...other], start: "2026-10-01", end: "2027-02-10" } };
  const { $, w, workspace, calls, saved } = await setup(t, initial);
  assert.equal(workspace.result().quantity, 3); assert.equal(saved.archive.rows.length, 5);
  assert.match($("historyFileInfo").textContent, /3 笔 Steam 订单.*2026-10-31/);
  assert.doesNotMatch($("historyRows").textContent, /不应显示/);
  assert.deepEqual([...$("historyAccount").options].map(option => option.value), ["all", "Steam账户"]);
  assert.deepEqual([...$("historyCurrency").options].map(option => option.value), ["all", "CNY"]);
  assert(![...$("historyGame").options].some(option => ["999", "888"].includes(option.value)));
  w.document.querySelector('[data-history-range="latest"]').click();
  assert.equal($("historyStart").value, "2026-10-01"); assert.equal($("historyEnd").value, "2026-10-31");
  $("historyDetailView").click(); assert.equal($("historyRows").children.length, 3);
  $("historyExportDetails").click(); await tick();
  const exported = calls.filter(call => call.action === "history:export").at(-1).payload;
  assert.match(exported.fileName, /^Steam订单/); assert.equal(H.parseCsv(exported.text).length, 4); assert.doesNotMatch(exported.text, /不应显示/);
  $("historyClear").click(); await workspace.reloadArchive();
  assert.equal(workspace.result().quantity, 3); assert.equal(saved.archive.rows.length, 5);
});

test("显式导入其他平台仍按原来源保存，但不进入 Steam 订单结果", async t => {
  const { $, submit, change, workspace, saved } = await setup(t);
  const text = "日期,物品名称,成交金额,数量\n2026-10-21 12:00:00,武器箱,12.35,2";
  await workspace.loadFile({ name: "BUFF.csv", size: text.length, text: async () => text });
  change("historyMapDefaultPlatform", "buff"); change("historyMapDefaultGame", "730"); submit("historyMappingForm"); await tick();
  assert.equal($("historyMappingDialog").open, false); assert.equal(workspace.result().quantity, 0);
  assert.equal(saved.archive.rows[0].platform, "buff"); assert.equal(saved.archive.rows[0].totalCents, 1235);
  assert.match($("historyMessage").textContent, /已按原来源保存/); assert.equal($("historyExportSummary").disabled, true);
});

test("导入失败与映射取消保留旧结果，晚到的文件读取不能覆盖新文件", async t => {
  const { $, workspace } = await setup(t);
  workspace.importText(sample, "原.csv");
  await workspace.loadFile({ name: "bad.csv", size: 10, text: async () => '"never closes' });
  assert.equal(workspace.result().quantity, 3); assert.match($("historyError").textContent, /已保留/);
  await workspace.loadFile({ name: "other.csv", size: 10, text: async () => "日期,物品名称,金额\n2026-10-21,物品,5" });
  $("historyMappingClose").click(); assert.equal(workspace.result().quantity, 3);
  let release;
  const old = workspace.loadFile({ name: "慢.csv", size: 10, text: () => new Promise(resolve => { release = resolve; }) });
  await workspace.loadFile({ name: "新.csv", size: sample.length, text: async () => sample });
  release(sample); await old;
  assert.equal($("historyFileName").textContent, "新.csv");
  $("historyClear").click(); assert.equal(workspace.result(), null); assert.equal($("historyExportSummary").disabled, true);
});

test("手工中文核对保存并可恢复；导入 HTML 文本不执行", async t => {
  const { $, w, submit, saved, calls, workspace } = await setup(t);
  const evil = header + "<img src=x onerror=alert(1)>,Dota 2,2026/10/01,2026/10/21,¥ 1.00,100,purchase,<img src=x onerror=alert(1)>,570,x";
  workspace.importText(evil, "安全.csv");
  assert.equal($("historyRows").querySelectorAll("img").length, 0); assert.match($("historyRows").textContent, /待核对/);
  w.document.querySelector('[data-history-action="name"]').click(); $("historyChineseName").value = "已核实物品";
  submit("historyNameForm"); await tick();
  assert.match($("historyRows").textContent, /已核实物品/); assert.match($("historyRows").textContent, /手动核对/);
  assert.equal(calls.filter(call => call.action === "ledger").length, 0);
  const second = await setup(t, saved); second.workspace.importText(evil, "再次.csv");
  assert.match(second.$("historyRows").textContent, /已核实物品/);
  assert.deepEqual(Object.keys(saved), ["nameMappings"]);
});
