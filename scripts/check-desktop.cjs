#!/usr/bin/env node
"use strict";
// Runs the packaged app against a disposable PostgreSQL database, not the user's ledger.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { PRODUCT_NAME } = require("../desktop/brand.cjs");
const { Store } = require("../server/store.cjs");
const { HistoryStore } = require("../server/history-store.cjs");

async function main() {
  const root = path.resolve(__dirname, "..");
  const development = process.argv.includes("--development");
  const applications = process.argv.includes("--applications");
  if (development && applications) throw new Error("开发模式不能同时验证应用程序入口");
  const distribution = development ? {} : JSON.parse(await fs.readFile(path.join(root, ".desktop-output/latest-app.json"), "utf8"));
  const bundle = applications ? distribution.applicationsShortcut : distribution.bundle;
  if (applications) {
    if (!bundle) throw new Error("请先运行 npm run desktop:package 创建应用程序入口");
    assert.equal(await fs.realpath(bundle), await fs.realpath(distribution.bundle), "应用程序入口应指向最新打包版本");
  }
  const executable = development ? require("electron") : path.join(bundle, `Contents/MacOS/${PRODUCT_NAME}`);
  await fs.access(executable);
  const name = `buff_goods_test_desktop_${process.pid}_${Date.now()}`;
  assert.match(name, /^buff_goods_test_desktop_\d+_\d+$/);
  const database = { host: process.env.PGHOST || "127.0.0.1", port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || os.userInfo().username, password: process.env.PGPASSWORD };
  const admin = new Client({ ...database, database: "postgres" });
  await admin.connect();
  const output = path.join(root, ".desktop-output", `verify-${Date.now()}`);
  const configFile = path.join(output, "config.json");
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  let child, store, created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`); created = true;
    store = new Store({ ...database, database: name }); await store.migrate();
    // Import archives into the disposable database. No confirmed ledger trades
    // are created, including for this synthetic verification fixture.
    const history = new HistoryStore(store.pool), fixture = require("../tests/fixtures/desktop-order-ledger.cjs").createFixture();
    await history.saveBuff({ revision: 0, data: fixture.buff });
    await history.saveUu({ revision: 0, data: fixture.uu });
    const steamFixture = require("../tests/fixtures/desktop-steam-orders.cjs"), { normalizePage } = require("../desktop/steam-orders.cjs");
    const steamRows = normalizePage(steamFixture.page([0,1].map(n => steamFixture.trade(n, {
      purchase: { currencyid: 2001, received_currencyid: 2001 },
      description: { name: "Steam 隔离验收物品", market_hash_name: "Steam Desktop Fixture" },
    }))), steamFixture.account.id, new Date().toISOString());
    const inventoryFixture = require("../tests/fixtures/steam-inventory.cjs");
    const craft = inventoryFixture.event({ accountId: steamFixture.account.id, key: `${steamFixture.account.id}:inventory:${"a".repeat(40)}` });
    await history.saveOrders("steam", { revision: 0, data: { version: 1, activeAccount: steamFixture.account.id, accounts: {
      [steamFixture.account.id]: { account: steamFixture.account, records: steamRows, inventoryHistory: inventoryFixture.archive([craft]), runs: ["buy","sell"].map(direction => ({ appid: 730, direction, channel: "history", complete: true, pages: 1, stopReason: "end", syncedAt: new Date().toISOString() })) },
    } } });
    assert.equal((await store.pool.query("SELECT count(*) FROM ledger_trades")).rows[0].count, "0");
    await store.close(); store = null;
    const reservation = net.createServer();
    await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    await fs.writeFile(configFile, JSON.stringify({ port, token: randomUUID(), extensionOrigins: [], database: { ...database, database: name } }), { mode: 0o600 });
    // Split fixtures by owner before launching. Generic CSV + native Steam
    // verification belongs to account 2; the accounting fixture belongs to 1.
    // This exercises real account isolation without a second ledger grouping.
    const profileDir = path.join(output, "profile");
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(profileDir, "preferences.json"), JSON.stringify({ accountProfiles: { version: 1, activeProfileId: "account-2", profiles: [
      { id: "account-1", name: "账户一", bindings: { buff: "buff:ledger-smoke", uu: "uu:ledger-smoke", steam: null }, csvScopes: [] },
      { id: "account-2", name: "账户二", bindings: { buff: development && process.argv.includes("--buff-orders-fixture") ? "buff:123" : null, uu: null, steam: steamFixture.account.id }, csvScopes: [] },
    ] } }), { mode: 0o600 });
    child = spawn(executable, [...(development ? [root] : []), "--smoke-test", "--order-ledger-fixture", ...(development && process.argv.includes("--buff-orders-fixture") ? ["--buff-orders-fixture"] : []), "--profile-dir", path.join(output, "profile"), "--ledger-config", configFile, "--smoke-output", output], { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
    let exitCode;
    try { exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("桌面版验收超时")); }, 90000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); resolve(code); });
    }); } finally { await fs.writeFile(path.join(output, "console.log"), log); }
    assert.equal(exitCode, 0, log);
    for (const reportName of ["smoke-result.json", "order-ledger-result.json"]) {
      let report;
      try { report = JSON.parse(await fs.readFile(path.join(output, reportName), "utf8")); }
      catch { throw new Error(`App 提前退出，未完成验收报告：${reportName}（${output}）`); }
      assert.equal(report.ok, true, reportName);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
    let stopped = false;
    try { await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(1500) }); } catch { stopped = true; }
    assert.equal(stopped, true, "App 自建账本服务应该随退出停止");
    store = new Store({ ...database, database: name });
    assert.equal((await store.pool.query("SELECT count(*) FROM ledger_trades")).rows[0].count, "0", "订单核算和验收不能创建已确认交易");
    await store.close(); store = null;
    const report = { ok: true, packagedApp: !development, ...(applications ? { applicationsShortcut: bundle } : {}), isolatedDatabase: true, autoStartedLocalService: true, serviceStoppedOnExit: true, productionWrites: false };
    await fs.writeFile(path.join(output, "lifecycle-result.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, output }));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (store) await store.close();
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
    await fs.rm(configFile, { force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
