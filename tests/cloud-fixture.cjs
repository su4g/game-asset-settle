"use strict";
const { accountKey } = require("../desktop/order-ledger.cjs");
function fixture(id = "account-1", suffix = "one", cost = 100) {
  const accountId = "buff:" + suffix;
  const record = (direction, cents) => ({ key: `${accountId}:730:${direction}:history:${direction}1`, accountId, appid: 730, goodsId: "100", orderId: direction + "1", name: "同名物品", marketHashName: "Same Item", direction,
    channel: "history", completed: true, quantity: 1, state: "SUCCESS", currencyCode: "CNY", paidTotalCents: direction === "buy" ? cents : null, netTotalCents: direction === "sell" ? cents : null,
    tradedAt: direction === "buy" ? "2026-01-01T00:00:00.000Z" : "2026-01-02T00:00:00.000Z" });
  return { schemaVersion: 1, deviceId: "device-" + suffix, sequence: 1, collectedAt: "2026-10-27T00:00:00.000Z", profiles: [{ id, name: id === "account-1" ? "账户一" : "账户二", bindings: { buff: accountId, uu: null, steam: null },
    input: { buff: { version: 1, accounts: { [accountId]: { account: { id: accountId }, records: [record("buy", cost), record("sell", 200)], runs: [{ channel: "history", syncedAt: "2026-10-26T00:00:00.000Z", complete: true }] } } },
      uu: { accounts: {} }, steam: { accounts: {} }, csv: { rows: [] }, names: {} }, options: { accountLinks: [{ id: "self", name: "本人", accountKeys: [accountKey("buff", "buff", accountId)] }] }, status: { platforms: { buff: { phase: "completed", message: "已同步" }, uu: { phase: "login-required", message: "请重新登录" } } } }] };
}

function alchemyFixture(profileId = "account-1", suffix = "one", cost = 1000) {
  const value = fixture(profileId, suffix, cost), p = value.profiles[0];
  const f = require("./fixtures/steam-inventory.cjs"), id = profileId === "account-1" ? f.accountId : "steam:76561198000000002";
  const craft = f.event({ accountId: id, key: `${id}:inventory:${"a".repeat(40)}` });
  p.bindings.steam = id;
  p.input.steam.accounts[id] = { account: { id }, records: [], runs: [], inventoryHistory: f.archive([craft]) };
  p.options.accountLinks[0].accountKeys.push(accountKey("steam", "steam", id));
  const [buy, sell] = p.input.buff.accounts[p.bindings.buff].records;
  Object.assign(buy, { name: "材料（略有磨损）", marketHashName: "Input (Minimal Wear)", quantity: 10, paidTotalCents: cost, tradedAt: "2026-10-26T00:00:00.000Z" });
  Object.assign(sell, { name: "产出（略有磨损）", marketHashName: "Output (Minimal Wear)", netTotalCents: 1500, tradedAt: "2026-10-27T13:00:00.000Z" });
  return value;
}
module.exports = { fixture, alchemyFixture };
