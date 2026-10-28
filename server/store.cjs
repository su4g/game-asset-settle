"use strict";
const { randomUUID, createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const v = require("./validation.cjs");
const { project } = require("./accounting.cjs");

const camel = (key) => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
function row(value) {
  if (!value) return null;
  return Object.fromEntries(Object.entries(value).map(([k, x]) => [camel(k), x instanceof Date ? x.toISOString() :
    /_cents$/.test(k) && x != null ? Number(x) : x]));
}
class Store {
  constructor(config) { this.pool = new Pool({ ...config, max: 5, connectionTimeoutMillis: 4000, statement_timeout: 15000 }); }
  async migrate() { await this.pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8")); }
  async close() { await this.pool.end(); }
  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // A single local account; serialize quantity checks, wallet edits and task writes.
      await client.query("SELECT pg_advisory_xact_lock(3217001)");
      const result = await fn(client);
      await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async audit(client, id, action, before, after) {
    await client.query("INSERT INTO ledger_audit(entity_id,action,before_data,after_data) VALUES($1,$2,$3,$4)", [id, action, before, after]);
  }
  async data(client = this.pool) {
    const tables = { trades: "ledger_trades", settlements: "ledger_settlements", walletEvents: "ledger_wallet_events", refunds: "ledger_refunds", prices: "ledger_price_snapshots" };
    const result = {};
    for (const [key, table] of Object.entries(tables)) result[key] = (await client.query(`SELECT * FROM ${table}`)).rows.map(row);
    return result;
  }
  async snapshot() {
    const client = await this.pool.connect();
    try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const data = await this.data(client); await client.query("COMMIT"); return data; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async insertTrade(client, value) {
    const t = v.trade(value);
    const result = await client.query(`INSERT INTO ledger_trades
      (id,account_id,platform,direction,appid,market_hash_name,name,goods_id,order_id,fill_id,quantity,buy_total_cents,
       bought_at,delivered_at,tradable_at,marketable_at,confirmed,source,source_url,legacy_key,snapshot,original)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      ON CONFLICT DO NOTHING RETURNING *`, [t.id,t.accountId,t.platform,t.direction,t.appid,t.marketHashName,t.name,t.goodsId || null,
      t.orderId || null,t.fillId || null,t.quantity,t.buyTotalCents,t.boughtAt,t.deliveredAt,t.tradableAt,t.marketableAt,t.confirmed,
      t.source,t.sourceUrl,t.legacyKey,t.snapshot,t.original]);
    if (result.rows.length) {
      const saved = row(result.rows[0]); await this.audit(client, saved.id, "purchase", null, saved); return saved;
    }
    const existing = await client.query(`SELECT * FROM ledger_trades WHERE id=$1 OR legacy_key=$2
      OR (account_id=$3 AND platform=$4 AND fill_id=$5)`, [t.id,t.legacyKey,t.accountId,t.platform,t.fillId || null]);
    if (!existing.rows.length) throw new v.HttpError(409, "购买记录冲突");
    const found = row(existing.rows[0]);
    if (!t.legacyKey && ["platform","appid","marketHashName","quantity","buyTotalCents","boughtAt"].some(k => found[k] !== t[k])) throw new v.HttpError(409,"相同购买标识的内容不一致，请核对原记录");
    return found;
  }
  async createTrade(value) { return this.transaction((client) => this.insertTrade(client, value)); }
  async getTrade(client, id, version) {
    const t = row((await client.query("SELECT * FROM ledger_trades WHERE id=$1 FOR UPDATE", [v.uuid(id)])).rows[0]);
    if (!t) throw new v.HttpError(404, "购买记录不存在");
    if (version !== undefined && t.version !== v.integer(version, "记录版本", 1)) throw new v.HttpError(409, "记录已更新，请刷新后再保存");
    return t;
  }
  async bump(client, id) { await client.query("UPDATE ledger_trades SET version=version+1 WHERE id=$1", [id]); }
  async amendTrade(id, patch) {
    return this.transaction(async (client) => {
      const old = await this.getTrade(client, id, v.integer(patch.version,"记录版本",1));
      const allowed = Object.fromEntries(["buyTotalCents","boughtAt","deliveredAt","tradableAt","marketableAt","confirmed","quantity","orderId"].filter(k => k in patch).map(k => [k,patch[k]]));
      const next = v.trade({ ...old, ...allowed });
      const data = await this.data(client);
      const used = data.settlements.filter(s=>s.tradeId===id && !s.voided).reduce((n,s)=>n+s.quantity,0) + data.refunds.filter(f=>f.tradeId===id).reduce((n,f)=>n+f.quantity,0);
      if (next.quantity < used || !next.confirmed && used) throw new v.HttpError(409,"数量或确认状态与已有出售、退款冲突");
      const dates = [...data.settlements.filter(s=>s.tradeId===id && !s.voided).map(s=>s.soldAt), ...data.refunds.filter(f=>f.tradeId===id).map(f=>f.occurredAt)];
      if (dates.some(d=>new Date(d)<new Date(next.boughtAt))) throw new v.HttpError(400,"买入时间不能晚于已有出售或退款");
      const result = row((await client.query(`UPDATE ledger_trades SET buy_total_cents=$2,bought_at=$3,delivered_at=$4,
        tradable_at=$5,marketable_at=$6,confirmed=$7,quantity=$8,order_id=$9,version=version+1 WHERE id=$1 RETURNING *`,
        [id,next.buyTotalCents,next.boughtAt,next.deliveredAt,next.tradableAt,next.marketableAt,next.confirmed,next.quantity,next.orderId || null])).rows[0]);
      await this.audit(client,id,"amend_purchase",old,result); return result;
    });
  }
  async available(client, trade) {
    const used = await client.query(`SELECT COALESCE((SELECT sum(quantity) FROM ledger_settlements WHERE trade_id=$1 AND NOT voided),0)
      + COALESCE((SELECT sum(quantity) FROM ledger_refunds WHERE trade_id=$1),0) AS quantity`, [trade.id]);
    return trade.quantity - Number(used.rows[0].quantity);
  }
  async settle(id, value) {
    return this.transaction(async client => {
      const requestKey = v.text(value.requestKey,"请求标识",200);
      const existing = row((await client.query("SELECT * FROM ledger_settlements WHERE request_key=$1",[requestKey])).rows[0]);
      if (existing) { if (existing.tradeId !== id || existing.quantity!==value.quantity || existing.netTotalCents!==value.netTotalCents || existing.soldAt!==v.time(value.soldAt,"成交时间") || existing.receivedAt!==v.time(value.receivedAt,"到账时间",true)) throw new v.HttpError(409,"请求标识已用于不同的回填，请核对已保存记录"); return existing; }
      const t = await this.getTrade(client,id,v.integer(value.version,"记录版本",1));
      if (!t.confirmed) throw new v.HttpError(409,"请先核对并确认购买记录");
      const quantity = v.integer(value.quantity,"售出数量",1);
      if (quantity > await this.available(client,t)) throw new v.HttpError(409,"售出数量超过剩余持仓");
      const soldAt = v.time(value.soldAt,"成交时间"), receivedAt = v.time(value.receivedAt,"到账时间",true);
      if (new Date(soldAt)<new Date(t.boughtAt) || receivedAt && new Date(receivedAt)<new Date(soldAt)) throw new v.HttpError(400,"成交和到账时间顺序错误");
      if(new Date(soldAt).getTime()>Date.now()+60000 || receivedAt&&new Date(receivedAt).getTime()>Date.now()+60000)throw new v.HttpError(400,"实际成交和到账时间不能在未来");
      const result = row((await client.query(`INSERT INTO ledger_settlements(id,trade_id,quantity,net_total_cents,sold_at,received_at,note,request_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[randomUUID(),id,quantity,v.integer(value.netTotalCents,"净到账总额"),soldAt,receivedAt,
        v.text(value.note,"备注",1000,true),requestKey])).rows[0]);
      await this.bump(client,id); await this.audit(client,id,"settlement",null,result); return result;
    });
  }
  async amendSettlement(id, value) {
    return this.transaction(async client=>{
      const old=row((await client.query("SELECT * FROM ledger_settlements WHERE id=$1 FOR UPDATE",[v.uuid(id)])).rows[0]);
      if(!old) throw new v.HttpError(404,"出售记录不存在");
      if(old.version!==v.integer(value.version,"记录版本",1)) throw new v.HttpError(409,"出售记录已更新，请刷新");
      const t=await this.getTrade(client,old.tradeId);
      const quantity=v.integer(value.quantity ?? old.quantity,"售出数量",1);
      const voided=value.voided === undefined ? old.voided : value.voided===true;
      if(!voided && quantity>await this.available(client,t)+(old.voided?0:old.quantity)) throw new v.HttpError(409,"售出数量超过持仓");
      const soldAt=v.time(value.soldAt ?? old.soldAt,"成交时间");
      const receivedAt=v.time("receivedAt" in value ? value.receivedAt : old.receivedAt,"到账时间",true);
      if(new Date(soldAt)<new Date(t.boughtAt)||receivedAt&&new Date(receivedAt)<new Date(soldAt)) throw new v.HttpError(400,"成交和到账时间顺序错误");
      if(new Date(soldAt).getTime()>Date.now()+60000 || receivedAt&&new Date(receivedAt).getTime()>Date.now()+60000)throw new v.HttpError(400,"实际成交和到账时间不能在未来");
      const saved=row((await client.query(`UPDATE ledger_settlements SET quantity=$2,net_total_cents=$3,sold_at=$4,received_at=$5,voided=$6,version=version+1 WHERE id=$1 RETURNING *`,
        [id,quantity,v.integer(value.netTotalCents ?? old.netTotalCents,"净到账总额"),soldAt,receivedAt,voided])).rows[0]);
      await this.bump(client,t.id); await this.audit(client,t.id,voided?"void_settlement":"amend_settlement",old,saved); return saved;
    });
  }
  async refund(id,value) {
    return this.transaction(async client=>{
      const requestKey=v.text(value.requestKey,"请求标识",200);
      const existing=row((await client.query("SELECT * FROM ledger_refunds WHERE request_key=$1",[requestKey])).rows[0]);
      if(existing) { if(existing.tradeId!==id) throw new v.HttpError(409,"请求标识冲突"); return existing; }
      const t=await this.getTrade(client,id,v.integer(value.version,"记录版本",1));
      if(!t.confirmed) throw new v.HttpError(409,"请先确认购买记录");
      const quantity=v.integer(value.quantity,"退款数量",1);
      if(quantity>await this.available(client,t)) throw new v.HttpError(409,"只能退回尚未售出的物品");
      const occurredAt=v.time(value.occurredAt,"退款到账时间");
      if(new Date(occurredAt)<new Date(t.boughtAt)) throw new v.HttpError(400,"退款不能早于购买");
      if(new Date(occurredAt)>new Date()) throw new v.HttpError(400,"实际退款到账时间不能在未来");
      const saved=row((await client.query(`INSERT INTO ledger_refunds(id,trade_id,quantity,amount_cents,occurred_at,note,request_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [randomUUID(),id,quantity,v.integer(value.amountCents,"退款到账金额"),occurredAt,v.text(value.note,"备注",1000,true),requestKey])).rows[0]);
      await this.bump(client,id); await this.audit(client,id,"purchase_refund",null,saved); return saved;
    });
  }
  async walletEvent(value) {
    return this.transaction(async client=>{
      if(!["opening","funding","spend"].includes(value.kind)) throw new v.HttpError(400,"资金调整类型无效");
      if(new Date(value.occurredAt)>new Date()) throw new v.HttpError(400,"资金调整时间不能在未来");
      const requestKey=v.text(value.requestKey,"请求标识",200);
      const existing=row((await client.query("SELECT * FROM ledger_wallet_events WHERE request_key=$1",[requestKey])).rows[0]);
      if(existing) return existing;
      const saved=row((await client.query(`INSERT INTO ledger_wallet_events(id,account_id,kind,amount_cents,cash_cost_cents,occurred_at,note,request_key) VALUES($1,'local',$2,$3,$4,$5,$6,$7) RETURNING *`,
        [randomUUID(),value.kind,v.integer(value.amountCents,"Steam 金额",1),value.cashCostCents==null?null:v.integer(value.cashCostCents,"现金成本"),v.time(value.occurredAt,"发生时间"),v.text(value.note,"备注",1000,true),requestKey])).rows[0]);
      await this.audit(client,saved.id,"wallet_event",null,saved); return saved;
    });
  }
  async amendWallet(id,value) {
    return this.transaction(async client=>{
      const old=row((await client.query("SELECT * FROM ledger_wallet_events WHERE id=$1 FOR UPDATE",[v.uuid(id)])).rows[0]);
      if(!old) throw new v.HttpError(404,"资金记录不存在");
      if(old.version!==v.integer(value.version,"记录版本",1)) throw new v.HttpError(409,"资金记录已更新");
      if(new Date(value.occurredAt ?? old.occurredAt)>new Date()) throw new v.HttpError(400,"资金调整时间不能在未来");
      const saved=row((await client.query(`UPDATE ledger_wallet_events SET amount_cents=$2,cash_cost_cents=$3,occurred_at=$4,voided=$5,version=version+1 WHERE id=$1 RETURNING *`,
        [id,v.integer(value.amountCents ?? old.amountCents,"Steam 金额",1),("cashCostCents" in value?value.cashCostCents:old.cashCostCents)==null?null:v.integer(value.cashCostCents ?? old.cashCostCents,"现金成本"),v.time(value.occurredAt ?? old.occurredAt,"发生时间"),value.voided===undefined?old.voided:value.voided===true])).rows[0]);
      await this.audit(client,id,"amend_wallet",old,saved); return saved;
    });
  }
  async importLegacy(records) {
    if(!Array.isArray(records)||records.length>1000) throw new v.HttpError(400,"每批迁移最多 1000 条");
    return this.transaction(async client=>{
      const results=[];
      for(const source of records) {
        const original=source?.record ?? source;
        const legacyKey=`${source?.store || "storage"}:${original?.id || createHash("sha256").update(JSON.stringify(original ?? null)).digest("hex")}`;
        try {
          if(!original || typeof original!=="object" || Array.isArray(original)) throw new v.HttpError(400,"旧购买记录格式无效");
          const saved=await this.insertTrade(client,{...original, id:undefined, legacyKey, original, confirmed:false,
            platform:typeof original.source==="string"&&original.source.startsWith("steam")?"steam":"buff", quantity:Number(original.quantity ?? 1),
            buyTotalCents:Number(original.buyPriceCents)*Number(original.quantity ?? 1), source:"legacy", boughtAt:original.boughtAt,
            marketHashName:original.marketHashName || original.name });
          results.push({legacyKey,id:saved.id});
        } catch(error) {
          if(!(error instanceof v.HttpError)) throw error;
          await client.query(`INSERT INTO ledger_meta(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING`,["rejected-legacy:"+legacyKey,{original,error:error.message}]);
          results.push({legacyKey,error:error.message,preserved:true});
        }
      }
      return {results,count:results.filter(x=>x.id).length,rejected:results.filter(x=>x.error).length};
    });
  }
  async addPrices(values) {
    if(!Array.isArray(values)||values.length>200) throw new v.HttpError(400,"每批最多 200 个报价");
    return this.transaction(async client=>{
      for(const p of values) {
        const identity=v.item(p), observedAt=v.time(p.observedAt,"报价时间");
        if(new Date(observedAt).getTime()>Date.now()+60000) throw new v.HttpError(400,"报价不能来自未来");
        await client.query(`INSERT INTO ledger_price_snapshots(id,appid,market_hash_name,observed_at,buff_price_cents,steam_price_cents,buff_net_cents,steam_net_cents,source,request_key,metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(request_key) DO NOTHING`,[randomUUID(),identity.appid,identity.marketHashName,observedAt,
          ...["buffPriceCents","steamPriceCents","buffNetCents","steamNetCents"].map(k=>p[k]==null?null:v.integer(p[k],k)),v.text(p.source || "quote","来源",100),v.text(p.requestKey,"报价标识",300),p.metadata || {}]);
      }
      return {count:values.length};
    });
  }
  async syncPreview(records) {
    const {preview}=require('./sync.cjs');
    const known=(await this.pool.query('SELECT source_key FROM ledger_sale_imports')).rows.map(x=>x.source_key);
    return {rows:preview(records,await this.snapshot(),known),persisted:false};
  }
  async syncConfirm(values) {
    if(!Array.isArray(values)||!values.length||values.length>1000) throw new v.HttpError(400,'请选择 1～1000 条记录');
    const {sourceKey}=require('./sync.cjs');
    return this.transaction(async client=>{
      const saved=[],skipped=[];
      for(const entry of values) {
        if(entry.confirmed!==true) throw new v.HttpError(400,'每条卖出记录都需要人工确认实际到账');
        const key=sourceKey(entry.source);
        if((await client.query('SELECT 1 FROM ledger_sale_imports WHERE source_key=$1',[key])).rows.length) {skipped.push(key);continue;}
        const allocations=entry.allocations || [entry];
        if(!allocations.length||allocations.length>100) throw new v.HttpError(400,'购买批次分配无效');
        const group=[];
        for(let index=0;index<allocations.length;index++) {
          const value=allocations[index];
          const t=await this.getTrade(client,v.uuid(value.tradeId));
          // Every row carries the version observed in the preview. Multiple
          // allocations on one lot in this transaction share that base version.
          const base=values.flatMap(x=>x.allocations || [x]).find(x=>x.tradeId===t.id)?.version;
          const prior=group.filter(x=>x.tradeId===t.id).length+saved.filter(x=>x.tradeId===t.id).length;
          if(t.version!==v.integer(base,'购买记录版本',1)+prior) throw new v.HttpError(409,'购买记录已更新，请重新生成同步预览');
          if(!t.confirmed || (entry.source.platform==='steam' ? t.direction!=='knife' : t.direction!=='cashout')) throw new v.HttpError(400,'卖出平台与购买方向不匹配');
          const quantity=v.integer(value.quantity,'售出数量',1), net=v.integer(value.netTotalCents,'实际净到账');
          const soldAt=v.time(value.soldAt,'成交时间'),receivedAt=v.time(value.receivedAt,'实际到账时间');
          if(new Date(soldAt)<new Date(t.boughtAt)||new Date(receivedAt)<new Date(soldAt)||new Date(receivedAt)>new Date()) throw new v.HttpError(400,'请核对成交及实际到账时间');
          let old=null;
          if(value.existingSettlementId) {
            old=row((await client.query('SELECT * FROM ledger_settlements WHERE id=$1 FOR UPDATE',[v.uuid(value.existingSettlementId)])).rows[0]);
            if(!old||old.tradeId!==t.id||old.voided||old.externalKey) throw new v.HttpError(409,'待合并的手动出售记录已改变');
            if(old.version!==v.integer(value.settlementVersion,'出售记录版本',1)) throw new v.HttpError(409,'出售记录已更新');
          }
          if(quantity>await this.available(client,t)+(old?.quantity || 0)) throw new v.HttpError(409,'同步数量超过剩余持仓');
          let result;
          if(old) result=row((await client.query(`UPDATE ledger_settlements SET quantity=$2,net_total_cents=$3,sold_at=$4,received_at=$5,external_key=$6,version=version+1 WHERE id=$1 RETURNING *`,[old.id,quantity,net,soldAt,receivedAt,`${key}:${index}`])).rows[0]);
          else result=row((await client.query(`INSERT INTO ledger_settlements(id,trade_id,quantity,net_total_cents,sold_at,received_at,note,request_key,external_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`,[randomUUID(),t.id,quantity,net,soldAt,receivedAt,'平台卖出记录，经人工核对',`${key}:${index}`])).rows[0]);
          await this.bump(client,t.id); await this.audit(client,t.id,'confirmed_sale_sync',old,result);group.push(result);
        }
        await client.query('INSERT INTO ledger_sale_imports(source_key,platform,original,reviewed) VALUES($1,$2,$3,$4)',[key,entry.source.platform,entry.source,entry]);
        saved.push(...group);
      }
      return {saved,skipped,count:saved.length};
    });
  }
}
Object.assign(Store.prototype,require('./purchases.cjs').methods);
Object.assign(Store.prototype,require('./buy-sync.cjs').methods);
module.exports={Store,row};
