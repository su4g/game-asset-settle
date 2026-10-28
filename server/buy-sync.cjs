'use strict';
const {createHash}=require('node:crypto');
const v=require('./validation.cjs'),A=require('../buff-account.js'),H=require('../buy-history.js');
const normalize=s=>String(s||'').normalize('NFKC').replace(/\s+/g,' ').trim();
const account=s=>s?A.canonical(s)||v.text(s,'BUFF 账号',200):null;
const hash=s=>createHash('sha256').update(JSON.stringify(s)).digest('hex');
function source(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||value.platform!=='buff')throw new v.HttpError(400,'仅支持 BUFF 买入记录');
  const appid=v.integer(value.appid,'游戏',1);if(![730,570].includes(appid))throw new v.HttpError(400,'购买记录游戏无效');
  const string=(key,max=500)=>v.text(value[key],key,max,true);
  const goodsId=String(value.goodsId||'');if(goodsId&&!/^\d{1,80}$/.test(goodsId))throw new v.HttpError(400,'BUFF 商品 ID 无效');
  const url=value.sourceUrl||`https://buff.163.com/market/buy_order/history?game=${appid===570?'dota2':'csgo'}`;
  let parsed;try{parsed=new URL(url);}catch{throw new v.HttpError(400,'购买历史来源地址无效');}
  if(parsed.origin!=='https://buff.163.com'||!/^\/market\/buy_order\/history\/?$/.test(parsed.pathname))throw new v.HttpError(400,'记录必须来自 BUFF 购买历史');
  const r={platform:'buff',kind:'buy',appid,goodsId,name:string('name'),marketHashName:string('marketHashName'),orderId:string('orderId',200),fillId:string('fillId',200),sourceId:string('sourceId',200),
    platformAccountId:account(value.platformAccountId),quantity:value.quantity==null?null:v.integer(value.quantity,'购买数量',1,1000000),
    buyTotalCents:value.buyTotalCents==null?null:v.integer(value.buyTotalCents,'购买实付总额'),currencyCode:value.currencyCode||null,
    boughtAt:v.time(value.boughtAt,'买入时间',true),deliveredAt:v.time(value.deliveredAt,'收货时间',true),
    status:string('status',200),dateLabel:string('dateLabel',200),note:string('note',1000),rawText:string('rawText',2000),sourceUrl:parsed.href};
  r.blocked=value.blocked===true||H.blockedStatus(r.status);
  if(r.currencyCode!=='CNY')r.buyTotalCents=null;
  return r;
}
function sourceKey(r) {
  // Immutable platform identity is independent of edited price, quantity and dates.
  const identity=r.fillId?['fill',r.fillId]:r.orderId?['order',r.orderId,r.appid,r.goodsId||r.marketHashName||r.name]:['row',r.sourceId,r.appid,r.goodsId,r.name,r.boughtAt,r.quantity,r.rawText];
  return 'buff-buy:'+hash([account(r.platformAccountId)||'local',identity]);
}
function sameItem(a,b) {
  if(a.appid!==b.appid)return false;
  if(a.goodsId&&b.goodsId&&String(a.goodsId)!==String(b.goodsId))return false;
  if(a.marketHashName&&b.marketHashName)return normalize(a.marketHashName)===normalize(b.marketHashName);
  return !!a.goodsId&&String(a.goodsId)===String(b.goodsId)||!!a.name&&normalize(a.name)===normalize(b.name);
}
function matches(r,trades) {
  const scoped=trades.filter(t=>t.platform==='buff'&&(!r.platformAccountId||!t.snapshot?.platformAccountId||account(r.platformAccountId)===account(t.snapshot.platformAccountId)));
  const sameFill=t=>!!r.fillId&&[t.original?.fillId,t.original?.source?.fillId].includes(r.fillId);
  const identityConflict=scoped.some(t=>!sameItem(r,t)&&(sameFill(t)||r.orderId&&t.orderId===r.orderId&&r.goodsId&&String(t.goodsId)===String(r.goodsId)));
  const relevant=scoped.filter(t=>sameItem(r,t));
  const orders=relevant.filter(t=>sameFill(t)||r.orderId&&t.orderId===r.orderId);
  const duplicates=orders.filter(t=>t.confirmed);
  const quantity=duplicates.reduce((n,t)=>n+t.quantity,0);
  const complete=duplicates.length>0&&quantity===r.quantity;
  const candidates=relevant.filter(t=>!t.orderId||r.orderId&&t.orderId===r.orderId).filter(t=>
    orders.includes(t)||t.quantity===r.quantity&&r.boughtAt&&Math.abs(new Date(t.boughtAt)-new Date(r.boughtAt))<=10*60000);
  return {duplicates:complete?duplicates:[],identityConflict,orderConflict:duplicates.length>0&&!complete,candidates};
}
function preview(records,trades,known=[]) {
  if(!Array.isArray(records)||records.length>500)throw new v.HttpError(400,'单次最多核对 500 条买入记录');
  const imported=new Set(known),seen=new Set();
  return records.map(raw=>{
    const s=source(raw);
    if(!s.marketHashName&&s.goodsId){const hashes=[...new Set(trades.filter(t=>t.appid===s.appid&&String(t.goodsId)===s.goodsId).map(t=>t.marketHashName))];if(hashes.length===1)s.marketHashName=hashes[0];}
    const key=sourceKey(s),m=matches(s,trades),duplicate=imported.has(key)||seen.has(key)||m.duplicates.length>0;seen.add(key);
    const status=s.blocked?'blocked':duplicate?'duplicate':m.identityConflict?'identity_conflict':m.orderConflict?'order_conflict':m.candidates.length?'possible_duplicate':'review';
    return {source:s,sourceKey:key,status,disabled:s.blocked||duplicate||m.orderConflict||m.identityConflict,candidates:m.candidates.map(t=>({id:t.id,version:t.version,name:t.name,quantity:t.quantity,buyTotalCents:t.buyTotalCents,boughtAt:t.boughtAt,orderId:t.orderId})),
      reviewed:{appid:s.appid,goodsId:s.goodsId,name:s.name,marketHashName:s.marketHashName,orderId:s.orderId,quantity:s.quantity,buyTotalCents:s.buyTotalCents,boughtAt:s.boughtAt,deliveredAt:s.deliveredAt},
      note:s.blocked?'未付款、取消或退款状态不能作为有效买入导入':duplicate?'已入账或本次读取重复，不重复增加成本':m.identityConflict?'相同订单或成交标识的物品规格不一致，请先核对原记录':m.orderConflict?'同订单已有部分买入，数量不一致；请先核对已有记录':m.candidates.length?'存在相似买入，请选择关联已有记录，或确认是另一笔订单':'勾选前请核对完整规格、订单、实际数量和含费总额'};
  });
}
function reviewed(entry,s) {
  if(entry.confirmed!==true)throw new v.HttpError(400,'每条买入记录必须手动勾选确认');
  if(s.blocked)throw new v.HttpError(400,'未付款、取消或退款的订单不能计入挂刀买入');
  const r=entry.reviewed||{};
  if(r.appid!==s.appid||s.goodsId&&String(r.goodsId)!==s.goodsId||s.marketHashName&&r.marketHashName!==s.marketHashName||s.orderId&&r.orderId!==s.orderId)throw new v.HttpError(400,'请保持平台原始订单与物品身份一致');
  const orderId=v.text(r.orderId,'真实购买订单号',200);
  const t=v.trade({...r,orderId,platform:'buff',currencyCode:'CNY',confirmed:true,source:'buff-buy-history',sourceUrl:s.sourceUrl,
    snapshot:{platformAccountId:s.platformAccountId,buyHistorySourceKey:sourceKey(s)},original:s});
  return {...t,platformAccountId:s.platformAccountId};
}
const methods={
  async buySyncPreview(records) {
    const known=(await this.pool.query('SELECT source_key FROM ledger_buy_imports')).rows.map(r=>r.source_key);
    return {rows:preview(records,(await this.snapshot()).trades,known),persisted:false};
  },
  async buySyncConfirm(values) {
    if(!Array.isArray(values)||!values.length||values.length>500)throw new v.HttpError(400,'请选择 1～500 条买入记录');
    return this.transaction(async c=>{
      const data=await this.data(c),saved=[],linked=[],skipped=[];
      for(const entry of values) {
        if(entry?.confirmed!==true)throw new v.HttpError(400,'买入记录尚未人工确认');
        const s=source(entry.source),key=sourceKey(s);
        if((await c.query('SELECT 1 FROM ledger_buy_imports WHERE source_key=$1',[key])).rowCount){skipped.push(key);continue;}
        const t=reviewed(entry,s),m=matches({...t,fillId:s.fillId},data.trades);
        if(m.identityConflict)throw new v.HttpError(409,'相同订单或成交标识的物品规格不一致，请先核对原记录');
        if(m.orderConflict)throw new v.HttpError(409,'同订单已有部分买入，数量不一致，请核对原账本后重新预览');
        let trade;
        if(m.duplicates.length){trade=m.duplicates[0];skipped.push(key);}
        else if(entry.existingTradeId) {
          if(!m.candidates.some(x=>x.id===entry.existingTradeId))throw new v.HttpError(409,'所选已有记录与该订单不匹配，请重新预览');
          const old=await this.getTrade(c,entry.existingTradeId,v.integer(entry.version,'已有记录版本',1));
          if(old.quantity!==t.quantity||old.buyTotalCents!==t.buyTotalCents)throw new v.HttpError(409,'已有记录的数量或实付金额不同；请先使用购买更正，再关联历史');
          const snapshot={...t.snapshot,platformAccountId:s.platformAccountId||old.snapshot?.platformAccountId||null};
          await c.query("UPDATE ledger_trades SET order_id=$2,confirmed=true,snapshot=snapshot||$3::jsonb,version=version+1 WHERE id=$1",[old.id,t.orderId,JSON.stringify(snapshot)]);
          trade={...old,orderId:t.orderId,confirmed:true,snapshot:{...old.snapshot,...snapshot},version:old.version+1};
          data.trades[data.trades.findIndex(x=>x.id===old.id)]=trade;linked.push(trade);
          await this.audit(c,old.id,'linked_buy_history',old,{trade,source:s});
        } else {
          if(m.candidates.length&&entry.decision!=='new')throw new v.HttpError(409,'发现相似买入，请重新预览并确认是否为另一笔订单');
          trade=await this.insertTrade(c,{...t,fillId:'history:'+hash([s.platformAccountId||'local',t.orderId,t.appid,t.goodsId||t.marketHashName,s.fillId])});
          data.trades.push(trade);saved.push(trade);
          await this.audit(c,trade.id,'confirmed_buy_sync',null,{source:s,reviewed:t});
        }
        await c.query('INSERT INTO ledger_buy_imports(source_key,trade_id,platform_account_id,original,reviewed) VALUES($1,$2,$3,$4,$5)',[key,trade.id,s.platformAccountId,s,{...entry.reviewed,decision:entry.decision,existingTradeId:entry.existingTradeId||null}]);
      }
      return {count:saved.length,linkedCount:linked.length,saved,linked,skipped};
    });
  },
};
module.exports={source,sourceKey,sameItem,matches,preview,reviewed,methods};
