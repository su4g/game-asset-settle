"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const H = require("../desktop/market-history.js"), catalog = require("../desktop/dota2-names.js");
const { saveExport, validateExport } = require("../desktop/history-export.cjs");
const { assetForUrl, LocalState } = require("../desktop/runtime.cjs");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const header = ["Item Name", "Game Name", "Listed On", "Acted On", "Display Price", "Price in Cents", "Type", "Market Name", "App Id", "Asset Id"];
const cell = value => `"${String(value).replace(/"/g, '""')}"`;
function csv(rows) { return [header, ...rows.map(row => [row.name || "Relic Sword", "Dota 2", row.listed || "2026/09/30", row.date || "2026/10/01", row.display || "¥ 1.00", row.cents ?? 100, row.type || "purchase", row.market || row.name || "Relic Sword", row.appid || "570", row.asset || "test-asset"])].map(row => row.map(cell).join(",")).join("\r\n"); }
const mapping = { columns: { date: "日期", name: "物品", price: "金额", quantity: "数量", game: "游戏", platform: "平台", type: "买卖", currency: "币种" }, unit: "major", priceMode: "unit", game: "730", platform: "buff", type: "purchase", currency: "CNY" };
const genericHeader = "日期,物品,金额,数量,游戏,平台,买卖,币种\n";

test("Steam CSV 保留完整名称、逗号换行、BOM 和旧导出的内部引号", () => {
  const source = "\uFEFF" + csv([{ name: 'Inscribed A, "B"\nC', cents: 1234 }]);
  const data = H.parseImport(source);
  assert.equal(data.rows[0].marketHashName, 'Inscribed A, "B"\nC');
  assert.equal(data.rows[0].totalCents, 1234);
  assert.equal(data.rows[0].platform, "steam");
  const legacy = H.parseCsv('name,value\r\n"x "PGC 2019" Dacia",1');
  assert.equal(legacy[1].cells[0], 'x "PGC 2019" Dacia');
  assert.equal(legacy.legacyQuotes, 2);
});

test("标准 Steam 本人历史金额保留买入实付与卖出净到账口径，不再次扣费", () => {
  const data = H.parseImport(csv([{ type: "purchase", cents: 115, display: "¥ 1.15" }, { type: "sale", cents: 100, display: "¥ 1.00" }]), "my_market_history_1792551006792.csv");
  assert.deepEqual(data.rows.map(row => [row.sourceFormat, row.amountSemantics, row.totalCents]), [
    ["steam-market-history", "actual", 115], ["steam-market-history", "actual", 100],
  ]);
  // Explicit column mapping is an independent format even when it targets Steam or
  // its input includes columns whose names look like trusted parser metadata.
  const source = genericHeader.trimEnd() + ",sourceFormat,amountSemantics\n2026-10-21,Case,1.15,1,730,Steam,sale,CNY,steam-market-history,actual";
  const mapped = H.parseImport(source, "generic.csv", mapping).rows[0];
  assert.equal(mapped.platform, "steam");
  assert.equal(mapped.sourceFormat, undefined);
  assert.equal(mapped.amountSemantics, undefined);
});

test("异常数据按原始行报告，不静默跳过或把错误金额算为零", () => {
  for (const [input, pattern] of [
    [csv([{ cents: "1.2" }]), /第 2 行.*整数分/], [csv([{ cents: -1 }]), /第 2 行/],
    [csv([{ cents: "9007199254740992" }]), /超出/], [csv([{ type: "cancelled" }]), /交易类型/],
    [csv([{ date: "2026/02/30" }]), /日期不存在/], [csv([{ appid: "oops" }]), /App Id/],
    [csv([{ display: "1.00" }]), /币种/], [csv([]), /没有交易记录/],
    ["name,name\na,b", /不能.*重复/], ["\u0000garbled", /UTF-8/],
    ["a,b\n\"unterminated", /未闭合/], [csv([{}]) + ",extra", /列数/],
  ]) assert.throws(() => H.parseImport(input), pattern);
  assert.throws(() => H.parseCsv("a\n".repeat(H.MAX_ROWS + 2)), /100,000/);
  assert.throws(() => H.parseCsv("x".repeat(H.MAX_BYTES + 1)), /20 MB/);
});

