"use strict";
(() => {
  const H = window.BuffMarketHistory, $ = id => document.getElementById(id);
  const api = (action, payload) => window.buffDesktop.request(action, payload);
  const PAGE_SIZE = 50;
  let dataset = null, result = null, view = "summary", page = 0, drillKey = null, nameTarget = null;
  let loadSequence = 0, searchTimer, customNames = {}, savingExport = false, pendingImport = null;
  const catalog = () => ({ items: { ...window.BuffDotaNameCatalog?.items, ...customNames } });
  function node(tag, text, className) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; }
  function message(text = "") { $("historyMessage").textContent = text; $("historyMessage").hidden = !text; }
  function error(text = "") { $("historyError").textContent = text; $("historyError").hidden = !text; }
  const steamRows = () => (dataset?.rows || []).filter(row => row.platform === "steam");
  function filters() { return { start: $("historyStart").value, end: $("historyEnd").value, game: $("historyGame").value, platform: "steam", type: $("historyType").value, currency: $("historyCurrency").value, search: $("historySearch").value, sort: $("historySort").value, unverified: $("historyUnverified").checked, scope: $("historyAccount").value }; }
  function stat(label, value, hint) { const el = node("div", null, "metric"); el.append(node("span", label, "metric-label"), node("strong", value), node("small", hint)); return el; }
  function selectedDetails() { return drillKey ? result.rows.filter(row => H.groupKey(row) === drillKey) : result.rows; }
  function nameCell(row) {
    const cell = node("td"), label = row.localized;
    cell.append(node("strong", label.name, "history-name"));
    if (label.name !== row.marketHashName) { const english = node("small", row.marketHashName, "history-english"); english.lang = "en"; cell.append(english); }
    const status = node("small", label.status, "history-name-status" + (label.status === "待核对" ? " pending" : ""));
    status.title = [label.source, label.checkedAt ? `核对时间：${label.checkedAt.slice(0, 10)}` : "", label.url].filter(Boolean).join("\n");
    cell.append(status, node("small", `${row.scope ? row.scope + " · " : ""}${row.platformName} · ${row.gameName} · ${H.TYPE_NAMES[row.type]} · ${row.currency}`));
    return cell;
  }
  function tableRow(row) {
    const tr = node("tr"); tr.dataset.historyKey = H.groupKey(row);
    if (view === "summary") {
      const price = cents => H.money(Math.round(cents), row.currency);
      tr.append(nameCell(row), node("td", row.quantity, "number"), node("td", price(H.roundedAverageCents(row.totalCents, row.quantity)), "number"), node("td", price(row.totalCents), "number"), node("td", row.minCents === row.maxCents ? price(row.minCents) : `${price(row.minCents)} – ${price(row.maxCents)}`, "number"));
      const dates = node("td", row.firstDate); if (row.lastDate !== row.firstDate) dates.append(node("small", `至 ${row.lastDate}`));
      const actions = node("td"), wrap = node("div", null, "history-row-actions");
      for (const [action, text] of [["details", "查看明细"], ["name", "核对名称"]]) {
        const button = node("button", text, "text-button"); button.type = "button"; button.dataset.historyAction = action; button.dataset.key = row.key; button.setAttribute("aria-label", `${text}：${row.localized.name}`); wrap.append(button);
      }
      actions.append(wrap); tr.append(dates, actions);
    } else {
      tr.append(node("td", row.date), nameCell(row), node("td", row.quantity, "number"), node("td", H.money(row.totalCents, row.currency), "number"), node("td", row.listedDate || "—"), node("td", row.sourceRow, "number"), node("td", row.orderId ? `订单 ${row.orderId}${row.assetId ? ` / 资产 ${row.assetId}` : ""}` : row.assetId || "—"));
    }
    return tr;
  }
  function renderTable() {
    $("historySummaryView").setAttribute("aria-pressed", String(view === "summary"));
    $("historyDetailView").setAttribute("aria-pressed", String(view === "details"));
    const headings = view === "summary" ? ["物品 / 中文名核对", "数量", "平均单价", "总金额", "单价区间", "成交日期", "操作"] : ["成交日期", "物品 / 中文名核对", "数量", "成交总额", "上架日期", "原清单行号", "资产 / 订单 ID"];
    const head = node("tr");
    headings.forEach((text, index) => { const th = node("th", text, (view === "summary" && index >= 1 && index <= 4 || view === "details" && [2, 3, 5].includes(index)) ? "number" : ""); th.scope = "col"; head.append(th); });
    $("historyTableHead").replaceChildren(head);
    const entries = !result ? [] : view === "summary" ? result.items : selectedDetails();
    const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE)); page = Math.min(page, pages - 1);
    $("historyRows").replaceChildren(...entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(tableRow));
    $("historyPagination").hidden = !entries.length;
    $("historyPageInfo").textContent = `第 ${page + 1} / ${pages} 页 · 共 ${entries.length} ${view === "summary" ? "组" : "笔"} · 每页 ${PAGE_SIZE} 条`;
    $("historyPrevious").disabled = page === 0; $("historyNext").disabled = page + 1 >= pages;
    $("historyEmpty").hidden = entries.length > 0;
    $("historyEmpty").replaceChildren(node("h2", dataset ? "当前条件没有匹配的 Steam 订单" : "导入 Steam 订单"), node("p", dataset ? "请调整日期、游戏、买卖方向或搜索条件。本页仅展示 Steam 订单。" : "上传 Steam 买入与卖出 CSV，查看同类汇总、逐笔订单和成交均价。"));
    const f = filters();
    $("historyCaption").textContent = result ? `Steam · ${f.start || "最早"} 至 ${f.end || "最新"} · ${result.items.length} 个物品分组 / ${result.quantity} 笔订单${drillKey ? " · 当前查看单个物品" : ""}` : "导入 CSV 后显示 Steam 订单";
    $("historyDrill").hidden = !drillKey;
    $("historyDrillName").textContent = drillKey && result ? `物品明细：${result.items.find(row => row.key === drillKey)?.localized.name || ""}` : "";
    $("historyExportSummary").disabled = !result?.items.length || savingExport;
    $("historyExportDetails").disabled = !result?.rows.length || savingExport;
    $("historyExportDetails").textContent = drillKey ? "导出该物品订单" : "导出订单 CSV";
  }
  function render() {
    error();
    try { result = dataset ? H.analyze(dataset, filters(), catalog()) : null; }
    catch (issue) { result = null; error(issue.message); }
    const amounts = result?.amounts || [], one = amounts.length === 1 ? amounts[0] : null, type = filters().type;
    const value = !result ? "—" : !result.quantity ? "—" : one && type !== "all" ? H.money(type === "purchase" ? one.purchaseCents : one.saleCents, one.currency) : "分项统计";
    $("historyMetrics").replaceChildren(
      stat("匹配订单", result?.quantity ?? "—", result ? `共 ${result.units} 件物品` : "可选数量列，未指定时每笔计 1 件"),
      stat("物品分组", result?.items.length ?? "—", "同平台、游戏、原名、币种与买卖类型"),
      stat(type === "purchase" ? "购买总支出" : type === "sale" ? "出售总金额" : "购买 / 出售金额", value, type === "all" ? "收支分别统计，不相抵" : "沿用清单金额，不另扣手续费"),
      stat("重复物品分组", result?.repeated ?? "—", "同组数量大于 1，自动计算均价"),
    );
    $("historyAmounts").hidden = !result?.quantity || amounts.length === 1 && type !== "all";
    $("historyAmounts").textContent = amounts.map(amount => `${amount.currency}：购买 ${H.money(amount.purchaseCents, amount.currency)} / 出售 ${H.money(amount.saleCents, amount.currency)}`).join("；");
    $("historyNameCoverage").textContent = result ? `中文名已核对或已提供 ${result.items.length - result.unverified} / ${result.items.length} 组${result.unverified ? `，${result.unverified} 组待核对。可在物品行点击“核对名称”保存中文名。` : "。英文市场名保留在中文名下方。"}` : "中文名称优先使用已入库的手动核对和 BUFF / CSV 精确对照，其次使用内置词表；名称冲突需人工核对。";
    if (drillKey && !result?.items.some(row => row.key === drillKey)) drillKey = null;
    renderTable();
  }
  function option(value, text) { const el = node("option", text); el.value = value; return el; }
  function importText(text, fileName, mapping) {
    return showDataset(H.parseImport(text, fileName, mapping));
  }
  function showDataset(next) {
    dataset = next; page = 0; drillKey = null; view = "summary";
    const rows = steamRows(), dates = rows.map(row => row.date).sort();
    const games = new Map([["730", "CS2"], ["570", "Dota 2"]]);
    for (const row of rows) if (!games.has(row.appid)) games.set(row.appid, row.appid === "730" ? "CS2" : row.appid === "753" ? "Steam 社区物品" : row.gameName);
    $("historyGame").replaceChildren(option("all", "全部游戏"), option("other", "其他游戏（全部）"), ...[...games].map(([id, name]) => option(id, name)));
    $("historyCurrency").replaceChildren(option("all", "全部币种"), ...[...new Set(rows.map(row => row.currency))].map(currency => option(currency, currency)));
    $("historyAccount").replaceChildren(option("all", "全部账户"), ...[...new Set(rows.map(row => row.scope).filter(Boolean))].map(scope => option(scope, scope)));
    $("historyFilters").reset();
    $("historyFileName").textContent = dataset.fileName === "已入库 CSV 历史" ? "已入库 Steam 订单" : dataset.fileName;
    $("historyFileInfo").textContent = `${rows.length.toLocaleString("zh-CN")} 笔 Steam 订单${dates.length ? ` · ${dates[0]} 至 ${dates.at(-1)}` : ""}`;
    $("historyClear").disabled = false;
    message(`已载入 ${rows.length.toLocaleString("zh-CN")} 笔 Steam 订单。${dataset.rows.length > rows.length ? "其他平台记录独立保留，不在本页展示。" : ""}${dataset.legacyQuotes ? "已兼容旧导出的名称内引号，原始名称完整保留。" : ""}`);
    render(); return result;
  }
  async function refreshNames() {
    const saved = await api("history:names"); customNames = saved.items || {}; render();
    if ($("historyNamesDialog").open) renderNames();
  }
  async function reloadArchive() {
    const next = await api("history:load"); await refreshNames();
    if (next.rows.length) showDataset(next);
    else { dataset = null; result = null; render(); }
    return next;
  }
  async function persistImport(text, fileName, mapping, sequence = loadSequence) {
    const imported = H.parseImport(text, fileName, mapping);
    const scope = $("historyImportScope").value.trim(); if (!scope) throw new Error("请填写导入账户标记");
    const saved = await api("history:import", { text, fileName, mapping, scope });
    const next = await api("history:load"); await refreshNames();
    if (sequence !== loadSequence) return;
    showDataset(next); $("historyFileName").textContent = fileName;
    message(`已入库：新增 ${saved.inserted}、更新 ${saved.updated}、跳过 ${saved.skipped} 笔；当前保存 ${steamRows().length} 笔 Steam 订单。${imported.rows.some(row => row.platform !== "steam") ? "其他平台记录已按原来源保存，不在 Steam 订单页展示。" : ""}${saved.withoutOrderId ? "无订单号记录按完整内容和重复次数去重。" : ""}`);
  }
  $("historyReload").onclick = () => { loadSequence++; reloadArchive().catch(issue => error(issue.message)); };
  async function loadFile(file) {
    if (!file) return;
    const sequence = ++loadSequence;
    $("historyFile").setAttribute("aria-busy", "true");
    try {
      if (!/\.csv$/i.test(file.name)) throw new Error("请选择 .csv 格式的 Steam 订单文件");
      if (file.size > H.MAX_BYTES) throw new Error("CSV 文件最多 20 MB");
      const text = await file.text();
      if (sequence !== loadSequence) return;
      const info = H.inspectCsv(text);
      if (info.steam) await persistImport(text, file.name, undefined, sequence);
      else openMapping(text, file.name, info);
    } catch (issue) {
      if (sequence === loadSequence) { error(`${issue.message}${dataset ? "；原分析结果已保留。" : ""}`); $("historyError").focus(); }
    } finally { if (sequence === loadSequence) $("historyFile").removeAttribute("aria-busy"); }
  }
  const aliases = {
    date: ["Acted On", "成交日期", "成交时间", "交易时间", "购买时间", "支付时间", "日期", "date", "time"],
    name: ["中文名称", "物品名称", "商品名称", "Item Name", "名称", "name"],
    price: ["Price in Cents", "成交单价", "购买单价", "单价", "成交金额", "实付金额", "金额", "价格", "price", "amount"],
    quantity: ["数量", "购买数量", "quantity", "count"], marketName: ["Market Name", "market_hash_name", "Market Hash Name", "英文市场名称", "原始市场名称", "英文名称"],
    game: ["App Id", "appid", "游戏", "游戏名称", "Game Name", "game"], platform: ["来源平台", "平台", "platform"],
    type: ["交易类型", "买卖类型", "type", "类型"], currency: ["币种", "currency"], assetId: ["Asset Id", "资产 ID", "asset_id"], orderId: ["Order Id", "订单 ID", "订单编号", "订单号", "order_id"],
  };
  function updateMappingSamples() {
    if (!pendingImport) return;
    for (const select of document.querySelectorAll("[data-history-column]")) {
      const key = select.dataset.historyColumn, index = pendingImport.info.headers.indexOf(select.value);
      document.querySelector(`[data-history-sample="${key}"]`).textContent = index < 0 ? "" : `首行：${pendingImport.info.sample[index] || "（空）"}`;
      const fixed = { game: "historyMapDefaultGame", platform: "historyMapDefaultPlatform", type: "historyMapDefaultType", currency: "historyMapDefaultCurrency" }[key];
      if (fixed) $(fixed).disabled = index >= 0;
    }
  }
  function openMapping(text, fileName, info) {
    pendingImport = { text, fileName, info };
    $("historyMappingForm").reset();
    for (const select of document.querySelectorAll("[data-history-column]")) {
      select.replaceChildren(option("", select.required ? "请选择对应列" : "未指定"), ...info.headers.map(name => option(name, name)));
      const candidates = aliases[select.dataset.historyColumn] || [];
      select.value = candidates.map(alias => info.headers.find(name => name.toLowerCase() === alias.toLowerCase())).find(Boolean) || "";
    }
    if (!$("historyMapName").value && $("historyMapMarketName").value) $("historyMapName").value = $("historyMapMarketName").value;
    $("historyMapUnit").value = /cents|分/.test($("historyMapPrice").value.toLowerCase()) ? "cents" : "major";
    $("historyMapPriceMode").value = /总额|总金额|实付|成交金额|amount/i.test($("historyMapPrice").value) ? "total" : "unit";
    $("historyMappingFile").textContent = `${fileName} · ${info.source.length - 1} 笔 · ${info.headers.length} 列`;
    $("historyMappingError").hidden = true; updateMappingSamples();
    $("historyMappingDialog").showModal();
  }
  $("historyMappingForm").addEventListener("change", updateMappingSamples);
  $("historyMappingClose").addEventListener("click", () => $("historyMappingDialog").close());
  $("historyMappingDialog").addEventListener("close", () => { pendingImport = null; });
  $("historyMappingForm").addEventListener("submit", async event => {
    event.preventDefault(); if (!pendingImport) return;
    const submitter = $("historyMappingForm").querySelector('button[type="submit"]'); if (submitter.disabled) return; submitter.disabled = true;
    try {
      const mapping = { columns: Object.fromEntries([...document.querySelectorAll("[data-history-column]")].map(select => [select.dataset.historyColumn, select.value])),
        unit: $("historyMapUnit").value, priceMode: $("historyMapPriceMode").value, platform: $("historyMapDefaultPlatform").value, game: $("historyMapDefaultGame").value, type: $("historyMapDefaultType").value, currency: $("historyMapDefaultCurrency").value };
      await persistImport(pendingImport.text, pendingImport.fileName, mapping); $("historyMappingDialog").close();
    } catch (issue) { $("historyMappingError").textContent = issue.message; $("historyMappingError").hidden = false; $("historyMappingError").focus(); }
    finally { submitter.disabled = false; }
  });
  function resetPage() { page = 0; drillKey = null; render(); }
  $("historyFile").addEventListener("click", event => { event.currentTarget.value = ""; });
  $("historyFile").addEventListener("change", event => loadFile(event.target.files[0]));
  $("historyClear").addEventListener("click", () => {
    loadSequence++; dataset = null; result = null; page = 0; drillKey = null; view = "summary";
    $("historyFile").value = ""; $("historyFile").removeAttribute("aria-busy"); $("historyFileName").textContent = "尚未选择文件"; $("historyFileInfo").textContent = "Steam 买入与卖出记录，支持日期、游戏与账户筛选"; $("historyClear").disabled = true;
    message(); render();
  });
  $("historyFilters").addEventListener("submit", event => { event.preventDefault(); clearTimeout(searchTimer); resetPage(); });
  for (const id of ["historyStart", "historyEnd", "historyGame", "historyPlatform", "historyType", "historyCurrency", "historySort", "historyUnverified", "historyAccount"]) $(id).addEventListener("change", resetPage);
  $("historySearch").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(resetPage, 150); });
  for (const button of document.querySelectorAll("[data-history-range]")) button.addEventListener("click", () => {
    let range;
    const kind = button.dataset.historyRange;
    if (kind === "all") range = { start: "", end: "" };
    else if (kind === "latest") { const latest = steamRows().map(row => row.date).sort().at(-1); if (!latest) { message("请先导入 Steam 订单，再选择最新月份。"); return; } range = H.monthRange(new Date(latest + "T04:00:00Z")); }
    else range = H.monthRange(new Date(), kind === "previous" ? -1 : 0);
    $("historyStart").value = range.start; $("historyEnd").value = range.end; resetPage();
  });
  $("historySummaryView").addEventListener("click", () => { view = "summary"; drillKey = null; page = 0; renderTable(); });
  $("historyDetailView").addEventListener("click", () => { view = "details"; drillKey = null; page = 0; renderTable(); });
  $("historyBack").addEventListener("click", () => { view = "summary"; drillKey = null; page = 0; renderTable(); });
  $("historyPrevious").addEventListener("click", () => { page--; renderTable(); });
  $("historyNext").addEventListener("click", () => { page++; renderTable(); });
  $("historyRows").addEventListener("click", event => {
    const button = event.target.closest("[data-history-action]");
    const row = button && result?.items.find(item => item.key === button.dataset.key); if (!row) return;
    if (button.dataset.historyAction === "details") { drillKey = row.key; view = "details"; page = 0; renderTable(); }
    else {
      nameTarget = row; $("historyNameEnglish").textContent = `${row.gameName} · ${row.marketHashName}`;
      $("historyChineseName").value = ["待核对", "映射冲突"].includes(row.localized.status) ? "" : row.localized.name;
      $("historyNameError").hidden = true; $("historyNameDialog").showModal();
    }
  });
  $("historyNameClose").addEventListener("click", () => $("historyNameDialog").close());
  $("historyNameForm").addEventListener("submit", async event => {
    event.preventDefault(); const button = event.submitter; if (button) button.disabled = true;
    try {
      const name = $("historyChineseName").value.trim();
      if (!nameTarget || !/[\u3400-\u9fff]/.test(name) || name.length > 300) throw new Error("请输入包含中文的完整物品名称，最多 300 字符");
      await api("history:name-save", { appid: nameTarget.appid, marketHashName: nameTarget.marketHashName, name }); await refreshNames();
      $("historyNameDialog").close(); message("中文名称已保存，原始市场名与均价计算保持一致。"); render();
    } catch (issue) { $("historyNameError").textContent = issue.message; $("historyNameError").hidden = false; }
    finally { if (button) button.disabled = false; }
  });
  async function exportResult(kind) {
    if (!result?.rows.length || savingExport) return;
    savingExport = true; renderTable();
    try {
      const output = kind === "details" && drillKey ? { ...result, rows: selectedDetails() } : result;
      const f = filters(), fileName = `Steam订单${kind === "summary" ? "汇总" : "明细"}_${f.start || "最早"}_${f.end || "最新"}.csv`;
      const response = await api("history:export", { fileName, text: H.exportCsv(output, kind) });
      if (!response.cancelled) message(`已导出${kind === "summary" ? "汇总" : "明细"} CSV，包含${kind === "summary" ? output.items.length : output.rows.length} 条结果。`);
    } catch (issue) { error(issue.message); }
    finally { savingExport = false; renderTable(); }
  }
  $("historyExportSummary").addEventListener("click", () => exportResult("summary"));
  $("historyExportDetails").addEventListener("click", () => exportResult("details"));
  function renderNames() {
    const search = $("historyNamesSearch").value.trim().toLowerCase();
    const entries = Object.values(customNames).filter(row => [row.appid, row.marketHashName, row.name, row.conflict ? "冲突" : "", ...(row.candidates || []).map(c => c.name)].join(" ").toLowerCase().includes(search));
    $("historyNamesCount").textContent = `共 ${entries.length} 条匹配，显示前 ${Math.min(100, entries.length)} 条；可搜索完整名称缩小范围。`;
    $("historyNamesRows").replaceChildren(...entries.slice(0,100).map(row => {
      const tr = node("tr"), name = node("td", row.name || "中文名待核对"), english = node("td", row.marketHashName);
      english.append(node("small", row.appid === "570" ? "Dota 2" : row.appid === "730" ? "CS2" : `App ${row.appid}`));
      name.append(node("small", `${row.custom ? "手动核对优先" : row.source || "自动对照"}${row.conflict ? " · 来源存在冲突" : ""}`));
      if (row.conflict) name.append(node("small", (row.candidates || []).map(c => `${c.name}（${c.source}）`).join("；")));
      const action = node("td"), button = node("button", "编辑", "text-button"); button.type = "button";
      button.onclick = () => { $("historyNamesGame").value = row.appid; $("historyNamesEnglish").value = row.marketHashName; $("historyNamesChinese").value = row.name || ""; $("historyNamesChinese").focus(); };
      action.append(button); tr.append(english, name, action); return tr;
    }));
  }
  $("historyNames").onclick = async () => { try { await refreshNames(); renderNames(); $("historyNamesDialog").showModal(); } catch (issue) { error(issue.message); } };
  $("historyNamesClose").onclick = () => $("historyNamesDialog").close();
  $("historyNamesSearch").oninput = renderNames;
  $("historyNamesForm").onsubmit = async event => {
    event.preventDefault(); const button = $("historyNamesForm").querySelector('button[type="submit"]'); if (button.disabled) return; button.disabled = true;
    try {
      await api("history:name-save", { appid: $("historyNamesGame").value.trim(), marketHashName: $("historyNamesEnglish").value.trim(), name: $("historyNamesChinese").value.trim() });
      await refreshNames(); renderNames(); $("historyNamesStatus").textContent = "手动映射已入库，后续同步保留该名称。";
    } catch (issue) { $("historyNamesStatus").textContent = issue.message; }
    finally { button.disabled = false; }
  };
  const ready = (async () => {
    const saved = await api("storage:get", ["historyNames"]);
    for (const [key, value] of Object.entries(saved.historyNames || {})) {
      const match = /^(\d+):(.+)$/.exec(key);
      if (match && value?.custom && typeof value.name === "string") await api("history:name-save", { appid: match[1], marketHashName: match[2], name: value.name, onlyIfMissing: true });
    }
    await reloadArchive();
  })().catch(issue => { render(); error(`历史或名称映射无法载入：${issue.message}`); });
  window.buffDesktop.onChange?.(event => {
    if (["buff-orders", "uu-orders"].includes(event.kind) && event.value.job.status !== "running" || event.kind === "history" && event.action === "history:name-save") refreshNames().catch(issue => error(issue.message));
  });
  render();
  window.BuffHistoryWorkspace = { ready, importText, loadFile, reloadArchive, refreshNames, refresh: render, result: () => result };
})();
