"use strict";
(() => {
  const $ = id => document.getElementById(id), api = (action, payload) => window.buffDesktop.request(action, payload);
  let snapshot = null, result = null, page = 1, sequence = 0, busy = false, searchTimer, view = "details", drillKey = null;
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; };
  const money = (value, currency = "CNY") => value == null ? "—" : window.BuffHelperCommon.formatCents(value, currency);
  const date = value => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未提供";
  const game = () => $("steamGame").value === "all" ? "all" : Number($("steamGame").value);
  const filters = () => ({ appid: game(), channel: "history", direction: ["buy", "sell"].includes($("steamView").value) ? $("steamView").value : "all", query: $("steamQuery").value.trim(), start: $("steamStart").value, end: $("steamEnd").value, dateField: $("steamDateField").value, category: $("steamCategory").value, status: $("steamStatus").value, sort: $("steamSort").value, mode: view, groupKey: drillKey, page });
  function message(text, error = false) { $("steamMessage").textContent = text; $("steamMessage").hidden = !text; $("steamMessage").classList.toggle("form-error", error); }
  function status(value) {
    snapshot = value;
    const account = value.account;
    $("steamAccount").textContent = account ? `${account.nickname} · ${account.id}` : "尚未连接 Steam";
    $("steamConnection").textContent = value.verified ? "登录已验证" : account ? "显示本机缓存 · 登录待检查" : "在 App 内登录后开始同步";
    const running = value.job.status === "running";
    const progress = $("steamSyncProgress"); progress.hidden = !running;
    if (value.job.total > 0) { progress.max = value.job.total; progress.value = value.job.events || 0; } else progress.removeAttribute("value");
    $("steamJob").textContent = value.job.message || "尚未开始同步；已保存历史自动汇总到账本。";
    $("steamProgress").textContent = `${value.job.pages || 0} 页 · ${value.job.count || 0} 条 · ${value.count} 条本机成交`;
    $("steamStop").disabled = !running;
    for (const id of ["steamCheck", "steamLogin", "steamLogout", "steamSync"]) $(id).disabled = busy || running;
    $("steamResults").setAttribute("aria-busy", String(running));

  }
  async function refresh() {
    const run = ++sequence, value = await api("steam:list", filters());
    if (run !== sequence) return;
    if (value.pages && page > value.pages) { page = value.pages; return refresh(); }
    result = value; page = value.page;
    const selectedCategory = $("steamCategory").value;
    const option = (value, label) => { const el = node("option", label); el.value = value; return el; };
    const selectedGame = $("steamGame").value, games = [...new Set([730,570,...(value.runs||[]).map(r=>r.appid)])];
    $("steamGame").replaceChildren(option("all","全部游戏"),...games.map(appid=>option(String(appid),({730:"CS2",570:"Dota 2",753:"Steam 社区物品"})[appid]||`App ${appid}`)));
    $("steamGame").value = games.some(appid=>String(appid)===selectedGame) ? selectedGame : "all";
    $("steamCategory").replaceChildren(option("all", "全部分类"), ...(value.categories || []).map(c => option(c,c)));
    if ([...$("steamCategory").options].some(o => o.value === selectedCategory)) $("steamCategory").value = selectedCategory;
    const metric = (label, number, hint) => { const el = node("div", null, "metric"); el.append(node("span", label, "metric-label"), node("strong", number), node("small", hint)); return el; };
    $("steamMetrics").replaceChildren(metric("匹配物品", value.recordTotal ?? value.total, "统计整个筛选范围"), metric("同类物品", value.groupTotal ?? "—", "完整市场名 · 买卖分别合并"), metric("已完成", value.completed ?? "—", "参与成交金额统计"), metric("名称待核对", (value.rows || []).filter(r => !r.marketHashName).length, "当前页缺少完整英文名"));
    $("steamAmounts").textContent = (value.amounts || []).map(a => `${a.currency} ${a.direction === "buy" ? "买入" : "卖出"}：已知成交总额 ${money(a.knownGross ? a.totalCents : null, a.currency)} / 已知${a.direction === "buy" ? "实付" : "净到账"} ${money(a.knownActual ? a.actualCents : null, a.currency)}${a.unknownActual ? `（${a.unknownActual} 件平台未提供实际金额）` : ""}${a.unknownGross ? `（${a.unknownGross} 件成交金额缺项）` : ""}`).join("；");
    $("steamSummaryView").setAttribute("aria-pressed", String(view === "summary")); $("steamDetailView").setAttribute("aria-pressed", String(view === "details")); $("steamBack").hidden = !drillKey;
    const headers = view === "summary" ? ["物品 / 分类", "方向 / 明细数", "已完成数量", "成交均价 / 总额", "实际收支均价", "成交范围 / 明细"] : ["物品 / 分类", "订单号 / 方向", "数量", "成交与实际收支", "成交 / 资金状态", "平台状态"];
    const head = node("tr"); for (const label of headers) { const th = node("th", label); th.scope = "col"; head.append(th); } $("steamTableHead").replaceChildren(head);
    const entries = view === "summary" ? value.groups || [] : value.rows;
    $("steamRows").replaceChildren(...entries.map(row => {
      const tr = node("tr"), item = node("td");
      item.append(node("strong", row.name, "history-name"), node("small", row.marketHashName || "完整市场名称待核对", "history-english"), node("small", `${row.appid === 570 ? "Dota 2" : row.appid === 730 ? "CS2" : `App ${row.appid}`} · ${row.category || "未分类"} · 商品 ${row.goodsId}`));
      if (view === "summary") {
        const average = (total, quantity) => quantity ? money(window.BuffMarketHistory.roundedAverageCents(total, quantity), row.currencyCode) : "未提供";
        const gross = node("td"); gross.append(node("strong", average(row.grossCents, row.grossQuantity)), node("small", `已知总额 ${money(row.grossQuantity ? row.grossCents : null, row.currencyCode)} · ${row.grossQuantity} 件计价`));
        if (row.unknownGross) gross.append(node("small", `${row.unknownGross} 件金额或数量缺项`));
        const actual = node("td"); actual.append(node("strong", average(row.actualCents, row.actualQuantity)), node("small", `${row.direction === "buy" ? "实付" : "净到账"} · ${row.actualQuantity} 件计价`));
        if (row.unknownActual) actual.append(node("small", `${row.unknownActual} 件平台收支或数量缺项`));
        const last = node("td", row.firstDate ? `${row.firstDate} 至 ${row.lastDate}` : "平台未提供成交时间"), button = node("button", "查看明细", "text-button"); button.type = "button"; button.dataset.steamGroup = row.key; last.append(button);
        tr.append(item, node("td", `${row.direction === "buy" ? "买入" : "卖出"} · ${row.completedRecords}/${row.records} 件已完成`), node("td", `${row.quantity} 件${row.unknownQuantity ? ` · ${row.unknownQuantity} 笔数量未知` : ""}`), gross, actual, last); return tr;
      }
      const order = node("td"); order.append(node("strong", row.orderId), node("small", `物品 ${row.assetId}`), node("small", row.direction === "buy" ? "买入" : "卖出"));
      const amounts = node("td"); amounts.append(node("div", `成交总额 ${money(row.grossTotalCents, row.currencyCode)}`), node("small", `${row.direction === "buy" ? "实付" : "净到账"} ${money(row.direction === "buy" ? row.paidTotalCents : row.netTotalCents, row.currencyCode)}`));
      if ((row.direction === "buy" ? row.paidTotalCents : row.netTotalCents) == null) amounts.append(node("small", "平台未提供实际金额"));
      if (row.currencyCode !== "CNY") amounts.append(node("small", `非人民币（${row.currencyCode}），不并入人民币统计`));
      if (row.direction === "sell" && row.fundsStatus === "held") amounts.append(node("small", `成交净额 ${money(row.saleProceedsCents, row.currencyCode)}，款项暂扣`));
      const times = node("td"); times.append(node("div", date(row.tradedAt)), node("small", row.fundsHeldUntil ? `预计解冻 ${date(row.fundsHeldUntil)}（非实际到账）` : "未提供实际到账时间"));
      const state = node("td"); state.append(node("span", row.status, "tag"), node("small", row.completed ? "已入库的完成历史" : row.channel === "pending" ? "待发货快照" : "未完成或状态未知"));
      tr.append(item, order, node("td", row.quantity ?? "未提供"), amounts, times, state); return tr;
    }));
    $("steamEmpty").hidden = entries.length > 0;
    $("steamPageInfo").textContent = `共 ${value.total} ${view === "summary" ? "组" : "条"} · 第 ${value.total ? page : 0} / ${value.pages} 页`;
    $("steamPrevious").disabled = page <= 1; $("steamNext").disabled = page >= value.pages;
    const runs = value.runs.filter(run => (game() === "all" || run.appid === game()) && run.channel === filters().channel);
    $("steamCoverage").textContent = runs.length ? runs.map(run => `${run.appid === 570 ? "Dota 2" : run.appid === 730 ? "CS2" : `App ${run.appid}`} ${run.direction === "buy" ? "买入" : "卖出"}：${date(run.syncedAt)}，${run.pages} 页，${run.stopReason === "known" ? run.complete ? "到已同步范围（历史曾读至末页）" : "到已同步范围（更早历史未补齐）" : run.complete ? run.channel === "pending" ? "当前待发货快照" : "已读至末页" : "更早历史待完整复核"}`).join("；") : "当前范围尚未同步。历史保留原始时间；重复同步合并同一订单。";
    if (value.csvBindings?.length) $("steamCoverage").textContent += ` 已核对 ${value.csvBindings.reduce((n,b)=>n+b.matchedCount,0)} 条 CSV 重复来源，账本仅计一次。`;
    status(value);
  }
  async function action(fn) {
    if (busy) return; busy = true; message(""); if (snapshot) status(snapshot);
    try { await fn(); await refresh(); } catch (error) { message(error.message, true); }
    finally { busy = false; if (snapshot) status(snapshot); }
  }
  $("steamLogin").onclick = () => action(async () => { await api("steam:login"); message("请在新窗口完成 Steam 登录，返回后点击“检查登录”。"); });
  $("steamCheck").onclick = () => action(async () => { status(await api("steam:check")); message("Steam 账号已核对，可查询订单或同步历史。"); });
  $("steamLogout").onclick = () => action(async () => { status(await api("steam:logout")); message("App 内 Steam 登录已清除；已同步历史保留在本机，重新登录同账号后可查看。"); });
  $("steamSync").onclick = () => action(async () => {
    page = 1; status(await api("steam:start", { mode: $("steamSyncMode").value }));
  });
  $("steamStop").onclick = () => action(() => api("steam:stop"));
  for (const id of ["steamGame", "steamView", "steamStart", "steamEnd", "steamDateField", "steamCategory", "steamStatus", "steamSort"]) $(id).onchange = () => { page = 1; drillKey = null; refresh().catch(error => message(error.message, true)); };
  $("steamQuery").oninput = () => { clearTimeout(searchTimer); page = 1; sequence++; searchTimer = setTimeout(() => refresh().catch(error => message(error.message, true)), 150); };
  const redraw = () => refresh().catch(error => message(error.message, true));
  $("steamSummaryView").onclick = () => { view = "summary"; drillKey = null; page = 1; redraw(); };
  $("steamDetailView").onclick = () => { view = "details"; drillKey = null; page = 1; redraw(); };
  $("steamBack").onclick = $("steamSummaryView").onclick;
  $("steamRows").onclick = event => { const button = event.target.closest("[data-steam-group]"); if (button) { drillKey = button.dataset.steamGroup; view = "details"; page = 1; redraw(); } };
  for (const button of document.querySelectorAll("[data-steam-range]")) button.onclick = () => {
    const range = button.dataset.steamRange === "all" ? { start: "", end: "" } : window.BuffMarketHistory.monthRange(new Date(), button.dataset.steamRange === "previous" ? -1 : 0);
    $("steamStart").value = range.start; $("steamEnd").value = range.end; page = 1; drillKey = null; redraw();
  };
  $("steamPrevious").onclick = () => { page--; refresh().catch(error => message(error.message, true)); };
  $("steamNext").onclick = () => { page++; refresh().catch(error => message(error.message, true)); };
  window.buffDesktop.onChange(event => {
    if (event.kind === "history" && event.action === "history:name-save") { refresh().catch(error => message(error.message,true)); return; }
    if (event.kind !== "steam-orders") return;
    status(event.value);
    if (event.value.job.status !== "running") refresh().catch(error => message(error.message, true));
  });
  const ready = refresh().catch(error => message(error.message, true));
  window.SteamOrdersWorkspace = { ready, refresh };
})();
