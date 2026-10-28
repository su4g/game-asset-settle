"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { BuffOrders, cents, instant, normalizeOrder, options, pageInfo } = require("../desktop/buff-orders.cjs");
const { navigationAllowed, resourceAllowed, createBuffSession } = require("../desktop/buff-session.cjs");
const { validateRequest, assetForUrl } = require("../desktop/runtime.cjs");
const B = require("../server/buy-sync.cjs"), S = require("../server/sync.cjs");
const goods = { "101": { name: "测试物品", market_hash_name: "Test Item", appid: 730 } };
const order = (extra = {}) => ({ id: "order-1", goods_id: 101, state: "SUCCESS", quantity: 2, price: "1.23", pay_amount: "2.47", seller_income: "2.40", pay_time: 1792548000, transact_time: 1792548000, created_at: 1792547900, ...extra });
const context = { accountId: "buff:123", appid: 730, direction: "buy", channel: "history", observedAt: "2026-10-21T00:00:00Z" };
const json = data => new Response(JSON.stringify({ code: "OK", data }), { headers: { "Content-Type": "application/json" } });
async function setup(t, responder) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-buff-")); t.after(() => fs.rm(dir, { force: true, recursive: true }));
  const calls = [], events = [], file = path.join(dir, "orders.json");
  const service = new BuffOrders({ file, interval: () => 0, notify: value => events.push(value), fetcher: async (url, init) => {
    calls.push({ url, init }); assert.equal(init.method, "GET"); assert.equal(init.credentials, "include"); assert.equal(init.redirect, "error"); assert.equal(new URL(url).origin, "https://buff.163.com");
    assert(!init.headers.Cookie); assert.equal(init.body, undefined);
    if (responder) { const value = await responder(new URL(url), init, calls); if (value) return value; }
    if (url.includes("/account/api/user/info")) return json({ user_id: "123", nickname: "测试账号", steamid: "76561198000000000", token: "NEVER-EXPOSE" });
    return json({ items: [order()], goods_infos: goods, total_page: 1, page_num: 1 });
  } });
  await service.ready;
  return { service, calls, events, file };
}
async function sync(service, value = {}) { await service.start({ appid: 730, direction: "buy", ...value }); await service.running; return service.snapshot(); }

test("金额用整数分；数量、状态、时间及账号不猜测，原始敏感字段不透传", () => {
  assert.equal(cents("0.29"), 29); assert.equal(cents("12.34"), 1234);
  for (const x of ["", null, "1.234", "1e2", "1,234", "-1", "9007199254740991"]) assert.equal(cents(x), null);
  const row = normalizeOrder(order({ cookies: "secret", token: "secret" }), goods, context);
  assert.equal(row.grossTotalCents, 246); assert.equal(row.paidTotalCents, 247); assert.equal(row.netTotalCents, 240); assert.equal(row.completed, true);
  assert.equal(JSON.stringify(row).includes("secret"), false);
  const unknown = normalizeOrder(order({ state: "99", pay_amount: undefined, seller_income: undefined, quantity: undefined, pay_time: undefined, transact_time: undefined }), goods, context);
  assert.equal(unknown.quantity, null); assert.equal(unknown.paidTotalCents, null); assert.equal(unknown.netTotalCents, null); assert.equal(unknown.tradedAt, null); assert.equal(unknown.completed, false);
  assert.equal(normalizeOrder(order({ quantity: undefined, asset_info: { assetid: "1" } }), goods, context).quantity, 1);
  assert.equal(normalizeOrder(order({ currency: "USD" }), goods, context).paidTotalCents, null);
  assert.throws(() => normalizeOrder(order({ id: 9007199254740992 }), goods, context), /订单号/);
  assert.throws(() => normalizeOrder(order({ buyer_id: "124" }), goods, context), /账号/);
  assert.throws(() => normalizeOrder(order({ appid: 570 }), goods, context), /游戏/);
  assert.equal(instant("2026-02-30 10:00:00"), null); assert.equal(instant("2026-10-20 10:00:00"), "2026-10-20T02:00:00.000Z");
});

