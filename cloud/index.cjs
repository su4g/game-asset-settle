"use strict";
const http = require("node:http");
const fs = require("node:fs/promises");
const { timingSafeEqual, createHash } = require("node:crypto");
const { createGunzip } = require("node:zlib");
const { CloudStore } = require("./store.cjs");
const { CloudError } = require("./validation.cjs");
const { profileInfo, view } = require("./views.cjs");
const { ReportCache } = require("./report-cache.cjs");
const MAX_BODY = 64 * 1024 * 1024;
function sameSecret(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  return timingSafeEqual(createHash("sha256").update(actual).digest(), createHash("sha256").update(expected).digest());
}
function validateConfig(config) {
  if (!config || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error("云服务端口配置无效");
  if (!Array.isArray(config.profiles) || config.profiles.length !== 2 || config.profiles.some(p => !["account-1", "account-2"].includes(p.id) || typeof p.name !== "string" || !p.name.trim() || p.name.length > 80) || new Set(config.profiles.map(p => p.id)).size !== 2) throw new Error("必须配置两个独立账户组");
  if (!config.ingestTokens || Object.keys(config.ingestTokens).length !== 2) throw new Error("必须分别配置两个账户组的同步凭据");
  const secrets = [config.readToken, ...config.profiles.map(p => config.ingestTokens[p.id])];
  if (secrets.some(s => typeof s !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(s)) || new Set(secrets).size !== secrets.length) throw new Error("查询与同步凭据必须分别设置且不能相同");
  return config;
}
async function body(req) {
  if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) throw new CloudError(415, "CONTENT_TYPE", "同步请求必须为 JSON");
  const encoding = req.headers["content-encoding"] || "identity";
  if (!["identity", "gzip"].includes(encoding)) throw new CloudError(415, "CONTENT_ENCODING", "不支持此压缩格式");
  if (Number(req.headers["content-length"]) > MAX_BODY) throw new CloudError(413, "BODY_TOO_LARGE", "同步快照过大");
  const stream = encoding === "gzip" ? req.pipe(createGunzip()) : req, chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) { size += chunk.length; if (size > MAX_BODY) throw new CloudError(413, "BODY_TOO_LARGE", "同步快照过大"); chunks.push(chunk); }
  } catch (error) { if (error instanceof CloudError) throw error; throw new CloudError(400, "INVALID_BODY", "同步请求不完整或压缩数据无效"); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new CloudError(400, "INVALID_JSON", "同步 JSON 格式无效"); }
}
function createServer({ store, readToken, ingestTokens }) {
  const reportCache = new ReportCache();
  const send = (res, status, value) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.headers.origin) throw new CloudError(403, "ORIGIN_FORBIDDEN", "此接口仅供已授权客户端使用");
      if (req.method === "GET" && url.pathname === "/v1/health" && !url.search) {
        await store.health(); send(res, 200, { ok: true, result: { service: "buff-helper-cloud", schemaVersion: 1 } }); return;
      }
      const authorization = req.headers.authorization;
      if (typeof authorization !== "string" || !authorization.startsWith("Bearer ") || req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === "authorization").length !== 1) throw new CloudError(401, "UNAUTHORIZED", "请检查手机查询凭据或终端同步配置");
      const token = authorization.slice(7);
      let result;
      if (req.method === "POST" && url.pathname === "/v1/sync" && !url.search) {
        const profile = Object.keys(ingestTokens).find(id => sameSecret(token, ingestTokens[id]));
        if (!profile) throw new CloudError(403, "INGEST_FORBIDDEN", "此凭据没有同步写入权限");
        result = await store.save(await body(req), profile);
      } else {
        if (!sameSecret(token, readToken)) throw new CloudError(401, "READ_UNAUTHORIZED", "手机查询凭据无效");
        if (req.method !== "GET") throw new CloudError(405, "READ_ONLY", "手机接口仅支持读取");
        if (url.pathname === "/v1/profiles" && !url.search) result = { profiles: (await store.list()).map(profileInfo) };
        else {
          const match = url.pathname.match(/^\/v1\/profiles\/(account-[12])\/(overview|orders|holdings|report|alchemy|sync-status)$/);
          if (!match) throw new CloudError(404, "NOT_FOUND", "接口不存在");
          result = view(await store.get(match[1]), match[2], url.searchParams, reportCache);
        }
      }
      send(res, 200, { ok: true, result });
    } catch (error) {
      const status = error instanceof CloudError ? error.status : 500;
      // Never log request bodies, URLs containing user input, credentials or DB errors.
      if (status === 500) console.error("BUFF 云服务请求未完成", /^[A-Z0-9_]{1,40}$/.test(error.code || "") ? error.code : "INTERNAL_ERROR");
      if (!res.headersSent) send(res, status, { ok: false, code: error instanceof CloudError ? error.code : "INTERNAL_ERROR", error: error instanceof CloudError ? error.message : "云端暂时不可用，已有数据已保留" });
      else res.end();
    }
  });
  server.requestTimeout = 120000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 100;
  return server;
}
async function main() {
  const configPath = process.argv[2] || process.env.BUFF_CLOUD_CONFIG;
  if (!configPath) throw new Error("需要独立云服务配置文件");
  const stat = await fs.stat(configPath);
  if (!stat.isFile() || stat.size > 65536 || process.platform !== "win32" && (stat.mode & 0o077)) throw new Error("云服务配置必须是仅所有者可读的文件");
  const config = validateConfig(JSON.parse(await fs.readFile(configPath, "utf8"))), store = new CloudStore(config.database, config.profiles);
  await store.migrate(); await store.warm(); const server = createServer({ store, readToken: config.readToken, ingestTokens: config.ingestTokens });
  server.listen(config.port, "127.0.0.1", () => console.log("BUFF 云服务已启动（仅回环监听）"));
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; server.close(() => store.close().then(() => process.exit(0))); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  server.on("error", () => { console.error("BUFF 云服务监听失败"); void store.close().finally(() => { process.exitCode = 1; }); });
}
if (require.main === module) main().catch(() => { console.error("BUFF 云服务启动失败，请检查专用配置与数据库"); process.exitCode = 1; });
module.exports = { createServer, validateConfig, sameSecret };
