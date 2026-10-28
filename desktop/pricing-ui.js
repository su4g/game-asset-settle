"use strict";
(() => {
  const P = window.BuffDesktopPricing, C = window.BuffHelperCommon;
  const $ = id => document.getElementById(id), api = (action, value) => window.buffDesktop.request(action, value);
  const money = value => value == null ? "—" : C.formatCents(value);
  const fold = value => value == null ? "—" : `${(value * 10).toFixed(3)} 折`;
  let state = { rows: [], settings: { ...P.DEFAULTS } }, analyzed = [], expirationTimer;
  function node(tag, text, className) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; }
  function message(text = "") { $("priceMessage").textContent = text; $("priceMessage").hidden = !text; }
  function showError(id, error) { const el = $(id); el.textContent = error.message; el.hidden = false; el.focus(); }
  async function persist() { await api("storage:set", { priceWorkspace: state }); }
  function fillSettings() {
    const s = state.settings;
    for (const [id, value] of Object.entries({ feeCs2: s.buffCsgoSellFeePercent, feeDota: s.buffDota2SellFeePercent, candidateKnife: s.maxKnifeRatio * 10, candidateLiquidity: s.minLiquidity, candidateMaxPrice: s.maxBuffPriceCents ? (s.maxBuffPriceCents / 100).toFixed(2) : "", fundingDiscount: s.fundingDiscount == null ? "" : s.fundingDiscount * 10, scenarioDiscount: s.targetCashoutRatio * 10 })) $(id).value = value;
  }
  function stat(label, value, subtitle) {
    const el = node("div", null, "metric"); el.append(node("span", label, "metric-label"), node("strong", value), node("small", subtitle)); return el;
  }
  function lines(cell, primary, secondary) { cell.append(node("span", primary), node("small", secondary)); }
  function rowElement(row) {
    const tr = document.createElement("tr"); tr.dataset.key = row.key;
    const cells = Array.from({ length: 8 }, () => document.createElement("td"));
    const select = document.createElement("input"); select.type = "checkbox"; select.checked = row.selected; select.dataset.select = row.key; select.setAttribute("aria-label", `将 ${row.name} 加入模拟组合`); cells[0].append(select);
    const name = node("strong", row.name, "quote-name");
    const when = time => time == null ? "时间缺失" : new Date(time).toLocaleTimeString("zh-CN", { hour12: false });
    cells[1].append(name, node("small", `${row.appid === 570 ? "Dota 2" : "CS2"} · ${ { manual: "手动", import: "导入", ledger: "账本缓存", example: "示例" }[row.source] } · ${row.currencyCode}`), node("small", `BUFF ${when(row.buffUpdatedAt)} / Steam ${when(row.steamUpdatedAt)}`));
    cells[1].title = [row.marketHashName, `BUFF：${row.buffUpdatedAt ? new Date(row.buffUpdatedAt).toLocaleString() : "无时间"}`, `Steam：${row.steamUpdatedAt ? new Date(row.steamUpdatedAt).toLocaleString() : "无时间"}`].join("\n");
    const price = value => value == null ? "—" : C.formatCents(value, row.currencyCode);
    lines(cells[2], price(row.buffPriceCents), `Steam ${price(row.steamLowestSellCents)}`);
    lines(cells[3], fold(row.knifeRatio), `Steam 净 ${money(row.steamNetSellCents)}`); cells[3].className = "ratio-cell";
    if (row.instantKnifeRatio != null) cells[3].append(node("small", `卖求购 ${fold(row.instantKnifeRatio)}`));
    lines(cells[4], fold(row.cashoutRatio), `求购提现 ${fold(row.buyOrderCashoutRatio)}`);
    if (row.cashoutProfitCents != null) cells[4].append(node("small", `预计利润 ${money(row.cashoutProfitCents)}`));
    cells[4].title = `BUFF 求购价 ${price(row.buffBuyPriceCents)} · 净到账 ${money(row.buffBuyNetCents)}${row.query.buffBuyExpired ? " · 求购已过期" : ""}${row.buffBuyError ? " · 求购获取失败" : ""}`;
    lines(cells[5], C.formatSteamVolume(row.steamVolume24h), `${C.formatSteamVolume(row.steamVolume7d)} / 7 日`);
    cells[5].append(node("small", row.volumeFresh ? `流动系数 ${row.liquidityCoefficient ?? "—"}` : "成交量时间缺失 / 过期"));
    cells[6].append(node("span", row.ready ? row.candidate ? "达标" : "可计算" : row.issues.join(" · ") || "不可计算", `price-status ${row.ready ? row.candidate ? "qualified" : "" : "stale"}`));
    if (row.ready && row.query.buffBuyExpired) cells[6].append(node("small", "求购已过期"));
    if (row.selected) {
      const quantity = document.createElement("input"); quantity.type = "number"; quantity.min = "1"; quantity.max = "10000"; quantity.step = "1"; quantity.value = row.quantity; quantity.dataset.quantity = row.key;
      quantity.setAttribute("aria-label", `${row.name} 的模拟数量`); cells[6].append(quantity);
    }
    const remove = node("button", "移除", "text-button"); remove.type = "button"; remove.dataset.remove = row.key; remove.setAttribute("aria-label", `移除 ${row.name} 的本机报价`); cells[7].append(remove);
    tr.append(...cells); return tr;
  }
  function renderPortfolio() {
    const selected = analyzed.filter(row => row.selected);
    $("pricePortfolio").hidden = !selected.length;
    if (!selected.length) return;
    const { summary } = P.portfolio(analyzed);
    $("portfolioValues").replaceChildren(
      stat("模拟买入成本", money(summary.totalSpentCents), `${selected.length} 种 · ${selected.reduce((sum, row) => sum + row.quantity, 0)} 件，已知成本部分`),
      stat("Steam 预计净到账", summary.complete ? money(summary.totalNetCents) : "待补全报价", `${summary.pricedRecordCount} / ${summary.purchaseCount} 种报价有效`),
      stat("加权挂刀折扣", summary.complete ? fold(summary.averageDiscountRatio) : "待补全报价", "总成本 / 总预计净到账"),
      stat("保本提现门槛", summary.complete ? C.formatDiscount(summary.breakEvenCashoutRatio, { roundUp: true }) : "待补全报价", "向上取整，不低估保本门槛"),
    );
    const scenario = C.calculateCashoutScenario(summary, state.settings.targetCashoutRatio);
    $("scenarioResult").textContent = scenario ? `预计回款 ${money(scenario.proceedsCents)} · ${scenario.profitCents >= 0 ? "盈利" : "亏损"} ${money(Math.abs(scenario.profitCents))}` : "所选物品存在缺价、过期或币种不符，暂不计算全部回款。";
  }
  function render() {
    const now = Date.now(); analyzed = state.rows.map(row => P.analyzeRow(row, state.settings, now));
    const ready = analyzed.filter(row => row.ready), candidates = analyzed.filter(row => row.candidate);
    $("priceMetrics").replaceChildren(stat("本机报价", String(analyzed.length), "导入后保留原始报价时间"), stat("有效报价", String(ready.length), "两平台人民币报价均有效"), stat("筛选达标", String(candidates.length), "挂刀、成交量与最高价条件"), stat("待补全 / 已过期", String(analyzed.length - ready.length), "不参与有效折扣与达标筛选"));
    const [sortBy, direction] = $("priceSort").value.split(":");
    const visible = P.filterRows(analyzed, { search: $("priceSearch").value, scope: $("priceScope").value, candidatesOnly: $("priceCandidates").checked, sortBy, direction });
    $("priceRows").replaceChildren(...visible.map(rowElement));
    $("priceCount").textContent = `${visible.length} / ${analyzed.length} 件物品 · 金额按报价币种展示，仅人民币参与计算`;
    $("priceEmpty").hidden = analyzed.length > 0;
    if (!visible.length && analyzed.length) { const tr = document.createElement("tr"), td = node("td", "没有符合当前筛选的报价", "no-quotes"); td.colSpan = 8; tr.append(td); $("priceRows").append(tr); }
    renderPortfolio();
    clearTimeout(expirationTimer);
    const times = analyzed.flatMap(row => [row.query.nextExpiresAt, row.steamVolumeCheckedAt && row.steamVolumeCheckedAt + P.TTL, row.buffUpdatedAt, row.steamUpdatedAt, row.buffBuyUpdatedAt]).filter(time => time > now);
    if (times.length) expirationTimer = setTimeout(render, Math.min(2147483647, Math.min(...times) - now + 20));
  }
  async function commitRows(rows) {
    const previous = state.rows; state.rows = P.normalizeRows(rows);
    try { await persist(); } catch (error) { state.rows = previous; throw error; }
    render(); window.dispatchEvent(new Event("price-quotes-changed"));
  }
  async function setSettings(settings) {
    const previous = state.settings; state.settings = P.normalizeSettings(settings);
    try { await persist(); } catch (error) { state.settings = previous; throw error; }
    fillSettings(); render(); window.dispatchEvent(new Event("price-settings-changed"));
  }
  async function guarded(button, task, errorId) {
    button.disabled = true;
    if (errorId) $(errorId).hidden = true;
    try { await task(); } catch (error) { if (errorId) showError(errorId, error); else message(error.message); }
    finally { button.disabled = false; }
  }
  const localDate = time => { const date = new Date(time); return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19); };
  $("addQuote").addEventListener("click", () => { $("quoteForm").reset(); $("quoteError").hidden = true; $("quoteTime").value = localDate(Date.now()); $("quoteDialog").showModal(); });
  $("importQuotes").addEventListener("click", () => { $("importError").hidden = true; $("importDialog").showModal(); });
  for (const button of document.querySelectorAll("[data-close]")) button.addEventListener("click", () => $(button.dataset.close).close());
  for (const [id, errorId] of [["quoteForm", "quoteError"], ["quoteImportForm", "importError"]]) $(id).addEventListener("input", () => { $(errorId).hidden = true; });
  $("quoteForm").addEventListener("submit", event => {
    event.preventDefault(); guarded(event.submitter, async () => {
      const at = new Date($("quoteTime").value).getTime();
      if (!Number.isFinite(at) || at > Date.now()) throw new Error("报价时间必须是已发生的有效时间");
      const raw = P.normalizeRow({ appid: Number($("quoteGame").value), marketHashName: $("quoteName").value, currencyCode: "CNY", source: "manual",
        buffPriceCents: P.cents($("quoteBuff").value), steamLowestSellCents: P.cents($("quoteSteam").value), buffBuyPriceCents: P.cents($("quoteBuffBuy").value, true), steamHighestBuyCents: P.cents($("quoteSteamBuy").value, true),
        steamVolume24h: $("quote24h").value === "" ? null : Number($("quote24h").value), steamVolume7d: $("quote7d").value === "" ? null : Number($("quote7d").value), quantity: Number($("quoteQuantity").value),
        buffUpdatedAt: at, steamUpdatedAt: at, buffBuyUpdatedAt: $("quoteBuffBuy").value ? at : null, steamVolumeCheckedAt: $("quote24h").value || $("quote7d").value ? at : null });
      await commitRows(P.mergeRows(state.rows, [raw]).map(row => row.key === raw.key ? { ...row, quantity: raw.quantity } : row));
      $("quoteDialog").close(); message("报价已保存；计算结果不会创建购买记录。");
    }, "quoteError");
  });
  $("quoteFile").addEventListener("change", async () => {
    try { const file = $("quoteFile").files[0]; if (!file) return; if (file.size > 1024 * 1024) throw new Error("文件最多 1 MB"); $("quoteImportText").value = await file.text(); }
    catch (error) { showError("importError", error); }
  });
  $("importTemplate").addEventListener("click", () => { $("quoteImportText").value = JSON.stringify(P.examples(), null, 2); });
  $("quoteImportForm").addEventListener("submit", event => {
    event.preventDefault(); guarded(event.submitter, async () => { const rows = P.parseImport($("quoteImportText").value); await commitRows(P.mergeRows(state.rows, rows)); $("importDialog").close(); message(`已校验 ${rows.length} 条报价，按物品合并并保留较新的平台报价时间。`); }, "importError");
  });
  $("priceExamples").addEventListener("click", event => guarded(event.currentTarget, async () => { await commitRows(P.mergeRows(state.rows, P.examples())); message("示例只用于演示算法，并非真实行情。勾选左侧复选框可查看组合保本门槛。"); }));
  $("loadLedgerQuotes").addEventListener("click", event => guarded(event.currentTarget, async () => {
    const holdings = await api("ledger", { path: "/holdings" });
    const rows = holdings.filter(row => row.quote).map(row => ({ appid: row.appid, marketHashName: row.marketHashName, name: row.name, goodsId: row.goodsId, currencyCode: row.currencyCode || "CNY", source: "ledger",
      buffPriceCents: row.quote.buffPriceCents, steamLowestSellCents: row.quote.steamPriceCents, buffUpdatedAt: row.quote.buffObservedAt, steamUpdatedAt: row.quote.steamObservedAt }));
    await commitRows(P.mergeRows(state.rows, rows)); message(rows.length ? `读取 ${rows.length} 条持仓报价缓存；过期价格已标记，不刷新时间。` : "本机持仓暂无可读取的报价缓存，可手动录入或导入文件。");
  }));
  $("priceSettingsForm").addEventListener("submit", event => {
    event.preventDefault(); guarded(event.submitter, async () => { await setSettings({ ...state.settings, buffCsgoSellFeePercent: Number($("feeCs2").value), buffDota2SellFeePercent: Number($("feeDota").value), maxKnifeRatio: Number($("candidateKnife").value) / 10, minLiquidity: Number($("candidateLiquidity").value), maxBuffPriceCents: P.cents($("candidateMaxPrice").value, true) || 0, fundingDiscount: $("fundingDiscount").value === "" ? null : Number($("fundingDiscount").value) / 10 }); message("已按当前手续费与门槛重新计算，原始报价时间保持不变。"); });
  });
  $("scenarioForm").addEventListener("submit", event => { event.preventDefault(); guarded(event.submitter, () => setSettings({ ...state.settings, targetCashoutRatio: Number($("scenarioDiscount").value) / 10 })); });
  $("priceSearch").addEventListener("input", render);
  for (const id of ["priceScope", "priceSort", "priceCandidates"]) $(id).addEventListener("change", render);
  $("priceRows").addEventListener("change", event => {
    const input = event.target, id = input.dataset.select || input.dataset.quantity;
    if (!id) return;
    const rows = state.rows.map(row => row.key === id ? { ...row, ...(input.dataset.select ? { selected: input.checked } : { quantity: Number(input.value) }) } : row);
    commitRows(rows).catch(error => { message(error.message); render(); });
  });
  $("priceRows").addEventListener("click", event => { const id = event.target.closest("[data-remove]")?.dataset.remove; if (id) commitRows(state.rows.filter(row => row.key !== id)).catch(error => message(error.message)); });
  const ready = (async () => {
    try {
      const stored = await api("storage:get", ["priceWorkspace", "calculatorDraft"]), saved = stored.priceWorkspace;
      if (saved) state = { rows: P.normalizeRows(saved.rows), settings: P.normalizeSettings(saved.settings) };
      else if (stored.calculatorDraft?.buffFee !== "" && stored.calculatorDraft?.buffFee != null) {
        const fee = Number(stored.calculatorDraft.buffFee);
        if (Number.isFinite(fee) && fee >= 0 && fee <= 100) state.settings[Number(stored.calculatorDraft.game) === 570 ? "buffDota2SellFeePercent" : "buffCsgoSellFeePercent"] = fee;
      }
      fillSettings(); render();
    } catch (error) { message(`无法载入报价：${error.message}`); throw error; }
  })();
  window.BuffPriceWorkspace = { ready, refresh: render, settings: () => ({ ...state.settings }), rows: () => state.rows.map(row => ({ ...row })),
    upsertQuotes: rows => commitRows(P.mergeRows(state.rows, rows)),
    updateCashoutRatio: value => setSettings({ ...state.settings, targetCashoutRatio: value }),
    updateFee: (appid, value) => setSettings({ ...state.settings, [Number(appid) === 570 ? "buffDota2SellFeePercent" : "buffCsgoSellFeePercent"]: value }) };
})();
