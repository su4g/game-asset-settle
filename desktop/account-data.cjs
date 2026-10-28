"use strict";

// Scope archived facts before reconciliation or financial calculations. Never
// infer ownership from matching item names, prices, CSV labels, or display names.
const { listAccounts, accountKey, sourceId } = require("./order-ledger.cjs");
const { reconcileInput } = require("./steam-reconcile.cjs");
const PLATFORMS = ["buff", "uu", "steam"];
const clone = value => structuredClone(value);

function scopeInput(input, profile) {
  if (!input || typeof input !== "object" || !profile || !["account-1", "account-2"].includes(profile.id) || !profile.bindings || !Array.isArray(profile.csvScopes || [])) throw new Error("请先配置当前终端的账户关联");
  const result = {};
  for (const platform of PLATFORMS) {
    const archive = input[platform] || { version: 1, accounts: {} };
    const id = profile?.bindings?.[platform];
    const account = id && archive.accounts?.[id];
    if (id && (typeof id !== "string" || !id.startsWith(platform + ":"))) throw new Error("平台账号与账户关联不一致");
    if (account && (account.account?.id !== id || !Array.isArray(account.records) || account.records.some(row => row.accountId !== id || row.key !== [id, row.appid, row.direction, row.channel, row.orderId, ...(platform === "uu" ? [row.lineId] : [])].join(":")))) throw new Error("归档账号与当前账户关联不一致，已停止核算");
    result[platform] = { ...clone(archive), accounts: account ? { [id]: clone(account) } : {}, activeAccount: id || null };
  }
  const scopes = new Set(profile?.csvScopes || []), csv = input.csv || {};
  const rows = (csv.rows || []).filter(row => scopes.has(row.scope));
  result.csv = { ...clone(csv), rows: clone(rows), imports: clone((csv.imports || []).filter(item => scopes.has(item.scope))) };
  // These fields are derived and must be recalculated from the scoped archive.
  delete result.csv.archiveRowCount; delete result.csv.suppressedCount; delete result.csv.bindings;
  result.names = clone(input.names || { rows: [] });
  return result;
}

function scopeOptions(options, input, profile) {
  const next = clone(options || {}), keys = new Set(listAccounts(reconcileInput(input)).map(account => account.key));
  // Resolve the old portfolio identity from owned raw sources too: a fully
  // reconciled CSV source is absent from calculation keys but still owns its
  // saved report group. Keeping that id preserves report entries and exclusions.
  for (const platform of PLATFORMS) if (profile.bindings[platform]) keys.add(accountKey(platform, platform, profile.bindings[platform]));
  const ownedKeys = new Set(listAccounts(input).map(account => account.key));
  for (const platform of PLATFORMS) if (profile.bindings[platform]) ownedKeys.add(accountKey(platform, platform, profile.bindings[platform]));
  for (const scope of profile.csvScopes || []) for (const platform of PLATFORMS) ownedKeys.add(accountKey("csv", platform, scope));
  const allLinks = next.accountLinks || [];
  if (!Array.isArray(allLinks) || allLinks.some(link => !link || !Array.isArray(link.accountKeys))) throw new Error("原账户组合设置无效，已停止核算");
  const links = allLinks.filter(link => link.accountKeys.some(key => ownedKeys.has(key)));
  // The stable prior group id retains report entry / excluded holding identity.
  if (links.length > 1) throw new Error("当前账户存在多个旧核算组合，请先统一该账户的归属再同步云端");
  const id = links[0]?.id || (profile.id === "account-1" ? "self" : profile.id);
  const hasGroupPreferences = (next.reportEntries || []).some(entry => entry.portfolioId === id) || (next.excludedHoldingIds || []).length || (next.watchlistIds || []).length;
  if (links.some(link => link.accountKeys.some(key => !ownedKeys.has(key))) && hasGroupPreferences) throw new Error("旧组合含其他账户且存在补录或持仓设置，不能自动分配给当前账户，请先核对原组合归属");
  next.accountLinkMode = "manual";
  next.accountLinks = [{ id, name: profile.name, accountKeys: [...keys] }];
  next.reportEntries = links.length ? (next.reportEntries || []).filter(entry => entry.portfolioId === id) : [];
  if (!links.length) { next.excludedHoldingIds = []; next.watchlistIds = []; }
  const sourceIds = new Set();
  for (const platform of PLATFORMS) for (const account of Object.values(input[platform]?.accounts || {})) for (const row of account.records || []) sourceIds.add(sourceId(platform, row.key));
  for (const row of input.csv?.rows || []) sourceIds.add(sourceId("csv", row.key));
  next.overrides = Object.fromEntries(Object.entries(next.overrides || {}).filter(([key]) => sourceIds.has(key)));
  next.csvAmountSemantics = Object.fromEntries(Object.entries(next.csvAmountSemantics || {}).filter(([key]) => ownedKeys.has(key)));
  return next;
}

function profileScope(connectionScope, profileId) {
  return !profileId || profileId === "account-1" ? connectionScope : `${connectionScope}:${profileId}`;
}

module.exports = { scopeInput, scopeOptions, profileScope };
