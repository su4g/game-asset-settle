"use strict";
// Reserved example domain only. A real endpoint comes from the imported connection.
const DEFAULT_BASE_URL = "https://ledger.example.com/buff-helper-api";
function normalizeBaseURL(value) {
  let url;
  try {
    if (typeof value !== "string" || /[\s\\]/.test(value)) throw new Error();
    url = new URL(value);
  } catch { throw new Error("云端地址无效"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.port || url.search || url.hash
      || !/^https:\/\/[^/?#]+\/buff-helper-api\/*$/i.test(value)
      || url.pathname.replace(/\/+$/, "") !== "/buff-helper-api") {
    throw new Error("连接文件须使用自建服务器的 HTTPS /buff-helper-api 地址，端口为 443，且不含凭据或参数");
  }
  return url.origin + "/buff-helper-api";
}
module.exports = { normalizeBaseURL, DEFAULT_BASE_URL };
