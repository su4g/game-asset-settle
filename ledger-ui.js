(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const money = value => value == null ? "—" : self.BuffHelperCommon.formatCents(value,"CNY");
  const signed = value => value == null ? "待补全" : `${value>0?"+":""}${money(value)}`;
  const tone = value => value == null || value===0 ? "" : value>0?"gain":"loss";
  const discount = value => self.BuffHelperCommon.formatDiscount(value);
  const date = value => value ? new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}) : "—";
  const inputTime = value => value ? new Date(new Date(value).getTime()+8*3600000).toISOString().slice(0,19) : "";
  const iso = value => value ? new Date(value+(value.length===16?":00":"")+"+08:00").toISOString() : null;
  const keepTime = (input, original) => input === inputTime(original) ? original : iso(input);
  function cents(value) {
    if(!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(String(value).trim())) throw new Error("金额须为非负数，最多两位小数");
    const [whole,fraction=""]=String(value).trim().split('.');
    const n=Number(whole)*100+Number(fraction.padEnd(2,'0'));
    if(!Number.isSafeInteger(n)) throw new Error("金额超出有效范围");return n;
  }
  const amount = value => value==null?"":(value/100).toFixed(2);
  const states={unverified:"待核对购买",awaiting_delivery:"待收货",cooling:"冷却中",estimated_cooldown:"解锁待核验",ready:"可出售",partial:"部分售出",pending_receipt:"已售出·待到账",completed:"已完成",refunded:"已退款"};
  const state={direction:"knife",page:1,rows:[],summary:null,online:false,cache:{},drafts:new Map(),busy:new Set(),syncRows:[],holdings:[],request:0};
  const params=new URLSearchParams(location.search);
  if(params.has("compact")) document.body.classList.add("compact");
  function send(message) {
    return new Promise((resolve,reject)=>{
      if(!globalThis.chrome?.runtime?.id) return reject(new Error("请从 BUFF Market Helper 扩展打开账本"));
      chrome.runtime.sendMessage(message,response=>{
        const error=chrome.runtime.lastError;
        if(error || !response?.ok) reject(new Error(error?.message || response?.error || "扩展未响应"));else resolve(response.result);
      });
    });
  }
  function notice(text) {$("notice").textContent=text;$("notice").hidden=!text;}
  function online(value) {
    state.online=value;document.body.classList.toggle("offline",!value);
    $("connection").className=value?"online":"offline";
    $("connection").textContent=value?"● PostgreSQL 已连接":"● 离线 · 最后同步数据";
  }
  async function api(path,method="GET",body) {
    try {
      const value=await send({type:"LEDGER_REQUEST",path,method,...(body===undefined?{}:{body})});
      if(method==="GET") {state.cache[path]={value,at:Date.now()};const keys=Object.keys(state.cache);while(keys.length>16)delete state.cache[keys.shift()];chrome.storage.local.set({ledgerViewCache:state.cache}).catch(()=>{});}
      return value;
    } catch(error) {
      if(method==="GET" && state.cache[path]) {online(false);notice(`${error.message}。显示上次同步数据，恢复连接后可继续编辑。`);return state.cache[path].value;}
      throw error;
    }
  }
  async function write(path,method,body) {if(!state.online)throw new Error("本地服务离线，请恢复连接后再保存");return api(path,method,body);}
  function openDialog(title,body,wide=false) {
    $("dialogTitle").textContent=title;$("dialogBody").innerHTML=body;$("dialogError").textContent="";$("dialog").classList.toggle("wide",wide);
    if(!$("dialog").open)$("dialog").showModal();
  }
  function errorDialog(error) {if(!$("dialog").open)return notice(error.message || String(error));$("dialogError").textContent=error.message || String(error);}
  async function action(button,fn) {if(button?.disabled)return; if(button)button.disabled=true;try{await fn();}catch(error){$("dialog").open?errorDialog(error):notice(error.message);}finally{if(button)button.disabled=false;}}
  function metric(title,value,sub,kind="") {return `<div class="metric"><span class="metric-title">${title}</span><strong class="${kind}">${value}</strong><small>${sub}</small></div>`;}
  function renderSummary(summary) {
    state.summary=summary;const t=summary.totals;
    $("metrics").innerHTML=metric("总购买 · BUFF 现金",money(t.buffBuyCents),`Steam 余额消耗 ${money(t.steamBuyCents)}`)+
      metric("总收入 · BUFF 净回款",money(t.buffReceivedCents),`Steam 净入账 ${money(t.steamReceivedCents)}`)+
      metric("已实现现金盈亏",t.realizedComplete?signed(t.realizedCents):"成本待补全",`${summary.tradeCount} 笔已确认 · ${summary.unverifiedCount} 笔待核对`,t.realizedComplete?tone(t.realizedCents):"")+
      metric("持仓现金成本",money(t.inventoryCostCents),`${t.holdingCount} 笔持仓 · 已知成本部分`)+
      metric("预估浮动盈亏",t.estimateComplete?signed(t.unrealizedCents):"估值待补全",`有效报价 ${t.quotedCount}/${t.holdingCount}`,t.estimateComplete?tone(t.unrealizedCents):"")+
      metric("当前总盈亏",signed(t.totalPnlCents),"已实现 ＋ 估值 · 现金口径",tone(t.totalPnlCents));
    const wallet=summary.wallets.find(w=>w.accountId==='local');
    $("walletSummary").textContent=wallet?`已记录 Steam 余额 ${money(wallet.balanceCents)} · 现金成本 ${money(wallet.costCents)} · 加权成本 ${discount(wallet.costRatio)}${wallet.missingFundingCents?" · 有支出来源待补全":""}`:"尚未记录 Steam 余额来源，可先填写期初余额与现金成本";
    $("coverage").textContent=summary.issues.length?summary.issues.join("；"):"现金与 Steam 余额分别统计；平台退款单独记账，不计为销售收入。";
    $("lastSync").textContent=`最近同步 ${date(summary.asOf)} · 上海时间`;
  }
  function chart(points,series,{small=false,markers=[]}={}) {
    const defined=points.flatMap(p=>series.map(s=>p[s.key]).filter(Number.isFinite));
    if(!defined.length)return small?'<span class="muted small">暂无走势</span>':'<div class="chart-empty"><strong>等待真实交易与价格数据</strong><span>完成回填后生成盈亏曲线；缺失报价不会补成零。</span></div>';
    const w=small?100:960,h=small?35:220,l=small?0:62,r=small?0:12,top=small?3:12,bottom=small?2:28;
    const times=points.map(p=>Number(p.at)),start=Math.min(...times),end=Math.max(...times,start+1);
    let low=Math.min(...defined,small?Infinity:0),high=Math.max(...defined,small?-Infinity:0);if(low===high){low-=100;high+=100;}
    const pad=(high-low)*.1;low-=pad;high+=pad;
    const x=at=>l+(at-start)/(end-start)*(w-l-r),y=n=>top+(high-n)/(high-low)*(h-top-bottom);
    let svg=`<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${small?"七天价格变化":"累计盈亏曲线，金额单位人民币元"}">`;
    if(!small)for(let i=0;i<4;i++){const v=low+(high-low)*i/3;svg+=`<line x1="${l}" x2="${w-r}" y1="${y(v)}" y2="${y(v)}" stroke="#edf0f4"/><text x="${l-10}" y="${y(v)+4}" text-anchor="end" fill="#8a94a2" font-size="10">${esc((v/100).toFixed(1))}</text>`;}
    if(!small)svg+=`<line x1="${l}" x2="${w-r}" y1="${y(0)}" y2="${y(0)}" stroke="#cbd3df" stroke-dasharray="3 4"/>`;
    for(const s of series){let path="",pen=false,lastAt=null;for(const p of points){const v=p[s.key];if(!Number.isFinite(v)){if(!s.gapMs)pen=false;continue;}if(s.gapMs&&lastAt!=null&&p.at-lastAt>s.gapMs)pen=false;path+=`${pen?'L':'M'}${x(p.at).toFixed(2)},${y(v).toFixed(2)} `;pen=true;lastAt=p.at;}svg+=`<path d="${path}" fill="none" stroke="${s.color}" stroke-width="${small?1.4:2}" ${s.dashed?'stroke-dasharray="5 5"':''}/>`;
      if(!small)for(const p of points){if(!Number.isFinite(p[s.key]))continue;svg+=`<circle cx="${x(p.at)}" cy="${y(p[s.key])}" r="3" fill="${s.color}"><title>${esc(date(p.at))} · ${s.label} ${esc(money(p[s.key]))}</title></circle>`;}}
    if(!small){for(const m of markers){if(m.at<start||m.at>end)continue;svg+=`<line x1="${x(m.at)}" x2="${x(m.at)}" y1="${top}" y2="${h-bottom}" stroke="#bba787" stroke-dasharray="3 5"><title>${esc(m.label)} ${esc(date(m.at))}</title></line>`;}svg+=`<text x="${l}" y="${h-6}" fill="#8a94a2" font-size="10">${esc(date(start))}</text><text x="${w-r}" y="${h-6}" text-anchor="end" fill="#8a94a2" font-size="10">${esc(date(end))}</text>`;}
    return svg+"</svg>";
  }
  function draft(row) {
    if(state.drafts.get(row.id)?.version!==row.version&&!state.drafts.get(row.id)?.dirty)state.drafts.delete(row.id);
    if(!state.drafts.has(row.id))state.drafts.set(row.id,{version:row.version,quantity:String(Math.max(1,row.remainingQuantity)),unit:"",netTotal:"",soldAt:inputTime(Date.now()),receivedAt:inputTime(Date.now()),received:true,dirty:false});
    return state.drafts.get(row.id);
  }
  function renderRows(result) {
    state.rows=result.rows;$("recordCount").textContent=`${result.total} 条记录`;$("pageNumber").textContent=String(result.page);$("prevPage").disabled=result.page<=1;$("nextPage").disabled=result.page*result.limit>=result.total;
    if(!result.rows.length){$("tradeRows").innerHTML='<tr><td colspan="14" class="empty-cell"><strong>还没有符合条件的购买记录</strong>使用“补录购买”记录实际成交，旧记录确认后计入统计。</td></tr>';return;}
    $("tradeRows").innerHTML=result.rows.map(row=>{
      const d=draft(row),closed=!row.confirmed||!row.remainingQuantity,disable=closed?'disabled':'';
      const ratio=row.snapshot?.[row.direction==='knife'?'knifeRatio':'cashoutRatio'];
      return `<tr data-trade-id="${row.id}"><td><button class="item-link" data-detail="${row.id}">${esc(row.name)}</button><div class="item-meta">${row.appid===730?'CS2':'Dota 2'} · ${row.platform==='buff'?'BUFF 现金买入':'Steam 余额买入'}</div><div class="item-meta" title="${esc(row.orderId || row.id)}">${esc(row.orderId || (row.source==='platform-purchase'?'平台成交回执 · 未展示单号':'手动／迁移记录'))}</div></td>
        <td>${esc(date(row.boughtAt))}<div class="muted small">${new Date(row.boughtAt).getFullYear()} · 上海时间</div></td><td>${money(row.buyTotalCents)}<div class="muted small">均价 ${money(Math.round(row.buyTotalCents/row.quantity))}</div></td><td>${row.remainingQuantity} / ${row.quantity}<div class="muted small">已售 ${row.soldQuantity}</div></td>
        <td>${discount(row.actualRatio)}<div class="muted small">买入参考 ${discount(ratio)}</div></td><td><span class="badge ${row.status==='completed'?'complete':row.status==='pending_receipt'?'pending':''}">${states[row.status]}</span><div class="muted small">${row.unlockAt?`${row.unlockConfirmed?'平台确认':'预计'} ${date(row.unlockAt)}`:'收货后记录解锁日期'}</div></td>
        <td>${money(row.estimatedNetUnitCents)}<div class="muted small">${date(row.quote?.[row.direction==='knife'?'steamObservedAt':'buffObservedAt'])}</div></td><td><div class="mini-chart">${chart((row.trend || []).map(p=>({at:new Date(p.observedAt).getTime(),price:row.direction==='knife'?p.steamNetCents:p.buffNetCents})),[{key:'price',color:'#647e9a',gapMs:90*60000}],{small:true})}</div><button class="small" data-detail="${row.id}">查看 7 天</button></td>
        <td class="entry"><input aria-label="本次售出数量" data-field="quantity" type="number" min="1" max="${row.remainingQuantity}" step="1" value="${esc(d.quantity)}" ${disable}></td><td class="entry"><input aria-label="净到手单价" data-field="unit" type="number" min="0" step="0.0001" placeholder="元 / 件" value="${esc(d.unit)}" ${disable}></td><td class="entry"><input aria-label="实际净到账总额" data-field="netTotal" type="number" min="0" step="0.01" placeholder="实际到账（元）" value="${esc(d.netTotal)}" ${disable}><div class="row-note" data-row-preview>以实际结算总额为准</div></td>
        <td class="entry"><div class="time-inputs"><input aria-label="出售成交时间" data-field="soldAt" type="datetime-local" step="1" value="${esc(d.soldAt)}" ${disable}><input aria-label="实际到账时间" data-field="receivedAt" type="datetime-local" step="1" value="${esc(d.receivedAt)}" ${disable}><label class="small"><input data-field="received" type="checkbox" ${d.received?'checked':''} ${disable}>已实际到账</label></div></td>
        <td>${money(row.receivedCents)}<div class="small ${tone(row.realizedCents)}">${row.direction==='knife'?(row.receivedCents?'已转 Steam 余额':'待 Steam 到账'):row.realizedComplete?signed(row.realizedCents):'成本待补全'}</div><div class="small muted">结转成本 ${money(row.settledCostCents)}</div>${row.direction==='cashout'&&row.realizedComplete&&row.settledCostCents>0?`<div class="small ${tone(row.realizedCents)}">盈亏率 ${(row.realizedCents/row.settledCostCents*100).toFixed(2)}%</div>`:''}${row.pendingQuantity?`<div class="small muted">${row.pendingQuantity} 件待到账</div>`:''}</td>
        <td class="sticky-end"><button class="primary write-action" data-settle="${row.id}" ${disable}>${d.received?'确认到账':'保存待到账'}</button><div><button class="item-link small" data-detail="${row.id}">${row.confirmed?'明细 / 更正':'核对购买'}</button></div></td></tr>`;
    }).join('');
  }
  function query() {
    const q=new URLSearchParams({direction:state.direction,page:state.page,limit:50,targetRatioBps:Math.round(Number($("targetRatio").value)*1000)});
    for(const [id,key] of [['search','q'],['game','appid'],['tradeStatus','status']])if($(id).value)q.set(key,$(id).value);
    if($("dateFrom").value)q.set('from',$("dateFrom").value+'T00:00:00+08:00');if($("dateTo").value)q.set('to',$("dateTo").value+'T23:59:59+08:00');return q;
  }
  async function refresh() {
    const request=++state.request;
    try {
      await send({type:'LEDGER_REQUEST',path:'/health'});online(true);notice('');
    } catch(error) {online(false);notice(error.message+'。服务启动命令：npm run service:start');}
    const ratio=Math.round(Number($("targetRatio").value)*1000);
    try {
      const results=await Promise.all([api(`/summary?targetRatioBps=${ratio}`),api(`/series?days=${$("chartDays").value}&targetRatioBps=${ratio}`),state.direction==='tasks'?api('/tasks'):api('/trades?'+query())]);
      if(request!==state.request)return;
      renderSummary(results[0]);$("pnlChart").innerHTML=chart(results[1].points,[{key:'realizedCents',color:'#455d77',label:'已实现盈亏'},{key:'totalPnlCents',color:'#9cabc0',dashed:true,label:'含估值总盈亏'}]);
      if(state.direction==='tasks')renderTasks(results[2]);else renderRows(results[2]);
    }catch(error){notice(error.message);}
  }
  function renderTasks(tasks) {
    const labels={queued:'排队中',executing:'购买中',awaiting_user:'等待人工处理',reconciling:'结果待核对',paused:'已暂停',completed:'全部成交',partial:'部分成交',no_fill:'无符合限价的成交',cancelled:'已停止',failed:'执行失败',blocked_adapter:'旧版购买意向'};
    $('recordCount').textContent=`${tasks.length} 个任务`;
    $('tasks').innerHTML=tasks.length?tasks.map(t=>{const ended=['completed','partial','no_fill','cancelled','failed','blocked_adapter'].includes(t.state);return `<div class="task-item"><div><strong>${esc(t.payload.name || t.payload.marketHashName)}</strong><p>${esc(t.platform.toUpperCase())} · 含费限价 ${money(t.payload.maxUnitPriceCents)} · 总预算 ${money(t.payload.quantity*t.payload.maxUnitPriceCents)}</p><p><b>${t.result.filledQuantity||0} / ${t.payload.quantity} 件已成交</b> · 实付 ${money(t.result.spentCents||0)} · ${date(t.createdAt)}</p><p class="muted small">账号 ${esc(t.platformAccountId||'待登录核对')}${t.stopRequested?' · 已要求停止后续购买':''}</p><p role="status">${esc(t.result.issue || t.result.message || '')}</p>${t.result.pending?`<p class="read-only-note">本笔 ${t.result.pending.quantity} 件 · 已保存金额上限 ${money(t.result.pending.maxTotalCents)}。核对完成前不会再次提交。</p>`:''}</div><div class="task-actions"><span class="badge">${labels[t.state]||esc(t.state)}</span>${ended?'':`<button data-task-action="OPEN" data-task-id="${t.id}">打开平台 / 人工接管 ↗</button><button data-task-action="RESUME" data-task-id="${t.id}">继续核对</button><button data-task-review="${t.id}">补填订单凭证</button><button data-task-action="STOP" data-task-id="${t.id}">停止后续购买</button>`}</div></div>`;}).join(''):'<div class="chart-empty">暂无购买任务</div>';
  }
  async function reviewTask(id) {
    const t=await api('/tasks/'+id);
    openDialog('人工核对购买结果',`<p>${esc(t.payload.name||t.payload.marketHashName)} · 已成交 ${t.result.filledQuantity||0}/${t.payload.quantity} 件</p><div class="callout">先在平台订单记录中核对。本表只记录已经发生的实际购买。请如实填写异常成交；数量或金额超出任务约定时，会入账并停止后续购买。其余核对完成后会继续执行原任务剩余数量；不再购买时，请先点击“停止后续购买”。</div><form id="reviewTaskForm"><div class="form-grid"><label class="span-2">核对结果<select name="outcome"><option value="filled">本笔已实际成交 / 付款</option><option value="not_filled">已确认本笔没有成交且没有未完成支付</option></select></label><label class="span-2">平台账号标识<input name="account" value="${esc(t.platformAccountId||'')}" ${t.platformAccountId?'readonly':''} required></label><label class="span-2">真实订单 / 成交号<input name="fillId" autocomplete="off"></label><label>实际数量<input name="quantity" type="number" min="1" max="1000000" step="1" value="1"></label><label>实际支付总额（含费，元）<input name="total" type="number" min="0" step="0.01"></label><label>实际购买时间<input name="boughtAt" type="datetime-local" step="1" value="${inputTime(Date.now())}"></label><label>实际收货时间（可后补）<input name="deliveredAt" type="datetime-local" step="1"></label><label class="span-2">核对说明<input name="note" required placeholder="根据平台哪条订单核对，或未成交的依据"></label><label class="span-2 check"><input type="checkbox" name="confirmed" required>我已核对平台订单，确认上述结果</label></div><div class="form-actions"><button class="primary">确认结果并更新原任务</button></div></form>`);
    const f=$('reviewTaskForm');const toggle=()=>{for(const name of ['fillId','quantity','total','boughtAt']){f.elements[name].required=f.outcome.value==='filled';f.elements[name].disabled=f.outcome.value!=='filled';}};f.outcome.onchange=toggle;toggle();
    f.onsubmit=e=>{e.preventDefault();action(f.querySelector('button'),async()=>{await write(`/tasks/${id}/review`,'POST',{version:t.version,confirmed:f.confirmed.checked,platformAccountId:f.account.value,outcome:f.outcome.value,note:f.note.value,...(f.outcome.value==='filled'?{fill:{fillId:f.fillId.value,orderId:f.fillId.value,quantity:Number(f.quantity.value),totalCents:cents(f.total.value),boughtAt:iso(f.boughtAt.value),deliveredAt:iso(f.deliveredAt.value)}}:{})});$('dialog').close();await refresh();});};
  }
  async function settle(id,button) {
    const d=state.drafts.get(id),row=state.rows.find(t=>t.id===id);if(!d||!row)return;
    const quantity=Number(d.quantity);if(!Number.isSafeInteger(quantity)||quantity<1||quantity>row.remainingQuantity)throw new Error('请填写有效的本次售出数量');
    const net=cents(d.netTotal);if(!d.soldAt || d.received&&!d.receivedAt)throw new Error('请补齐成交和实际到账时间');
    const requestKey=d.requestKey || (d.requestKey=crypto.randomUUID());
    await write(`/trades/${id}/settlements`,'POST',{version:d.version,quantity,netTotalCents:net,soldAt:iso(d.soldAt),receivedAt:d.received?iso(d.receivedAt):null,requestKey});
    state.drafts.delete(id);await refresh();notice(d.received?'实际到账已保存，资金成本与盈亏已重新计算':'已记录成交，实际到账后才完成挂刀／提现');
  }
  function manual(seed={}) {
    openDialog('补录实际购买',`<form id="manualForm"><div class="form-grid"><label>购买平台<select name="platform"><option value="buff" ${seed.platform!=='steam'?'selected':''}>BUFF · 挂刀</option><option value="steam" ${seed.platform==='steam'?'selected':''}>Steam · 提现</option></select></label><label>游戏<select name="appid"><option value="730">CS2</option><option value="570" ${seed.appid===570?'selected':''}>Dota 2</option></select></label><label class="span-2">物品显示名称<input name="name" required value="${esc(seed.name || '')}"></label><label class="span-2">完整 Steam 物品名称（含规格）<input name="marketHashName" required value="${esc(seed.marketHashName || '')}" placeholder="例如 Recoil Case"></label><label>实际购买数量<input name="quantity" type="number" min="1" step="1" value="1" required></label><label>实际支付总额（元）<input name="total" type="number" min="0" step="0.01" required placeholder="按真实订单填写"></label><label>买入时间<input name="boughtAt" type="datetime-local" step="1" value="${inputTime(Date.now())}" required></label><label>实际收货时间（可后补）<input name="deliveredAt" type="datetime-local" step="1"></label><label class="span-2">平台订单号<input name="orderId" placeholder="可选；后续同步辅助匹配"></label><label class="span-2 check"><input name="confirmed" type="checkbox">已核对实际付款与数量，计入正式账本</label></div><div class="form-actions"><p>BUFF 与 Steam 金额分别入账。未确认的记录保留在“待核对购买”。</p><button class="primary">保存购买记录</button></div></form>`);
    const form=$('manualForm'),id=crypto.randomUUID();
    form.onsubmit=e=>{e.preventDefault();action(form.querySelector('button'),async()=>{
      const f=new FormData(form);await write('/trades','POST',{id,platform:f.get('platform'),appid:Number(f.get('appid')),name:f.get('name'),marketHashName:f.get('marketHashName'),quantity:Number(f.get('quantity')),buyTotalCents:cents(f.get('total')),boughtAt:iso(f.get('boughtAt')),deliveredAt:iso(f.get('deliveredAt')),orderId:f.get('orderId'),confirmed:form.confirmed.checked,goodsId:seed.goodsId || '',snapshot:seed,source:'manual'});
      $('dialog').close();await refresh();});};
  }
  async function detail(id,window='purchase') {
    const data=await api(`/trades/${id}?window=${window}`),t=data.trade;
    const markers=[{at:new Date(t.boughtAt).getTime(),label:'买入'},...(t.unlockAt?[{at:new Date(t.unlockAt).getTime(),label:t.unlockConfirmed?'平台解锁':'预计解锁'}]:[]),...data.settlements.map(s=>({at:new Date(s.soldAt).getTime(),label:'实际售出'}))];
    openDialog(t.name,`<div class="detail-numbers"><div><small>实际买入</small><strong>${money(t.buyTotalCents)}</strong></div><div><small>实际净到账</small><strong>${money(t.receivedCents)}</strong></div><div><small>剩余数量</small><strong>${t.remainingQuantity} / ${t.quantity}</strong></div><div><small>实际折扣</small><strong>${discount(t.actualRatio)}</strong></div></div>
      <div class="section-heading"><h3>价格轨迹 · 在售净价</h3><select id="detailWindow"><option value="purchase" ${window==='purchase'?'selected':''}>买入后 0—7 天</option><option value="recent" ${window==='recent'?'selected':''}>最近 7 天</option></select></div><div class="chart">${chart(data.prices.map(p=>({at:new Date(p.observedAt).getTime(),buff:p.buffNetCents,steam:p.steamNetCents})),[{key:'buff',color:'#c3945d',label:'BUFF 净卖价',gapMs:90*60000},{key:'steam',color:'#647e9a',label:'Steam 净卖价',gapMs:90*60000}],{markers})}</div><p class="muted small">金色：BUFF；蓝色：Steam。每个点使用真实采价时间，离线缺口不补值。买入均价 ${money(Math.round(t.buyTotalCents/t.quantity))}。</p>
      <section class="detail-section"><h3>买入核对与更正</h3><form id="editTrade"><div class="form-grid"><label>实际买入总额（元）<input name="total" type="number" min="0" step="0.01" value="${amount(t.buyTotalCents)}" required></label><label>实际购买数量<input name="quantity" type="number" min="1" step="1" value="${t.quantity}" required></label><label>买入时间<input name="boughtAt" type="datetime-local" step="1" value="${inputTime(t.boughtAt)}" required></label><label>实际收货时间<input name="deliveredAt" type="datetime-local" step="1" value="${inputTime(t.deliveredAt)}"></label><label>平台可交易时间<input name="tradableAt" type="datetime-local" step="1" value="${inputTime(t.tradableAt)}"></label><label>平台可上架时间<input name="marketableAt" type="datetime-local" step="1" value="${inputTime(t.marketableAt)}"></label><label class="span-2 check"><input name="confirmed" type="checkbox" ${t.confirmed?'checked':''}>已核对真实购买，可计入账本</label></div><div class="form-actions"><p>原成本 ${money(t.buyTotalCents)}。保存后会重算后续资金池成本；平台解锁时间请按实际库存信息填写。</p><button class="primary">保存核对 / 更正</button></div></form></section>
      <section class="detail-section"><h3>分批出售与实际到账</h3><div class="detail-scroll"><table><thead><tr><th>数量</th><th>净到账（元）</th><th>成交时间</th><th>实际到账时间</th><th>操作</th></tr></thead><tbody>${data.settlements.map(s=>`<tr data-sale-id="${s.id}"><td><input aria-label="更正售出数量" data-sale-field="quantity" type="number" min="1" step="1" value="${s.quantity}" ${s.voided?'disabled':''}>${s.voided?' · 已冲销':''}</td><td><input aria-label="更正净到账金额" data-sale-field="net" type="number" step="0.01" min="0" value="${amount(s.netTotalCents)}" ${s.voided?'disabled':''}></td><td><input aria-label="更正成交时间" data-sale-field="soldAt" type="datetime-local" step="1" value="${inputTime(s.soldAt)}" ${s.voided?'disabled':''}></td><td><input aria-label="补填实际到账时间" data-sale-field="receivedAt" type="datetime-local" step="1" value="${inputTime(s.receivedAt)}" ${s.voided?'disabled':''}></td><td>${s.voided?'':`<button data-amend-sale="${s.id}">保存到账</button> <button class="danger" data-void-sale="${s.id}">冲销</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">尚无出售回填</td></tr>'}</tbody></table></div></section>
      ${t.confirmed&&t.remainingQuantity?`<section class="detail-section"><h3>未售出物品退款</h3><form id="refundForm"><div class="form-grid"><label>退款数量<input name="quantity" type="number" min="1" max="${t.remainingQuantity}" value="1" required></label><label>实际退款到账总额（元）<input name="amount" type="number" min="0" step="0.01" required></label><label>到账时间<input name="occurredAt" type="datetime-local" step="1" value="${inputTime(Date.now())}" required></label><label>备注<input name="note"></label></div><div class="form-actions"><button>记录实际退款</button></div></form></section>`:''}
      <section class="detail-section"><h3>原始购买快照与更正历史</h3><details class="audit-item"><summary>买入时的报价与来源</summary><pre>${esc(JSON.stringify(t.snapshot,null,2))}</pre></details>${data.audit.map(a=>`<details class="audit-item"><summary>${date(a.createdAt)} · ${esc({purchase:'记录购买',amend_purchase:'购买更正',settlement:'手动出售回填',amend_settlement:'到账更正',void_settlement:'出售冲销',purchase_refund:'购买退款',confirmed_sale_sync:'已确认平台同步',confirmed_buy_sync:'已确认买入同步',linked_buy_history:'关联已有买入',linked_purchase_receipt:'关联自动购买回执'}[a.action] || a.action)}</summary><pre>${esc(JSON.stringify({before:a.beforeData,after:a.afterData},null,2))}</pre></details>`).join('')}</section>`,true);
    $('detailWindow').onchange=e=>detail(id,e.target.value).catch(errorDialog);
    const form=$('editTrade');form.onsubmit=e=>{e.preventDefault();action(form.querySelector('button'),async()=>{const f=new FormData(form);await write('/trades/'+id,'PATCH',{version:t.version,buyTotalCents:cents(f.get('total')),quantity:Number(f.get('quantity')),boughtAt:keepTime(f.get('boughtAt'),t.boughtAt),deliveredAt:keepTime(f.get('deliveredAt'),t.deliveredAt),tradableAt:keepTime(f.get('tradableAt'),t.tradableAt),marketableAt:keepTime(f.get('marketableAt'),t.marketableAt),confirmed:form.confirmed.checked});state.drafts.delete(id);await refresh();await detail(id,window);});};
    for(const b of $('dialogBody').querySelectorAll('[data-amend-sale],[data-void-sale]'))b.onclick=()=>action(b,async()=>{const sale=data.settlements.find(s=>s.id===(b.dataset.amendSale || b.dataset.voidSale)),tr=b.closest('tr');await write('/settlements/'+sale.id,'PATCH',{version:sale.version,quantity:Number(tr.querySelector('[data-sale-field=quantity]').value),netTotalCents:cents(tr.querySelector('[data-sale-field=net]').value),soldAt:keepTime(tr.querySelector('[data-sale-field=soldAt]').value,sale.soldAt),receivedAt:keepTime(tr.querySelector('[data-sale-field=receivedAt]').value,sale.receivedAt),...(b.dataset.voidSale?{voided:true}:{})});await refresh();await detail(id,window);});
    const refund=$('refundForm');if(refund){const requestKey=crypto.randomUUID();refund.onsubmit=e=>{e.preventDefault();action(refund.querySelector('button'),async()=>{const f=new FormData(refund);await write(`/trades/${id}/refunds`,'POST',{version:t.version,quantity:Number(f.get('quantity')),amountCents:cents(f.get('amount')),occurredAt:iso(f.get('occurredAt')),note:f.get('note'),requestKey});await refresh();await detail(id,window);});};}
  }
  async function walletDialog() {
    const entries=await api('/wallet-events');
    openDialog('Steam 余额与现金成本',`<div class="callout">填写已持有 Steam 余额的真实现金成本；不知道成本时留空，账本会标记待补全。非本账本支出会按当时平均成本扣减资金池。</div><form id="walletForm"><div class="form-grid"><label>类型<select name="kind"><option value="opening">期初余额</option><option value="funding">充值 / 外部收入</option><option value="spend">非本账本支出</option></select></label><label>发生时间<input name="occurredAt" type="datetime-local" step="1" value="${inputTime(Date.now())}" required></label><label>Steam 金额（元）<input name="amount" type="number" step="0.01" min="0.01" required></label><label>对应现金成本（元，可留空）<input name="cashCost" type="number" step="0.01" min="0"></label><label class="span-2">备注<input name="note"></label></div><div class="form-actions"><button class="primary">保存资金调整</button></div></form><section class="detail-section"><h3>资金来源与支出记录</h3><div class="detail-scroll"><table><thead><tr><th>时间 / 类型</th><th>Steam 金额（元）</th><th>现金成本（元）</th><th>操作</th></tr></thead><tbody>${entries.map(w=>`<tr data-wallet-id="${w.id}"><td>${date(w.occurredAt)}<div>${{opening:'期初余额',funding:'外部收入',spend:'外部支出'}[w.kind]}${w.voided?' · 已冲销':''}</div><span class="muted small">${esc(w.note)}</span></td><td><input data-wallet-field="amount" type="number" step="0.01" min="0.01" value="${amount(w.amountCents)}"></td><td><input data-wallet-field="cashCost" type="number" step="0.01" min="0" value="${amount(w.cashCostCents)}" placeholder="未知"></td><td>${w.voided?'':`<button data-edit-wallet="${w.id}">更正</button> <button data-void-wallet="${w.id}" class="danger">冲销</button>`}</td></tr>`).join('')||'<tr><td colspan="4">暂无资金调整</td></tr>'}</tbody></table></div></section>`,true);
    const form=$('walletForm'),requestKey=crypto.randomUUID();form.onsubmit=e=>{e.preventDefault();action(form.querySelector('button'),async()=>{const f=new FormData(form);await write('/wallet-events','POST',{kind:f.get('kind'),amountCents:cents(f.get('amount')),cashCostCents:f.get('cashCost')===''?null:cents(f.get('cashCost')),occurredAt:iso(f.get('occurredAt')),note:f.get('note'),requestKey});await refresh();await walletDialog();});};
    for(const b of $('dialogBody').querySelectorAll('[data-edit-wallet],[data-void-wallet]'))b.onclick=()=>action(b,async()=>{const id=b.dataset.editWallet||b.dataset.voidWallet,w=entries.find(x=>x.id===id),tr=b.closest('tr'),cost=tr.querySelector('[data-wallet-field=cashCost]').value;await write('/wallet-events/'+id,'PATCH',{version:w.version,amountCents:cents(tr.querySelector('[data-wallet-field=amount]').value),cashCostCents:cost===''?null:cents(cost),voided:!!b.dataset.voidWallet});await refresh();await walletDialog();});
  }
  async function purchase(seed) {
    const capabilities=await api('/capabilities');
    if(!['buff','steam'].includes(seed.platform) || !capabilities[seed.platform])throw new Error('购买平台无效，请重新打开商品设置');
    const label=seed.platform==='steam'?'Steam':'BUFF',reference=seed.platform==='steam'?seed.steamLowestSellCents:seed.buffPriceCents;
    openDialog(`${label} 自动买入现货`, `<p><strong>${esc(seed.name || seed.marketHashName)}</strong></p><p class="muted small">${esc(seed.marketHashName)} · ${seed.appid===570?'Dota 2':'CS2'}</p><div class="callout">${esc(capabilities[seed.platform].reason)}。按下方数量和限价逐件购买现货，允许部分成交。求购和卖出需要另外二次确认，不会由本任务执行。</div><form id="purchaseForm"><div class="form-grid"><label for="purchaseQuantity">购买数量（必填）<input id="purchaseQuantity" name="quantity" type="number" min="1" max="1000" step="1" autocomplete="off" placeholder="1—1000" required aria-describedby="purchaseBudget dialogError"></label><label for="purchaseLimit">最高含费单价（元，必填）<input id="purchaseLimit" name="limit" type="number" min="0.01" step="0.01" autocomplete="off" placeholder="请填写你接受的最高单价" required aria-describedby="purchaseBudget dialogError"></label></div><div class="callout" id="purchaseBudget" aria-live="polite"></div>${seed.platform==='buff'?'<p class="read-only-note">支付方式：仅使用 BUFF 可用资金，余额不足时暂停。只核对人民币（CNY）金额；如页面显示 US$，请先切回人民币。遇到验证可在原页面处理后继续核对。</p>':''}<p class="muted small">参考在售价 ${money(reference)} · 参考折扣 ${discount(seed.platform==='steam'?seed.cashoutRatio:seed.knifeRatio)} · 报价 ${date(seed.updatedAt)}。参考价不会自动作为限价；执行时重新读取当前价格，最终含费金额不得超过你填写的上限。</p><div class="form-actions"><button type="submit" class="primary">启动自动买入现货</button></div></form>`);
    // Reopening or reloading the same seeded form must resolve the same task.
    const form=$('purchaseForm'),requestKey=params.get('purchase')?`purchase:${params.get('purchase')}`:crypto.randomUUID();
    const quantityInput=form.elements.namedItem('quantity'),limitInput=form.elements.namedItem('limit');
    let submitted=false,request=null;
    const values=()=>{
      const quantity=Number(quantityInput.value),limit=cents(limitInput.value),total=quantity*limit;
      if(!Number.isSafeInteger(quantity)||quantity<1||quantity>1000)throw new Error('购买数量须为 1—1000 的整数');
      if(limit<1||!Number.isSafeInteger(total))throw new Error('最高含费单价或总预算无效');
      return {quantity,limit,total};
    };
    const update=()=>{
      let v;try{v=values();}catch{}
      $('purchaseBudget').textContent=v?`最多 ${v.quantity} 件 · 最高总支出 ${money(v.total)} · 仅购买限价以内的现货`:'请填写购买数量和最高含费单价，以核对总预算';
      form.querySelector('button').textContent=v?`${request?'核对 / 重试本次购买':'启动自动买入现货'} · ${v.quantity} 件 · 上限 ${money(v.total)}`:'启动自动买入现货';
    };
    form.oninput=()=>{$('dialogError').textContent='';update();};update();
    form.onsubmit=e=>{e.preventDefault();if(submitted || !form.reportValidity())return;action(form.querySelector('button'),async()=>{
      if(!state.online)throw new Error('数据库离线，暂停新的购买');
      const v=values();submitted=true;
      request ||= {...seed,...(seed.platform==='buff'?{paymentMethod:'buff_balance'}:{}),quantity:v.quantity,maxUnitPriceCents:v.limit,requestKey,snapshot:seed};
      quantityInput.readOnly=true;limitInput.readOnly=true;
      try {await send({type:'LEDGER_PURCHASE_START',purchase:request});}
      catch(error){submitted=false;update();throw new Error(`${error.message}。本次参数已保留；重试将核对同一任务，请勿另开购买任务。`);}
      $('dialog').close();switchDirection('tasks');
    });};
  }
  function syncShell() {
    openDialog('同步卖出记录 · 核对后再入账',`<div class="callout">BUFF 卖出对应提现；Steam 卖出对应挂刀。拉取及预览不会修改账本。核对购买批次、数量、实际净到账及到账时间后，再点击底部确认按钮。</div><div class="sync-toolbar"><button id="collectBoth" class="primary">一键拉取两平台</button><button data-history="buff">打开 BUFF 卖出记录 ↗</button><button data-history="steam">打开 Steam 市场历史 ↗</button></div><p id="syncNotices" class="read-only-note"></p><details class="sync-import"><summary>粘贴或导入平台记录 JSON（读取失败时可用）</summary><p>每条记录包含 platform、sourceId、name / marketHashName、quantity、soldAt、receivedAt、netTotalCents（整数分）。金额或时间不明时可留空，在核对表中填写。</p><textarea id="syncJson" aria-label="平台卖出记录 JSON" placeholder='[{"platform":"steam","sourceId":"订单号","marketHashName":"Recoil Case","name":"反冲武器箱","quantity":1,"netTotalCents":188}]'></textarea><input id="syncFile" type="file" accept=".json,application/json"><button id="previewJson">生成核对表</button></details><div id="syncPreview"></div><div class="form-actions"><p id="syncSelection">尚未拉取记录</p><button id="confirmSync" class="primary" disabled>确认所选记录并入账</button></div>`,true);
    $('collectBoth').onclick=()=>action($('collectBoth'),async()=>{const result=await send({type:'LEDGER_COLLECT_SALES',platform:'all'});$('syncNotices').textContent=result.notices.join('；');await prepareSync(result.records);});
    for(const b of $('dialogBody').querySelectorAll('[data-history]'))b.onclick=()=>send({type:'LEDGER_OPEN_HISTORY',platform:b.dataset.history}).catch(errorDialog);
    $('previewJson').onclick=()=>action($('previewJson'),async()=>{let records;try{records=JSON.parse($('syncJson').value);}catch{throw new Error('JSON 无法解析，请检查格式');}await prepareSync(records);});
    $('syncFile').onchange=async e=>{const file=e.target.files[0];if(!file)return;if(file.size>2*1024*1024)return errorDialog(new Error('文件不能超过 2 MB'));$('syncJson').value=await file.text();};
    $('confirmSync').onclick=()=>action($('confirmSync'),confirmSync);
  }
  async function prepareSync(records) {
    const [preview,holdings]=await Promise.all([api('/sync/preview','POST',{records}),api('/holdings')]);state.holdings=holdings;
    state.syncRows=preview.rows.map(r=>({...r,selected:!!r.tradeId&&!r.duplicate,allocations:[{tradeId:r.tradeId,version:r.version,quantity:r.quantity,netTotal:amount(r.netTotalCents),soldAt:inputTime(r.soldAt),receivedAt:inputTime(r.receivedAt)}]}));renderSync();
  }
  function syncOptions(row,a) {
    const list=[...row.candidates];for(const t of state.holdings)if(t.direction===(row.source.platform==='steam'?'knife':'cashout')&&!list.some(c=>c.id===t.id))list.push({...t,score:0,existingSettlements:[]});
    let html='<option value="">选择对应的购买记录</option>';
    for(const t of list){if(t.remainingQuantity)html+=`<option value="${t.id}" ${a.tradeId===t.id&&!a.existingSettlementId?'selected':''}>${esc(t.name)} · ${date(t.boughtAt)} · 余 ${t.remainingQuantity}${t.score?' · 名称/ID匹配':''}</option>`;
      for(const s of t.existingSettlements || [])html+=`<option value="sale:${s.id}" ${a.existingSettlementId===s.id?'selected':''}>合并已手填：${esc(t.name)} · ${s.quantity} 件 · ${money(s.netTotalCents)}</option>`;}
    return html;
  }
  function renderSync() {
    $('syncPreview').innerHTML=state.syncRows.length?`<div class="sync-table-wrap"><table class="sync-table"><thead><tr><th>确认</th><th>平台原始记录</th><th>对应购买批次 / 已回填记录</th><th>售出数量</th><th>实际净到账总额（元）</th><th>成交时间 / 实际到账时间</th><th>匹配说明</th></tr></thead><tbody>${state.syncRows.map((r,i)=>`<tr data-sync-index="${i}" data-duplicate="${r.duplicate}"><td><input type="checkbox" aria-label="选择本条卖出记录" data-sync-select ${r.selected?'checked':''} ${r.duplicate?'disabled':''}></td><td><strong class="source-name">${esc(r.source.name || r.source.marketHashName)}</strong><div class="small muted">${r.source.platform.toUpperCase()} · ${esc(r.source.sourceId || '按原始记录去重')}</div><div class="raw-source">${esc(r.source.dateLabel || '')} · 页面净到账 ${money(r.source.netTotalCents)}${r.source.grossTotalCents!=null?` · 成交价 ${money(r.source.grossTotalCents)}`:''}</div><details class="raw-source"><summary>原始行</summary>${esc(r.source.rawText || r.source.note || '')}</details></td>
      <td>${r.allocations.map((a,j)=>`<div class="allocation" data-allocation="${j}"><select aria-label="匹配购买记录" data-sync-field="match">${syncOptions(r,a)}</select></div>`).join('')}<button class="small" data-split-sync="${i}" ${r.duplicate?'disabled':''}>＋ 分配到另一批次</button></td>
      <td>${r.allocations.map((a,j)=>`<div class="allocation" data-allocation="${j}"><input aria-label="同步售出数量" type="number" min="1" step="1" data-sync-field="quantity" value="${esc(a.quantity)}"></div>`).join('')}</td><td>${r.allocations.map((a,j)=>`<div class="allocation" data-allocation="${j}"><input aria-label="同步实际净到账" type="number" min="0" step="0.01" data-sync-field="netTotal" value="${esc(a.netTotal)}" placeholder="必须核对"></div>`).join('')}</td>
      <td>${r.allocations.map((a,j)=>`<div class="allocation" data-allocation="${j}"><input aria-label="同步成交时间" type="datetime-local" step="1" data-sync-field="soldAt" value="${esc(a.soldAt)}"><input aria-label="同步实际到账时间" type="datetime-local" step="1" data-sync-field="receivedAt" value="${esc(a.receivedAt)}"></div>`).join('')}</td><td class="raw-source">${esc({already_imported:'已同步，自动跳过',possible_duplicate:'可能已手动回填：请选择“合并已手填”避免重复计入',matched:'找到唯一匹配，仍需确认到账',review_match:'存在多个可能匹配，请人工选择',unmatched:'未找到精确匹配，可补录购买后重新预览'}[r.status])}<p>${esc(r.note)}</p></td></tr>`).join('')}</tbody></table></div>`:'<div class="chart-empty">未读取到卖出记录。请打开历史页并加载记录，再次拉取。</div>';
    syncCount();
  }
  function syncCount(){const rows=state.syncRows.filter(r=>r.selected&&!r.duplicate);const total=p=>rows.filter(r=>r.source.platform===p).flatMap(r=>r.allocations).reduce((sum,a)=>{try{return sum+cents(a.netTotal);}catch{return sum;}},0);$('syncSelection').textContent=`已选 ${rows.length} 条 · BUFF 现金 ${money(total('buff'))} · Steam 余额 ${money(total('steam'))}`;$('confirmSync').disabled=!rows.length;}
  async function confirmSync() {
    const rows=state.syncRows.filter(r=>r.selected&&!r.duplicate).map(r=>({source:r.source,confirmed:true,allocations:r.allocations.map(a=>{
      if(!a.tradeId || !a.soldAt || !a.receivedAt)throw new Error('请为所有选中记录选择购买批次，并补齐实际成交和到账时间');
      return {...a,quantity:Number(a.quantity),netTotalCents:cents(a.netTotal),soldAt:iso(a.soldAt),receivedAt:iso(a.receivedAt)};
    })}));
    const result=await write('/sync/confirm','POST',{rows});await refresh();$('dialog').close();notice(`已确认并保存 ${result.count} 笔出售回填，跳过 ${result.skipped.length} 条已同步记录。`);
  }
  function switchDirection(direction) {
    state.direction=direction;state.page=1;for(const b of document.querySelectorAll('[data-direction]'))b.setAttribute('aria-selected',String(b.dataset.direction===direction));
    const tasks=direction==='tasks';$('tasks').hidden=!tasks;document.querySelector('.ledger-table-wrap').hidden=tasks;$('filters').hidden=tasks;
    $('directionHint').textContent=tasks?'逐笔购买现货，按数据库确认的回执计入账本。等待人工处理时打开平台完成验证，再继续核对；结果未明的订单不会重新提交。':direction==='knife'?'BUFF 买入 → Steam 卖出。填写实际 Steam 净到账并确认到账后，该售出部分才完成挂刀。':'Steam 买入 → BUFF 卖出。填写实际 BUFF 净到账并确认到账后，该售出部分才完成提现。';refresh();
  }
  $('dialogClose').onclick=()=>$('dialog').close();$('refresh').onclick=()=>refresh();$('openFull').onclick=()=>chrome.tabs.create({url:chrome.runtime.getURL('ledger.html')});
  $('manualButton').onclick=()=>manual();$('walletButton').onclick=()=>walletDialog().catch(errorDialog);$('syncButton').onclick=syncShell;
  $('buySyncButton').onclick=()=>self.BuffBuySyncUI.open({send,api,write,openDialog,errorDialog,refresh,notice,esc,money,amount,inputTime,iso,cents});
  $('pollPrices').onclick=()=>action($('pollPrices'),async()=>{const r=await send({type:'LEDGER_POLL_PRICES'});await refresh();notice(r.deferred?'采价正在退避，将自动重试':`已更新 ${r.count} 个持仓物品的 Steam 报价。${r.buff}`);});
  for(const b of document.querySelectorAll('[data-direction]'))b.onclick=()=>switchDirection(b.dataset.direction);
  for(const id of ['game','tradeStatus','dateFrom','dateTo','chartDays'])$(id).onchange=()=>{state.page=1;refresh();};
  let searchTimer;$('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.page=1;refresh();},250);};
  $('targetRatio').onchange=()=>{if(!$('targetRatio').checkValidity()||$('targetRatio').value==='')return;chrome.storage.local.set({ledgerTargetRatio:$('targetRatio').value});refresh();};
  $('prevPage').onclick=()=>{state.page=Math.max(1,state.page-1);refresh();};$('nextPage').onclick=()=>{state.page++;refresh();};
  $('tradeRows').addEventListener('input',event=>{const el=event.target,tr=el.closest('[data-trade-id]');if(!tr||!el.dataset.field)return;const d=state.drafts.get(tr.dataset.tradeId);d[el.dataset.field]=el.type==='checkbox'?el.checked:el.value;d.dirty=true;
    const q=Number(d.quantity);if(q>0){if(el.dataset.field==='unit'||el.dataset.field==='quantity'&&d.mode==='unit'){d.mode='unit';if(d.unit!=='')d.netTotal=(Math.round(Number(d.unit)*100*q)/100).toFixed(2);}else if(el.dataset.field==='netTotal'||el.dataset.field==='quantity'){d.mode='total';if(d.netTotal!=='')d.unit=(Number(d.netTotal)/q).toFixed(4);}}
    tr.querySelector('[data-field=unit]').value=d.unit;tr.querySelector('[data-field=netTotal]').value=d.netTotal;tr.querySelector('[data-row-preview]').textContent=d.netTotal===''?'请填写实际到账':`${d.quantity} 件 · 合计 ${money(Math.round(Number(d.netTotal)*100))}`;tr.querySelector('[data-settle]').textContent=d.received?'确认到账':'保存待到账';});
  $('tradeRows').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.detail)detail(b.dataset.detail).catch(errorDialog);if(b.dataset.settle)action(b,()=>settle(b.dataset.settle,b));});
  $('tasks').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.taskReview)action(b,()=>reviewTask(b.dataset.taskReview));else if(b.dataset.taskAction)action(b,async()=>{await send({type:'LEDGER_PURCHASE_'+b.dataset.taskAction,id:b.dataset.taskId});await refresh();});});
  $('dialogBody').addEventListener('input',e=>{const tr=e.target.closest('[data-sync-index]');if(!tr)return;const r=state.syncRows[Number(tr.dataset.syncIndex)];if(e.target.hasAttribute('data-sync-select'))r.selected=e.target.checked;
    else if(e.target.dataset.syncField){const a=r.allocations[Number(e.target.closest('[data-allocation]').dataset.allocation)],field=e.target.dataset.syncField;
      if(field==='match'){const selected=e.target.value;if(selected.startsWith('sale:')){const s=r.existing.find(x=>x.id===selected.slice(5));a.tradeId=s.tradeId;a.existingSettlementId=s.id;a.settlementVersion=s.version;a.version=r.candidates.find(x=>x.id===s.tradeId).version;}else{a.tradeId=selected;const t=r.candidates.find(x=>x.id===selected)||state.holdings.find(x=>x.id===selected);a.version=t?.version;delete a.existingSettlementId;delete a.settlementVersion;}}
      else a[field]=e.target.value;}
    syncCount();});
  $('dialogBody').addEventListener('click',e=>{const b=e.target.closest('[data-split-sync]');if(!b)return;const r=state.syncRows[Number(b.dataset.splitSync)];r.allocations.push({tradeId:'',quantity:1,netTotal:'',soldAt:r.allocations[0].soldAt,receivedAt:r.allocations[0].receivedAt});renderSync();});
  async function init() {
    if(globalThis.chrome?.storage){const saved=await chrome.storage.local.get(['ledgerViewCache','ledgerTargetRatio']);state.cache=saved.ledgerViewCache || {};if(saved.ledgerTargetRatio)$('targetRatio').value=saved.ledgerTargetRatio;}
    switchDirection('knife');
    const seedId=params.get('purchase') || params.get('record');if(seedId){const seed=await send({type:'LEDGER_SEED',id:seedId});if(seed){await refresh();params.has('record')?manual(seed):await purchase(seed);}}
    let timer;chrome.storage.onChanged.addListener(changes=>{if(!changes.ledgerChangedAt)return;clearTimeout(timer);timer=setTimeout(()=>{if($('dialog').open||[...state.drafts.values()].some(d=>d.dirty)){notice('账本有更新；你当前的输入已保留，可点击刷新核对。');return;}refresh();},500);});
  }
  init().catch(error=>{online(false);notice(error.message);});
})();
