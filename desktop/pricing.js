/* Local quote analysis. Shares the extension's cent/fee/portfolio calculations. No network or orders. */
(function (root, factory) {
  const common = typeof module === "object" && module.exports ? require("../common.js") : root.BuffHelperCommon;
  const api = factory(common);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BuffDesktopPricing = api;
})(typeof self === "undefined" ? globalThis : self, common => {
  "use strict";
  const TTL = 15 * 60000, BUY_TTL = 5 * 60000, MAX_ROWS = 500;
  const DEFAULTS = { buffCsgoSellFeePercent: 2.5, buffDota2SellFeePercent: 2.5, maxKnifeRatio: 0.75, minLiquidity: 1, maxBuffPriceCents: 0, fundingDiscount: null, targetCashoutRatio: 0.8 };
  const key = row => common.buildPriceKey(row.appid, row.marketHashName, row.currencyCode);
  function integer(value, label, { optional = false, min = 0, max = 1000000000 } = {}) {
    if (optional && (value == null || value === "")) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}必须是 ${min}～${max} 范围内的整数`);
    return value;
  }
  function cents(value, optional = false) {
    const text = String(value ?? "").trim();
    if (optional && !text) return null;
    if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(text)) throw new Error("金额须为人民币元，最多两位小数");
    const [whole, part = ""] = text.split(".");
    return integer(Number(whole) * 100 + Number(part.padEnd(2, "0")), "金额（分）", { min: 1 });
  }
  function timestamp(value) {
    if (value == null || value === "") return null;
    const time = typeof value === "number" ? value : typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
    if (!Number.isSafeInteger(time) || time <= 0 || time > 8640000000000000) throw new Error("报价时间应为毫秒时间戳或含时区的 ISO 时间");
    return time;
  }
  function normalizeSettings(input = {}) {
    const result = { ...DEFAULTS };
    for (const [name, max] of Object.entries({ buffCsgoSellFeePercent: 100, buffDota2SellFeePercent: 100, maxKnifeRatio: 10, minLiquidity: 100000000, maxBuffPriceCents: 1000000000, fundingDiscount: 10, targetCashoutRatio: 10 })) {
      if (!Object.hasOwn(input, name)) continue;
      const value = input[name];
      if (name === "fundingDiscount" && value == null) { result[name] = null; continue; }
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) throw new Error("手续费、折扣或筛选门槛无效");
      result[name] = name.includes("FeePercent") ? Math.round(value * 100) / 100 : value;
    }
    integer(result.maxBuffPriceCents, "最高 BUFF 价");
    return result;
  }
  function normalizeRow(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("每条报价必须是对象");
    const appid = Number(input.appid);
    if (![730, 570].includes(appid)) throw new Error("游戏 appid 仅支持 730 或 570");
    const marketHashName = String(input.marketHashName ?? "").trim();
    if (!marketHashName || marketHashName.length > 300) throw new Error("需要完整物品名称 marketHashName（最多 300 字）");
    const currencyCode = common.normalizeCurrencyCode(input.currencyCode || "CNY");
    if (!/^[A-Z]{3}$/.test(currencyCode)) throw new Error("币种代码无效");
    const goodsId = String(input.goodsId ?? "");
    if (goodsId && !/^\d{1,30}$/.test(goodsId)) throw new Error("BUFF 商品 ID 应为数字");
    const result = { appid, marketHashName, name: String(input.name || marketHashName).slice(0, 300), currencyCode, goodsId, source: input.source === "manual" ? "manual" : input.source === "example" ? "example" : input.source === "ledger" ? "ledger" : "import", selected: input.selected === true, quantity: integer(input.quantity ?? 1, "模拟数量", { min: 1, max: 10000 }) };
    for (const field of ["buffPriceCents", "buffBuyPriceCents", "steamLowestSellCents", "steamHighestBuyCents", "uuNetSellCents"]) result[field] = integer(input[field], field, { optional: true, min: 1 });
    for (const field of ["steamVolume24h", "steamVolume7d"]) result[field] = integer(input[field], field, { optional: true });
    for (const field of ["buffUpdatedAt", "buffBuyUpdatedAt", "buffBuyExpiresAt", "steamUpdatedAt", "steamExpiresAt", "steamVolumeCheckedAt", "uuUpdatedAt"]) result[field] = timestamp(input[field]);
    // Legacy market history has a separate Steam timestamp and uses updatedAt for BUFF.
    if (result.buffUpdatedAt == null) result.buffUpdatedAt = timestamp(input.updatedAt);
    result.buffBuyError = input.buffBuyError ? String(input.buffBuyError).slice(0, 200) : "";
    result.steamError = input.steamError ? String(input.steamError).slice(0, 200) : "";
    result.steamCurrencyInvalid = input.steamCurrencyInvalid === true || !!input.priceoverview?.lowest_price && common.parseCnyPriceTextToCents(input.priceoverview.lowest_price) == null;
    result.key = key(result);
    return result;
  }
  function normalizeRows(input) {
    if (!Array.isArray(input) || input.length > MAX_ROWS) throw new Error(`单次最多 ${MAX_ROWS} 条报价`);
    return input.map((row, index) => {
      try { return normalizeRow(row); } catch (error) { throw new Error(`第 ${index + 1} 条：${error.message}`); }
    });
  }
  function mergeRows(existing, incoming) {
    const rows = new Map(normalizeRows(existing).map(row => [row.key, row]));
    for (const next of normalizeRows(incoming)) {
      const old = rows.get(next.key);
      if (!old) { rows.set(next.key, next); continue; }
      if (old.goodsId && next.goodsId && old.goodsId !== next.goodsId) throw new Error(`物品 ${next.marketHashName} 的 BUFF ID 不一致`);
      const combined = { ...old, goodsId: next.goodsId || old.goodsId };
      const groups = [
        ["buffUpdatedAt", "buffPriceCents"],
        ["buffBuyUpdatedAt", "buffBuyPriceCents", "buffBuyExpiresAt", "buffBuyError"],
        ["steamUpdatedAt", "steamLowestSellCents", "steamHighestBuyCents", "steamExpiresAt", "steamError", "steamCurrencyInvalid"],
        ["steamVolumeCheckedAt", "steamVolume24h", "steamVolume7d"],
        ["uuUpdatedAt", "uuNetSellCents"],
      ];
      for (const [time, ...fields] of groups) {
        if (next[time] != null && (old[time] == null || next[time] >= old[time]) || old[time] == null && next[time] == null && fields.some(field => old[field] == null && next[field] != null)) {
          for (const field of [time, ...fields]) combined[field] = next[field];
        }
      }
      // Imported quote updates never change the user's simulated basket selection or quantity.
      combined.source = old.source === next.source ? old.source : "import";
      rows.set(next.key, combined);
    }
    if (rows.size > MAX_ROWS) throw new Error(`本机最多保存 ${MAX_ROWS} 件物品，请先移除不用的报价`);
    return [...rows.values()];
  }
  function expiry(at, declared, ttl = TTL) { return at == null ? 0 : Math.min(at + ttl, declared ?? Infinity); }
  function analyzeRow(raw, settings = DEFAULTS, now = Date.now()) {
    const row = normalizeRow(raw), config = normalizeSettings(settings);
    const item = { appid: row.appid, marketHashName: row.marketHashName, goodsId: row.goodsId, currencyCode: row.currencyCode, priceCents: row.buffPriceCents, readAt: row.buffUpdatedAt };
    const quote = { appid: row.appid, marketHashName: row.marketHashName, currencyCode: row.steamCurrencyInvalid ? "UNKNOWN" : row.currencyCode,
      lowestSellCents: row.steamError || !common.calculateSteamFees(row.steamLowestSellCents) ? null : row.steamLowestSellCents, highestBuyCents: row.steamHighestBuyCents,
      updatedAt: row.steamUpdatedAt, expiresAt: expiry(row.steamUpdatedAt, row.steamExpiresAt),
      buffBuyQuote: { appid: row.appid, goodsId: row.goodsId, marketHashName: row.marketHashName, priceCents: row.currencyCode === "CNY" ? row.buffBuyPriceCents : null,
        checkedAt: row.buffBuyUpdatedAt, expiresAt: expiry(row.buffBuyUpdatedAt, row.buffBuyExpiresAt, BUY_TTL), error: row.buffBuyError },
    };
    const query = common.calculateItemQuery({ item, quote }, config, now);
    const ratios = query.ratios;
    const ready = ratios.knifeRatio != null;
    const volumeFresh = row.steamVolumeCheckedAt != null && row.steamVolumeCheckedAt <= now && row.steamVolumeCheckedAt + TTL > now;
    const liquidityCoefficient = volumeFresh && row.steamVolume24h != null ? row.steamVolume24h / 10 : null;
    const candidate = ready && liquidityCoefficient != null && ratios.knifeRatio <= config.maxKnifeRatio && liquidityCoefficient >= config.minLiquidity && (!config.maxBuffPriceCents || row.buffPriceCents <= config.maxBuffPriceCents);
    const issues = [];
    if (row.currencyCode !== "CNY" || row.steamCurrencyInvalid) issues.push("币种不符");
    if (row.buffPriceCents == null || row.steamLowestSellCents == null) issues.push("缺少报价");
    if (row.steamLowestSellCents != null && !common.calculateSteamFees(row.steamLowestSellCents)) issues.push("Steam 金额低于最低费用");
    if (row.buffUpdatedAt == null || row.steamUpdatedAt == null) issues.push("缺少报价时间");
    else if (row.buffUpdatedAt > now || row.steamUpdatedAt > now) issues.push("报价时间晚于当前");
    else if (query.buffExpired || query.steamExpired) issues.push("报价已过期");
    if (row.steamError) issues.push("Steam 报价错误");
    const cashoutCostCents = config.fundingDiscount != null && ratios.steamBuyPriceCents != null ? Math.round(ratios.steamBuyPriceCents * config.fundingDiscount) : null;
    const cashoutProfitCents = cashoutCostCents != null && ratios.buffNetSellCents != null ? ratios.buffNetSellCents - cashoutCostCents : null;
    const steamBidNetCents = !query.steamExpired && query.steamCurrencyValid && !row.steamError ? common.calculateSteamFees(row.steamHighestBuyCents)?.netCents ?? null : null;
    return { ...row, ...ratios, query, ready, issues, candidate, volumeFresh, liquidityCoefficient, cashoutCostCents, cashoutProfitCents, steamBidNetCents,
      instantKnifeRatio: !query.buffExpired && query.buffPriceCents != null && steamBidNetCents > 0 ? query.buffPriceCents / steamBidNetCents : null,
      updatedAt: Math.max(row.buffUpdatedAt || 0, row.steamUpdatedAt || 0) };
  }
  function filterRows(rows, { search = "", scope = "all", candidatesOnly = false, sortBy = "knifeRatio", direction = "asc" } = {}) {
    const needle = search.trim().toLocaleLowerCase();
    const allowed = ["knifeRatio", "cashoutRatio", "buyOrderCashoutRatio", "buffPriceCents", "steamVolume24h", "steamVolume7d", "liquidityCoefficient", "cashoutProfitCents", "updatedAt"];
    if (!allowed.includes(sortBy)) sortBy = "knifeRatio";
    return rows.filter(row => (!needle || `${row.name} ${row.marketHashName}`.toLocaleLowerCase().includes(needle)) &&
      (scope === "all" || scope === "730" && row.appid === 730 || scope === "570" && row.appid === 570 || scope === "cases" && row.appid === 730 && common.isWeaponCaseItem(row)) && (!candidatesOnly || row.candidate))
      .sort((a, b) => {
        const av = a[sortBy], bv = b[sortBy], aMissing = av == null || !Number.isFinite(av), bMissing = bv == null || !Number.isFinite(bv);
        if (aMissing !== bMissing) return aMissing ? 1 : -1;
        return !aMissing && av !== bv ? (av - bv) * (direction === "desc" ? -1 : 1) : b.updatedAt - a.updatedAt;
      });
  }
  function portfolio(rows, now = Date.now()) {
    const selected = rows.filter(row => row.selected);
    const purchases = selected.map(row => ({ appid: row.appid, marketHashName: row.marketHashName, currencyCode: row.currencyCode,
      quantity: row.quantity, buyPriceCents: row.query.buffExpired ? null : row.buffPriceCents }));
    const prices = selected.map(row => ({ key: common.buildPriceKey(row.appid, row.marketHashName, row.currencyCode), appid: row.appid, marketHashName: row.marketHashName,
      currencyCode: row.currencyCode, lowestSellCents: row.steamLowestSellCents, error: !row.ready, updatedAt: row.steamUpdatedAt,
      expiresAt: expiry(row.steamUpdatedAt, row.steamExpiresAt) }));
    return common.calculatePurchasePortfolio(purchases, prices, now);
  }
  // Resolve each platform independently; reading holdings never renews quote timestamps.
  function holdingQuote(holding, rows = []) {
    const cached = normalizeRow({ appid: holding.appid, marketHashName: holding.marketHashName,
      name: holding.name, goodsId: holding.goodsId, currencyCode: holding.currencyCode || "CNY", source: "ledger",
      buffPriceCents: holding.quote?.buffPriceCents, steamLowestSellCents: holding.quote?.steamPriceCents,
      buffUpdatedAt: holding.quote?.buffObservedAt, steamUpdatedAt: holding.quote?.steamObservedAt });
    const matching = rows.filter(row => row.source !== "example" && key(row) === cached.key);
    return mergeRows([cached], matching)[0];
  }
  function compareHolding(holding, rows = [], settings = DEFAULTS, now = Date.now()) {
    const config = normalizeSettings(settings), quantity = holding.remainingQuantity;
    const eligible = holding.confirmed === true && Number.isSafeInteger(quantity) && quantity > 0;
    const cost = eligible && Number.isSafeInteger(holding.inventoryCostCents) && holding.inventoryCostCents >= 0 ? holding.inventoryCostCents : null;
    let quote = null, quoteError = "";
    try { quote = analyzeRow(holdingQuote(holding, rows), config, now); }
    catch (error) { quoteError = error.message; }
    const reason = (price, at, end, error, currencyValid = true) => {
      if (!eligible) return "非已确认持仓";
      if (quoteError) return quoteError;
      if (quote?.currencyCode !== "CNY" || !currencyValid) return "币种不符";
      if (error) return "报价错误";
      if (price == null) return "缺少报价";
      if (at == null) return "缺少报价时间";
      if (at > now) return "报价时间晚于当前";
      if (end <= now) return "报价已过期";
      return "";
    };
    const issues = {
      buffAsk: reason(quote?.buffPriceCents, quote?.buffUpdatedAt, expiry(quote?.buffUpdatedAt)),
      buffBid: reason(quote?.buffBuyPriceCents, quote?.buffBuyUpdatedAt, expiry(quote?.buffBuyUpdatedAt, quote?.buffBuyExpiresAt, BUY_TTL), quote?.buffBuyError),
      steam: reason(quote?.steamLowestSellCents, quote?.steamUpdatedAt, expiry(quote?.steamUpdatedAt, quote?.steamExpiresAt), quote?.steamError, !quote?.steamCurrencyInvalid),
    };
    if (!issues.steam && quote.steamNetSellCents == null) issues.steam = "Steam 金额低于最低费用";
    const total = (unit, issue) => !issue && Number.isSafeInteger(unit) && Number.isSafeInteger(unit * quantity) ? unit * quantity : null;
    const steamNetCents = total(quote?.steamNetSellCents, issues.steam);
    const scenario = steamNetCents > 0 ? common.calculateCashoutScenario({ complete: true, totalNetCents: steamNetCents, totalSpentCents: cost ?? 0 }, config.targetCashoutRatio) : null;
    const route = (id, label, proceedsCents, issue) => ({ id, label, proceedsCents,
      profitCents: proceedsCents != null && cost != null ? proceedsCents - cost : null,
      issue: issue || (proceedsCents == null ? "金额超出计算范围" : cost == null ? "实际现金成本缺失或无效" : "") });
    const routes = [route("buffAsk", "BUFF 挂售", total(quote?.buffNetSellCents, issues.buffAsk), issues.buffAsk),
      route("buffBid", "BUFF 求购", total(quote?.buffBuyNetCents, issues.buffBid), issues.buffBid),
      route("steam", "Steam 再提现", scenario?.proceedsCents ?? null, issues.steam)];
    // UU is an explicitly observed net receipt, so do not guess a fee rate or
    // subtract fees a second time. Missing UU quotes do not affect legacy routes.
    if (quote?.uuNetSellCents != null) {
      const issue = reason(quote.uuNetSellCents, quote.uuUpdatedAt, expiry(quote.uuUpdatedAt));
      routes.push(route("uu", "悠悠净到账", total(quote.uuNetSellCents, issue), issue));
    }
    const available = routes.filter(row => row.profitCents != null);
    const bestProfitCents = available.length ? Math.max(...available.map(row => row.profitCents)) : null;
    const bestRoutes = available.filter(row => row.profitCents === bestProfitCents).map(row => row.id);
    const next = available.filter(row => row.profitCents < bestProfitCents);
    const threshold = target => steamNetCents > 0 && Number.isSafeInteger(target) ? target / steamNetCents : null;
    return { holding, quantity, costCents: cost, quote, quoteError, steamNetCents, routes,
      breakEvenCashoutRatio: threshold(cost),
      // A strict improvement means one extra cent for the entire remaining lot.
      beatBuffAskCashoutRatio: threshold(routes[0].proceedsCents == null ? null : routes[0].proceedsCents + 1),
      beatBuffBidCashoutRatio: threshold(routes[1].proceedsCents == null ? null : routes[1].proceedsCents + 1),
      bestRoutes, bestProfitCents, complete: available.length === routes.length,
      advantageCents: bestRoutes.length === 1 && next.length ? bestProfitCents - Math.max(...next.map(row => row.profitCents)) : null };
  }
  function parseCsv(text) {
    const rows = []; let row = [], value = "", quoted = false, closed = false;
    for (let i = 0; i <= text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === undefined) throw new Error("CSV 引号未闭合");
        if (c === '"') { if (text[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; } }
        else value += c;
      } else if (c === '"' && !value && !closed) quoted = true;
      else if (c === "," || c === "\n" || c === undefined) {
        row.push(value.replace(/\r$/, "")); value = ""; closed = false;
        if (c !== ",") { if (row.some(cell => cell.trim())) rows.push(row); row = []; }
      } else if (closed && c !== "\r" || c === '"') throw new Error("CSV 引号格式无效");
      else value += c;
    }
    const headers = (rows.shift() || []).map(value => value.trim());
    if (!headers.includes("appid") || !headers.includes("marketHashName") || new Set(headers).size !== headers.length) throw new Error("CSV 需要 appid、marketHashName 且列名不能重复");
    return rows.map((cells, index) => {
      if (cells.length !== headers.length) throw new Error(`CSV 第 ${index + 2} 行列数不一致`);
      const entry = Object.fromEntries(headers.map((header, i) => [header, cells[i].trim()]));
      for (const field of ["appid", "quantity", "buffPriceCents", "buffBuyPriceCents", "steamLowestSellCents", "steamHighestBuyCents", "steamVolume24h", "steamVolume7d"]) {
        if (entry[field] === "") delete entry[field];
        else if (Object.hasOwn(entry, field)) { if (!/^\d+$/.test(entry[field])) throw new Error(`CSV 第 ${index + 2} 行 ${field} 需要整数`); entry[field] = Number(entry[field]); }
      }
      for (const field of ["updatedAt", "buffUpdatedAt", "buffBuyUpdatedAt", "buffBuyExpiresAt", "steamUpdatedAt", "steamExpiresAt", "steamVolumeCheckedAt"]) if (/^\d+$/.test(entry[field] || "")) entry[field] = Number(entry[field]);
      return entry;
    });
  }
  function parseImport(text) {
    if (typeof text !== "string" || new TextEncoder().encode(text).length > 1024 * 1024) throw new Error("报价文件最多 1 MB");
    const clean = text.replace(/^\uFEFF/, "").trim();
    let rows;
    if (/^[\[{]/.test(clean)) {
      let parsed; try { parsed = JSON.parse(clean); } catch { throw new Error("JSON 格式无效"); }
      rows = Array.isArray(parsed) ? parsed : parsed.rows;
    } else rows = parseCsv(clean);
    const result = normalizeRows(rows);
    // The selection is a separate manual action, not part of an imported quote.
    return result.map(row => ({ ...row, selected: false, source: "import" }));
  }
  function examples(now = Date.now()) {
    return normalizeRows([
      { appid: 730, marketHashName: "示例 · CS2 武器箱", buffPriceCents: 5000, buffBuyPriceCents: 4900, steamLowestSellCents: 8000, steamHighestBuyCents: 7600, steamVolume24h: 240, steamVolume7d: 1680, quantity: 2 },
      { appid: 570, marketHashName: "示例 · Dota 2 物品", buffPriceCents: 3000, buffBuyPriceCents: 2800, steamLowestSellCents: 5000, steamVolume24h: 60, steamVolume7d: 420, quantity: 3 },
    ].map(row => ({ ...row, source: "example", currencyCode: "CNY", buffUpdatedAt: now, steamUpdatedAt: now, buffBuyUpdatedAt: now, steamVolumeCheckedAt: now })));
  }
  return { DEFAULTS, TTL, BUY_TTL, MAX_ROWS, cents, timestamp, normalizeSettings, normalizeRow, normalizeRows, mergeRows, analyzeRow, filterRows, portfolio, holdingQuote, compareHolding, parseImport, examples };
});
