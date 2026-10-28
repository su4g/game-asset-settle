"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const H = require("../desktop/market-history.js"), { HistoryStore, csvRecords, candidate, learnName, same } = require("../server/history-store.cjs"), { analyzeOrders } = require("../desktop/buff-analysis.cjs");
const csv = "Item Name,Acted On,Display Price,Price in Cents,Type,Market Name,App Id,Asset Id\n";
const line = (id = "", price = 100, game = 570, english = "Inscribed Sword") => `铭刻 测试剑,2026/10/21,¥ ${(price/100).toFixed(2)},${price},purchase,${english},${game},${id}`;
const order = (id, extra = {}) => ({ key: String(id), accountId: "buff:test", appid: 730, channel: "history", direction: "buy", marketHashName: "AK-47 | Test (Field-Tested)", name: "AK-47 | 测试（久经沙场）", goodsId: "1", orderId: String(id), quantity: 1, completed: true, state: "SUCCESS", currencyCode: "CNY", grossTotalCents: 100, paidTotalCents: 90, tradedAt: "2026-10-20T16:00:00.000Z", createdAt: "2026-10-20T15:59:00.000Z", ...extra });
test("归组使用精确别名与游戏，多英文歧义不推断；买卖、账号、币种、品质仍分开",()=>{
  const {resolveOrderNames}=require("../desktop/buff-analysis.cjs");
  const hash="Sealed Dead Hand Terminal",name="封装的毁灭之手终端机";
  const source=[order(1,{marketHashName:hash,name,quantity:166,grossTotalCents:33034}),order(2,{marketHashName:"",name,goodsId:"2",quantity:55,grossTotalCents:10960}),order(3,{marketHashName:hash,name,direction:"sell",quantity:227,grossTotalCents:49940}),order(4,{marketHashName:hash,name,accountId:"buff:other"}),order(5,{marketHashName:hash,name,currencyCode:"USD"}),order(6,{marketHashName:"",name,appid:570})];
  const before=structuredClone(source),resolved=resolveOrderNames(source),result=analyzeOrders(resolved,{mode:"summary"});
  assert.equal(result.groupTotal,5);assert.equal(result.recordTotal,6);
  const buy=result.groups.find(r=>r.records===2);assert.equal(buy.quantity,221);assert.equal(buy.grossCents,43994);assert.equal(buy.averageCents,43994/221);
  assert.equal(result.groups.find(r=>r.direction==="sell").quantity,227);assert.equal(resolved[5].marketHashName,"");assert.deepEqual(source,before);
  const catalog={items:{a:{appid:"730",marketHashName:"AK-47 | Test (Field-Tested)",conflict:true,candidates:[{name:"测试皮肤"}]},b:{appid:"730",marketHashName:"AK-47 | Test (Factory New)",name:"测试皮肤",custom:true},c:{appid:"570",marketHashName:"Dota Item",name:"测试皮肤"}}};
  const ambiguous=resolveOrderNames([order(7,{name:"测试皮肤",marketHashName:"",goodsId:"7"}),order(8,{name:"测试皮肤",marketHashName:"AK-47 | Test (Field-Tested)"}),order(9,{name:"测试皮肤",marketHashName:"AK-47 | Test (Factory New)"}),order(10,{name:"测试皮肤",marketHashName:"",appid:570})],catalog);
  assert.equal(ambiguous[0].marketHashName,"");assert.equal(ambiguous[3].marketHashName,"Dota Item");assert.equal(analyzeOrders(ambiguous,{mode:"summary"}).groupTotal,4);
});
test("CSV 无订单号按完整内容及出现次数去重，保留同价多笔、账户和品质差异", () => {
  const a = csvRecords(H.parseImport(csv + [line(),line(),line("asset")].join("\n")),"A");
  assert.equal(new Set(a.map(r=>r.key)).size,3);
  const b = csvRecords(H.parseImport(csv + [line("asset"),line(),line()].join("\n")),"A");
  assert.deepEqual(a.map(r=>r.key).sort(), b.map(r=>r.key).sort());
  assert.notEqual(a[0].key, csvRecords(H.parseImport(csv+line()),"B")[0].key);
  assert.notEqual(a[0].key, csvRecords(H.parseImport(csv+line("",100,570,"Sword")),"A")[0].key);
});
test("Steam 金额来源元数据完整保存，但不改变已有订单或出现次数去重身份", () => {
  const dataset = H.parseImport(csv + [line(), line(), line("asset")].join("\n"), "my_market_history.csv");
  const previous = structuredClone(dataset);
  for (const row of previous.rows) { delete row.sourceFormat; delete row.amountSemantics; }
  const before = csvRecords(previous, "本人"), after = csvRecords(dataset, "本人");
  assert.deepEqual(after.map(row => row.key), before.map(row => row.key));
  assert(after.every(row => row.sourceFormat === "steam-market-history" && row.amountSemantics === "actual"));
  assert.equal(new Set(after.map(row => row.key)).size, 3);
  previous.rows.forEach((row, i) => { row.orderId = `order-${i}`; });
  const withOrders = structuredClone(previous);
  withOrders.rows.forEach(row => { row.sourceFormat = "steam-market-history"; row.amountSemantics = "actual"; });
  assert.deepEqual(csvRecords(previous, "本人").map(row => row.key), csvRecords(withOrders, "本人").map(row => row.key));
});
test("同一标准 Steam 文件逆时序有独立来源证据，乱序或通用格式不推断时序", () => {
  const source = csv + [line("1"), line("2"), line("3").replace("2026/10/21", "2026/10/20")].join("\n");
  const dataset = H.parseImport(source), digest = require("node:crypto").createHash("sha256").update(source).digest("hex");
  const rows = csvRecords(dataset, "本人", digest);
  assert.deepEqual(rows.map(row => row.sourceSequence), [2, 3, 4].map(row => ({ format: "steam-market-history", documentHash: digest, row, direction: "newest-first" })));
  assert.deepEqual(rows.map(row => row.key), csvRecords(dataset, "本人").map(row => row.key));
  assert.deepEqual(rows.map(row => row.key), csvRecords(dataset, "本人", "b".repeat(64)).map(row => row.key));
  for (const mutate of [
    copy => copy.rows.reverse(),
    copy => { copy.rows[1].date = "2026-10-22"; },
    copy => { copy.rows[1].sourceRow = copy.rows[0].sourceRow; },
    copy => { delete copy.rows[1].sourceFormat; },
    copy => { copy.rows[1].amountSemantics = "unknown"; },
  ]) {
    const copy = structuredClone(dataset); mutate(copy);
    assert(csvRecords(copy, "本人", digest).every(row => !row.sourceSequence));
  }
  assert(csvRecords(dataset, "本人").every(row => !row.sourceSequence));
  assert(csvRecords(dataset, "本人", "not-a-document-hash").every(row => !row.sourceSequence));
});
test("JSONB 嵌套键重排不算变更，但来源行和文档的实际变更仍保存", () => {
  const source = { key: "one", sourceRow: 2, fileName: "first.csv", sourceSequence: { format: "steam-market-history", documentHash: "a".repeat(64), row: 2, direction: "newest-first" } };
  const persisted = { ...source, fileName: "renamed.csv", sourceSequence: { row: 2, format: "steam-market-history", direction: "newest-first", documentHash: "a".repeat(64) } };
  assert(same(source, persisted));
  assert(!same(source, { ...persisted, sourceSequence: { ...persisted.sourceSequence, row: 3 } }));
  assert(!same(source, { ...persisted, sourceSequence: { ...persisted.sourceSequence, documentHash: "b".repeat(64) } }));
  assert(!same({ values: [1, 2] }, { values: [2, 1] }));
});
test("旧版 Steam 历史重导入只更新金额口径，重复导入不新增历史", async () => {
  const content = csv + [line(), line(), line("asset")].join("\n"), fileName = "my_market_history.csv", scope = "本人";
  let stored = csvRecords(H.parseImport(content, fileName), scope);
  for (const row of stored) { delete row.sourceFormat; delete row.amountSemantics; }
  const store = new HistoryStore({});
  store.transaction = callback => callback({ query: async sql => ({ rows: sql.startsWith("SELECT key,payload") ? stored.map(payload => ({ key: payload.key, payload })) : [] }) });
  store.upsert = async (_client, kind, rows) => {
    assert.equal(kind, "csv");
    const merged = new Map(stored.map(row => [row.key, row]));
    rows.forEach(row => merged.set(row.key, row)); stored = [...merged.values()];
  };
  store.learn = async () => 0;
  const first = await store.importCsv({ text: content, fileName, scope });
  assert.deepEqual([first.inserted, first.updated, first.skipped, first.total], [0, 3, 0, 3]);
  assert(stored.every(row => row.sourceFormat === "steam-market-history" && row.amountSemantics === "actual"));
  const digest = require("node:crypto").createHash("sha256").update(content).digest("hex");
  assert(stored.every(row => row.sourceSequence.documentHash === digest && row.sourceSequence.row === row.sourceRow));
  const repeat = await store.importCsv({ text: content, fileName, scope });
  assert.deepEqual([repeat.inserted, repeat.updated, repeat.skipped, repeat.total], [0, 0, 3, 3]);
});
test("UU 服务端允许同订单行从旧占位商品号补全模板，不接受两个明确模板冲突", async () => {
  const row = { ...order("uu-order"), key: "uu:test:730:buy:history:uu-order:100", accountId: "uu:test", lineId: "100", goodsId: "100", state: "340", quantity: 1 };
  let old = row, saved = [];
  const store = new HistoryStore({});
  store.transaction = callback => callback({ query: async sql => ({ rows: sql.startsWith("SELECT revision") ? [{ revision: 0 }] : sql.startsWith("SELECT key,payload") ? [{ key: old.key, payload: old }] : [] }) });
  store.upsert = async (_client, kind, rows) => { assert.equal(kind, "uu"); saved = rows; };
  store.learn = async () => 0;
  const data = record => ({ version: 1, accounts: { "uu:test": { account: { id: "uu:test" }, records: [record], runs: [] } } });
  const filled = { ...row, goodsId: "200", templateId: "200" };
  await store.saveUu({ revision: 0, data: data(filled) });
  assert.equal(saved[0].key, row.key); assert.equal(saved[0].goodsId, "200");
  old = filled;
  await assert.rejects(store.saveUu({ revision: 0, data: data({ ...filled, goodsId: "201", templateId: "201" }) }), /物品身份冲突/);
});
test("BUFF 精确中英文名增量收录、冲突隔离、手动优先，游戏与品质不串名", () => {
  assert.equal(candidate(570, "Inscribed Sword", "Sword", "BUFF"), null);
  assert.equal(candidate(570, "测试剑", "测试剑", "BUFF"), null);
  const a = candidate(570, "Inscribed Sword", "铭刻 测试剑", "BUFF 订单");
  const first = learnName(null,a,"2026-10-21");
  assert.equal(learnName(first,a), first);
  let conflicting = learnName(first, {...a,name:"测试剑"});
  assert.equal(conflicting.conflict,true); assert.equal(conflicting.name,"");
  const data = H.parseImport(csv+line());
  assert.equal(H.itemName(data.rows[0],{items:{"570:Inscribed Sword":conflicting}}).status,"映射冲突");
  conflicting = {...conflicting,custom:true,name:"铭刻 已核实剑"};
  assert.equal(learnName(conflicting,{...a,name:"另一个名字"}).name,"铭刻 已核实剑");
  assert.equal(H.itemName({...data.rows[0],appid:"730"},{items:{"570:Inscribed Sword":first}}).status,"清单中文名");
});
test("BUFF 全量筛选后按完整规格分组，均价按数量加权且未知实付不当零", () => {
  const rows = [order(1,{quantity:2,grossTotalCents:301,paidTotalCents:null}),order(2,{quantity:1,grossTotalCents:200,paidTotalCents:180}),order(3,{completed:false,state:"CANCELLED",grossTotalCents:999}),order(4,{marketHashName:"AK-47 | Test (Factory New)"}),order(5,{direction:"sell"})];
  const result=analyzeOrders(rows,{appid:730,direction:"buy",start:"2026-10-21",end:"2026-10-21",mode:"summary"});
  assert.equal(result.recordTotal,4);assert.equal(result.groupTotal,2);assert.equal(result.completed,3);
  const group=result.groups.find(r=>r.records===3);assert.equal(group.averageCents,167);assert.equal(group.actualAverageCents,180);assert.equal(group.unknownActual,1);assert.equal(group.quantity,3);
  assert.equal(analyzeOrders(rows,{start:"2026-10-21",dateField:"created"}).total,0);
  assert.equal(analyzeOrders(rows,{category:"武器皮肤",status:"closed"}).total,1);
  assert.equal(analyzeOrders(rows,{groupKey:group.key}).total,3);
  assert.throws(()=>analyzeOrders(rows,{start:"2026-10-22",end:"2026-10-21"}),/开始日期/);
  const many=Array.from({length:65},(_,i)=>order(i,{marketHashName:`Name ${i}`}));
  const paged=analyzeOrders(many,{page:2,mode:"summary"});assert.equal(paged.groups.length,15);assert.equal(paged.completed,65);assert.equal(paged.amounts[0].totalCents,6500);
});
