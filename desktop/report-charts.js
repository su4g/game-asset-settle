"use strict";
(() => {
  const A = window.BuffReportAnalytics, C = window.BuffHelperCommon;
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el; };
  const money = (v, c) => v == null ? "—" : C.formatCents(Math.round(v), c);
  const signed = (v, c) => v == null ? "—" : (v > 0 ? "+" : "") + money(v, c);
  const fold = v => v == null ? "—" : C.formatDiscount(v, { roundUp: true });
  let nextId = 0;
  const colors = ["var(--positive)", "var(--accent)", "var(--warning)", "#9775cc"];
  const tradeDateNote = "时间按北京时间的实际成交日展示，多日显示起止范围。买入为截至结束日的同名历史记录（含期初），卖出为所选期间及当前列表的记录；不代表逐件配对，剩余持仓尚未卖出。";
  function tradeTimeCells(dates) {
    return ["buy", "sell"].map(direction => {
      const td = node("td", null, "trade-date-cell"), range = dates[direction];
      if (!range?.firstDate) { td.textContent = direction === "buy" ? "无买入记录" : "无卖出记录"; return td; }
      const time = value => { const el = node("time", value); el.dateTime = value; return el; };
      td.append(time(range.firstDate));
      if (range.lastDate && range.lastDate !== range.firstDate) { const end = node("small", "至 "); end.append(time(range.lastDate)); td.append(end); }
      return td;
    });
  }
  function wallets(host, report) {
    host.replaceChildren();
    host.append(node("summary", "未提现余额与来源成本（不计收益）"), node("p", "按账户组合与结束日期核算，物品筛选不拆分钱包；当前余额平均折扣与报告使用的历史挂刀折扣分别列示。", "small muted"));
    for (const c of [...new Set((report.wallets || []).map(w => w.currencyCode))].sort()) {
      const ws = report.wallets.filter(w => w.currencyCode === c), face = A.complete(ws.map(w => w.faceBalanceCents)), cost = A.complete(ws.map(w => w.cashBasisCents));
      host.append(node("p", `${c} · 订单推算余额 ${money(face,c)} · 来源现金成本 ${money(cost,c)} · 当前余额平均折扣 ${fold(face > 0 && cost != null ? cost / face : null)}`, "small"));
    }
    host.append(node("p", "金额或来源成本不足时保留为空，不用固定折扣补成实际余额成本。", "small muted"));
  }
  function metrics(host, report, groups = report.groups) {
    host.replaceChildren();
    const stat = (label, text, hint, value) => { const card = node("div", null, "metric"), strong = node("strong", text); if (value != null) strong.className = value < 0 ? "negative" : value > 0 ? "positive" : ""; card.append(node("span", label, "metric-label"), strong, node("small", hint)); return card; };
    for (const c of [...new Set(groups.map(g => g.currencyCode))].sort()) {
      const s = A.summary(groups.filter(g => g.currencyCode === c), report), profit = A.shown(s.profitCents, s.knownProfitCents, s.includedQuantity);
      const hint = r => r.pendingQuantity ? `可计算 ${r.includedQuantity} 件 · 缺依据 ${r.pendingQuantity} 件` : `${r.quantity} 件 · 按同名均价计算`;
      host.append(
        stat(c + " · 总已实现收益", signed(profit, c), s.pendingQuantity ? `可计算部分 · 缺价格或挂刀样本 ${s.pendingQuantity} 件` : "直接盈亏 + 提现折扣差收益", profit),
        stat("直接盈亏", signed(A.shown(s.direct.profitCents, s.direct.knownProfitCents, s.direct.includedQuantity), c), hint(s.direct), s.direct.profitCents),
        stat("提现折扣差收益", signed(A.shown(s.cashout.profitCents, s.cashout.knownProfitCents, s.cashout.includedQuantity), c), hint(s.cashout), s.cashout.profitCents),
        stat("期间现金投入", money(s.cashInvestmentCents ?? s.knownCashInvestmentCents, c), (s.cashInvestmentCents == null ? "仅已知部分 · " : "") + "仅 BUFF / 悠悠买入实付"),
        stat("历史加权挂刀折扣", fold(s.historicalKnifeRatio), "截至结束日，同账户组合与币种的已覆盖样本"),
        stat("实际提现折扣", fold(s.cashoutRatio), "提现净回款 / 对应 Steam 买入面值"),
        stat("期末持仓 · 不计收益", `${s.holdingQuantity} 件`, `现金成本 ${money(s.cashHoldingCents, c)} · Steam 面值 ${money(s.steamHoldingFaceCents, c)}` + (s.excludedHoldingQuantity ? ` · 账本隐藏 ${s.excludedHoldingQuantity} 件` : "")),
        stat("净卖出 · 不计收益", `${s.netSaleQuantity} 件`, `现金净到账 ${money(s.netCash.proceedsCents, c)} · Steam 净到账 ${money(s.netSteam.proceedsCents, c)}`));
    }
    if (!groups.length) host.append(node("p", "当前筛选暂无可计算物品。", "small muted"));
  }
  function draw(host, points, fields, { title, note, currency, type = "line", unit = "money", tablePoints = points }) {
    const format = v => v == null ? "—" : unit === "quantity" ? `${v} 件` : money(v, currency);
    host.replaceChildren(); host.append(node("h3", title), node("p", note, "small muted chart-explanation"));
    if (!points.length || !points.some(p => fields.some(f => Number.isFinite(p[f.key])))) { host.append(node("p", "此范围暂无可计算数据。", "chart-empty")); return; }
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 660 260"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", title + "。" + note); svg.classList.add("report-chart");
    const add = (tag, attrs = {}, text, parent = svg) => { const el = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v)); if (text != null) el.textContent = text; parent.append(el); return el; };
    add("title", {}, title); add("desc", {}, note + "。精确数值可通过下方数据点滑块或展开数据表查看。");
    const values = points.flatMap(p => fields.map(f => p[f.key])).filter(Number.isFinite), min = Math.min(0, ...values), rawMax = Math.max(1, ...values), max = unit === "quantity" ? Math.ceil(rawMax / 2) * 2 : rawMax, span = max - min;
    const left = 70, right = 638, top = 24, bottom = 218, width = right - left;
    const x = i => type === "line" ? left + (i + (points.length === 1 ? .5 : 0)) * width / Math.max(1, points.length - 1) : left + (i + .5) * width / points.length;
    const y = v => bottom - (v - min) * (bottom - top) / span;
    const tick = v => unit === "quantity" ? String(Math.round(v)) : Math.abs(v) >= 1000000 ? (v / 1000000).toFixed(1) + "万" : Math.abs(v) >= 100000 ? (v / 100000).toFixed(1) + "千" : (v / 100).toFixed(Math.abs(v) < 10000 ? 2 : 0);
    for (const v of [...new Set([min, min + span / 2, max, 0])]) { add("line", { x1: left, x2: right, y1: y(v), y2: y(v), stroke: v === 0 ? "var(--muted)" : "var(--line)", "stroke-dasharray": v === 0 ? "none" : "3 4" }); add("text", { x: left - 9, y: y(v) + 4, "text-anchor": "end", class: "chart-axis" }, tick(v)); }
    add("text", { x: left, y: 12, class: "chart-axis" }, unit === "quantity" ? "件" : currency);
    for (const i of [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])]) add("text", { x: x(i), y: 246, "text-anchor": i === 0 ? "start" : i === points.length - 1 ? "end" : "middle", class: "chart-axis" }, points[i].date);
    if (type === "candles") {
      points.forEach((p, i) => {
        if (![p.openCents, p.closeCents, p.highCents, p.lowCents].every(Number.isFinite)) return;
        const color = p.closeCents >= p.openCents ? colors[0] : "var(--negative)", w = Math.max(1, Math.min(22, width / points.length * .55));
        add("line", { x1: x(i), x2: x(i), y1: y(p.highCents), y2: y(p.lowCents), stroke: color, "stroke-width": 1.5 });
        add("rect", { x: x(i) - w / 2, y: y(Math.max(p.openCents, p.closeCents)), width: w, height: Math.max(1.5, Math.abs(y(p.openCents) - y(p.closeCents))), fill: color, rx: 1 });
      });
    } else fields.forEach((f, j) => {
      if (type === "bar") points.forEach((p, i) => { const v = p[f.key]; if (!Number.isFinite(v)) return; const w = Math.max(.5, Math.min(28, width / points.length * .75 / fields.length)), px = x(i) + (j - fields.length / 2) * w;
        add("rect", { x: px, y: y(Math.max(0, v)), width: w * .9, height: Math.max(v ? 1 : 0, Math.abs(y(v) - y(0))), fill: v < 0 ? "var(--negative)" : f.color || colors[j], rx: Math.min(2, w / 4) });
      });
      else {
        let segment = []; const flush = () => { if (segment.length) add("polyline", { points: segment.join(" "), fill: "none", stroke: f.color || colors[j], "stroke-width": 2.5, "stroke-dasharray": f.dash || "none", "stroke-linejoin": "round" }); segment = []; };
        points.forEach((p, i) => { const v = p[f.key]; if (!Number.isFinite(v)) { flush(); return; } segment.push(`${x(i)},${y(v)}`); if (points.length < 30) add("circle", { cx: x(i), cy: y(v), r: 2.7, fill: f.color || colors[j] }); }); flush();
      }
    });
    const marker = add("line", { x1: x(points.length - 1), x2: x(points.length - 1), y1: top, y2: bottom, stroke: "var(--muted)", "stroke-dasharray": "3 3", "pointer-events": "none" });
    const legend = node("div", null, "chart-legend");
    const legendFields = type === "candles" ? [{ label: "周内收益增加", color: colors[0] }, { label: "周内收益减少", color: "var(--negative)" }] : fields;
    legendFields.forEach((f, i) => { const span = node("span", f.label); span.style.setProperty("--series-color", f.color || colors[i]); legend.append(span); });
    const readout = node("p", null, "chart-readout"), sliderLabel = node("label", "查看数据点", "chart-scrubber"), slider = node("input"); slider.id = "report-chart-point-" + (++nextId); sliderLabel.htmlFor = slider.id; slider.type = "range"; slider.min = 0; slider.max = points.length - 1; slider.step = 1; slider.value = points.length - 1; slider.setAttribute("aria-label", title + "：选择数据点"); sliderLabel.append(slider);
    const select = i => { const p = points[i]; readout.textContent = `${p.from || p.date}${p.to && p.to !== (p.from || p.date) ? " 至 " + p.to : ""}　` + fields.map(f => `${f.label} ${format(p[f.key])}`).join(" · ") + (p.pendingQuantity ? ` · 缺依据 ${p.pendingQuantity} 件` : ""); slider.value = i; slider.setAttribute("aria-valuetext", readout.textContent); marker.setAttribute("x1", x(i)); marker.setAttribute("x2", x(i)); };
    slider.addEventListener("input", () => select(Number(slider.value)));
    svg.addEventListener("pointermove", e => { const rect = svg.getBoundingClientRect(); if (!rect.width) return; const ratio = Math.max(0, Math.min(1, ((e.clientX - rect.left) * 660 / rect.width - left) / width)); select(Math.min(points.length - 1, Math.round(ratio * (points.length - 1)))); }); select(points.length - 1);
    const details = node("details", null, "chart-data"), toggle = node("summary", `查看图表数据（${tablePoints.length} 行）`); details.append(toggle);
    details.addEventListener("toggle", () => {
      if (!details.isConnected || !details.open || details.childElementCount > 1) return;
      const wrap = node("div", null, "chart-table-wrap"), table = node("table"), head = node("thead"), row = node("tr"), body = node("tbody");
      wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", title + "数据表"); table.append(node("caption", title));
      ["日期 / 类目", ...fields.map(f => f.label), "缺依据数量"].forEach(text => { const th = node("th", text); th.scope = "col"; row.append(th); }); head.append(row);
      for (const p of tablePoints) { const tr = node("tr"); tr.append(node("td", p.date), ...fields.map(f => node("td", format(p[f.key]))), node("td", String(p.pendingQuantity || 0))); body.append(tr); }
      table.append(head, body); wrap.append(table); details.append(wrap);
    });
    host.append(svg, legend, readout, sliderLabel, details);
  }
  const instances = new WeakMap();
  function render(host, report, groups = report.groups, { compact = false } = {}) {
    let state = instances.get(host);
    if (state && !host.contains(state.grid)) { instances.delete(host); state = null; }
    const signature = groups.map(g => g.id).join("|");
    if (state?.report === report && state.signature === signature) return;
    if (!state) {
      const controls = node("div", null, "analytics-controls"), grid = node("div", null, "analytics-grid"), note = node("p", null, "small muted analytics-note");
      const select = (title, pairs) => { const label = node("label", title), el = node("select"); el.id = "report-chart-select-" + (++nextId); label.htmlFor = el.id; el.setAttribute("aria-label", title); for (const [v, t] of pairs) { const op = node("option", t); op.value = v; el.append(op); } label.append(el); controls.append(label); return el; };
      state = { currency: select("图表币种", []), interval: select("统计粒度", [["week", "按周"], ["day", "按日"], ["month", "按月"]]), range: select("图表窗口", [["all", "所选日期全部"], ["30", "最近 30 天"], ["90", "最近 90 天"], ["365", "最近 365 天"]]), dimension: select("图表维度", [["all", "全部图表"], ["profit", "收益分析"], ["capital", "成本与回款"], ["volume", "交易数量"]]), grid, note, compact };
      host.replaceChildren(controls, note, grid); instances.set(host, state);
      for (const el of [state.currency, state.interval, state.range, state.dimension]) el.addEventListener("change", () => update(state));
    }
    state.report = report; state.groups = groups; state.signature = signature;
    const current = state.currency.value, currencies = [...new Set(groups.map(g => g.currencyCode))].sort(); state.currency.replaceChildren(...currencies.map(c => { const op = node("option", c); op.value = c; return op; })); if (currencies.includes(current)) state.currency.value = current;
    update(state);
  }
  function update(s) {
    if (!s.groups.length) { s.grid.replaceChildren(node("p", "当前筛选暂无图表数据。", "small muted")); s.note.textContent = "更改日期或物品筛选以查看图表。"; return; }
    const a = A.analyze(s.report, s.groups, { currencyCode: s.currency.value, interval: s.interval.value, range: s.range.value });
    s.grid.replaceChildren(); s.note.textContent = `按北京时间统计；币种独立。曲线从所选报告开始日期累计，缩小图表窗口保留此前累计值。${a.partial ? "存在缺失依据，收益图仅呈现可计算部分。" : ""}周 K 线固定按周一至周日。`;
    const fields = (items) => items.map(([key, label, color, dash], i) => ({ key, label, color: color || colors[i], dash }));
    const add = (key, dimension, title, note, points, fs, type = "line", unit = "money", tablePoints) => {
      if (s.dimension.value !== "all" && s.dimension.value !== dimension) return;
      if (s.compact && s.dimension.value === "all" && !["profit", "capital"].includes(key)) return;
      const card = node("article", null, "card analytics-card"); card.dataset.chart = key; s.grid.append(card); draw(card, points, fs, { title, note, currency: a.currencyCode, type, unit, tablePoints: tablePoints || points });
    };
    const partial = a.partial ? "（可计算部分）" : "";
    add("profit", "profit", "累计收益曲线" + partial, "总收益 = 直接盈亏 + 提现折扣差；持仓、净卖出和余额不计利润。", a.points, fields([["cumulativeProfitCents", "总收益"], ["cumulativeDirectProfitCents", "直接盈亏", colors[2], "5 3"], ["cumulativeCashoutProfitCents", "提现收益", colors[1], "2 3"]]));
    add("capital", "capital", "累计成本投入与现金回款", "投入仅 BUFF / 悠悠买入；回款含现金净卖出，收支差不能当作利润。金额缺失时为已知部分。", a.points, fields([["cumulativeCostCents", "累计投入"], ["cumulativeReceiptsCents", "累计现金回款"]]));
    add("weekly", "profit", "周 K 线收益" + partial, "开 / 收为周初 / 周末累计收益；高 / 低含周初与周内日终值。边界周按所选窗口截取，不代表日内波动。", a.weekly, fields([["openCents", "开"], ["highCents", "高"], ["lowCents", "低"], ["closeCents", "收"]]), "candles");
    add("weekly-profit", "profit", "每周新增收益" + partial, "显示每周总收益及两类来源；负收益向零线下方延伸。", a.weekly, fields([["displayProfitCents", "总收益"], ["displayDirectProfitCents", "直接盈亏", colors[2]], ["displayCashoutProfitCents", "提现收益", colors[1]]]), "bar");
    add("cashflow", "capital", "期间投入与回款", "按成交日归集现金收支，不将 Steam 买入重复计作外部投入。显示已知金额。", a.points, fields([["knownCashInvestmentCents", "现金投入"], ["knownCashReceiptsCents", "现金回款"]]), "bar");
    add("volume", "volume", "买入与卖出数量", "三平台所有买卖均计数量；含期末持仓对应买入和净卖出，不等同于计收益数量。", a.points, fields([["buyQuantity", "买入"], ["saleQuantity", "卖出"]]), "bar", "quantity");
    add("routes", "volume", "卖出路径分布", "挂刀为有现金买入来源的 Steam 卖出；其他 Steam 卖出列为净卖出。各路径数量不重叠。", a.points, fields([["knifeQuantity", "已覆盖挂刀"], ["cashoutQuantity", "提现"], ["directQuantity", "直接转卖"], ["netQuantity", "净卖出"]]), "bar", "quantity");
    add("categories", "profit", "类目收益贡献" + partial, "按所选报告全部日期、当前物品筛选汇总；图示绝对收益前 10 类，数据表保留全部类目。", a.categories.slice(0, 10), fields([["profitCents", "已实现收益"]]), "bar", "money", a.categories);
    if (!s.grid.childElementCount) s.grid.append(node("p", "当前条件暂无图表。", "small muted"));
  }
  window.BuffReportCharts = { render, metrics, wallets, draw, signed, money, tradeTimeCells, tradeDateNote };
})();
