"use strict";
// Verifies only this service. Never logs private configuration or response bodies.
const fs = require("node:fs");
const assert = require("node:assert/strict");
async function main() {
  const file = process.argv[2];
  if (!file) throw new Error();
  const connection = JSON.parse(fs.readFileSync(file, "utf8"));
  const { normalizeBaseURL } = require("../desktop/cloud-endpoint.cjs");
  const base = normalizeBaseURL(connection.baseURL), token = connection.accessToken;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error();
  const get = route => fetch(base + route, { redirect: "error", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(90000) });
  assert.equal((await get("/v1/health")).status, 200);
  const response = await get("/v1/profiles"); assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.ok, true);
  assert.deepEqual(body.result.profiles.map(p => p.id).sort(), ["account-1", "account-2"]);
  for (const id of ["account-1", "account-2"]) for (const route of ["overview", "orders", "holdings", "report", "alchemy", "sync-status"]) {
    const r = await get(`/v1/profiles/${id}/${route}`); assert.equal(r.status, 200); assert.equal((await r.json()).ok, true);
  }
  console.log("健康检查、两个账户及六类只读视图通过；未发起同步或交易。");
}
main().catch(() => { console.error("云端只读检查未通过，请检查私有手机连接文件、TLS 和服务状态；凭据未输出。"); process.exitCode = 1; });
