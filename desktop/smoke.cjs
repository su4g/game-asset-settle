"use strict";
// Exercises only bundled UI and read-only local ledger routes. Never visits platform websites.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

async function run(window, output) {
  await fs.mkdir(output, { recursive: true });
  const errors = [];
  window.webContents.on("console-message", (_event, ...args) => {
    const details = _event.message ? _event : args[0];
    if (typeof details === "object" && details.level === "error") errors.push(details.message);
  });
  const js = source => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`界面执行超时：${source.slice(0, 180)}`)), 10000);
    window.webContents.executeJavaScript(source).then(value => { clearTimeout(timeout); resolve(value); }, error => { clearTimeout(timeout); reject(error); });
  });
  async function waitFor(source, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { if (await js(source)) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`桌面验收等待超时：${source}`);
  }
  async function capture(name) {
    // macOS may occlude the restored test window while another app is active.
    // Keep painting only during capture; the hidden-window background check
    // still runs with the application's normal throttling policy.
    const throttled = window.webContents.getBackgroundThrottling();
    window.webContents.setBackgroundThrottling(false);
    try {
      await js("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      await new Promise(resolve => setTimeout(resolve, 300));
      await fs.writeFile(path.join(output, name), (await window.webContents.capturePage()).toPNG());
    } catch (error) { throw new Error(`截图 ${name} 失败：${error.message}`); }
    finally { window.webContents.setBackgroundThrottling(throttled); }
  }
  async function reload() {
    await new Promise(resolve => { window.webContents.once("did-finish-load", resolve); window.webContents.reload(); });
    await waitFor("document.documentElement.dataset.ready === 'true'");
  }
  async function selectProfile(id) {
    await new Promise((resolve, reject) => {
      window.webContents.once("did-finish-load", resolve);
      js(`void window.buffDesktop.request('profiles:select', {profileId:${JSON.stringify(id)}})`).catch(reject);
    });
    await waitFor("document.documentElement.dataset.ready === 'true'");
    const selected = await js("window.buffDesktop.request('profiles:status')");
    assert.equal(selected.activeProfileId, id);
  }
  await waitFor("document.documentElement.dataset.ready === 'true'");
  const runtime = await js("window.buffDesktop.request('status')");
  assert.equal(runtime.ledger.connected, true, `本机账本应可读取：${runtime.ledger.error || ""}`);
  assert.equal(runtime.platformConnected, false);
  const startup = await js("window.buffDesktop.request('startup:status')");
  assert.equal(startup.enabled, false, "隔离验收模式不能启动真实平台自动同步");
  if (process.argv.includes("--order-ledger-fixture")) assert.equal(startup.activeProfileId, "account-2", "一般 CSV 和原生 Steam 归属第二组隔离验收账户");
  assert.equal(await js("document.querySelector('[data-page=pricing], [data-page=selling]') === null"), true);
  const isolated = await js("({ require: typeof window.require, process: typeof window.process, keys: Object.keys(window.buffDesktop) })");
  assert.equal(isolated.require, "undefined"); assert.equal(isolated.process, "undefined");
  assert.deepEqual(isolated.keys.sort(), ["onChange", "request"]);
  assert(!JSON.stringify(runtime).includes('"token"'));
  await waitFor("[...document.querySelectorAll('.brand-mark, .platform-logo')].every(image => image.complete && image.naturalWidth > 0)");
  assert.equal(await js("document.title.includes('饰品交易账本')"), true);
  await capture("overview.png");
  await js("document.querySelector('[data-page=accounts]').click()");
  assert.equal(await js("document.getElementById('accountCloudCard').closest('section').id"), "page-accounts");
  await capture("accounts-sync.png");
  const { nativeTheme } = require("electron"), originalAppearance = nativeTheme.themeSource;
  try {
    nativeTheme.themeSource = "dark";
    await waitFor("matchMedia('(prefers-color-scheme: dark)').matches");
    await capture("accounts-sync-dark.png");
    await js("document.querySelector('[data-page=overview]').click()");
    await capture("overview-dark.png");
    window.setSize(1000, 800);
    window.webContents.setZoomFactor(1.15);
    assert.equal(await js("document.documentElement.scrollWidth <= innerWidth"), true, "放大文字后主体不应横向溢出");
    await capture("overview-large-text.png");
  } finally {
    window.webContents.setZoomFactor(1);
    window.setSize(1380, 900);
    nativeTheme.themeSource = originalAppearance;
  }
  await js("document.querySelector('[data-page=steam]').click(); window.SteamOrdersWorkspace.ready");
  await waitFor("document.querySelectorAll('#steamRows tr').length === 2");
  assert.match(await js("document.getElementById('steamRows').textContent"), /Steam 隔离验收物品/);
  assert.equal(await js("document.getElementById('steamSyncProgress').hidden"), true);
  for (const action of ["steam:login", "steam:check", "steam:start"]) {
    assert.equal(await js(`(async()=>{try{await window.buffDesktop.request(${JSON.stringify(action)});return false;}catch(e){return e.message.includes('不访问真实交易平台');}})()`), true);
  }
  await capture("steam-history.png");
  await js("document.getElementById('steamRows').scrollIntoView({block:'center'})");
  await capture("steam-history-rows.png");
  await js("document.getElementById('steamTitle').scrollIntoView({block:'start'})");
  window.setSize(1000,800);await capture("steam-history-narrow.png");
  assert.equal(await js("document.documentElement.scrollWidth <= innerWidth"), true);
  window.setSize(1380,900);
  await js("document.querySelector('[data-page=calculator]').click(); document.getElementById('exampleButton').click();");
  assert.equal(await js("document.getElementById('knifeResult').textContent"), "8.213 折");
  assert.equal(await js("document.getElementById('cashoutResult').textContent"), "6.964 折");
  await capture("calculator.png");
  await js("document.getElementById('buffBuyPrice').value = '49.00'; document.querySelector('#calculatorForm button[type=submit]').click()");
  assert.match(await js("document.getElementById('buyOrderResult').textContent"), /^6\.824 折/);
  await js("document.querySelector('[data-page=history]').click(); window.BuffHistoryWorkspace.ready");
  // Synthetic CSV only: exercise the real sandboxed File input, stored only in the disposable history database.
  const historySample = "Item Name,Game Name,Listed On,Acted On,Display Price,Price in Cents,Type,Market Name,App Id,Asset Id\nRelic Sword,Dota 2,2026/09/30,2026/10/01,¥ 0.62,62,purchase,Inscribed Relic Sword,570,1\nRelic Sword,Dota 2,2026/09/30,2026/10/31,¥ 0.63,63,purchase,Inscribed Relic Sword,570,2\nCase,Counter-Strike 2,2026/09/30,2026/10/21,¥ 1.00,100,sale,Case,730,3";
  async function upload(text, name) {
    await js(`(() => { const files = new DataTransfer(); files.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(name)}, {type:'text/csv'})); const input = document.getElementById('historyFile'); input.files = files.files; input.dispatchEvent(new Event('change')); })()`);
  }
  await upload(historySample, "界面验收.csv");
  await waitFor("window.BuffHistoryWorkspace.result()?.quantity === 3");
  assert.equal(await js("document.getElementById('historyTitle').textContent"), "CSV 归档");
  assert.equal(await js("document.getElementById('historyPlatform').value"), "steam");
  assert.equal(await js("document.getElementById('historyGame').value"), "all");
  await js("document.getElementById('historyGame').value='570'; document.getElementById('historyType').value='purchase'; document.getElementById('historyStart').value='2026-10-01'; document.getElementById('historyEnd').value='2026-10-31'; document.getElementById('historyType').dispatchEvent(new Event('change'))");
  assert.equal(await js("window.BuffHistoryWorkspace.result().quantity"), 2);
  assert.match(await js("document.getElementById('historyRows').textContent"), /铭刻 圣者遗物/);
  assert.match(await js("document.getElementById('historyRows').textContent"), /0\.63/);
  assert.match(await js("document.getElementById('historyMetrics').textContent"), /1\.25/);
  await capture("history.png");
  await js("document.getElementById('historyMetrics').scrollIntoView({block:'start'})");
  await capture("history-results.png");
  await js("window.scrollTo(0,0)");
  await js("document.querySelector('[data-history-action=details]').click()");
  assert.equal(await js("document.querySelectorAll('#historyRows tr').length"), 2);
  await js("document.getElementById('historyBack').click(); document.querySelector('[data-history-action=name]').click(); document.getElementById('historyChineseName').value='铭刻 圣者遗物'; document.querySelector('#historyNameForm button[type=submit]').click()");
  await waitFor("!document.getElementById('historyNameDialog').open");
  await upload("日期,物品名称,成交金额,数量\n2026-10-21 12:00:00,武器箱,12.35,2", "BUFF通用格式.csv");
  await waitFor("document.getElementById('historyMappingDialog').open");
  assert.equal(await js("document.getElementById('historyMapDefaultPlatform').value"), "steam");
  await capture("history-mapping.png");
  await js("document.getElementById('historyMapDefaultPlatform').value='buff'; document.getElementById('historyMapDefaultGame').value='730'; document.querySelector('#historyMappingForm button[type=submit]').click()");
  await waitFor("!document.getElementById('historyMappingDialog').open && window.BuffHistoryWorkspace.result()?.quantity === 3");
  assert.equal(await js("window.BuffHistoryWorkspace.result().rows.every(row=>row.platform==='steam')"), true);
  assert.match(await js("document.getElementById('historyMessage').textContent"), /已按原来源保存/);
  assert.equal(await js("(async()=>{ const archive=await window.buffDesktop.request('history:load'); return archive.rows.some(row=>row.platform==='buff'&&row.totalCents===1235&&row.quantity===2); })()"), true);
  window.setSize(1000, 800);
  await capture("history-narrow.png");
  assert.equal(await js("document.documentElement.scrollWidth <= innerWidth"), true, "窄窗口不应产生整页横向溢出");
  window.setSize(1380, 900);
  const refused = await js("(async () => { try { await window.buffDesktop.request('ledger', {path:'/tasks',method:'POST',body:{}}); return false; } catch { return true; } })()");
  assert.equal(refused, true, "未接入的购买执行接口必须拒绝");
  await js("document.querySelector('[data-page=ledger]').click(); document.getElementById('openLegacyLedger').click()");
  await waitFor("document.getElementById('ledgerFrame').contentDocument?.getElementById('connection')?.className === 'online'");
  await waitFor("document.getElementById('ledgerFrame').contentDocument?.getElementById('metrics')?.children.length === 6");
  assert.equal(await js("document.getElementById('ledgerFrame').contentDocument.getElementById('buySyncButton').disabled"), false);
  assert.equal(await js("document.getElementById('ledgerFrame').contentDocument.getElementById('pollPrices').disabled"), true);
  if (process.argv.includes("--order-ledger-fixture")) {
    await js("document.querySelector('[data-page=alchemy]').click(); window.BuffAlchemyWorkspace.refresh()");
    await waitFor("document.getElementById('alchemyRows').children.length === 1");
    assert.match(await js("document.getElementById('alchemyRows').textContent"), /10 件 → 1 件/);
    assert.equal(await js("(async()=>{try{await window.buffDesktop.request('steam:inventory',{mode:'full'});return false;}catch(e){return e.message.includes('不访问真实');}})()"), true);
    await js("document.querySelector('#alchemyRows details').open = true");
    await capture("alchemy-recipe.png");
    await selectProfile("account-1");
    await js("window.BuffAlchemyWorkspace.refresh()");
    assert.equal(await js("document.getElementById('alchemyRows').children.length"),0);
  }
  if (process.argv.includes("--order-ledger-fixture")) await selectProfile("account-1");
  await js("document.querySelector('[data-page=orders]').click(); window.BuffOrdersWorkspace.ready");
  const ledgerFixture = process.argv.includes("--order-ledger-fixture");
  const profileState = await js("window.buffDesktop.request('profiles:status')");
  assert.equal(profileState.activeProfileId, "account-1");
  const buffArchive = await js("window.buffDesktop.request('buff:list', {appid:730, channel:'history', direction:'all', page:1})");
  assert.equal(buffArchive.verified, false, "离线可见不代表已登录认证");
  assert.equal(buffArchive.rows.length, ledgerFixture ? 3 : 0);
  if (ledgerFixture) {
    assert.equal(profileState.profiles[0].bindings.buff, "buff:ledger-smoke");
    assert.equal(buffArchive.account.id, "buff:ledger-smoke");
    assert(buffArchive.rows.every(row => row.accountId === "buff:ledger-smoke"));
    assert.match(await js("document.getElementById('buffConnection').textContent"), /本机缓存.*待检查/);
  }
  assert.equal(await js("document.getElementById('buffRows').children.length"), buffArchive.rows.length);
  assert.equal(await js("document.getElementById('buffReviewBuys').disabled"), !ledgerFixture);
  if (!process.argv.includes("--buff-orders-fixture")) for (const action of ["buff:login", "buff:check", "buff:start"]) {
    assert.equal(await js(`(async()=>{try{await window.buffDesktop.request(${JSON.stringify(action)});return false;}catch(e){return e.message.includes('不访问真实交易平台');}})()`), true);
  }
  await capture("buff-orders.png");
  await js("document.querySelector('[data-page=uu]').click(); window.UuOrdersWorkspace.ready");
  assert.equal(await js("document.getElementById('uuRows').children.length"), 0);
  assert.equal(await js("document.getElementById('uuSellProbe').textContent"), "卖出历史待只读验证");
  for (const action of ["uu:login", "uu:check", "uu:start", "uu:probe-sell"]) {
    assert.equal(await js(`(async()=>{try{await window.buffDesktop.request(${JSON.stringify(action)});return false;}catch(e){return e.message.includes('不访问真实交易平台');}})()`), true);
  }
  if (ledgerFixture) {
    const uuArchive = await js("window.buffDesktop.request('uu:list', {appid:730, channel:'history', direction:'sell', page:1})");
    assert.equal(profileState.profiles[0].bindings.uu, "uu:ledger-smoke");
    assert.equal(uuArchive.account.id, "uu:ledger-smoke"); assert.equal(uuArchive.verified, false);
    assert.equal(uuArchive.rows.length, 2); assert(uuArchive.rows.every(row => row.accountId === "uu:ledger-smoke"));
    await js("document.getElementById('uuView').value='sell'; document.getElementById('uuView').dispatchEvent(new Event('change'))");
    await waitFor("document.getElementById('uuRows').children.length === 2");
    assert.match(await js("document.getElementById('uuConnection').textContent"), /本机缓存.*待检查/);
  }
  await capture("uu-orders.png");
  await js("document.querySelector('[data-page=orders]').click()");
  if (process.argv.includes("--buff-orders-fixture")) {
    // The simulated BUFF identity belongs to the other fixture account; it
    // must not replace account one's archived accounting identity.
    if (ledgerFixture) await selectProfile("account-2");
    await js("document.querySelector('[data-page=orders]').click(); window.BuffOrdersWorkspace.ready");
    assert.equal((await js("window.buffDesktop.request('buff:list', {appid:730, page:1})")).rows.length, 0);
    await js("document.getElementById('buffSync').click()");
    await waitFor("document.getElementById('buffJob').textContent.includes('已入库') && document.getElementById('buffRows').children.length === 2");
    assert.match(await js("document.getElementById('buffRows').textContent"), /2\.47/);
    assert.match(await js("document.getElementById('buffRows').textContent"), /2\.40/);
    await capture("buff-orders-synced.png");
    await js("document.getElementById('buffLegacyReview').open = true; document.getElementById('buffReviewBuys').click()");
    await waitFor("document.getElementById('ledgerFrame').contentDocument.querySelectorAll('[data-buy-index]').length === 1");
    assert.equal(await js("document.getElementById('ledgerFrame').contentDocument.querySelector('[data-buy-select]').checked"), false);
    await capture("buff-buy-review.png");
    await js("document.getElementById('ledgerFrame').contentDocument.getElementById('dialogClose').click(); document.querySelector('[data-page=orders]').click()");
    await waitFor("!document.getElementById('buffReviewSales').disabled");
    await js("document.getElementById('buffReviewSales').click()");
    await waitFor("document.getElementById('ledgerFrame').contentDocument.querySelectorAll('[data-sync-index]').length === 1");
    assert.equal(await js("document.getElementById('ledgerFrame').contentDocument.querySelector('[data-history=steam]').hidden"), true);
    await capture("buff-sale-review.png");
    await js("document.getElementById('ledgerFrame').contentDocument.getElementById('dialogClose').click(); document.querySelector('[data-page=orders]').click()");
    await js("document.getElementById('buffSummaryView').click()");
    await waitFor("document.getElementById('buffSummaryView').getAttribute('aria-pressed')==='true' && document.querySelectorAll('#buffRows [data-buff-group]').length > 0");
    assert.equal(await js("window.BuffHistoryWorkspace.result().rows.every(row=>row.platform==='steam')"), true);
    await js("document.getElementById('buffDetailView').click()");
    await js("document.querySelector('[data-page=orders]').click(); document.getElementById('buffGame').value='570'; document.getElementById('buffGame').dispatchEvent(new Event('change'))");
    await waitFor("document.getElementById('buffRows').children.length === 0");
    await js("document.getElementById('buffSync').click()");
    await waitFor("document.getElementById('buffJob').textContent.includes('已入库') && document.getElementById('buffRows').children.length === 2");
    await js("document.getElementById('buffLegacyReview').open = true; document.getElementById('buffReviewBuys').click()");
    await waitFor("document.getElementById('ledgerFrame').contentDocument.querySelectorAll('[data-buy-index]').length === 1");
    assert.equal(await js("document.getElementById('ledgerFrame').contentDocument.getElementById('buySyncGame').value"), "570");
    assert.match(await js("document.getElementById('ledgerFrame').contentDocument.querySelector('[data-buy-index]').textContent"), /Dota 2/);
    await js("document.getElementById('ledgerFrame').contentDocument.getElementById('dialogClose').click()");
  }
  await js("document.querySelector('[data-page=ledger]').click(); document.getElementById('openLegacyLedger').click()");
  await waitFor("document.getElementById('ledgerFrame').contentDocument?.getElementById('connection')?.className === 'online'");
  // Open and dismiss the actual purchase-record form, without submitting or writing anything.
  await js("document.getElementById('ledgerFrame').contentDocument.getElementById('manualButton').click()");
  assert.equal(await js("document.getElementById('ledgerFrame').contentDocument.getElementById('dialog').open"), true);
  await js("document.getElementById('ledgerFrame').contentDocument.getElementById('dialogClose').click()");
  await capture("ledger.png");
  await js("document.querySelector('[data-page=runtime]').click(); document.getElementById('startProbe').click();");
  await waitFor("document.getElementById('probeLabel').textContent === '检查中'");
  // Reload the UI during a running main-process task, then hide the native window.
  await reload();
  await js("document.querySelector('[data-page=runtime]').click()");
  window.hide();
  await waitFor("document.getElementById('probeLabel').textContent === '检查完成'", 45000);
  window.show();
  const probe = await js("window.buffDesktop.request('status')");
  assert.equal(probe.probe.successes, 6);
  await capture("runtime.png");
  await reload();
  if (process.argv.includes("--order-ledger-fixture")) await selectProfile("account-2");
  assert.equal(await js("document.getElementById('buffPrice').value"), "50.00");
  await js("window.BuffHistoryWorkspace.ready");
  assert.equal(await js("window.BuffHistoryWorkspace.result()?.quantity"), 3, "Steam 订单应在界面重载后恢复，其他平台归档不混入");
  await upload(historySample, "重新载入.csv");
  await waitFor("document.getElementById('historyMessage').textContent.includes('跳过 3')");
  assert.equal(await js("window.BuffHistoryWorkspace.result()?.quantity"), 3, "重复导入不新增 Steam 订单");
  await js("document.querySelector('[data-page=history]').click(); document.getElementById('historyNames').click()");
  await waitFor("document.getElementById('historyNamesDialog').open");
  assert.match(await js("document.getElementById('historyNamesRows').textContent"), /Inscribed Relic Sword/);
  await capture("history-names.png");
  await js("document.getElementById('historyNamesClose').click()");
  assert.match(await js("document.getElementById('historyRows').textContent"), /手动核对/);
  if (process.argv.includes("--order-ledger-fixture")) {
    await selectProfile("account-1");
    const firstCSV = await js("window.buffDesktop.request('history:load')");
    assert.equal(firstCSV.rows.length, 0, "第二组 CSV 不得显示在第一组");
    await require("./order-ledger-smoke.cjs").run({ window, js, waitFor, capture, reload, output });
  }
  const result = { ok: true, electron: runtime.electron, ledgerConnected: true,
    checks: ["Steam 原生历史离线展示、重启恢复与窄窗口", "Steam 登录/检查/同步在 smoke 中禁网", "隔离数据库连接", "桌面与账本界面加载", "手续费与三种折扣试算", "订单账本与二级历史账本入口", "Steam 订单 CSV 导入与日期/游戏/买卖筛选", "中文名核对与重复物品均价", "通用 CSV 原来源保存与 Steam 页面隔离", "Steam 订单持久化与重复导入去重", "1000px 窄窗口布局", "本机偏好恢复", "隐藏窗口后台检查", "未开放任务写入被拒绝", "界面无 Node 权限与账本令牌"], consoleErrors: errors };
  result.checks.push("账户一 BUFF/悠悠归档身份与离线行数", "未认证归档只读展示，三平台真实登录与同步禁网");
  if (process.argv.includes("--buff-orders-fixture")) result.checks.push("模拟 BUFF 买卖历史同步", "CS2 与 Dota 2 买入核对联通", "卖出批次核对联通（未提交）", "BUFF 本页汇总与 Steam 订单隔离", "模拟平台响应，不代表实站验收");
  await fs.writeFile(path.join(output, "smoke-result.json"), JSON.stringify(result, null, 2));
  if (errors.length) throw new Error(`界面出现错误：${errors.join("；")}`);
  console.log(JSON.stringify(result));
}
module.exports = { run };