test("默认全量；日期包含两端，并按游戏、买卖和平台分别筛选", () => {
  const data = H.parseImport(csv([{ date: "2026/09/30" }, { date: "2026/10/01", cents: 50 }, { date: "2026/10/31", cents: 75 }, { date: "2026/11/01" }, { type: "sale" }, { appid: "730" }, { appid: "753" }]));
  assert.equal(H.analyze(data).quantity, 7);
  const a = H.analyze(data, { start: "2026-10-01", end: "2026-10-31", game: "570", type: "purchase", platform: "steam" });
  assert.equal(a.quantity, 2); assert.equal(a.items.length, 1);
  assert.equal(a.items[0].totalCents, 125); assert.equal(a.items[0].averageCents, 62.5);
  assert.equal(H.roundedAverageCents(125, 2), 63);
  assert.equal(H.analyze(data, { platform: "buff" }).quantity, 0);
  assert.equal(H.analyze(data, { game: "other" }).quantity, 1);
  assert.throws(() => H.analyze(data, { start: "2026-10-31", end: "2026-10-01" }), /开始日期/);
  assert.deepEqual(H.monthRange(new Date("2026-09-30T16:00:00Z")), { start: "2026-10-01", end: "2026-10-31" });
  assert.deepEqual(H.monthRange(new Date("2024-03-01T00:00:00Z"), -1), { start: "2024-02-01", end: "2024-02-29" });
});

test("品质前缀、币种、游戏和买卖方向不混算，均价不提前四舍五入", () => {
  const data = H.parseImport(csv([{ cents: 1 }, { cents: 1 }, { cents: 2 }, { market: "Inscribed Relic Sword" }, { type: "sale" }, { appid: "730" }, { display: "US$ 1.00" }, { display: "$ 1.00" }]));
  const a = H.analyze(data);
  assert.equal(a.items.length, 6); assert.equal(a.quantity, 8); assert.equal(a.repeated, 1);
  const group = a.items.find(row => row.quantity === 3);
  assert.equal(group.totalCents, 4); assert.equal(group.averageCents, 4 / 3);
  assert.deepEqual(a.amounts.find(row => row.currency === "CNY"), { currency: "CNY", purchaseCents: 204, saleCents: 100 });
  assert.deepEqual(new Set(a.amounts.map(row => row.currency)), new Set(["CNY", "USD", "$"]));
});

