"use strict";
const {randomUUID,createHash}=require('node:crypto');
const v=require('./validation.cjs');
const terminal=new Set(['completed','partial','no_fill','failed','cancelled']);
const states=new Set(['queued','executing','awaiting_user','reconciling','paused',...terminal]);
const lockedStates=new Set(['executing','awaiting_user','reconciling']);
const pendingTotals=(fills,pending)=>fills.filter(f=>f.requestKey===pending.requestKey).reduce((total,f)=>({quantity:total.quantity+f.quantity,cents:total.cents+f.totalCents}),{quantity:0,cents:0});
const decode=r=>r&&Object.fromEntries(Object.entries(r).map(([k,x])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),x instanceof Date?x.toISOString():x]));
const fail=message=>{throw new v.HttpError(409,message);};
const methods={
  async task(value) {
    const identity=v.item(value),platform=v.text(value.platform,'平台',10);
    if(!['buff','steam'].includes(platform))throw new v.HttpError(400,'购买平台无效');
    const quantity=v.integer(value.quantity,'数量',1,1000),maxUnitPriceCents=v.integer(value.maxUnitPriceCents,'最高含费单价',1);
    const maxTotalCents=v.integer(quantity*maxUnitPriceCents,'最高总支出',1);
    if(value.execute!==true)throw new v.HttpError(400,'购买任务需要明确提交执行');
    const requestKey=v.text(value.requestKey,'唯一请求标识',200);
    const payload={...identity,quantity,maxUnitPriceCents,maxTotalCents,name:v.text(value.name||identity.marketHashName,'物品名称'),goodsId:v.text(String(value.goodsId||''),'BUFF 物品 ID',80,true),snapshot:value.snapshot||{}};
    if(platform==='buff'&&!/^\d+$/.test(payload.goodsId))throw new v.HttpError(400,'BUFF 购买必须提供准确的商品 ID');
    if(platform==='buff') {
      if(value.paymentMethod&&value.paymentMethod!=='buff_balance')throw new v.HttpError(400,'BUFF 自动购买仅使用可用资金，余额不足时暂停');
      payload.paymentMethod='buff_balance';
    }
    return this.transaction(async c=>{
      const old=decode((await c.query('SELECT * FROM ledger_purchase_tasks WHERE request_key=$1',[requestKey])).rows[0]);
      if(old){if(old.platform!==platform||['appid','marketHashName','quantity','maxUnitPriceCents','goodsId'].some(k=>old.payload[k]!==payload[k]))fail('相同请求标识对应的购买条件不一致');return old;}
      const account=value.platformAccountId?v.text(value.platformAccountId,'平台账号',200):null;
      const r=decode((await c.query(`INSERT INTO ledger_purchase_tasks(id,account_id,platform,platform_account_id,state,request_key,payload,result)
        VALUES($1,'local',$2,$3,'queued',$4,$5,$6) RETURNING *`,[randomUUID(),platform,account,requestKey,payload,{state:'queued',fills:[],pending:null,filledQuantity:0,spentCents:0}])).rows[0]);
      await this.audit(c,r.id,'purchase_task_created',null,{platform,payload});return r;
    });
  },
  async purchaseTask(id,c=this.pool){const t=decode((await c.query('SELECT * FROM ledger_purchase_tasks WHERE id=$1',[v.uuid(id)])).rows[0]);if(!t)throw new v.HttpError(404,'购买任务不存在');return t;},
  async claimPurchase(id) {
    return this.transaction(async c=>{
      const t=await this.purchaseTask(id,c);
      if(terminal.has(t.state)||t.state==='blocked_adapter'||t.state==='paused')return {task:t,claimed:false};
      if(t.leaseUntil&&new Date(t.leaseUntil)>new Date())return {task:t,claimed:false};
      // Unresolved checkouts retain the platform lock even if an older worker saved
      // an inconsistent queued/paused state. Only an explicit review may release it.
      const other=await c.query(`SELECT id FROM ledger_purchase_tasks WHERE id<>$1 AND platform=$2 AND
        (state IN ('executing','awaiting_user','reconciling') OR result->'pending' IS NOT NULL AND result->'pending'<>'null'::jsonb
        OR result->'preparing'->>'openAttempted'='true') LIMIT 1`,[t.id,t.platform]);
      if(other.rows.length)return {task:t,claimed:false,waitingFor:other.rows[0].id};
      const lease=randomUUID();
      const r=decode((await c.query("UPDATE ledger_purchase_tasks SET lease_token=$2,lease_until=now()+interval '45 seconds',state=CASE WHEN state='queued' THEN 'executing' ELSE state END,version=version+1,updated_at=now() WHERE id=$1 RETURNING *",[t.id,lease])).rows[0]);
      return {task:r,claimed:true,leaseToken:lease};
    });
  },
  async checkpointPurchase(id,value) {
    return this.transaction(async c=>{
      const t=await this.purchaseTask(id,c);
      if(t.leaseToken!==value.leaseToken||!t.leaseUntil||new Date(t.leaseUntil)<=new Date())fail('购买执行权已过期，先核对原任务');
      const j=value.journal;
      if(!j||!states.has(j.state))throw new v.HttpError(400,'购买状态无效');
      if(t.platformAccountId&&value.platformAccountId&&t.platformAccountId!==value.platformAccountId)fail('平台账号已改变，停止购买');
      const account=t.platformAccountId||(value.platformAccountId?v.text(value.platformAccountId,'平台账号',200):null);
      const fills=(await c.query('SELECT payload FROM ledger_purchase_receipts WHERE task_id=$1 ORDER BY created_at',[t.id])).rows.map(r=>r.payload);
      const qty=fills.reduce((n,f)=>n+f.quantity,0),spent=fills.reduce((n,f)=>n+f.totalCents,0);
      if((j.pending||j.preparing?.openAttempted)&&!lockedStates.has(j.state))fail('原购买窗口或订单尚未核对，不能释放平台执行锁');
      if(j.pending) {
        if(!account)fail('没有确认平台账号，禁止提交');
        v.text(j.pending.listingId,'挂单标识',500);v.text(j.pending.requestKey,'子订单标识',500);
        v.integer(j.pending.quantity,'本次购买数量',1,t.payload.quantity);
        v.integer(j.pending.maxTotalCents,'本次含费金额',1,t.payload.maxTotalCents);
        if(j.pending.maxTotalCents>j.pending.quantity*t.payload.maxUnitPriceCents)fail('本次提交超出限价');
        // Existing pending submissions may already have produced the saved receipt.
        if(!t.result.pending&&(qty+j.pending.quantity>t.payload.quantity||spent+j.pending.maxTotalCents>t.payload.maxTotalCents))fail('本次提交超出剩余数量或预算');
      }
      if(t.result.pending&&j.pending&&['requestKey','listingId','quantity','maxTotalCents'].some(k=>t.result.pending[k]!==j.pending[k]))fail('原购买结果尚未核对，不能变更待核对订单或预算');
      if(t.result.pending&&!j.pending&&!value.resolved)fail('清除待核对订单需要明确核对结果');
      if(t.result.pending&&!j.pending) {
        const paid=pendingTotals(fills,t.result.pending);
        if(paid.quantity!==t.result.pending.quantity||paid.cents>t.result.pending.maxTotalCents)fail('原订单回执尚未完整覆盖本笔数量和金额，请通过人工核对确认实际结果');
      }
      if(t.result.preparing?.openAttempted&&j.preparing&&(t.result.preparing.listingId!==j.preparing.listingId||j.preparing.openAttempted!==true))fail('原购买窗口尚未核对，不能切换或重置购买窗口');
      if(t.result.preparing?.openAttempted&&j.pending&&t.result.preparing.listingId!==j.pending.listingId)fail('待提交订单与原购买窗口不一致');
      if(t.result.preparing?.openAttempted&&!j.preparing&&!j.pending&&(!t.result.pending||!value.resolved))fail('原购买窗口可能仍可付款，请先核对实际结果');
      if(terminal.has(j.state)&&j.pending)fail('未核对的订单不能结束');
      if(terminal.has(j.state)&&j.preparing?.openAttempted)fail('已打开的购买窗口尚未核对，不能结束任务');
      if(j.state==='completed'&&qty!==t.payload.quantity)fail('尚未全部成交');
      const result={...j,fills,filledQuantity:qty,spentCents:spent};
      if(t.stopRequested&&!result.pending){
        result.state=result.preparing?.openAttempted?'awaiting_user':'cancelled';
        if(result.state==='awaiting_user')result.issue='已停止后续购买；原购买窗口可能仍可付款，请核对并补填实际结果后结束任务';
      }
      const r=decode((await c.query(`UPDATE ledger_purchase_tasks SET result=$2,state=$3,platform_account_id=$4,version=version+1,
        lease_until=CASE WHEN $5 THEN NULL ELSE now()+interval '45 seconds' END,lease_token=CASE WHEN $5 THEN NULL ELSE lease_token END,updated_at=now() WHERE id=$1 RETURNING *`,[t.id,result,result.state,account,!!value.release])).rows[0]);
      await this.audit(c,t.id,'purchase_checkpoint',{state:t.state,pending:t.result.pending},{state:r.state,pending:r.result.pending});return r;
    });
  },
  async purchaseReceipt(id,value) {
    return this.transaction(c=>this.receiptInTransaction(c,id,value));
  },
  async receiptInTransaction(c,id,value) {
      const t=await this.purchaseTask(id,c),f=value.fill;
      if(!f||f.platform!==t.platform||f.appid!==t.payload.appid||f.marketHashName!==t.payload.marketHashName||!t.platformAccountId||f.accountId!==t.platformAccountId)fail('成交回执的账号或完整物品不一致');
      const fillId=v.text(f.fillId,'成交标识',200),quantity=v.integer(f.quantity,'成交数量',1),totalCents=v.integer(f.totalCents,'实付金额',0);
      const boughtAt=v.time(f.boughtAt,'成交时间');
      const old=(await c.query('SELECT * FROM ledger_purchase_receipts WHERE platform=$1 AND platform_account_id=$2 AND fill_id=$3',[t.platform,t.platformAccountId,fillId])).rows[0];
      if(old){if(old.task_id!==t.id||['requestKey','quantity','totalCents','appid','marketHashName'].some(k=>old.payload[k]!==f[k]))fail('成交标识已记入其他订单或金额不一致');return {duplicate:true,tradeId:old.trade_id};}
      if(!t.result.pending||f.requestKey!==t.result.pending.requestKey)fail('回执不对应待核对订单');
      const fill={...f,fillId,quantity,totalCents,boughtAt};
      const scopedId='purchase:'+createHash('sha256').update(`${t.platform}|${t.platformAccountId}|${fillId}`).digest('hex');
      const orderId=f.orderId===null?null:f.orderId||fillId;
      let trade;
      if(t.platform==='buff') {
        // A user may have confirmed history while the original browser receipt was offline.
        // Reuse that purchase instead of charging its cash cost a second time.
        const history=(await this.data(c)).trades.filter(x=>x.snapshot?.buyHistorySourceKey);
        const matching=require('./buy-sync.cjs').matches({...t.payload,platform:'buff',platformAccountId:t.platformAccountId,fillId,orderId,quantity,boughtAt},history);
        if(matching.identityConflict)fail('该订单已通过购买历史入账，但完整物品规格不一致，请核对已有买入');
        if(matching.orderConflict||matching.duplicates.length>1)fail('该订单已通过购买历史入账，但成交数量不一致，请核对已有买入后继续');
        if(matching.duplicates.length) {
          trade=matching.duplicates[0];
          if(trade.buyTotalCents!==totalCents)fail('该订单已通过购买历史入账，实付金额与回执不同，请先更正已有买入');
          await this.audit(c,trade.id,'linked_purchase_receipt',null,{taskId:t.id,fill});
        }
      }
      trade=trade||await this.insertTrade(c,{...t.payload,platform:t.platform,fillId:scopedId,orderId,quantity,buyTotalCents:totalCents,boughtAt,
        deliveredAt:f.deliveredAt||null,tradableAt:f.tradableAt||null,marketableAt:f.marketableAt||null,confirmed:true,source:'platform-purchase',
        snapshot:{...t.payload.snapshot,purchaseTaskId:t.id,platformAccountId:t.platformAccountId},original:fill});
      await c.query('INSERT INTO ledger_purchase_receipts(task_id,platform,platform_account_id,fill_id,trade_id,payload) VALUES($1,$2,$3,$4,$5,$6)',[t.id,t.platform,t.platformAccountId,fillId,trade.id,fill]);
      const fills=(await c.query('SELECT payload FROM ledger_purchase_receipts WHERE task_id=$1',[t.id])).rows.map(r=>r.payload);
      const qty=fills.reduce((n,f)=>n+f.quantity,0),spent=fills.reduce((n,f)=>n+f.totalCents,0);
      const paid=pendingTotals(fills,t.result.pending);
      const breach=qty>t.payload.quantity||spent>t.payload.maxTotalCents||totalCents>quantity*t.payload.maxUnitPriceCents||
        paid.quantity>t.result.pending.quantity||paid.cents>t.result.pending.maxTotalCents;
      const result={...t.result,fills,filledQuantity:qty,spentCents:spent,...(breach?{issue:'实际回执超出限额，已保留并停止后续购买'}:{})};
      await c.query('UPDATE ledger_purchase_tasks SET result=$2,stop_requested=stop_requested OR $3,version=version+1,updated_at=now() WHERE id=$1',[t.id,result,breach]);
      await this.audit(c,t.id,'purchase_receipt',null,{fill,tradeId:trade.id});return {tradeId:trade.id,breach};
  },
  async reviewPurchase(id,value) {
    if(value.confirmed!==true)throw new v.HttpError(400,'请人工确认平台订单的实际结果');
    return this.transaction(async c=>{
      let t=await this.purchaseTask(id,c);
      if(t.version!==value.version)fail('任务已更新，请刷新后核对');
      if(t.leaseUntil&&new Date(t.leaseUntil)>new Date())fail('任务正在操作平台，请等待后再核对');
      if(terminal.has(t.state))fail('任务已结束');
      if(!['filled','not_filled'].includes(value.outcome))throw new v.HttpError(400,'核对结果无效');
      const note=v.text(value.note,'核对说明',1000);
      if(t.platformAccountId&&value.platformAccountId&&t.platformAccountId!==value.platformAccountId)fail('实际购买账号与原任务不一致，请核对原账号');
      const account=t.platformAccountId||v.text(value.platformAccountId,'实际购买账号',200);
      if(value.outcome==='not_filled'&&t.result.pending) {
        const receipts=(await c.query('SELECT payload FROM ledger_purchase_receipts WHERE task_id=$1',[t.id])).rows.map(r=>r.payload);
        if(pendingTotals(receipts,t.result.pending).quantity>0)fail('本笔已有成交回执，不能确认未成交；请核对并补填实际成交凭证');
      }
      if(value.outcome==='filled') {
        const f=value.fill||{};
        // Review records the actual outcome, including a retained overfilled receipt.
        // The receipt path still marks any limit breach and stops further purchases.
        v.integer(f.quantity,'实际数量',1,1000000);
        v.integer(f.totalCents,'实际支付金额',0);
        const pending=t.result.pending||{listingId:'manual:'+v.text(f.fillId,'实际订单号',200),requestKey:'manual:'+randomUUID(),quantity:f.quantity,maxTotalCents:f.totalCents};
        await c.query('UPDATE ledger_purchase_tasks SET platform_account_id=$2,result=$3 WHERE id=$1',[t.id,account,{...t.result,pending}]);
        await this.receiptInTransaction(c,id,{fill:{...f,platform:t.platform,appid:t.payload.appid,marketHashName:t.payload.marketHashName,accountId:account,requestKey:pending.requestKey,evidence:{source:'human-confirmed',note}}});
        t=await this.purchaseTask(id,c);
      }
      const attempted=[...new Set([...(t.result.attemptedListingIds||[]),t.result.pending?.listingId,t.result.preparing?.listingId].filter(Boolean))];
      const next=t.stopRequested?'cancelled':t.result.filledQuantity===t.payload.quantity?'completed':'queued';
      const result={...t.result,pending:null,preparing:null,attemptedListingIds:attempted,state:next,issue:'',reviewResolution:{outcome:value.outcome,note,at:new Date().toISOString()}};
      const saved=decode((await c.query('UPDATE ledger_purchase_tasks SET result=$2,state=$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[id,result,next])).rows[0]);
      await this.audit(c,id,'purchase_human_review',t.result,{outcome:value.outcome,note,result});return saved;
    });
  },
  async taskState(id,value) {
    return this.transaction(async c=>{
      const t=await this.purchaseTask(id,c);
      if(value.version!==t.version)fail('任务已更新，请刷新后操作');
      if(!['cancelled','resume'].includes(value.state))throw new v.HttpError(400,'任务操作无效');
      if(terminal.has(t.state))return t;
      if(t.leaseUntil&&new Date(t.leaseUntil)>new Date()) {
        if(value.state==='resume')fail('任务正在执行，请等待本次结果');
        return decode((await c.query('UPDATE ledger_purchase_tasks SET stop_requested=true,version=version+1 WHERE id=$1 RETURNING *',[t.id])).rows[0]);
      }
      const cancel=value.state==='cancelled';
      const state=t.result.pending?'reconciling':t.result.preparing?.openAttempted?'awaiting_user':cancel?'cancelled':'queued';
      const issue=cancel&&state==='awaiting_user'?'已停止后续购买；原购买窗口可能仍可付款，请核对并补填实际结果后结束任务':'';
      const r=decode((await c.query('UPDATE ledger_purchase_tasks SET state=$2,stop_requested=$3,result=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[t.id,state,cancel,{...t.result,state,issue}])).rows[0]);
      await this.audit(c,id,cancel?'purchase_stop_requested':'purchase_resumed',{state:t.state},{state});return r;
    });
  },
};
module.exports={methods,terminal};
