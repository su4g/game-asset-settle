"use strict";
// Compatibility bridge for the bundled ledger UI. BUFF reads use the desktop cache.
(() => {
  if (window.parent === window || !window.parent.buffDesktop) throw new Error("请从桌面工作台打开账本");
  const desktop = window.parent.buffDesktop;
  const listeners = new Set();
  const platformUnavailable = "桌面版尚未接入 Steam 历史、自动采价和购买执行";
  window.chrome = {
    runtime: {
      id: "buff-desktop-preview",
      getURL: name => name === "ledger.html" ? "buff-desktop://app/ledger.html" : "",
      sendMessage(message, callback) {
        const send = async () => {
          try {
            if (message.type === "LEDGER_COLLECT_BUYS" || message.type === "LEDGER_COLLECT_SALES") {
              const direction = message.type === "LEDGER_COLLECT_BUYS" ? "buy" : "sell";
              if (message.platform === "steam") throw new Error(platformUnavailable);
              const selection = window.parent.BuffOrdersWorkspace?.consumeReview(direction);
              const appid = selection?.appid || (direction === "buy" ? message.appid : undefined);
              if (selection && direction === "buy") document.getElementById("buySyncGame").value = String(appid);
              return { ok: true, result: await desktop.request("buff:collect", { direction, appid, ...(selection ? { keys: selection.keys } : {}) }) };
            }
            if (message.type === "LEDGER_OPEN_BUY_HISTORY" || message.type === "LEDGER_OPEN_HISTORY") {
              if (message.platform === "steam") throw new Error(platformUnavailable);
              return { ok: true, result: await desktop.request("buff:login", { direction: message.type === "LEDGER_OPEN_BUY_HISTORY" ? "buy" : "sell", appid: message.appid || 730 }) };
            }
            if (message.type !== "LEDGER_REQUEST") throw new Error(platformUnavailable);
            return { ok: true, result: await desktop.request("ledger", message) };
          } catch (error) { return { ok: false, error: error.message }; }
        };
        const response = send();
        if (callback) response.then(callback);
        return response;
      },
    },
    storage: {
      local: { get: keys => desktop.request("storage:get", keys), set: values => desktop.request("storage:set", values) },
      onChanged: { addListener: callback => listeners.add(callback), removeListener: callback => listeners.delete(callback) },
    },
    tabs: { create: async () => { throw new Error(platformUnavailable); } },
  };
  const unsubscribe = desktop.onChange(event => { if (event.kind === "storage") for (const callback of listeners) callback(event.changes, "local"); });
  window.addEventListener("unload", unsubscribe, { once: true });
  window.addEventListener("DOMContentLoaded", () => {
    document.getElementById("openFull").hidden = true;
    for (const id of ["pollPrices"]) {
      const button = document.getElementById(id);
      button.disabled = true; button.setAttribute("aria-description", platformUnavailable);
    }
    const tasks = document.getElementById("tasks");
    new MutationObserver(() => {
      for (const button of tasks.querySelectorAll("[data-task-action], [data-task-review]")) button.hidden = true;
      if (!tasks.hidden) document.getElementById("directionHint").textContent = "当前显示本机账本中已有的购买任务；桌面预览仅查看任务，不启动、恢复或修改执行中的订单。";
    }).observe(tasks, { childList: true });
    new MutationObserver(() => {
      const form = document.getElementById("buySyncForm");
      if (form && !form.dataset.desktop) {
        form.dataset.desktop = "true";
        document.getElementById("readBuys").textContent = "重新读取本机历史";
        form.querySelector("p.muted.small").textContent = "读取 App 已同步的 BUFF 历史；更新记录请到 BUFF 订单页同步。实付金额与时间缺失时需核对补全。每次最多 500 条，可从订单页核对当前页。";
      }
      const collect = document.getElementById("collectBoth");
      if (collect && !collect.dataset.desktop) {
        collect.dataset.desktop = "true"; collect.textContent = "读取 BUFF 本机历史";
        const steam = document.querySelector('[data-history="steam"]'); if (steam) steam.hidden = true;
      }
    }).observe(document.getElementById("dialogBody"), { childList: true, subtree: true });
  }, { once: true });
})();
