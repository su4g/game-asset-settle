"use strict";
// Synthetic archive rows for a newly created buff_goods_test_ database only.
const { normalizeOrder: buffRow } = require("../../desktop/buff-orders.cjs");
const { normalizeOrder: uuRows } = require("../../desktop/uu-orders.cjs");
function createFixture(now = Date.now()) {
  const day = 86400000, at = days => new Date(now - days * day).toISOString();
  const buffAccount = { id: "buff:ledger-smoke", nickname: "订单账本隔离验收" }, uuAccount = { id: "uu:ledger-smoke", nickname: "订单账本隔离验收" };
  const buy = (id, name, hash, cents, days) => buffRow({ id, goods_id: 9001, quantity: 1, price: (cents / 100).toFixed(2), pay_amount: (cents / 100).toFixed(2), state: "SUCCESS", pay_time: at(days) }, { "9001": { appid: 730, name, market_hash_name: hash } }, { accountId: buffAccount.id, appid: 730, direction: "buy", channel: "history", observedAt: at(0) });
  const sell = (id, name, hash, cents, days) => ({ ...uuRows({ orderId: id, id: "9002", sellerUserId: "ledger-smoke", orderType: 1, saleOrderType: 1, commodityAmount: cents, paymentAmount: cents, totalFeeAmount: 0, orderStatus: 340, orderStatusName: "已完成", commodityNum: 1, finishOrderTime: at(days), productDetailList: [{ commodityId: "9002", templateId: "9002", commodityName: name, marketHashName: hash, price: cents }] }, { accountId: uuAccount.id, direction: "sell", observedAt: at(0) })[0], netTotalCents: cents });
  return {
    buff: { version: 1, activeAccount: null, cooldownUntil: 0, accounts: { [buffAccount.id]: { account: buffAccount, records: [
      buy("ledger-holding", "订单持仓验收物品", "Desktop Ledger Holding Fixture", 346, 1),
      buy("ledger-knife", "挂刀验收物品", "Desktop Ledger Knife Fixture", 700, 35),
      buy("ledger-direct", "直接转卖验收物品", "Desktop Ledger Direct Fixture", 300, 34),
    ], runs: [] } } },
    uu: { version: 1, activeAccount: null, cooldownUntil: 0, accounts: { [uuAccount.id]: { account: uuAccount, records: [
      sell("ledger-cashout", "提现验收物品", "Desktop Ledger Cashout Fixture", 500, 18),
      sell("ledger-direct", "直接转卖验收物品", "Desktop Ledger Direct Fixture", 400, 30),
    ], runs: [] } } },
  };
}
module.exports = { createFixture };
