(() => {
  const clean = s => String(s || "").replace(/\s+/g, " ").trim();
  function cents(value) {
    const s = clean(value);
    if (!/[¥￥]|CNY|人民币/.test(s) || /[$€£]/.test(s)) return null;
    const match = s.replace(/,/g, "").match(/(?:[¥￥]|CNY)\s*([\d]+)(?:\.(\d{1,2}))?/);
    if (!match) return null;
    const n = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
    return Number.isSafeInteger(n) ? n : null;
  }
  function preciseDate(s) {
    const match = clean(s).match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return null;
    const [, y, mo, d, h, m, sec = "00"] = match;
    const text = `${y}-${mo.padStart(2,"0")}-${d.padStart(2,"0")}T${h.padStart(2,"0")}:${m}:${sec}+08:00`;
    return Number.isFinite(new Date(text).getTime()) ? new Date(text).toISOString() : null;
  }
  function steamEntry(entry) {
    // In Steam market history '+' means item acquired, '-' means item sold.
    if (clean(entry.sign) !== "-" || !/^\+/.test(clean(entry.price))) return null;
    const match = String(entry.url || "").match(/\/market\/listings\/(730|570)\/([^?#]+)/);
    if (!match) return null;
    let hash; try { hash = decodeURIComponent(match[2]); } catch { return null; }
    if (/^G\d+$/.test(hash)) return null;
    return { platform: "steam", sourceId: entry.id, appid: Number(match[1]), marketHashName: hash,
      name: clean(entry.name), quantity: 1, netTotalCents: cents(entry.price),
      soldAt: preciseDate(entry.date), receivedAt: null, dateLabel: clean(entry.date),
      datePrecision: preciseDate(entry.date) ? "minute" : "day", pending: !!entry.pending,
      sourceUrl: "https://steamcommunity.com/market/", rawText: clean(entry.rawText).slice(0,2000),
      note: "Steam 市场历史的正向钱包金额；实际到账时间需要核对（可能仍在待处理余额中）" };
  }
  function steamDocument(doc) {
    return Array.from(doc.querySelectorAll(".market_recent_listing_row[id^='history_row_']")).map(el => steamEntry({
      id: el.id, sign: el.querySelector(".market_listing_gainorloss")?.textContent,
      price: el.querySelector(".market_listing_price")?.textContent,
      name: el.querySelector(".market_listing_item_name")?.textContent,
      url: el.querySelector(".market_listing_item_name a[href*='/market/listings/']")?.href,
      date: el.querySelector(".market_listing_listed_date")?.textContent,
      pending: /待处理|待到账|pending/i.test(el.innerText || el.textContent), rawText: el.innerText || el.textContent,
    })).filter(Boolean);
  }
  function buffDocument(doc) {
    const records = [];
    for (const table of doc.querySelectorAll("table")) {
      const headings = Array.from(table.querySelectorAll("thead th, tr:first-child th")).map(x => clean(x.textContent));
      const column = (cells, pattern) => cells[headings.findIndex(h => pattern.test(h))]?.textContent || "";
      for (const el of table.querySelectorAll("tbody tr")) {
        const link = el.querySelector("a[href*='/goods/']");
        if (!link) continue;
        const cells = Array.from(el.querySelectorAll("td")), rawText = clean(el.innerText || el.textContent);
        if (/已取消|未支付|等待付款|出售中|已退款/.test(rawText)) continue;
        const netText = column(cells, /实际到账|净到账|实收|到手|净收入|到账金额/);
        const priceText = column(cells, /价格|售价|成交价/);
        const dateText = column(cells, /成交时间|交易时间|售出时间|订单时间/);
        const receivedText = column(cells, /到账时间|结算时间/);
        const quantity = Number(clean(column(cells, /数量/)).match(/\d+/)?.[0] || 1);
        const orderText = column(cells, /订单号|订单编号/);
        records.push({ platform: "buff", sourceId: el.getAttribute("data-order-id") || clean(orderText) || null,
          name: clean(link.textContent), marketHashName: el.getAttribute("data-market-hash-name") || "",
          appid: /game=dota2/.test(location.search) ? 570 : 730, goodsId: link.href.match(/\/goods\/(\d+)/)?.[1],
          quantity, netTotalCents: cents(netText), grossTotalCents: cents(priceText), soldAt: preciseDate(dateText),
          receivedAt: preciseDate(receivedText), dateLabel: clean(dateText), rawText: rawText.slice(0,2000), sourceUrl: location.href,
          note: netText ? "请核对平台净到账与到账时间" : "页面未明确标注扣费后到账，请手动填写，不能将成交价直接记为收入" });
      }
    }
    return records;
  }
  const api = { clean, cents, preciseDate, steamEntry, steamDocument, buffDocument };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof self !== "undefined") self.BuffSaleHistory = api;
})();
