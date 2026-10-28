"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {UuOrders,normalizeOrder,pageInfo}=require("../desktop/uu-orders.cjs");
const {navigationAllowed,resourceAllowed,createUuSession}=require("../desktop/uu-session.cjs");
const product=(n=1,extra={})=>({commodityId:String(n),assertId:String(100+n),templateId:"200",commodityName:"测试武器箱",marketHashName:"Test Case",price:101,typeName:"武器箱",...extra});
const order=(n=1,extra={})=>{const products=extra.productDetailList||[product(n)],count=extra.commodityNum||1,gross=products.length===count?products.reduce((sum,p)=>sum+Number(p.price),0):count*101;return{orderId:`order-${n}`,id:String(1000+n),buyerUserId:"7",sellerUserId:"7",orderType:1,saleOrderType:1,leaseNo:null,orderStatus:340,orderStatusName:"已完成",commodityNum:1,commodityAmount:gross,paymentAmount:gross,totalFeeAmount:0,finishOrderTime:"2026-10-21 12:00:00",productDetailList:products,...extra};};
const context={accountId:"uu:7",direction:"buy",observedAt:"2026-10-21T07:00:00.000Z"};
const response=data=>new Response(JSON.stringify({code:0,data}),{headers:{"content-type":"application/json"}});
function setup(handler,initial){
 let stored=structuredClone(initial||{version:1,accounts:{},cooldownUntil:0});const saves=[],calls=[],catalog={items:{}};
 const repository={load:async()=>structuredClone(stored),save:async value=>{stored=structuredClone(value);saves.push(stored);},names:async()=>catalog};
 const client=new UuOrders({repository,interval:()=>0,fetcher:async(url,init)=>{const body=init.body?JSON.parse(init.body):{};calls.push({url,body,method:init.method});if(url.endsWith("getUserInfo"))return response({UserId:"7",NickName:"测试"});return handler(url,body,init);}});
 return {client,calls,saves,catalog,stored:()=>stored};
}
async function run(client,options={}){await client.start(options);await client.running;return client.snapshot();}

