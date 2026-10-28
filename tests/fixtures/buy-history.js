(() => {
  const H=self.BuffBuyHistory,results=[];
  const test=(name,fn)=>{try{fn();results.push('通过 '+name);}catch(error){results.push('失败 '+name+'：'+error.message);}};
  const equal=(a,b)=>{if(a!==b)throw new Error(JSON.stringify(a)+' !== '+JSON.stringify(b));};
  const options={url:'https://buff.163.com/market/buy_order/history?game=csgo',accountId:'buff:demo'};
  const records=H.buffDocument(document,options);
  test('提取表格订单、总实付、完整名称和数量',()=>{equal(records.length,4);equal(records[0].orderId,'demo-buy-001');equal(records[0].buyTotalCents,198);equal(records[0].quantity,2);equal(records[0].marketHashName,'Demo Item (Field-Tested)');});
  test('按北京时间读取成交，不能以成交推断收货',()=>{equal(records[0].boughtAt,'2025-01-02T02:03:04.000Z');equal(records[0].deliveredAt,null);});
  test('Steam 链接补全精确规格，外币和未标注数量留空',()=>{equal(records[1].marketHashName,'Demo Item (Factory New)');equal(records[1].buyTotalCents,null);equal(records[1].quantity,null);});
  test('取消订单显示为不可导入',()=>equal(records[2].blocked,true));
  test('单价列不能充当实付总额',()=>{const doc=new DOMParser().parseFromString(document.getElementById('history').outerHTML,'text/html');doc.querySelectorAll('th')[3].textContent='价格';equal(H.buffDocument(doc,options)[0].buyTotalCents,null);});
  test('外站商品链接和助手表格不会混入',()=>{const doc=new DOMParser().parseFromString('<div data-buff-helper>'+document.getElementById('history').outerHTML+'</div>','text/html');equal(H.buffDocument(doc,options).length,0);doc.querySelector('[data-buff-helper]').removeAttribute('data-buff-helper');for(const a of doc.querySelectorAll('a[href*="/goods/"]'))a.setAttribute('href','https://example.com/goods/1');equal(H.buffDocument(doc,options).length,0);});
  document.getElementById('testResults').textContent=results.join('\n')+'\n'+results.filter(r=>r.startsWith('通过')).length+'/'+results.length+' 通过';
})();
