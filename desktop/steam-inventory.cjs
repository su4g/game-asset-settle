"use strict";
// Parse inert markup. No Steam scripts, URLs or raw HTML enter the archive/UI.
const { parseFragment } = require("parse5");
const { createHash } = require("node:crypto");
const digest = value => createHash("sha256").update(JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b))) : v)).digest("hex");
const attrs = node => Object.fromEntries((node.attrs || []).map(a => [a.name, a.value]));
const has = (node, name) => (attrs(node).class || "").split(/\s+/).includes(name);
function all(node, test) { const found = []; function visit(n) { if (test(n)) found.push(n); for (const c of n.childNodes || []) visit(c); } visit(node); return found; }
const text = node => node?.nodeName === "#text" ? node.value : (node?.childNodes || []).map(text).join("");
const clean = value => typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 500) : "";
const digits = value => typeof value === "string" && /^\d{1,30}$/.test(value);
const fail = () => { throw new Error("Steam 库存历史格式无法核对，已保存的历史保留"); };
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function eventTime(date, clock) {
  const m = date.trim().match(/^(\d{1,2}) ([A-Za-z]{3}), (\d{4})$/), t = clock.trim().match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
  if (!m || !t || !MONTHS.includes(m[2]) || +t[1] < 1 || +t[1] > 12 || +t[2] > 59) return null;
  const hour = +t[1] % 12 + (t[3].toLowerCase() === "pm" ? 12 : 0), day = `${m[3]}-${String(MONTHS.indexOf(m[2]) + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const ms = Date.parse(`${day}T${String(hour).padStart(2, "0")}:${t[2]}:00+08:00`);
  return Number.isFinite(ms) && new Date(ms + 8 * 3600000).toISOString().slice(0, 10) === day ? new Date(ms).toISOString() : null;
}
function cursorValue(value) {
  if (value == null || value === false) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !["time", "time_frac", "s"].includes(k))) fail();
  const result = Object.fromEntries(["time","time_frac","s"].map(k => [k, String(value[k])]));
  if (!Object.values(result).every(digits) || +result.time < 0 || +result.time > 4102444800 || +result.time_frac >= 1000000000) fail();
  return result;
}
function parseInventoryPage(data, accountId) {
  if (!/^steam:\d{17}$/.test(accountId) || ![true, 1].includes(data?.success) || typeof data.html !== "string" || !Number.isSafeInteger(data.num) || data.num < 0 || data.num > 50) fail();
  const doc = parseFragment(data.html), rows = all(doc, n => has(n, "tradehistoryrow"));
  if (rows.length !== data.num) fail();
  const events = rows.map(row => {
    const action = clean(text(all(row, n => has(n, "tradehistory_event_description"))[0]));
    const date = all(row, n => has(n, "tradehistory_date"))[0], clock = all(date || {}, n => has(n, "tradehistory_timestamp"))[0];
    const at = eventTime((date?.childNodes || []).filter(n => n !== clock).map(text).join(""), text(clock));
    if (!action || !at) fail();
    const items = [], identities = new Set();
    for (const group of all(row, n => has(n, "tradehistory_items"))) {
      const sign = text(all(group, n => has(n, "tradehistory_items_plusminus"))[0]).trim();
      if (!["+", "-"].includes(sign)) fail();
      for (const node of all(group, n => has(n, "history_item"))) {
        const a = attrs(node), match = a.id?.match(/^history([a-f0-9]{40})_item(\d+)$/);
        if (!match || a["data-appid"] !== "730" || !digits(a["data-classid"]) || !digits(a["data-instanceid"]) || !digits(a["data-contextid"]) || !/^\d+$/.test(a["data-amount"]) || !Number.isSafeInteger(+a["data-amount"]) || +a["data-amount"] < 1) fail();
        identities.add(match[1]);
        const d = data.descriptions?.["730"]?.[a["data-classid"] + "_" + a["data-instanceid"]];
        if (d && (String(d.appid) !== "730" || String(d.classid) !== a["data-classid"] || String(d.instanceid) !== a["data-instanceid"])) fail();
        let assetId = "";
        try { const u = new URL(a.href); if (u.origin === "https://steamcommunity.com" && !u.username && !u.password && /^\/(profiles\/\d{17}|id\/[^/]+)\/inventory\/$/.test(u.pathname)) assetId = u.hash.match(/^#730_2_(\d{1,30})$/)?.[1] || ""; } catch {}
        const tag = category => clean(d?.tags?.find(t => t.category === category)?.internal_name);
        items.push({ index: +match[2], direction: sign === "+" ? "in" : "out", appid: 730, contextId: a["data-contextid"], classId: a["data-classid"], instanceId: a["data-instanceid"], assetId,
          quantity: +a["data-amount"], name: clean(d?.market_name) || clean(text(all(node, n => has(n, "history_item_name"))[0])), marketHashName: clean(d?.market_hash_name), collection: tag("ItemSet"), rarity: tag("Rarity") });
      }
    }
    if (identities.size !== 1 || !items.length || new Set(items.map(i => i.index)).size !== items.length) fail();
    const eventId = [...identities][0], inputs = items.filter(i => i.direction === "out"), outputs = items.filter(i => i.direction === "in");
    const inputQuantity = inputs.reduce((n, i) => n + i.quantity, 0), outputQuantity = outputs.reduce((n, i) => n + i.quantity, 0);
    // A real CS2 Crafted event with both sides, never a snapshot disappearance.
    const craft = action === "Crafted" && [5, 10].includes(inputQuantity) && outputQuantity === 1;
    const kind = craft ? "trade-up" : action === "Crafted" ? "unrecognized-craft" : /^(Moved to Storage Unit|Retrieved from Storage Unit)$/.test(action) ? "storage" : "other";
    // Storage movements are not economic consumption; retain their identity/time
    // for paging coverage, without copying thousands of redundant item names.
    return { key: `${accountId}:inventory:${eventId}`, accountId, eventId, appid: 730, at, timePrecision: "minute", kind,
      action: kind === "other" ? (/Community Market/.test(action) ? "market" : /^(Traded|You traded with )/.test(action) ? "trade" : "other") : action,
      items: kind === "storage" ? [] : items };
  });
  if (new Set(events.map(e => e.key)).size !== events.length) fail();
  const cursor = cursorValue(data.cursor);
  if (!events.length && cursor) fail();
  return { events, cursor, signature: digest(events.map(e => e.key)) };
}
function sameEvent(a, b) {
  // An output can lose its inventory href after sale; the description identity
  // and name remain the event evidence. Preserve an already seen asset ID.
  const core = e => ({ ...e, items: e.items.map(i => ({ ...i, assetId: "", name: "", marketHashName: "", collection: "", rarity: "" })) });
  return digest(core(a)) === digest(core(b));
}
function mergeEvent(old, next) {
  if (!old) return next;
  if (!sameEvent(old, next)) throw new Error("Steam 库存事件内容发生变化，请核对；原历史保留");
  return { ...next, items: next.items.map((i, n) => {
    const before = old.items[n], merged = { ...i, name: i.marketHashName ? i.name : before.name || i.name, assetId: before.assetId || i.assetId };
    for (const key of ["marketHashName","collection","rarity"]) {
      if (before[key] && i[key] && before[key] !== i[key]) throw new Error("Steam 库存事件内容发生变化，请核对；原历史保留");
      merged[key] = before[key] || i[key];
    }
    return merged;
  }) };
}
function validateInventory(value, accountId) {
  if (value == null) return;
  if (value.version !== 1 || !Array.isArray(value.events) || !value.coverage || typeof value.coverage.complete !== "boolean") fail();
  const fields = (o, list) => { if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some(k => !list.includes(k))) fail(); };
  fields(value, ["version","events","coverage"]);
  fields(value.coverage, ["complete","cursor","stopReason","syncedAt","pages","eventCount","fromAt"]);
  if (!["checkpoint","end","known"].includes(value.coverage.stopReason) || !Number.isFinite(Date.parse(value.coverage.syncedAt)) || !Number.isSafeInteger(value.coverage.pages) || value.coverage.pages < 0 || value.coverage.eventCount !== value.events.length) fail();
  const keys = new Set();
  for (const e of value.events) {
    fields(e, ["key","accountId","eventId","appid","at","timePrecision","kind","action","items"]);
    if (!["Crafted","Moved to Storage Unit","Retrieved from Storage Unit","market","trade","other"].includes(e.action)) fail();
    if (e.accountId !== accountId || !/^[a-f0-9]{40}$/.test(e.eventId) || e.key !== `${accountId}:inventory:${e.eventId}` || keys.has(e.key) || e.appid !== 730 || e.timePrecision !== "minute" || !Number.isFinite(Date.parse(e.at)) || new Date(e.at).toISOString() !== e.at || !["trade-up","unrecognized-craft","storage","other"].includes(e.kind) || !Array.isArray(e.items)) fail();
    keys.add(e.key);
    for (const i of e.items) if (!["in","out"].includes(i.direction) || i.appid !== 730 || ![i.contextId,i.classId,i.instanceId].every(digits) || i.assetId && !digits(i.assetId) || !Number.isSafeInteger(i.quantity) || i.quantity < 1 || !Number.isSafeInteger(i.index) || i.index < 0 || [i.name,i.marketHashName,i.collection,i.rarity].some(s => typeof s !== "string" || s.length > 500 || /[\u0000-\u001f]/.test(s))) fail();
    for (const i of e.items) fields(i, ["index","direction","appid","contextId","classId","instanceId","assetId","quantity","name","marketHashName","collection","rarity"]);
    if (new Set(e.items.map(i => i.index)).size !== e.items.length) fail();
    if (e.kind === "trade-up" && (e.action !== "Crafted" || ![5,10].includes(e.items.filter(i => i.direction === "out").reduce((s,i) => s+i.quantity,0)) || e.items.filter(i => i.direction === "in").reduce((s,i) => s+i.quantity,0) !== 1)) fail();
  }
  cursorValue(value.coverage.cursor);
  if (value.coverage.fromAt != null && (!Number.isFinite(Date.parse(value.coverage.fromAt)) || new Date(value.coverage.fromAt).toISOString() !== value.coverage.fromAt)) fail();
}
module.exports = { parseInventoryPage, eventTime, cursorValue, mergeEvent, validateInventory };
