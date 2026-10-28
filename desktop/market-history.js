"use strict";
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("../common.js"));
  else root.BuffMarketHistory = factory(root.BuffHelperCommon);
})(typeof self !== "undefined" ? self : globalThis, function (C) {
  const MAX_BYTES = 20 * 1024 * 1024;
  const MAX_ROWS = 100000;
  const MAX_CENTS = 100000000000;
  const TYPE_NAMES = { purchase: "购买", sale: "出售" };
  const PLATFORM_NAMES = { steam: "Steam", buff: "BUFF", other: "其他" };
  function parseDate(value) {
    const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(String(value).trim());
    if (!match) throw new Error("日期需要 YYYY/MM/DD 或 YYYY-MM-DD 格式");
    const [, y, m, d] = match.map(Number), date = new Date(Date.UTC(y, m - 1, d));
    if (y < 1970 || y > 9999 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw new Error("日期不存在或超出范围");
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  function monthRange(now = new Date(), offset = 0) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).formatToParts(now);
    const year = Number(parts.find(p => p.type === "year").value), month = Number(parts.find(p => p.type === "month").value);
    const start = new Date(Date.UTC(year, month - 1 + offset, 1)), end = new Date(Date.UTC(year, month + offset, 0));
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  // RFC 4180 fields, including quoted commas/newlines and escaped double quotes.
  // Keep physical source line numbers so invalid rows can be found in the original file.
  function parseCsv(text) {
    if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_BYTES) throw new Error("CSV 文件最多 20 MB");
    const source = text.replace(/^\uFEFF/, "");
    if (source.includes("\u0000") || source.includes("\uFFFD")) throw new Error("无法识别文件编码，请导出 UTF-8 格式的 CSV");
    const rows = [];
    let cells = [], value = "", quoted = false, closed = false, line = 1, rowLine = 1, legacyQuotes = 0;
    function field() { cells.push(value); value = ""; closed = false; }
    function row() {
      field();
      if (cells.some(cell => cell.trim() !== "")) rows.push({ cells, sourceRow: rowLine });
      if (rows.length > MAX_ROWS + 1) throw new Error("CSV 最多支持 100,000 条交易记录");
      cells = [];
    }
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (char === '"') {
          if (source[i + 1] === '"') { value += '"'; i++; }
          else if (i + 1 === source.length || /[,\r\n]/.test(source[i + 1])) { quoted = false; closed = true; }
          // Older Steam exporters wrapped every field without escaping internal quotes.
          // Retain those literal quotes; field count and record validation still apply.
          else { value += '"'; legacyQuotes++; }
        } else {
          value += char;
          if (char === "\n" || char === "\r" && source[i + 1] !== "\n") line++;
        }
      } else if (char === ",") field();
      else if (char === "\n" || char === "\r") {
        row(); if (char === "\r" && source[i + 1] === "\n") i++;
        rowLine = ++line;
      } else if (char === '"') {
        if (value !== "" || closed) throw new Error(`CSV 第 ${line} 行引号位置无效`);
        quoted = true;
      } else {
        if (closed) throw new Error(`CSV 第 ${line} 行引号后应为逗号或换行`);
        value += char;
      }
    }
    if (quoted) throw new Error(`CSV 第 ${rowLine} 行引号未闭合`);
    if (cells.length || value !== "" || closed) row();
    rows.legacyQuotes = legacyQuotes;
    return rows;
  }
  function currencyOf(display) {
    const token = display.replace(/[\d\s.,+-]/g, "");
    if (!token || token.length > 20) throw new Error("Display Price 缺少可识别的币种标记");
    // Keep ambiguous symbols distinct; never convert or combine currencies.
    const known = { "¥": "CNY", "￥": "CNY", "CN¥": "CNY", "CNY": "CNY", "RMB": "CNY", "US$": "USD", "USD": "USD", "€": "EUR", "EUR": "EUR", "£": "GBP", "GBP": "GBP" };
    return known[token] || token;
  }
  function inspectCsv(text) {
    const source = parseCsv(text), header = source[0];
    if (!header) throw new Error("CSV 是空文件");
    const headers = header.cells.map(value => value.trim());
    if (headers.some(value => !value) || new Set(headers).size !== headers.length) throw new Error("CSV 列名不能为空或重复");
    const steam = ["App Id", "Acted On", "Price in Cents", "Display Price", "Type"].every(key => headers.includes(key)) && ["Market Name", "Item Name"].some(key => headers.includes(key));
    return { headers, source, steam, sample: source[1]?.cells || [] };
  }
  function normalizedGame(value) {
    const name = String(value || "其他").trim(), token = name.toLowerCase().replace(/[\s:_-]/g, "");
    if (["730", "cs", "cs2", "csgo", "cs/go", "counterstrike2", "counterstrikeglobaloffensive", "反恐精英2", "反恐精英：全球攻势"].includes(token)) return { appid: "730", gameName: "CS2" };
    if (["570", "dota", "dota2", "刀塔2"].includes(token)) return { appid: "570", gameName: "Dota 2" };
    if (/^\d+$/.test(name) && Number.isSafeInteger(Number(name)) && Number(name) > 0) return { appid: String(Number(name)), gameName: name === "753" ? "Steam 社区物品" : `应用 ${Number(name)}` };
    if (name.length > 200) throw new Error("游戏名称超过 200 字符");
    return { appid: `other:${name === "other" ? "其他" : name}`, gameName: name === "other" ? "其他" : name };
  }
  function normalizedPlatform(value) {
    const name = String(value || "其他").trim();
    if (name.length > 100) throw new Error("来源平台名称超过 100 字符");
    const platform = /^(steam|steam社区市场)$/i.test(name) ? "steam" : /^(buff|buff163|buff\.163\.com|网易buff)$/i.test(name) ? "buff" : "other";
    return { platform, platformName: platform === "other" && !/^(other|其他)$/i.test(name) ? name : PLATFORM_NAMES[platform] };
  }
  function normalizedType(value) {
    const type = String(value).trim().toLowerCase();
    if (["purchase", "buy", "购买", "买入", "购入"].includes(type)) return "purchase";
    if (["sale", "sell", "出售", "卖出"].includes(type)) return "sale";
    throw new Error("交易类型需为购买 / 出售（purchase / sale、buy / sell）");
  }
  function parseMoney(value, unit) {
    const raw = String(value).trim().replace(/^(?:CNY|RMB|USD|EUR|GBP|CN¥|US\$|[¥￥$€£])\s*/i, "");
    const pattern = unit === "cents" ? /^\d+$/ : /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;
    if (!pattern.test(raw)) throw new Error(unit === "cents" ? "金额应为非负整数分" : "金额应为非负数，最多两位小数；请核对元 / 分设置");
    const [whole, fraction = ""] = raw.replace(/,/g, "").split(".");
    const cents = unit === "cents" ? Number(whole) : Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) throw new Error("金额超出支持范围");
    return cents;
  }
  function mappedDate(value) {
    // Preserve the calendar date written in the file; never shift it via UTC parsing.
    const match = /^(\d{4}[-/]\d{1,2}[-/]\d{1,2})(?:[ T](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(String(value).trim());
    if (!match) throw new Error("成交日期需要 YYYY-MM-DD，可附带时分秒");
    return parseDate(match[1]);
  }
  function parseImport(text, fileName = "交易清单.csv", mapping) {
    const { source, headers, steam } = inspectCsv(text);
    if (!steam && !mapping) throw Object.assign(new Error("请先设置 CSV 列对应关系"), { code: "NEEDS_MAPPING" });
    if (mapping) {
      for (const key of ["date", "name", "price"]) if (!mapping.columns?.[key]) throw new Error("请指定成交日期、物品名称和金额列");
      for (const name of Object.values(mapping.columns || {})) if (name && !headers.includes(name)) throw new Error(`清单中不存在列：${name}`);
      if (!["major", "cents"].includes(mapping.unit) || !["unit", "total"].includes(mapping.priceMode)) throw new Error("请选择金额单位与单价 / 总额含义");
    }
    const rows = source.slice(1).map(({ cells, sourceRow }) => {
      try {
        if (cells.length !== headers.length) throw new Error("列数与表头不一致");
        const raw = Object.fromEntries(headers.map((key, i) => [key, cells[i].trim()]));
        let row;
        if (!mapping) {
          const appid = raw["App Id"];
          if (!/^\d+$/.test(appid) || !Number.isSafeInteger(Number(appid)) || Number(appid) <= 0) throw new Error("App Id 应为正整数");
          if (!/^\d+$/.test(raw["Price in Cents"])) throw new Error("Price in Cents 应为非负整数分");
          row = { ...normalizedPlatform("steam"), ...normalizedGame(appid), sourceRow, type: normalizedType(raw.Type), marketHashName: raw["Market Name"] || raw["Item Name"], itemName: raw["Item Name"] || raw["Market Name"],
            // SIH / CSGO Trader export the price displayed in personal market history:
            // the buyer's wallet debit or seller's wallet credit, with no further fee conversion.
            sourceFormat: "steam-market-history", amountSemantics: "actual",
            date: parseDate(raw["Acted On"]), listedDate: raw["Listed On"] ? parseDate(raw["Listed On"]) : "", quantity: 1, priceMode: "unit",
            priceCents: parseMoney(raw["Price in Cents"], "cents"), currency: currencyOf(raw["Display Price"]), assetId: raw["Asset Id"] || "", orderId: raw["Order Id"] || "", sourceTime: raw["Acted On"] };
          if (raw["Game Name"] && !["570", "730"].includes(row.appid)) row.gameName = raw["Game Name"];
        } else {
          const value = key => mapping.columns[key] ? raw[mapping.columns[key]] : "";
          const quantity = mapping.columns.quantity ? value("quantity") : "1";
          if (!/^\d+$/.test(quantity) || Number(quantity) < 1 || Number(quantity) > 1000000) throw new Error("数量需为 1 至 1,000,000 的整数");
          for (const key of ["date", "name", "price", "game", "type", "platform", "currency"]) if (mapping.columns[key] && !value(key)) throw new Error(`${mapping.columns[key]} 不能为空`);
          row = { ...normalizedPlatform(value("platform") || mapping.platform), ...normalizedGame(value("game") || mapping.game), sourceRow,
            type: normalizedType(value("type") || mapping.type), marketHashName: value("marketName") || value("name"), itemName: value("name"),
            date: mappedDate(value("date")), listedDate: "", quantity: Number(quantity), priceMode: mapping.priceMode,
            priceCents: parseMoney(value("price"), mapping.unit), currency: currencyOf(value("currency") || mapping.currency || "CNY"), assetId: value("assetId"), orderId: value("orderId"), sourceTime: value("date") };
        }
        if (!row.marketHashName || row.marketHashName.length > 500 || row.itemName.length > 500) throw new Error("物品名称缺失或超过 500 字符");
        row.totalCents = row.priceCents * (row.priceMode === "unit" ? row.quantity : 1);
        if (!Number.isSafeInteger(row.totalCents)) throw new Error("金额乘数量超出安全计算范围");
        return row;
      } catch (error) { throw new Error(`CSV 第 ${sourceRow} 行：${error.message}`); }
    });
    if (!rows.length) throw new Error("CSV 中没有交易记录");
    const dates = rows.map(row => row.date).sort();
    return { fileName, rows, start: dates[0], end: dates.at(-1), importedAt: Date.now(), legacyQuotes: source.legacyQuotes };
  }
  function itemName(row, catalog = {}) {
    const entry = catalog.items?.[`${row.appid}:${row.marketHashName}`];
    if (entry?.conflict && !entry.custom) return { name: row.marketHashName, status: "映射冲突", source: "发现多个中文名称，请在名称映射中核对", url: "", checkedAt: entry.checkedAt || "" };
    if (entry && typeof entry.name === "string" && /[\u3400-\u9fff]/.test(entry.name)) return { name: entry.name, status: entry.custom ? "手动核对" : "已核对", source: entry.source || (entry.custom ? "本机手动核对" : "Steam 简体中文市场名称"), url: entry.url || "", checkedAt: entry.checkedAt || "" };
    if (/[\u3400-\u9fff]/.test(row.itemName)) return { name: row.itemName, status: "清单中文名", source: "CSV 原始物品名称", url: "", checkedAt: "" };
    return { name: row.marketHashName, status: "待核对", source: "尚未收录中文名称，保留英文原名", url: "", checkedAt: "" };
  }
  function groupKey(row) { return JSON.stringify([row.scope || "", row.platformName, row.appid, row.marketHashName, row.currency, row.type]); }
  function analyze(dataset, filters = {}, catalog = {}) {
    const start = filters.start ? parseDate(filters.start) : "", end = filters.end ? parseDate(filters.end) : "";
    if (start && end && start > end) throw new Error("开始日期不能晚于结束日期");
    const search = String(filters.search || "").trim().toLocaleLowerCase(), groups = new Map(), amounts = new Map();
    const rows = [];
    for (const row of dataset.rows) {
      if (filters.scope && filters.scope !== "all" && row.scope !== filters.scope) continue;
      if (start && row.date < start || end && row.date > end) continue;
      if (filters.game === "other" ? ["570", "730"].includes(row.appid) : filters.game && filters.game !== "all" && row.appid !== filters.game) continue;
      if (filters.platform && filters.platform !== "all" && row.platform !== filters.platform) continue;
      if (filters.type && filters.type !== "all" && row.type !== filters.type) continue;
      if (filters.currency && filters.currency !== "all" && row.currency !== filters.currency) continue;
      const localized = itemName(row, catalog);
      if (search && ![row.marketHashName, row.itemName, localized.name].some(value => value.toLocaleLowerCase().includes(search))) continue;
      if (filters.unverified && !["待核对", "映射冲突"].includes(localized.status)) continue;
      const named = { ...row, localized };
      rows.push(named);
      const key = groupKey(row);
      let group = groups.get(key);
      const unitCents = row.totalCents / row.quantity;
      if (!group) { group = { ...named, key, quantity: 0, records: 0, totalCents: 0, minCents: unitCents, maxCents: unitCents, firstDate: row.date, lastDate: row.date }; groups.set(key, group); }
      group.quantity += row.quantity; group.records++; group.totalCents += row.totalCents;
      group.minCents = Math.min(group.minCents, unitCents); group.maxCents = Math.max(group.maxCents, unitCents);
      if (row.date < group.firstDate) group.firstDate = row.date;
      if (row.date > group.lastDate) group.lastDate = row.date;
      const total = amounts.get(row.currency) || { currency: row.currency, purchaseCents: 0, saleCents: 0 };
      total[row.type === "purchase" ? "purchaseCents" : "saleCents"] += row.totalCents;
      if (!Number.isSafeInteger(group.totalCents) || !Number.isSafeInteger(total.purchaseCents + total.saleCents)) throw new Error("汇总金额超过安全计算范围，请缩小日期范围");
      amounts.set(row.currency, total);
    }
    const items = [...groups.values()].map(group => ({ ...group, averageCents: group.totalCents / group.quantity }));
    const compareName = (a, b) => a.localized.name.localeCompare(b.localized.name, "zh-CN") || a.key.localeCompare(b.key);
    const sort = { total: (a, b) => b.totalCents - a.totalCents, quantity: (a, b) => b.quantity - a.quantity, average: (a, b) => b.averageCents - a.averageCents, date: (a, b) => b.lastDate.localeCompare(a.lastDate), name: compareName }[filters.sort || "total"];
    if (!sort) throw new Error("不支持的排序方式");
    items.sort((a, b) => sort(a, b) || compareName(a, b));
    rows.sort((a, b) => b.date.localeCompare(a.date) || a.sourceRow - b.sourceRow);
    return { rows, items, amounts: [...amounts.values()], quantity: rows.length, units: items.reduce((sum, row) => sum + row.quantity, 0), repeated: items.filter(row => row.quantity > 1).length, unverified: items.filter(row => ["待核对", "映射冲突"].includes(row.localized.status)).length };
  }
  function roundedAverageCents(total, count) {
    return Number((BigInt(total) * 2n + BigInt(count)) / (2n * BigInt(count)));
  }
  function money(cents, currency = "CNY") {
    return /^[A-Z]{3}$/.test(currency) ? C.formatCents(cents, currency) : `${currency} ${(cents / 100).toFixed(2)}`;
  }
  function csvCell(value) {
    let text = String(value ?? "");
    if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  }
  function exportCsv(result, kind = "summary") {
    let rows;
    if (kind === "summary") {
      rows = [["中文名称", "原始市场名称", "名称核对状态", "来源平台", "游戏", "游戏标识", "交易类型", "币种", "数量", "平均单价", "总金额", "最低单价", "最高单价", "首次成交日期", "末次成交日期", "中文名来源"]];
      for (const item of result.items) rows.push([item.localized.name, item.marketHashName, item.localized.status, item.platformName, item.gameName, item.appid, TYPE_NAMES[item.type], item.currency, item.quantity, (roundedAverageCents(item.totalCents, item.quantity) / 100).toFixed(2), (item.totalCents / 100).toFixed(2), (Math.round(item.minCents) / 100).toFixed(2), (Math.round(item.maxCents) / 100).toFixed(2), item.firstDate, item.lastDate, item.localized.url || item.localized.source]);
    } else if (kind === "details") {
      rows = [["成交日期", "中文名称", "原始市场名称", "名称核对状态", "来源平台", "游戏", "游戏标识", "交易类型", "币种", "数量", "成交总金额", "原始金额（分）", "原始金额含义", "上架日期", "原清单行号", "资产 ID"]];
      for (const item of result.rows) rows.push([item.date, item.localized.name, item.marketHashName, item.localized.status, item.platformName, item.gameName, item.appid, TYPE_NAMES[item.type], item.currency, item.quantity, (item.totalCents / 100).toFixed(2), item.priceCents, item.priceMode === "unit" ? "单价" : "行总额", item.listedDate, item.sourceRow, item.assetId]);
    } else throw new Error("不支持的导出类型");
    return "\uFEFF" + rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }
  return { MAX_BYTES, MAX_ROWS, TYPE_NAMES, PLATFORM_NAMES, parseDate, monthRange, parseCsv, inspectCsv, parseImport, itemName, groupKey, analyze, money, roundedAverageCents, exportCsv };
});