test("悠悠列表分与大订单元分别解析，完整保留多组物品，不把取消时间当成交时间",()=>{
 const rows=normalizeOrder(order(1,{commodityNum:2,productDetailList:[product(1),product(2,{price:102})]}),context);
 assert.equal(rows.length,2);assert.notEqual(rows[0].key,rows[1].key);assert.equal(rows[0].grossTotalCents,101);assert.equal(rows[0].paidTotalCents,101);assert.equal(rows[0].netTotalCents,null);
 const detail={orderNo:"1001",orderCanceledTime:"2026-10-22 12:00:00",userCommodityVOList:[{commodityVOList:[{id:"1",price:"1.01",name:"测试武器箱",marketHashName:"Test Case"}]},{commodityVOList:[{id:"2",price:"1.02",name:"测试武器箱"}]}]};
 const batch=normalizeOrder(order(1,{commodityNum:2,commodityAmount:203,paymentAmount:203,finishOrderTime:null}),{...context,detail});assert.deepEqual(batch.map(r=>r.grossTotalCents),[101,102]);assert.equal(batch[0].tradedAt,null);
});
test("缺物品、重复资产、其他账号、未知状态、非法金额和不安全 ID 拒绝整单",()=>{
 for(const bad of [order(1,{commodityNum:2}),order(1,{commodityNum:2,productDetailList:[product(),product()]}),order(1,{buyerUserId:"8"}),order(1,{orderStatus:140}),order(1,{productDetailList:[product(1,{price:"1.01"})]}),order(1,{orderId:9007199254740992})])assert.throws(()=>normalizeOrder(bad,context));
 assert.throws(()=>pageInfo({orderList:[],totalPages:3},1),/分页中断/);assert.throws(()=>pageInfo({orderList:[order()],pageIndex:2},1),/错误页码/);
});
test("旧订单列表与详情商品价格缩小 100 倍时，用一致的订单商品总价恢复金额",()=>{
 const old=order(1,{commodityAmount:54500,paymentAmount:54500,totalFeeAmount:null,productDetailList:[product(1,{price:545})]});
 const buy=normalizeOrder(old,context)[0];assert.equal(buy.grossTotalCents,54500);assert.equal(buy.paidTotalCents,54500);assert.equal(buy.priceUnitEvidence,"list-yuan");
 const detail={orderNumber:"1001",tradeType:{type:2,name:"出售"},saleOrderType:1,commodityAmount:{type:2,name:"商品总价",amount:"545.00"},revenue:{type:5,name:"实际收入",amount:"545.00"},userCommodityVOList:[],commodity:{id:"1",name:"测试武器箱",price:"5.45"}};
 const sell=normalizeOrder(old,{...context,direction:"sell",detail})[0];assert.equal(sell.grossTotalCents,54500);assert.equal(sell.netTotalCents,54500);assert.equal(sell.priceUnitEvidence,"detail-legacy-scaled");assert.equal(sell.marketHashName,"Test Case");assert.equal(sell.goodsId,"200");
 assert.throws(()=>normalizeOrder({...old,commodityAmount:54000},{...context,direction:"sell",detail}),/商品总价字段不一致/);
 assert.throws(()=>normalizeOrder({...old,commodityAmount:54600},context),/价格单位与订单总价不一致/);
});
test("普通买卖业务与详情方向必须相符，租赁、退款和未知业务不会混入持仓",()=>{
 for(const patch of [{orderType:2},{orderType:null},{saleOrderType:2},{saleOrderType:3},{leaseNo:"lease-order"},{commodityFailedNum:1},{returnAmount:1}])assert.throws(()=>normalizeOrder(order(1,patch),context));
 assert.throws(()=>normalizeOrder(order(),{...context,detail:{tradeType:{type:2,name:"出售"},userCommodityVOList:[{commodityVOList:[{id:"1",price:"1.01",name:"测试"}]}]}}),/业务类型/);
});
test("已验证来源类型 2 每次强制详情确认普通买卖、完成状态、订单身份及实际金额",async()=>{
 const source=order(1,{saleOrderType:2,commodityAmount:65,paymentAmount:65,totalFeeAmount:1,productDetailList:[product(1,{price:65})]});
 const detail={orderNumber:"1001",saleOrderType:2,leaseNo:null,tradeType:{type:1,name:"购买"},status:{status:340,statusName:"已完成",subStatusName:"购买成功"},
  commodityAmount:{type:2,name:"商品总价",amount:"0.65"},amount:{type:1,name:"实付款",amount:"0.65"},amounts:[{type:3,name:"实际支付金额",amount:"0.65"}],
  userCommodityVOList:[{commodityVOList:[{id:"1",templateId:"200",name:"测试武器箱",price:"0.65"}]}]};
 const normalized=normalizeOrder(source,{...context,detail})[0];assert.equal(normalized.paidTotalCents,65);assert.equal(normalized.grossTotalCents,65);assert.equal(normalized.lineId,"1");
 for(const patch of [{tradeType:null},{tradeType:{type:2,name:"出售"}},{status:null},{status:{status:340,statusName:"处理中"}},{orderNumber:null},{orderNumber:"wrong"},{leaseNo:"lease"},{leaseNo:undefined},{saleOrderType:1},{commodityAmount:null},{amount:null,amounts:[]}])assert.throws(()=>normalizeOrder(source,{...context,detail:{...detail,...patch}}));
 const env=setup(async url=>url.endsWith("/query/detail")?response(detail):response({orderList:[source],hasNext:false}));
 assert.equal((await run(env.client)).job.status,"completed");assert.equal(env.calls.filter(call=>call.url.endsWith("/query/detail")).length,1);
 assert.equal(env.stored().accounts["uu:7"].records[0].paidTotalCents,65);
});
test("租赁关联的过户购买须以详情过户价加额外费用核对实付，租金不转成持仓",async()=>{
 const source=order(1,{orderSubType:13,leaseNo:"lease-list",commodityAmount:736600,paymentAmount:744400,productDetailList:[product(1,{price:736600})]});
 const detail={orderNumber:"1001",orderSubType:13,saleOrderType:1,leaseNo:"lease-detail",tradeType:{type:1,name:"购买"},status:{status:340,statusName:"已完成",subStatusName:"出售成功",statusDesc:"购买成功"},
  commodityAmount:{type:9,name:"过户价格",amount:"7366.00"},amount:{type:1,name:"实付款",amount:"7444.00"},amounts:[{type:9,name:"过户价格",amount:"7366.00"},{type:10,name:"额外费用",amount:"78.00"}],
  userCommodityVOList:[{commodityVOList:[{id:"1",templateId:"200",name:"测试手套",price:"7366.00"}]}]};
 assert.throws(()=>normalizeOrder(source,context));
 const row=normalizeOrder(source,{...context,detail})[0];assert.equal(row.grossTotalCents,736600);assert.equal(row.paidTotalCents,744400);assert.equal(row.orderExtraCostCents,7800);assert.equal(row.businessType,"ownership-transfer");
 for(const patch of [{tradeType:{type:1,name:"租赁"}},{orderSubType:1},{status:null},{amount:{type:1,name:"实付款",amount:"7443.00"}},
  {commodityAmount:{type:9,name:"租金",amount:"7366.00"},amounts:[{type:10,name:"额外费用",amount:"78.00"}]},
  {amounts:[{type:10,name:"额外费用",amount:"77.00"}]}])assert.throws(()=>normalizeOrder(source,{...context,detail:{...detail,...patch}}));
 assert.throws(()=>normalizeOrder({...source,orderSubType:1},{...context,detail}));assert.throws(()=>normalizeOrder(source,{...context,direction:"sell",detail}));
 const env=setup(async url=>url.endsWith("/query/detail")?response(detail):response({orderList:[source],hasNext:false}));
 assert.equal((await run(env.client)).job.status,"completed");assert.equal(env.calls.filter(call=>call.url.endsWith("/query/detail")).length,1);assert.equal(env.stored().accounts["uu:7"].records[0].paidTotalCents,744400);
});
test("卖给求购单的详情以卖出方向及成功收入核验，批量九件金额与手续费守恒",async()=>{
 const products=Array.from({length:9},(_,i)=>product(i+1,{price:2430}));
 const source=order(1,{orderSubType:5,commodityNum:9,commodityAmount:21870,paymentAmount:21870,totalFeeAmount:216,productDetailList:products.slice(0,3)});
 const detail={orderNumber:"1001",orderSubType:5,saleOrderType:1,leaseNo:null,tradeType:{type:2,name:"求购"},status:{status:340,statusName:"已完成",statusDesc:"出售成功",subStatusName:"出售成功"},
  commodityAmount:{type:2,name:"商品总价",amount:"218.70"},revenue:{type:5,name:"实际收入",amount:"216.54"},amounts:[{type:11,name:"交易服务费",amount:"2.16"}],
  userCommodityVOList:[{commodityVOList:products.map(p=>({id:p.commodityId,templateId:"200",name:p.commodityName,price:"24.30"}))}]};
 const ctx={...context,direction:"sell",detail},rows=normalizeOrder(source,ctx);
 assert.equal(rows.length,9);assert.equal(rows.reduce((n,r)=>n+r.netTotalCents,0),21654);assert.equal(rows.reduce((n,r)=>n+r.feeCents,0),216);assert(rows.every(r=>r.direction==="sell"&&r.businessType==="buy-order-sale"));
 for(const patch of [{tradeType:{type:1,name:"求购"}},{orderSubType:1},{status:{status:340,statusName:"已完成",statusDesc:"购买成功"}},
  {revenue:{type:5,name:"实际收入",amount:"216.55"}},{leaseNo:"lease"}])assert.throws(()=>normalizeOrder(source,{...ctx,detail:{...detail,...patch}}));
 assert.equal(normalizeOrder(source,{...ctx,detail:{...detail,amounts:[]}}).reduce((n,r)=>n+r.feeCents,0),216);
 assert.throws(()=>normalizeOrder({...source,orderSubType:1},ctx));
 const env=setup(async url=>url.endsWith("/query/detail")?response(detail):response({}));
 const loaded=await env.client.readOrder(source,"uu:7","sell",new AbortController().signal);assert.equal(loaded.length,9);assert.equal(env.calls.length,1);
 env.calls.length=0;const complete=await env.client.readOrder({...source,productDetailList:products},"uu:7","sell",new AbortController().signal);
 assert.equal(complete.reduce((n,r)=>n+r.netTotalCents,0),21654);assert.equal(env.calls.length,0);
});
test("求购明确零费用可省略详情费用，普通还价补贴只采用明确实际收入",()=>{
 const source=order(1,{orderSubType:5,commodityAmount:125000,paymentAmount:125000,totalFeeAmount:1250,platformSubsidyAmount:1250,productDetailList:[product(1,{price:125000})]});
 const detail={orderNumber:"1001",orderSubType:5,saleOrderType:1,leaseNo:null,tradeType:{type:2,name:"还价"},status:{status:340,statusName:"已完成",statusDesc:"出售成功"},
  commodityAmount:{type:2,name:"商品总价",amount:"1250.00"},revenue:{type:5,name:"实际收入",amount:"1237.50"},amounts:[{type:11,name:"交易服务费",amount:"12.50"}],
  commodity:{id:"1",templateId:"200",name:"测试手套",price:"1250.00"}};
 const ctx={...context,direction:"sell",detail},row=normalizeOrder(source,ctx)[0];assert.equal(row.netTotalCents,123750);assert.equal(row.feeCents,1250);assert.equal(row.businessType,"negotiated-sale");
 // The adjustment label does not reveal which party received it. Only the
 // explicit seller receipt may change the net amount.
 const credited=normalizeOrder(source,{...ctx,detail:{...detail,revenue:{type:5,name:"实际收入",amount:"1250.00"}}})[0];assert.equal(credited.netTotalCents,125000);assert.equal(credited.feeCents,1250);
 assert.throws(()=>normalizeOrder({...source,platformSubsidyAmount:0},{...ctx,detail:{...detail,revenue:{type:5,name:"实际收入",amount:"1250.00"}}}),/实际收入字段不一致/);
 assert.throws(()=>normalizeOrder(source,{...ctx,detail:{...detail,amounts:[{type:11,name:"交易服务费",amount:"12.00"}]}}),/交易服务费字段不一致/);
 const noFee={...detail,tradeType:{type:2,name:"求购"},commodityAmount:{type:2,name:"商品总价",amount:"28.80"},revenue:{type:5,name:"实际收入",amount:"28.80"},amounts:[],commodity:{...detail.commodity,price:"28.80"}};
 const zero=normalizeOrder({...source,commodityAmount:2880,paymentAmount:2880,totalFeeAmount:0,platformSubsidyAmount:0,productDetailList:[product(1,{price:2880})]},{...ctx,detail:noFee})[0];assert.equal(zero.netTotalCents,2880);assert.equal(zero.feeCents,0);
 const absent=normalizeOrder({...source,totalFeeAmount:null},{...ctx,detail:{...detail,amounts:[]}})[0];assert.equal(absent.feeCents,null);assert.equal(absent.netTotalCents,123750);
 for(const patch of [{tradeType:{type:1,name:"还价"}},{tradeType:{type:2,name:"租赁"}},{status:{status:340,statusName:"已完成",statusDesc:"购买成功"}},{orderNumber:"other"},{leaseNo:"lease"}])assert.throws(()=>normalizeOrder(source,{...ctx,detail:{...detail,...patch}}));
});
test("旧出售必须双完成状态与明确详情，单件成交总额不被原挂牌报价覆盖",async()=>{
 const source=order(1,{orderType:2,orderSubType:1,commodityAmount:392000,paymentAmount:392000,totalFeeAmount:null,productDetailList:[product(1,{price:3940})]});
 const detail={orderNumber:"1001",orderSubType:1,saleOrderType:1,leaseNo:null,tradeType:{type:2,name:"出售"},status:{status:340,statusName:null,subStatusName:null,statusDesc:""},
  commodityAmount:{type:2,name:"商品总价",amount:"3920.00"},revenue:{type:5,name:"实际收入",amount:"3920.00"},userCommodityVOList:[],commodity:{id:"1",templateId:"200",name:"测试手套",price:"39.40"}};
 const ctx={...context,direction:"sell",detail},row=normalizeOrder(source,ctx)[0];assert.equal(row.grossTotalCents,392000);assert.equal(row.netTotalCents,392000);assert.equal(row.feeCents,null);
 assert.equal(row.businessType,"legacy-sale");assert.equal(row.priceUnitEvidence,"order-total-single");assert.equal(row.sourceProductPrice,"39.40");assert.equal(row.sourceListProductPrice,3940);
 assert.throws(()=>normalizeOrder(source,{...context,direction:"sell"}));
 for(const patch of [{tradeType:{type:1,name:"购买"}},{tradeType:{type:2,name:"租赁"}},{orderSubType:5},{leaseNo:"lease"},{leaseNo:undefined},{orderNumber:"other"},{status:null},{status:{status:140,statusName:null}},{status:{status:340,statusName:"已取消"}},{status:{status:340,subStatusName:"退款成功"}},{status:{status:340,statusDesc:"购买成功"}},{commodityAmount:null},{revenue:null}])assert.throws(()=>normalizeOrder(source,{...ctx,detail:{...detail,...patch}}));
 for(const patch of [{orderType:3},{orderSubType:5},{saleOrderType:2},{leaseNo:"lease"},{orderStatus:140},{orderStatusName:"待完成"}])assert.throws(()=>normalizeOrder({...source,...patch},ctx));
 assert.throws(()=>normalizeOrder({...source,commodityNum:2,commodityAmount:784000},{...ctx,detail:{...detail,commodityAmount:{type:2,name:"商品总价",amount:"7840.00"},revenue:{type:5,name:"实际收入",amount:"7840.00"},userCommodityVOList:[{commodityVOList:[detail.commodity,{...detail.commodity,id:"2"}]}]}}),/价格单位与订单总价不一致/);
 const env=setup(async()=>response(detail));const rows=await env.client.readOrder({...source,totalFeeAmount:0},"uu:7","sell",new AbortController().signal);assert.equal(env.calls.length,1);assert.equal(rows[0].netTotalCents,392000);
 await assert.rejects(env.client.readOrder({...source,productDetailList:[product(2,{price:3940})]},"uu:7","sell",new AbortController().signal),/列表与详情物品/);
});
test("实际收入采用已核验费用或详情收入，差额按毛价比例分摊且不丢分",()=>{
 const source=order(1,{commodityNum:3,commodityAmount:406,paymentAmount:406,totalFeeAmount:7,productDetailList:[product(1,{price:101}),product(2,{price:102}),product(3,{price:203})]});
 const rows=normalizeOrder(source,{...context,direction:"sell"});
 assert.equal(rows.reduce((sum,row)=>sum+row.netTotalCents,0),399);assert.equal(rows.reduce((sum,row)=>sum+row.feeCents,0),7);
 assert(rows.every(row=>row.netTotalCents+row.feeCents===row.grossTotalCents&&row.amountAllocation==="proportional-gross"));
 const reversed=normalizeOrder({...source,productDetailList:[...source.productDetailList].reverse()},{...context,direction:"sell"});
 assert.deepEqual(Object.fromEntries(rows.map(row=>[row.lineId,row.netTotalCents])),Object.fromEntries(reversed.map(row=>[row.lineId,row.netTotalCents])));
 const detail={commodityAmount:{type:2,name:"商品总价",amount:"4.06"},revenue:{type:5,name:"实际收入",amount:"3.98"},userCommodityVOList:[{commodityVOList:source.productDetailList.map(p=>({id:p.commodityId,name:p.commodityName,price:(p.price/100).toFixed(2)}))}]};
 assert.throws(()=>normalizeOrder(source,{...context,direction:"sell",detail}),/实际收入字段不一致/);
 const unknown=normalizeOrder(order(1,{paymentAmount:null}),context)[0];assert.equal(unknown.paidTotalCents,null);assert.equal(unknown.amountAllocation,"unknown");
});
test("卖出调整字段为说明对象时回退详情净收入，不解析对象费率或使用买家实付",async()=>{
 const source=order(1,{orderSubType:5,commodityAmount:187,paymentAmount:188,totalFeeAmount:1,sellGiveFee:{serviceFee:"0.01",rate:"0.01"},productDetailList:[product(1,{price:187})]});
 const detail={orderNumber:"1001",saleOrderType:1,orderSubType:5,leaseNo:null,tradeType:{type:2,name:"出售"},status:{status:340,statusName:"已完成",statusDesc:"出售成功"},
  commodityAmount:{type:2,name:"商品总价",amount:"1.87"},revenue:{type:5,name:"实际收入",amount:"1.86"},amounts:[{type:11,name:"交易服务费",amount:"0.01"}],
  userCommodityVOList:[{commodityVOList:[{id:"1",templateId:"200",name:"测试物品",price:"1.87"}]}]};
 assert.equal(normalizeOrder(source,{...context,direction:"sell"})[0].netTotalCents,null);
 const env=setup(async()=>response(detail)),rows=await env.client.readOrder(source,"uu:7","sell",new AbortController().signal);
 assert.equal(env.calls.length,1);assert.equal(rows[0].netTotalCents,186);assert.equal(rows[0].grossTotalCents,187);assert.equal(rows[0].feeCents,1);assert.equal(rows[0].amountSource,"uu-detail-actual");
 for(const patch of [{commodityAmount:{}},{totalFeeAmount:{}}])assert.throws(()=>normalizeOrder({...source,...patch},{...context,direction:"sell",detail}),/金额字段格式/);
});
test("首次读至末页，重启后两页已知边界停止；重复同步零新增且不刷新观测时间",async()=>{
 let batch=0;const env=setup(async(_url,b)=>response({orderList:b.pageIndex<=2?[order(b.pageIndex)]:[]}));
 let result=await run(env.client);assert.equal(result.job.inserted,2);assert.equal(result.job.pages,3);const before=structuredClone(env.stored());
 env.calls.length=0;result=await run(env.client);assert.equal(result.job.skipped,2);assert.equal(result.job.inserted,0);assert.equal(result.job.pages,2);assert.equal(result.runs[0].stopReason,"known");assert.equal(result.runs[0].complete,true);
 assert.deepEqual(env.stored().accounts["uu:7"].records,before.accounts["uu:7"].records);
 const reloaded=setup(async(_url,b)=>response({orderList:b.pageIndex<=2?[order(b.pageIndex)]:[]}),env.stored());await reloaded.client.ready;assert.equal(reloaded.client.snapshot().count,2);
 assert(env.calls.filter(c=>!c.url.endsWith("getUserInfo")).every(c=>c.method==="POST"));
});
test("读取全部历史，忽略旧版页数配置；已知订单金额改变时更新并继续读取",async()=>{
 let price=101;const env=setup(async(_url,b)=>response({orderList:b.pageIndex<=3?[order(b.pageIndex,{productDetailList:[product(b.pageIndex,{price})]})]:[]}));
 let r=await run(env.client,{maxPages:2});assert.equal(r.job.status,"completed");assert.equal(r.runs[0].complete,true);assert.equal(r.job.pages,4);
 price=102;r=await run(env.client);assert.equal(r.job.updated,3);assert.equal(r.job.inserted,0);assert.equal(r.job.pages,4);
});
test("同订单物品可补全商品模板编号，后续列表缺字段不丢已知身份，真实模板冲突仍拒绝",async()=>{
 const legacy=normalizeOrder(order(),context)[0];legacy.goodsId=legacy.lineId;delete legacy.templateId;
 const initial={version:1,activeAccount:"uu:7",accounts:{"uu:7":{account:{id:"uu:7"},records:[legacy],runs:[]}}};
 let templateId="200";
 const env=setup(async()=>response({orderList:[order(1,{productDetailList:[product(1,{templateId})]})],hasNext:false}),initial);
 let result=await run(env.client);assert.equal(result.job.updated,1);assert.equal(env.stored().accounts["uu:7"].records[0].goodsId,"200");
 templateId=null;result=await run(env.client);assert.equal(result.job.status,"completed");assert.equal(env.stored().accounts["uu:7"].records[0].templateId,"200");
 const before=structuredClone(env.stored());templateId="201";result=await run(env.client);assert.equal(result.job.status,"failed");assert.match(result.job.message,/物品身份冲突/);assert.deepEqual(env.stored(),before);
});
test("接口失败、重复页和账号切换均不提交部分历史",async()=>{
 for(const handler of [async(_u,b)=>b.pageIndex===1?response({orderList:[order()]}):new Response("bad",{status:500}),async()=>response({orderList:[order()]})]){
  const env=setup(handler);assert.equal((await run(env.client)).job.status,"failed");assert.equal(env.saves.length,0);
 }
 const env=setup(async()=>response({orderList:[order()],hasNext:false}));let count=0;env.client.identify=async()=>({id:++count===1?"uu:7":"uu:8",nickname:"测试"});assert.equal((await run(env.client)).job.status,"failed");assert.equal(env.saves.length,0);
});
test("大订单自动补全所有组，缺详情时原库不变",async()=>{
 const large=order(1,{commodityNum:4,productDetailList:[product(1),product(2),product(3)]});let incomplete=false;
 const env=setup(async(url)=>url.endsWith("/query/detail")?response({orderNo:"1001",userCommodityVOList:[{commodityVOList:[1,2].map(n=>({id:String(n),name:"测试武器箱",price:"1.01"}))},{commodityVOList:(incomplete?[3]:[3,4]).map(n=>({id:String(n),name:"测试武器箱",price:"1.01"}))}]}):response({orderList:[large],hasNext:false}));
 assert.equal((await run(env.client)).job.inserted,4);const before=structuredClone(env.stored());incomplete=true;assert.equal((await run(env.client)).job.status,"failed");assert.deepEqual(env.stored(),before);
});
test("只读卖出验证：空列表不放行，有样本且详情金额吻合才允许同步",async()=>{
 let mode="empty";const env=setup(async(url)=>url.endsWith("/query/detail")?response({orderNo:"1001",userCommodityVOList:[{commodityVOList:[{id:"1",name:"测试武器箱",price:mode==="wrong"?"101.00":"1.01"}]}]}):response({orderList:mode==="empty"?[]:[order()],hasNext:false}));
 assert.match((await run(env.client,{direction:"sell"})).job.message,/先完成/);
 assert.equal((await run(env.client,{probe:true})).sellProbe.status,"empty");assert.equal(env.stored().accounts["uu:7"].records.length,0);
 mode="wrong";assert.equal((await run(env.client,{probe:true})).job.status,"failed");
 mode="valid";let r=await run(env.client,{probe:true});assert.equal(r.sellProbe.status,"verified");assert.equal(r.count,0);
 r=await run(env.client,{direction:"sell"});assert.equal(r.job.inserted,1);assert.equal(env.stored().accounts["uu:7"].records[0].netTotalCents,101);
 mode="wrong";r=await run(env.client,{probe:true});assert.equal(r.job.status,"failed");assert.equal(r.sellProbe.status,"unverified");assert.equal(r.count,1);
});
test("限流保存冷却，无自动重试；未知路由不能提交交易",async()=>{
 const env=setup(async()=>new Response("busy",{status:429,headers:{"retry-after":"90"}}));
 assert.equal((await run(env.client)).job.status,"failed");assert(env.stored().cooldownUntil>Date.now()+80000);const count=env.calls.length;await run(env.client);assert.equal(env.calls.length,count);
 await assert.rejects(env.client.request("/api/trade/send",{}),/未开放/);
});
test("停止查询不会提交；UI 只读映射匹配全名与游戏，冲突不自动对应",async()=>{
 const env=setup(async(_u,_b,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true})));
 await env.client.start();await new Promise(r=>setTimeout(r,15));env.client.stop();await env.client.running;assert.equal(env.saves.length,0);assert.equal(env.client.snapshot().job.status,"cancelled");
 const records=normalizeOrder(order(1,{productDetailList:[product(1,{marketHashName:""})]}),context);
 const names=setup(async()=>response({}),{version:1,activeAccount:"uu:7",accounts:{"uu:7":{account:{id:"uu:7"},records,runs:[]}}});
 names.catalog.items["730:Test Case"]={appid:"730",marketHashName:"Test Case",name:"测试武器箱"};let result=await names.client.list();assert.equal(result.rows[0].marketHashName,"Test Case");
 names.catalog.items["730:Other Case"]={appid:"730",marketHashName:"Other Case",name:"测试武器箱"};result=await names.client.list();assert.equal(result.rows[0].marketHashName,"");
});
test("同一英文名的不同中文别名不拆组：105 + 55 件按原金额加权，分类与明细保持完整",async()=>{
 const hash="Sealed Dead Hand Terminal",name="毁灭之手终端机密封版";
 const records=Array.from({length:160},(_,i)=>normalizeOrder(order(i+1,{paymentAmount:null,productDetailList:[product(i+1,{
  commodityName:name,marketHashName:i<105?hash:"",templateId:i<105?String(2087196415+i):"121599",
  typeName:i<105?"武器箱":"",price:i===104||i===159?214:199
 })]}),context)[0]);
 const env=setup(async()=>response({}),{version:1,activeAccount:"uu:7",accounts:{"uu:7":{account:{id:"uu:7"},records,runs:[]}}});
 env.catalog.items[`730:${hash}`]={appid:"730",marketHashName:hash,name:"",conflict:true,candidates:[{name:"封装的毁灭之手终端机",source:"BUFF 订单"},{name,source:"悠悠 订单"}]};
 const before=structuredClone(env.stored());
 const result=await env.client.list({mode:"summary"});
 assert.equal(result.groupTotal,1);const group=result.groups[0];
 assert.equal(group.quantity,160);assert.equal(group.grossCents,31870);assert.equal(group.averageCents,31870/160);assert.equal(group.actualAverageCents,null);
 assert.equal(group.records,160);assert.equal(group.marketHashName,hash);
 assert.equal((await env.client.list({category:"武器箱",groupKey:group.key})).recordTotal,160);
 assert.deepEqual(env.stored(),before);assert.equal(env.saves.length,0);
 // A display-name choice must not change membership or the original archive.
 env.catalog.items[`730:${hash}`].custom=true;env.catalog.items[`730:${hash}`].name="封装的毁灭之手终端机";
 const renamed=await env.client.list({mode:"summary"});assert.equal(renamed.groups[0].name,"封装的毁灭之手终端机");assert.equal(renamed.groups[0].grossCents,31870);
});
test("悠悠登录域名与后台查询白名单，不向渲染侧返回凭据",async()=>{
 assert(navigationAllowed("https://www.youpin898.com/mine"));assert(!navigationAllowed("https://www.youpin898.com.evil.test"));assert(!resourceAllowed("http://www.youpin898.com"));assert(!resourceAllowed("https://www.youpin898.com:8443"));
 const fetches=[],ses={setPermissionRequestHandler(){},setPermissionCheckHandler(){},on(){},webRequest:{onBeforeRequest(){},onBeforeSendHeaders(){}},cookies:{on(){},get:async()=>[{value:"Bearer%20secret-test-token"}]},fetch:async(url,init)=>{fetches.push({url,init});return response({});}};
 const login=createUuSession({session:{fromPartition:()=>ses},BrowserWindow(){},parent:()=>null,onSessionChange(){}});
 await assert.rejects(login.fetch("https://api.youpin898.com/api/trade/send",{method:"POST"}),/未开放/);assert.equal(fetches.length,0);
 await login.fetch("https://api.youpin898.com/api/user/Account/getUserInfo",{method:"GET"});assert.equal(fetches[0].init.headers.authorization,"Bearer secret-test-token");assert.equal("token" in login,false);
});

