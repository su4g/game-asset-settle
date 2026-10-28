/* Purchase-history review stays in this dialog until the user selects and confirms rows. */
(() => {
  'use strict';
  self.BuffBuySyncUI = {open};
  function open({send,api,write,openDialog,errorDialog,refresh,notice,esc,money,amount,inputTime,iso,cents}) {
    openDialog('同步 BUFF 买入 · 勾选确认后入账',`
      <p class="callout">读取购买历史后，请逐条核对并勾选。确认后计入 <strong>BUFF 挂刀买入</strong>；实际 Steam 卖出到账仍需另行回填或同步。</p>
      <form id="buySyncForm" novalidate>
        <fieldset id="buySyncFields" class="buy-sync-fields">
          <div class="sync-toolbar buy-sync-toolbar"><label>游戏 <select id="buySyncGame" aria-label="买入记录游戏"><option value="730">CS2</option><option value="570">Dota 2</option></select></label><button type="button" id="readBuys">重新读取当前页</button><button type="button" id="openBuyHistory">打开 BUFF 购买记录 ↗</button></div>
          <p class="muted small">只读取已加载的一页；可在 BUFF 翻页后重新读取。重新读取会清除本列表未保存的编辑。金额为人民币含费实付总额，所有时间按北京时间填写。</p>
          <p id="buySyncNotice" role="status" aria-live="polite"></p>
          <div id="buySyncPreview" aria-busy="false"></div>
        </fieldset>
        <div class="form-actions buy-sync-actions"><span id="buySyncSelection" role="status" aria-live="polite">尚未选择记录</span><button type="submit" id="confirmBuys" class="primary" disabled>勾选记录后确认入账</button></div>
      </form>`,true);
    const form=document.getElementById('buySyncForm'),dialog=document.getElementById('dialog');
    const $=id=>form.querySelector('#'+id);
    const live=()=>form.isConnected&&dialog.open;
    let rows=[],busy=false,loadId=0;
    const field=(row,key)=>row.querySelector(`[data-buy-field="${key}"]`);
    const selected=()=>[...form.querySelectorAll('tr[data-buy-index]')].filter(tr=>tr.querySelector('[data-buy-select]').checked);
    function setBusy(value) {
      busy=value;$('buySyncFields').disabled=value;$('buySyncPreview').setAttribute('aria-busy',String(value));count();
    }
    function count() {
      const picked=selected();let total=0,quantity=0,complete=true;
      for(const tr of picked) {
        try {total+=cents(field(tr,'total').value);}catch{complete=false;}
        const q=Number(field(tr,'quantity').value);if(Number.isSafeInteger(q)&&q>0)quantity+=q;else complete=false;
      }
      if(!Number.isSafeInteger(total))complete=false;
      $('buySyncSelection').textContent=`已选 ${picked.length} / ${rows.length} 条 · ${quantity} 件 · 本次核对实付 ${complete?money(total):'待补全'}（关联已有记录不重复增加成本）`;
      $('confirmBuys').disabled=busy||!picked.length;
      $('confirmBuys').textContent=busy?'处理中…':picked.length?`确认 ${picked.length} 条并计入挂刀买入`:'勾选记录后确认入账';
      const all=$('selectAllBuys');
      if(all){const available=rows.filter(r=>!r.disabled).length;all.checked=available>0&&picked.length===available;all.indeterminate=picked.length>0&&picked.length<available;}
    }
    function render() {
      const statuses={review:'待勾选确认',duplicate:'已入账 / 重复',blocked:'不可计入买入',identity_conflict:'订单规格待核对',order_conflict:'订单数量待核对',possible_duplicate:'存在相似买入'};
      const input=(key,label,value,extra='')=>`<input data-buy-field="${key}" aria-label="${label}" value="${esc(value??'')}" ${extra}>`;
      $('buySyncPreview').innerHTML=rows.length?`<div class="sync-table-wrap buy-sync-wrap" tabindex="0" aria-label="买入记录核对表，可横向滚动"><table class="buy-sync-table"><thead><tr>
        <th scope="col"><input type="checkbox" id="selectAllBuys" aria-label="选择所有可导入买入记录" ${rows.every(r=>r.disabled)?'disabled':''}></th><th scope="col">物品 / 完整规格</th><th scope="col">订单号 / 来源</th><th scope="col">购买数量</th><th scope="col">实际支付总额（元）</th><th scope="col">买入 / 收货时间</th><th scope="col">核对结果</th>
        </tr></thead><tbody>${rows.map((r,i)=>{
          const a=r.reviewed,off=r.disabled?'disabled':'';
          return `<tr data-buy-index="${i}" class="${r.disabled?'buy-sync-disabled':''}"><td><input type="checkbox" data-buy-select aria-label="选择买入记录 ${i+1}：${esc(a.name)}" ${off}></td>
            <td><strong class="source-name">${esc(a.name||'名称待补全')}</strong><div class="small muted">${a.appid===570?'Dota 2':'CS2'} · 商品 ${esc(a.goodsId||'—')}</div><label class="buy-sync-label">完整 Steam 名称${input('marketHashName','完整 Steam 物品名称',a.marketHashName,`${off} ${r.source.marketHashName?'readonly':''} placeholder="需含磨损 / 暗金等完整规格" maxlength="500"`)}</label>${!a.name?input('name','物品名称','',`${off} placeholder="完整物品名称" maxlength="500"`):''}</td>
            <td>${input('orderId','真实 BUFF 购买订单号',a.orderId,`${off} ${r.source.orderId?'readonly':''} placeholder="填写真实购买订单号" maxlength="200"`)}<div class="small muted">账号：${esc(r.source.platformAccountId||'未识别，请核对本人订单')}</div><details class="raw-source"><summary>查看原始记录</summary><p>${esc(r.source.rawText||'未提供原始行文本')}</p><p>${esc(r.source.note||'')}</p></details></td>
            <td>${input('quantity','实际买入数量',a.quantity,`${off} type="number" min="1" max="1000000" step="1" inputmode="numeric"`)}</td>
            <td>${input('total','含费实际支付总额',amount(a.buyTotalCents),`${off} type="number" min="0" step="0.01" inputmode="decimal" placeholder="核对实付总额"`)}<div class="small muted">页面实付 ${money(r.source.buyTotalCents)}<br>已含买方费用</div></td>
            <td><label class="buy-sync-label">买入时间${input('boughtAt','实际买入时间',inputTime(a.boughtAt),`${off} type="datetime-local" step="1"`)}</label><label class="buy-sync-label">实际收货时间（可留空）${input('deliveredAt','实际收货时间',inputTime(a.deliveredAt),`${off} type="datetime-local" step="1"`)}</label></td>
            <td><strong>${statuses[r.status]}</strong><div class="small muted">平台：${esc(r.source.status||'未识别，请核对已付款')}</div><p class="raw-source">${esc(r.note)}</p>${!r.disabled&&r.candidates.length?`<select data-buy-field="decision" aria-label="处理相似买入记录"><option value="">请选择关联或新增</option>${r.candidates.map(c=>`<option value="${esc(c.id)}">关联已有：${esc(c.name)} · ${c.quantity} 件 · ${money(c.buyTotalCents)} · ${esc(inputTime(c.boughtAt).replace('T',' '))}</option>`).join('')}<option value="new">确认是另一笔订单，新增</option></select>`:''}</td></tr>`;
        }).join('')}</tbody></table></div>`:'<div class="chart-empty">当前页未读取到买入记录。请打开 BUFF 购买历史并加载列表，再重新读取。</div>';
      const all=$('selectAllBuys');if(all)all.onchange=()=>{for(const box of form.querySelectorAll('[data-buy-select]:not(:disabled)'))box.checked=all.checked;count();};
      count();
    }
    async function read() {
      if(busy)return;const request=++loadId;rows=[];$('buySyncPreview').replaceChildren();setBusy(true);
      document.getElementById('dialogError').textContent='';$('buySyncNotice').textContent='正在读取 BUFF 购买历史，尚未写入账本…';
      try {
        const result=await send({type:'LEDGER_COLLECT_BUYS',appid:Number($('buySyncGame').value)});
        if(!live()||request!==loadId)return;
        const preview=await api('/sync/buys/preview','POST',{records:result.records});
        if(!live()||request!==loadId)return;
        rows=preview.rows;$('buySyncNotice').textContent=(result.notices||[]).join(' ')||`读取 ${rows.length} 条记录，尚未入账。`;
        render();
      } catch(error) {if(live()&&request===loadId){$('buySyncNotice').textContent='读取未完成，未写入账本。';errorDialog(error);}}
      finally{if(live()&&request===loadId)setBusy(false);}
    }
    function checkedRows() {
      return selected().map(tr=>{
        const row=rows[Number(tr.dataset.buyIndex)];
        const required=(key,message)=>{const el=field(tr,key);if(!el?.value.trim()||!el.checkValidity()){el?.focus();throw new Error(message);}return el.value.trim();};
        const quantity=Number(required('quantity','请填写选中记录的正整数购买数量'));
        if(!Number.isSafeInteger(quantity)||quantity<1||quantity>1000000)throw new Error('购买数量须为 1～1000000 的整数');
        const buyTotalCents=cents(required('total','请核对选中记录的人民币含费实际支付总额'));
        const marketHashName=required('marketHashName','请补齐选中物品的完整 Steam 名称（含磨损、暗金等规格）');
        const orderId=required('orderId','请填写选中记录的真实 BUFF 购买订单号');
        const boughtAt=iso(required('boughtAt','请填写选中记录的实际买入时间'));
        const deliveredAt=iso(field(tr,'deliveredAt').value);
        if(deliveredAt&&new Date(deliveredAt)<new Date(boughtAt))throw new Error('实际收货时间不能早于买入时间');
        const decision=field(tr,'decision')?.value||'';
        if(row.candidates.length&&!decision){field(tr,'decision').focus();throw new Error('存在相似买入，请选择关联已有记录，或明确确认是另一笔订单');}
        const candidate=row.candidates.find(c=>c.id===decision);
        return {source:row.source,confirmed:true,reviewed:{...row.reviewed,name:field(tr,'name')?.value.trim()||row.reviewed.name,marketHashName,orderId,quantity,buyTotalCents,boughtAt,deliveredAt},
          ...(candidate?{existingTradeId:candidate.id,version:candidate.version}:{decision:decision==='new'?'new':undefined})};
      });
    }
    form.addEventListener('input',count);
    form.addEventListener('change',count);
    $('readBuys').onclick=read;$('buySyncGame').onchange=read;
    $('openBuyHistory').onclick=async()=>{try{await send({type:'LEDGER_OPEN_BUY_HISTORY',appid:Number($('buySyncGame').value)});}catch(error){if(live())errorDialog(error);}};
    form.onsubmit=async e=>{
      e.preventDefault();if(busy)return;
      try {
        const entries=checkedRows();if(!entries.length)throw new Error('请手动勾选需要入账的买入记录');
        document.getElementById('dialogError').textContent='';setBusy(true);
        const result=await write('/sync/buys/confirm','POST',{rows:entries});
        if(live())dialog.close();
        await refresh();notice(`BUFF 买入已确认：新增 ${result.count} 条，关联已有 ${result.linkedCount} 条，跳过重复 ${result.skipped.length} 条。挂刀完成仍以 Steam 实际卖出到账为准。`);
      }catch(error){if(live())errorDialog(error);else notice(error.message);}
      finally{if(live())setBusy(false);}
    };
    read();
  }
})();
