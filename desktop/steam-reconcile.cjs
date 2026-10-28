"use strict";
const { createHash } = require("node:crypto");
const signature = (row, native) => {
  const date = native ? row.tradedAt && new Date(Date.parse(row.tradedAt)+28800000).toISOString().slice(0,10) : row.date;
  const direction = native ? row.direction : ({purchase:"buy",sale:"sell"})[row.type];
  const amount = native ? direction==="buy"?row.paidTotalCents:row.saleProceedsCents??row.netTotalCents : row.totalCents;
  if(!date||!direction||!row.marketHashName||!Number.isSafeInteger(row.quantity)||row.quantity<1||!Number.isSafeInteger(amount))return null;
  return JSON.stringify([String(row.appid),row.marketHashName,date,direction,native?row.currencyCode:row.currency,row.quantity,amount]);
};
function pairRows(native, csv) {
  const buckets=new Map();for(const row of native){const key=signature(row,true);if(key){if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(row);}}
  const pairs=[];
  for(const row of csv){
    const key=signature(row,false),list=key&&buckets.get(key);if(!list?.length)return null;
    const index=row.assetId ? list.findIndex(n=>(n.assetAliases||[n.assetId]).includes(row.assetId)) : list.length-1;
    if(index<0)return null;
    pairs.push([row.key,list.splice(index,1)[0].key]);
  }
  return pairs;
}
function bindCsv(account,csv,previous=[]) {
  if(!account.coverage?.complete)return previous||[];
  const scopes=new Map(),result=[];
  for(const row of csv.rows||[])if(row.platform==="steam"&&row.sourceFormat==="steam-market-history"&&row.amountSemantics==="actual"){if(!scopes.has(row.scope))scopes.set(row.scope,[]);scopes.get(row.scope).push(row);}
  for(const [scope,rows]of scopes){
    const old=(previous||[]).find(b=>b.scope===scope);
    // First association requires a complete, exact multiset of the entire
    // archive, including multiplicity, day, app, full name, currency and direction.
    // Account ownership alone, similar names, or a single matching price cannot bind.
    if(!old&&(rows.length!==account.records.length||!rows.length||account.records.some(r=>!r.completed)&&rows.some(r=>!r.assetId)))continue;
    const nativeKeys=new Set(account.records.map(r=>r.key)),csvKeys=new Set(rows.map(r=>r.key));
    const kept=(old?.pairs||[]).filter(([c,n])=>csvKeys.has(c)&&nativeKeys.has(n));
    const usedCsv=new Set(kept.map(p=>p[0])),usedNative=new Set(kept.map(p=>p[1]));
    const pairs=pairRows(account.records.filter(r=>!usedNative.has(r.key)),rows.filter(r=>!usedCsv.has(r.key)));
    if(!old&&!pairs)continue;
    const all=[...kept,...(pairs||[])];
    result.push({scope,matchedCount:all.length,pairs:all,matchedAt:account.coverage.syncedAt,evidence:"complete-history-multiset",fingerprint:old?.fingerprint||createHash("sha256").update(JSON.stringify(rows.map(r=>signature(r,false)).sort())).digest("hex")});
  }
  return result;
}
function reconcileInput(input) {
  const owners=new Map(),keys=new Set();
  for(const account of Object.values(input.steam?.accounts||{}))for(const binding of account.csvBindings||[]){if(!owners.has(binding.scope))owners.set(binding.scope,[]);owners.get(binding.scope).push({account,binding});}
  const bindings=[];
  for(const [scope,values]of owners){if(values.length!==1)continue;const {account,binding}=values[0],nativeKeys=new Set((account.records||[]).map(r=>r.key));
    for(const [csvKey,nativeKey]of binding.pairs||[])if(nativeKeys.has(nativeKey))keys.add(JSON.stringify([scope,csvKey]));
    bindings.push({scope,accountId:account.account.id,matchedCount:binding.matchedCount});}
  const rows=input.csv?.rows||[],filtered=rows.filter(r=>!keys.has(JSON.stringify([r.scope,r.key])));
  return {...input,csv:{...input.csv,rows:filtered,archiveRowCount:rows.length,suppressedCount:rows.length-filtered.length,bindings}};
}
module.exports={bindCsv,reconcileInput,signature};
