"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { timingSafeEqual } = require("node:crypto");
const { Store, row } = require("./store.cjs");
const { project } = require("./accounting.cjs");
const { HttpError, integer, uuid } = require("./validation.cjs");
const { HistoryStore } = require("./history-store.cjs");

const capabilities = {
  buff: { mode:'dom', reason: "BUFF 实站接入待验证；DOM 流程逐步核对，登录、支付或无法识别时等待人工接管", nativeSync: false },
  steam: { mode:'dom', reason: "逐步核对完整规格与含费金额；手机确认或页面无法识别时等待人工接管", nativeSync: false },
};
function createServer({ store, token, extensionOrigins, port = 3217 }) {
  const history = new HistoryStore(store.pool);
  const startedAt = new Date().toISOString();
  const send = (res, status, value) => { res.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      if(req.headers.host!==`127.0.0.1:${server.address().port}`) throw new HttpError(403,"仅允许本机地址");
      const origin=req.headers.origin;
      if(origin && !extensionOrigins.includes(origin)) throw new HttpError(403,"扩展来源未配对");
      if(origin) { res.setHeader("Access-Control-Allow-Origin",origin); res.setHeader("Vary","Origin"); }
      if(req.method==="OPTIONS") {
        res.writeHead(204,{"Access-Control-Allow-Methods":"GET, POST, PATCH, OPTIONS","Access-Control-Allow-Headers":"Authorization, Content-Type","Access-Control-Max-Age":"600"}); return res.end();
      }
      const secret=Buffer.from(req.headers.authorization || ""), expected=Buffer.from(`Bearer ${token}`);
      if(secret.length!==expected.length || !timingSafeEqual(secret,expected)) throw new HttpError(401,"本地服务未配对，请运行 npm run setup");
      const url=new URL(req.url,"http://127.0.0.1"), route=url.pathname.replace(/^\/v1/,"");
      let body={};
      if(["POST","PATCH"].includes(req.method)) {
        if(!/^application\/json\b/.test(req.headers["content-type"] || "")) throw new HttpError(415,"需要 JSON 请求");
        let size=0; const chunks=[];
        const limit = ["/history/buff", "/history/csv", "/history/uu", "/history/steam"].includes(route) ? 40*1024*1024 : 2*1024*1024;
        for await(const chunk of req) { size+=chunk.length; if(size>limit) throw new HttpError(413,"请求过大"); chunks.push(chunk); }
        try { body=JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400,"JSON 格式错误"); }
        if(!body || Array.isArray(body) || typeof body!=="object") throw new HttpError(400,"请求必须为对象");
      }
      const ratio=integer(Number(url.searchParams.get("targetRatioBps") || 8600),"目标提现折扣",0,100000);
      let result;
      if(req.method==="GET" && route==="/health") {
        await store.pool.query("SELECT 1");
        result={ok:true,database:"buff_goods",schemaVersion:1,historyVersion:3,startedAt,pid:process.pid,capabilities};
      } else if(req.method==="GET" && route==="/capabilities") result=capabilities;
      else if(req.method==="GET" && route==="/history/steam") result=await history.orders("steam");
      else if(req.method==="POST" && route==="/history/steam") result=await history.saveOrders("steam",body);
      else if(req.method==="GET" && route==="/history/uu") result=await history.uu();
      else if(req.method==="POST" && route==="/history/uu") result=await history.saveUu(body);
      else if(req.method==="GET" && route==="/history/buff") result=await history.buff();
      else if(req.method==="POST" && route==="/history/buff") result=await history.saveBuff(body);
      else if(req.method==="GET" && route==="/history/csv") result=await history.csv();
      else if(req.method==="POST" && route==="/history/csv") result=await history.importCsv(body);
      else if(req.method==="GET" && route==="/history/names") result=await history.names();
      else if(req.method==="POST" && route==="/history/names") result=await history.saveName(body);
      else if(req.method==="GET" && ["/summary","/trades","/holdings"].includes(route)) {
        const data=await store.snapshot(), state=project(data,{targetRatioBps:ratio});
        if(route==="/summary") { const {rows,realizedSeries,...summary}=state; result={...summary,tradeCount:rows.filter(t=>t.confirmed).length,unverifiedCount:rows.filter(t=>!t.confirmed).length}; }
        else if(route==="/holdings") result=state.rows.filter(t=>t.confirmed && t.remainingQuantity>0);
        else {
          let rows=state.rows;
          const query=(url.searchParams.get("q") || "").trim().toLocaleLowerCase();
          if(query) rows=rows.filter(t=>`${t.name} ${t.marketHashName} ${t.orderId || ""}`.toLocaleLowerCase().includes(query));
          if(url.searchParams.get("direction")) rows=rows.filter(t=>t.direction===url.searchParams.get("direction"));
          if(url.searchParams.get("appid")) rows=rows.filter(t=>t.appid===Number(url.searchParams.get("appid")));
          if(url.searchParams.get("status")) rows=rows.filter(t=>t.status===url.searchParams.get("status"));
          if(url.searchParams.get("from")) rows=rows.filter(t=>new Date(t.boughtAt)>=new Date(url.searchParams.get("from")));
          if(url.searchParams.get("to")) rows=rows.filter(t=>new Date(t.boughtAt)<=new Date(url.searchParams.get("to")));
          const page=integer(Number(url.searchParams.get("page") || 1),"页码",1), limit=integer(Number(url.searchParams.get("limit") || 50),"每页记录数",1,200);
          const total=rows.length;
          rows=rows.slice((page-1)*limit,page*limit).map(t=>{
            const start=new Date(t.boughtAt).getTime(),end=Math.min(Date.now(),start+7*86400000);
            return {...t,trend:data.prices.filter(p=>p.appid===t.appid&&p.marketHashName===t.marketHashName&&new Date(p.observedAt).getTime()>=start&&new Date(p.observedAt).getTime()<=end).sort((a,b)=>new Date(a.observedAt)-new Date(b.observedAt))};
          });
          result={rows,total,page,limit,asOf:state.asOf};
        }
      } else if(req.method==="GET" && route==="/series") {
        const data=await store.snapshot(), now=Date.now();
        const days=integer(Number(url.searchParams.get("days") ?? 30),"曲线天数",0,36500);
        const times=[...data.trades.filter(t=>t.confirmed).map(t=>new Date(t.boughtAt).getTime()),...data.walletEvents.filter(w=>!w.voided).map(w=>new Date(w.occurredAt).getTime())];
        const earliest=times.length?Math.min(...times):now;
        const start=days?Math.max(earliest,now-days*86400000):earliest;
        const step=Math.max(1,Math.ceil((now-start)/86400000/400))*86400000;
        const points=[];
        const add=(at)=>{ const s=project(data,{asOf:at,targetRatioBps:ratio}); points.push({at,realizedCents:s.totals.realizedComplete?s.totals.realizedCents:null,totalPnlCents:s.totals.totalPnlCents,coverage:`${s.totals.quotedCount}/${s.totals.holdingCount}`}); };
        if(times.length) {
          const samples=new Set([start-1,start,now]);for(let at=start;at<now;at+=step)samples.add(at);
          for(const at of [...data.settlements.filter(s=>!s.voided&&s.receivedAt).map(s=>new Date(s.receivedAt).getTime()),...data.refunds.map(f=>new Date(f.occurredAt).getTime())])if(at>=start&&at<=now)samples.add(at);
          for(const at of [...samples].sort((a,b)=>a-b))add(at);
        }
        result={points,targetRatioBps:ratio};
      } else if(req.method==="GET" && /^\/trades\/[^/]+$/.test(route)) {
        const id=uuid(route.split("/")[2]), data=await store.snapshot();
        const trade=project(data,{targetRatioBps:ratio}).rows.find(t=>t.id===id);
        if(!trade) throw new HttpError(404,"购买记录不存在");
        const end=url.searchParams.get("window")==="recent"?Date.now():Math.min(Date.now(),new Date(trade.boughtAt).getTime()+7*86400000);
        const start=url.searchParams.get("window")==="recent"?end-7*86400000:new Date(trade.boughtAt).getTime();
        result={trade,settlements:data.settlements.filter(s=>s.tradeId===id),refunds:data.refunds.filter(f=>f.tradeId===id),
          prices:data.prices.filter(p=>p.appid===trade.appid&&p.marketHashName===trade.marketHashName&&new Date(p.observedAt).getTime()>=start&&new Date(p.observedAt).getTime()<=end).sort((a,b)=>new Date(a.observedAt)-new Date(b.observedAt)),
          audit:(await store.pool.query("SELECT * FROM ledger_audit WHERE entity_id=$1 ORDER BY created_at DESC LIMIT 100",[id])).rows.map(row),start,end};
      } else if(req.method==="GET" && route==="/tasks") result=(await store.pool.query(url.searchParams.get('active')==='1'?"SELECT * FROM ledger_purchase_tasks WHERE state IN ('queued','executing','reconciling') ORDER BY created_at ASC LIMIT 200":"SELECT * FROM ledger_purchase_tasks ORDER BY created_at DESC LIMIT 200")).rows.map(row);
      else if(req.method==="GET" && route==="/wallet-events") result=(await store.pool.query("SELECT * FROM ledger_wallet_events ORDER BY occurred_at DESC")).rows.map(row);
      else if(req.method==="GET" && route==="/migration-issues") result=(await store.pool.query("SELECT key,value FROM ledger_meta WHERE key LIKE 'rejected-legacy:%'")).rows;
      else if(req.method==="POST" && route==="/trades") result=await store.createTrade(body);
      else if(req.method==="PATCH" && /^\/trades\/[^/]+$/.test(route)) result=await store.amendTrade(route.split("/")[2],body);
      else if(req.method==="POST" && /^\/trades\/[^/]+\/settlements$/.test(route)) result=await store.settle(route.split("/")[2],body);
      else if(req.method==="PATCH" && /^\/settlements\/[^/]+$/.test(route)) result=await store.amendSettlement(route.split("/")[2],body);
      else if(req.method==="POST" && /^\/trades\/[^/]+\/refunds$/.test(route)) result=await store.refund(route.split("/")[2],body);
      else if(req.method==="POST" && route==="/wallet-events") result=await store.walletEvent(body);
      else if(req.method==="PATCH" && /^\/wallet-events\/[^/]+$/.test(route)) result=await store.amendWallet(route.split("/")[2],body);
      else if(req.method==="POST" && route==="/prices") result=await store.addPrices(body.prices);
      else if(req.method==="POST" && route==="/migrate") result=await store.importLegacy(body.records);
      else if(req.method==="POST" && route==="/tasks") result=await store.task(body);
      else if(req.method==="GET" && /^\/tasks\/[^/]+$/.test(route)) result=await store.purchaseTask(route.split('/')[2]);
      else if(req.method==="POST" && /^\/tasks\/[^/]+\/claim$/.test(route)) result=await store.claimPurchase(route.split('/')[2],body);
      else if(req.method==="POST" && /^\/tasks\/[^/]+\/checkpoint$/.test(route)) result=await store.checkpointPurchase(route.split('/')[2],body);
      else if(req.method==="POST" && /^\/tasks\/[^/]+\/receipts$/.test(route)) result=await store.purchaseReceipt(route.split('/')[2],body);
      else if(req.method==="POST" && /^\/tasks\/[^/]+\/review$/.test(route)) result=await store.reviewPurchase(route.split('/')[2],body);
      else if(req.method==="PATCH" && /^\/tasks\/[^/]+$/.test(route)) result=await store.taskState(route.split("/")[2],body);
      else if(req.method==="POST" && route==="/sync/preview") result=await store.syncPreview(body.records);
      else if(req.method==="POST" && route==="/sync/confirm") result=await store.syncConfirm(body.rows);
      else if(req.method==="POST" && route==="/sync/buys/preview") result=await store.buySyncPreview(body.records);
      else if(req.method==="POST" && route==="/sync/buys/confirm") result=await store.buySyncConfirm(body.rows);
      else throw new HttpError(404,"接口不存在");
      send(res,200,{ok:true,result});
    } catch(error) {
      const status=error.status || (error.code==="23505"?409:500);
      if(status===500) console.error(new Date().toISOString(),"账本服务错误",error.code || error.name);
      send(res,status,{ok:false,error:status===500?"本地数据库暂不可用，请检查服务状态":error.message});
    }
  });
  server.requestTimeout=30000; server.headersTimeout=10000;
  return server;
}
async function main() {
  const file=path.resolve(__dirname,"../.ledger/config.json");
  if(!fs.existsSync(file)) throw new Error("请先运行 npm run setup -- --extension-id <扩展ID>");
  const config=JSON.parse(fs.readFileSync(file,"utf8"));
  const store=new Store(config.database); await store.migrate();
  const server=createServer({store,...config});
  server.listen(config.port || 3217,"127.0.0.1",()=>console.log(`本地交易账本已启动：127.0.0.1:${config.port || 3217}`));
  const stop=()=>server.close(()=>store.close().then(()=>process.exit(0)));
  process.on("SIGTERM",stop); process.on("SIGINT",stop);
}
if(require.main===module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={createServer,capabilities};
