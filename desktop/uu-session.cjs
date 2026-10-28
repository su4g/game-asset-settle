"use strict";
// The official website owns authentication. No preload or credential IPC is exposed.
const SITE = "https://www.youpin898.com";
const API = "https://api.youpin898.com";
const { sessionPartition } = require("./account-profiles.cjs");
const ROUTES = new Map([
  ["/api/user/Account/getUserInfo", "GET"],
  ["/api/youpin/bff/trade/sale/v1/buy/list", "POST"],
  ["/api/youpin/bff/trade/sale/v1/sell/list", "POST"],
  ["/api/youpin/bff/trade/v1/order/query/detail", "POST"],
]);
function navigationAllowed(raw) {
  try { const u = new URL(raw); return u.origin === SITE && !u.username && !u.password; } catch { return false; }
}
function resourceAllowed(raw, resourceType) {
  try {
    if (raw === "about:blank" && resourceType === "subFrame") return true;
    const u = new URL(raw);
    if (["data:", "blob:"].includes(u.protocol)) return true;
    return u.protocol === "https:" && !u.username && !u.password && !u.port &&
      ["youpin898.com", "youpinimg.com", "img898.com", "captcha.qcloud.com", "captcha.gtimg.com", "captcha.qq.com", "rce.tencentrio.com", "cloudcache.tencentcs.com"].some(h => u.hostname === h || u.hostname.endsWith("." + h));
  } catch { return false; }
}
function createUuSession({ session, BrowserWindow, parent, onSessionChange, profileId }) {
  const ses = session.fromPartition(sessionPartition("uu", profileId));
  let loginWindow = null, headers = {};
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false)); ses.setPermissionCheckHandler(() => false);
  const preventDownload = event => event.preventDefault();
  ses.on("will-download", preventDownload);
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !resourceAllowed(d.url, d.resourceType) }));
  ses.webRequest.onBeforeSendHeaders((d, cb) => {
    // Capture only device headers sent by this official login window, in memory.
    if (loginWindow && d.webContentsId === loginWindow.webContents.id && new URL(d.url).origin === "https://pc-api.youpin898.com") {
      for (const [k,v] of Object.entries(d.requestHeaders)) if (["uk","deviceuk","deviceid","app-version","appversion"].includes(k.toLowerCase()) && typeof v === "string" && v.length <= 4096) headers[k.toLowerCase()] = v;
    }
    cb({ requestHeaders: d.requestHeaders });
  });
  const cookieChanged = (_e, cookie, cause, removed) => {
    if (cookie.name !== "uu_token" || !/(^|\.)youpin898\.com$/.test(cookie.domain)) return;
    if (removed && cause === "overwrite") return;
    if (!removed && ["inserted-no-change-overwrite", "inserted-no-value-change-overwrite"].includes(cause)) return;
    // The login window is destroyed before backend reads. Renewing a token
    // then cannot represent an interactive account switch; deletions still do.
    if (removed || loginWindow && !loginWindow.isDestroyed()) onSessionChange();
  };
  ses.cookies.on("changed", cookieChanged);
  return {
    isOpen: () => Boolean(loginWindow && !loginWindow.isDestroyed()),
    async hasSession() {
      const cookies = await ses.cookies.get({ url: SITE, name: "uu_token" });
      const tokens = cookies.filter(cookie => !cookie.expirationDate || cookie.expirationDate > Date.now() / 1000).map(cookie => {
        try { return decodeURIComponent(cookie.value); } catch { return ""; }
      }).filter(Boolean);
      return new Set(tokens).size === 1 && tokens.every(token => token.length <= 16000 && !/[\r\n]/.test(token));
    },
    async fetch(url, init) {
      const u = new URL(url);
      if (u.origin !== API || u.search || u.hash || u.username || u.password || ROUTES.get(u.pathname) !== init.method) throw new Error("未开放的悠悠查询接口");
      const cookies = await ses.cookies.get({ url: SITE, name: "uu_token" });
      const tokens = [...new Set(cookies.map(c => { try { return decodeURIComponent(c.value); } catch { return ""; } }).filter(Boolean))];
      if (tokens.length !== 1 || tokens[0].length > 16000 || /[\r\n]/.test(tokens[0])) throw new Error("请先在 App 的悠悠窗口登录，再检查登录状态");
      const requestHeaders = { ...headers, "content-type": "application/json", accept: "application/json", platform: "pc", appType: "1", authorization: tokens[0], "App-Version": headers["app-version"] || "5.26.0" };
      const body = init.body ? JSON.stringify({ ...JSON.parse(init.body), ...(headers.deviceid ? { Sessionid: headers.deviceid } : {}) }) : undefined;
      return ses.fetch(url, { ...init, body, headers: requestHeaders, redirect: "error" });
    },
    open() {
      if (!loginWindow || loginWindow.isDestroyed()) {
        loginWindow = new BrowserWindow({ width: 1100, height: 800, title: "悠悠登录 · 完成后返回助手检查登录", parent: parent(), webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false } });
        const wc = loginWindow.webContents;
        wc.setWindowOpenHandler(({ url }) => { if (navigationAllowed(url)) wc.loadURL(url).catch(() => {}); return { action: "deny" }; });
        wc.on("will-navigate", (e, url) => { if (!navigationAllowed(url)) e.preventDefault(); });
        // Tencent's verification runs in a cross-origin iframe. Main-frame navigation remains on UU.
        wc.on("will-redirect", (e, url, _inPlace, isMainFrame) => { if (!(isMainFrame === false ? resourceAllowed(url, "subFrame") : navigationAllowed(url))) e.preventDefault(); });
        wc.on("will-attach-webview", e => e.preventDefault()); loginWindow.on("closed", () => { loginWindow = null; });
      }
      loginWindow.loadURL(SITE + "/mine").catch(() => {}); loginWindow.show(); loginWindow.focus(); return { opened: true };
    },
    close() { loginWindow?.destroy(); },
    dispose() { ses.cookies.removeListener?.("changed", cookieChanged); ses.removeListener?.("will-download", preventDownload); headers = {}; loginWindow?.destroy(); },
    async clear() { loginWindow?.destroy(); headers = {}; await ses.clearStorageData(); await ses.clearCache(); },
  };
}
module.exports = { API, ROUTES, navigationAllowed, resourceAllowed, createUuSession };
