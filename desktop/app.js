"use strict";
const $ = id => document.getElementById(id);
const api = (action, payload) => window.buffDesktop.request(action, payload);
const common = window.BuffHelperCommon;
const money = value => value == null ? "—" : common.formatCents(value, "CNY");
const pages = { overview: "总览", orders: "BUFF 订单", uu: "悠悠订单", ledger: "交易账本", report: "收益报告", alchemy: "已完成炼金", steam: "Steam 订单", history: "CSV 归档", calculator: "收益试算", accounts: "账户与同步", runtime: "运行状态" };
let currentPage = "overview";
let latestStatus;
let statusSequence = 0;

function notice(message = "") { $("appNotice").textContent = message; $("appNotice").hidden = !message; }
function navigate(page) {
  if (!pages[page]) return;
  currentPage = page;
  window.scrollTo({ top: 0, behavior: "instant" });
  for (const name of Object.keys(pages)) $("page-" + name).hidden = name !== page;
  for (const button of document.querySelectorAll("[data-page]")) {
    const active = button.dataset.page === page;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  }
  $("pageLabel").textContent = pages[page];
  document.title = `${pages[page]} · 饰品交易账本`;
  if (page === "overview") refreshOverviewReport().catch(error => notice(error.message));
  if (page === "ledger") window.BuffOrderLedgerWorkspace.refresh().catch(error => notice(error.message));
  if (page === "report") window.BuffProfitReport.refresh().catch(error => notice(error.message));
  document.querySelector(`#page-${page} h1`)?.focus({ preventScroll: true });
  if (page === "accounts") window.BuffOrderLedgerWorkspace.refreshStartup().catch(error => notice(error.message));
  if (page === "runtime") refreshStatus().catch(error => notice(error.message));
  if (page === "alchemy") window.BuffAlchemyWorkspace.refresh().catch(error => notice(error.message));
  if (page === "steam") window.SteamOrdersWorkspace.refresh().catch(error => notice(error.message));
  if (page === "uu") window.UuOrdersWorkspace.refresh().catch(error => notice(error.message));
  if (page === "orders") window.BuffOrdersWorkspace.refresh().catch(error => notice(error.message));
}
window.BuffDesktopNavigation = { navigate };
for (const button of document.querySelectorAll("[data-page], [data-go]")) button.addEventListener("click", () => navigate(button.dataset.page || button.dataset.go));

