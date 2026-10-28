/* BUFF buy-history DOM adapter. Reading and previewing never creates a purchase. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.BuffBuyHistory=api;})(typeof self==='undefined'?null:self,()=>{
  'use strict';
  const clean=s=>String(s??'').replace(/\s+/g,' ').trim();
  const blockedStatus=s=>/取消|撤销|交易关闭|交易失败|支付失败|未支付|未付款|等待付款|等待支付|待付款|待支付|支付中|付款中|退款|求购中|Cancelled|Unpaid|Refund/i.test(s);
  function cents(value) {
    const text=clean(value);
    if(/\d,/.test(text)&&!/(?:[¥￥]|CNY|人民币)\s*\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?(?![\d.,])/.test(text))return null;
    const s=text.replaceAll(',','');
    if(/[$€£]|USD|HKD|EUR|USDT/i.test(s))return null;
    const values=[...s.matchAll(/(?:[¥￥]|CNY|人民币)\s*(\d+)(?:\.(\d{1,2}))?(?![.\d])/g)].map(m=>Number(m[1])*100+Number((m[2]||'').padEnd(2,'0')));
    return values.length===1&&Number.isSafeInteger(values[0])?values[0]:null;
  }
  function time(value) {
    const m=clean(value).match(/\b(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
    if(!m)return null;
    const [,y,mo,d,h,mi,se='00']=m,iso=`${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}T${h.padStart(2,'0')}:${mi}:${se}`;
    const n=new Date(iso+'+08:00').getTime();
    return Number.isFinite(n)&&new Date(n+8*3600000).toISOString().slice(0,19)===iso?new Date(n).toISOString():null;
  }
  function entry(value) {
    const name=clean(value.name),goodsId=String(value.goodsId||'');
    if(!/^\d+$/.test(goodsId)||!name)return null;
    const quantity=/^\s*\d+\s*(?:件|个)?\s*$/.test(String(value.quantity))?Number(String(value.quantity).match(/\d+/)[0]):null;
    const total=cents(value.paidText),status=clean(value.status),boughtAt=time(value.boughtAt),deliveredAt=time(value.deliveredAt);
    return {platform:'buff',kind:'buy',appid:value.appid===570?570:730,goodsId,name,marketHashName:clean(value.marketHashName),
      orderId:clean(value.orderId)||null,fillId:clean(value.fillId)||null,sourceId:clean(value.fillId||value.orderId)||null,
      platformAccountId:value.platformAccountId||null,quantity:Number.isSafeInteger(quantity)&&quantity>0?quantity:null,
      buyTotalCents:total,currencyCode:total==null?null:'CNY',boughtAt,deliveredAt,
      dateLabel:clean(value.boughtAt),status,blocked:blockedStatus(status),sourceUrl:value.sourceUrl,
      rawText:clean(value.rawText).slice(0,2000),note:total==null?'未识别到明确人民币实付总额，请按实际订单填写（不能把单价当总额）':'实付总额来自页面，保存前请核对数量与金额'};
  }
  function buffDocument(doc,{url,accountId=null}={}) {
    const page=new URL(url||doc.location?.href||'https://buff.163.com/market/buy_order/history?game=csgo');
    if(page.origin!=='https://buff.163.com'||!/^\/market\/buy_order\/history\/?$/.test(page.pathname))throw new Error('请打开 BUFF 购买记录页');
    const appid=page.searchParams.get('game')==='dota2'?570:730,records=[];
    for(const table of doc.querySelectorAll('table')) {
      if(table.closest('[data-buff-helper],#buff-helper-panel'))continue;
      const headings=[...table.querySelectorAll('thead th,tr:first-child th')].map(e=>clean(e.textContent));
      const column=(cells,pattern)=>cells[headings.findIndex(h=>pattern.test(h))]?.textContent||'';
      for(const row of table.querySelectorAll('tbody tr')) {
        const links=[...row.querySelectorAll('a[href*="/goods/"]')];
        const link=links.find(a=>clean(a.textContent));if(!link)continue;
        const u=new URL(link.getAttribute('href'),page);if(u.origin!==page.origin)continue;
        const cells=[...row.querySelectorAll('td')],text=clean(row.innerText||row.textContent);
        const attr=names=>names.map(n=>row.getAttribute(n)).find(Boolean)||'';
        const field=(role,pattern)=>row.querySelector(`[data-role="${role}"]`)?.textContent||column(cells,pattern);
        let marketHashName=attr(['data-market-hash-name']);
        for(const a of row.querySelectorAll('a[href*="steamcommunity.com/market/listings/"]')) {
          try{const steam=new URL(a.href),m=steam.pathname.match(/^\/market\/listings\/(730|570)\/(.+?)\/?$/);if(steam.origin==='https://steamcommunity.com'&&Number(m?.[1])===appid)marketHashName=decodeURIComponent(m[2]);}catch{}
        }
        const order=attr(['data-buy-order-id','data-order-id','data-orderid'])||field('order-id',/^订单(?:号|编号)$|^购买订单号$/).replace(/^(?:订单号|订单编号)\s*[:：]?\s*/, '');
        const quantity=attr(['data-quantity'])||field('quantity',/^数量$|^购买数量$|^成交数量$/);
        const r=entry({name:link.textContent,goodsId:u.pathname.match(/^\/goods\/(\d+)/)?.[1],appid,marketHashName,orderId:order,
          fillId:attr(['data-fill-id','data-trade-id']),platformAccountId:accountId,quantity,
          paidText:field('paid-total',/^(?:实际支付|实付|实付金额|实付总额|实际支付总额|支付金额|支付总额|订单总额|成交总额)(?:[（(]元[）)])?$/),
          boughtAt:field('bought-at',/^(?:购买时间|买入时间|付款时间|支付时间|成交时间|交易时间|订单时间)$/),
          deliveredAt:field('delivered-at',/^(?:收货时间|交付时间)$/),status:field('order-status',/^(?:状态|订单状态|交易状态)$/),rawText:text,sourceUrl:page.href});
        if(r)records.push(r);
      }
    }
    return records;
  }
  function enrich(records,known=[]) {
    return records.map(r=>{
      if(r.marketHashName)return r;
      const matches=known.filter(x=>x.appid===r.appid&&String(x.goodsId)===r.goodsId&&x.marketHashName);
      const hashes=[...new Set(matches.map(x=>x.marketHashName))];
      return hashes.length===1?{...r,marketHashName:hashes[0],note:r.note+'；完整 Steam 名称来自本机同商品缓存，请核对规格'}:r;
    });
  }
  return {cents,time,entry,buffDocument,blockedStatus,enrich};
});
