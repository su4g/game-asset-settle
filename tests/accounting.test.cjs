const test=require('node:test');
const assert=require('node:assert/strict');
const {project,share}=require('../server/accounting.cjs');
const t=(n)=>new Date(Date.UTC(2026,9,n)).toISOString();
const buy=(id,platform,total,quantity=1,day=1)=>({id,accountId:'local',platform,direction:platform==='buff'?'knife':'cashout',appid:730,marketHashName:id,name:id,buyTotalCents:total,quantity,boughtAt:t(day),deliveredAt:t(day),confirmed:true});
const sale=(id,tradeId,net,quantity=1,day=2)=>({id,tradeId,netTotalCents:net,quantity,soldAt:t(day),receivedAt:t(day)});
const options={asOf:new Date(t(20)).getTime()};

test('800 → 1000 → 860 recognizes exactly 60 cash profit, never on Steam receipt',()=>{
 const data={trades:[buy('a','buff',80000),buy('b','steam',100000,1,3)],settlements:[sale('s1','a',100000),sale('s2','b',86000,1,4)]};
 const first=project(data,{asOf:new Date(t(2)).getTime()});
 assert.equal(first.totals.realizedCents,0);assert.equal(first.wallets[0].costCents,80000);
 const final=project(data,options);assert.equal(final.totals.realizedCents,6000);assert.equal(final.wallets[0].balanceCents,0);
 assert.equal(final.rows.find(r=>r.id==='b').cashCostCents,80000);
});
test('pending receipts do not fund purchases or realize profit',()=>{
 const pending={...sale('s','a',100000),receivedAt:null};
 const p=project({trades:[buy('a','buff',80000),buy('b','steam',100000,1,3)],settlements:[pending]},options);
 assert.equal(p.rows.find(r=>r.id==='a').pendingCents,100000);
 assert.equal(p.rows.find(r=>r.id==='b').cashCostCents,null);
 assert.equal(p.wallets[0].missingFundingCents,100000);
});
test('weighted funding carries exact cent remainders across partial purchases',()=>{
 const data={walletEvents:[{id:'w',accountId:'local',kind:'opening',amountCents:3,cashCostCents:2,occurredAt:t(1)}],trades:[buy('a','steam',1,1,2),buy('b','steam',1,1,3),buy('c','steam',1,1,4)]};
 const p=project(data,options);assert.equal(p.rows.reduce((n,r)=>n+r.cashCostCents,0),2);assert.equal(p.wallets[0].costCents,0);
 assert.equal(share(9007199254740991,2,3),6004799503160660);
});
test('multiple funding lots use weighted average and external spending consumes cost',()=>{
 const data={walletEvents:[{id:'w1',accountId:'local',kind:'opening',amountCents:10000,cashCostCents:8000,occurredAt:t(1)},
 {id:'w2',accountId:'local',kind:'funding',amountCents:10000,cashCostCents:6000,occurredAt:t(2)},
 {id:'w3',accountId:'local',kind:'spend',amountCents:10000,occurredAt:t(3)}],trades:[buy('x','steam',10000,1,4)]};
 assert.equal(project(data,options).rows[0].cashCostCents,7000);
});
test('unknown opening cost never assumes a 1:1 funding ratio',()=>{
 const p=project({walletEvents:[{id:'w',accountId:'local',kind:'opening',amountCents:10000,cashCostCents:null,occurredAt:t(1)}],trades:[buy('x','steam',10000,1,2)],settlements:[sale('s','x',9000,1,3)]},options);
 assert.equal(p.totals.realizedComplete,false);assert.equal(p.totals.totalPnlCents,null);
});
test('partial sales conserve inventory cost and final actual discount',()=>{
 const p=project({trades:[buy('a','buff',100,3)],settlements:[sale('s1','a',50,1,2),sale('s2','a',100,2,3)]},options);
 assert.equal(p.rows[0].settledCostCents,100);assert.equal(p.wallets[0].costCents,100);assert.equal(p.rows[0].actualRatio,100/150);
});
test('refunds restore remaining cost, and invalid legacy records do not enter financial totals',()=>{
 const p=project({trades:[buy('a','buff',100,3),{...buy('legacy','buff',90000),confirmed:false}],settlements:[sale('s','a',50,1,2)],
 refunds:[{id:'f',tradeId:'a',quantity:2,amountCents:67,occurredAt:t(3)}]},options);
 assert.equal(p.totals.buffBuyCents,100);assert.equal(p.totals.realizedCents,0);assert.equal(p.rows.find(r=>r.id==='a').remainingQuantity,0);
});
test('amended historical funding deterministically recomputes all later profits',()=>{
 const data={trades:[buy('a','buff',80000),buy('b','steam',100000,1,3)],settlements:[sale('s1','a',100000),sale('s2','b',86000,1,4)]};
 data.trades[0].buyTotalCents=70000;assert.equal(project(data,options).totals.realizedCents,16000);
});
test('expired quotes suppress complete valuation; estimated cooldown never claims verified unlock',()=>{
 const p=project({trades:[buy('a','buff',800)],prices:[{appid:730,marketHashName:'a',observedAt:t(1),steamNetCents:1000}]},options);
 assert.equal(p.totals.estimateComplete,false);assert.equal(p.rows[0].status,'estimated_cooldown');assert.equal(p.rows[0].unlockConfirmed,false);
});
test('same timestamp wallet receipt precedes cashout purchase; estimated unlock is exactly 7 days',()=>{
 const p=project({trades:[buy('a','buff',80000),buy('b','steam',100000,1,2)],settlements:[sale('s1','a',100000),sale('s2','b',86000,1,2)]},options);
 assert.equal(p.totals.realizedCents,6000);assert.equal(p.totals.realizedComplete,true);
 assert.equal(p.rows.find(r=>r.id==='a').estimatedUnlockAt,t(8));
});
test('a newer quote for one platform cannot freshen the other platform',()=>{
 const p=project({trades:[buy('a','steam',100)],walletEvents:[{id:'w',accountId:'local',kind:'opening',amountCents:100,cashCostCents:80,occurredAt:t(1)}],prices:[{appid:730,marketHashName:'a',observedAt:t(1),buffNetCents:100},{appid:730,marketHashName:'a',observedAt:t(20),steamNetCents:100}]},options);
 assert.equal(p.rows[0].estimatedNetUnitCents,null);assert.equal(p.totals.estimateComplete,false);
});
test('a zero-proceeds pending sale still holds its cost and remains incomplete',()=>{
 const p=project({trades:[buy('a','buff',100)],settlements:[{...sale('s','a',0),receivedAt:null}]},options);
 assert.equal(p.rows[0].status,'pending_receipt');assert.equal(p.totals.unrealizedCents,-100);
});
test('legacy forecast uses a PG lot total instead of rounding fractional unit costs',()=>{
 const {calculatePurchasePortfolio,buildPriceKey}=require('../common.js');
 const result=calculatePurchasePortfolio([{appid:730,marketHashName:'a',quantity:3,buyPriceCents:100/3,inventoryBuyCents:100,boughtAt:t(1),currencyCode:'CNY'}],[{key:buildPriceKey(730,'a','CNY'),lowestSellCents:50,currencyCode:'CNY',expiresAt:Date.now()+10000}]);
 assert.equal(result.summary.totalSpentCents,100);assert.equal(result.summary.invalidCount,0);
});