test("悠悠短信二次验证允许腾讯脚本、挑战 iframe 与 CDN，仍拦截非验证域名",()=>{
 for(const url of ["https://turing.captcha.qcloud.com/TCaptcha.js","https://turing.captcha.qcloud.com/cap_union_new_show","https://ca.turing.captcha.qcloud.com/cap_union_new_show","https://turing.captcha.gtimg.com/1/a.js","https://global.turing.captcha.gtimg.com/a.png","https://rce.tencentrio.com/collect","https://cloudcache.tencentcs.com/qcloud/main/scripts/release/common/vendor/jquery.js"])assert(resourceAllowed(url),url);
 assert(resourceAllowed("about:blank","subFrame"));assert(!resourceAllowed("about:blank","mainFrame"));
 for(const url of ["https://turing.captcha.qcloud.com.evil.test/TCaptcha.js","https://other.qcloud.com/TCaptcha.js","http://turing.captcha.qcloud.com/TCaptcha.js","file:///etc/passwd","http://127.0.0.1:3217/v1/health"])assert(!resourceAllowed(url),url);
 assert(!navigationAllowed("https://turing.captcha.qcloud.com/cap_union_new_show"));
});

test("平台长整数订单号与资产号无损读取，名称内数字不改写",()=>{
 const {parsePlatformJson}=require("../desktop/platform-json.cjs");
 const data=parsePlatformJson('{"orderId":202610210000000001,"assetId":9007199254740993,"name":"Knife 9007199254740993 \\"quoted\\"","price":101}');
 assert.equal(data.orderId,"202610210000000001");assert.equal(data.assetId,"9007199254740993");assert.equal(data.name,'Knife 9007199254740993 "quoted"');assert.equal(data.price,101);
});

test("悠悠完整同步穿过第 500 页直到平台末页",async()=>{
 const env=setup(async(_url,b)=>response({orderList:[order(b.pageIndex)],hasNext:b.pageIndex<501}));
 const result=await run(env.client,{mode:"full"});assert.equal(result.job.pages,501);assert.equal(result.job.inserted,501);assert.equal(result.runs[0].complete,true);
});

test("悠悠旧版未补齐存档遇到已知边界仍继续，自动补齐更早历史",async()=>{
 const env=setup(async(_url,b)=>response({orderList:b.pageIndex<=3?[order(b.pageIndex)]:[]}));
 await run(env.client);const saved=env.stored();saved.accounts["uu:7"].records=saved.accounts["uu:7"].records.slice(0,2);saved.accounts["uu:7"].runs[0].complete=false;
 const next=setup(async(_url,b)=>response({orderList:b.pageIndex<=3?[order(b.pageIndex)]:[]}),saved);
 const result=await run(next.client);assert.equal(result.job.pages,4);assert.equal(result.job.inserted,1);assert.equal(result.runs[0].complete,true);
});
