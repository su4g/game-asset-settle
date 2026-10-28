"use strict";
// Synthetic values with the shape verified against Steam JSON + rendered HTML.
// No session values, account data, or private live-response fixture is included.
const owner = "76561198000000001", other = "76561198000000002";
const account = { id: "steam:" + owner, nickname: "Steam 测试账户" };
function trade(n, patch = {}) {
  const listingid = String(90071992547410000n + BigInt(n)), purchaseid = String(91071992547410000n + BigInt(n));
  const buy = patch.buy ?? n % 2 === 0, appid = patch.appid || 730, asset = { appid, contextid: "16", id: String(10000+n), amount: "1" };
  const event = { listingid, purchaseid, event_type: buy ? 4 : 3, time_event: 1792555200-n, time_event_fraction: 123000000, ...(patch.event || {}) };
  const purchase = { listingid, purchaseid, steamid_purchaser: buy ? owner : other, asset,
    failed: 0, needs_rollback: 0, funds_returned: 0, paid_amount: 3885, paid_fee: 582, steam_fee: 194, publisher_fee: 388, added_tax: 0,
    currencyid: buy ? 2023 : 2005, received_amount: buy ? 47836 : 203, received_currencyid: buy ? 2005 : 2023,
    time_sold: event.time_event, ...(patch.purchase || {}) };
  const description = { appid, id: asset.id, contextid: "2", unowned_id: asset.id, unowned_contextid: "16", amount: "0", original_amount: "1", name: "测试武器箱", market_hash_name: "Test Case", ...(patch.description || {}) };
  return { event, purchase, description, listing: { listingid, price: 1, currencyid: 2005, asset: { ...asset, contextid: "2", amount: "0" } } };
}
function page(trades, start = 0, pagesize = 100) {
  const slice = trades.slice(start,start+pagesize), data = { success: true, start, pagesize, total_count: trades.length, events: [], purchases: {}, listings: {}, assets: {} };
  for (const t of slice) {
    const { event:e, purchase:p, description:d, listing:l } = structuredClone(t);
    data.events.push(e); data.purchases[e.listingid+"_"+e.purchaseid] = p; data.listings[e.listingid] = l;
    ((data.assets[d.appid] ||= {})["2"] ||= {})[d.id] = d;
  }
  return data;
}
const html = (id = owner) => `<script>var g_steamID = "${id}";</script>`;
module.exports = { owner, other, account, trade, page, html };
