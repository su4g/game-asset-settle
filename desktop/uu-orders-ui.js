"use strict";
(() => {
  const $ = id => document.getElementById(id), api = (action, payload) => window.buffDesktop.request(action, payload);
  let snapshot = null, result = null, page = 1, sequence = 0, busy = false, searchTimer, view = "details", drillKey = null;
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const money = (value, currency = "CNY") => value == null ? "—" : window.BuffHelperCommon.formatCents(value, currency);
  const date = value => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未提供";
  const game = () => $("uuGame").value === "all" ? "all" : Number($("uuGame").value);
  const filters = () => ({ appid: game(), channel: $("uuView").value === "pending" ? "pending" : "history", direction: ["buy", "sell"].includes($("uuView").value) ? $("uuView").value : "all", query: $("uuQuery").value.trim(), start: $("uuStart").value, end: $("uuEnd").value, dateField: $("uuDateField").value, category: $("uuCategory").value, status: $("uuStatus").value, sort: $("uuSort").value, mode: view, groupKey: drillKey, page });
  function message(text, error = false) { $("uuMessage").textContent = text; $("uuMessage").hidden = !text; $("uuMessage").classList.toggle("form-error", error); }
  function status(value) {
    snapshot = value;
    const account = value.account;
    $("uuAccount").textContent = account ? `${account.nickname} · ${account.id}` : "尚未连接 悠悠";
    $("uuConnection").textContent = value.verified ? "登录已验证" : account ? "显示本机缓存 · 登录待检查" : "在 App 内登录后开始同步";
    const running = value.job.status === "running";
    $("uuJob").textContent = value.job.message || "尚未开始同步；读取订单不会修改交易账本。";
    $("uuProgress").textContent = `${value.job.pages || 0} 页 · ${value.job.count || 0} 条 · ${value.count} 件本机物品`;
    $("uuStop").disabled = !running;
    for (const id of ["uuCheck", "uuLogin", "uuLogout", "uuSync", "uuProbeSell"]) $(id).disabled = busy || running;
    $("uuResults").setAttribute("aria-busy", String(running));
    $("uuSellProbe").textContent = value.sellProbe?.message || "卖出历史待验证";
    $("uuSync").disabled = busy || running || $("uuView").value === "sell" && value.sellProbe?.status !== "verified";

  }
  async function refresh() {
    const run = ++sequence, value = await api("uu:list", filters());
    if (run !== sequence) return;
    if (value.pages && page > value.pages) { page = value.pages; return refresh(); }
    result = value; page = value.page;
    const selectedCategory = $("uuCategory").value;
    const option = (value, label) => { const el = node("option", label); el.value = value; return el; };
    $("uuCategory").replaceChildren(option("all", "全部分类"), ...(value.categories || []).map(c => option(c,c)));
    if ([...$("uuCategory").options].some(o => o.value === selectedCategory)) $("uuCategory").value = selectedCategory;
    const metric = (label, number, hint) => { const el = node("div", null, "metric"); el.append(node("span", label, "metric-label"), node("strong", number), node("small", hint)); return el; };
    $("uuMetrics").replaceChildren(metric("匹配物品", value.recordTotal ?? value.total, "统计整个筛选范围"), metric("同类物品", value.groupTotal ?? "—", "完整市场名 · 买卖分别合并"), metric("已完成", value.completed ?? "—", "参与成交金额统计"), metric("名称待核对", (value.rows || []).filter(r => !r.marketHashName).length, "当前页缺少完整英文名"));
    $("uuAmounts").textContent = (value.amounts || []).map(a => `${a.currency} ${a.direction === "buy" ? "买入" : "卖出"}：已知成交总额 ${money(a.knownGross ? a.totalCents : null, a.currency)} / 已知${a.direction === "buy" ? "实付" : "净到账"} ${money(a.knownActual ? a.actualCents : null, a.currency)}${a.unknownActual ? `（${a.unknownActual} 件平台未提供实际金额）` : ""}${a.unknownGross ? `（${a.unknownGross} 件成交金额缺项）` : ""}`).join("；");
    $("uuSummaryView").setAttribute("aria-pressed", String(view === "summary")); $("uuDetailView").setAttribute("aria-pressed", String(view === "details")); $("uuBack").hidden = !drillKey;
    const headers = view === "summary" ? ["物品 / 分类", "方向 / 明细数", "已完成数量", "成交均价 / 总额", "实际收支均价", "成交范围 / 明细"] : ["物品 / 分类", "订单号 / 方向", "数量", "成交与实际收支", "成交 / 创建时间", "平台状态"];
    const head = node("tr"); for (const label of headers) { const th = node("th", label); th.scope = "col"; head.append(th); } $("uuTableHead").replaceChildren(head);
    const entries = view === "summary" ? value.groups || [] : value.rows;
    $("uuRows").replaceChildren(...entries.map(row => {
      const tr = node("tr"), item = node("td");
      item.append(node("strong", row.name, "history-name"), node("small", row.marketHashName || "完整市场名称待核对", "history-english"), node("small", `${row.appid === 570 ? "Dota 2" : "CS2"} · ${row.category || "未分类"} · 商品 ${row.goodsId}`));
      if (view === "summary") {
        const average = (total, quantity) => quantity ? money(window.BuffMarketHistory.roundedAverageCents(total, quantity), row.currencyCode) : "未提供";
        const gross = node("td"); gross.append(node("strong", average(row.grossCents, row.grossQuantity)), node("small", `已知总额 ${money(row.grossQuantity ? row.grossCents : null, row.currencyCode)} · ${row.grossQuantity} 件计价`));
        if (row.unknownGross) gross.append(node("small", `${row.unknownGross} 件金额或数量缺项`));
        const actual = node("td"); actual.append(node("strong", average(row.actualCents, row.actualQuantity)), node("small", `${row.direction === "buy" ? "实付" : "净到账"} · ${row.actualQuantity} 件计价`));
        if (row.unknownActual) actual.append(node("small", `${row.unknownActual} 件平台收支或数量缺项`));
        const last = node("td", row.firstDate ? `${row.firstDate} 至 ${row.lastDate}` : "平台未提供成交时间"), button = node("button", "查看明细", "text-button"); button.type = "button"; button.dataset.uuGroup = row.key; last.append(button);
        tr.append(item, node("td", `${row.direction === "buy" ? "买入" : "卖出"} · ${row.completedRecords}/${row.records} 件已完成`), node("td", `${row.quantity} 件${row.unknownQuantity ? ` · ${row.unknownQuantity} 笔数量未知` : ""}`), gross, actual, last); return tr;
      }
      const order = node("td"); order.append(node("strong", row.orderId), node("small", `物品 ${row.lineId}`), node("small", row.direction === "buy" ? "买入" : "卖出"));
      const amounts = node("td"); amounts.append(node("div", `成交总额 ${money(row.grossTotalCents)}`), node("small", `${row.direction === "buy" ? "实付" : "净到账"} ${money(row.direction === "buy" ? row.paidTotalCents : row.netTotalCents)}`));
      if ((row.direction === "buy" ? row.paidTotalCents : row.netTotalCents) == null) amounts.append(node("small", "平台未提供实际金额"));
      if (row.currencyCode !== "CNY") amounts.append(node("small", `非人民币（${row.currencyCode}），不并入人民币统计`));
      const times = node("td"); times.append(node("div", date(row.tradedAt)), node("small", `创建 ${date(row.createdAt)}`));
      const state = node("td"); state.append(node("span", row.status, "tag"), node("small", row.completed ? "已入库的完成历史" : row.channel === "pending" ? "待发货快照" : "未完成或状态未知"));
      tr.append(item, order, node("td", row.quantity ?? "未提供"), amounts, times, state); return tr;
    }));
    $("uuEmpty").hidden = entries.length > 0;
    $("uuPageInfo").textContent = `共 ${value.total} ${view === "summary" ? "组" : "条"} · 第 ${value.total ? page : 0} / ${value.pages} 页`;
    $("uuPrevious").disabled = page <= 1; $("uuNext").disabled = page >= value.pages;
    const runs = value.runs.filter(run => (game() === "all" || run.appid === game()) && run.channel === filters().channel);
    $("uuCoverage").textContent = runs.length ? runs.map(run => `${run.appid === 570 ? "Dota 2" : "CS2"} ${run.direction === "buy" ? "买入" : "卖出"}：${date(run.syncedAt)}，${run.pages} 页，${run.stopReason === "known" ? run.complete ? "到已同步范围（历史曾读至末页）" : "到已同步范围（更早历史未补齐）" : run.complete ? run.channel === "pending" ? "当前待发货快照" : "已读至末页" : "更早历史待完整复核"}`).join("；") : "当前范围尚未同步。历史保留原始时间；重复同步合并同一订单。";
    status(value);
  }
  async function action(fn) {
    if (busy) return; busy = true; message(""); if (snapshot) status(snapshot);
    try { await fn(); await refresh(); } catch (error) { message(error.message, true); }
    finally { busy = false; if (snapshot) status(snapshot); }
  }
  $("uuLogin").onclick = () => action(async () => { await api("uu:login", { appid: game() === "all" ? 730 : game() }); message("请在新窗口完成 悠悠 登录，返回后点击“检查登录”。"); });
  $("uuCheck").onclick = () => action(async () => { status(await api("uu:check")); message("悠悠 账号已核对，可查询订单或同步历史。"); });
  $("uuLogout").onclick = () => action(async () => { status(await api("uu:logout")); message("App 内 悠悠 登录已清除；已同步历史保留在本机，重新登录同账号后可查看。"); });
  $("uuSync").onclick = () => action(async () => {
    page = 1; status(await api("uu:start", { direction: $("uuView").value, mode: $("uuSyncMode").value }));
  });
  $("uuProbeSell").onclick = () => action(async () => { status(await api("uu:probe-sell")); });
  $("uuStop").onclick = () => action(() => api("uu:stop"));
  for (const id of ["uuGame", "uuView", "uuStart", "uuEnd", "uuDateField", "uuCategory", "uuStatus", "uuSort"]) $(id).onchange = () => { page = 1; drillKey = null; refresh().catch(error => message(error.message, true)); };
  $("uuQuery").oninput = () => { clearTimeout(searchTimer); page = 1; sequence++; searchTimer = setTimeout(() => refresh().catch(error => message(error.message, true)), 150); };
  const redraw = () => refresh().catch(error => message(error.message, true));
  $("uuSummaryView").onclick = () => { view = "summary"; drillKey = null; page = 1; redraw(); };
  $("uuDetailView").onclick = () => { view = "details"; drillKey = null; page = 1; redraw(); };
  $("uuBack").onclick = $("uuSummaryView").onclick;
  $("uuRows").onclick = event => { const button = event.target.closest("[data-uu-group]"); if (button) { drillKey = button.dataset.uuGroup; view = "details"; page = 1; redraw(); } };
  for (const button of document.querySelectorAll("[data-uu-range]")) button.onclick = () => {
    const range = button.dataset.uuRange === "all" ? { start: "", end: "" } : window.BuffMarketHistory.monthRange(new Date(), button.dataset.uuRange === "previous" ? -1 : 0);
    $("uuStart").value = range.start; $("uuEnd").value = range.end; page = 1; drillKey = null; redraw();
  };
  $("uuPrevious").onclick = () => { page--; refresh().catch(error => message(error.message, true)); };
  $("uuNext").onclick = () => { page++; refresh().catch(error => message(error.message, true)); };
  window.buffDesktop.onChange(event => {
    if (event.kind === "history" && event.action === "history:name-save") { refresh().catch(error => message(error.message,true)); return; }
    if (event.kind !== "uu-orders") return;
    status(event.value);
    if (event.value.job.status !== "running") refresh().catch(error => message(error.message, true));
  });
  const ready = refresh().catch(error => message(error.message, true));
  window.UuOrdersWorkspace = { ready, refresh };
})();
