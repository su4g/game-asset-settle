"use strict";
(() => {
  const $ = id => document.getElementById(id), api = (action,payload) => window.buffDesktop.request(action,payload);
  const node = (tag,text,cls) => { const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n; };
  const money=(n,c)=>n==null?"待核对":window.BuffHelperCommon.formatCents(n,c||"CNY");
  const date=value=>new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});
  const platform=p=>({buff:"BUFF",uu:"悠悠",steam:"Steam"})[p]||p;
  const stateLabel={held:"尚无已确认出售",sold:"已出售",reused:"投入后续炼金",removed:"库存消耗 / 移出",ambiguous:"去向待核对","cost-pending":"成本待核对","proceeds-pending":"净到账待确认"};
  let sequence=0,page=1,busy=false,syncing=false,activeProfileId=null,reloadTimer;
  function error(message=""){$("alchemyError").textContent=message;$("alchemyError").hidden=!message;}
  function lock(){ $("alchemySync").disabled=busy||syncing;$("alchemyStop").disabled=!syncing;$("alchemyMode").disabled=busy||syncing;$("alchemyProgress").hidden=!syncing; }
  function status(s){syncing=s.job?.status==="running";activeProfileId=s.profileId||activeProfileId;lock();$("alchemySyncStatus").textContent=s.job?.kind==="inventory"?s.job.message||"准备读取库存历史":syncing?"Steam 订单正在同步，完成后可读取库存历史。":"复用本机 Steam 登录；读取过程中可以停止，已核对的分页保留。";}
  function metric(label,value,note){const c=node("div",null,"metric");c.append(node("span",label,"metric-label"),node("strong",value),node("small",note));return c;}
  function costLabel(cost,currency){if(!currency)return "币种 / 成本待核对";if(cost.cash==null&&cost.steam==null)return "成本待核对";if(cost.cash===0)return `${money(cost.steam,currency)} · Steam 余额`;if(cost.steam===0)return `${money(cost.cash,currency)} · 现金`;return `${money(cost.cash,currency)} 现金 + ${money(cost.steam,currency)} Steam 余额`;}
  function details(row){const d=node("details");d.dataset.alchemyId=row.id;const summary=node("summary",`${row.inputs.reduce((n,i)=>n+i.quantity,0)} 件 → 1 件`);d.append(summary);
    const content=node("div",null,"alchemy-recipe"),title=node("strong","实际投入");content.append(node("p",`材料合计：${costLabel(row.cost,row.currencyCode)}`),node("p",`可追溯现金成本：${money(row.cost.basis,row.currencyCode)}`,"small muted"),title);
    for(const i of row.inputs){const block=node("div",null,"alchemy-ingredient");block.append(node("p",`${i.quantity} × ${i.name||i.marketHashName}`),node("small",costLabel(i.cost,row.currencyCode)));
      if(i.reason)block.append(node("p",i.reason,"small muted"));
      if(i.parentCraftIds.length)block.append(node("p","成本由此前已完成炼金结转。","small muted"));
      if(i.sources.length){const sources=node("details"),label=node("summary",`平均成本来源 · ${i.sources.length} 笔买入`);sources.append(label);const list=node("ul");for(const s of i.sources){list.append(node("li",`${platform(s.platform)} · ${date(s.tradedAt)} · ${s.quantity} 件 / ${money(s.totalCents,s.currencyCode)} · 订单 ${s.orderId||"CSV"}`));}sources.append(list);block.append(sources);}content.append(block);}
    content.append(node("strong","实际产出"),node("p",row.output.name||row.output.marketHashName));
    if(row.sale)content.append(node("p",`${platform(row.sale.platform)} · ${date(row.sale.tradedAt)} · 净到账 ${money(row.sale.netCents,row.sale.currencyCode)} · 订单 ${row.sale.orderId||"CSV"}`));
    if(row.reasons.length){const list=node("ul",null,"small muted");[...new Set(row.reasons)].forEach(reason=>list.append(node("li",reason)));content.append(list);}d.append(content);return d;
  }
  function render(data){
    const s=data.summary,cards=[metric("已完成炼金",String(s.craftCount),"Steam 真实合成事件"),metric("已确认出售",String(s.soldCount),"含净到账待确认" )];
    if(!s.currencies.length){cards.push(metric("现金已实现收益","—","尚无可核对结果"),metric("Steam 余额盈亏","—","余额与现金分别核算"));}
    for(const c of s.currencies){cards.push(metric(`${c.currencyCode} 现金收益 · 已核对`,c.cashCount?money(c.cashProfitCents,c.currencyCode):"—",`${c.cashCount} 次可计算的现金出售`),metric(`${c.currencyCode} 余额盈亏 · 已核对`,c.steamCount?money(c.steamProfitCents,c.currencyCode):"—",`${c.steamCount} 次纯余额买入与卖出`));}
    $("alchemyMetrics").replaceChildren(...cards);
    $("alchemyCoverage").textContent=data.archives.length?data.archives.map(a=>`${a.coverage.complete?"已读至平台末页 / 已知边界":"历史尚未读完，可继续读取"} · ${a.coverage.eventCount} 条库存事件 · ${a.craftCount} 次炼金 · ${date(a.coverage.syncedAt)}`).join("；"):"尚未同步库存历史；需要先在 Steam 订单页完成登录与购买历史同步。";
    const expanded=new Set([...$("alchemyRows").querySelectorAll("details[data-alchemy-id][open]")].map(d=>d.dataset.alchemyId));
    $("alchemyRows").replaceChildren(...data.rows.map(r=>{const tr=node("tr"),head=node("th");head.scope="row";head.append(node("small",date(r.at),"muted"),node("div",r.output.name||r.output.marketHashName));const cost=node("td",costLabel(r.cost,r.currencyCode)),state=node("td",stateLabel[r.state]||r.state),profit=node("td"),detail=node("td");
      if(r.cashProfitCents!=null)profit.append(node("strong",money(r.cashProfitCents,r.currencyCode)),node("small","现金","muted"));
      else if(r.steamProfitCents!=null)profit.append(node("strong",money(r.steamProfitCents,r.currencyCode)),node("small","Steam 余额","muted"));
      else profit.append(node("span",r.sale?"收益待核对":"尚未实现"));const recipe=details(r);recipe.open=expanded.has(r.id);detail.append(recipe);tr.append(head,cost,state,profit,detail);return tr;}));
    $("alchemyEmpty").hidden=data.total!==0;$("alchemyPageInfo").textContent=`${data.total} 次炼金 · 第 ${data.page} / ${Math.max(1,Math.ceil(data.total/data.pageSize))} 页`;
    $("alchemyPrevious").disabled=page<=1;$("alchemyNext").disabled=page*data.pageSize>=data.total;
  }
  async function refresh(){const run=++sequence;try{const [data,s]=await Promise.all([api("alchemy:load",{page,search:$("alchemySearch").value.trim(),dateFrom:$("alchemyFrom").value,dateTo:$("alchemyTo").value}),api("steam:status")]);if(run!==sequence)return;error();status(s);render(data);}catch(e){if(run===sequence)error(e.message);}}
  async function action(fn){const run=sequence;busy=true;lock();error();try{const s=await fn();if(run===sequence)status(s);}catch(e){if(run===sequence)error(e.message);}finally{busy=false;lock();}}
  $("alchemySync").onclick=()=>action(()=>api("steam:inventory",{mode:$("alchemyMode").value}));
  $("alchemyStop").onclick=()=>action(()=>api("steam:stop"));
  $("alchemyFilters").onsubmit=e=>{e.preventDefault();page=1;void refresh();};
  $("alchemyReset").onclick=()=>{$("alchemyFrom").value="";$("alchemyTo").value="";$("alchemySearch").value="";page=1;void refresh();};
  $("alchemyPrevious").onclick=()=>{page--;void refresh();};$("alchemyNext").onclick=()=>{page++;void refresh();};
  window.buffDesktop.onChange(event=>{
    if(["account-profiles","connection"].includes(event.kind)){sequence++;page=1;activeProfileId=null;syncing=false;lock();$("alchemyRows").replaceChildren();$("alchemyMetrics").replaceChildren();$("alchemyCoverage").textContent="正在读取当前账户…";$("alchemySyncStatus").textContent="正在切换账户…";clearTimeout(reloadTimer);reloadTimer=setTimeout(refresh,0);return;}
    if(event.profileId&&event.profileId!==activeProfileId)return;
    if(event.kind==="steam-orders"){status(event.value);if(event.value.job?.status==="running")return;}
    if(["buff-orders","uu-orders"].includes(event.kind)&&event.value?.job?.status==="running")return;
    if(["steam-orders","buff-orders","uu-orders","history","order-ledger"].includes(event.kind)){clearTimeout(reloadTimer);reloadTimer=setTimeout(refresh,300);}
  });
  // Lazy load: navigation requests the selected account only.
  window.BuffAlchemyWorkspace={refresh};
})();