test("BUFF 完成买单按已核验实价加支付通道费恢复实付，不用标价或买方占位收入", () => {
  const sample = order({ quantity: 1, price: "20.00", pay_amount: null, seller_income: "0", real_price: "19.00", pay_channel_fee: "0.12", price_with_pay_fee: "19.12" });
  const row = normalizeOrder(sample, goods, context);
  assert.equal(row.grossTotalCents, 2000); assert.equal(row.paidTotalCents, 1912); assert.equal(row.netTotalCents, 0);
  assert.equal(normalizeOrder({ ...sample, price_with_pay_fee: null }, goods, context).paidTotalCents, 1912);
  assert.equal(normalizeOrder({ ...sample, real_price: null, pay_channel_fee: null }, goods, context).paidTotalCents, 1912);
  assert.equal(normalizeOrder({ ...sample, price_with_pay_fee: null, pay_channel_fee: null }, goods, context).paidTotalCents, null);
  assert.equal(normalizeOrder({ ...sample, quantity: 2 }, goods, context).paidTotalCents, null);
  assert.equal(normalizeOrder({ ...sample, state: "TO_PAY" }, goods, context).paidTotalCents, null);
  assert.equal(normalizeOrder(sample, goods, { ...context, direction: "sell" }).paidTotalCents, null);
  assert.throws(() => normalizeOrder({ ...sample, price_with_pay_fee: "19.13" }, goods, context), /实付金额字段不一致/);
});

