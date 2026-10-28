"use strict";
const { createHash } = require("node:crypto");
const H = require("../desktop/market-history.js");
const { HttpError } = require("./validation.cjs");
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const chinese = value => typeof value === "string" && /[\u3400-\u9fff]/.test(value);
const text = (value, max = 500) => typeof value === "string" && value.length <= max && !/[\u0000-\u001f]/.test(value);
const fail = message => { throw new HttpError(400, message); };
const comparable = row => Object.fromEntries(Object.entries(row).filter(([key]) => !["observedAt", "sourceRow", "fileName", "importedAt"].includes(key)).sort(([a], [b]) => a.localeCompare(b)));
// jsonb may reorder nested object keys on persistence. Provenance metadata is
// semantically unchanged by that reordering; arrays still retain their order.
const sortedObject = (_key, value) => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value;
function same(a, b) { return JSON.stringify(comparable(a), sortedObject) === JSON.stringify(comparable(b), sortedObject); }
function candidate(appid, marketHashName, name, source) {
  return /^\d+$/.test(String(appid)) && text(marketHashName) && /[A-Za-z]/.test(marketHashName) && !chinese(marketHashName) && text(name) && chinese(name) ? { appid: String(appid), marketHashName, name, source } : null;
}
function learnName(old, next, now = new Date().toISOString()) {
  if (!next) return old;
  const result = old ? structuredClone(old) : { appid: next.appid, marketHashName: next.marketHashName, candidates: [] };
  if (result.candidates.some(item => item.name === next.name && item.source === next.source)) return old;
  if (result.candidates.length >= 30) { result.conflict = true; return result; }
  result.candidates.push({ name: next.name, source: next.source });
  const choices = [...new Set(result.candidates.map(item => item.name))];
  result.conflict = choices.length > 1;
  if (!result.custom) { result.name = choices.length === 1 ? choices[0] : ""; result.source = result.conflict ? "存在名称冲突" : result.candidates[0].source; }
  result.checkedAt = now;
  return result;
}
function csvRecords(dataset, scope, documentHash) {
  const ranks = new Map(), identified = new Map();
  // Only a complete, server-parsed standard export can establish ordering within
  // a calendar day. The document hash records provenance, never transaction identity.
  const ordered = typeof documentHash === "string" && /^[a-f0-9]{64}$/.test(documentHash) && dataset.rows.length > 0 && dataset.rows.every((row, index, rows) =>
    row.platform === "steam" && row.sourceFormat === "steam-market-history" && row.amountSemantics === "actual" &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.date) && Number.isSafeInteger(row.sourceRow) && row.sourceRow >= 2 &&
    (!index || rows[index - 1].date >= row.date && rows[index - 1].sourceRow < row.sourceRow));
  return dataset.rows.flatMap(row => {
    const base = [scope, row.platformName, row.appid, row.type, row.currency];
    // One order may contain several distinct assets. A market name alone is never an order ID.
    let key;
    if (row.orderId) {
      if (!text(row.orderId, 200) || !text(row.assetId || "", 200)) fail("订单号或资产 ID 格式无效");
      key = hash([...base, "order", row.orderId, row.assetId || row.marketHashName]);
      const duplicate = identified.get(key);
      if (duplicate) { if (!same(duplicate, row)) fail("同一订单中的同一物品存在不同金额或数量，请核对 CSV"); return []; }
      identified.set(key, row);
    } else {
      // Retain the maximum multiplicity of indistinguishable rows across overlapping exports.
      const source = (row.sourceTime || "").trim(), suffix = source.match(/[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)$/)?.[1];
      const time = suffix ? new Date(`${row.date}T${suffix}${/(?:Z|[+-]\d{2}:\d{2})$/.test(suffix) ? "" : "+08:00"}`).toISOString() : row.date;
      const fingerprint = hash([...base, row.marketHashName, row.assetId || "", time, row.quantity, row.totalCents]);
      const rank = (ranks.get(fingerprint) || 0) + 1; ranks.set(fingerprint, rank);
      key = hash([fingerprint, rank]);
    }
    const record = { ...row, key, scope, fileName: dataset.fileName };
    delete record.sourceSequence;
    if (ordered) record.sourceSequence = { format: "steam-market-history", documentHash, row: row.sourceRow, direction: "newest-first" };
    return [record];
  });
}
class HistoryStore {
  constructor(pool) { this.pool = pool; }
  async transaction(fn) {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(3217002)"); const result = await fn(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async learn(client, candidates) {
    const catalog = new Map((await client.query("SELECT key,payload FROM desktop_history_names")).rows.map(row => [row.key, row.payload]));
    const changed = new Map();
    for (const item of candidates) {
      if (!item) continue;
      const key = `${item.appid}:${item.marketHashName}`, old = catalog.get(key), next = learnName(old, item);
      if (next !== old) { catalog.set(key, next); changed.set(key, next); }
    }
    if (changed.size) await client.query(`INSERT INTO desktop_history_names(key,payload) SELECT key,payload FROM jsonb_to_recordset($1::jsonb) AS x(key text,payload jsonb)
      ON CONFLICT(key) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()`, [JSON.stringify([...changed].map(([key, payload]) => ({ key, payload })))]);
    return changed.size;
  }
  buff() { return this.orders("buff"); }
  uu() { return this.orders("uu"); }
  async orders(kind) {
    if (!["buff","uu","steam"].includes(kind)) fail("历史平台无效");
    // Consistent metadata + records even if another desktop commits concurrently.
    return this.transaction(async client => {
      const state = (await client.query("SELECT revision,payload FROM desktop_history_state WHERE kind=$1", [kind])).rows[0];
      const data = state?.payload || { version: 1, accounts: {}, cooldownUntil: 0 };
      for (const value of Object.values(data.accounts)) value.records = [];
      for (const { payload } of (await client.query("SELECT payload FROM desktop_history_records WHERE kind=$1", [kind])).rows) {
        if (data.accounts[payload.accountId]) data.accounts[payload.accountId].records.push(payload);
      }
      return { revision: state?.revision || 0, exists: Boolean(state), data };
    });
  }
  saveBuff(value) { return this.saveOrders("buff", value); }
  saveUu(value) { return this.saveOrders("uu", value); }
  async saveOrders(kind, { revision, data }) {
    if (!["buff","uu","steam"].includes(kind)) fail("历史平台无效");
    const label = kind === "buff" ? "BUFF" : kind === "steam" ? "Steam" : "悠悠";
    if (!Number.isInteger(revision) || !data || data.version !== 1 || !data.accounts || Array.isArray(data.accounts) || Object.keys(data.accounts).length > 100) fail(label + " 历史存档格式无效");
    const records = [], metadata = structuredClone(data);
    for (const [id, account] of Object.entries(data.accounts)) {
      if (!new RegExp(`^${kind}:[A-Za-z0-9_-]{1,100}$`).test(id) || account.account?.id !== id || !Array.isArray(account.records) || !Array.isArray(account.runs)) fail(label + " 账号历史格式无效");
      if (kind === "steam") try { require("../desktop/steam-inventory.cjs").validateInventory(account.inventoryHistory, id); } catch (error) { fail(error.message); }
      metadata.accounts[id].records = [];
      for (const row of account.records) {
        if (row.accountId !== id || (kind === "steam" ? !Number.isSafeInteger(row.appid) || row.appid < 1 : ![570,730].includes(row.appid)) || !["buy","sell"].includes(row.direction) || !["history","pending"].includes(row.channel) || !/^[A-Za-z0-9_-]{1,100}$/.test(row.orderId) || !/^\d+$/.test(row.goodsId) || row.key !== [id,row.appid,row.direction,row.channel,row.orderId,...(kind === "uu" ? [row.lineId] : [])].join(":")) fail(label + " 订单身份无效");
        if (!text(row.name) || !text(row.marketHashName) || typeof row.completed !== "boolean" || row.quantity != null && (!Number.isSafeInteger(row.quantity) || row.quantity < 1)) fail(label + " 订单信息无效");
        for (const field of ["unitPriceCents","grossTotalCents","paidTotalCents","netTotalCents","feeCents","saleProceedsCents"]) if (row[field] != null && (!Number.isSafeInteger(row[field]) || row[field] < 0)) fail(label + " 订单金额无效");
        if (kind === "uu" && (row.appid !== 730 || row.channel !== "history" || row.state !== "340" || !row.completed || !/^[A-Za-z0-9_-]{1,100}$/.test(row.lineId) || row.quantity !== 1 || row.currencyCode !== "CNY" || !Number.isSafeInteger(row.grossTotalCents) || [row.createdAt,row.tradedAt].some(date => date != null && (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date)))) fail("悠悠订单格式无效");
        if (kind === "steam" && (!/^steam:\d{17}$/.test(id) || row.channel !== "history" || !/^\d+_\d+$/.test(row.orderId) || row.orderId !== row.listingId + "_" + row.purchaseId || row.assetId !== row.goodsId || !/^\d+$/.test(row.contextId) || !["COMPLETED","UNKNOWN","FAILED","REFUNDED","REVOKED","ROLLBACK"].includes(row.state) || row.completed !== (row.state === "COMPLETED") || !["held","released","unknown","returned","revoked","unconfirmed"].includes(row.fundsStatus) || row.receivedAt !== null || row.tradedAt != null && (!Number.isFinite(Date.parse(row.tradedAt)) || new Date(row.tradedAt).toISOString() !== row.tradedAt) || row.direction === "sell" && row.fundsStatus !== "released" && row.netTotalCents != null)) fail("Steam 订单格式无效");
        if (kind === "steam" && (!/^(?:[A-Z]{3})?$/.test(row.currencyCode) || !Array.isArray(row.assetAliases) || row.assetAliases.length > 5 || !row.assetAliases.includes(row.assetId) || row.assetAliases.some(value => typeof value !== "string" || !/^\d{1,30}$/.test(value)) ||
          [row.eventAt,row.fundsHeldUntil].some(date => date != null && (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString() !== date)) ||
          row.paidTotalCents != null && (row.direction !== "buy" || !row.currencyCode) || row.netTotalCents != null && (row.direction !== "sell" || !row.completed || !row.currencyCode) || row.saleProceedsCents != null && (row.direction !== "sell" || !row.currencyCode))) fail("Steam 收支或时间证据无效");
        records.push(row);
      }
    }
    if (new Set(records.map(row => row.key)).size !== records.length) fail(label + " 存档中存在重复订单");
    return this.transaction(async client => {
      const previous = (await client.query("SELECT revision,payload FROM desktop_history_state WHERE kind=$1", [kind])).rows[0];
      if ((previous?.revision || 0) !== revision) throw new HttpError(409, "历史已被其他窗口更新，请重新打开 App 后再同步");
      if (kind === "steam") for (const [id, account] of Object.entries(previous?.payload?.accounts || {})) {
        const events = new Map((data.accounts[id]?.inventoryHistory?.events || []).map(e => [e.key,e]));
        for (const before of account.inventoryHistory?.events || []) {
          if (!events.has(before.key)) fail("不能移除已存档的 Steam 库存事件");
          try { events.set(before.key, require("../desktop/steam-inventory.cjs").mergeEvent(before, events.get(before.key))); } catch (error) { fail(error.message); }
        }
        if (metadata.accounts[id]?.inventoryHistory) metadata.accounts[id].inventoryHistory.events = [...events.values()];
      }
      const old = (await client.query("SELECT key,payload FROM desktop_history_records WHERE kind=$1", [kind])).rows;
      const nextKeys = new Set(records.map(row => row.key));
      if (old.some(row => row.payload.channel === "history" && !nextKeys.has(row.key))) fail("不能移除已存档的 " + label + " 历史");
      const oldMap = new Map(old.map(row => [row.key, row.payload]));
      for (const row of records) {
        const before = oldMap.get(row.key);
        if (before) {
          const oldTemplate = before.templateId || (before.goodsId !== before.lineId ? before.goodsId : "");
          const newTemplate = row.templateId || (row.goodsId !== row.lineId ? row.goodsId : "");
          const identityChanged = kind === "uu" ? before.lineId !== row.lineId || oldTemplate && newTemplate && oldTemplate !== newTemplate : before.goodsId !== row.goodsId;
          if (identityChanged || before.marketHashName && row.marketHashName && before.marketHashName !== row.marketHashName) fail(label + " 订单物品身份冲突");
        }
      }
      await this.upsert(client, kind, records.filter(row => !oldMap.has(row.key) || !same(oldMap.get(row.key), row)));
      const removed = old.filter(row => !nextKeys.has(row.key)).map(row => row.key);
      if (removed.length) await client.query("DELETE FROM desktop_history_records WHERE kind=$1 AND key=ANY($2::text[])", [kind,removed]);
      const namesUpdated = await this.learn(client, records.map(row => candidate(row.appid, row.marketHashName, row.name, label + " 订单")));
      await client.query("INSERT INTO desktop_history_state(kind,revision,payload) VALUES($1,$2,$3) ON CONFLICT(kind) DO UPDATE SET revision=EXCLUDED.revision,payload=EXCLUDED.payload", [kind, revision + 1, metadata]);
      return { revision: revision + 1, namesUpdated };
    });
  }
  async upsert(client, kind, rows) {
    if (!rows.length) return;
    await client.query(`INSERT INTO desktop_history_records(kind,key,payload) SELECT $1,key,payload FROM jsonb_to_recordset($2::jsonb) AS x(key text,payload jsonb)
      ON CONFLICT(kind,key) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()`, [kind, JSON.stringify(rows.map(payload => ({ key: payload.key, payload })))]);
  }
  async csv() {
    const [records, imports] = await Promise.all([this.pool.query("SELECT payload FROM desktop_history_records WHERE kind='csv' ORDER BY payload->>'date' DESC,key"), this.pool.query("SELECT payload FROM desktop_history_imports ORDER BY imported_at DESC LIMIT 30")]);
    const rows = records.rows.map(row => row.payload), dates = rows.map(row => row.date).sort();
    return { fileName: "已入库 CSV 历史", rows, start: dates[0] || "", end: dates.at(-1) || "", imports: imports.rows.map(row => row.payload), importedAt: Date.now() };
  }
  async importCsv({ text: content, fileName, mapping, scope = "默认账户" }) {
    if (typeof content !== "string" || Buffer.byteLength(content) > H.MAX_BYTES || !text(fileName, 200) || !text(scope, 100) || !scope.trim()) fail("CSV 内容、文件名或账户标记无效");
    let dataset;
    try { dataset = H.parseImport(content, fileName, mapping); } catch (error) { fail(error.message); }
    const documentHash = createHash("sha256").update(content).digest("hex");
    const records = csvRecords(dataset, scope.trim(), documentHash);
    return this.transaction(async client => {
      const existing = (await client.query("SELECT key,payload FROM desktop_history_records WHERE kind='csv'")).rows;
      const old = new Map(existing.map(row => [row.key, row.payload]));
      let inserted = 0, updated = 0, skipped = dataset.rows.length - records.length;
      const changes = [];
      for (const row of records) {
        const before = old.get(row.key);
        if (before?.orderId && before.marketHashName !== row.marketHashName) fail("同一订单资产的物品名称冲突，未保存本次 CSV");
        if (!before) { inserted++; changes.push(row); }
        else if (!same(before, row)) { updated++; changes.push(row); }
        else skipped++;
      }
      if (old.size + inserted > H.MAX_ROWS) fail("CSV 历史超过 100,000 行，请使用另一独立历史数据库");
      await this.upsert(client, "csv", changes);
      const namesUpdated = await this.learn(client, records.map(row => candidate(row.appid, row.marketHashName, row.itemName, "CSV 中英文对照")));
      const result = { fileName, scope: scope.trim(), inserted, updated, skipped, total: old.size + inserted, namesUpdated, importedAt: new Date().toISOString(), withoutOrderId: records.filter(row => !row.orderId).length };
      await client.query("INSERT INTO desktop_history_imports(key,payload) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET payload=EXCLUDED.payload,imported_at=now()", [hash([scope.trim(),content,mapping || null]), result]);
      return result;
    });
  }
  async names() {
    const rows = (await this.pool.query("SELECT key,payload FROM desktop_history_names ORDER BY key")).rows;
    return { items: Object.fromEntries(rows.map(row => [row.key, row.payload])) };
  }
  async saveName({ appid, marketHashName, name, onlyIfMissing = false }) {
    const value = candidate(appid, marketHashName, name, "手动核对");
    if (!value) fail("请提供游戏标识、完整英文市场名和中文名称");
    return this.transaction(async client => {
      const key = `${value.appid}:${value.marketHashName}`;
      const old = (await client.query("SELECT payload FROM desktop_history_names WHERE key=$1", [key])).rows[0]?.payload;
      if (onlyIfMissing && old?.custom) return old;
      const next = { ...(learnName(old, value) || old), name, custom: true, source: "手动核对", checkedAt: new Date().toISOString() };
      await client.query("INSERT INTO desktop_history_names(key,payload) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()", [key,next]);
      return next;
    });
  }
}
module.exports = { HistoryStore, csvRecords, candidate, learnName, same };
