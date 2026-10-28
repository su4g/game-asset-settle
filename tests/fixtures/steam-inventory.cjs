"use strict";
const accountId="steam:76561198000000001";
function item(name="Input (Minimal Wear)",extra={}) { return {index:0,direction:"out",appid:730,contextId:"2",classId:"100",instanceId:"200",assetId:"",quantity:10,name,marketHashName:name,collection:"set_test",rarity:"Rarity_Mythical_Weapon",...extra}; }
function event(extra={}) {const eventId=extra.eventId||"a".repeat(40);return {key:`${accountId}:inventory:${eventId}`,eventId,accountId,appid:730,at:"2026-10-27T12:05:00.000Z",timePrecision:"minute",kind:"trade-up",action:"Crafted",items:[item("Output (Minimal Wear)",{index:0,direction:"in",quantity:1,assetId:"900"}),item(undefined,{index:1})],...extra};}
function archive(events=[event()],extra={}) {return {version:1,events,coverage:{complete:true,cursor:null,stopReason:"end",syncedAt:"2026-10-28T00:00:00.000Z",pages:1,eventCount:events.length,...extra}};}
function page(events=[event()],cursor=null) {
 const descriptions={730:{}};
 const html=events.map(e=>{
   const groups=["in","out"].map(dir=>{const children=e.items.filter(i=>i.direction===dir).map(i=>{descriptions[730][`${i.classId}_${i.instanceId}`]={appid:"730",classid:i.classId,instanceid:i.instanceId,market_hash_name:i.marketHashName,market_name:i.name,tags:[{category:"ItemSet",internal_name:i.collection},{category:"Rarity",internal_name:i.rarity}]};return `<span id="history${e.eventId}_item${i.index}" class="history_item economy_item_hoverable" data-appid="730" data-classid="${i.classId}" data-instanceid="${i.instanceId}" data-contextid="2" data-amount="${i.quantity}"><span class="history_item_name">Safe label</span></span>`;}).join(", ");return children?`<div class="tradehistory_items tradehistory_items_withimages"><div class="tradehistory_items_plusminus">${dir==="in"?"+":"-"}</div><div class="tradehistory_items_group">${children}</div></div>`:"";}).join("");
   return `<div class="tradehistoryrow"><div class="tradehistory_date">27 Oct, 2026<div class="tradehistory_timestamp">8:05pm</div></div><div class="tradehistory_content"><div class="tradehistory_event_description">${e.action}</div>${groups}</div></div>`;
 }).join("");return {success:true,num:events.length,html,descriptions,cursor};
}
// Each description really has its own class/instance; never identify an asset by it.
function sample(){return page([event({items:[item("Output (Minimal Wear)",{direction:"in",quantity:1,classId:"101",index:0}),...Array.from({length:10},(_,n)=>item(undefined,{quantity:1,index:n+1}))]})]);}
module.exports={accountId,item,event,archive,page,sample};