test("读取两页后去重保存，重复同步更新同订单，重启不会伪装为已登录", async t => {
  let paid = "2.47";
  const { service, file, events } = await setup(t, url => {
    if (url.pathname.includes("/history")) return json({ items: [order({ id: "order-" + url.searchParams.get("page_num"), pay_amount: paid })], goods_infos: goods, total_page: 2, page_num: Number(url.searchParams.get("page_num")) });
  });
  assert.equal((await sync(service)).job.status, "completed"); assert.equal((await service.list()).total, 2);
  paid = "2.50"; await sync(service);
  assert.equal((await service.list()).total, 2); assert.equal((await service.list()).rows[0].paidTotalCents, 250);
  assert(!JSON.stringify(events).includes("NEVER-EXPOSE"));
  const again = new BuffOrders({ file, fetcher: () => assert.fail("restoring cache never requests platform") }); await again.ready;
  assert.equal(again.verified, false); assert.equal((await again.list()).total, 2);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("买卖分开去重，未完成记录不进入账本预览；同步本身不记账", async t => {
  const { service } = await setup(t, url => {
    if (url.pathname.includes("/history")) return json({ items: [order(), order({ id: "unpaid", state: "TO_PAY" }), order({ id: "new-status", state: "999" })], goods_infos: goods, total_page: 1 });
  });
  await sync(service, { direction: "all" });
  assert.equal((await service.list()).total, 6);
  const buys = await service.collect({ direction: "buy", appid: 730 }); assert.equal(buys.records.length, 1);
  const preview = B.preview(buys.records, []); assert.equal(preview[0].status, "review"); assert.equal(preview[0].source.buyTotalCents, 247);
  const sales = await service.collect({ direction: "sell" }); assert.equal(sales.records.length, 1); assert.equal(sales.records[0].netTotalCents, 240);
  assert.equal(S.sourceKey(sales.records[0]), S.sourceKey({ ...sales.records[0], netTotalCents: 500 }));
  assert.equal((await service.collect({ direction: "buy", keys: [] })).records.length, 0);
  assert.equal((await service.list({ query: "order-1" })).total, 2);
});

test("读取全部分页；空列表、重复页和格式错误不当作成功覆盖", async t => {
  let mode = "normal";
  const { service, file } = await setup(t, url => {
    if (!url.pathname.includes("/history")) return;
    const page = Number(url.searchParams.get("page_num"));
    if (mode === "invalid") return json({ items: "bad" });
    if (mode === "empty") return json({ items: [], total_page: 3, page_num: page });
    return json({ items: [order({ id: mode === "repeat" ? "same" : "order-" + page })], goods_infos: goods, total_page: 3, page_num: page });
  });
  const full = await sync(service, { maxPages: 1 }); assert.equal(full.job.status, "completed"); assert.equal(full.runs[0].complete, true); assert.equal(full.job.pages,3);
  const before = await fs.readFile(file, "utf8");
  for (mode of ["invalid", "empty", "repeat"]) {
    assert.equal((await sync(service)).job.status, "failed"); assert.equal(await fs.readFile(file, "utf8"), before);
  }
});

test("账号切换隔离历史；同步途中切换账号时整次不保存", async t => {
  let id = "123", switched = false;
  const { service, file } = await setup(t, url => {
    if (url.pathname.includes("/user/info")) return json({ user_id: id, nickname: "账号" + id });
    if (switched) id = "789";
  });
  await sync(service); id = "456"; await service.check(); assert.equal((await service.list()).total, 0);
  await sync(service); assert.equal((await service.list()).total, 1);
  const before = await fs.readFile(file, "utf8"); switched = true;
  assert.equal((await sync(service)).job.status, "failed"); assert.equal(await fs.readFile(file, "utf8"), before);
  assert.equal((await service.list()).total, 0);
  id = "123"; switched = false; await service.check(); assert.equal((await service.list()).total, 1);
});

test("停止请求会中断网络，迟到结果不能覆盖历史；禁止并行同步", async t => {
  let hold = false, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const { service, file } = await setup(t, async (url, init) => {
    if (hold && url.pathname.includes("/history")) { reached(); await new Promise(resolve => init.signal.addEventListener("abort", resolve, { once: true })); return json({ items: [order({ id: "late" })], goods_infos: goods, total_page: 1 }); }
  });
  await sync(service); const before = await fs.readFile(file, "utf8"); hold = true;
  await service.start({ appid: 730, direction: "buy" }); await waiting;
  await assert.rejects(service.start({}), /进行中/); service.stop(); await service.running;
  assert.equal(service.job.status, "cancelled"); assert.equal(await fs.readFile(file, "utf8"), before);
});

test("登录失效与限流区别处理，Retry-After 持久化，不自动重试", async t => {
  let mode = "login";
  const { service, calls, file } = await setup(t, () => mode === "login" ? new Response('{"code":"Login Required"}') : new Response("", { status: 429, headers: { "Retry-After": "120" } }));
  await assert.rejects(service.check(), /登录/); assert.equal(service.verified, false);
  mode = "limit"; const now = Date.now(); await sync(service);
  assert.equal(service.job.status, "failed"); assert(service.data.cooldownUntil >= now + 120000);
  const count = calls.length; await sync(service); assert.equal(calls.length, count);
  const cache = JSON.parse(await fs.readFile(file)); assert.equal(cache.cooldownUntil, service.data.cooldownUntil);
});

test("未知字段与参数失败关闭；登录窗口无本机资源和后台通道", () => {
  for (const value of [{ appid: "730" }, { channel: "buy" }]) assert.throws(() => options(value));
  assert.throws(() => pageInfo({ items: [], total_page: 5 }, 1), /分页/);
  assert(navigationAllowed("https://buff.163.com/account/login")); assert(navigationAllowed("https://steamcommunity.com/openid/login"));
  for (const url of ["http://buff.163.com/", "https://buff.163.com.evil.test/", "https://user:pass@buff.163.com/", "buff-desktop://app/desktop/index.html", "https://127.0.0.1/", "https://steamcommunity.com/tradeoffer/new/"]) assert.equal(navigationAllowed(url), false);
  assert(resourceAllowed("https://cstaticdun.126.net/captcha.js")); assert.equal(resourceAllowed("http://localhost:3217/v1/trades"), false);
  assert.equal(assetForUrl("buff-desktop://app/desktop/buff-orders.cjs"), null);
  assert.equal(validateRequest({ path: "/sync/buys/preview", method: "POST", body: { records: [] } }).method, "POST");
  assert.throws(() => validateRequest({ path: "/tasks", method: "POST", body: {} }));
});

test("只读请求的会话轮换不中断；登录窗口变更、删除和到期仍取消", () => {
  let changed, invalidations = 0;
  const ses = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {},
    webRequest: { onBeforeRequest() {} }, cookies: { on(_event, callback) { changed = callback; } } };
  class LoginWindow extends require("node:events").EventEmitter {
    constructor() { super(); this.webContents = { setWindowOpenHandler() {}, on() {} }; this.destroyed = false; }
    isDestroyed() { return this.destroyed; }
    loadURL() { return Promise.resolve(); }
    show() {} focus() {}
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const session = createBuffSession({ session: { fromPartition: () => ses }, BrowserWindow: LoginWindow, parent: () => null, onSessionChange: () => invalidations++ });
  const cookie = { name: "session", domain: ".buff.163.com" };
  changed({}, cookie, "overwrite", true);
  changed({}, cookie, "inserted-no-value-change-overwrite", false);
  changed({}, cookie, "inserted-no-change-overwrite", false);
  changed({}, cookie, "inserted", false);
  changed({}, { ...cookie, domain: "unrelated.example" }, "inserted", false);
  assert.equal(invalidations, 0);
  session.open(); changed({}, cookie, "inserted", false);
  assert.equal(invalidations, 1);
  session.close(); changed({}, cookie, "inserted", false);
  assert.equal(invalidations, 1);
  for (const cause of ["explicit", "expired", "expired-overwrite", "evicted"]) changed({}, cookie, cause, true);
  assert.equal(invalidations, 5);
});

test("待发货无分页信息时保存当前快照，空快照清理旧待发货而保留历史", async t => {
  let empty = false;
  const { service, calls } = await setup(t, url => {
    if (url.pathname.endsWith("to_deliver")) return json({ items: empty ? [] : [order({ state: "TO_DELIVER" })], goods_infos: goods });
  });
  await sync(service);
  assert.equal((await sync(service, { channel: "pending" })).job.status, "completed");
  assert.equal(calls.filter(call => call.url.includes("to_deliver")).length, 1);
  assert.equal((await service.list({ channel: "pending" })).total, 1);
  empty = true; await sync(service, { channel: "pending" });
  assert.equal((await service.list({ channel: "pending" })).total, 0); assert.equal((await service.list({ channel: "history" })).total, 1);
});

test("同订单物品冲突不覆盖缓存；未知币种不混入人民币账本", async t => {
  let conflict = false;
  const { service, file } = await setup(t, url => {
    if (url.pathname.endsWith("history")) return json({ items: [order({ goods_id: conflict ? 102 : 101 }), order({ id: "usd", currency: "USD" })], goods_infos: { ...goods, "102": { appid: 730, name: "另一物品", market_hash_name: "Other Item" } }, total_page: 1 });
  });
  await sync(service); assert.equal((await service.collect({ direction: "buy" })).records.length, 1);
  const before = await fs.readFile(file, "utf8"); conflict = true;
  assert.equal((await sync(service)).job.status, "failed"); assert.match(service.job.message, /冲突/); assert.equal(await fs.readFile(file, "utf8"), before);
});

test("增量同步在连续已知页停止；较旧未完成订单仍复查，完整复核可补齐旧历史", async t => {
  let changed = false;
  const { service, calls } = await setup(t, url => {
    if (!url.pathname.includes("/history")) return;
    const page = Number(url.searchParams.get("page_num"));
    return json({ items: [order({ id: `page-${page}`, state: page === 4 && !changed ? "TO_DELIVER" : "SUCCESS" })], goods_infos: goods, total_page: 6, page_num: page });
  });
  await sync(service); assert.equal(service.job.pages,6);
  // Simulate a cache produced by the old version's two-page cap.
  const saved = service.data.accounts["buff:123"]; saved.records = saved.records.filter(r => /page-[12]$/.test(r.orderId)); saved.runs[0].complete = false;
  let start = calls.length;
  await sync(service, {});
  assert.equal(service.job.pages, 6); assert.equal(service.snapshot().runs[0].stopReason, "end"); assert.equal(service.snapshot().runs[0].complete, true);
  await sync(service, { mode: "full" }); assert.equal((await service.list()).total,6);
  changed = true; start = calls.length;
  await sync(service, {}); assert.equal(service.job.pages,6); assert.equal(service.job.updated,1);
  const before = (await service.list()).rows.map(r=>[r.key,r.observedAt,r.tradedAt]);
  await sync(service, {}); assert.equal(service.job.pages,2); assert.equal(service.job.inserted,0); assert.equal(service.job.updated,0); assert.equal(service.job.skipped,2);
  assert.deepEqual((await service.list()).rows.map(r=>[r.key,r.observedAt,r.tradedAt]),before);
});

test("BUFF 完整同步穿过第 500 页直到平台末页",async t=>{
 const {service}=await setup(t,url=>url.pathname.endsWith("history")?json({items:[order({id:"page-"+url.searchParams.get("page_num")})],goods_infos:goods,total_page:501,page_num:Number(url.searchParams.get("page_num"))}):undefined);
 const result=await sync(service,{mode:"full"});assert.equal(result.job.pages,501);assert.equal(result.job.inserted,501);assert.equal(result.runs[0].complete,true);
});

test("已失败退款订单不阻止增量边界；未知状态继续复查，完整复核仍遍历末页", async t => {
  let finalState = "FAIL";
  const { service } = await setup(t, url => {
    if (!url.pathname.endsWith("history")) return;
    const page = Number(url.searchParams.get("page_num"));
    return json({ items: [order({ id: `page-${page}`, state: page === 5 ? finalState : "SUCCESS", state_text: page === 5 ? "购买失败-已退款" : "购买成功" })], goods_infos: goods, total_page: 6, page_num: page });
  });
  await sync(service, { mode: "full" }); assert.equal(service.job.pages, 6);
  const failed = service.data.accounts["buff:123"].records.find(row => row.state === "FAIL");
  assert.equal(failed.completed, false);
  await sync(service); assert.equal(service.job.pages, 2); assert.equal(service.snapshot().runs[0].stopReason, "known");
  await sync(service, { mode: "full" }); assert.equal(service.job.pages, 6);
  finalState = "NEW_UNRESOLVED_STATE";
  await sync(service, { mode: "full" }); await sync(service);
  assert.equal(service.job.pages, 5); assert.equal(service.snapshot().runs[0].stopReason, "known");
});
