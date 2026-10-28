"use strict";
const ORIGIN = "https://steamcommunity.com";
const { sessionPartition } = require("./account-profiles.cjs");
function navigationAllowed(raw) {
  try { const u = new URL(raw); return u.origin === ORIGIN && !u.username && !u.password && /^\/(login|market|openid|my|profiles|id)(\/|$)/.test(u.pathname); } catch { return false; }
}
function resourceAllowed(raw) {
  try {
    if (raw === "about:blank") return true;
    const u = new URL(raw);
    if (["data:", "blob:"].includes(u.protocol)) return true;
    return u.protocol === "https:" && !u.username && !u.password && !u.port &&
      ["steamcommunity.com", "steampowered.com", "steamstatic.com", "steamusercontent.com"].some(h => u.hostname === h || u.hostname.endsWith("." + h));
  } catch { return false; }
}
function readAllowed(raw, init = {}) {
  try {
    const u = new URL(raw);
    if (u.origin !== ORIGIN || u.username || u.password || u.hash || init.method !== "GET" || init.body != null) return false;
    const keys = [...u.searchParams.keys()];
    if (new Set(keys).size !== keys.length) return false;
    if (/^\/profiles\/\d{17}\/inventoryhistory\/$/.test(u.pathname)) {
      const p = u.searchParams, cursorKeys = ["cursor[time]","cursor[time_frac]","cursor[s]"];
      return keys.every(k => ["ajax","app[]","l",...cursorKeys].includes(k)) && p.get("ajax") === "1" && p.get("app[]") === "730" && p.get("l") === "english" &&
        (!cursorKeys.some(k => p.has(k)) || cursorKeys.every(k => /^\d{1,30}$/.test(p.get(k) || "")));
    }
    if (u.pathname === "/market/") return keys.every(k => k === "l") && (!u.searchParams.has("l") || ["english", "schinese"].includes(u.searchParams.get("l")));
    return ["/market/myhistory", "/market/myhistory/render/"].includes(u.pathname) && keys.every(k => ["start", "count", "norender", "l"].includes(k)) &&
      /^\d+$/.test(u.searchParams.get("start")) && Number.isSafeInteger(Number(u.searchParams.get("start"))) &&
      /^\d+$/.test(u.searchParams.get("count")) && Number(u.searchParams.get("count")) > 0 && Number(u.searchParams.get("count")) <= 100 &&
      (!u.searchParams.has("norender") || ["0", "1"].includes(u.searchParams.get("norender"))) &&
      (!u.searchParams.has("l") || ["english", "schinese"].includes(u.searchParams.get("l")));
  } catch { return false; }
}
// A fresh login redirects the market page through this read-only eligibility
// check. Follow only that exact route back to an allowlisted market page.
function backgroundReadAllowed(raw, method = "GET") {
  if (readAllowed(raw, { method })) return true;
  try {
    const u = new URL(raw);
    return method === "GET" && u.origin === ORIGIN && !u.username && !u.password && !u.hash &&
      u.pathname === "/market/eligibilitycheck/" && [...u.searchParams.keys()].join() === "goto" &&
      readAllowed(new URL(u.searchParams.get("goto"), ORIGIN).href, { method });
  } catch { return false; }
}
// Steam canonicalizes a numeric profile URL to its vanity URL and rewrites
// app[] as app[0]. Only learn that exact redirect from a pending trusted GET;
// it is never an additional public endpoint accepted from an IPC caller.
function inventoryRedirectAllowed(from, target) {
  try {
    const a = new URL(from), b = new URL(target);
    const valid = u => u.origin === ORIGIN && !u.username && !u.password && !u.hash &&
      /^\/(?:profiles\/\d{17}|id\/[A-Za-z0-9_-]{1,100})\/inventoryhistory\/?$/.test(u.pathname) &&
      new Set(u.searchParams.keys()).size === [...u.searchParams.keys()].length &&
      [...u.searchParams.keys()].every(k => ["ajax","app[]","app[0]","l","cursor[time]","cursor[time_frac]","cursor[s]"].includes(k)) &&
      u.searchParams.get("ajax") === "1" && u.searchParams.get("l") === "english" &&
      (u.searchParams.has("app[]") !== u.searchParams.has("app[0]")) && (u.searchParams.get("app[]") || u.searchParams.get("app[0]")) === "730";
    const normalized = u => JSON.stringify([...u.searchParams.entries()].map(([k,v]) => [k === "app[0]" ? "app[]" : k,v]).sort(([a],[b]) => a.localeCompare(b)));
    return valid(a) && valid(b) && normalized(a) === normalized(b);
  } catch { return false; }
}
function createSteamSession({ session, BrowserWindow, parent = () => undefined, onSessionChange = () => {}, profileId }) {
  const ses = session.fromPartition(sessionPartition("steam", profileId));
  let loginWindow = null, backgroundReads = 0;
  const inventoryRedirects = new Set();
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false)); ses.setPermissionCheckHandler(() => false);
  const preventDownload = event => event.preventDefault();
  ses.on("will-download", preventDownload);
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(backgroundReads ? backgroundReadAllowed(d.url, d.method) || d.method === "GET" && inventoryRedirects.has(d.url) : resourceAllowed(d.url)) }));
  ses.webRequest.onBeforeRedirect?.(d => {
    if (backgroundReads && (readAllowed(d.url, { method: "GET" }) || inventoryRedirects.has(d.url)) && inventoryRedirectAllowed(d.url, d.redirectURL)) inventoryRedirects.add(d.redirectURL);
  });
  const cookieChanged = (_e, cookie, cause, removed) => {
    if (cookie.name !== "steamLoginSecure" || !/(^|\.)steamcommunity\.com$/.test(cookie.domain)) return;
    if (removed && cause === "overwrite") return;
    if (!removed && ["inserted-no-change-overwrite", "inserted-no-value-change-overwrite"].includes(cause)) return;
    if (removed || loginWindow && !loginWindow.isDestroyed()) onSessionChange();
  };
  ses.cookies.on("changed", cookieChanged);
  return {
    isOpen: () => Boolean(loginWindow && !loginWindow.isDestroyed()),
    async hasSession() {
      const cookies = await ses.cookies.get({ url: ORIGIN, name: "steamLoginSecure" });
      return cookies.some(c => c.value && (!c.expirationDate || c.expirationDate > Date.now() / 1000));
    },
    async fetch(url, init) {
      if (!readAllowed(url, init)) throw new Error("未开放的 Steam 查询接口");
      if (loginWindow && !loginWindow.isDestroyed()) throw new Error("请先关闭 Steam 登录窗口再查询历史");
      // The server renders inventory timestamps using this non-secret display
      // preference. Always request Beijing time, independent of machine timezone.
      if (new URL(url).pathname.endsWith("/inventoryhistory/")) await ses.cookies.set({ url: ORIGIN, name: "timezoneOffset", value: "28800,0", path: "/" });
      backgroundReads++;
      try {
        return await ses.fetch(url, { ...init, credentials: "include", redirect: "follow", cache: "no-store", headers: { Accept: "application/json,text/html", Referer: ORIGIN + "/market/" } });
      } catch (error) {
        if (init.signal?.aborted) throw error;
        throw new Error(/redirect|ERR_BLOCKED_BY_CLIENT/i.test(error.message || "")
          ? "Steam 会话需要重新登录，请打开 Steam 窗口后再检查登录"
          : "Steam 网络连接失败，请检查网络或稍后重试");
      } finally { backgroundReads--; if (!backgroundReads) inventoryRedirects.clear(); }
    },
    open() {
      if (!loginWindow || loginWindow.isDestroyed()) {
        loginWindow = new BrowserWindow({ width: 1100, height: 800, title: "Steam 独立登录 · 完成后返回助手检查登录", parent: parent(),
          webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false } });
        const wc = loginWindow.webContents;
        wc.setWindowOpenHandler(({ url }) => { if (navigationAllowed(url)) wc.loadURL(url).catch(() => {}); return { action: "deny" }; });
        wc.on("will-navigate", (e, url) => { if (!navigationAllowed(url)) e.preventDefault(); });
        wc.on("will-redirect", (e, url, _inPlace, isMainFrame) => { if (!(isMainFrame === false ? resourceAllowed(url) : navigationAllowed(url))) e.preventDefault(); });
        wc.on("will-attach-webview", e => e.preventDefault());
        loginWindow.on("closed", () => { loginWindow = null; });
      }
      loginWindow.loadURL(ORIGIN + "/login/home/?goto=market%2F").catch(() => {});
      loginWindow.show(); loginWindow.focus(); return { opened: true };
    },
    close() { loginWindow?.destroy(); },
    dispose() { ses.cookies.removeListener?.("changed", cookieChanged); ses.removeListener?.("will-download", preventDownload); loginWindow?.destroy(); },
    async clear() { loginWindow?.destroy(); await ses.clearStorageData(); await ses.clearCache(); },
  };
}
module.exports = { ORIGIN, navigationAllowed, resourceAllowed, readAllowed, backgroundReadAllowed, inventoryRedirectAllowed, createSteamSession };
