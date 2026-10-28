"use strict";
(() => {
  const $ = id => document.getElementById(id), api = (action, payload) => window.buffDesktop.request(action, payload);
  let snapshot = null, result = null, page = 1, sequence = 0, busy = false, reviewSelection = null, searchTimer, view = "details", drillKey = null;
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const money = (value, currency = "CNY") => value == null ? "—" : window.BuffHelperCommon.formatCents(value, currency);
  const date = value => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未提供";
  const game = () => $("buffGame").value === "all" ? "all" : Number($("buffGame").value);
  const filters = () => ({ appid: game(), channel: $("buffView").value === "pending" ? "pending" : "history", direction: ["buy", "sell"].includes($("buffView").value) ? $("buffView").value : "all", query: $("buffQuery").value.trim(), start: $("buffStart").value, end: $("buffEnd").value, dateField: $("buffDateField").value, category: $("buffCategory").value, status: $("buffStatus").value, sort: $("buffSort").value, mode: view, groupKey: drillKey, page });
  function message(text, error = false) { $("buffMessage").textContent = text; $("buffMessage").hidden = !text; $("buffMessage").classList.toggle("form-error", error); }
  function status(value) {
    snapshot = value;
    const account = value.account;
    $("buffAccount").textContent = account ? `${account.nickname} · ${account.id}` : "尚未连接 BUFF";
    $("buffConnection").textContent = value.verified ? "登录已验证" : account ? "显示本机缓存 · 登录待检查" : "在 App 内登录后开始同步";
    const running = value.job.status === "running";
    $("buffJob").textContent = value.job.message || "尚未开始同步；读取订单不会修改交易账本。";
    $("buffProgress").textContent = `${value.job.pages || 0} 页 · ${value.job.count || 0} 条 · ${value.count} 条本机订单`;
    $("buffStop").disabled = !running;
    for (const id of ["buffCheck", "buffLogin", "buffLogout", "buffSync", "buffPending"]) $(id).disabled = busy || running;
    $("buffResults").setAttribute("aria-busy", String(running));
    $("buffReviewBuys").disabled = busy || running || view === "summary" || game() === "all" || !result?.rows.some(row => row.completed && row.direction === "buy");
    $("buffReviewSales").disabled = busy || running || view === "summary" || game() === "all" || !result?.rows.some(row => row.completed && row.direction === "sell");
  }
  async function refresh() {
    const run = ++sequence, value = await api("buff:list", filters());
    if (run !== sequence) return;
    if (value.pages && page > value.pages) { page = value.pages; return refresh(); }
    result = value; page = value.page;
    const selectedCategory = $("buffCategory").value;
    const option = (value, label) => { const el = node("option", label); el.value = value; return el; };
    $("buffCategory").replaceChildren(option("all", "全部分类"), ...(value.categories || []).map(c => option(c,c)));
    if ([...$("buffCategory").options].some(o => o.value === selectedCategory)) $("buffCategory").value = selectedCategory;
    const metric = (label, number, hint) => { const el = node("div", null, "metric"); el.append(node("span", label, "metric-label"), node("strong", number), node("small", hint)); return el; };
    $("buffMetrics").replaceChildren(metric("匹配订单", value.recordTotal ?? value.total, "统计整个筛选范围"), metric("同类物品", value.groupTotal ?? "—", "完整市场名 · 买卖分别合并"), metric("已完成", value.completed ?? "—", "参与成交金额统计"), metric("其他状态", value.excluded ?? "—", "不计入成交均价"));
    $("buffAmounts").textContent = (value.amounts || []).map(a => `${a.currency} ${a.direction === "buy" ? "买入" : "卖出"}：已知成交总额 ${money(a.knownGross ? a.totalCents : null, a.currency)} / 已知${a.direction === "buy" ? "实付" : "净到账"} ${money(a.knownActual ? a.actualCents : null, a.currency)}${a.unknownActual ? `（${a.unknownActual} 笔平台未提供实际金额）` : ""}${a.unknownGross ? `（${a.unknownGross} 笔成交金额缺项）` : ""}`).join("；");
    $("buffSummaryView").setAttribute("aria-pressed", String(view === "summary")); $("buffDetailView").setAttribute("aria-pressed", String(view === "details")); $("buffBack").hidden = !drillKey;
    const headers = view === "summary" ? ["物品 / 分类", "方向 / 订单数", "已完成数量", "成交均价 / 总额", "实际收支均价", "成交范围 / 明细"] : ["物品 / 分类", "订单号 / 方向", "数量", "成交与实际收支", "成交 / 创建时间", "平台状态"];
    const head = node("tr"); for (const label of headers) { const th = node("th", label); th.scope = "col"; head.append(th); } $("buffTableHead").replaceChildren(head);
    const entries = view === "summary" ? value.groups || [] : value.rows;
    $("buffRows").replaceChildren(...entries.map(row => {
      const tr = node("tr"), item = node("td");
      item.append(node("strong", row.name, "history-name"), node("small", row.marketHashName || "完整市场名称待核对", "history-english"), node("small", `${row.appid === 570 ? "Dota 2" : "CS2"} · ${row.category || "未分类"} · 商品 ${row.goodsId}`));
      if (view === "summary") {
        const average = (total, quantity) => quantity ? money(window.BuffMarketHistory.roundedAverageCents(total, quantity), row.currencyCode) : "未提供";
        const gross = node("td"); gross.append(node("strong", average(row.grossCents, row.grossQuantity)), node("small", `已知总额 ${money(row.grossQuantity ? row.grossCents : null, row.currencyCode)} · ${row.grossQuantity} 件计价`));
        if (row.unknownGross) gross.append(node("small", `${row.unknownGross} 笔金额或数量缺项`));
        const actual = node("td"); actual.append(node("strong", average(row.actualCents, row.actualQuantity)), node("small", `${row.direction === "buy" ? "实付" : "净到账"} · ${row.actualQuantity} 件计价`));
        if (row.unknownActual) actual.append(node("small", `${row.unknownActual} 笔平台收支或数量缺项`));
        const last = node("td", row.firstDate ? `${row.firstDate} 至 ${row.lastDate}` : "平台未提供成交时间"), button = node("button", "查看明细", "text-button"); button.type = "button"; button.dataset.buffGroup = row.key; last.append(button);
        tr.append(item, node("td", `${row.direction === "buy" ? "买入" : "卖出"} · ${row.completedRecords}/${row.records} 笔已完成`), node("td", `${row.quantity} 件${row.unknownQuantity ? ` · ${row.unknownQuantity} 笔数量未知` : ""}`), gross, actual, last); return tr;
      }
      const order = node("td"); order.append(node("strong", row.orderId), node("small", row.direction === "buy" ? "买入" : "卖出"));
      const amounts = node("td"); amounts.append(node("div", `成交总额 ${money(row.grossTotalCents)}`), node("small", `${row.direction === "buy" ? "实付" : "净到账"} ${money(row.direction === "buy" ? row.paidTotalCents : row.netTotalCents)}`));
      if ((row.direction === "buy" ? row.paidTotalCents : row.netTotalCents) == null) amounts.append(node("small", "平台未提供实际金额"));
      if (row.currencyCode !== "CNY") amounts.append(node("small", `非人民币（${row.currencyCode}），不并入人民币统计`));
      const times = node("td"); times.append(node("div", date(row.tradedAt)), node("small", `创建 ${date(row.createdAt)}`));
      const state = node("td"); state.append(node("span", row.status, "tag"), node("small", row.completed ? "已入库，自动参与订单汇总" : row.channel === "pending" ? "待发货快照" : "未完成或状态未知"));
      tr.append(item, order, node("td", row.quantity ?? "未提供"), amounts, times, state); return tr;
    }));
    $("buffEmpty").hidden = entries.length > 0;
    $("buffPageInfo").textContent = `共 ${value.total} ${view === "summary" ? "组" : "条"} · 第 ${value.total ? page : 0} / ${value.pages} 页`;
    $("buffPrevious").disabled = page <= 1; $("buffNext").disabled = page >= value.pages;
    const runs = value.runs.filter(run => (game() === "all" || run.appid === game()) && run.channel === filters().channel);
    $("buffCoverage").textContent = runs.length ? runs.map(run => `${run.appid === 570 ? "Dota 2" : "CS2"} ${run.direction === "buy" ? "买入" : "卖出"}：${date(run.syncedAt)}，${run.pages} 页，${run.stopReason === "known" ? run.complete ? "到已同步范围（历史曾读至末页）" : "到已同步范围（更早历史未补齐）" : run.complete ? run.channel === "pending" ? "当前待发货快照" : "已读至末页" : "更早历史待完整复核"}`).join("；") : "当前范围尚未同步。历史保留原始时间；重复同步合并同一订单。";
    status(value);
  }
  async function action(fn) {
    if (busy) return; busy = true; message(""); if (snapshot) status(snapshot);
    try { await fn(); await refresh(); } catch (error) { message(error.message, true); }
    finally { busy = false; if (snapshot) status(snapshot); }
  }
  $("buffLogin").onclick = () => action(async () => { await api("buff:login", { appid: game() === "all" ? 730 : game() }); message("请在新窗口完成 BUFF 登录，返回后点击“检查登录”。"); });
  $("buffCheck").onclick = () => action(async () => { status(await api("buff:check")); message("BUFF 账号已核对，可查询订单或同步历史。"); });
  $("buffLogout").onclick = () => action(async () => { status(await api("buff:logout")); message("App 内 BUFF 登录已清除；已同步历史保留在本机，重新登录同账号后可查看。"); });
  function start(channel) {
    return action(async () => {
      if (channel === "pending") $("buffView").value = "pending";
      else if ($("buffView").value === "pending") $("buffView").value = "all";
      page = 1; status(await api("buff:start", { appid: game(), direction: channel === "pending" ? "sell" : filters().direction, channel, mode: $("buffSyncMode").value }));
    });
  }
  $("buffSync").onclick = () => start("history"); $("buffPending").onclick = () => start("pending");
  $("buffStop").onclick = () => action(() => api("buff:stop"));
  for (const id of ["buffGame", "buffView", "buffStart", "buffEnd", "buffDateField", "buffCategory", "buffStatus", "buffSort"]) $(id).onchange = () => { page = 1; drillKey = null; refresh().catch(error => message(error.message, true)); };
  $("buffQuery").oninput = () => { clearTimeout(searchTimer); page = 1; sequence++; searchTimer = setTimeout(() => refresh().catch(error => message(error.message, true)), 150); };
  const redraw = () => refresh().catch(error => message(error.message, true));
  $("buffSummaryView").onclick = () => { view = "summary"; drillKey = null; page = 1; redraw(); };
  $("buffDetailView").onclick = () => { view = "details"; drillKey = null; page = 1; redraw(); };
  $("buffBack").onclick = $("buffSummaryView").onclick;
  $("buffRows").onclick = event => { const button = event.target.closest("[data-buff-group]"); if (button) { drillKey = button.dataset.buffGroup; view = "details"; page = 1; redraw(); } };
  for (const button of document.querySelectorAll("[data-buff-range]")) button.onclick = () => {
    const range = button.dataset.buffRange === "all" ? { start: "", end: "" } : window.BuffMarketHistory.monthRange(new Date(), button.dataset.buffRange === "previous" ? -1 : 0);
    $("buffStart").value = range.start; $("buffEnd").value = range.end; page = 1; drillKey = null; redraw();
  };
  $("buffPrevious").onclick = () => { page--; refresh().catch(error => message(error.message, true)); };
  $("buffNext").onclick = () => { page++; refresh().catch(error => message(error.message, true)); };
  async function review(direction) {
    if (game() === "all") throw new Error("请先选择单个游戏，再核对本页订单");
    const keys = result.rows.filter(row => row.completed && row.direction === direction).map(row => row.key);
    if (!keys.length) throw new Error("本页没有可核对的已完成订单");
    reviewSelection = { direction, appid: game(), keys };
    const frame = $("ledgerFrame"), loaded = frame.hasAttribute("src");
    const ready = loaded ? Promise.resolve() : new Promise(resolve => frame.addEventListener("load", resolve, { once: true }));
    window.BuffDesktopNavigation.navigate("ledger");
    document.getElementById("legacyLedger").hidden = false;
    document.getElementById("legacyLedger").closest("details").open = true;
    if (!loaded) frame.src = "/ledger.html";
    await ready;
    const button = frame.contentDocument.getElementById(direction === "buy" ? "buySyncButton" : "syncButton");
    if (!button || button.disabled) throw new Error("请先连接本机账本，再核对订单");
    button.click();
    if (direction === "sell") frame.contentDocument.getElementById("collectBoth").click();
  }
  $("buffReviewBuys").onclick = () => action(() => review("buy"));
  $("buffReviewSales").onclick = () => action(() => review("sell"));
  window.buffDesktop.onChange(event => {
    if (event.kind !== "buff-orders") return;
    status(event.value);
    if (event.value.job.status !== "running") refresh().catch(error => message(error.message, true));
  });
  const ready = refresh().catch(error => message(error.message, true));
  window.BuffOrdersWorkspace = { ready, refresh, consumeReview(direction) { if (reviewSelection?.direction !== direction) return null; const value = reviewSelection; reviewSelection = null; return value; } };
})();
