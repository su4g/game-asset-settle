"use strict";
// Independent read-only adapter, contracts referenced from Steamauto c759311 and UU's official PC client.
// Shared lifecycle handles atomic repository saves, cancellation, and local analysis; no trade actions exist here.
const { BuffOrders, cents, instant } = require("./buff-orders.cjs");
const { API, ROUTES } = require("./uu-session.cjs");
const { parsePlatformJson } = require("./platform-json.cjs");
const { analyzeOrders, resolveOrderNames } = require("./buff-analysis.cjs");
const clean = v => typeof v === "string" ? v.trim().slice(0, 500) : "";
const id = v => (typeof v !== "number" || Number.isSafeInteger(v)) && /^[A-Za-z0-9_-]{1,100}$/.test(String(v ?? "")) ? String(v) : "";
const integer = v => /^(0|[1-9]\d*)$/.test(String(v)) && Number.isSafeInteger(Number(v)) ? Number(v) : null;
const equal = (a,b) => Boolean(a) && JSON.stringify(Object.entries(a).filter(([k])=>k!=="observedAt").sort()) === JSON.stringify(Object.entries(b).filter(([k])=>k!=="observedAt").sort());
const fail = message => { throw new Error(message + "，原历史已保留"); };
const present = value => value != null && value !== "";
function listMoney(order, key) {
  if (!present(order[key])) return null;
  const value = integer(order[key]); if (value == null) fail("悠悠订单金额字段格式无法识别：" + key);
  return value;
}
function consistent(values, label) {
  const known = values.filter(value => value != null);
  if (new Set(known).size > 1) fail("悠悠" + label + "字段不一致");
  return known[0] ?? null;
}
function detailMoney(detail, labels) {
  if (!detail) return null;
  for (const field of ["amounts", "orderAmounts", "amountList"]) if (detail[field] != null && !Array.isArray(detail[field])) fail("悠悠详情金额列表格式无法识别");
  const values = [detail.amount, detail.commodityAmount, detail.revenue, ...(detail.amounts || []), ...(detail.orderAmounts || []), ...(detail.amountList || [])];
  return consistent(values.filter(value => value && labels.some(([type, name]) => Number(value.type) === type && value.name === name)).map(value => {
    const amount = cents(value.amount); if (amount == null) fail("悠悠详情金额无法识别"); return amount;
  }), "详情金额");
}
function productPrices(products, fromDetail, total) {
  if (total == null) fail("悠悠缺少可核对的订单商品总价");
  const converters = fromDetail
    ? [["detail-yuan", cents], ["detail-legacy-scaled", value => { const amount = cents(value); return amount != null && Number.isSafeInteger(amount * 100) ? amount * 100 : null; }]]
    : [["list-cents", integer], ["list-yuan", cents]];
  const matches = converters.map(([unit, convert]) => ({ unit, values: products.map(product => convert(product.price)) }))
    .filter(candidate => candidate.values.every(value => value != null) && candidate.values.reduce((sum, value) => sum + BigInt(value), 0n) === BigInt(total));
  if (!matches.length || new Set(matches.map(candidate => JSON.stringify(candidate.values))).size !== 1) fail("悠悠商品价格单位与订单总价不一致");
  return matches[0];
}
function listActual(order, direction, gross) {
  if (direction === "buy") return listMoney(order, "paymentAmount");
  const fee = listMoney(order, "totalFeeAmount");
  const adjustments = ["returnAmount", "discountAmount", "platformSubsidyAmount", "privateTradeSubsidyAmount", "sellGiveFee", "guardSellerPenaltyAmount", "guardBuyerPenaltyAmount", "guardSellerPenaltyChargeAmount"];
  // Adjustment fields may be descriptive objects (for example sellGiveFee).
  // Only an explicit numeric zero proves there is no adjustment; every other
  // shape requires the detail's actual receipt rather than parsing a fee rate.
  if (gross == null || fee == null || fee > gross || adjustments.some(key => present(order[key]) && integer(order[key]) !== 0)) return null;
  return gross - fee;
}
function allocateAmount(total, prices, keys) {
  if (total == null) return prices.map(() => null);
  if (prices.length === 1) return [total];
  const gross = prices.reduce((sum, value) => sum + BigInt(value), 0n);
  if (gross === 0n) return total === 0 ? prices.map(() => 0) : prices.map(() => null);
  const parts = prices.map((price, index) => { const numerator = BigInt(total) * BigInt(price); return { index, cents: Number(numerator / gross), remainder: numerator % gross, key: keys[index] }; });
  let remaining = total - parts.reduce((sum, part) => sum + part.cents, 0);
  const ranked = [...parts].sort((a, b) => a.remainder === b.remainder ? a.key.localeCompare(b.key) : a.remainder > b.remainder ? -1 : 1);
  for (const part of ranked) { if (!remaining) break; part.cents++; remaining--; }
  return parts.map(part => part.cents);
}
const transferPurchase = (order, direction) => direction === "buy" && Number(order.orderType) === 1 && Number(order.orderSubType) === 13 && Number(order.saleOrderType) === 1;
const legacySale = (order, direction) => direction === "sell" && Number(order.orderType) === 2 && Number(order.orderSubType) === 1 && Number(order.saleOrderType) === 1;
function detailCompleted(detail, legacy) {
  const status = detail?.status;
  if (!status || Number(status.status) !== 340) return false;
  if (!legacy) return status.statusName === "已完成";
  // Old completed sales omit the display labels; a conflicting label is still
  // evidence against completion even when the numeric status is 340.
  return (!present(status.statusName) || status.statusName === "已完成") &&
    [status.statusDesc, status.subStatusName].every(value => !present(value) || value === "出售成功");
}
function orderInfo(order, accountId, direction) {
  if (!order || typeof order !== "object" || !id(order.orderId)) fail("悠悠订单缺少可靠订单号（字段：" + Object.keys(order || {}).filter(k=>/^[A-Za-z_]{1,40}$/.test(k)).slice(0,30).join(", ") + "）");
  const owner = order[direction === "buy" ? "buyerUserId" : "sellerUserId"];
  if (owner != null && id(owner) !== accountId.slice(3)) fail("悠悠订单账号不一致");
  if (order.gameId != null && Number(order.gameId) !== 730) fail("暂只支持悠悠 CS2 历史");
  if (Number(order.orderStatus) !== 340 || order.orderStatusName !== "已完成") fail("悠悠接口返回非已完成订单，未混入成交历史");
  if (Number(order.orderType) !== 1 && !legacySale(order, direction) || ![1, 2].includes(Number(order.saleOrderType)) || present(order.leaseNo) && !transferPurchase(order, direction)) fail("悠悠订单尚未确认为普通买卖，未混入租赁或其他业务");
  for (const field of ["commodityFailedNum", "returnAmount"]) if (present(order[field]) && integer(order[field]) !== 0) fail("悠悠部分失败或退款订单需要单独核对");
  const count = integer(order.commodityNum);
  if (!count || count > 2000) fail("悠悠订单物品数量无法识别");
  return { orderId: id(order.orderId), count };
}
function normalizeOrder(order, { accountId, direction = "buy", observedAt, detail } = {}) {
  const { orderId, count } = orderInfo(order, accountId, direction);
  // Type 2 is observed in completed ordinary purchases, but its enum alone is
  // not evidence of a cash trade. Require the official detail's explicit trade
  // direction, completed status, identity and absence of a lease every time.
  const transfer = transferPurchase(order, direction);
  const legacy = legacySale(order, direction);
  const specialSale = direction === "sell" && Number(order.orderType) === 1 && Number(order.orderSubType) === 5 && Number(order.saleOrderType) === 1 && ["求购", "还价"].includes(detail?.tradeType?.name);
  const tradeName = direction === "buy" ? "购买" : specialSale ? detail.tradeType.name : "出售";
  const needsBusinessDetail = Number(order.saleOrderType) === 2 || transfer || specialSale || legacy;
  if (needsBusinessDetail && (!detail || Number(detail.saleOrderType) !== Number(order.saleOrderType) ||
      (transfer ? Number(detail.orderSubType) !== 13 : detail.leaseNo !== null) ||
      !id(detail.orderNo ?? detail.orderNumber) || !detailCompleted(detail, legacy) ||
      Number(detail.tradeType?.type) !== (direction === "buy" ? 1 : 2) || detail.tradeType?.name !== tradeName)) fail("悠悠该来源订单需要明确的普通买卖详情证据");
  if (specialSale && (Number(detail.orderSubType) !== 5 || ![detail.status?.statusDesc, detail.status?.subStatusName].includes("出售成功"))) fail("悠悠求购或还价成交详情缺少出售成功证据");
  if (legacy && Number(detail.orderSubType) !== 1) fail("悠悠旧出售详情业务类型不一致");
  let products = order.productDetailList, fromDetail = detail != null;
  if (fromDetail) {
    if (detail.userCommodityVOList != null && (!Array.isArray(detail.userCommodityVOList) || detail.userCommodityVOList.some(g => !Array.isArray(g.commodityVOList)))) fail("悠悠大订单详情格式无法识别");
    const owner = detail[direction === "buy" ? "buyerUserId" : "sellerUserId"];
    if (owner != null && id(owner) !== accountId.slice(3)) fail("悠悠订单详情账号不一致");
    for (const field of ["orderNo", "orderNumber"]) if (detail[field] != null && id(detail[field]) !== id(order.id)) fail("悠悠订单详情编号不一致");
    if (present(detail.leaseNo) && !transfer || detail.saleOrderType != null && Number(detail.saleOrderType) !== Number(order.saleOrderType) || detail.tradeType && (Number(detail.tradeType.type) !== (direction === "buy" ? 1 : 2) || detail.tradeType.name !== tradeName)) fail("悠悠详情业务类型不一致");
    if (detail.status && !detailCompleted(detail, legacy) || Number(detail.orderFailNum || 0) > 0) fail("悠悠详情不是完整成交");
    products = (detail.userCommodityVOList || []).flatMap(g => g.commodityVOList);
    if (!products.length && count === 1 && detail.commodity) products = [detail.commodity];
  }
  if (!Array.isArray(products) || products.length !== count) fail("悠悠订单物品未读取完整");
  const grossLabels = transfer ? [[9, "过户价格"]] : [[2, "商品总价"]];
  const detailGross = detailMoney(detail, grossLabels);
  const gross = consistent([listMoney(order, "commodityAmount"), detailGross], "商品总价");
  // A legacy negotiated single-item sale retains the original listing price in
  // commodity.price. Its verified order total is the item's transaction price.
  const prices = legacy && count === 1 && gross != null && detailGross != null
    ? { unit: "order-total-single", values: [gross] } : productPrices(products, fromDetail, gross);
  const actualDetail = detailMoney(detail, direction === "buy" ? [[1, "实付款"], [3, "实际支付金额"]] : [[5, "实际收入"]]);
  if (needsBusinessDetail && (detailGross == null || actualDetail == null)) fail("悠悠该来源订单缺少详情实际成交金额");
  const transferExtra = transfer ? detailMoney(detail, [[10, "额外费用"]]) : null;
  if (transfer && (transferExtra == null || !Number.isSafeInteger(detailGross + transferExtra) || detailGross + transferExtra !== actualDetail)) fail("悠悠过户价格、额外费用与实付款不一致");
  const actualList = listActual(order, direction, gross);
  const actual = consistent([actualDetail, actualList], direction === "buy" ? "实际支付金额" : "实际收入");
  const fee = direction === "sell" ? consistent([listMoney(order, "totalFeeAmount"), detailMoney(detail, [[11, "交易服务费"]])], "交易服务费") : null;
  const keys = new Set();
  const rows = products.map((product, index) => {
    const lineId = id(fromDetail ? product.id ?? product.commodityId : product.commodityId);
    if (!lineId || keys.has(lineId)) fail("悠悠订单物品标识缺失或重复"); keys.add(lineId);
    const preview = fromDetail && Array.isArray(order.productDetailList) ? order.productDetailList.find(item => id(item.commodityId) === lineId) : null;
    const name = clean(product.commodityName || product.name || preview?.commodityName);
    const marketHashName = clean(product.marketHashName || product.commodityHashName || product.CommodityHashName || product.market_hash_name || preview?.marketHashName || preview?.commodityHashName);
    if (!name && !marketHashName || /[\u3400-\u9fff]/.test(marketHashName)) fail("悠悠物品名称格式无法识别");
    const price = prices.values[index];
    if (product.quantity != null && Number(product.quantity) !== 1) fail("悠悠物品数量语义需要重新核对");
    if (product.num != null && Number(product.num) !== 1) fail("悠悠物品数量语义需要重新核对");
    if (product.currency != null && product.currency !== "CNY") fail("悠悠返回了不支持的币种");
    const key = [accountId, 730, direction, "history", orderId, lineId].join(":");
    return { key, accountId, appid: 730, direction, channel: "history", orderId, lineId, assetId: id(product.assertId ?? product.assetId ?? preview?.assertId ?? preview?.assetId), goodsId: id(product.templateId ?? preview?.templateId) || lineId, templateId: id(product.templateId ?? preview?.templateId),
      name: name || marketHashName, marketHashName, category: clean(product.typeName || preview?.typeName), quantity: 1, currencyCode: "CNY", state: "340", status: "已完成", completed: true,
      unitPriceCents: price, grossTotalCents: price, paidTotalCents: null, netTotalCents: null, feeCents: null,
      businessType: transfer ? "ownership-transfer" : legacy ? "legacy-sale" : specialSale ? tradeName === "求购" ? "buy-order-sale" : "negotiated-sale" : "sale", ...(transfer ? { orderExtraCostCents: transferExtra } : {}),
      ...(prices.unit === "order-total-single" ? { sourceProductPrice: product.price ?? null, sourceListProductPrice: preview?.price ?? null } : {}), priceUnitEvidence: prices.unit, orderGrossTotalCents: gross, orderActualTotalCents: actual,
      amountSource: actualDetail != null ? "uu-detail-actual" : actualList != null ? direction === "buy" ? "uu-list-payment" : "uu-list-net-after-fee" : "unknown",
      amountAllocation: actual == null ? "unknown" : count === 1 ? "single" : actual === gross ? "per-item-gross" : "proportional-gross",
      createdAt: instant(order.createOrderTime ?? order.createTime), tradedAt: instant(order.finishOrderTime), deliveredAt: null, receivedAt: null,
      observedAt, sourceUrl: "https://www.youpin898.com/mine" };
  });
  const allocated = allocateAmount(actual, prices.values, rows.map(row => row.lineId));
  const fees = actual != null && fee != null && actual + fee === gross ? prices.values.map((value, index) => value - allocated[index]) : allocateAmount(fee, prices.values, rows.map(row => row.lineId));
  rows.forEach((row, index) => { row[direction === "buy" ? "paidTotalCents" : "netTotalCents"] = allocated[index]; row.feeCents = fees[index]; if (actual != null && allocated[index] == null) row.amountAllocation = "unallocated-zero-gross"; });
  return rows;
}
function pageInfo(data, page) {
  if (!data || !Array.isArray(data.orderList) || data.orderList.length > 20) fail("悠悠列表格式无法识别");
  if (data.pageIndex != null && Number(data.pageIndex) !== page) fail("悠悠返回了错误页码");
  const total = data.totalPages == null ? null : integer(data.totalPages);
  if (data.totalPages != null && (total == null || !total && data.orderList.length)) fail("悠悠分页信息无效");
  if (!data.orderList.length && (total != null && page < total || data.hasNext === true)) fail("悠悠分页中断");
  // Without explicit pagination metadata, even a short page is followed by an empty-page check.
  return { items: data.orderList, more: data.orderList.length > 0 && data.hasNext !== false && (total == null || page < total) };
}
function options(value = {}) {
  const direction = value.direction || "buy", mode = value.mode || "incremental";
  if (!["buy","sell"].includes(direction) || !["incremental","full"].includes(mode)) throw new Error("悠悠同步范围无效");
  return { direction, mode };
}
function sleep(ms, signal) {
  return new Promise((resolve,reject)=>{
    const abort = () => { clearTimeout(timer); reject(new Error("悠悠同步已停止，原历史已保留")); };
    const timer = setTimeout(()=>{ signal?.removeEventListener("abort",abort); resolve(); },ms);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort",abort,{once:true});
  });
}
class UuOrders extends BuffOrders {
  snapshot() { return { ...super.snapshot(), sellProbe: this.data.accounts[this.account?.id]?.sellProbe || { status: "unverified", message: "卖出历史待只读验证" } }; }
  emit() { this.notify({ kind: "uu-orders", value: this.snapshot() }); }
  request(route, params, signal) {
    const run = async () => {
      if (!ROUTES.has(route)) throw new Error("未开放的悠悠查询接口");
      if (this.data.cooldownUntil > this.now()) throw new Error("悠悠请求冷却中，请稍后重试");
      await sleep(Math.max(0,this.nextAt-this.now()),signal); if (signal?.aborted) throw new Error("悠悠同步已停止"); this.nextAt=this.now()+this.interval();
      const controller=new AbortController(), abort=()=>controller.abort(); signal?.addEventListener("abort",abort,{once:true});
      const timer=setTimeout(abort,20000);
      try {
        const method=ROUTES.get(route), response=await this.fetcher(API+route,{method, ...(method==="POST"?{body:JSON.stringify(params||{})}:{}),signal:controller.signal,redirect:"error",cache:"no-store"});
        if ([401,403].includes(response.status)) { this.verified=false; throw new Error("悠悠登录失效或需要验证，请重新打开登录窗口"); }
        if ([405,429,503].includes(response.status)) {
          const value=response.headers.get("retry-after"), duration=/^\d+$/.test(value||"")?Number(value)*1000:Date.parse(value)-this.now();
          await this.save({...this.data,cooldownUntil:this.now()+Math.min(86400000,Math.max(60000,Number.isFinite(duration)?duration:0))});
          throw new Error("悠悠查询受限，已停止并保存冷却时间；稍后重新打开登录窗口完成验证");
        }
        if (!response.ok) throw new Error(`悠悠查询失败（HTTP ${response.status}）`);
        const reader=response.body?.getReader(); if (!reader) fail("悠悠响应为空");
        const chunks=[];let length=0;
        try { while(true) { const part=await reader.read(); if(part.done)break;length+=part.value.byteLength;if(length>4*1024*1024)fail("悠悠响应过大");chunks.push(Buffer.from(part.value)); } }
        catch(error){await reader.cancel().catch(()=>{});throw error;} finally{reader.releaseLock();}
        let body;try{body=parsePlatformJson(Buffer.concat(chunks).toString("utf8"));}catch{fail("悠悠响应无法识别");}
        const code=body?.code??body?.Code;
        if (Number(code)===84101) { this.verified=false;throw new Error("悠悠登录已失效，请重新登录"); }
        if (/频繁|限流|too.?many|rate.?limit/i.test(String(body?.msg||body?.Msg||""))) { await this.save({...this.data,cooldownUntil:this.now()+60000});throw new Error("悠悠请求过于频繁，已停止同步，请一分钟后重试"); }
        if (code == null || Number(code)!==0 || (body.data??body.Data)==null) throw new Error(`悠悠查询未成功（状态 ${/^\d{1,10}$/.test(String(code))?code:"未知"}），请检查登录或接口权限`);
        return body.data??body.Data;
      } catch(error) { if(signal?.aborted) throw new Error("悠悠同步已停止，原历史已保留");if(controller.signal.aborted)throw new Error("悠悠查询超时，原历史已保留");if(error instanceof TypeError)throw new Error("悠悠网络连接失败，请检查网络");throw error; }
      finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);}
    };
    const result=this.requestTail.then(run);this.requestTail=result.catch(()=>{});return result;
  }
  async identify(signal) {
    const data=await this.request("/api/user/Account/getUserInfo",{},signal);
    const ids=[...new Set([data.UserId,data.userId].map(id).filter(Boolean))];
    if(ids.length!==1){this.verified=false;throw new Error("未识别到唯一悠悠账号");}
    return this.guardAccount({id:"uu:"+ids[0],nickname:clean(data.NickName||data.nickName)||"悠悠用户"},signal);
  }
  async check() {
    await this.ready;if(this.running||this.checking)throw new Error("悠悠查询正在进行，请稍后重试");this.checking=true;this.verified=false;
    const controller=new AbortController();this.checkController=controller;
    this.checkTask=(async()=>{
      try{const account=await this.identify(controller.signal);if(controller.signal.aborted)throw new Error("悠悠登录检查已停止");this.account=account;this.verified=true;return this.snapshot();}
      finally{this.checking=false;this.checkController=null;this.emit();}
    })();return this.checkTask;
  }
  async start(value={}) {
    await this.ready;if(this.running||this.checking)throw new Error("已有悠悠查询进行中");
    const config=options(value),controller=new AbortController();this.controller=controller;
    this.job={status:"running",pages:0,count:0,startedAt:this.now(),message:value.probe?"正在只读验证卖出历史":"正在核对悠悠账号"};this.emit();
    this.running=(value.probe?this.probeSell(controller.signal):this.sync(config,controller.signal)).catch(error=>{
      this.job={...this.job,status:controller.signal.aborted?"cancelled":"failed",message:error.message,endedAt:this.now()};
    }).finally(()=>{this.running=null;this.controller=null;this.emit();});return this.snapshot();
  }
  async readOrder(order,accountId,direction,signal,forceDetail=false) {
    const info=orderInfo(order,accountId,direction);let detail;
    const needsActual = listActual(order, direction, listMoney(order, "commodityAmount")) == null;
    if(forceDetail || Number(order.saleOrderType)===2 || transferPurchase(order,direction) || legacySale(order,direction) || needsActual || !Array.isArray(order.productDetailList) || order.productDetailList.length!==info.count){
      const orderNo=id(order.id);if(!orderNo)fail("悠悠大订单缺少详情编号");
      detail=await this.request("/api/youpin/bff/trade/v1/order/query/detail",{orderNo,userId:accountId.slice(3)},signal);
    }
    const rows = normalizeOrder(order,{accountId,direction,detail,observedAt:new Date(this.now()).toISOString()});
    if (detail && Array.isArray(order.productDetailList)) for (const preview of order.productDetailList) {
      const full = rows.find(row => row.lineId === id(preview.commodityId));
      if (!full || full.priceUnitEvidence !== "order-total-single" && ![integer(preview.price), cents(preview.price)].includes(full.grossTotalCents)) fail("悠悠列表与详情物品或金额不一致");
    }
    return rows;
  }
  async probeSell(signal) {
    const account=await this.identify(signal);this.account=account;this.verified=true;
    const current = this.data.accounts[account.id] || { account, records: [], runs: [] };
    if (signal.aborted) fail("验证已停止");
    await this.save({ ...this.data, activeAccount: account.id, accounts: { ...this.data.accounts, [account.id]: { ...current, sellProbe: { status: "unverified", message: "本次卖出验证尚未通过" } } } });
    this.emit();
    const page=pageInfo(await this.request("/api/youpin/bff/trade/sale/v1/sell/list",{keys:"",orderStatus:340,pageIndex:1,pageSize:20},signal),1);
    // 340 is a candidate completion filter, not an assumed sell contract. Verify against actual completed rows and detail prices.
    let status="empty",message="接口响应成功，但没有已完成卖出样本；暂未开放卖出同步",sampleItems=0;
    if(page.items.length){
      for(const order of page.items)orderInfo(order,account.id,"sell");
      const sample=page.items[0],rows=await this.readOrder(sample,account.id,"sell",signal,true);
      const previews=sample.productDetailList;
      if(!Array.isArray(previews)||!previews.length)fail("卖出列表缺少可核对的成交金额");
      for(const item of previews){const detail=rows.find(r=>r.lineId===id(item.commodityId));if(!detail||![integer(item.price),cents(item.price)].includes(detail.unitPriceCents))fail("卖出列表与详情金额或物品标识不一致");}
      if(rows.some(r=>!r.tradedAt))fail("卖出完成时间尚未验证");
      status="verified";sampleItems=rows.length;message="已核对普通买卖业务、完成状态、物品标识及订单总价，可同步卖出历史；实付与净收入按平台实际金额核算";
    }
    const end=await this.identify(signal);if(end.id!==account.id)fail("验证期间悠悠账号已切换");if(signal.aborted)fail("验证已停止");
    const old=this.data.accounts[account.id]||{account,records:[],runs:[]};
    await this.save({...this.data,activeAccount:account.id,accounts:{...this.data.accounts,[account.id]:{...old,account,sellProbe:{status,message,sampleItems,checkedAt:new Date(this.now()).toISOString()}}}});
    this.job={...this.job,status:"completed",pages:1,count:sampleItems,message,endedAt:this.now()};
  }
  async sync(config,signal) {
    const account=await this.identify(signal);this.account=account;this.verified=true;this.emit();
    const old=this.data.accounts[account.id]||{account,records:[],runs:[]};
    if(config.direction==="sell"&&old.sellProbe?.status!=="verified")throw new Error("请先完成当前悠悠账号的卖出接口验证");
    const known=new Map(old.records.map(r=>[r.key,r])),staged=new Map(),seenPages=new Set(),seenOrders=new Set();
    const previous=old.runs.find(r=>r.direction===config.direction);
    let more=true,knownPages=0,stopReason="end",pages=0;
    const counts={inserted:0,updated:0,skipped:0};
    for(let page=1;more;page++){
      this.job.message=`悠悠已完成${config.direction==="buy"?"买入":"卖出"} · 第 ${page} 页`;this.emit();
      const data=pageInfo(await this.request(`/api/youpin/bff/trade/sale/v1/${config.direction}/list`,{keys:"",orderStatus:340,pageIndex:page,pageSize:20,presenterId:0,sceneType:0},signal),page);
      const signature=data.items.map(o=>id(o.orderId)).sort().join("|");if(data.items.length&&seenPages.has(signature))fail("悠悠返回重复页");seenPages.add(signature);
      let unchanged=data.items.length>0;
      for(const order of data.items){
        const rows=await this.readOrder(order,account.id,config.direction,signal);
        if(seenOrders.has(order.orderId))fail("悠悠分页出现重复订单，请稍后重新同步");seenOrders.add(order.orderId);
        for(let row of rows){
          const before=known.get(row.key);
          if(before){
            // Older archives used the commodity line ID when the list omitted its
            // catalogue template. Filling that metadata never changes this order line.
            const oldTemplate=before.templateId||(before.goodsId!==before.lineId?before.goodsId:""),newTemplate=row.templateId||(row.goodsId!==row.lineId?row.goodsId:"");
            if(before.lineId!==row.lineId||oldTemplate&&newTemplate&&oldTemplate!==newTemplate||before.marketHashName&&row.marketHashName&&before.marketHashName!==row.marketHashName)fail("悠悠订单物品身份冲突");
            const templateId=newTemplate||oldTemplate;
            row={...row,templateId,goodsId:templateId||row.lineId,marketHashName:row.marketHashName||before.marketHashName,category:row.category||before.category,assetId:row.assetId||before.assetId};
          }
          const same=equal(before,row);unchanged&&=same;staged.set(row.key,same?before:row);
          if(!before)counts.inserted++;else if(same)counts.skipped++;else counts.updated++;
        }
      }
      more=data.more;pages++;this.job.pages=pages;this.job.count=staged.size;this.emit();
      knownPages=unchanged?knownPages+1:0;
      if(more&&config.mode==="incremental"&&knownPages>=2&&previous?.complete){stopReason="known";break;}
    }
    const end=await this.identify(signal);if(end.id!==account.id)fail("同步期间悠悠账号已切换");if(signal.aborted)fail("悠悠同步已停止");
    // Changing the item set of an archived completed order is not an additive history update.
    for(const row of old.records)if(row.direction===config.direction&&seenOrders.has(row.orderId)&&!staged.has(row.key))fail("悠悠已存档订单的物品集合发生变化");
    for(const row of staged.values())known.set(row.key,row);
    const run={appid:730,direction:config.direction,channel:"history",pages,complete:!more||stopReason==="known"&&Boolean(previous?.complete),stopReason,syncedAt:new Date(this.now()).toISOString()};
    await this.save({...this.data,activeAccount:account.id,accounts:{...this.data.accounts,[account.id]:{...old,account,records:[...known.values()],runs:[...old.runs.filter(r=>r.direction!==config.direction),run]}}});
    this.job={...this.job,...counts,status:"completed",endedAt:this.now(),message:`已入库：新增 ${counts.inserted}、更新 ${counts.updated}、跳过 ${counts.skipped} 件。`+(stopReason==="known"?"已到历史同步范围。":"已读取到末页。")};
  }
  async list(value={}) {
    await this.ready;
    if(!Number.isSafeInteger(value.page??1)||(value.page??1)<1||String(value.query||"").length>100)throw new Error("悠悠查询条件无效");
    const catalog=await this.repository.names();
    const rows=resolveOrderNames(this.data.accounts[this.account?.id]?.records||[],catalog);
    return {...analyzeOrders(rows,value),...this.snapshot()};
  }
}
module.exports={UuOrders,normalizeOrder,pageInfo,options};
