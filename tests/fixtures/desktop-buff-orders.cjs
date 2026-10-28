"use strict";
// Synthetic transport used only by an explicitly requested, unpackaged smoke run.
module.exports = async raw => {
  const url = new URL(raw), appid = Number(url.searchParams.get("appid")) || 730;
  let data;
  if (url.pathname === "/account/api/user/info") data = { user_id: "123", nickname: "界面验收账号" };
  else if (/^\/api\/market\/(buy|sell)_order\/(history|to_deliver)$/.test(url.pathname)) {
    data = { page_num: 1, total_page: 1, goods_infos: { "101": { appid, name: "BUFF 订单验收物品", market_hash_name: "Desktop BUFF Sync Fixture" } }, items: [
      { id: "smoke-order-" + appid, goods_id: 101, quantity: 2, price: "1.23", pay_amount: "2.47", seller_income: "2.40", state: url.pathname.endsWith("history") ? "SUCCESS" : "TO_DELIVER", pay_time: 1792548000, transact_time: 1792548000 },
    ] };
  } else throw new Error("Smoke attempted an unexpected BUFF endpoint");
  return new Response(JSON.stringify({ code: "OK", data }), { headers: { "Content-Type": "application/json" } });
};
