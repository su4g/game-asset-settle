"use strict";
const {createHash}=require('node:crypto');
const {project}=require('./accounting.cjs');
const {HttpError}=require('./validation.cjs');
const normalize=s=>String(s || '').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase();
function sourceKey(record) {
  if(!record || typeof record!== 'object') throw new HttpError(400,'卖出记录格式无效');
  if(!['buff','steam'].includes(record.platform)) throw new HttpError(400,'卖出平台无效');
  // The fingerprint uses ORIGINAL source fields, never the edited price.
  const identity=JSON.stringify([record.accountId || 'local', record.sourceId || [record.marketHashName || record.name,record.quantity,record.soldAt,record.netTotalCents,record.rawText]]);
  return `${record.platform}:${createHash('sha256').update(String(identity)).digest('hex')}`;
}
function preview(records,data,imported=[]) {
  if(!Array.isArray(records)||records.length>1000) throw new HttpError(400,'单次最多核对 1000 条卖出记录');
  const rows=project(data).rows;
  const known=new Set(imported),seen=new Set();
  return records.map(original=>{
    const source={...original,sourceKey:sourceKey(original)};
    const duplicate=known.has(source.sourceKey)||seen.has(source.sourceKey);seen.add(source.sourceKey);
    const direction=source.platform==='steam'?'knife':'cashout';
    const soldAt=source.soldAt?new Date(source.soldAt).getTime():NaN;
    const candidates=rows.filter(t=>t.confirmed&&t.direction===direction&&(!source.appid||Number(source.appid)===t.appid))
      .map(t=>{
        const name=normalize(source.name),hash=normalize(source.marketHashName);
        const exactHash=hash&&hash===normalize(t.marketHashName),exactName=name&&[normalize(t.name),normalize(t.marketHashName)].includes(name);
        const asset=source.assetId&&String(source.assetId)===String(t.original?.assetId || t.snapshot?.assetId || '');
        const chronology=Number.isFinite(soldAt)&&new Date(t.boughtAt).getTime()<=soldAt;
        const matches=(data.settlements || []).filter(s=>s.tradeId===t.id&&!s.voided&&!s.externalKey&&s.quantity===Number(source.quantity)&&(!Number.isFinite(soldAt)||Math.abs(new Date(s.soldAt).getTime()-soldAt)<12*3600000));
        return {id:t.id,name:t.name,marketHashName:t.marketHashName,boughtAt:t.boughtAt,remainingQuantity:t.remainingQuantity,version:t.version,
          score:hash&&!exactHash?0:asset?100:exactHash?90:exactName?70:0,chronology,existingSettlements:matches};
      }).filter(t=>t.score>0).sort((a,b)=>b.score-a.score || new Date(b.boughtAt)-new Date(a.boughtAt));
    const eligible=candidates.filter(t=>t.chronology&&t.remainingQuantity>=Number(source.quantity));
    const existing=candidates.flatMap(c=>c.existingSettlements.map(s=>({tradeId:c.id,...s})));
    const suggested=eligible.length===1&&!existing.length?eligible[0]:null;
    return {source,duplicate,candidates,existing,tradeId:suggested?.id || '',version:suggested?.version,
      status:duplicate?'already_imported':existing.length?'possible_duplicate':suggested?'matched':candidates.length?'review_match':'unmatched',
      quantity:Number.isSafeInteger(Number(source.quantity))?Number(source.quantity):1,
      netTotalCents:Number.isSafeInteger(source.netTotalCents)&&source.netTotalCents>=0?source.netTotalCents:null,
      soldAt:source.soldAt || '',receivedAt:source.receivedAt || '',
      note:source.netTotalCents==null?'缺少明确的扣费后到账金额，请填写':source.receivedAt?'请核对实际到账及对应购买批次':'请确认实际到账时间'};
  });
}
module.exports={preview,sourceKey};
