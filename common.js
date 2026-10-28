(function () {
  const DEFAULT_SETTINGS = {
    steamCurrency: "CNY",
    refreshMinutes: 15,
    buffAccountLabel: "",
    steamAccountLabel: "",
    autoRecordPurchases: true,
    marketAnalysisEnabled: true,
    weaponCaseOnly: false,
    knifeModeEnabled: true,
    balanceModeEnabled: true,
    buffCsgoSellFeePercent: 2.5,
    buffDota2SellFeePercent: 2.5,
    maxMarketAnalysisItems: 80,
    autoBuffRefreshEnabled: false,
    buffRefreshMode: "pagination",
    buffRefreshIntervalSeconds: 60,
    buffPollIntervalSeconds: 5,
    buffPaginationReturnDelaySeconds: 2,
    buffPaginationBounce: false,
    autoAdvanceAfterAnalysis: true,
    buyAssistEnabled: false,
    buyAssistAutoOpenDetail: false,
    buyAssistMaxDiscountRatio: 0.75,
    buyAssistMinLiquidityCoefficient: 1,
    buyAssistMaxBuffPriceCents: 0,
    bargainEnabled: true,
    bargainMaxDiscountRatio: 0.6,
    bargainMinGapPercent: 10,
    bargainMinGapCents: 100,
    includeStatTrak: true,
    includeSouvenir: true,
    trackedTypes: {
      knife: true,
      hands: true,
      rifle: true,
      pistol: true,
      smg: true,
      shotgun: true,
      machinegun: true,
      sniper_rifle: true,
      sticker: true,
      container: true,
      other: true,
    },
    trackedWears: {
      factory_new: true,
      minimal_wear: true,
      field_tested: true,
      well_worn: true,
      battle_scarred: true,
      no_wear: true,
    },
  };

  const CURRENCY_CODE_TO_ID = {
    USD: 1,
    GBP: 2,
    EUR: 3,
    CHF: 4,
    RUB: 5,
    PLN: 6,
    BRL: 7,
    JPY: 8,
    NOK: 9,
    IDR: 10,
    MYR: 11,
    PHP: 12,
    SGD: 13,
    THB: 14,
    VND: 15,
    KRW: 16,
    TRY: 17,
    UAH: 18,
    MXN: 19,
    CAD: 20,
    AUD: 21,
    NZD: 22,
    CNY: 23,
    RMB: 23,
    INR: 24,
    CLP: 25,
    PEN: 26,
    COP: 27,
    ZAR: 28,
    HKD: 29,
    TWD: 30,
    SAR: 31,
  };

  const CURRENCY_SYMBOLS = {
    CNY: "¥",
    RMB: "¥",
    USD: "$",
    EUR: "€",
    GBP: "£",
    JPY: "¥",
    RUB: "₽",
    KRW: "₩",
    HKD: "HK$",
    TWD: "NT$",
  };

  function normalizeCurrencyCode(code) {
    if (!code) return "CNY";
    const upper = String(code).toUpperCase();
    return upper === "RMB" ? "CNY" : upper;
  }

  function currencyCodeToId(code) {
    return CURRENCY_CODE_TO_ID[normalizeCurrencyCode(code)] || 23;
  }

  function currencyCodeFromId(id) {
    const found = Object.entries(CURRENCY_CODE_TO_ID).find(([, value]) => value === Number(id));
    return found ? normalizeCurrencyCode(found[0]) : "CNY";
  }

  function formatCents(valueInCents, currencyCode = "CNY") {
    const code = normalizeCurrencyCode(currencyCode);
    const value = Number(valueInCents || 0) / 100;
    try {
      return new Intl.NumberFormat(code === "CNY" ? "zh-CN" : "en-US", {
        style: "currency",
        currency: code,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
    } catch (error) {
      const symbol = CURRENCY_SYMBOLS[code] || code;
      return `${symbol} ${value.toFixed(2)}`;
    }
  }

  function parseSteamVolume(value) {
    if (typeof value !== "number" && typeof value !== "string") return null;
    const text = String(value).trim().replace(/[,\s]/g, "");
    if (!/^\d+$/.test(text)) return null;
    const count = Number(text);
    return Number.isSafeInteger(count) ? count : null;
  }

  function formatSteamVolume(value) {
    const count = parseSteamVolume(value);
    return count == null ? "暂无数据" : `${count.toLocaleString("zh-CN")} 件`;
  }

  function getSteamVolumeTitle(row) {
    const source = row.steamVolumeSource === "history"
      ? "按 Steam 小时成交记录汇总近24小时及近7日（168小时），数据可能有延迟。"
      : row.steamVolume24h != null ? "24小时成交量来自 Steam 报价摘要。" : "Steam 成交量暂不可用。";
    const checked = row.steamVolumeCheckedAt
      ? `查询时间：${new Date(row.steamVolumeCheckedAt).toLocaleString("zh-CN")}`
      : "7日成交量尚未查询，重新计算后更新。";
    return [source, checked, row.steamVolumeError || ""].filter(Boolean).join("\n");
  }

  function parsePriceTextToCents(text, currencyCode = "CNY") {
    if (text == null) return null;
    const code = normalizeCurrencyCode(currencyCode);
    let value = String(text).trim();
    const symbol = CURRENCY_SYMBOLS[code];
    if (symbol) {
      value = value.replaceAll(symbol, "");
    }
    value = value.replace(/USD|CNY|RMB|EUR|GBP|JPY|RUB|KRW|HKD|TWD/gi, "");
    value = value.replace(/\s+/g, "");
    value = value.replace(/,/g, "");
    const match = value.match(/(-?\d+(?:\.\d{1,2})?)/);
    if (!match) return null;
    return Math.round(Number(match[1]) * 100);
  }

  // Manual amounts are decimal strings; never silently truncate sub-cent inputs.
  function parseCnyAmountToCents(value) {
    if (typeof value !== "string") return null;
    const match = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (!match) return null;
    const cents = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
    return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
  }

  function parseCnyPriceTextToCents(text) {
    // Require an explicit currency and exactly one amount, not a balance or a range.
    const match = String(text || "").trim().match(/^(?:(?:CNY|RMB|人民币|[¥￥])\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:CNY|RMB|人民币|元))$/i);
    if (!match) return null;
    const amount = match[1] || match[2];
    if (amount.includes(",") && !/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(amount)) return null;
    return parseCnyAmountToCents(amount.replaceAll(",", ""));
  }

  function encodeHashName(hashName) {
    try {
      return encodeURIComponent(decodeURIComponent(hashName));
    } catch (error) {
      return encodeURIComponent(hashName);
    }
  }

  function buildPriceKey(appid, marketHashName, currencyCode = "CNY") {
    return `${appid}|${normalizeCurrencyCode(currencyCode)}|${marketHashName}`;
  }

  const MARKET_GAMES = {
    csgo: { game: "csgo", appid: 730, label: "CS2" },
    dota2: { game: "dota2", appid: 570, label: "Dota 2" },
  };

  function getMarketGame(urlText) {
    try {
      const url = new URL(urlText, "https://buff.163.com/");
      const pathGame = url.pathname.match(/^\/market\/(csgo|dota2)(?:\/|$)/)?.[1];
      const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
      const game = pathGame || url.searchParams.get("game") || hash.get("game");
      return MARKET_GAMES[game] || null;
    } catch (error) {
      return null;
    }
  }

  function getBuffGoodsId(urlText) {
    try {
      const url = new URL(urlText);
      if (url.origin !== "https://buff.163.com" || url.username || url.password) return null;
      return url.pathname.match(/^\/goods\/([1-9]\d*)\/?$/)?.[1] || null;
    } catch {
      return null;
    }
  }

  function getSteamListingInfo(urlText) {
    try {
      const url = new URL(urlText);
      if (url.hostname !== "steamcommunity.com") return null;
      const match = url.pathname.match(/^\/market\/listings\/(\d+)\/(.+)$/);
      return match ? { appid: Number(match[1]), marketHashName: decodeURIComponent(match[2]) } : null;
    } catch (error) {
      return null;
    }
  }

  function resolveMarketAppId(item = {}, ...urls) {
    const info = item.goods_info || item.goodsInfo || {};
    const explicit = Number(item.appid || info.appid);
    if (Number.isInteger(explicit) && explicit > 0) return explicit;
    const listing = getSteamListingInfo(item.steam_market_url || info.steam_market_url);
    if (listing) return listing.appid;
    const game = MARKET_GAMES[item.game || info.game] || urls.map(getMarketGame).find(Boolean);
    return game?.appid || 730;
  }

  function marketGameLabel(appid) {
    return Object.values(MARKET_GAMES).find((game) => game.appid === Number(appid))?.label || `Steam ${appid}`;
  }

  function normalizeBuffMarketItems(data = {}) {
    return (Array.isArray(data.items) ? data.items : []).map((item) => {
      const goodsId = item.goods_id || item.id;
      const info = { ...(data.goods_infos?.[goodsId] || {}), ...(item.goods_info || item.goodsInfo || {}) };
      const listing = getSteamListingInfo(item.steam_market_url || info.steam_market_url);
      return {
        ...item,
        goods_info: info,
        market_hash_name: item.market_hash_name || item.marketHashName || info.market_hash_name || listing?.marketHashName || "",
      };
    });
  }

  function isWeaponCaseItem(item) {
    const info = item.goods_info || item.goodsInfo || {};
    const name = item.market_hash_name || item.marketHashName || info.market_hash_name || item.name || info.name || "";
    if (/\b(?:Key|Capsule|Package|Sticker|Souvenir)\b|钥匙|胶囊|纪念包|纪念品|印花/i.test(name)) return false;
    const tags = info.tags || item.tags || {};
    const categories = [tags.category?.internal_name, tags.type?.internal_name, info.category, item.category];
    return categories.some((value) => /^(csgo_type_weaponcase|weapon_case|weaponcase)$/i.test(String(value || ""))) ||
      /\bCase$|武器箱$|武器箱（[^）]*）$/i.test(name.trim());
  }

  function buildWeaponCaseMarketUrl(page) {
    const url = new URL("https://buff.163.com/api/market/goods");
    // Start with a clean query so the page's search, price and wear filters cannot restrict the scan.
    url.search = new URLSearchParams({
      game: "csgo",
      category: "csgo_type_weaponcase",
      page_num: String(Math.max(1, Number(page) || 1)),
      page_size: "80",
    }).toString();
    return url.toString();
  }

  async function scanWeaponCasePages({ fetchPage, analyzePage, onPage, isCurrent, maxPages = 2, pause = () => randomDelay(5000, 6500) }) {
    const seen = new Set();
    const totals = { succeeded: 0, failed: 0, missing: 0, pages: 0 };
    let pageSize = 0;
    for (let page = 1; page <= Math.min(2, maxPages) && isCurrent(); page += 1) {
      const url = buildWeaponCaseMarketUrl(page);
      const data = await fetchPage(url, page, totals);
      if (!isCurrent()) return { ...totals, cancelled: true };
      if (!Array.isArray(data?.items)) throw new Error("BUFF 未返回市场列表，请检查登录状态");
      const items = normalizeBuffMarketItems(data);
      if (!items.length) break;
      if (Number(data.page_num) > 0 && Number(data.page_num) !== page) throw new Error("BUFF 返回的页码不匹配，未继续扫描");
      const fresh = items.filter((item) => {
        const key = String(item.goods_id || item.id || item.market_hash_name);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (!fresh.length) throw new Error("BUFF 重复返回同一页，未继续扫描");
      const result = await analyzePage(fresh, url);
      if (!isCurrent() || result.cancelled) return { ...totals, cancelled: true };
      for (const key of ["succeeded", "failed", "missing"]) totals[key] += result[key] || 0;
      totals.pages = page;
      onPage?.(result, page, totals);
      if (result.filtered === fresh.length) throw new Error("分类未返回武器箱，请检查 BUFF 分类是否变更");
      pageSize = Number(data.page_size) || pageSize || items.length;
      const totalPages = Number(data.total_page) || (Number(data.total_count) > 0 ? Math.ceil(Number(data.total_count) / pageSize) : 0);
      if (totalPages && page >= totalPages) break;
      await pause();
    }
    return { ...totals, cancelled: !isCurrent() };
  }

  function calculateSteamFees(grossCents) {
    const gross = Number(grossCents);
    if (!Number.isSafeInteger(gross) || gross < 3) return null;
    const feesFor = (net) => ({
      steam: Math.max(Math.floor(net / 20), 1),
      publisher: Math.max(Math.floor(net / 10), 1),
    });
    // Invert Steam's buyer total (seller proceeds + both rounded fees).
    let low = 0;
    let high = gross;
    while (low < high) {
      const net = low + Math.ceil((high - low) / 2);
      const fees = feesFor(net);
      if (net + fees.steam + fees.publisher <= gross) low = net;
      else high = net - 1;
    }
    const fees = feesFor(low);
    return {
      grossCents: gross,
      netCents: low,
      // Steam assigns any cent left between representable buyer totals to its fee.
      steamFeeCents: gross - low - fees.publisher,
      publisherFeeCents: fees.publisher,
      totalFeeCents: gross - low,
    };
  }

  function estimateNetCents(grossCents) {
    return calculateSteamFees(grossCents)?.netCents || 0;
  }

  function getBuffSellFeePercent(appid, settings = DEFAULT_SETTINGS) {
    const key = Number(appid) === 570 ? "buffDota2SellFeePercent" : "buffCsgoSellFeePercent";
    const value = Number(settings[key] ?? DEFAULT_SETTINGS[key]);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value * 100) / 100 : DEFAULT_SETTINGS[key];
  }

  function calculateMarketRatios({ buffPriceCents, buffBuyPriceCents, steamLowestSellCents, buffSellFeePercent = 2.5 }) {
    const validCents = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
    const buff = validCents(buffPriceCents);
    const buffBuy = validCents(buffBuyPriceCents);
    const steam = validCents(steamLowestSellCents);
    const steamFees = calculateSteamFees(steam);
    const feePercent = Number(buffSellFeePercent);
    const validFee = Number.isFinite(feePercent) && feePercent >= 0 && feePercent <= 100;
    const feeBps = Math.round(feePercent * 100);
    // BUFF proceeds are an estimate; round the fee up to a cent to avoid overstating it.
    const buffSellFeeCents = buff && validFee ? Math.ceil(buff * feeBps / 10000) : null;
    const buffNetSellCents = buffSellFeeCents != null ? buff - buffSellFeeCents : null;
    const buffBuyFeeCents = buffBuy && validFee ? Math.ceil(buffBuy * feeBps / 10000) : null;
    const buffBuyNetCents = buffBuyFeeCents != null ? buffBuy - buffBuyFeeCents : null;
    const steamNetSellCents = steamFees?.netCents ?? null;
    return {
      steamBuyPriceCents: steam,
      steamNetSellCents,
      steamFeeCents: steamFees?.totalFeeCents ?? null,
      buffSellFeePercent: validFee ? feeBps / 100 : null,
      buffSellFeeCents,
      buffNetSellCents,
      buffBuyFeeCents,
      buffBuyNetCents,
      knifeRatio: buff && steamNetSellCents > 0 ? buff / steamNetSellCents : null,
      knifeDiscountRatio: buff && steamNetSellCents > 0 ? buff / steamNetSellCents : null,
      cashoutRatio: steam && buffNetSellCents != null ? buffNetSellCents / steam : null,
      buyOrderCashoutRatio: steam && buffBuyNetCents != null ? buffBuyNetCents / steam : null,
      ratioVersion: 3,
    };
  }

  function formatDiscount(ratio, { roundUp = false } = {}) {
    if (ratio == null || !Number.isFinite(Number(ratio)) || Number(ratio) < 0) return "-";
    const value = Number(ratio);
    // A displayed break-even floor must never round below the actual threshold.
    return roundUp ? `${(Math.ceil(value * 10000) / 1000).toFixed(3)} 折` : `${(value * 10).toFixed(1)} 折`;
  }

  function calculateItemQuery({ item, quote, manualPriceCents = null, manualPriceAt = null }, settings = DEFAULT_SETTINGS, now = Date.now()) {
    const positiveCents = value => Number.isSafeInteger(value) && value > 0 ? value : null;
    const manual = positiveCents(manualPriceCents) != null;
    const buffPriceCents = manual ? manualPriceCents : item?.currencyCode === "CNY" ? positiveCents(item.priceCents) : null;
    const buffReadAt = manual ? manualPriceAt : item?.readAt;
    const buffExpiresAt = Number.isFinite(buffReadAt) ? buffReadAt + 15 * 60 * 1000 : 0;
    const buffExpired = buffPriceCents != null && !(buffReadAt <= now && buffExpiresAt > now);
    const sameItem = !!item && Number(quote?.appid) === Number(item.appid) && quote?.marketHashName === item.marketHashName;
    const steamPriceCents = sameItem ? positiveCents(quote?.lowestSellCents) || positiveCents(quote?.estimatedSellCents) : null;
    const steamBuyCents = sameItem ? positiveCents(quote?.highestBuyCents) : null;
    const steamExpiresAt = Number.isFinite(quote?.updatedAt) && Number.isFinite(quote?.expiresAt)
      ? Math.min(quote.expiresAt, quote.updatedAt + 15 * 60 * 1000) : 0;
    const steamExpired = !!quote && !(quote.updatedAt <= now && steamExpiresAt > now);
    // Reject legacy caches that labelled an explicitly foreign overview as CNY.
    const cnyOverview = !quote?.priceoverview?.lowest_price || parseCnyPriceTextToCents(quote.priceoverview.lowest_price) != null;
    const steamCurrencyValid = quote?.currencyCode === "CNY" && cnyOverview;
    const buyQuote = quote?.buffBuyQuote;
    const sameBuyItem = sameItem && buyQuote?.appid === item.appid && buyQuote?.goodsId === String(item.goodsId) &&
      buyQuote?.marketHashName === item.marketHashName;
    const buffBuyReadAt = sameBuyItem ? buyQuote.checkedAt : null;
    const buffBuyExpiresAt = Number.isFinite(buffBuyReadAt)
      ? Math.min(buffBuyReadAt + 15 * 60 * 1000, buyQuote?.expiresAt || Infinity) : 0;
    const buffBuyPriceCents = sameBuyItem && !buyQuote.error ? positiveCents(buyQuote.priceCents) : null;
    const buffBuyExpired = buffBuyPriceCents != null && !(buffBuyReadAt <= now && buffBuyExpiresAt > now);
    const ratios = calculateMarketRatios({
      buffPriceCents: !buffExpired ? buffPriceCents : null,
      buffBuyPriceCents: !buffBuyExpired ? buffBuyPriceCents : null,
      steamLowestSellCents: sameItem && !steamExpired && steamCurrencyValid ? steamPriceCents : null,
      buffSellFeePercent: getBuffSellFeePercent(item?.appid, settings),
    });
    const futureExpiries = [buffPriceCents && buffExpiresAt, buffBuyPriceCents && buffBuyExpiresAt, quote && steamExpiresAt].filter(time => time > now);
    return { manual, buffPriceCents, buffReadAt, buffExpired, steamPriceCents, steamBuyCents, steamExpired,
      buffBuyPriceCents, buffBuyReadAt, buffBuyExpired,
      steamCurrencyValid, ratios, nextExpiresAt: futureExpiries.length ? Math.min(...futureExpiries) : null };
  }

  function calculatePurchasePortfolio(purchases = [], prices = [], now = Date.now()) {
    const priceMap = new Map(prices.map((price) => [price.key, price]));
    const records = purchases.map((purchase) => {
      const currencyCode = normalizeCurrencyCode(purchase.currencyCode || "CNY");
      const quantity = Number(purchase.quantity ?? 1);
      const buyPriceCents = Number(purchase.buyPriceCents);
      // PG lots retain the cent remainder in the total, so a partial lot may
      // have a fractional average unit cost. Never round that total away.
      const actualTotal = purchase.inventoryBuyCents;
      const validCost = Number.isSafeInteger(quantity) && quantity > 0 && (actualTotal != null
        ? Number.isSafeInteger(actualTotal) && actualTotal >= 0
        : purchase.buyPriceCents != null && purchase.buyPriceCents !== "" && Number.isSafeInteger(buyPriceCents) && buyPriceCents >= 0 && Number.isSafeInteger(buyPriceCents * quantity));
      const totalCostCents = validCost ? actualTotal ?? buyPriceCents * quantity : null;
      const price = priceMap.get(buildPriceKey(purchase.appid, purchase.marketHashName, "CNY"));
      const gross = Number(price?.lowestSellCents || price?.estimatedSellCents);
      const fees = calculateSteamFees(gross);
      const expiresAt = Number(price?.expiresAt || (price?.updatedAt ? price.updatedAt + 15 * 60 * 1000 : 0));
      let quoteStatus = "ready";
      if (!validCost || !purchase.marketHashName || ![730, 570].includes(Number(purchase.appid))) quoteStatus = "invalid";
      else if (currencyCode !== "CNY") quoteStatus = "currency";
      else if (!fees || price?.error || normalizeCurrencyCode(price?.currencyCode || "CNY") !== "CNY") quoteStatus = "missing";
      else if (!(expiresAt > now)) quoteStatus = "expired";
      const ready = quoteStatus === "ready";
      return {
        ...purchase, currencyCode, quantity, buyPriceCents, totalCostCents, quoteStatus,
        estimatedSellCents: ready ? gross : null,
        estimatedNetCents: ready ? fees.netCents : null,
        gross: ready ? gross * quantity : null,
        net: ready ? fees.netCents * quantity : null,
        knifeDiscountRatio: ready ? totalCostCents / (fees.netCents * quantity) : null,
        updatedAt: price?.updatedAt || null,
        expiresAt: price ? expiresAt : null,
      };
    }).sort((a, b) => new Date(b.boughtAt || 0).getTime() - new Date(a.boughtAt || 0).getTime());
    const priced = records.filter((row) => row.quoteStatus === "ready");
    const eligible = records.filter((row) => !["invalid", "currency"].includes(row.quoteStatus));
    const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
    const totalSpentCents = sum(eligible, "totalCostCents");
    const pricedSpentCents = sum(priced, "totalCostCents");
    const totalNetCents = sum(priced, "net");
    const complete = records.length > 0 && priced.length === records.length && totalNetCents > 0;
    const averageDiscountRatio = totalNetCents > 0 ? pricedSpentCents / totalNetCents : null;
    return {
      records,
      summary: {
        currencyCode: "CNY", purchaseCount: records.length,
        itemCount: new Set(records.map((row) => buildPriceKey(row.appid, row.marketHashName, row.currencyCode))).size,
        quantity: sum(eligible, "quantity"), pricedCount: sum(priced, "quantity"), pricedRecordCount: priced.length,
        missingCount: records.filter((row) => row.quoteStatus === "missing").length,
        expiredCount: records.filter((row) => row.quoteStatus === "expired").length,
        foreignCurrencyCount: records.filter((row) => row.quoteStatus === "currency").length,
        invalidCount: records.filter((row) => row.quoteStatus === "invalid").length,
        totalSpentCents, pricedSpentCents, totalGrossCents: sum(priced, "gross"), totalNetCents,
        averageDiscountRatio, breakEvenCashoutRatio: complete ? averageDiscountRatio : null, complete,
        nextQuoteExpiresAt: priced.length ? Math.min(...priced.map((row) => row.expiresAt)) : null,
      },
    };
  }

  function calculateCashoutScenario(summary, cashoutRatio) {
    if (!summary?.complete || cashoutRatio == null || cashoutRatio === "" || !Number.isFinite(Number(cashoutRatio)) || Number(cashoutRatio) < 0) return null;
    // Conservative cent rounding; tolerate only floating-point noise at a cent boundary.
    const proceedsCents = Math.floor(summary.totalNetCents * Number(cashoutRatio) + 1e-8);
    if (!Number.isSafeInteger(proceedsCents)) return null;
    const profitCents = proceedsCents - summary.totalSpentCents;
    return { proceedsCents, profitCents, breaksEven: profitCents >= 0 };
  }

  function uniqBy(list, fn) {
    const seen = new Set();
    const out = [];
    for (const item of list || []) {
      const key = fn(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomDelay(minMs, maxMs) {
    const ms = Math.round(minMs + Math.random() * (maxMs - minMs));
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason || Object.assign(new Error("请求已取消"), { name: "AbortError" });
  }

  function abortableDelay(ms, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const finish = () => { signal?.removeEventListener("abort", cancel); resolve(); };
      const timer = setTimeout(finish, ms);
      const cancel = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(signal.reason || new Error("请求已取消")); };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }

  function isPageMessageInterrupted(error) {
    return error?.code === "PAGE_MESSAGE_INTERRUPTED" ||
      /back[/-]forward cache|\bbfcache\b/i.test(String(error?.message || error || ""));
  }

  function extensionMessageError(error) {
    if (isPageMessageInterrupted(error)) {
      return Object.assign(new Error("页面已切换，消息连接已中断；请返回页面后继续。若刚提交操作，请先核对结果。"), {
        code: "PAGE_MESSAGE_INTERRUPTED",
      });
    }
    return new Error(error?.message || String(error));
  }

  const commonApi = {
    DEFAULT_SETTINGS,
    currencyCodeToId,
    currencyCodeFromId,
    encodeHashName,
    estimateNetCents,
    calculateSteamFees,
    calculateMarketRatios,
    calculateItemQuery,
    calculatePurchasePortfolio,
    calculateCashoutScenario,
    formatDiscount,
    getBuffSellFeePercent,
    formatCents,
    parseSteamVolume,
    formatSteamVolume,
    getSteamVolumeTitle,
    normalizeCurrencyCode,
    parsePriceTextToCents,
    parseCnyAmountToCents,
    parseCnyPriceTextToCents,
    buildPriceKey,
    getMarketGame,
    getBuffGoodsId,
    getSteamListingInfo,
    resolveMarketAppId,
    marketGameLabel,
    normalizeBuffMarketItems,
    isWeaponCaseItem,
    buildWeaponCaseMarketUrl,
    scanWeaponCasePages,
    uniqBy,
    delay,
    randomDelay,
    throwIfAborted,
    abortableDelay,
    isPageMessageInterrupted,
    extensionMessageError,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = commonApi;
  if (typeof self !== "undefined") self.BuffHelperCommon = commonApi;
})();
