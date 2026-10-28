"use strict";
const { ORIGIN } = require("./buff-orders.cjs");
const { sessionPartition } = require("./account-profiles.cjs");
function navigationAllowed(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    return url.hostname === "buff.163.com" || url.hostname === "steamcommunity.com" && /^\/(openid|login)(\/|$)/.test(url.pathname);
  } catch { return false; }
}
function resourceAllowed(raw) {
  try {
    const url = new URL(raw);
    if (["data:", "blob:"].includes(url.protocol)) return true;
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      ["163.com", "126.net", "netease.com", "steamcommunity.com", "steampowered.com", "steamstatic.com"].some(host => url.hostname === host || url.hostname.endsWith("." + host));
  } catch { return false; }
}
function createBuffSession({ session, BrowserWindow, parent, onSessionChange, profileId }) {
  const ses = session.fromPartition(sessionPartition("buff", profileId));
  let loginWindow = null;
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  const preventDownload = event => event.preventDefault();
  ses.on("will-download", preventDownload);
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !resourceAllowed(details.url) }));
  const cookieChanged = (_event, cookie, cause, removed) => {
    if (cookie.name !== "session" || !/(^|\.)buff\.163\.com$/.test(cookie.domain.replace(/^\./, ""))) return;
    // BUFF also rotates the session value on authenticated read responses.
    // The login window is destroyed before checking/syncing, so only our
    // read-only requests can rotate it then. BuffOrders verifies the account
    // before and after each run; opening a login window invalidates the run.
    if (removed && cause === "overwrite") return;
    if (!removed && ["inserted-no-change-overwrite", "inserted-no-value-change-overwrite"].includes(cause)) return;
    if (removed || loginWindow && !loginWindow.isDestroyed()) onSessionChange();
  };
  ses.cookies.on("changed", cookieChanged);
  return {
    isOpen: () => Boolean(loginWindow && !loginWindow.isDestroyed()),
    fetch: (url, init) => ses.fetch(url, init),
    async hasSession() {
      const cookies = await ses.cookies.get({ url: ORIGIN, name: "session" });
      return cookies.some(cookie => typeof cookie.value === "string" && cookie.value.length > 0 && (!cookie.expirationDate || cookie.expirationDate > Date.now() / 1000));
    },
    open({ direction = "buy", appid = 730 } = {}) {
      if (!["buy", "sell"].includes(direction) || ![730, 570].includes(appid)) throw new Error("BUFF 页面参数无效");
      const url = `${ORIGIN}/market/${direction}_order/history?game=${appid === 570 ? "dota2" : "csgo"}`;
      if (!loginWindow || loginWindow.isDestroyed()) {
        loginWindow = new BrowserWindow({ width: 1100, height: 800, title: "BUFF 登录与订单 · 完成后返回助手检查登录", parent: parent(),
          webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false } });
        const wc = loginWindow.webContents;
        wc.setWindowOpenHandler(({ url: target }) => {
          if (navigationAllowed(target)) wc.loadURL(target).catch(() => {});
          return { action: "deny" };
        });
        for (const eventName of ["will-navigate", "will-redirect"]) wc.on(eventName, (event, target) => { if (!navigationAllowed(target)) event.preventDefault(); });
        wc.on("will-attach-webview", event => event.preventDefault());
        loginWindow.on("closed", () => { loginWindow = null; });
      }
      loginWindow.loadURL(url).catch(() => {}); loginWindow.show(); loginWindow.focus();
      return { opened: true };
    },
    async clear() { loginWindow?.close(); await ses.clearStorageData(); await ses.clearCache(); },
    close() { loginWindow?.destroy(); },
    dispose() { ses.cookies.removeListener?.("changed", cookieChanged); ses.removeListener?.("will-download", preventDownload); loginWindow?.destroy(); },
  };
}
module.exports = { navigationAllowed, resourceAllowed, createBuffSession };
