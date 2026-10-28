"use strict";
function resolveOrderNames(source, catalog = {}) {
  const aliases = new Map(), items = catalog.items || {};
  const add = (appid, name, hash) => {
    if (!/^\d+$/.test(String(appid)) || typeof name !== "string" || !/[\u3400-\u9fff]/.test(name)
      || typeof hash !== "string" || !/[A-Za-z]/.test(hash) || /[\u3400-\u9fff]/.test(hash)) return;
    const key = JSON.stringify([String(appid), name]);
    if (!aliases.has(key)) aliases.set(key, new Set());
    aliases.get(key).add(hash);
  };
  for (const entry of Object.values(items)) {
    // Several Chinese aliases for one full market name are not an item-identity conflict.
    // Keep all evidence so a Chinese alias pointing to multiple full names stays unresolved.
    if (!entry.conflict || entry.custom) add(entry.appid, entry.name, entry.marketHashName);
    for (const candidate of entry.candidates || []) add(entry.appid, candidate.name, entry.marketHashName);
  }
  for (const row of source) add(row.appid, row.name, row.marketHashName);
  const rows = source.map(row => {
    const matches = aliases.get(JSON.stringify([String(row.appid), row.name]));
    const hash = row.marketHashName || (matches?.size === 1 ? [...matches][0] : "");
    const entry = items[`${row.appid}:${hash}`];
    return { ...row, marketHashName: hash, name: entry?.name && (!entry.conflict || entry.custom) ? entry.name : row.name };
  });
  // List and batch-detail endpoints may supply different metadata for the same item.
  // Fill a missing category only when this account/platform has one unambiguous category.
  const categories = new Map(), itemKey = row => JSON.stringify([row.accountId, row.appid, row.marketHashName]);
  for (const row of rows) if (row.marketHashName && row.category) {
    const key = itemKey(row);
    if (!categories.has(key)) categories.set(key, new Set());
    categories.get(key).add(row.category);
  }
  return rows.map(row => {
    const choices = row.marketHashName && categories.get(itemKey(row));
    return !row.category && choices?.size === 1 ? { ...row, category: [...choices][0] } : row;
  });
}
function category(row) {
  if (row.category) return row.category;
  const name = `${row.name} ${row.marketHashName}`;
  if (/终端机|\bTerminal\b/i.test(name)) return "终端机";
  if (/印花|Sticker(?: \|| Capsule)/i.test(name)) return "印花";
  if (/音乐盒|Music Kit/i.test(name)) return "音乐盒";
  if (/手套|Gloves|Hand Wraps/i.test(name)) return "手套";
  if (/★|刺刀|匕首|Knife|Bayonet/i.test(name)) return "刀";
  if (/武器箱|胶囊|珍藏|宝瓶|\b(Case|Capsule|Treasure)\b/i.test(name)) return "箱子 / 容器";
  if (/探员|Agent|特种部队|游击队/i.test(name)) return "探员";
  if (/(?:^| )(AK-47|M4A[14]-?S?|AWP|USP-S|Glock-18|P250|Desert Eagle|沙漠之鹰|SSG 08|FAMAS|Galil AR|MP9|MAC-10|P90|UMP-45|XM1014|Nova|Sawed-Off|Negev|M249|SCAR-20|G3SG1|SG 553|AUG|Five-SeveN|Tec-9|CZ75-Auto|R8|双持贝瑞塔|Dual Berettas|MAG-7|MP7|MP5-SD|PP-Bizon)\s*\|/i.test(name)) return "武器皮肤";
  return "未分类";
}
function day(value) { return value ? new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10) : ""; }
function groupKey(row) { return JSON.stringify([row.accountId, row.appid, row.direction, row.channel, row.currencyCode, row.marketHashName || `goods:${row.goodsId}`]); }
function analyzeOrders(source, filters = {}) {
  for (const value of [filters.start, filters.end]) if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value)) throw new Error("订单筛选日期无效");
  if (filters.start && filters.end && filters.start > filters.end) throw new Error("开始日期不能晚于结束日期");
  const query = String(filters.query || "").trim().toLowerCase(), groups = new Map(), amounts = new Map();
  const all = source.map(row => ({ ...row, category: category(row) }));
  const rows = all.filter(row => {
    const date = day(filters.dateField === "created" ? row.createdAt : row.tradedAt);
    return (filters.appid === "all" || filters.appid == null || row.appid === filters.appid)
      && (!filters.channel || row.channel === filters.channel) && (!filters.direction || filters.direction === "all" || row.direction === filters.direction)
      && (!filters.category || filters.category === "all" || row.category === filters.category)
      && (!filters.status || filters.status === "all" || (filters.status === "completed" ? row.completed : filters.status === "open" ? !row.completed && !/CANCEL|REFUND|CLOSED|取消|退款/i.test(row.state) : /CANCEL|REFUND|CLOSED|取消|退款/i.test(row.state)))
      && (!filters.start || date && date >= filters.start) && (!filters.end || date && date <= filters.end)
      && (!query || [row.name, row.marketHashName, row.orderId, row.goodsId].some(value => String(value || "").toLowerCase().includes(query)))
      && (!filters.groupKey || groupKey(row) === filters.groupKey);
  }).sort((a,b) => (b.tradedAt || b.createdAt || "").localeCompare(a.tradedAt || a.createdAt || "") || a.key.localeCompare(b.key));
  let completed = 0;
  for (const row of rows) {
    const key = groupKey(row);
    const group = groups.get(key) || { ...row, key, records: 0, completedRecords: 0, quantity: 0, grossCents: 0, grossQuantity: 0, actualCents: 0, actualQuantity: 0, unknownGross: 0, unknownActual: 0, unknownQuantity: 0, firstDate: "", lastDate: "" };
    group.records++;
    if (row.completed) {
      completed++; group.completedRecords++;
      const date = day(row.tradedAt);
      if (date && (!group.firstDate || date < group.firstDate)) group.firstDate = date;
      if (date > group.lastDate) group.lastDate = date;
      if (row.quantity > 0) group.quantity += row.quantity; else group.unknownQuantity++;
      const actual = row.direction === "buy" ? row.paidTotalCents : row.netTotalCents;
      if (row.quantity > 0 && row.grossTotalCents != null) { group.grossCents += row.grossTotalCents; group.grossQuantity += row.quantity; } else group.unknownGross++;
      if (row.quantity > 0 && actual != null) { group.actualCents += actual; group.actualQuantity += row.quantity; } else group.unknownActual++;
      const amountKey = `${row.currencyCode}:${row.direction}`, amount = amounts.get(amountKey) || { currency: row.currencyCode, direction: row.direction, totalCents: 0, actualCents: 0, knownGross: 0, knownActual: 0, unknownGross: 0, unknownActual: 0 };
      if (row.grossTotalCents != null) { amount.totalCents += row.grossTotalCents; amount.knownGross++; } else amount.unknownGross++;
      if (actual != null) { amount.actualCents += actual; amount.knownActual++; } else amount.unknownActual++;
      if (![group.grossCents, group.actualCents, amount.totalCents, amount.actualCents].every(Number.isSafeInteger)) throw new Error("订单金额汇总超过安全计算范围，请缩小范围");
      amounts.set(amountKey, amount);
    }
    groups.set(key, group);
  }
  const grouped = [...groups.values()].map(row => ({ ...row, averageCents: row.grossQuantity ? row.grossCents / row.grossQuantity : null, actualAverageCents: row.actualQuantity ? row.actualCents / row.actualQuantity : null }));
  const sort = filters.sort || "date";
  grouped.sort((a,b) => (sort === "total" ? b.grossCents - a.grossCents : sort === "quantity" ? b.quantity - a.quantity : sort === "average" ? (b.averageCents ?? -1) - (a.averageCents ?? -1) : b.lastDate.localeCompare(a.lastDate)) || a.key.localeCompare(b.key));
  const total = filters.mode === "summary" ? grouped.length : rows.length;
  const pages = Math.ceil(total / 50), page = Math.min(Math.max(1, filters.page || 1), Math.max(1,pages));
  return { rows: rows.slice((page-1)*50,page*50), groups: grouped.slice((page-1)*50,page*50), total, page, pages, recordTotal: rows.length, groupTotal: grouped.length, completed, excluded: rows.length-completed, amounts: [...amounts.values()], categories: [...new Set(all.map(row => row.category))].sort((a,b)=>a.localeCompare(b,"zh-CN")) };
}
module.exports = { category, day, groupKey, analyzeOrders, resolveOrderNames };