function detailList(element, entries) {
  element.replaceChildren(...entries.map(([label, value]) => {
    const row = document.createElement("div"), dt = document.createElement("dt"), dd = document.createElement("dd");
    dt.textContent = label; dd.textContent = value ?? "—"; row.append(dt, dd); return row;
  }));
}
function renderStatus(value) {
  latestStatus = value;
  $("connectionPill").textContent = value.ledger.connected ? "账本已连接" : "账本未连接";
  $("connectionPill").classList.toggle("offline", !value.ledger.connected);
  $("sidebarStatus").textContent = value.ledger.connected ? "账本连接正常" : "手动试算可用";
  const minutes = Math.floor(value.uptimeMs / 60000), seconds = Math.floor(value.uptimeMs / 1000) % 60;
  $("overviewRuntime").textContent = `已运行 ${minutes} 分 ${seconds} 秒 · ${value.ledger.connected ? "本机账本连接正常" : "账本尚未连接，手动试算仍可使用"}`;
  detailList($("runtimeDetails"), [["版本", value.version], ["运行时长", `${minutes} 分 ${seconds} 秒`], ["后台进程", String(value.pid)], ["Electron / Chromium", `${value.electron} / ${value.chromium.split(".")[0]}`], ["数据目录", value.dataDir]]);
  detailList($("ledgerDetails"), [["连接状态", value.ledger.connected ? "已连接" : "未连接"], ["数据库", value.ledger.database || "—"], ["服务来源", value.managedService ? "随桌面版启动" : value.ledger.connected ? "已有本机服务" : "待连接"], ["配置文件", value.configFile || "未选择"]]);
  if (!value.ledger.connected) notice(value.ledger.error);
  renderProbe(value.probe);
}
function renderProbe(value) {
  const labels = { idle: "未开始", running: "检查中", completed: "检查完成", failed: "连接异常", cancelled: "已停止" };
  $("probeLabel").textContent = labels[value.status] || value.status;
  $("probeProgress").value = value.completed;
  $("probeProgress").max = value.total;
  $("startProbe").disabled = value.status === "running";
  $("stopProbe").disabled = value.status !== "running";
  $("probeDetail").textContent = value.status === "idle" ? "只检查本机连接，不读取交易平台。" : `${value.completed} / ${value.total} 次已完成 · ${value.successes} 次连接成功${value.issue ? " · " + value.issue : ""}`;
}
async function refreshLogs() {
  const logs = await api("logs");
  $("runtimeLogs").replaceChildren(...logs.slice().reverse().map(entry => {
    const li = document.createElement("li"), time = document.createElement("time"), text = document.createElement("span");
    time.dateTime = new Date(entry.at).toISOString(); time.textContent = new Date(entry.at).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    text.textContent = entry.message; if (entry.level === "error") text.className = "error"; li.append(time, text); return li;
  }));
}
async function refreshStatus() {
  const sequence = ++statusSequence;
  const value = await api("status");
  if (sequence === statusSequence) renderStatus(value);
  await refreshLogs();
  return value;
}
function metric(label, value, subtitle, { incomplete = false, signed = false } = {}) {
  const card = document.createElement("div"), name = document.createElement("span"), amount = document.createElement("strong"), sub = document.createElement("small");
  card.className = "metric"; name.className = "metric-label";
  name.textContent = label; sub.textContent = subtitle;
  amount.textContent = incomplete ? "待补全" : (signed && value > 0 ? "+" : "") + money(value);
  if (incomplete) amount.className = "incomplete";
  else if (signed && value) amount.className = value > 0 ? "gain" : "loss";
  card.append(name, amount, sub); return card;
}
function renderSummary(result) {
  if (!result?.report) { $("overviewMetrics").replaceChildren(); $("overviewCharts").replaceChildren(); $("overviewWallet").replaceChildren(); $("overviewQuality").textContent = "连接本机订单后查看收益报告。"; return; }
  const report = result.report, charts = document.defaultView.BuffReportCharts;
  charts.metrics($("overviewMetrics"), report); charts.wallets($("overviewWallet"),report); charts.render($("overviewCharts"), report, report.groups, { compact: true });
  const incomplete = ["buff", "uu", "steam"].flatMap(name => result.sourceStatus?.[name]?.accounts || []).flatMap(a => a.runs || []).filter(r => !r.complete).length;
  $("overviewQuality").textContent = `${report.quality.unknownAmountCount || 0} 笔金额缺项 · ${report.quality.missingTimeCount || 0} 笔成交时间缺项。` + (incomplete ? `${incomplete} 个订单范围历史未齐，需补全历史。` : "按已保存的订单与价格核对记录汇总。") + "净卖出与持仓单独列示，不按零成本计利润。";
  $("overviewUpdated").textContent = "与收益报告、交易账本统一口径；多币种分别统计。历史加权挂刀折扣用于提现收益核算，不代表当前钱包余额成本。";
}
let overviewSequence = 0;
async function refreshOverviewReport() {
  const run = ++overviewSequence;
  try {
    const report = await api("profit-report:load", { portfolioId: $("overviewPortfolio").value, dateFrom: $("overviewStart").value, dateTo: $("overviewEnd").value });
    if (run !== overviewSequence) return;
    const select = $("overviewPortfolio"), selected = select.value, names = new Map((report.accountLinks || []).map(l => [l.id,l.name || l.id]));
    for (const a of report.accounts) if (!names.has(a.portfolioId)) names.set(a.portfolioId,a.label);
    select.replaceChildren(...[["all","全部账户（分别核算）"], ...names].map(([v,text]) => { const o = document.createElement("option"); o.value = v; o.textContent = text; return o; }));
    if ([...select.options].some(o => o.value === selected)) select.value = selected;
    renderSummary({ report, sourceStatus: report.sourceStatus });
  } catch (e) { if (run === overviewSequence) { renderSummary(null); notice(e.message); } throw e; }
}
async function refreshOverview() {
  const status = await refreshStatus(); await window.BuffOrderLedgerWorkspace.refreshStartup();
  if (!status.ledger.connected) { renderSummary(null); return; }
  await window.BuffOrderLedgerWorkspace.refresh(); await refreshOverviewReport();
}
for (const id of ["overviewPortfolio","overviewStart","overviewEnd"]) $(id).addEventListener("change", () => refreshOverviewReport().catch(() => {}));
$("overviewAllDates").addEventListener("click", () => { $("overviewStart").value = ""; $("overviewEnd").value = ""; refreshOverviewReport().catch(() => {}); });
async function action(button, fn) {
  button.disabled = true; notice();
  try { await fn(); } catch (error) { notice(error.message); } finally { button.disabled = false; }
}
$("refreshOverview").addEventListener("click", event => action(event.currentTarget, refreshOverview));
$("reconnectButton").addEventListener("click", event => action(event.currentTarget, async () => { renderStatus(await api("service:connect")); await refreshLogs(); }));
$("selectConfig").addEventListener("click", event => action(event.currentTarget, () => api("config:select")));
$("startProbe").addEventListener("click", async () => { try { renderProbe(await api("probe:start")); } catch (error) { notice(error.message); } });
$("stopProbe").addEventListener("click", async () => { try { renderProbe(await api("probe:stop")); } catch (error) { notice(error.message); } });

