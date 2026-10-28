"use strict";
(() => {
  const $ = id => document.getElementById(id), api = (action, payload) => window.buffDesktop.request("profit-report:" + action, payload);
  const C = window.BuffHelperCommon, P = window.BuffDesktopPricing;
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el; };
  const money = (n, currency = "CNY") => n == null ? "—" : C.formatCents(Math.round(n), currency);
  const signed = (n, currency) => n == null ? "—" : (n > 0 ? "+" : "") + money(n, currency);
  const fold = n => n == null ? "—" : C.formatDiscount(n, { roundUp: true });
  const game = id => ({ 730: "CS2", 570: "Dota 2", 753: "Steam 社区物品", 578080: "PUBG" }[id] || "游戏 " + id);
  const platform = id => ({ buff: "BUFF", uu: "悠悠", steam: "Steam" }[id] || id);
  const sum = values => values.reduce((a, b) => a + b, 0), complete = values => values.some(n => n == null) ? null : sum(values);
  const today = () => new Date(Date.now() + 28800000).toISOString().slice(0, 10);
  let data, view = "profit", page = 0, requestSequence = 0, dialogState, opener, busy = false, reloadTimer;
  const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
  const field = (key, label, value, money = false) => ({ key, label, value, money });
  const nameSort = field("name", "物品名称", r => r.name);
  const dateRoutes = { profit: ["direct", "cashout"], knife: ["knife", "netSteam"], net: ["netCash", "netSteam"] };
  const tradeDates = (g, list = view) => window.BuffReportAnalytics.tradeDates([g], dateRoutes[list]);
  const sortFields = {
    profit: [nameSort, field("profit", "总收益", r => r.profitCents, true), field("direct", "直接盈亏", r => r.direct.profitCents, true), field("cashout", "提现收益", r => r.cashout.profitCents, true), field("cashoutRatio", "提现折扣", r => r.cashoutRatio), field("basisRatio", "来源挂刀折扣", r => r.basisRatio), field("pending", "缺少依据数量", r => r.pendingQuantity)],
    knife: [nameSort, field("steamQuantity", "Steam 卖出数量", r => r.steamSaleQuantity), field("knifeQuantity", "已覆盖挂刀数量", r => r.knife.quantity), field("knifeProceeds", "挂刀净到账", r => r.knife.proceedsCents, true), field("knifeCost", "挂刀现金成本", r => r.knife.costCents, true), field("knifeRatio", "挂刀折扣", r => r.knifeRatio), field("netSteamQuantity", "Steam 净卖出数量", r => r.netSteam.quantity), field("netSteamProceeds", "Steam 净卖出金额", r => r.netSteam.proceedsCents, true)],
    holdings: [nameSort, field("holdingQuantity", "持仓数量", r => r.holding.quantity), field("cashCost", "现金来源成本", r => r.holding.cashCostCents, true), field("cashQuantity", "现金来源数量", r => r.holding.cashQuantity), field("steamFace", "Steam 买入面值", r => r.holding.steamFaceCents, true), field("steamQuantity", "Steam 来源数量", r => r.holding.steamQuantity)],
    net: [nameSort, field("netQuantity", "净卖出数量", r => r.netSaleQuantity), field("netCashQuantity", "现金净卖出数量", r => r.netCash.quantity), field("netCashProceeds", "现金净卖出金额", r => r.netCash.proceedsCents, true), field("netSteamQuantity", "Steam 净卖出数量", r => r.netSteam.quantity), field("netSteamProceeds", "Steam 净卖出金额", r => r.netSteam.proceedsCents, true)],
    entries: [nameSort, field("date", "成交日期", r => r.date), field("quantity", "核对数量", r => r.quantity), field("unitPrice", "核对均价", r => r.unitPriceCents, true), field("total", "核对总金额", r => r.quantity * r.unitPriceCents, true), field("platform", "成交平台", r => platform(r.platform)), field("direction", "买卖方向", r => r.direction === "buy" ? "买入" : "卖出"), field("status", "计入状态", r => r.active ? "已计入" : r.enabled === false ? "已撤回" : "已暂停")],
  };
  for (const list of ["profit", "knife", "holdings", "net"]) sortFields[list].splice(1, 0,
    field("buyDate", "最近买入时间", g => g.lastBuyDate || null),
    field("sellDate", list === "profit" ? "最近卖出时间（收益时间）" : "最近卖出时间", g => tradeDates(g, list).sell.lastDate || null));
  const listFilters = {
    profit: [["all", "全部收益明细", () => true], ["direct", "含直接转卖", r => r.direct.quantity > 0], ["cashout", "含提现", r => r.cashout.quantity > 0], ["both", "同时含直接转卖和提现", r => r.direct.quantity > 0 && r.cashout.quantity > 0], ["pending", "缺少价格或折扣样本", r => r.pendingQuantity > 0]],
    knife: [["all", "全部 Steam 卖出", () => true], ["covered", "含已覆盖挂刀", r => r.knife.quantity > 0], ["net", "含 Steam 净卖出", r => r.netSteam.quantity > 0]],
    holdings: [["all", "全部持仓", () => true], ["cash", "含 BUFF / 悠悠来源", r => r.holding.cashQuantity > 0], ["steam", "含 Steam 来源", r => r.holding.steamQuantity > 0], ["both", "同时含两类来源", r => r.holding.cashQuantity > 0 && r.holding.steamQuantity > 0]],
    net: [["all", "全部净卖出", () => true], ["cash", "含现金净卖出", r => r.netCash.quantity > 0], ["steam", "含 Steam 净卖出", r => r.netSteam.quantity > 0], ["return", "含 Steam 买入回卖", r => r.steamReturnQuantity > 0]],
    entries: [["all", "全部核对记录", () => true], ["active", "已计入报告", r => r.active], ["withdrawn", "已撤回", r => r.enabled === false], ["paused", "已暂停", r => r.enabled !== false && !r.active], ["buy", "买入价格核对", r => r.direction === "buy"], ["sell", "卖出价格核对", r => r.direction === "sell"]],
  };
  const defaultSort = { profit: "profit", knife: "steamQuantity", holdings: "holdingQuantity", net: "netQuantity", entries: "date" };
  let tableStates = {};
  const tableState = () => tableStates[view] ||= { key: defaultSort[view], direction: "desc", filter: "all" };
  function tableControls() {
    const state = tableState();
    $("reportSort").replaceChildren(...sortFields[view].map(f => choice(f.key, f.label))); $("reportSort").value = state.key;
    $("reportListFilter").replaceChildren(...listFilters[view].map(([key, label]) => choice(key, label))); $("reportListFilter").value = state.filter;
    $("reportSortDirection").textContent = state.direction === "asc" ? "升序 ↑" : "降序 ↓";
    $("reportSortDirection").setAttribute("aria-label", state.direction === "asc" ? "当前升序，切换为降序" : "当前降序，切换为升序");
    $("reportProfit").disabled = view === "entries";
  }
  function compareRows(a, b) {
    const state = tableState(), f = sortFields[view].find(f => f.key === state.key);
    // Different currencies have no shared monetary scale; never imply a conversion.
    if (f.money && a.currencyCode !== b.currencyCode) return collator.compare(a.currencyCode, b.currencyCode);
    const av = f.value(a), bv = f.value(b), missing = v => v == null || typeof v === "number" && !Number.isFinite(v);
    if (missing(av) !== missing(bv)) return missing(av) ? 1 : -1;
    const result = missing(av) ? 0 : typeof av === "number" ? av - bv : collator.compare(String(av), String(bv));
    return (state.direction === "asc" ? result : -result) || collator.compare(a.name, b.name) || collator.compare(a.id, b.id);
  }
  function sortBy(key) {
    const state = tableState();
    state.direction = state.key === key ? (state.direction === "asc" ? "desc" : "asc") : ["name", "platform", "direction", "status"].includes(key) ? "asc" : "desc";
    state.key = key; page = 0; render();
  }
  function error(text = "", form = false) { const el = $(form ? "reportEntryError" : "reportError"); el.textContent = text; el.hidden = !text; if (text) el.focus(); }
  function choice(value, label) { const el = node("option", label); el.value = value; return el; }
  function choices(id, rows, label) {
    const el = $(id), old = el.value; el.replaceChildren(choice("all", label), ...rows.map(([value, text]) => choice(String(value), text)));
    if ([...el.options].some(o => o.value === old)) el.value = old;
  }
  const portfolio = id => { const link = data.accountLinks.find(l => l.id === id); return link?.name || link?.id || data.accounts.find(a => a.portfolioId === id)?.label || id; };
  function filters() {
    const portfolios = new Map(data.accounts.map(a => [a.portfolioId, portfolio(a.portfolioId)]));
    choices("reportPortfolio", [...portfolios], "全部账户（分别核算）");
    choices("reportGame", [...new Set(data.groups.map(g => g.appid))].sort().map(id => [id, game(id)]), "全部游戏");
    choices("reportCategory", [...new Set(data.groups.map(g => g.category))].sort((a,b) => a.localeCompare(b, "zh-CN")).map(x => [x,x]), "全部类型");
    choices("reportCurrency", [...new Set(data.groups.map(g => g.currencyCode))].sort().map(x => [x,x]), "全部币种");
  }
  function matches(g, withProfit = true) {
    const q = $("reportSearch").value.trim().toLocaleLowerCase(), p = $("reportProfit").value;
    return (!q || `${g.name} ${g.marketHashName}`.toLocaleLowerCase().includes(q))
      && ($("reportGame").value === "all" || String(g.appid) === $("reportGame").value)
      && ($("reportCategory").value === "all" || g.category === $("reportCategory").value)
      && ($("reportCurrency").value === "all" || g.currencyCode === $("reportCurrency").value)
      && (!withProfit || p === "all" || p === "positive" && g.profitCents > 0 || p === "negative" && g.profitCents < 0 || p === "zero" && g.profitCents === 0 || p === "unknown" && g.pendingQuantity > 0);
  }
  const stat = (label, value, hint, n) => { const el = node("div", null, "metric"), amount = node("strong", value); if (n != null) amount.className = n < 0 ? "negative" : n > 0 ? "positive" : ""; el.append(node("span", label, "metric-label"), amount, node("small", hint)); return el; };
  function renderMetrics(groups) {
    window.BuffReportCharts.metrics($("reportMetrics"), data, groups); window.BuffReportCharts.wallets($("reportWallet"),data);
    window.BuffReportCharts.render($("reportCharts"), data, groups);
  }
  function cell(main, small, n) { const td = node("td"), strong = node("strong", main); if (n != null) strong.className = n < 0 ? "negative" : n > 0 ? "positive" : ""; td.append(strong); if (small) td.append(node("small", small)); return td; }
  function nameCell(g) { const td = cell(g.name, g.marketHashName === g.name ? "" : g.marketHashName); td.append(node("small", `${game(g.appid)} · ${g.category || ""} · ${g.currencyCode} · ${portfolio(g.portfolioId)}`)); if (g.manualEntryCount) td.append(node("small", `含 ${g.manualEntryCount} 条价格核对记录`)); return td; }
  function action(label, actionName, id, name) { const b = node("button", label, "text-button"); b.type = "button"; b.dataset.reportAction = actionName; b.dataset.id = id; b.setAttribute("aria-label", label + "：" + name); return b; }
  function profitCell(value, currency, hint) { return cell(signed(value, currency), hint, value); }
  function render() {
    if (!data) return;
    const groups = data.groups.filter(g => matches(g, view !== "entries")); renderMetrics(groups); tableControls();
    $("reportFormula").textContent = data.formula;
    for (const el of document.querySelectorAll("[data-report-view]")) el.setAttribute("aria-pressed", String(el.dataset.reportView === view));
    let rows = groups.filter(g => view === "profit" ? g.direct.quantity + g.cashout.quantity > 0 : view === "knife" ? g.steamSaleQuantity > 0 : view === "holdings" ? g.holding.quantity > 0 : view === "net" ? g.netSaleQuantity > 0 : false);
    if (view === "entries") rows = data.entries.filter(e => ($("reportPortfolio").value === "all" || e.portfolioId === $("reportPortfolio").value)
      && (!data.dateFrom || e.date >= data.dateFrom) && (!data.dateTo || e.date <= data.dateTo)
      && matches({ ...e, category: data.groups.find(g => g.id === e.groupId)?.category || "" }, false));
    const unfilteredCount = rows.length, state = tableState();
    rows = rows.filter(listFilters[view].find(([key]) => key === state.filter)[2]).sort(compareRows);
    const maxPage = Math.max(0, Math.ceil(rows.length / 50) - 1); page = Math.min(page, maxPage);
    const headings = view === "profit" ? ["物品", "直接盈亏", "提现收益", "提现 / 挂刀折扣", "总收益", "计算依据"] : view === "knife" ? ["物品", "Steam 卖出", "已覆盖挂刀", "现金成本 / 挂刀折扣", "Steam 净卖出", "收益口径"] : view === "holdings" ? ["物品", "持仓数量", "现金来源成本", "Steam 买入面值", "收益口径", "核对价格"] : view === "net" ? ["物品", "净卖出数量", "现金净卖出", "Steam 净卖出", "来源说明", "核对价格"] : ["物品", "方向 / 平台", "数量 / 均价", "成交日期 / 说明", "计入状态", "操作"];
    const headerKeys = view === "profit" ? [["name"], ["direct"], ["cashout"], ["cashoutRatio", "basisRatio"], ["profit"], ["pending"]]
      : view === "knife" ? [["name"], ["steamQuantity"], ["knifeQuantity", "knifeProceeds"], ["knifeCost", "knifeRatio"], ["netSteamQuantity", "netSteamProceeds"], []]
      : view === "holdings" ? [["name"], ["holdingQuantity"], ["cashCost", "cashQuantity"], ["steamFace", "steamQuantity"], [], []]
      : view === "net" ? [["name"], ["netQuantity"], ["netCashQuantity", "netCashProceeds"], ["netSteamQuantity", "netSteamProceeds"], [], []]
      : [["name"], ["platform", "direction"], ["quantity", "unitPrice", "total"], ["date"], ["status"], []];
    if (view !== "entries") {
      headings.splice(1, 0, "买入时间", view === "profit" ? "卖出时间（收益时间）" : "卖出时间");
      headerKeys.splice(1, 0, ["buyDate"], ["sellDate"]);
    }
    const hr = node("tr"); headings.forEach((title, index) => {
      const th = node("th"), keys = headerKeys[index], active = keys.includes(state.key), key = active ? state.key : keys[0]; th.scope = "col";
      if (key) {
        const f = sortFields[view].find(f => f.key === key), b = node("button", title, "report-sort-heading"), arrow = node("span", active ? state.direction === "asc" ? "↑" : "↓" : "↕");
        b.type = "button"; b.dataset.reportSort = key; arrow.setAttribute("aria-hidden", "true"); b.append(arrow);
        const next = active ? state.direction === "asc" ? "降序" : "升序" : key === "name" || key === "platform" || key === "status" ? "升序" : "降序";
        b.setAttribute("aria-label", `按${f.label}${next}排序`); th.append(b);
        if (active) th.setAttribute("aria-sort", state.direction === "asc" ? "ascending" : "descending");
      } else th.textContent = title;
      hr.append(th);
    }); $("reportHead").replaceChildren(hr);
    $("reportCaption").textContent = `${rows.length} / ${unfilteredCount} ${view === "entries" ? "条核对记录" : "种物品"} · 每页 50 条`;
    $("reportTableStatus").textContent = `当前按${sortFields[view].find(f => f.key === state.key).label}${state.direction === "asc" ? "升序" : "降序"}排列。列表条件仅影响下表，上方汇总沿用报告筛选；金额按币种分别排序，缺失值置后。`;
    $("reportListNote").textContent = view === "net" ? "净卖出不计利润。Steam 买入后回卖且无现金买入来源的部分也单列为 Steam 净卖出；可核对实际买入价格后重算。" : view === "holdings" ? "三平台买入未售数量全部作为持仓。现金成本与 Steam 面值分别显示，尚未成交的报价不计收益。" : view === "entries" ? "补充本机报表，工作台与交易账本同步更新，可修改、撤回或恢复。同名同日新增平台记录时暂停补录，防止重复。" : `${data.scopeNote} 当前筛选 ${groups.length} 种物品；价格缺项 ${data.quality.unknownAmountCount || 0} 笔，成交日期缺项 ${data.quality.missingTimeCount || 0} 笔。`;
    if (view !== "entries") $("reportListNote").textContent += " " + window.BuffReportCharts.tradeDateNote;
    const body = $("reportRows"); body.replaceChildren();
    for (const g of rows.slice(page * 50, page * 50 + 50)) {
      const tr = node("tr"); tr.dataset.reportId = g.id; tr.append(nameCell(g)); const c = g.currencyCode;
      if (view !== "entries") tr.append(...window.BuffReportCharts.tradeTimeCells(tradeDates(g)));
      if (view === "profit") {
        tr.append(profitCell(g.direct.profitCents, c, `${g.direct.quantity} 件 · 回款 ${money(g.direct.proceedsCents,c)} − 成本 ${money(g.direct.costCents,c)}`),
          profitCell(g.cashout.profitCents,c, `${g.cashout.quantity} 件 · Steam 买入 ${money(g.cashout.steamCostCents,c)} · 折算成本 ${money(g.cashout.costCents,c)}`),
          cell(fold(g.cashoutRatio), `提现折扣 / 来源挂刀折扣 ${fold(g.basisRatio)}`), profitCell(g.profitCents,c, g.pendingQuantity ? `缺依据 ${g.pendingQuantity} 件；可计算 ${signed(g.knownProfitCents,c)}` : "可计算交易合计"), cell(g.pendingQuantity ? "缺少价格或折扣样本" : "已按均价计算", "持仓与净卖出均未计入"));
      } else if (view === "knife") {
        tr.append(cell(`${g.steamSaleQuantity} 件`, "Steam 卖出全部列入此视图"), cell(`${g.knife.quantity} 件`, `Steam 净到账 ${money(g.knife.proceedsCents,c)}`), cell(money(g.knife.costCents,c), fold(g.knifeRatio)), cell(`${g.netSteam.quantity} 件`, money(g.netSteam.proceedsCents,c)), cell("挂刀不重复计收益", "提现时按折扣差计算"));
      } else if (view === "holdings") {
        const acts = node("td"); acts.append(action("核对卖出价格", "sell", g.id, g.name));
        tr.append(cell(`${g.holding.quantity} 件`, "期末未售数量"), cell(money(g.holding.cashCostCents,c), `${g.holding.cashQuantity} 件 · BUFF / 悠悠`), cell(money(g.holding.steamFaceCents,c), `${g.holding.steamQuantity} 件 · Steam 实付面值`), cell("不计收益", "补充实际卖出后重新分类"), acts);
      } else if (view === "net") {
        const acts = node("td"); acts.append(action("核对买入价格", "buy", g.id, g.name));
        tr.append(cell(`${g.netSaleQuantity} 件`), cell(`${g.netCash.quantity} 件`, money(g.netCash.proceedsCents,c)), cell(`${g.netSteam.quantity} 件`, money(g.netSteam.proceedsCents,c)), cell("不计收益", g.steamReturnQuantity ? `其中 ${g.steamReturnQuantity} 件为 Steam 买入回卖，无现金买入来源` : "缺少卖出前可用的买入数量"), acts);
      } else {
        const acts = node("td"); acts.append(action("修改价格核对", "edit", g.id, g.name), action(g.enabled === false ? "恢复计入" : "撤回核对", "toggle", g.id, g.name));
        tr.append(cell(`${g.direction === "buy" ? "买入" : "卖出"} · ${platform(g.platform)}`), cell(`${g.quantity} 件 · ${money(g.unitPriceCents,c)}`, `合计 ${money(g.quantity*g.unitPriceCents,c)}`), cell(g.date, g.note || "无说明"), cell(g.active ? "已计入报告" : g.enabled === false ? "已撤回" : "已暂停", g.issue), acts);
      }
      body.append(tr);
    }
    if (!rows.length) { const tr = node("tr"), td = node("td", "此范围暂无记录。"); td.colSpan = headings.length; tr.append(td); body.append(tr); }
    $("reportPageInfo").textContent = `${page + 1} / ${maxPage + 1}`; $("reportPrevious").disabled = page === 0; $("reportNext").disabled = page === maxPage;
  }
  async function refresh() {
    const sequence = ++requestSequence; $("reportRefresh").disabled = true; $("page-report").setAttribute("aria-busy", "true");
    try {
      const result = await api("load", { portfolioId: $("reportPortfolio").value, dateFrom: $("reportStart").value, dateTo: $("reportEnd").value });
      if (sequence !== requestSequence) return data;
      data = result; error(); filters(); render(); return data;
    } catch (e) { if (sequence === requestSequence) { data = null; error(e.message); $("reportMetrics").replaceChildren(); $("reportCharts").replaceChildren(); $("reportWallet").replaceChildren(); $("reportRows").replaceChildren(); $("reportCaption").textContent = "报告读取失败，请刷新重试"; $("reportListNote").textContent = ""; } throw e; }
    finally { if (sequence === requestSequence) { $("reportRefresh").disabled = false; $("page-report").setAttribute("aria-busy", "false"); } }
  }
  function entryTotal() {
    try { const cents = P.cents($("reportEntryPrice").value), q = Number($("reportEntryQuantity").value); $("reportEntryTotal").textContent = Number.isSafeInteger(q) && q > 0 && Number.isSafeInteger(cents*q) ? `核对合计 ${money(cents*q, dialogState.currencyCode)} · ${dialogState.direction === "buy" ? "含费实付" : "扣费后净到账"}` : "请填写有效数量。"; }
    catch { $("reportEntryTotal").textContent = "请填写实际成交均价，最多两位小数。"; }
  }
  function openEntry(id, direction, entry, target) {
    const g = data.groups.find(g => g.id === id); if (!g) { error("当前日期范围内没有该物品，请清除筛选后重试。"); return; }
    opener = target; dialogState = { groupId: id, direction, entryId: entry?.id, revision: data.revision, currencyCode: g.currencyCode };
    $("reportEntryTitle").textContent = direction === "buy" ? "核对净卖出的买入价格" : "核对持仓的卖出价格";
    $("reportEntryItem").textContent = `${g.name} · ${game(g.appid)} · ${g.currencyCode}`;
    $("reportEntryHint").textContent = direction === "buy" ? "按名称补充已发生的买入；Steam 来源优先计提现，现金来源用于挂刀或直接转卖。" : "按名称补充已发生的卖出；现金卖出优先计提现，Steam 卖出按挂刀或净卖出处理。";
    $("reportEntryPriceLabel").textContent = `${direction === "buy" ? "单件含费实付" : "单件扣费后净到账"}（${g.currencyCode}）`;
    $("reportEntryPlatform").value = entry?.platform || "buff"; $("reportEntryQuantity").value = entry?.quantity || 1;
    $("reportEntryQuantity").removeAttribute("max");
    $("reportEntryDate").max = today(); $("reportEntryDate").value = entry?.date || (direction === "buy" ? [g.netCash.firstDate,g.netSteam.firstDate].filter(Boolean).sort()[0] : data.dateTo || today()) || today();
    $("reportEntryPrice").value = entry ? (entry.unitPriceCents/100).toFixed(2) : ""; $("reportEntryNote").value = entry?.note || "";
    error("",true); entryTotal(); $("reportEntryDialog").showModal(); $("reportEntryPrice").focus();
  }
  $("reportRows").addEventListener("click", async event => {
    const b = event.target.closest("[data-report-action]"); if (!b || busy) return;
    const id = b.dataset.id, kind = b.dataset.reportAction;
    if (kind === "buy" || kind === "sell") return openEntry(id, kind, null, b);
    const entry = data.entries.find(e => e.id === id); if (!entry) return;
    if (kind === "edit") return openEntry(entry.groupId, entry.direction, entry, b);
    busy = true; b.disabled = true;
    try { await api("toggle", { id, enabled: entry.enabled === false, revision: data.revision }); await refresh(); }
    catch (e) { error(e.message); } finally { busy = false; b.disabled = false; }
  });
  $("reportEntryForm").addEventListener("submit", async event => {
    event.preventDefault(); if (busy) return; busy = true; $("reportEntrySave").disabled = true;
    try {
      const quantity = Number($("reportEntryQuantity").value); if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error("数量必须是正整数");
      const { currencyCode, ...request } = dialogState;
      await api("save", { ...request, platform: $("reportEntryPlatform").value, date: $("reportEntryDate").value, quantity, unitPriceCents: P.cents($("reportEntryPrice").value), note: $("reportEntryNote").value.trim() });
      $("reportEntryDialog").close(); await refresh();
    } catch (e) { error(e.message, $("reportEntryDialog").open); } finally { busy = false; $("reportEntrySave").disabled = false; }
  });
  $("reportEntryClose").addEventListener("click", () => { if (!busy) $("reportEntryDialog").close(); });
  $("reportEntryDialog").addEventListener("cancel", e => { if (busy) e.preventDefault(); });
  $("reportEntryDialog").addEventListener("close", () => { if (opener?.isConnected) opener.focus(); else $("profitReportTitle").focus(); });
  for (const id of ["reportEntryPrice","reportEntryQuantity"]) $(id).addEventListener("input", entryTotal);
  $("reportJumpDetails").addEventListener("click", () => { $("reportSort").scrollIntoView({ block: "center" }); $("reportSort").focus({ preventScroll: true }); });
  $("reportRefresh").addEventListener("click", () => refresh().catch(() => {}));
  $("reportHead").addEventListener("click", event => {
    const b = event.target.closest("[data-report-sort]"); if (!b || !data) return;
    sortBy(b.dataset.reportSort); $("reportHead").querySelector(`[data-report-sort="${tableState().key}"]`)?.focus();
  });
  $("reportSort").addEventListener("change", () => { if (data) sortBy($("reportSort").value); });
  $("reportSortDirection").addEventListener("click", () => { if (data) sortBy(tableState().key); });
  $("reportListFilter").addEventListener("change", () => { tableState().filter = $("reportListFilter").value; page = 0; render(); });
  $("reportTableReset").addEventListener("click", () => { delete tableStates[view]; page = 0; render(); });
  for (const id of ["reportPortfolio","reportStart","reportEnd"]) $(id).addEventListener("change", () => { page = 0; refresh().catch(() => {}); });
  for (const id of ["reportGame","reportCategory","reportCurrency","reportProfit","reportSearch"]) $(id).addEventListener(id === "reportSearch" ? "input" : "change", () => { page = 0; render(); });
  for (const b of document.querySelectorAll("[data-report-view]")) b.addEventListener("click", () => { view = b.dataset.reportView; page = 0; render(); });
  $("reportPrevious").addEventListener("click", () => { page--; render(); }); $("reportNext").addEventListener("click", () => { page++; render(); });
  $("reportReset").addEventListener("click", () => { for (const id of ["reportPortfolio","reportGame","reportCategory","reportCurrency","reportProfit"]) $(id).value = "all"; for (const id of ["reportStart","reportEnd","reportSearch"]) $(id).value = ""; tableStates = {}; page = 0; refresh().catch(() => {}); });
  window.buffDesktop.onChange(e => { if ((["order-ledger","history","connection"].includes(e.kind) || ["buff-orders","uu-orders","steam-orders"].includes(e.kind) && e.value?.job?.status !== "running") && !busy && !$("page-report").hidden && !$("reportEntryDialog").open) { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => refresh().catch(() => {}), 350); } });
  window.BuffProfitReport = { refresh, data: () => data };
})();
