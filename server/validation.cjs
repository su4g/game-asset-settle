"use strict";
const { randomUUID } = require("node:crypto");
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new HttpError(400, `${label}必须是 ${min}～${max} 的整数`);
  return value;
}
function text(value, label, max = 500, optional = false) {
  if (optional && (value == null || value === "")) return "";
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpError(400, `${label}不能为空且不能超过 ${max} 字符`);
  return value.trim();
}
function time(value, label, optional = false) {
  if (optional && (value == null || value === "")) return null;
  const timestamp = new Date(value).getTime();
  if (!value || !Number.isFinite(timestamp) || timestamp < Date.UTC(2000, 0, 1)) throw new HttpError(400, `${label}无效`);
  return new Date(timestamp).toISOString();
}
function uuid(value = randomUUID()) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new HttpError(400, "记录 ID 无效");
  return value;
}
function item(value) {
  const appid = integer(value.appid, "游戏", 1);
  if (![730, 570].includes(appid)) throw new HttpError(400, "仅支持 CS2 和 Dota 2");
  const marketHashName = text(value.marketHashName, "完整 Steam 物品名称");
  if (/^G[0-9A-F]+$/i.test(marketHashName)) throw new HttpError(400, "Steam 聚合页 ID 不能代替完整物品名称");
  return { appid, marketHashName };
}
function trade(value) {
  const identity = item(value);
  if (!["buff", "steam"].includes(value.platform)) throw new HttpError(400, "购买平台无效");
  if (value.currencyCode && value.currencyCode !== "CNY") throw new HttpError(400, "账本目前仅接受 CNY 实际金额");
  if (new Date(value.boughtAt).getTime() > Date.now()+60000 || value.deliveredAt && new Date(value.deliveredAt).getTime()>Date.now()+60000) throw new HttpError(400,"实际购买和收货时间不能在未来");
  if (value.deliveredAt && new Date(value.deliveredAt) < new Date(value.boughtAt)) throw new HttpError(400,"收货时间不能早于买入时间");
  return { ...identity, id: uuid(value.id), accountId: "local", platform: value.platform,
    direction: value.platform === "buff" ? "knife" : "cashout", name: text(value.name || value.marketHashName, "物品名称"),
    quantity: integer(value.quantity, "购买数量", 1, 1000000), buyTotalCents: integer(value.buyTotalCents, "实付总额"),
    boughtAt: time(value.boughtAt, "买入时间"), deliveredAt: time(value.deliveredAt, "收货时间", true),
    tradableAt: time(value.tradableAt, "可交易时间", true), marketableAt: time(value.marketableAt, "可上架时间", true),
    confirmed: value.confirmed === true, orderId: text(value.orderId, "订单号", 200, true),
    fillId: text(value.fillId, "成交号", 200, true), goodsId: text(String(value.goodsId || ""), "BUFF 物品 ID", 80, true),
    sourceUrl: text(value.sourceUrl, "来源地址", 2000, true), source: text(value.source || "manual", "记录来源", 80),
    snapshot: value.snapshot && typeof value.snapshot === "object" && !Array.isArray(value.snapshot) ? value.snapshot : {},
    original: value.original || {}, legacyKey: value.legacyKey || null };
}
module.exports = { integer, text, time, uuid, item, trade, HttpError };
