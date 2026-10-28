"use strict";
(() => {
  const $ = id => document.getElementById(id), api = (action, payload) => window.buffDesktop.request(action, payload);
  const C = window.BuffHelperCommon, P = window.BuffDesktopPricing;
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const money = (value, currency = "CNY") => value == null ? "—" : C.formatCents(Math.round(value), currency);
  const date = value => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "尚无记录";
  const fold = value => value == null ? "—" : C.formatDiscount(value, { roundUp: true });
  const platform = value => ({ buff: "BUFF", uu: "悠悠", steam: "Steam", mixed: "多平台" }[value] || value);
  let data = null, view = "holdings", page = 0, sequence = 0, trendSequence = 0, detailId = null, reloadTimer;
  function error(message = "") { $("orderLedgerError").textContent = message; $("orderLedgerError").hidden = !message; const notice = $("appNotice"); if (notice) { notice.textContent = message; notice.hidden = !message; } }
  function button(text, action, id) { const el = node("button", text, "text-button"); el.type = "button"; el.dataset.ledgerAction = action; el.dataset.id = id; return el; }
  const stat = (title, value, hint) => { const el = node("div", null, "metric"); el.append(node("span", title, "metric-label"), node("strong", value), node("small", hint)); return el; };
  const option = (value, label) => { const el = node("option", label); el.value = value; return el; };
  const portfolioLabel = id => { const link = data?.options.accountLinks?.find(row => row.id === id); return link?.name || link?.id || data?.accounts.find(row => row.key === id || `account:${row.key}` === id)?.label || "独立账户"; };
  function chart(target, points, series, title, currency = "CNY") {
    const host = $(target); host.replaceChildren();
    const values = points.flatMap(row => series.map(s => row[s.key])).filter(Number.isFinite);
    if (!values.length) { host.append(node("p", "此范围暂无可核实数据。", "chart-empty")); return; }
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 600 210"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", title); svg.classList.add("ledger-chart");
    const st = document.createElementNS(ns, "title"); st.textContent = title; svg.append(st);
    const min = Math.min(0, ...values), max = Math.max(1, ...values), span = max - min || 1;
    const x = i => 65 + i * 510 / Math.max(1, points.length - 1), y = value => 170 - (value - min) * 145 / span;
    const add = (tag, attrs, text) => { const el = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value); if (text != null) el.textContent = text; svg.append(el); return el; };
    for (const value of [min, min + span / 2, max]) { add("line", { x1: 65, x2: 575, y1: y(value), y2: y(value), stroke: "#e4e9e6" }); add("text", { x: 59, y: y(value) + 4, "text-anchor": "end", fill: "#63776c", "font-size": 10 }, money(value, currency)); }
    for (const i of [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])]) if (points[i]) add("text", { x: x(i), y: 198, "text-anchor": "middle", fill: "#63776c", "font-size": 10 }, points[i].date.slice(5));
    for (const s of series) {
      let segment = [];
      const flush = () => { if (segment.length > 1) add("polyline", { points: segment.join(" "), fill: "none", stroke: s.color, "stroke-width": 2, ...(s.dash ? { "stroke-dasharray": s.dash } : {}) }); segment = []; };
      points.forEach((row, i) => { const value = row[s.key]; if (!Number.isFinite(value)) { flush(); return; } segment.push(`${x(i)},${y(value)}`); const dot = add("circle", { cx: x(i), cy: y(value), r: 3, fill: s.color }); const label = document.createElementNS(ns, "title"); label.textContent = `${row.date} ${s.label} ${money(value, currency)}`; dot.append(label); }); flush();
    }
    const legend = node("div", null, "chart-legend"); for (const s of series) { const label = node("span", s.label); label.style.setProperty("--series-color", s.color); legend.append(label); }
    const details = node("details", null, "chart-data"), table = node("table"), head = node("thead"), hr = node("tr"), body = node("tbody");
    table.append(node("caption", title)); for (const label of ["日期", ...series.map(s => s.label)]) { const th = node("th", label); th.scope = "col"; hr.append(th); } head.append(hr);
    for (const row of points) { const tr = node("tr"); tr.append(node("td", row.date), ...series.map(s => node("td", row[s.key] == null ? "—" : money(row[s.key], currency)))); body.append(tr); }
    table.append(head, body); details.append(node("summary", "查看图表数据"), table); host.append(svg, legend, details);
  }
  const profitValue = (total, known, covered) => total ?? (covered > 0 ? known : null);
  const profitHint = (total, covered) => total != null ? "" : covered > 0 ? `仅已知 ${covered} 件 · ` : "暂无可核实盈亏 · ";
  const valuationDescription = (value = data.summary) => value.valuationSource === "historical-cashout" ? "历史加权提现折扣" : "无历史提现样本，使用备用估值折扣";
  function reportGroups() { return filteredGroups().map(g => g.report).filter(Boolean); }
  function renderMetrics() {
    const groups = reportGroups(), q = data.report.quality;
    window.BuffReportCharts.metrics($("orderLedgerMetrics"), data.report, groups); window.BuffReportCharts.wallets($("ledgerWallet"),data.report);
    $("ledgerOverviewSummary").textContent = "与收益报告共用计算口径和价格核对记录。下方物品筛选同时作用于汇总与图表；列表标签仅切换明细。";
    $("ledgerDataQuality").textContent = `数据质量：${q.unknownAmountCount || 0} 笔金额缺项 · ${q.missingTimeCount || 0} 笔成交时间缺失 · ${groups.reduce((n,g) => n+g.netSaleQuantity,0)} 件净卖出不计收益。持仓、余额及理论估值均不计入总收益。`;
  }
  function renderProfit() {
    if (data) window.BuffReportCharts.render($("ledgerCharts"), data.report, reportGroups());
  }
  function fillSelectors() {
    const selected = $("ledgerPortfolio").value, portfolios = new Map();
    for (const link of data.options.accountLinks || []) portfolios.set(link.id, link.name || link.id);
    for (const row of data.accounts) portfolios.set(row.portfolioId || row.key, row.portfolioId && row.portfolioId !== row.key ? portfolioLabel(row.portfolioId) : row.label);
    $("ledgerPortfolio").replaceChildren(option("all", "全部账户（各组合独立核算）"), ...[...portfolios].map(([id, label]) => option(id, label)));
    if ([...$("ledgerPortfolio").options].some(o => o.value === selected)) $("ledgerPortfolio").value = selected;
    const previous = $("trendItem").value, items = new Map();
    for (const row of data.orders || []) if (row.marketHashName && row.portfolioId) {
      const key = JSON.stringify([row.portfolioId, row.appid, row.marketHashName, row.currencyCode]);
      if (!items.has(key)) items.set(key, `${row.name || row.marketHashName} · ${row.currencyCode} · ${portfolioLabel(row.portfolioId)}`);
    }
    $("trendItem").replaceChildren(...(items.size ? [...items].map(([key, label]) => option(key, label)) : [option("", "暂无可核算物品")]));
    if (items.has(previous)) $("trendItem").value = previous;
    for (const [id, values, label] of [["ledgerGame", (data.games || []).map(g => [String(g.appid), g.label]), "全部游戏"], ["ledgerCategory", (data.categories || []).map(v => [v, v]), "全部类型"], ["ledgerCurrency", [...new Set(data.groups.map(g => g.currencyCode))].map(v => [v, v]), "全部币种"]]) {
      const old = $(id).value; $(id).replaceChildren(option("all", label), ...values.map(([v, text]) => option(v, text)));
      if ([...$(id).options].some(o => o.value === old)) $(id).value = old;
    }
  }
  async function refreshTrend() {
    const run = ++trendSequence, value = $("trendItem").value;
    if (!value) { $("orderTrendChart").replaceChildren(node("p", "同步或导入订单后显示三平台成交走势。", "chart-empty")); return; }
    const [portfolioId, appid, marketHashName, currencyCode] = JSON.parse(value);
    try {
      const dateTo = $("ledgerEnd").value, dateFrom = $("ledgerStart").value;
      const trend = await api("order-ledger:trends", { portfolioId, appid, marketHashName, currencyCode, direction: $("trendDirection").value, ...(dateTo ? { asOf: Date.parse(dateTo + "T23:59:59.999+08:00") } : {}) });
      if (run === trendSequence) chart("orderTrendChart", trend.points.filter(point => !dateFrom || point.date >= dateFrom), [{ key: "steam", label: "Steam", color: "#3f6797" }, { key: "buff", label: "BUFF", color: "#206454", dash: "6 3" }, { key: "uu", label: "悠悠", color: "#ad6c27", dash: "2 3" }], trend.title, currencyCode);
    } catch (issue) { if (run === trendSequence) $("orderTrendChart").replaceChildren(node("p", issue.message, "chart-empty")); }
  }
  function sourceCell(row) {
    const cell = node("td", null, "ledger-source"); cell.append(node("strong", row.name || row.marketHashName || "未提供名称")); if (row.marketHashName && row.marketHashName !== row.name) cell.append(node("small", row.marketHashName));
    if (row.portfolioId) cell.append(node("small", portfolioLabel(row.portfolioId)));
    cell.append(node("small", `${({ 730: "CS2", 570: "Dota 2", 753: "Steam 社区物品", 578080: "PUBG" })[row.appid] || "其他游戏"} · ${row.category || platform(row.platform || row.buyPlatform)} · ${row.currencyCode || "CNY"}`)); return cell;
  }
  function tradeDates(row) {
    const routes = { knife: ["knife", "netSteam"], cashout: ["cashout"], direct: ["direct"], net: ["netCash", "netSteam"] };
    const dates = window.BuffReportAnalytics.tradeDates(row.members ? row.members.map(member => member.report) : [row.report], routes[view]);
    if (view === "gaps") dates.sell = { firstDate: row.gap.firstMissingSale, lastDate: row.gap.lastMissingSale };
    return dates;
  }
  const realized = row => row.report?.profitCents;
  const completeTotal = values => values.some(v => v == null) ? null : values.reduce((a, b) => a + b, 0);
  const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
  const field = (label, value, money = false, direction = "desc") => ({ label, value, money, direction });
  const gapReasonLabels = { no_buy: "无同名买入", later_buy: "买入晚于卖出", exhausted: "此前买入数量不足" };
  const sortFields = {
    name: field("物品名称", row => row.name, false, "asc"),
    buy_recent: field("最近买入时间", row => tradeDates(row).buy.lastDate),
    sell_recent: field("最近卖出时间", row => tradeDates(row).sell.lastDate),
    buy: field("期间买入数量", row => row.buy.quantity),
    investment: field("期间现金投入", row => row.report.cashInvestmentCents, true),
    holding: field("持仓数量", row => row.report.holding.quantity),
    cost: field("现金持仓成本", row => row.report.holding.cashCostCents, true),
    steamFace: field("Steam 持仓面值", row => row.report.holding.steamFaceCents, true),
    direct: field("直接盈亏", row => row.report.direct.profitCents, true),
    directQuantity: field("直接转卖数量", row => row.report.direct.quantity),
    directProceeds: field("直接转卖净回款", row => row.report.direct.proceedsCents, true),
    directCost: field("直接转卖成本", row => row.report.direct.costCents, true),
    cashout: field("提现折扣差收益", row => row.report.cashout.profitCents, true),
    cashoutQuantity: field("提现数量", row => row.report.cashout.quantity),
    cashoutProceeds: field("提现净回款", row => row.report.cashout.proceedsCents, true),
    cashoutSteamFace: field("提现对应 Steam 买入面值", row => row.report.cashout.steamCostCents, true),
    cashoutRatio: field("提现折扣", row => row.report.cashoutRatio),
    basisRatio: field("来源挂刀折扣", row => row.report.basisRatio),
    profit: field("总已实现收益", realized, true),
    net: field("净卖出数量", row => row.report.netSaleQuantity),
    netCash: field("现金净卖出金额", row => row.report.netCash.proceedsCents, true),
    netSteam: field("Steam 净卖出金额", row => row.report.netSteam.proceedsCents, true),
    steamSales: field("Steam 卖出数量", row => row.report.steamSaleQuantity),
    knife: field("已覆盖挂刀数量", row => row.report.knife.quantity),
    knifeProceeds: field("挂刀 Steam 净到账", row => row.report.knife.proceedsCents, true),
    knifeCost: field("挂刀现金成本", row => row.report.knife.costCents, true),
    knifeRatio: field("挂刀折扣", row => row.report.knifeRatio),
    gap: field("来源缺口数量", row => row.uncoveredSaleQuantity),
    gapCash: field("现金卖出缺口数量", row => row.gap.cashQuantity),
    gapSteam: field("Steam 卖出缺口数量", row => row.gap.steamQuantity),
    historyBuy: field("历史买入数量", row => row.gap.buyQuantity),
    historySale: field("历史卖出数量", row => row.gap.saleQuantity),
    gapReason: field("缺口原因", row => Object.entries(row.gap.counts).filter(([, quantity]) => quantity > 0).map(([code]) => gapReasonLabels[code]).join("、"), false, "asc"),
    noBuy: field("无同名买入缺口数量", row => row.gap.counts.no_buy),
    laterBuy: field("买入晚于卖出缺口数量", row => row.gap.counts.later_buy),
    exhausted: field("此前买入不足缺口数量", row => row.gap.counts.exhausted),
    evidence: field("名称与来源证据", row => [row.gap.classification === "mapping_candidate" ? "名称映射候选" : "历史取得记录缺口", row.gap.mappingEvidence, row.gap.coverageEvidence].join(" · "), false, "asc"),
    recent: field("最近交易", row => (row.members || [row]).map(member => member.instrument?.lastTradeDate || "").sort().at(-1)),
  };
  const tableStates = {}, tableState = () => tableStates[view] ||= { key: "name", direction: "asc" };
  const sortLabel = key => key === "name" && view === "categories" ? "类型名称" : key === "sell_recent" && ["direct", "cashout"].includes(view) ? "最近卖出时间（收益时间）" : sortFields[key].label;
  function tableColumns() {
    const col = (label, ...keys) => ({ label, keys });
    const columns = [col(view === "categories" ? "类型 / 游戏" : "物品 / 类型", "name"), col("买入时间", "buy_recent"), col(["direct", "cashout"].includes(view) ? "卖出时间（收益时间）" : "卖出时间", "sell_recent")];
    if (view === "gaps") return [...columns, col("缺口数量", "gap", "gapCash", "gapSteam"), col("历史记录", "historyBuy", "historySale"), col("缺口原因", "gapReason", "noBuy", "laterBuy", "exhausted"), col("名称与来源证据", "evidence"), col("操作")];
    const holding = col("期末持仓（不计收益）", "holding", "cost", "steamFace"), direct = col("直接盈亏", "direct", "directQuantity", "directProceeds", "directCost"), net = col("净卖出（不计收益）", "net", "netCash", "netSteam");
    if (["all", "holdings", "watchlist", "categories", "excluded"].includes(view)) return [...columns, col("期间买入 / 现金投入", "buy", "investment"), holding, direct, col("提现折扣差收益", "cashout", "cashoutQuantity"), col("总已实现收益", "profit"), net, col("操作")];
    return [...columns, col("Steam 卖出 / 挂刀", "steamSales", "knife", "knifeProceeds", "knifeCost", "knifeRatio"), col("提现 / 折扣差收益", "cashout", "cashoutQuantity", "cashoutProceeds", "cashoutSteamFace", "cashoutRatio", "basisRatio"), direct, net, holding, col("操作")];
  }
  function sortControls(columns) {
    const state = tableState(), keys = [...new Set([...columns.flatMap(column => column.keys), "profit", "gap", "recent"])];
    $("ledgerSort").replaceChildren(...keys.map(key => option(key, sortLabel(key)))); $("ledgerSort").value = state.key;
    $("ledgerSortDirection").textContent = state.direction === "asc" ? "升序 ↑" : "降序 ↓";
    $("ledgerSortDirection").setAttribute("aria-label", state.direction === "asc" ? "当前升序，切换为降序" : "当前降序，切换为升序");
    $("ledgerSortStatus").textContent = `当前按${sortLabel(state.key)}${state.direction === "asc" ? "升序" : "降序"}排列。点击表头切换排序；金额按币种分别排列，缺失值置后。`;
    const head = node("tr");
    for (const { label, keys } of columns) {
      const th = node("th"), active = keys.includes(state.key), key = active ? state.key : keys[0]; th.scope = "col";
      if (key) {
        const b = node("button", label, "ledger-sort-heading"), arrow = node("span", active ? state.direction === "asc" ? "↑" : "↓" : "↕");
        b.type = "button"; b.dataset.ledgerSort = key; arrow.setAttribute("aria-hidden", "true"); b.append(arrow);
        const next = active ? state.direction === "asc" ? "降序" : "升序" : sortFields[key].direction === "asc" ? "升序" : "降序";
        b.setAttribute("aria-label", `按${sortLabel(key)}${next}排序`); th.append(b);
        if (active) th.setAttribute("aria-sort", state.direction === "asc" ? "ascending" : "descending");
      } else th.textContent = label;
      head.append(th);
    }
    $("orderLedgerHead").replaceChildren(head);
  }
  function sortBy(key) {
    const state = tableState();
    state.direction = state.key === key ? state.direction === "asc" ? "desc" : "asc" : sortFields[key].direction;
    state.key = key; page = 0; renderRows(true);
  }
  function filteredGroups() {
    const search = $("ledgerSearch").value.trim().toLocaleLowerCase(), game = $("ledgerGame").value, category = $("ledgerCategory").value, currency = $("ledgerCurrency").value, position = $("ledgerPosition").value, profit = $("ledgerProfitFilter").value, gap = $("ledgerGapFilter").value;
    return data.groups.filter(row => {
      const value = realized(row);
      return (!search || [row.name, row.marketHashName].some(v => String(v || "").toLocaleLowerCase().includes(search)))
        && (game === "all" || String(row.appid) === game) && (category === "all" || row.category === category) && (currency === "all" || row.currencyCode === currency)
        && (position === "all" || position === "gap" && row.uncoveredSaleQuantity > 0 || position === row.instrument?.status)
        && (profit === "all" || profit === "unknown" && value == null || value != null && (profit === "profit" && value > 0 || profit === "loss" && value < 0 || profit === "flat" && value === 0))
        && (gap === "all" || gap === "mapping_candidate" && row.gap?.classification === gap || row.gap?.counts?.[gap] > 0);
    });
  }
  function sortRows(rows) {
    const state = tableState(), f = sortFields[state.key], missing = value => value == null || value === "" || typeof value === "number" && !Number.isFinite(value);
    return rows.map(row => ({ row, value: f.value(row) })).sort((a, b) => {
      if (f.money && a.row.currencyCode !== b.row.currencyCode) return collator.compare(a.row.currencyCode, b.row.currencyCode);
      if (missing(a.value) !== missing(b.value)) return missing(a.value) ? 1 : -1;
      const result = missing(a.value) ? 0 : typeof a.value === "number" ? a.value - b.value : collator.compare(String(a.value), String(b.value));
      return (state.direction === "asc" ? result : -result) || collator.compare(a.row.name, b.row.name) || collator.compare(a.row.id, b.row.id);
    }).map(item => item.row);
  }
  function groupCategories(rows) {
    const groups = new Map(), A = window.BuffReportAnalytics;
    for (const row of rows) { const key = JSON.stringify([row.portfolioId, row.appid, row.currencyCode, row.category]); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
    return [...groups].map(([id, members]) => {
      const first = members[0], reports = members.map(r => r.report), summary = A.summary(reports, data.report);
      return { ...first, id, members, name: first.category, marketHashName: "", excluded: false,
        remainingQuantity: summary.holdingQuantity, buy: { quantity: summary.buyQuantity },
        report: { ...summary, knownProfitCents: summary.knownProfitCents, holding: { quantity: summary.holdingQuantity,
          cashQuantity: A.sum(reports.map(g => g.holding.cashQuantity)), steamQuantity: A.sum(reports.map(g => g.holding.steamQuantity)), cashCostCents: summary.cashHoldingCents, steamFaceCents: summary.steamHoldingFaceCents } },
        uncoveredSaleQuantity: members.reduce((n,r) => n + r.uncoveredSaleQuantity, 0) };
    });
  }
  function filterSummary(rows) {
    const A = window.BuffReportAnalytics;
    const lines = [...new Set(rows.map(r => r.currencyCode))].sort().map(currency => {
      const s = A.summary(rows.filter(r => r.currencyCode === currency).map(r => r.report), data.report);
      return `${currency}：持仓 ${s.holdingQuantity} 件 · 总收益 ${window.BuffReportCharts.signed(A.shown(s.profitCents,s.knownProfitCents,s.includedQuantity),currency)}${s.pendingQuantity ? "（可计算部分）" : ""} · 净卖出 ${s.netSaleQuantity} 件`;
    });
    $("ledgerFilterSummary").textContent = `当前列表 ${rows.length} 个物品标的。` + lines.join("；") + "。持仓与净卖出不计利润；价格核对请在收益报告按名称补充。";
  }
  function profitCell(value, known, currency, hint = "") {
    const td = node("td"); td.append(node("strong", window.BuffReportCharts.signed(value, currency), value > 0 ? "positive" : value < 0 ? "negative" : ""));
    if (value == null && known != null) td.append(node("small", "可计算部分 " + money(known, currency)));
    if (hint) td.append(node("small", hint)); return td;
  }
  function holdingCell(row) {
    const h = row.report.holding, td = node("td");
    td.append(node("strong", `${h.quantity} 件${row.excluded ? "（账本已隐藏）" : ""}`), node("small", `现金来源 ${h.cashQuantity} 件 · 成本 ${money(h.cashCostCents,row.currencyCode)}`), node("small", `Steam 来源 ${h.steamQuantity} 件 · 面值 ${money(h.steamFaceCents,row.currencyCode)}`));
    if (row.opening) td.append(node("small", `期初 ${row.opening.quantity} 件 · 来源成本 ${money(row.opening.costCents,row.currencyCode)}`));
    return td;
  }
  function instrumentRow(row) {
    const tr = node("tr"), r = row.report, c = row.currencyCode; tr.dataset.orderId = row.id; tr.append(sourceCell(row), ...window.BuffReportCharts.tradeTimeCells(tradeDates(row)));
    const buy = node("td"); buy.append(node("strong", `${row.members ? row.members.length + " 种 · " : ""}买入 ${row.buy.quantity} 件`), node("small", "现金投入 " + money(r.cashInvestmentCents ?? r.knownCashInvestmentCents,c)));
    const net = node("td"); net.append(node("strong", `${r.netSaleQuantity} 件`), node("small", `现金 ${money(r.netCash.proceedsCents,c)} · Steam ${money(r.netSteam.proceedsCents,c)}`), node("small", "净卖出与持仓不计收益"));
    const actions = node("td");
    if (row.members) { const b = button("查看此类", "category", row.category); b.dataset.game = row.appid; b.dataset.currency = c; b.dataset.portfolio = row.portfolioId; actions.append(b); }
    else { actions.append(button("物品详情", "detail", row.id), node("br")); const star = button(row.instrument.watched ? "移出自选" : "加入自选", "watch", row.id); star.setAttribute("aria-pressed", String(row.instrument.watched)); star.setAttribute("aria-label", (row.instrument.watched ? "移出自选：" : "加入自选：") + row.name); actions.append(star); if (row.remainingQuantity) actions.append(node("br"), button(row.excluded ? "恢复持仓" : "移出持仓", row.excluded ? "restore" : "exclude", row.id)); }
    tr.append(buy, holdingCell(row), profitCell(r.direct.profitCents, r.direct.includedQuantity ? r.direct.knownProfitCents : null,c, `${r.direct.quantity} 件 · 现金卖出减成本`), profitCell(r.cashout.profitCents,r.cashout.includedQuantity ? r.cashout.knownProfitCents : null,c, `${r.cashout.quantity} 件 · 按挂刀 / 提现折扣差`), profitCell(r.profitCents,r.includedQuantity ? r.knownProfitCents : null,c,r.pendingQuantity ? `缺依据 ${r.pendingQuantity} 件` : "总收益 = 直接 + 提现"), net, actions); return tr;
  }
  function gapRow(row) {
    const g = row.gap, tr = node("tr"); tr.dataset.orderId = row.id; tr.append(sourceCell(row), ...window.BuffReportCharts.tradeTimeCells(tradeDates(row)));
    const qty = node("td"); qty.append(node("strong", `${g.quantity} 件`), node("small", `现金卖出 ${g.cashQuantity} · Steam 卖出 ${g.steamQuantity}`));
    const history = node("td"); history.append(node("strong", `买入 ${g.buyQuantity} / 卖出 ${g.saleQuantity}`), node("small", "卖出时间列为发生来源缺口的成交日"));
    const reasons = node("td"); for (const [code, qty] of Object.entries(g.counts)) if (qty) reasons.append(node("small", `${gapReasonLabels[code]}：${qty} 件`));
    const evidence = node("td"); evidence.append(node("strong", g.classification === "mapping_candidate" ? "名称映射候选" : "历史取得记录缺口"), node("small", g.mappingEvidence), node("small", g.coverageEvidence));
    const actions = node("td"); actions.append(button("查看物品汇总", "detail", row.id)); tr.append(qty, history, reasons, evidence, actions); return tr;
  }
  function renderRows(sortingOnly = false) {
    if (!data) return;
    if (!sortingOnly) { renderMetrics(); renderProfit(); }
    let rows = filteredGroups().filter(row => view === "holdings" ? !row.excluded && row.remainingQuantity > 0 : view === "excluded" ? row.excluded && row.remainingQuantity > 0 : view === "watchlist" ? row.instrument.watched : view === "gaps" ? row.uncoveredSaleQuantity > 0 : view === "net" ? row.report.netSaleQuantity > 0 : ["all", "categories"].includes(view) || (view === "knife" ? row.report.steamSaleQuantity : row.report[view]?.quantity) > 0);
    filterSummary(rows); if (view === "categories") rows = groupCategories(rows); rows = sortRows(rows);
    const instruments = ["all", "holdings", "watchlist", "categories", "excluded"].includes(view), gaps = view === "gaps";
    const count = rows.length, max = Math.max(1, Math.ceil(count / 50)); page = Math.min(page, max - 1); rows = rows.slice(page * 50, (page + 1) * 50);
    const columns = tableColumns(); sortControls(columns);
    $("orderLedgerRows").replaceChildren(...rows.map(row => {
      if (gaps) return gapRow(row); if (instruments) return instrumentRow(row);
      const r = row.report, c = row.currencyCode, tr = node("tr"); tr.dataset.orderId = row.id; tr.append(sourceCell(row), ...window.BuffReportCharts.tradeTimeCells(tradeDates(row)));
      const knife = node("td"); knife.append(node("strong", `${r.steamSaleQuantity} 件 Steam 卖出`), node("small", `已覆盖挂刀 ${r.knife.quantity} 件 · Steam 净到账 ${money(r.knife.proceedsCents,c)}`), node("small", `现金成本 ${money(r.knife.costCents,c)} · 挂刀折扣 ${fold(r.knifeRatio)}`));
      const cashout = node("td"); cashout.append(node("strong", `${r.cashout.quantity} 件 · ${window.BuffReportCharts.signed(r.cashout.profitCents,c)}`), node("small", `对应 Steam 买入 ${money(r.cashout.steamCostCents,c)} · 净回款 ${money(r.cashout.proceedsCents,c)}`), node("small", `提现 ${fold(r.cashoutRatio)} − 挂刀 ${fold(r.basisRatio)}`));
      const direct = profitCell(r.direct.profitCents,r.direct.includedQuantity ? r.direct.knownProfitCents : null,c, `${r.direct.quantity} 件 · 净回款 ${money(r.direct.proceedsCents,c)} − 成本 ${money(r.direct.costCents,c)}`);
      const net = node("td"); net.append(node("strong", `${r.netSaleQuantity} 件`), node("small", `现金 ${r.netCash.quantity} 件 · ${money(r.netCash.proceedsCents,c)}`), node("small", `Steam ${r.netSteam.quantity} 件 · ${money(r.netSteam.proceedsCents,c)}`));
      if(r.steamReturnQuantity) net.append(node("small", `含 ${r.steamReturnQuantity} 件 Steam 买入回卖`));
      const actions = node("td"); actions.append(button("物品详情", "detail", row.id)); tr.append(knife, cashout, direct, net, holdingCell(row), actions); return tr;
    }));
    if (!count) { const tr = node("tr"), td = node("td", view === "watchlist" ? "暂无自选物品。可在物品总览加入自选。" : "当前日期与筛选条件暂无物品。", "ledger-empty"); td.colSpan = columns.length; tr.append(td); $("orderLedgerRows").append(tr); }
    $("ledgerListCount").textContent = count + " 种物品 · 每页 50 条"; $("ledgerPageInfo").textContent = (page + 1) + " / " + max; $("ledgerPrevious").disabled = page === 0; $("ledgerNext").disabled = page + 1 >= max;
    $("ledgerListDescription").textContent = "每种完整名称作为一个物品标的，期末持仓按历史推算。总收益仅含直接盈亏与提现折扣差，持仓、净卖出与估值均单列。移出只隐藏账本持仓列表，报表保留全部实际数量和已发生收益。" + window.BuffReportCharts.tradeDateNote;
    document.querySelectorAll("[data-ledger-view]").forEach(el => el.setAttribute("aria-pressed", String(el.dataset.ledgerView === view)));
  }
  async function refresh() {
    const run = ++sequence; $("refreshOrderLedger").disabled = true;
    try {
      await window.BuffPriceWorkspace.ready;
      const result = await api("order-ledger:load", { portfolioId: $("ledgerPortfolio").value, dateFrom: $("ledgerStart").value, dateTo: $("ledgerEnd").value });
      if (run !== sequence) return data;
      data = result; error(); fillSelectors(); renderRows(); refreshTrend();
      window.dispatchEvent(new CustomEvent("order-ledger-loaded", { detail: result })); return result;
    } catch (issue) { if (run === sequence) { error(`核算未更新：${issue.message}`); } throw issue; }
    finally { if (run === sequence) $("refreshOrderLedger").disabled = false; }
  }
  async function guarded(task, errorId) { try { if (errorId) $(errorId).textContent = ""; await task(); } catch (issue) { if (errorId) $(errorId).textContent = issue.message; else error(issue.message); } }
  function syncAccountMode() {
    const automatic = data?.profileScoped || $("ledgerSamePerson").checked;
    document.querySelectorAll("[data-account-group]").forEach(input => { input.disabled = automatic; input.hidden = automatic; });
  }
  function showAccounts() {
    if (!data) return;
    const scoped = data.profileScoped === true;
    $("ledgerAccountsHelp").textContent = scoped ? "以下为本终端当前账户的已有平台订单与 CSV 来源，均按当前账户独立核算。请在工作台选择当前终端关联账户。" : "默认将已同步与导入的来源归为本人，无需再次确认。需要分开核算时关闭下方选项，填写不同组合名；留空则独立。";
    $("ledgerSamePersonControl").hidden = scoped; $("ledgerSamePerson").disabled = scoped;
    $("ledgerAccountsSave").hidden = scoped; $("ledgerAccountsSave").disabled = scoped;
    $("ledgerAccountsGoOverview").hidden = !scoped;
    $("ledgerSamePerson").checked = data.options.accountLinkMode === "auto";
    $("ledgerAccountFields").replaceChildren(...data.accounts.map((account, i) => {
      const row = node("div", null, "ledger-account-row"), label = node(scoped ? "div" : "label", account.label);
      label.append(node("small", `${platform(account.platform)} · ${account.source === "csv" ? "CSV" : "平台订单"} · ${account.count} 条`));
      const link = data.options.accountLinks?.find(item => item.accountKeys.includes(account.key));
      if (scoped) row.append(label, node("span", link?.name || link?.id || "当前终端账户", "small muted"));
      else {
        label.htmlFor = `accountGroup${i}`;
        const input = node("input"); input.id = label.htmlFor; input.maxLength = 60; input.placeholder = "组合名，留空则独立"; input.dataset.accountGroup = account.key; input.value = link?.id || ""; row.append(label, input);
      }
      return row;
    })); syncAccountMode(); $("ledgerAccountsError").textContent = ""; $("ledgerAccountsDialog").showModal();
    if (!data.accounts.length) $("ledgerAccountFields").append(node("p", "当前账户尚无已关联的订单来源，请前往工作台完成关联与同步。", "small muted"));
  }
  const localDate = time => { const at = new Date(time); return new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 23); };
  function detailActivity(row) {
    const days = new Map(), dateOf = r => r.timePrecision === "day" ? r.tradedAt : new Date(r.timeStart + 8 * 3600000).toISOString().slice(0, 10);
    const get = date => { if (!days.has(date)) days.set(date, { date, buy: [], sells: [], events: [] }); return days.get(date); };
    for (const r of data.orders) if (r.portfolioId === row.portfolioId && r.appid === row.appid && r.marketHashName === row.marketHashName && r.currencyCode === row.currencyCode && (!$("ledgerStart").value || dateOf(r) >= $("ledgerStart").value)) get(dateOf(r))[r.direction === "buy" ? "buy" : "sells"].push(r);
    for (const event of row.report.activity || []) get(event.date).events.push(event);
    const section = node("details", null, "ledger-activity"); section.append(node("summary", "按日查看成交与已实现盈亏"));
    const table = node("table", null, "quote-table"), head = node("thead"), hr = node("tr"), body = node("tbody"); table.append(node("caption", "按完整名称与自然日汇总；各平台金额分别统计，Steam 买入不重复计现金投入"));
    for (const title of ["日期", "买入", "卖出", "当日已实现盈亏", "日末持仓"]) { const th = node("th", title); th.scope = "col"; hr.append(th); } head.append(hr);
    let quantity = row.opening.quantity;
    const daily = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map(value => {
      quantity += value.buy.reduce((n, r) => n + r.quantity, 0) - value.events.filter(e => !e.route.startsWith("uncovered")).reduce((n, e) => n + e.quantity, 0);
      return { ...value, quantity };
    });
    for (const value of daily.slice(-150).reverse()) {
      const tr = node("tr"); tr.append(node("td", value.date));
      for (const direction of ["buy", "sells"]) {
        const td = node("td");
        for (const p of ["buff", "uu", "steam"]) { const rs = value[direction].filter(r => r.platform === p); if (rs.length) { const qty = rs.reduce((n, r) => n + r.quantity, 0), amount = completeTotal(rs.map(r => r.actualTotalCents)); td.append(node("small", `${platform(p)} ${qty} 件 · ${money(amount, row.currencyCode)} · 均价 ${money(amount == null ? null : amount / qty, row.currencyCode)}`)); } }
        if (!td.childNodes.length) td.append(node("small", "—")); tr.append(td);
      }
      const realizedEvents = value.events.filter(e => ["direct", "cashout"].includes(e.route));
      const amount = completeTotal(realizedEvents.map(e => e.profitCents));
      tr.append(profitCell(amount, null, row.currencyCode, "与收益报告一致；净卖出不计利润"), node("td", `${value.quantity} 件`)); body.append(tr);
    }
    table.append(head, body); const wrap = node("div", null, "quote-table-wrap"); wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", "可横向滚动的按日物品交易记录"); wrap.append(table); section.append(wrap);
    if (daily.length > 150) section.append(node("p", `共 ${daily.length} 个成交日，显示最近 150 日记录。可用账本日期筛选查看更早区间。`, "small muted"));
    return section;
  }
  function showDetail(id, open = true) {
    const row = data.groups.find(item => item.id === id); if (!row) return;
    detailId = id; $("ledgerDetailTitle").textContent = row.name || row.marketHashName;
    const r = row.report, info = $("ledgerDetailContent"), t = row.theoretical; info.replaceChildren(node("p", `${r.holding.quantity} 件期末持仓 · 现金成本 ${money(r.holding.cashCostCents,row.currencyCode)} · Steam 买入面值 ${money(r.holding.steamFaceCents,row.currencyCode)}。持仓不计收益。`));
    const metrics = node("div", null, "metrics ledger-detail-metrics");
    metrics.append(stat("直接盈亏", window.BuffReportCharts.signed(r.direct.profitCents,row.currencyCode), "现金卖出减对应现金买入成本"), stat("提现折扣差收益", window.BuffReportCharts.signed(r.cashout.profitCents,row.currencyCode), `实际提现 ${fold(r.cashoutRatio)} − 来源挂刀 ${fold(r.basisRatio)}`), stat("总已实现收益", window.BuffReportCharts.signed(r.profitCents,row.currencyCode), r.pendingQuantity ? `缺依据 ${r.pendingQuantity} 件` : "与收益报告一致")); info.append(metrics);
    info.append(node("p", `Steam 卖出 ${r.steamSaleQuantity} 件；已覆盖挂刀 ${r.knife.quantity} 件 / ${fold(r.knifeRatio)}；提现 ${r.cashout.quantity} 件；净卖出 ${r.netSaleQuantity} 件（不计收益）。`, "small"));
    if (row.gap) {
      const g = row.gap, card = node("div", null, "ledger-gap-note"); card.append(node("strong", `来源缺口 ${g.quantity} 件（按名称汇总）`), node("p", g.mappingEvidence + "。" + g.coverageEvidence + "。"), node("p", `同名买入 ${g.buyQuantity} 件、卖出 ${g.saleQuantity} 件；首笔买入 ${g.firstBuy || "无记录"}；缺口发生于 ${g.firstMissingSale} 至 ${g.lastMissingSale}。`));
      for (const [code, qty] of Object.entries(g.counts)) if (qty) card.append(node("small", `${({ no_buy: "无同名买入记录", later_buy: "买入晚于卖出", exhausted: "此前买入数量不足" })[code]} ${qty} 件。`)); info.append(card);
    }
    info.append(detailActivity(row));
    if (t && row.remainingQuantity > 0) {
      info.append(node("h3", "持仓报价试算（不计报告收益）"), node("p", "以下按原始来源现金成本与报价估值比较路线，仅作持仓参考；与已实现收益分开。", "small muted"));
      const thresholds = node("dl", null, "detail-list"); for (const [label, value] of [["保本提现折扣", t.breakEvenCashoutRatio], ["比 BUFF 挂售至少多赚 1 分", t.beatBuffAskCashoutRatio], ["比 BUFF 求购至少多赚 1 分", t.beatBuffBidCashoutRatio]]) { const line = node("div"); line.append(node("dt", label), node("dd", fold(value))); thresholds.append(line); }
      const comparison = node("div", null, "ledger-comparison"); for (const route of t.routes || []) { const item = node("div", null, `ledger-route${t.bestRoutes.includes(route.id) ? " best" : ""}`); item.append(node("span", route.label), node("strong", money(route.profitCents)), node("small", `预计回款 ${money(route.proceedsCents)}`), node("small", route.issue || (t.bestRoutes.includes(route.id) ? "已知路线中收益最高" : ""))); comparison.append(item); }
      info.append(thresholds, comparison);
    } else if (row.remainingQuantity > 0) info.append(node("p", "来源现金成本或物品身份不足，无法计算理论收益。"));
    const supported = row.remainingQuantity > 0 && row.currencyCode === "CNY" && [730, 570].includes(row.appid);
    const quote = supported ? P.holdingQuote(row, window.BuffPriceWorkspace.rows()) : {};
    for (const [field, price, at] of [["Ask", quote.buffPriceCents, quote.buffUpdatedAt], ["Bid", quote.buffBuyPriceCents, quote.buffBuyUpdatedAt], ["Steam", quote.steamLowestSellCents, quote.steamUpdatedAt], ["Uu", quote.uuNetSellCents, quote.uuUpdatedAt]]) { $("ledgerQuote" + field).value = price == null ? "" : (price / 100).toFixed(2); $("ledgerQuote" + field + "At").value = localDate(at || Date.now()); }
    $("ledgerQuoteForm").hidden = !supported; $("ledgerQuoteError").textContent = ""; if (open) $("ledgerDetailDialog").showModal();
  }
  $("orderLedgerRows").onclick = event => {
    const el = event.target.closest("[data-ledger-action]"); if (!el) return;
    guarded(async () => { const id = el.dataset.id;
      if (el.dataset.ledgerAction === "detail") showDetail(id);
      else if (el.dataset.ledgerAction === "watch") { await api("order-ledger:watch", { id, watched: !data.groups.find(r => r.id === id)?.instrument.watched }); await refresh(); }
      else if (el.dataset.ledgerAction === "category") { $("ledgerCategory").value = id; $("ledgerGame").value = el.dataset.game; $("ledgerCurrency").value = el.dataset.currency; $("ledgerPortfolio").value = el.dataset.portfolio; view = "all"; page = 0; await refresh(); }
      else if (["exclude", "restore"].includes(el.dataset.ledgerAction)) { await api("order-ledger:exclude", { id, excluded: el.dataset.ledgerAction === "exclude" }); await refresh(); }
    });
  };
  $("ledgerAccounts").onclick = showAccounts;
  $("ledgerAccountsGoOverview").onclick = () => { $("ledgerAccountsDialog").close(); window.BuffDesktopNavigation?.navigate("overview"); };
  $("ledgerSamePerson").onchange = syncAccountMode;
  $("ledgerAccountsForm").onsubmit = event => { event.preventDefault(); guarded(async () => {
    if (data?.profileScoped) throw new Error("请在工作台选择当前终端关联账户，账本中的归属仅供查看");
    const groups = new Map();
    document.querySelectorAll("[data-account-group]").forEach(input => { const id = input.value.trim(); if (id) { if (!groups.has(id)) groups.set(id, []); groups.get(id).push(input.dataset.accountGroup); } });
    const association = $("ledgerSamePerson").checked ? { accountLinkMode: "auto" } : { accountLinks: [...groups].map(([id, accountKeys]) => ({ id, accountKeys })) };
    await api("order-ledger:configure", association); $("ledgerPortfolio").value = "all"; page = 0; $("ledgerAccountsDialog").close(); await refresh();
  }, "ledgerAccountsError"); };
  $("ledgerSettings").onclick = () => { const s = window.BuffPriceWorkspace.settings(); $("ledgerDiscount").value = s.targetCashoutRatio * 10; $("ledgerFeeCs2").value = s.buffCsgoSellFeePercent; $("ledgerFeeDota").value = s.buffDota2SellFeePercent; $("ledgerSettingsError").textContent = ""; $("ledgerSettingsDialog").showModal(); };
  $("ledgerSettingsForm").onsubmit = event => { event.preventDefault(); guarded(async () => { if (["ledgerDiscount", "ledgerFeeCs2", "ledgerFeeDota"].some(id => $(id).value.trim() === "")) throw new Error("请填写提现折扣与手续费"); await window.BuffPriceWorkspace.updateSettings({ targetCashoutRatio: Number($("ledgerDiscount").value) / 10, buffCsgoSellFeePercent: Number($("ledgerFeeCs2").value), buffDota2SellFeePercent: Number($("ledgerFeeDota").value) }); $("ledgerSettingsDialog").close(); await refresh(); }, "ledgerSettingsError"); };
  $("ledgerQuoteForm").onsubmit = event => { event.preventDefault(); guarded(async () => {
    const row = [...data.holdings, ...data.excludedHoldings].find(item => item.id === detailId); if (!row) throw new Error("持仓已变化，请重新打开详情");
    const original = P.holdingQuote(row, window.BuffPriceWorkspace.rows());
    const quote = { ...original, source: "manual" }; let count = 0, changed = false;
    for (const [field, priceKey, timeKey] of [["Ask", "buffPriceCents", "buffUpdatedAt"], ["Bid", "buffBuyPriceCents", "buffBuyUpdatedAt"], ["Steam", "steamLowestSellCents", "steamUpdatedAt"], ["Uu", "uuNetSellCents", "uuUpdatedAt"]]) {
      const value = P.cents($("ledgerQuote" + field).value, true); if (value == null) continue; const at = new Date($("ledgerQuote" + field + "At").value).getTime(); if (!Number.isSafeInteger(at) || at > Date.now()) throw new Error("报价时间必须为已发生的有效时间"); count++;
      if (value !== original[priceKey] || at !== original[timeKey]) changed = true;
      quote[priceKey] = value; quote[timeKey] = at;
      if (at !== original[timeKey]) {
        if (field === "Steam") { quote.steamExpiresAt = null; quote.steamError = ""; quote.steamCurrencyInvalid = false; quote.steamHighestBuyCents = null; }
        if (field === "Bid") { quote.buffBuyExpiresAt = null; quote.buffBuyError = ""; }
      }
    }
    if (!count) throw new Error("请至少填写一种报价");
    if (changed) await window.BuffPriceWorkspace.upsertQuotes([P.normalizeRow(quote)]); await refresh(); showDetail(detailId, false);
  }, "ledgerQuoteError"); };
  for (const el of document.querySelectorAll("[data-close-ledger]")) el.onclick = () => $(el.dataset.closeLedger).close();
  for (const el of document.querySelectorAll("[data-ledger-view]")) el.onclick = () => { view = el.dataset.ledgerView; page = 0; renderRows(); };
  $("ledgerSearch").oninput = () => { page = 0; renderRows(); }; $("ledgerPortfolio").onchange = () => { page = 0; guarded(refresh); };
  for (const id of ["ledgerGame", "ledgerCategory", "ledgerCurrency", "ledgerPosition", "ledgerProfitFilter", "ledgerGapFilter"]) $(id).onchange = () => { page = 0; renderRows(); };
  $("orderLedgerHead").onclick = event => {
    const b = event.target.closest("[data-ledger-sort]"); if (!b || !data) return;
    sortBy(b.dataset.ledgerSort); $("orderLedgerHead").querySelector(`[data-ledger-sort="${tableState().key}"]`)?.focus({ preventScroll: true });
  };
  $("ledgerSort").onchange = () => { if (data) sortBy($("ledgerSort").value); };
  $("ledgerSortDirection").onclick = () => { if (data) sortBy(tableState().key); };
  for (const id of ["ledgerStart", "ledgerEnd"]) $(id).onchange = () => { page = 0; guarded(refresh); };
  $("ledgerAllDates").onclick = () => { $("ledgerStart").value = ""; $("ledgerEnd").value = ""; page = 0; guarded(refresh); };
  $("ledgerPrevious").onclick = () => { page--; renderRows(); }; $("ledgerNext").onclick = () => { page++; renderRows(); };
  $("trendItem").onchange = refreshTrend; $("trendDirection").onchange = refreshTrend;
  $("refreshOrderLedger").onclick = () => guarded(refresh);
  $("openLegacyLedger").onclick = () => { $("legacyLedger").hidden = false; if (!$("ledgerFrame").hasAttribute("src")) $("ledgerFrame").src = "/ledger.html"; };
  function renderStartup(value) {
    $("startupEnabled").checked = value.enabled; $("startupRetry").disabled = value.status === "running" || !value.enabled; $("startupStop").disabled = value.status !== "running";
    $("startupMessage").textContent = ({ idle: "等待下次校验已有登录会话", unbound: "请先在上方关联本机所属账户", disabled: "启动及每 6 小时自动同步已关闭", running: "正在核对当前账户并增量同步", completed: "本次校验与同步已完成", partial: "部分来源需要处理，请查看平台状态", cancelled: "本次自动同步已停止" })[value.status] || "等待状态";
    $("accountCards").replaceChildren(...Object.entries(value.platforms || {}).map(([name, item]) => {
      const el = node("article", null, "account-card"); if (window.LedgerBrand) el.append(window.LedgerBrand.platformLogo(name)); el.append(node("strong", platform(name)), node("p", item.account ? `${item.account.nickname || item.account.id} · ${item.verified ? "账户已校验" : "账户待校验"}` : "尚未登录"), node("small", item.message), node("small", `上次历史读取：${date(item.lastSyncedAt)}`), node("small", item.job?.status === "running" ? item.job.message : `本机已保存 ${item.count || 0} 条`));
      const archived = data?.sourceStatus?.[name]?.accounts || [], accounts = archived.length ? archived : [{ runs: item.runs || [] }];
      for (const account of accounts) {
        const runs = (account.runs || []).filter(run => run.channel === "history");
        if (!runs.length) el.append(node("small", "历史完整性未知：尚无完整同步记录", "pending"));
        for (const run of runs) el.append(node("small", `${accounts.length > 1 ? account.accountId + " · " : ""}${Number(run.appid) === 570 ? "Dota 2" : Number(run.appid) === 730 ? "CS2" : `App ${run.appid}`} ${run.direction === "buy" ? "买入" : "卖出"}：${run.complete ? run.stopReason === "known" ? "历史已补齐，本次增量到已知边界" : "已读至末页" : `历史未齐${Number.isSafeInteger(run.pages) ? `（已读 ${run.pages} 页）` : ""}，需完整复核`}`, run.complete ? "" : "pending"));
      }
      const go = node("button", "管理账户与历史 →", "text-button"); go.onclick = () => window.BuffDesktopNavigation.navigate(name === "buff" ? "orders" : name); el.append(go); return el;
    }));
    const csv = node("article", null, "account-card"); csv.append(node("strong", "CSV 归档"), node("p", "保留已导入的 Steam 买入与卖出"), node("small", `上次 CSV 导入：${date(data?.sourceStatus?.csv?.lastImportedAt)}`), node("small", `已核对的在线 / CSV 重复记录：${data?.sourceStatus?.csv?.suppressedCount || 0} 条，账本仅计一次`)); const go = node("button", "导入 Steam 订单 →", "text-button"); go.onclick = () => window.BuffDesktopNavigation.navigate("history"); csv.append(go); $("accountCards").append(csv);
  }
  async function refreshStartup() { const value = await api("startup:status"); renderStartup(value); return value; }
  $("startupEnabled").onchange = () => guarded(async () => { try { renderStartup(await api("startup:configure", { enabled: $("startupEnabled").checked })); } catch (issue) { await refreshStartup(); throw issue; } });
  $("startupRetry").onclick = () => guarded(async () => { renderStartup(await api("startup:start")); }); $("startupStop").onclick = () => guarded(async () => { renderStartup(await api("startup:stop")); });
  function queueRefresh() { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { guarded(refresh); guarded(refreshStartup); }, 250); }
  window.buffDesktop.onChange(event => {
    if (event.kind === "startup-sync") renderStartup(event.value);
    if (["history", "order-ledger"].includes(event.kind) || ["buff-orders", "uu-orders", "steam-orders"].includes(event.kind) && event.value.job?.status !== "running") queueRefresh();
  });
  window.addEventListener("price-settings-changed", queueRefresh); window.addEventListener("price-quotes-changed", queueRefresh);
  window.addEventListener("order-ledger-loaded", () => { guarded(refreshStartup); });
  window.BuffOrderLedgerWorkspace = { refresh, refreshStartup, showDetail, data: () => data };
})();