test("中文名精确匹配完整市场名，未知不猜译，搜索兼容中英文", () => {
  const d = H.parseImport(csv([{ market: "Inscribed Relic Sword" }, { market: "Relic Sword" }, { name: "清单已有中文", market: "Unknown Market" }, { market: "Unknown" }]));
  assert.equal(Object.keys(catalog.items).length, 76);
  assert.equal(H.analyze(d, { search: "铭刻 圣者遗物" }, catalog).quantity, 1);
  assert.equal(H.analyze(d, { search: "inscribed relic" }, catalog).items[0].localized.name, "铭刻 圣者遗物");
  assert.equal(H.analyze(d, { search: "Unknown Market" }, catalog).items[0].localized.status, "清单中文名");
  assert.equal(H.analyze(d, { search: "Unknown", unverified: true }, catalog).quantity, 1);
  const local = { items: { "570:Unknown": { name: "人工核实物品", custom: true } } };
  assert.equal(H.analyze(d, { search: "人工核实" }, local).items[0].localized.status, "手动核对");
  for (const [key, entry] of Object.entries(catalog.items)) { assert.match(key, /^570:/); assert.match(entry.url, /^https:\/\/steamcommunity\.com\/market\/listings\/570\//); assert.match(entry.name, /[\u3400-\u9fff]/); }
});

test("通用 CSV 需列映射，BUFF / Steam / 其他平台与 CS2 / Dota / 其他游戏独立", () => {
  const source = genericHeader + "2026-10-21 23:59:59,某物品,12.34,2,CS2,BUFF,买入,CNY\n2026-10-21,某物品,10.00,1,csgo,Steam,sell,USD\n2026-10-21,某物品,3.20,1,Dota 2,其他平台,购买,CNY\n2026-10-21,某物品,1.00,1,PUBG,BUFF,购买,CNY";
  assert.equal(H.inspectCsv(source).steam, false);
  assert.throws(() => H.parseImport(source), error => error.code === "NEEDS_MAPPING");
  const d = H.parseImport(source, "多平台.csv", mapping), a = H.analyze(d);
  assert.equal(a.quantity, 4); assert.equal(a.units, 5); assert.equal(a.items.length, 4);
  assert.equal(H.analyze(d, { game: "730", platform: "buff" }).items[0].totalCents, 2468);
  assert.equal(H.analyze(d, { game: "other", platform: "buff" }).quantity, 1);
  assert.equal(H.analyze(d, { game: "570", platform: "other" }).quantity, 1);
  assert.equal(d.rows[0].date, "2026-10-21");
});

test("批量数量支持单价与总额两种语义，元转分精确，单价按数量加权", () => {
  const source = genericHeader + "2026-10-21,物品,0.10,2,730,BUFF,buy,CNY\n2026-10-21,物品,0.29,1,730,BUFF,buy,CNY";
  const unit = H.analyze(H.parseImport(source, "单价.csv", mapping));
  assert.equal(unit.items[0].totalCents, 49); assert.equal(unit.items[0].quantity, 3);
  assert.equal(unit.items[0].averageCents, 49 / 3);
  const total = H.analyze(H.parseImport(source, "总额.csv", { ...mapping, priceMode: "total" }));
  assert.equal(total.items[0].totalCents, 39); assert.equal(total.items[0].averageCents, 13);
  assert.equal(total.items[0].minCents, 5);
  const cents = genericHeader + "2026-10-21,物品,29,2,730,BUFF,buy,CNY";
  assert.equal(H.analyze(H.parseImport(cents, "分.csv", { ...mapping, unit: "cents" })).items[0].totalCents, 58);
});

test("通用格式的缺失列、单位、日期、空值和数量异常必须报告", () => {
  const valid = "2026-10-21,物品,12.34,1,730,BUFF,buy,CNY";
  for (const row of [valid.replace("12.34", "12.345"), valid.replace("12.34", "-12"), valid.replace(",1,730", ",0,730"), valid.replace(",1,730", ",1.5,730"), valid.replace("2026-10-21", "2026-02-30"), valid.replace("2026-10-21", "2026-10-21 99:00"), valid.replace("BUFF", ""), valid.replace("buy", "cancelled")]) assert.throws(() => H.parseImport(genericHeader + row, "test.csv", mapping), /第 2 行/);
  assert.throws(() => H.parseImport(genericHeader + valid, "test.csv", { ...mapping, columns: { ...mapping.columns, price: "missing" } }), /不存在列/);
  assert.throws(() => H.parseImport(genericHeader + valid, "test.csv", { ...mapping, unit: "unknown" }), /金额单位/);
  const small = "时间,名字,钱\n2026/10/21,武器箱,12.34";
  const d = H.parseImport(small, "BUFF.csv", { ...mapping, columns: { date: "时间", name: "名字", price: "钱" } });
  assert.equal(d.rows[0].quantity, 1); assert.equal(d.rows[0].platform, "buff"); assert.equal(d.rows[0].appid, "730");
});

test("导出包含中文、原名、来源与精确总额，转义引号及公式注入", () => {
  const a = H.analyze(H.parseImport(csv([{ name: '=HYPERLINK("evil")', cents: 62 }, { name: '=HYPERLINK("evil")', cents: 63 }])));
  const output = H.exportCsv(a), rows = H.parseCsv(output);
  assert.equal(output.charCodeAt(0), 0xFEFF);
  assert.equal(rows[1].cells[1], '\'=HYPERLINK("evil")');
  assert.equal(rows[1].cells[3], "Steam");
  assert.equal(rows[1].cells[9], "0.63"); assert.equal(rows[1].cells[10], "1.25");
  assert.equal(H.parseCsv(H.exportCsv(a, "details")).length, 3);
});

test("原生导出只写对话框选择的路径，取消不写，拒绝路径注入", async () => {
  const payload = { fileName: "交易汇总.csv", text: "\uFEFF名称,金额\r\n物品,1.00\r\n" };
  let writes = 0;
  assert.deepEqual(await saveExport(payload, async () => ({ canceled: true }), async () => { writes++; }), { cancelled: true });
  assert.equal(writes, 0);
  await saveExport({ ...payload, path: "/ignored.csv" }, async options => { assert.equal(options.defaultPath, "交易汇总.csv"); return { filePath: "/chosen.csv" }; }, async (file, text, options) => { writes++; assert.equal(file, "/chosen.csv"); assert.equal(text, payload.text); assert.equal(options.mode, 0o600); });
  assert.equal(writes, 1);
  for (const fileName of ["../evil.csv", "/tmp/evil.csv", "C:\\evil.csv", ".hidden.csv", "evil.txt", "x\n.csv"]) assert.throws(() => validateExport({ ...payload, fileName }));
  assert.throws(() => validateExport({ ...payload, text: "no BOM" }));
});

test("前端资源与旧中文名偏好仍受允许列表限制，归档由后台处理", async t => {
  for (const name of ["market-history.js", "market-history-ui.js", "dota2-names.js"]) assert.equal(assetForUrl("buff-desktop://app/desktop/" + name), "desktop/" + name);
  assert.equal(assetForUrl("buff-desktop://app/desktop/history-export.cjs"), null);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "buff-history-test-")); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json"), state = new LocalState(file), historyNames = { "730:Case": { name: "武器箱", custom: true } };
  await state.set({ historyNames }); assert.deepEqual(await new LocalState(file).get(["historyNames"]), { historyNames });
  await assert.rejects(state.set({ historyCsv: "raw private CSV" }), /未开放/);
});