function inputCents(value) {
  return window.BuffDesktopPricing.cents(value);
}
function draft() { return Object.fromEntries(["game", "buffPrice", "steamPrice", "buffBuyPrice", "buffFee"].map(id => [id, $(id).value])); }
function calculate() {
  $("calculatorError").hidden = true;
  try {
    const inputs = draft();
    const buff = inputCents(inputs.buffPrice), steam = inputCents(inputs.steamPrice), fee = Number(inputs.buffFee);
    if (inputs.buffFee === "" || !Number.isFinite(fee) || fee < 0 || fee > 100) throw new Error("手续费应在 0% 到 100% 之间");
    const bid = window.BuffDesktopPricing.cents(inputs.buffBuyPrice, true);
    const value = common.calculateMarketRatios({ buffPriceCents: buff, buffBuyPriceCents: bid, steamLowestSellCents: steam, buffSellFeePercent: fee });
    if (value.steamNetSellCents == null) throw new Error("Steam 含费买价不能低于 0.03 元的最低费用边界");
    const result = $("calculatorResult");
    result.replaceChildren();
    const label = document.createElement("div"); label.className = "section-kicker"; label.textContent = `${inputs.game === "570" ? "Dota 2" : "CS2"} · 人民币试算`;
    const ratios = document.createElement("div"); ratios.className = "result-main";
    for (const [name, ratio, hint, id] of [["挂刀折扣", value.knifeRatio, "BUFF 成本 / Steam 净到账", "knifeResult"], ["提现折扣", value.cashoutRatio, "BUFF 净到账 / Steam 含费买价", "cashoutResult"]]) {
      const column = document.createElement("div"), p = document.createElement("p"), strong = document.createElement("strong"), small = document.createElement("small");
      p.textContent = name; strong.id = id; strong.textContent = ratio == null ? "不可计算" : `${(ratio * 10).toFixed(3)} 折`; small.textContent = hint; column.append(p, strong, small); ratios.append(column);
    }
    const details = document.createElement("dl"); details.className = "detail-list";
    detailList(details, [["Steam 含费买价", money(steam)], ["Steam 预计总手续费", money(value.steamFeeCents)], ["Steam 预计净到账", money(value.steamNetSellCents)], ["BUFF 预计出售手续费", money(value.buffSellFeeCents)], ["BUFF 预计净到账", money(value.buffNetSellCents)]]);
    if (bid != null) {
      const buyDetails = document.createElement("div");
      const name = document.createElement("dt"), amount = document.createElement("dd");
      name.textContent = "BUFF 求购提现折扣"; amount.id = "buyOrderResult";
      amount.textContent = `${value.buyOrderCashoutRatio == null ? "不可计算" : (value.buyOrderCashoutRatio * 10).toFixed(3) + " 折"} · 净到账 ${money(value.buffBuyNetCents)}`;
      buyDetails.append(name, amount); details.append(buyDetails);
    }
    const caption = document.createElement("p"); caption.className = "result-caption"; caption.textContent = "手动报价 · 未联网查价 · 未写入账本";
    result.append(label, ratios, details, caption);
    api("storage:set", { calculatorDraft: inputs }).catch(error => notice(error.message));
    window.BuffPriceWorkspace.updateFee(inputs.game, fee).catch(error => notice(error.message));
  } catch (error) { $("calculatorResult").replaceChildren(); $("calculatorError").textContent = error.message; $("calculatorError").hidden = false; }
}
$("calculatorForm").addEventListener("submit", event => { event.preventDefault(); calculate(); });
$("exampleButton").addEventListener("click", () => { $("buffPrice").value = "50.00"; $("steamPrice").value = "70.00"; $("buffFee").value = "2.5"; calculate(); });
function invalidateCalculator() {
  if ($("knifeResult")) { $("calculatorResult").textContent = "报价或手续费已变更，请重新计算。"; $("calculatorError").hidden = true; }
}
$("calculatorForm").addEventListener("input", invalidateCalculator);
function updateCalculatorFee() {
  const value = String(common.getBuffSellFeePercent(Number($("game").value), window.BuffPriceWorkspace.settings()));
  if ($("buffFee").value !== value) invalidateCalculator();
  $("buffFee").value = value;
}
$("game").addEventListener("change", () => { invalidateCalculator(); updateCalculatorFee(); });
window.addEventListener("price-settings-changed", updateCalculatorFee);

let overviewRefreshTimer;
window.buffDesktop.onChange(event => {
  if (["history", "order-ledger", "connection", "account-profiles"].includes(event.kind) || ["buff-orders", "uu-orders", "steam-orders"].includes(event.kind) && event.value?.job?.status !== "running") { clearTimeout(overviewRefreshTimer); overviewRefreshTimer = setTimeout(() => refreshOverviewReport().catch(() => {}), 400); }
  if (event.kind === "probe") renderProbe(event.value);
  if (event.kind === "log") refreshLogs().catch(() => {});

});
function updateClock() { $("clock").textContent = new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "short" }); }
updateClock(); setInterval(updateClock, 60000);
setInterval(() => { if (!document.hidden) refreshStatus().catch(error => notice(error.message)); }, 30000);
async function init() {
  await window.BuffPriceWorkspace.ready;
  const saved = await api("storage:get", ["calculatorDraft"]);
  if (saved.calculatorDraft) for (const id of ["game", "buffPrice", "steamPrice", "buffBuyPrice"]) if (typeof saved.calculatorDraft[id] === "string") $(id).value = saved.calculatorDraft[id];
  updateCalculatorFee();
  await refreshOverview();
  document.documentElement.dataset.ready = "true";
}
init().catch(error => { renderSummary(null); notice(error.message); document.documentElement.dataset.ready = "error"; });
