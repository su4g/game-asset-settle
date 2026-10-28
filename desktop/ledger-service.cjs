"use strict";
// Reuses the existing schema and never provisions, migrates or replaces a database.
const { readConfig } = require("./runtime.cjs");
let store, server;
async function main() {
  const { Store } = require("../server/store.cjs");
  const { createServer } = require("../server/index.cjs");
  const config = await readConfig(process.argv[2]);
  store = new Store(config.database);
  await store.pool.query("SELECT 1");
  server = createServer({ store, token: config.token, extensionOrigins: config.extensionOrigins || [] });
  server.on("error", () => stop(1));
  server.listen(config.port, "127.0.0.1", () => process.parentPort?.postMessage({ ready: true }));
}
async function stop(code = 0) {
  server?.close(); server?.closeAllConnections();
  try { await store?.close(); } catch {}
  process.exit(code);
}
process.on("SIGTERM", () => stop());
main().catch(error => {
  process.parentPort?.postMessage({ error: `无法启动本机账本，请确认 PostgreSQL 正在运行且配置有效（${error.code || error.name}）` });
  stop(1);
});
