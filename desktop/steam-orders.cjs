"use strict";
// Read-only market history. Money/state evidence: live JSON vs 100 rendered rows,
// 2026-10-22. Credentials and page HTML never enter archive records or IPC.
const { createHash } = require("node:crypto");
const { ORIGIN } = require("./steam-session.cjs");
const { parsePlatformJson } = require("./platform-json.cjs");
const { analyzeOrders, resolveOrderNames } = require("./buff-analysis.cjs");
const sortedObject = (_key, value) => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value;
const hash = value => createHash("sha256").update(JSON.stringify(value, sortedObject)).digest("hex");
const id = v => (typeof v === "string" || Number.isSafeInteger(v)) && /^\d{1,30}$/.test(String(v)) ? String(v) : "";
const clean = v => typeof v === "string" && v.length <= 500 && !/[\u0000-\u001f]/.test(v) ? v.trim() : "";
const money = v => (typeof v === "number" || typeof v === "string" && /^\d+$/.test(v)) && Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const sum = values => values.every(v => v != null) && Number.isSafeInteger(values.reduce((a,b) => a+b,0)) ? values.reduce((a,b) => a+b,0) : null;
const flag = (v, fallback = null) => v == null ? fallback : [0,1,"0","1",false,true].includes(v) ? Number(v) : null;
const CURRENCIES = { 2001:"USD",2002:"GBP",2003:"EUR",2004:"CHF",2005:"RUB",2006:"PLN",2007:"BRL",2008:"JPY",2009:"NOK",2010:"IDR",2011:"MYR",2012:"PHP",2013:"SGD",2014:"THB",2015:"VND",2016:"KRW",2017:"TRY",2018:"UAH",2019:"MXN",2020:"CAD",2021:"AUD",2022:"NZD",2023:"CNY",2024:"INR",2025:"CLP",2026:"PEN",2027:"COP",2028:"ZAR",2029:"HKD",2030:"TWD",2031:"SAR",2032:"AED",2034:"ARS",2035:"ILS",2036:"BYN",2037:"KZT",2039:"QAR",2040:"CRC",2041:"UYU" };
function instant(seconds, fraction = 0) {
  const s = money(seconds), f = money(fraction);
  if (s == null || s < 946684800 || s > 4102444800 || f == null || f >= 1000000000) return null;
  return new Date(s * 1000 + Math.floor(f / 1000000)).toISOString();
}
function identifyHtml(html) {
  const ids = [...new Set([...html.matchAll(/\bg_steamID\s*=\s*["'](\d{17})["']/g)].map(m => m[1]))];
  if (ids.length !== 1 || ids[0] === "00000000000000000") throw new Error("请先在 App 的 Steam 窗口登录，再检查登录状态");
  return { id: "steam:" + ids[0], nickname: "Steam 用户 · " + ids[0].slice(-4) };
}
function assetIndex(assets) {
  const map = new Map();
  for (const [app, contexts] of Object.entries(assets || {})) for (const [context, values] of Object.entries(contexts || {})) for (const a of Object.values(values || {})) {
    if (!a || typeof a !== "object" || String(a.appid) !== app) throw new Error("Steam 物品描述格式无效");
    for (const [ctx, asset] of [[context,a.id], [a.unowned_contextid || context,a.unowned_id]]) {
      if (!id(asset) || !id(ctx)) continue;
      const key = [app,ctx,asset].join(":"), old = map.get(key);
      if (old && old.market_hash_name !== a.market_hash_name) throw new Error("Steam 物品描述身份冲突");
      map.set(key, a);
    }
  }
  return map;
}
function pageInfo(data, start) {
  if (!data || ![true,1].includes(data.success) || !Number.isSafeInteger(data.total_count) || data.total_count < 0 || data.start !== start || !Number.isSafeInteger(data.pagesize) || data.pagesize < 1 || data.pagesize > 100) throw new Error("Steam 历史分页格式无法识别，原历史保留");
  // Steam represents empty maps/arrays as [] in some responses.
  const events = data.events || [];
  if (!Array.isArray(events) || events.length > data.pagesize || !events.length && start < data.total_count || events.length && start + events.length > data.total_count) throw new Error("Steam 历史分页中断，原历史保留");
  return { events, total: data.total_count, next: start + events.length, more: start + events.length < data.total_count };
}
function normalizePage(data, accountId, observedAt) {
  const index = assetIndex(data.assets), records = [];
  for (const event of data.events || []) {
    if ([1,2].includes(event.event_type)) continue; // Listing creation/cancellation is not a trade.
    if (![3,4].includes(event.event_type)) throw new Error("Steam 返回未知市场事件，未保存本次结果");
    const listingId = id(event.listingid), purchaseId = id(event.purchaseid), orderId = listingId + "_" + purchaseId;
    const p = data.purchases?.[orderId], l = data.listings?.[listingId];
    if (!listingId || !purchaseId || !p || id(p.listingid) !== listingId || id(p.purchaseid) !== purchaseId || l && id(l.listingid) !== listingId) throw new Error("Steam 成交缺少可靠订单身份");
    const direction = event.event_type === 4 ? "buy" : "sell", owner = accountId.slice(6);
    if (!/^steam:\d{17}$/.test(accountId) || !id(p.steamid_purchaser) || (direction === "buy") !== (id(p.steamid_purchaser) === owner)) throw new Error("Steam 成交方向或账号不一致");
    const a = p.asset, appid = Number(a?.appid), assetId = id(a?.id), contextId = id(a?.contextid);
    if (!Number.isSafeInteger(appid) || appid < 1 || !assetId || !contextId) throw new Error("Steam 成交物品身份无效");
    const info = index.get([appid,contextId,assetId].join(":"));
    // Transfer rewrites asset IDs (also for community items in context 6).
    // Both IDs must resolve to the very same official id/unowned_id description;
    // a similar item name or matching price is never sufficient identity evidence.
    if (l?.asset && (Number(l.asset.appid) !== appid || id(l.asset.id) !== assetId &&
      (!info || info !== index.get([appid,l.asset.contextid,l.asset.id].join(":"))))) throw new Error("Steam 买卖物品身份冲突");
    if (a.classid && info?.classid && String(a.classid) !== String(info.classid) ||
      a.instanceid && info?.instanceid && String(a.instanceid) !== String(info.instanceid)) throw new Error("Steam 成交描述身份冲突");
    const marketHashName = clean(info?.market_hash_name), name = clean(info?.name) || marketHashName;
    if (!marketHashName || !name) throw new Error("Steam 成交缺少完整物品名称");
    const quantity = money(a.amount) > 0 ? money(a.amount) : null;
    if (quantity && money(info.original_amount) > 0 && quantity !== money(info.original_amount)) throw new Error("Steam 成交数量字段不一致");
    const failed = flag(p.failed), rollback = flag(p.needs_rollback), returned = flag(p.funds_returned,0), revoked = flag(p.funds_revoked,0), held = flag(p.funds_held,0);
    const known = [failed,rollback,returned,revoked,held].every(v => v != null);
    const state = !known ? "UNKNOWN" : failed ? "FAILED" : returned ? "REFUNDED" : revoked ? "REVOKED" : rollback ? "ROLLBACK" : "COMPLETED";
    const completed = state === "COMPLETED";
    const currencyId = direction === "buy" ? p.currencyid : p.received_currencyid, currencyCode = CURRENCIES[currencyId] || "";
    const buyerTotal = sum([money(p.paid_amount),money(p.paid_fee),p.added_tax == null ? 0 : money(p.added_tax)]);
    if (money(p.steam_fee) != null && money(p.publisher_fee) != null && money(p.paid_fee) != null && sum([money(p.steam_fee),money(p.publisher_fee)]) !== money(p.paid_fee)) throw new Error("Steam 手续费字段不一致");
    const saleProceedsCents = currencyCode && direction === "sell" ? money(p.received_amount) : null;
    const paidTotalCents = currencyCode && direction === "buy" ? buyerTotal : null;
    const grossTotalCents = currencyCode && (direction === "buy" || String(p.currencyid) === String(p.received_currencyid)) ? buyerTotal : null;
    const fundsStatus = !known ? "unknown" : returned ? "returned" : revoked ? "revoked" : failed || rollback ? "unconfirmed" : held ? "held" : "released";
    const netTotalCents = direction === "sell" && completed && fundsStatus === "released" ? saleProceedsCents : null;
    // Old market events can be emitted hours after the purchase's time_sold.
    // The standard CSV's Acted On follows time_sold; retain event time separately.
    const tradedAt = instant(p.time_sold), eventAt = instant(event.time_event, event.time_event_fraction || 0);
    const assetAliases = [...new Set([assetId,id(l?.asset?.id),id(info?.id),id(info?.unowned_id),id(a.new_id)].filter(Boolean))].sort();
    records.push({ key:[accountId,appid,direction,"history",orderId].join(":"),accountId,appid,direction,channel:"history",orderId,listingId,purchaseId,
      assetId,contextId,assetAliases,goodsId:assetId,name,marketHashName,quantity,currencyCode,state,completed,
      status: ({UNKNOWN:"状态待核对",FAILED:"交易失败",REFUNDED:"已退款",REVOKED:"资金已撤回",ROLLBACK:"回滚处理中",COMPLETED:"已成交"})[state] + (completed && held ? direction === "sell" ? " · 款项暂扣" : " · 卖家款项暂扣" : ""),
      paidTotalCents,netTotalCents,saleProceedsCents,grossTotalCents,unitPriceCents:quantity===1?grossTotalCents:null,
      feeCents:direction === "buy" && currencyCode ? money(p.paid_fee) : null,
      tradedAt,eventAt,createdAt:null,receivedAt:null,fundsStatus,fundsHeldUntil:held?instant(p.time_funds_held_until):null,
      // Only fixed, non-credential response fields are archived for reconciliation.
      evidence:{eventType:event.event_type,timeEvent:event.time_event,timeEventFraction:event.time_event_fraction||0,timeSold:money(p.time_sold),failed,rollback,returned,revoked,held,
        paidAmount:money(p.paid_amount),paidFee:money(p.paid_fee),addedTax:p.added_tax==null?0:money(p.added_tax),buyerCurrencyId:String(p.currencyid),receivedAmount:money(p.received_amount),receivedCurrencyId:String(p.received_currencyid)},
      observedAt,sourceUrl:ORIGIN+"/market/#myhistory" });
  }
  return records;
}
const same = (a,b) => a && hash({...a,observedAt:null}) === hash({...b,observedAt:null});
const terminal = r => ["FAILED","REFUNDED","REVOKED"].includes(r.state) || r.completed && (r.direction === "buy" || r.fundsStatus === "released");
const aborted = () => new Error("Steam 同步已停止，原历史已保留");
function sleep(ms, signal) { return new Promise((resolve,reject) => { if(signal?.aborted)return reject(aborted()); const stop=()=>{clearTimeout(timer);signal?.removeEventListener("abort",stop);reject(aborted());};const timer=setTimeout(()=>{signal?.removeEventListener("abort",stop);resolve();},ms);signal?.addEventListener("abort",stop,{once:true}); }); }
async function readText(response) {
  const reader=response.body?.getReader(); if(!reader)throw new Error("Steam 响应为空");const chunks=[];let size=0;
  try { while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>8*1024*1024)throw new Error("Steam 响应过大");chunks.push(Buffer.from(part.value));}return Buffer.concat(chunks).toString("utf8"); }
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}
class SteamOrders {
  constructor({repository,fetcher,notify=()=>{},interval=()=>7000+Math.random()*2000,now=Date.now,accountGuard=()=>{}}) {
    Object.assign(this,{repository,fetcher,notify,interval,now,accountGuard});this.data={version:1,accounts:{},cooldownUntil:0};this.account=null;this.verified=false;
    this.job={status:"idle",pages:0,count:0};this.running=null;this.checking=false;this.requestTail=Promise.resolve();this.writeTail=Promise.resolve();this.nextAt=0;this.ready=this.load();
  }
  async load(){this.data=await this.repository.load();this.account=this.data.accounts[this.data.activeAccount]?.account||null;}
  save(next){const task=this.writeTail.then(async()=>{await this.repository.save(next);this.data=next;});this.writeTail=task.catch(()=>{});return task;}
  snapshot(){
    const saved=this.data.accounts[this.account?.id];
    const csvBindings=(saved?.csvBindings||[]).filter(binding=>Object.values(this.data.accounts).filter(a=>(a.csvBindings||[]).some(b=>b.scope===binding.scope)).length===1)
      .map(({scope,matchedCount,matchedAt,evidence})=>({scope,matchedCount,matchedAt,evidence}));
    return {account:this.account,verified:this.verified,job:{...this.job},cooldownUntil:this.data.cooldownUntil||0,count:saved?.records?.length||0,runs:saved?.runs||[],csvBindings,inventory: saved?.inventoryHistory ? {coverage:saved.inventoryHistory.coverage,craftCount:saved.inventoryHistory.events.filter(e=>e.kind==="trade-up").length} : null};
  }
  emit(){this.notify({kind:"steam-orders",value:this.snapshot()});}
  request(route,params,signal,html=false){
    const run=async()=>{
      if(signal?.aborted)throw aborted();
      if(this.data.cooldownUntil>this.now())throw new Error(`Steam 请求冷却中，请在 ${new Date(this.data.cooldownUntil).toLocaleTimeString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false})} 后重试`);
      await sleep(Math.max(0,this.nextAt-this.now()),signal);this.nextAt=this.now()+this.interval();
      const url=new URL(route,ORIGIN);for(const [k,v]of Object.entries(params||{}))url.searchParams.set(k,String(v));
      const controller=new AbortController(),stop=()=>controller.abort();signal?.addEventListener("abort",stop,{once:true});const timer=setTimeout(stop,25000);
      try{
        const response=await this.fetcher(url.href,{method:"GET",credentials:"include",cache:"no-store",redirect:"error",signal:controller.signal});
        if (!response.ok) await response.body?.cancel().catch(()=>{});
        if([429,503].includes(response.status)){const retry=response.headers.get("Retry-After"),ms=/^\d+$/.test(retry||"")?Number(retry)*1000:Date.parse(retry)-this.now();await this.save({...this.data,cooldownUntil:this.now()+Math.max(60000,Number.isFinite(ms)?ms:0)});throw new Error("Steam 请求受限，已保存冷却时间；请稍后重试");}
        if([401,403].includes(response.status)){this.verified=false;throw new Error("Steam 登录失效或市场访问受限，请重新检查登录");}
        if(!response.ok)throw new Error(`Steam 查询失败（HTTP ${response.status}），原历史保留`);
        const text=await readText(response);if(signal?.aborted)throw aborted();if(html)return text;
        let data;try{data=parsePlatformJson(text);}catch{throw new Error("Steam 返回了无法识别的数据，请检查登录");}
        if(![true,1].includes(data?.success))throw new Error("Steam 历史查询未成功，请检查登录或稍后重试");return data;
      }catch(error){if(signal?.aborted)throw aborted();if(controller.signal.aborted)throw new Error("Steam 查询超时，原历史保留");if(error instanceof TypeError)throw new Error("Steam 网络连接失败，原历史保留");throw error;}
      finally{clearTimeout(timer);signal?.removeEventListener("abort",stop);}
    };const task=this.requestTail.then(run);this.requestTail=task.catch(()=>{});return task;
  }
  async identify(signal){const account=identifyHtml(await this.request("/market/",{l:"english"},signal,true));if(signal?.aborted)throw aborted();try{await this.accountGuard(account,{signal});}catch(error){this.verified=false;throw error;}if(signal?.aborted)throw aborted();return account;}
  async check(){await this.ready;if(this.running||this.checking)throw new Error("Steam 同步或登录检查进行中");this.checking=true;this.verified=false;const controller=new AbortController();this.checkController=controller;
    this.checkTask=(async()=>{try{const account=await this.identify(controller.signal);if(controller.signal.aborted)throw aborted();if(account.id!==this.account?.id)this.job={status:"idle",pages:0,count:0};this.account=account;this.verified=true;return this.snapshot();}finally{this.checking=false;this.checkController=null;this.emit();}})();return this.checkTask;}
  async start(value={}){await this.ready;if(!value||Object.keys(value).some(k=>k!=="mode")||value.mode!=null&&!["incremental","full"].includes(value.mode))throw new Error("Steam 同步参数无效");if(this.running||this.checking)throw new Error("已有 Steam 同步或登录检查进行中");
    const controller=new AbortController();this.controller=controller;this.job={status:"running",pages:0,count:0,startedAt:this.now(),message:"正在核对 Steam 账号"};this.emit();
    this.running=this.sync(value.mode||"incremental",controller.signal).catch(error=>{this.job={...this.job,status:controller.signal.aborted?"cancelled":"failed",message:error.message,endedAt:this.now()};}).finally(()=>{this.running=null;this.controller=null;this.emit();});return this.snapshot();}
  startInventory(value={}){return require("./steam-inventory-sync.cjs").startInventory.call(this,value);}
  stop(){this.controller?.abort();this.checkController?.abort();return this.snapshot();}
  async invalidate(){this.stop();await this.running;if(this.checkTask)await this.checkTask.catch(()=>{});await this.requestTail;this.verified=false;this.emit();}
  async disconnect(){await this.invalidate();this.account=null;await this.save({...this.data,activeAccount:null});this.job={status:"idle",pages:0,count:0};this.emit();}
  async sync(mode,signal){
    const account=await this.identify(signal);this.account=account;this.verified=true;this.emit();
    const old=this.data.accounts[account.id]||{records:[],runs:[]},known=new Map(old.records.map(r=>[r.key,r])),unresolved=new Set(old.records.filter(r=>!terminal(r)).map(r=>r.key));
    const collected=new Map(),seen=new Set();let start=0,unchangedPages=0,stopReason="end",firstTotal=null,firstSignature=null;const counts={inserted:0,updated:0,skipped:0};
    while(true){
      const data=await this.request("/market/myhistory",{norender:1,start,count:100,l:"schinese"},signal),page=pageInfo(data,start);
      if(firstTotal==null)firstTotal=page.total;else if(firstTotal!==page.total)throw new Error("Steam 历史在分页期间发生变化，请重新同步；原历史保留");
      const signature=hash(page.events.map(e=>[e.listingid,e.purchaseid,e.event_type,e.time_event,e.time_event_fraction]));
      if(firstSignature==null)firstSignature=signature;
      if(page.events.length&&seen.has(signature))throw new Error("Steam 返回了重复页，原历史保留");seen.add(signature);
      const rows=normalizePage(data,account.id,new Date(this.now()).toISOString());let unchanged=page.events.length>0&&rows.length===page.events.length;
      for(const row of rows){if(collected.has(row.key))throw new Error("Steam 分页重复了成交订单，原历史保留");const before=known.get(row.key);if(before&&(before.assetId!==row.assetId||before.marketHashName!==row.marketHashName))throw new Error("Steam 历史物品身份冲突");const equal=same(before,row);unchanged&&=Boolean(equal);unresolved.delete(row.key);collected.set(row.key,equal?before:row);if(!before)counts.inserted++;else if(!equal)counts.updated++;else counts.skipped++;}
      this.job={...this.job,pages:this.job.pages+1,count:collected.size,total:page.total,events:page.next,message:`Steam 市场历史 · 已读取 ${page.next} / ${page.total} 条事件`};this.emit();
      unchangedPages=unchanged?unchangedPages+1:0;
      if(!page.more)break;
      if(mode==="incremental"&&old.coverage?.complete===true&&unchangedPages>=2&&!unresolved.size){stopReason="known";break;}
      start=page.next;
    }
    // Recheck the first page as well as the account so shifting offsets cannot
    // silently declare a complete archive after a concurrent market transaction.
    const head=await this.request("/market/myhistory",{norender:1,start:0,count:100,l:"schinese"},signal);pageInfo(head,0);
    if(head.total_count!==firstTotal||firstSignature!==hash((head.events||[]).map(e=>[e.listingid,e.purchaseid,e.event_type,e.time_event,e.time_event_fraction])))throw new Error("Steam 历史在同步期间发生变化，请重新同步");
    if (normalizePage(head,account.id,new Date(this.now()).toISOString()).some(row => !same(collected.get(row.key),row))) throw new Error("Steam 首页成交状态或金额已变化，请重新同步；原历史保留");
    const end=await this.identify(signal);if(end.id!==account.id){this.verified=false;throw new Error("Steam 同步期间账号已切换，本次结果未保存");}if(signal.aborted)throw aborted();
    const records=new Map(known);for(const [key,row]of collected)records.set(key,row);
    const syncedAt=new Date(this.now()).toISOString(),appids=[...new Set([730,570,...[...records.values()].map(r=>r.appid)])];
    const runs=appids.flatMap(appid=>["buy","sell"].map(direction=>({appid,direction,channel:"history",pages:this.job.pages,complete:true,stopReason,syncedAt})));
    const value={...old,account,records:[...records.values()],runs,coverage:{complete:true,totalEvents:firstTotal,stopReason,syncedAt}};
    if(this.repository.csv){const {bindCsv}=require("./steam-reconcile.cjs");value.csvBindings=bindCsv(value,await this.repository.csv(),old.csvBindings);}
    if(signal.aborted)throw aborted();
    await this.save({...this.data,activeAccount:account.id,accounts:{...this.data.accounts,[account.id]:value}});
    this.job={...this.job,...counts,status:"completed",endedAt:this.now(),message:`已保存：新增 ${counts.inserted}、更新 ${counts.updated}、跳过 ${counts.skipped} 条。${stopReason==="end"?"已读至末页。":"已到已知边界；旧历史曾完整读取。"}`};
  }
  async list(value={}){await this.ready;if(!Number.isSafeInteger(value.page??1)||(value.page??1)<1)throw new Error("Steam 查询页码无效");const names=await this.repository.names?.();return {...analyzeOrders(resolveOrderNames(this.data.accounts[this.account?.id]?.records||[],names),value),...this.snapshot()};}
}
module.exports={SteamOrders,normalizePage,pageInfo,identifyHtml,assetIndex,instant,terminal};
