"use strict";
const { normalizeOrders, accountKey, sourceId, portion } = require("./order-ledger.cjs");
const { resolveOrderNames } = require("./buff-analysis.cjs");
const { validateInventory } = require("./steam-inventory.cjs");
const sum = values => values.every(Number.isSafeInteger) && Number.isSafeInteger(values.reduce((a,b) => a+b,0)) ? values.reduce((a,b) => a+b,0) : null;
const emptyCost = () => ({ cash: 0, steam: 0, basis: 0 });
const unknownCost = () => ({ cash: null, steam: null, basis: null });
const addCost = values => Object.fromEntries(["cash","steam","basis"].map(k => [k, sum(values.map(v => v[k]))]));
const partCost = (value, q, total) => Object.fromEntries(Object.entries(value).map(([k,v]) => [k, portion(v, 0, q, total)]));
const subtract = (a,b) => Object.fromEntries(Object.entries(a).map(([k,v]) => [k, v == null || b[k] == null ? null : v-b[k]]));
const groupKey = (portfolio, name, currency) => JSON.stringify([portfolio, name, currency]);
function buildAlchemy(input, options = {}) {
  const normalized = normalizeOrders(input, { ...options, preserveFullNames: true }), results = [], archives = [], timeline = [], buckets = new Map(), wallets = new Map();
  const orderById = new Map(normalized.orders.map(o => [o.id,o]));
  const rawAssets = new Map();
  for (const platform of ["buff","uu","steam"]) for (const account of Object.values(input[platform]?.accounts || {})) for (const row of account.records || []) rawAssets.set(sourceId(platform,row.key), [...new Set([row.assetId,...(row.assetAliases || [])].filter(Boolean))]);
  const orderNames = new Map(), coverageFrom = new Map(), ambiguousUntil = new Map();
  for (const order of normalized.orders) {
    const key = groupKey(order.portfolioId, order.marketHashName, "");
    if (!orderNames.has(key)) orderNames.set(key, []);
    orderNames.get(key).push(order);
    // Day-only CSV can only precede an event on a later day.
    timeline.push({ type: "order", at: order.timeEnd, order });
  }
  for (const [id, account] of Object.entries(input.steam?.accounts || {})) {
    const archive = account.inventoryHistory; if (!archive) continue; validateInventory(archive, id);
    const key = accountKey("steam","steam",id);
    const portfolio = normalized.accounts.find(a => a.key === key)?.portfolioId || options.accountLinks?.find(link => link.accountKeys.includes(key))?.id || `account:${key}`;
    if (!portfolio || options.portfolioId && options.portfolioId !== "all" && options.portfolioId !== portfolio) continue;
    coverageFrom.set(portfolio, archive.coverage.complete ? -Infinity : archive.coverage.fromAt ? Date.parse(archive.coverage.fromAt) : Infinity);
    archives.push({ accountId: id, coverage: archive.coverage, craftCount: archive.events.filter(e => e.kind === "trade-up").length });
    archive.events.forEach((event,index) => { if (Date.parse(event.at) > (options.now ?? Date.now()) || event.kind === "storage" || event.kind === "other" && ["market","trade"].includes(event.action)) return;
      timeline.push({ type: "inventory", at: Date.parse(event.at), event, portfolio, complete: archive.coverage.complete || Date.parse(event.at) >= coverageFrom.get(portfolio), index }); });
  }
  for (const o of normalized.walletEvents) if (!orderById.has(o.id)) timeline.push({ type:"wallet", at:o.timeEnd, order:o });
  const walletTimes = new Map();
  for (const o of normalized.walletEvents) {
    const key=JSON.stringify([o.portfolioId,o.currencyCode,o.timeStart]);
    if(!walletTimes.has(key))walletTimes.set(key,[]);walletTimes.get(key).push(o);
    if(o.timePrecision!=="instant")timeline.push({type:"wallet-uncertainty",at:o.timeStart,order:o});
  }
  for(const group of walletTimes.values()) if(new Set(group.map(o=>o.direction)).size>1) timeline.push({type:"wallet-uncertainty",at:group[0].timeStart,order:group[0]});
  timeline.sort((a,b) => a.at-b.at || (a.type==="wallet-uncertainty"?-1:b.type==="wallet-uncertainty"?1:0) || (a.type === b.type && a.type === "inventory" ? b.index-a.index : a.type === "inventory" ? -1 : 1));
  const bucket = (portfolio,name,currency) => {
    const key = groupKey(portfolio,name,currency);
    if (!buckets.has(key)) buckets.set(key, { portfolio,name,currency, pools: [], tokens: [] });
    return buckets.get(key);
  };
  const wallet = (portfolio,currency) => {
    const key = JSON.stringify([portfolio,currency]);
    if (!wallets.has(key)) wallets.set(key, { face: 0, basis: 0 });
    return wallets.get(key);
  };
  function debitWallet(order) {
    const w = wallet(order.portfolioId,order.currencyCode), amount = order.actualTotalCents;
    if (amount == null) { w.face = 0; w.basis = null; return null; }
    const used = Math.min(amount,w.face), basis = w.face ? portion(w.basis,0,used,w.face) : 0;
    w.face -= used; w.basis = w.basis == null || basis == null ? null : w.basis-basis;
    return used === amount ? basis : null; // missing top-ups never cost zero
  }
  function creditWallet(order,cost) {
    const w = wallet(order.portfolioId,order.currencyCode);
    if (order.actualTotalCents == null) { w.face = 0; w.basis = null; return; }
    w.face += order.actualTotalCents; w.basis = sum([w.basis,cost.basis]);
  }
  function addRaw(b,source,q,cost,ids=[]) {
    let p = b.pools.find(p => p.source === source);
    if (!p) { p = { source, q:0, cost:emptyCost(), ids:new Set() }; b.pools.push(p); }
    if (!Number.isSafeInteger(p.q + q)) throw new Error("材料数量超出安全计算范围");
    p.q += q; p.cost = addCost([p.cost,cost]); ids.forEach(id => p.ids.add(id));
  }
  function rawTake(b,q,priority) {
    let left=q; const parts=[],ids=new Set();
    const active=b.pools.filter(p=>p.q>0);
    // A craft does not identify the payment source of otherwise identical inputs.
    // If it consumes only part of mixed cash/Steam pools, preserve the uncertainty.
    const mixed = !priority && active.length>1 && active.reduce((s,p)=>s+p.q,0)>q;
    if (mixed) {
      const total=active.reduce((s,p)=>s+p.q,0);active.forEach(p=>p.ids.forEach(id=>ids.add(id)));
      b.pools=[];addRaw(b,"unknown",total-q,unknownCost(),[...ids]);
      return { cost:unknownCost(),ids:[...ids],missing:0,reason:"同名材料含多种资金来源，无法确认投入比例" };
    }
    const sorted=active.slice().sort((a,c)=> Number(c.source===priority)-Number(a.source===priority));
    for (const p of sorted) { const used=Math.min(left,p.q);if(!used)continue;const cost=partCost(p.cost,used,p.q);parts.push(cost);p.q-=used;p.cost=subtract(p.cost,cost);p.ids.forEach(id=>ids.add(id));if(!p.q){p.cost=emptyCost();p.ids.clear();}left-=used; }
    if (left)parts.push(unknownCost());
    const cost=addCost(parts);
    return { cost,ids:[...ids],missing:left,reason:left?`缺少 ${left} 件此前买入或成本来源`:cost.cash==null||cost.steam==null?"历史成本池含缺价或未覆盖的库存变化":"" };
  }
  function ambiguous(b,q,reason) {
    const total=b.pools.reduce((s,p)=>s+p.q,0)+b.tokens.length;
    for(const token of b.tokens){token.result.state="ambiguous";token.result.reasons.push(reason);}
    b.tokens=[];b.pools=[];if(total>q)addRaw(b,"unknown",total-q,unknownCost());
    return {cost:unknownCost(),ids:[],missing:Math.max(0,q-total),reason};
  }
  function take(b,q,mode,order,consumer) {
    if (!b.tokens.length) return rawTake(b,q,mode === "sell" ? order.platform === "steam" ? "cash" : "steam" : null);
    let selected=[],left=q;
    const rawQ=b.pools.reduce((s,p)=>s+p.q,0),assets=order ? rawAssets.get(order.id)||[order.assetId] : [];
    const exact=mode==="sell" ? b.tokens.filter(t=>t.assetId&&assets.includes(t.assetId)) : [];
    if (exact.length && exact.length<=q) selected=exact;
    else if (rawQ+b.tokens.length===q || rawQ===0&&b.tokens.length===1&&q>=1) selected=b.tokens.slice();
    else return ambiguous(b,q,mode==="sell" ? "同名持仓并存，无法确认本次出售属于哪次炼金" : "同名产出并存，后续炼金的材料归属待核对");
    const parts=[],ids=[],parents=[];
    for(const token of selected){
      b.tokens.splice(b.tokens.indexOf(token),1);left--;parts.push(token.cost);parents.push(token.result.id);
      if(mode==="sell")settle(token,order, q-left-1, q);
      else if(mode==="craft") {token.result.state="reused";token.result.reusedBy=consumer;}
      else {token.result.state="removed";token.result.reasons.push("库存记录了消耗或移出，未确认出售收益");}
    }
    const raw=rawTake(b,Math.max(0,left),mode==="sell"?order.platform==="steam"?"cash":"steam":null);parts.push(raw.cost);ids.push(...raw.ids);
    return {...raw,cost:addCost(parts),ids,parents};
  }
  function settle(token,order,offset,total) {
    const r=token.result;
    if(order.timeStart<Date.parse(r.at)+60000){r.state="ambiguous";r.reasons.push("合成与出售时间范围重叠，先后顺序待核对");return;}
    r.sale={platform:order.platform,orderId:order.orderId,tradedAt:order.tradedAt,currencyCode:order.currencyCode,netCents:portion(order.actualTotalCents,offset,1,total),sourceId:order.id};
    r.state=order.actualTotalCents==null?"proceeds-pending":"sold";
    if(r.sale.netCents==null)r.reasons.push("出售净到账未知或 Steam 款项仍暂扣");
    if(r.sale.netCents!=null&&r.complete&&token.cost.basis!=null&&order.platform!=="steam")r.cashProfitCents=r.sale.netCents-token.cost.basis;
    if(r.sale.netCents!=null&&r.complete&&token.cost.cash===0&&token.cost.steam!=null&&order.platform==="steam")r.steamProfitCents=r.sale.netCents-token.cost.steam;
    if(order.platform==="steam"&&token.cost.cash!==0)r.reasons.push("Steam 净到账为余额，尚未形成现金出售收益");
  }
  for (const o of normalized.unplacedWalletEvents) wallet(o.portfolioId,o.currencyCode).basis = null;
  for(const step of timeline){
    if(step.type==="wallet-uncertainty"){wallet(step.order.portfolioId,step.order.currencyCode).basis=null;continue;}
    if(step.type==="wallet"){if(step.order.direction==="buy")debitWallet(step.order);else creditWallet(step.order,unknownCost());continue;}
    if(step.type==="order"){
      const o=step.order;
      // Other games still contribute genuine wallet inflows/outflows, but their
      // item costs cannot be inferred from CS2 alone. Replay all normalized buys.
      const b=bucket(o.portfolioId,`${o.appid}:${o.marketHashName}`,o.currencyCode);
      if(o.direction==="buy"){
        const cost=o.platform==="steam"?{cash:0,steam:o.actualTotalCents,basis:debitWallet(o)}:{cash:o.actualTotalCents,steam:0,basis:o.actualTotalCents};
        if(o.appid===730 && (o.timeStart < (coverageFrom.get(o.portfolioId) ?? -Infinity) || o.timeStart <= (ambiguousUntil.get(groupKey(o.portfolioId,o.marketHashName,"")) ?? -Infinity))) Object.assign(cost,unknownCost());
        addRaw(b,o.platform==="steam"?"steam":"cash",o.quantity,cost,[o.id]);
      }else{const taken=take(b,o.quantity,"sell",o);if(o.platform==="steam")creditWallet(o,taken.cost);}
      continue;
    }
    const {event:e,portfolio,complete}=step;
    const items=resolveOrderNames(e.items, input.names);
    if(e.kind!=="trade-up"){
      // Non-market item destruction/acquisition must not leave known material
      // costs available twice (e.g. a deleted skin or an unrecognized craft).
      for(const item of items){if(!item.marketHashName)continue;const matches=[...buckets.values()].filter(b=>b.portfolio===portfolio&&b.name===`730:${item.marketHashName}`);
        for(const b of matches){if(item.direction==="out")take(b,item.quantity,"other");else addRaw(b,"unknown",item.quantity,unknownCost());}}
      continue;
    }
    const output=items.find(i=>i.direction==="in"),inputs=[];
    for(const item of items.filter(i=>i.direction==="out")){let g=inputs.find(g=>g.marketHashName===item.marketHashName&&g.name===item.name);if(!g){g={name:item.name,marketHashName:item.marketHashName,quantity:0,collection:item.collection};inputs.push(g);}g.quantity+=item.quantity;}
    const currencies=new Set(inputs.flatMap(i=>[...buckets.values()].filter(b=>b.portfolio===portfolio&&b.name===`730:${i.marketHashName}`&&b.pools.reduce((s,p)=>s+p.q,0)+b.tokens.length>0).map(b=>b.currency)));
    const currencyCode=currencies.size===1?[...currencies][0]:"";
    const r={id:e.key,accountId:e.accountId,portfolioId:portfolio,at:e.at,output:{...output},inputs,currencyCode,state:"held",complete:Boolean(complete),reasons:[],cashProfitCents:null,steamProfitCents:null,sale:null};
    results.push(r);
    if(!complete)r.reasons.push("尚未覆盖此次合成之前的库存历史，成本与收益待核对");
    if(!currencyCode)r.reasons.push(currencies.size?"材料涉及多种币种，不能合并成本":"材料此前买入来源尚未覆盖");
    const costs=[];
    for(const i of inputs){
      let taken={cost:unknownCost(),ids:[],missing:i.quantity,reason:"未找到同名材料买入"};
      if(!currencyCode && i.marketHashName) for(const b of buckets.values()) if(b.portfolio===portfolio&&b.name===`730:${i.marketHashName}`) ambiguous(b,i.quantity,"材料币种归属待核对");
      if(currencyCode&&i.marketHashName)taken=take(bucket(portfolio,`730:${i.marketHashName}`,currencyCode),i.quantity,"craft",null,r.id);
      const overlapping=(orderNames.get(groupKey(portfolio,i.marketHashName,""))||[]).filter(o=>o.appid===730&&o.timeStart<=step.at+59999&&o.timeEnd>=step.at), overlaps=overlapping.length>0;
      if(overlaps){
        ambiguousUntil.set(groupKey(portfolio,i.marketHashName,""),Math.max(...overlapping.map(o=>o.timeEnd)));
        if(currencyCode)for(const p of bucket(portfolio,`730:${i.marketHashName}`,currencyCode).pools)if(p.q)p.cost=unknownCost();
      }
      const invalid=normalized.anomalies.some(a=>a.portfolioId===portfolio&&a.appid===730&&a.marketHashName===i.marketHashName&&["missing_trade_time","invalid_quantity","missing_currency"].includes(a.code));
      if(overlaps||invalid){taken.cost=unknownCost();taken.reason=overlaps?"同一分钟或仅有日期的订单与合成先后不明":"材料订单时间、数量或币种待核对";}
      i.cost=complete?taken.cost:unknownCost();i.reason=taken.reason;i.missingQuantity=taken.missing;i.parentCraftIds=taken.parents||[];
      i.sources=taken.ids.map(id=>orderById.get(id)).filter(Boolean).map(o=>({id:o.id,platform:o.platform,orderId:o.orderId,tradedAt:o.tradedAt,quantity:o.quantity,totalCents:o.actualTotalCents,currencyCode:o.currencyCode}));
      if(i.reason)r.reasons.push(`${i.name}：${i.reason}`);costs.push(i.cost);
    }
    r.cost=addCost(costs);
    if(r.cost.basis==null && r.cost.steam>0)r.reasons.push("Steam 余额的现金来源尚未覆盖，材料成本按实际余额支付额列示");
    r.materialCostCents=r.cost.cash===0?r.cost.steam:r.cost.steam===0?r.cost.cash:null;
    r.costUnit=r.cost.cash===0?"steam":r.cost.steam===0?"cash":"mixed";
    if(currencyCode&&output?.marketHashName)bucket(portfolio,`730:${output.marketHashName}`,currencyCode).tokens.push({result:r,cost:r.cost,assetId:output.assetId});
    else {r.state="cost-pending";r.complete=false;}
  }
  const filtered=results.filter(r=>!options.dateFrom||r.at>=new Date(`${options.dateFrom}T00:00:00+08:00`).toISOString()).filter(r=>!options.dateTo||r.at<new Date(Date.parse(`${options.dateTo}T00:00:00+08:00`)+86400000).toISOString()).filter(r=>!options.search||[r.output.name,r.output.marketHashName,...r.inputs.flatMap(i=>[i.name,i.marketHashName])].join(" ").toLowerCase().includes(options.search.toLowerCase())).sort((a,b)=>b.at.localeCompare(a.at));
  const summaries=[...new Set(filtered.map(r=>r.currencyCode).filter(Boolean))].map(currencyCode=>{const rows=filtered.filter(r=>r.currencyCode===currencyCode);return {currencyCode,cashProfitCents:sum(rows.map(r=>r.cashProfitCents).filter(v=>v!=null)),steamProfitCents:sum(rows.map(r=>r.steamProfitCents).filter(v=>v!=null)),cashCount:rows.filter(r=>r.cashProfitCents!=null).length,steamCount:rows.filter(r=>r.steamProfitCents!=null).length};});
  const page=options.page||1,pageSize=20;
  return {rows:filtered.slice((page-1)*pageSize,page*pageSize),page,pageSize,total:filtered.length,summary:{craftCount:filtered.length,soldCount:filtered.filter(r=>r.sale).length,pendingCount:filtered.filter(r=>!r.complete||r.cost.basis==null||r.state==="ambiguous").length,currencies:summaries},archives};
}
module.exports={buildAlchemy};
