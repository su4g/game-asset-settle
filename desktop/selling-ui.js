"use strict";
(() => {
  const P = window.BuffDesktopPricing, C = window.BuffHelperCommon, W = window.BuffPriceWorkspace;
  const $ = id => document.getElementById(id);
  const money = value => value == null ? "—" : C.formatCents(value);
  const fold = value => value == null ? "待补全" : `≥ ${C.formatDiscount(value, { roundUp: true })}`;
  const profit = value => value == null ? "利润待补全" : value === 0 ? "保本 ¥0.00" : `${value > 0 ? "盈利" : "亏损"} ${money(Math.abs(value))}`;
  const date = value => value == null ? "无观测时间" : new Date(value).toLocaleString("zh-CN", { hour12: false });
  const localDate = value => value == null ? "" : new Date(value - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 23);
  let holdings = [], comparisons = [], loaded = false, sequence = 0, timer, quoteTarget, quoteOriginal;
  function node(tag, text, className) { const el = document.createElement(tag); if (text != null) el.textContent = text; if (className) el.className = className; return el; }
  function error(id, message = "") { $(id).textContent = message; $(id).hidden = !message; }
  function fillSettings() {
    const s = W.settings();
    $("sellingDiscount").value = Number((s.targetCashoutRatio * 10).toFixed(3));
    $("sellingFees").textContent = `BUFF 卖出手续费：CS2 ${s.buffCsgoSellFeePercent}% / Dota 2 ${s.buffDota2SellFeePercent}%；Steam 按分位手续费反推净到账。`;
  }
  function rowElement(row) {
    const tr = node("tr"), h = row.holding, q = row.quote;
    tr.dataset.holdingId = h.id;
    const cells = Array.from({ length: 6 }, () => node("td"));
    cells[0].append(node("strong", h.name || h.marketHashName, "quote-name"), node("small", `${h.appid === 570 ? "Dota 2" : "CS2"} · 剩余 ${row.quantity} 件`), node("small", `实际剩余成本 ${money(row.costCents)}`), node("small", `买入 ${date(h.boughtAt)}`));
    if (h.status === "cooling") cells[0].append(node("small", "冷却中 · 按报价试算"));
    const edit = node("button", "更新报价", "text-button"); edit.type = "button"; edit.dataset.sellingQuote = h.id;
    edit.setAttribute("aria-label", `更新报价：${h.name || h.marketHashName}`); cells[0].append(edit);
    for (const [label, value] of [["保本", row.breakEvenCashoutRatio], ["比挂售更赚", row.beatBuffAskCashoutRatio], ["比求购更赚", row.beatBuffBidCashoutRatio]]) {
      const entry = node("div", null, "selling-threshold"); entry.append(node("small", label), node("strong", fold(value))); cells[1].append(entry);
    }
    if (row.quoteError) cells[1].append(node("small", row.quoteError));
    for (const [i, route] of row.routes.entries()) {
      const cell = cells[i + 2]; cell.dataset.route = route.id;
      cell.append(node("strong", profit(route.profitCents), `selling-profit ${route.profitCents > 0 ? "gain" : route.profitCents < 0 ? "loss" : ""}`));
      cell.append(node("small", `预计回款 ${money(route.proceedsCents)}`));
      const price = [q?.buffPriceCents, q?.buffBuyPriceCents, q?.steamLowestSellCents][i];
      const at = [q?.buffUpdatedAt, q?.buffBuyUpdatedAt, q?.steamUpdatedAt][i];
      cell.append(node("small", `单价 ${price == null ? "—" : C.formatCents(price, q.currencyCode)}`), node("small", date(at)));
      if (route.id === "steam") cell.append(node("small", `Steam 净余额 ${money(row.steamNetCents)}`));
      if (route.issue) cell.append(node("small", route.issue, "price-status stale"));
      if (row.bestRoutes.includes(route.id)) cell.classList.add("selling-best");
    }
    const best = cells[5];
    if (!row.bestRoutes.length) best.append(node("strong", "暂不能判断"), node("small", row.costCents == null ? "请补全实际现金成本" : "请补全有效报价"));
    else {
      const names = row.routes.filter(route => row.bestRoutes.includes(route.id)).map(route => route.label).join(" / ");
      best.append(node("strong", names), node("small", `${row.bestRoutes.length > 1 ? "并列 · " : ""}${row.bestProfitCents < 0 ? "亏损最少" : "利润最高"}${row.complete ? "" : "（已知路线中）"}`), node("strong", profit(row.bestProfitCents), "selling-profit"));
      if (row.advantageCents != null) best.append(node("small", `比次高多回款 ${money(row.advantageCents)}`));
      if (!row.complete) best.append(node("small", "报价不全，不能判断全部卖法"));
    }
    tr.append(...cells); return tr;
  }
  function render() {
    const now = Date.now(), quotes = W.rows(), settings = W.settings();
    comparisons = holdings.map(row => P.compareHolding(row, quotes, settings, now));
    const needle = $("sellingSearch").value.trim().toLocaleLowerCase();
    const visible = comparisons.filter(row => `${row.holding.name} ${row.holding.marketHashName}`.toLocaleLowerCase().includes(needle));
    $("sellingRows").replaceChildren(...visible.map(rowElement));
    if (loaded && holdings.length && !visible.length) { const tr = node("tr"), td = node("td", "没有匹配的已购物品", "no-quotes"); td.colSpan = 6; tr.append(td); $("sellingRows").append(tr); }
    $("sellingEmpty").hidden = !loaded || holdings.length > 0;
    $("sellingSummary").textContent = loaded ? `${holdings.length} 笔剩余持仓 · ${comparisons.filter(row => row.complete).length} 笔可完整比较` : "尚未读取持仓";
    $("sellingCaption").textContent = `按净提现 ${(settings.targetCashoutRatio * 10).toFixed(3)} 折比较 · 金额为每批剩余物品合计 · 当前显示 ${visible.length} 笔`;
    clearTimeout(timer);
    const times = comparisons.flatMap(row => row.quote ? [row.quote.query.nextExpiresAt, row.quote.buffUpdatedAt, row.quote.buffBuyUpdatedAt, row.quote.steamUpdatedAt] : []).filter(time => time > now);
    if (times.length) timer = setTimeout(render, Math.min(2147483647, Math.min(...times) - now + 20));
  }
  async function refresh() {
    const request = ++sequence; $("refreshSelling").disabled = true; error("sellingError");
    try {
      await W.ready;
      const result = await window.buffDesktop.request("ledger", { path: "/holdings" });
      if (request !== sequence) return;
      if (!Array.isArray(result)) throw new Error("账本持仓返回格式无效");
      holdings = result.filter(row => row.confirmed === true && Number.isSafeInteger(row.remainingQuantity) && row.remainingQuantity > 0);
      loaded = true; render();
    } catch (issue) {
      if (request !== sequence) return;
      holdings = []; loaded = false; render(); error("sellingError", `无法读取最新持仓：${issue.message}`);
    } finally { if (request === sequence) $("refreshSelling").disabled = false; }
  }
  function openQuote(holding) {
    quoteTarget = holding; $("sellingQuoteForm").reset(); error("sellingQuoteError");
    $("sellingQuoteName").textContent = holding.marketHashName;
    let q;
    try { q = P.holdingQuote(holding, W.rows()); }
    catch (issue) { error("sellingError", issue.message); return; }
    for (const [field, price, at] of [["Ask", q.buffPriceCents, q.buffUpdatedAt], ["Bid", q.buffBuyPriceCents, q.buffBuyUpdatedAt], ["Steam", q.steamLowestSellCents, q.steamUpdatedAt]]) {
      $("sellingQuote" + field).value = price == null ? "" : (price / 100).toFixed(2);
      $("sellingQuote" + field + "At").value = localDate(at ?? (price == null ? Date.now() : null));
    }
    quoteOriginal = q;
    $("sellingQuoteDialog").showModal();
  }
  $("refreshSelling").addEventListener("click", refresh);
  $("sellingSearch").addEventListener("input", render);
  $("sellingRows").addEventListener("click", event => {
    const id = event.target.closest("[data-selling-quote]")?.dataset.sellingQuote;
    const holding = holdings.find(row => row.id === id); if (holding) openQuote(holding);
  });
  $("closeSellingQuote").addEventListener("click", () => $("sellingQuoteDialog").close());
  $("sellingSettingsForm").addEventListener("input", () => { error("sellingError"); $("sellingSettingsStatus").textContent = "折扣尚未保存，表格仍按已保存的设置比较。"; });
  $("sellingSettingsForm").addEventListener("submit", async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const input = $("sellingDiscount");
      if (!input.value || !input.checkValidity()) throw new Error("请填写 0～100 折范围内的净提现折扣，最多三位小数");
      await W.updateCashoutRatio(Number(input.value) / 10);
      $("sellingSettingsStatus").textContent = `已保存 ${(W.settings().targetCashoutRatio * 10).toFixed(3)} 折，并重新比较。`;
    } catch (issue) { error("sellingError", issue.message); $("sellingError").focus(); }
    finally { button.disabled = false; }
  });
  $("sellingQuoteForm").addEventListener("input", () => error("sellingQuoteError"));
  $("sellingQuoteForm").addEventListener("submit", async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try {
      const raw = { appid: quoteTarget.appid, marketHashName: quoteTarget.marketHashName, goodsId: quoteTarget.goodsId, name: quoteTarget.name, currencyCode: "CNY", source: "manual" };
      let count = 0, changed = 0;
      for (const [field, priceKey, timeKey] of [["Ask", "buffPriceCents", "buffUpdatedAt"], ["Bid", "buffBuyPriceCents", "buffBuyUpdatedAt"], ["Steam", "steamLowestSellCents", "steamUpdatedAt"]]) {
        const value = P.cents($("sellingQuote" + field).value, true); if (value == null) continue;
        const at = new Date($("sellingQuote" + field + "At").value).getTime();
        if (!Number.isSafeInteger(at) || at > Date.now()) throw new Error("每个已填价格都需要有效且不晚于当前的观测时间");
        count++;
        if (value === quoteOriginal[priceKey] && at === quoteOriginal[timeKey]) continue;
        raw[priceKey] = value; raw[timeKey] = at; changed++;
        // Editing a price at the same observed time must not extend an explicit expiry.
        if (at === quoteOriginal[timeKey]) {
          if (field === "Bid") raw.buffBuyExpiresAt = quoteOriginal.buffBuyExpiresAt;
          if (field === "Steam") raw.steamExpiresAt = quoteOriginal.steamExpiresAt;
        }
      }
      if (!count) throw new Error("请至少填写一种报价");
      if (changed) await W.upsertQuotes([P.normalizeRow(raw)]);
      $("sellingQuoteDialog").close();
    } catch (issue) { error("sellingQuoteError", issue.message); $("sellingQuoteError").focus(); }
    finally { button.disabled = false; }
  });
  window.addEventListener("price-settings-changed", () => { fillSettings(); render(); });
  window.addEventListener("price-quotes-changed", render);
  window.buffDesktop.onChange(event => { if (event.kind === "storage" && event.changes.ledgerChangedAt && !$("page-selling").hidden) refresh(); });
  const ready = W.ready.then(() => { fillSettings(); render(); }).catch(issue => error("sellingError", issue.message));
  window.BuffSellingWorkspace = { ready, refresh };
})();
