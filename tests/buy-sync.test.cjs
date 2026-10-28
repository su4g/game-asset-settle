'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const H=require('../buy-history.js'),S=require('../server/buy-sync.cjs');
const sample=extra=>({platform:'buff',appid:730,goodsId:'921475',name:'测试饰品（久经沙场）',marketHashName:'Test Item (Field-Tested)',orderId:'buy-1',platformAccountId:'buff:123',quantity:2,buyTotalCents:99,currencyCode:'CNY',boughtAt:'2025-01-01T01:00:00.000Z',status:'交易成功',...extra});
test('buy history only accepts one explicit CNY total, never foreign currency or malformed precision',()=>{
  for(const [text,value] of [['实付 ￥0.99',99],['CNY 1,234.56',123456],['人民币 8',800],['￥0.00',0]])assert.equal(H.cents(text),value,text);
  for(const text of ['0.99','US$0.99','￥1 (USD 0.1)','￥-1','￥0.999','￥1,23','￥1.2.3','￥1 ￥2','￥9007199254740991'])assert.equal(H.cents(text),null,text);
});
test('precise history times use Shanghai time and unknown quantity/payment stay missing',()=>{
  assert.equal(H.time('2025-1-2 10:03:04'),'2025-01-02T02:03:04.000Z');
  for(const value of ['2025-01-02','2025-02-30 10:00','2025-01-02 25:00'])assert.equal(H.time(value),null);
  const r=H.entry({goodsId:'1',name:'物品',quantity:'',paidText:'',boughtAt:'2025-01-02',status:'待发货'});
  assert.equal(r.quantity,null);assert.equal(r.buyTotalCents,null);assert.equal(r.boughtAt,null);assert.equal(r.deliveredAt,null);assert.equal(r.blocked,false);
  for(const status of ['已取消','交易关闭','待支付','未付款','退款中','待付款','Unpaid'])assert.equal(H.blockedStatus(status),true,status);
  assert.equal(H.entry({goodsId:'../bad',name:'物品'}),null);
});
test('full item name enrichment is constrained to exact game and goods id; ambiguous versions stay empty',()=>{
  const r=sample({marketHashName:''}),known=[sample(),sample({appid:570,marketHashName:'Other game'})];
  assert.equal(H.enrich([r],known)[0].marketHashName,sample().marketHashName);
  assert.equal(H.enrich([r],[...known,sample({marketHashName:'Different Wear'})])[0].marketHashName,'');
  assert.equal(H.enrich([r],[sample({goodsId:'123'})])[0].marketHashName,'');
});
test('source keys survive reviewed price/date edits and canonical account aliases',()=>{
  const r=S.source(sample());
  assert.equal(S.sourceKey(r),S.sourceKey({...r,buyTotalCents:88,boughtAt:'2025-02-01T00:00:00Z',quantity:4}));
  assert.equal(S.sourceKey(r),S.sourceKey({...r,platformAccountId:'buff:/user-center/123'}));
  assert.notEqual(S.sourceKey(r),S.sourceKey({...r,platformAccountId:'buff:456'}));
  assert.notEqual(S.sourceKey(r),S.sourceKey({...r,orderId:'buy-2'}));
  assert.throws(()=>S.source(sample({sourceUrl:'https://evil.example/market/buy_order/history'})),{status:400});
});
test('preview detects real orders, partial imports and nearby manual purchases without approving anything',()=>{
  const r=sample(),trade={...r,id:'id',confirmed:true,version:1,snapshot:{platformAccountId:r.platformAccountId}};
  assert.equal(S.preview([r],[trade])[0].status,'duplicate');
  assert.equal(S.preview([r],[{...trade,quantity:1}])[0].status,'order_conflict');
  assert.equal(S.preview([r],[{...trade,orderId:null}])[0].status,'possible_duplicate');
  assert.equal(S.preview([r],[{...trade,snapshot:{platformAccountId:'buff:456'}}])[0].status,'review');
  assert.equal(S.preview([r],[{...trade,marketHashName:'Test Item (Factory New)',goodsId:'1'}])[0].status,'review');
  assert.equal(S.preview([r],[{...trade,marketHashName:'Test Item (Factory New)'}])[0].status,'identity_conflict');
  assert.equal(S.preview([{...r,fillId:'same-fill'}],[{...trade,original:{fillId:'same-fill'},goodsId:'1',marketHashName:'Wrong Item'}])[0].status,'identity_conflict');
  assert.deepEqual(S.preview([r,r],[]).map(x=>x.status),['review','duplicate']);
  assert.equal(S.preview([sample({status:'已退款'})],[])[0].disabled,true);
});
test('confirmation fixes missing metadata but cannot replace the platform identity or skip human confirmation',()=>{
  const source=S.source(sample()),entry={source,reviewed:sample(),confirmed:true};
  assert.equal(S.reviewed(entry,source).direction,'knife');
  assert.throws(()=>S.reviewed({...entry,confirmed:false},source),{status:400});
  for(const patch of [{appid:570},{goodsId:'2'},{orderId:'different'},{marketHashName:'Different Wear'},{quantity:0},{buyTotalCents:1.1}])assert.throws(()=>S.reviewed({...entry,reviewed:{...entry.reviewed,...patch}},source),{status:400});
  const missing=S.source(sample({quantity:null,buyTotalCents:null,marketHashName:'',orderId:null,boughtAt:null}));
  const fixed=S.reviewed({...entry,source:missing},missing);assert.equal(fixed.buyTotalCents,99);assert.equal(fixed.orderId,'buy-1');
});
