"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {steamEntry,cents,preciseDate}=require('../sale-history.js');
const {preview,sourceKey}=require('../server/sync.cjs');
const trade={id:'one',accountId:'local',platform:'buff',direction:'knife',appid:730,marketHashName:'Test Item (Factory New)',name:'测试（崭新出厂）',quantity:2,buyTotalCents:100,boughtAt:'2025-01-01T00:00:00Z',confirmed:true,version:1};
const record={platform:'steam',sourceId:'synthetic-1',appid:730,marketHashName:trade.marketHashName,name:trade.name,quantity:1,netTotalCents:90,soldAt:'2025-01-02T00:00:00Z'};
test('Steam item-sale sign and CNY net cash delta are required; no inferred receipt',()=>{
 const entry={id:'history_row_test',sign:'-',price:'+¥ 1.88',name:'测试',url:'https://steamcommunity.com/market/listings/730/Test%20Item',date:'10 月 9 日'};
 assert.equal(steamEntry({...entry,sign:'+'}),null);assert.equal(steamEntry({...entry,price:'-¥ 1.88'}),null);
 const sale=steamEntry(entry);assert.equal(sale.netTotalCents,188);assert.equal(sale.soldAt,null);assert.equal(sale.receivedAt,null);assert.equal(sale.quantity,1);
 assert.equal(steamEntry({...entry,url:'https://steamcommunity.com/market/listings/730/G123'}),null);
});
test('unknown currency and date precision remain missing',()=>{
 assert.equal(cents('$ 2.00'),null);assert.equal(cents('2.00'),null);assert.equal(cents('¥ 1,200.09'),120009);
 assert.equal(preciseDate('10月9日'),null);assert.equal(preciseDate('2025-01-02 03:04:05'),'2025-01-01T19:04:05.000Z');
});
test('sync requires exact specification and compatible direction, game and chronological order',()=>{
 assert.equal(preview([record],{trades:[trade]})[0].status,'matched');
 assert.equal(preview([{...record,marketHashName:'Test Item (Battle-Scarred)',name:'other'}],{trades:[trade]})[0].status,'unmatched');
 assert.equal(preview([{...record,marketHashName:'Test Item (Battle-Scarred)'}],{trades:[trade]})[0].status,'unmatched');
 assert.equal(preview([{...record,platform:'buff'}],{trades:[trade]})[0].status,'unmatched');
 assert.equal(preview([{...record,appid:570}],{trades:[trade]})[0].status,'unmatched');
 assert.equal(preview([{...record,soldAt:'2024-01-01T00:00:00Z'}],{trades:[trade]})[0].tradeId,'');
});
test('ambiguous duplicate lots and manual receipts are never silently matched',()=>{
 assert.equal(preview([record],{trades:[trade,{...trade,id:'two'}]})[0].status,'review_match');
 assert.equal(preview([record],{trades:[trade],settlements:[{id:'sale',tradeId:'one',quantity:1,netTotalCents:90,soldAt:record.soldAt,receivedAt:record.soldAt}]})[0].status,'possible_duplicate');
 assert.equal(preview([{...record,soldAt:null}],{trades:[trade],settlements:[{id:'sale',tradeId:'one',quantity:1,netTotalCents:90,soldAt:record.soldAt,receivedAt:record.soldAt}]})[0].status,'possible_duplicate');
 const result=preview([record,record],{trades:[trade]});assert.equal(result[1].duplicate,true);
 assert.equal(preview([record],{trades:[trade]},[sourceKey(record)])[0].status,'already_imported');
});
test('original source identity is stable and account scoped',()=>{
 assert.equal(sourceKey(record),sourceKey({...record,netTotalCents:80}));
 assert.notEqual(sourceKey(record),sourceKey({...record,accountId:'another'}));
 assert.throws(()=>sourceKey(null));
});
