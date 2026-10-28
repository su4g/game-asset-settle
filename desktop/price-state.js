"use strict";
// Shared local quote/settings state; the standalone pricing screen has been retired.
(() => {
  const P = window.BuffDesktopPricing;
  let state = { rows: [], settings: { ...P.DEFAULTS } }, pending = Promise.resolve();
  const ready = (async () => {
    const saved = await window.buffDesktop.request("storage:get", ["priceWorkspace", "calculatorDraft"]);
    if (saved.priceWorkspace) state = { rows: P.normalizeRows(saved.priceWorkspace.rows), settings: P.normalizeSettings(saved.priceWorkspace.settings) };
    else if (saved.calculatorDraft?.buffFee !== "" && saved.calculatorDraft?.buffFee != null) {
      const fee = Number(saved.calculatorDraft.buffFee);
      if (Number.isFinite(fee) && fee >= 0 && fee <= 100) state.settings[Number(saved.calculatorDraft.game) === 570 ? "buffDota2SellFeePercent" : "buffCsgoSellFeePercent"] = fee;
    }
  })();
  function change(update, event) {
    const task = pending.then(async () => {
      await ready;
      const next = update(state);
      await window.buffDesktop.request("storage:set", { priceWorkspace: next });
      state = next; window.dispatchEvent(new Event(event));
    });
    pending = task.catch(() => {}); return task;
  }
  window.BuffPriceWorkspace = { ready, settings: () => ({ ...state.settings }), rows: () => state.rows.map(row => ({ ...row })),
    upsertQuotes: rows => change(current => ({ ...current, rows: P.normalizeRows(P.mergeRows(current.rows, rows)) }), "price-quotes-changed"),
    updateSettings: settings => change(current => ({ ...current, settings: P.normalizeSettings({ ...current.settings, ...settings }) }), "price-settings-changed"),
    updateCashoutRatio: value => change(current => ({ ...current, settings: P.normalizeSettings({ ...current.settings, targetCashoutRatio: value }) }), "price-settings-changed"),
    updateFee: (appid, value) => change(current => ({ ...current, settings: P.normalizeSettings({ ...current.settings, [Number(appid) === 570 ? "buffDota2SellFeePercent" : "buffCsgoSellFeePercent"]: value }) }), "price-settings-changed") };
})();
