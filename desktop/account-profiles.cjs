"use strict";

const PLATFORMS = Object.freeze(["buff", "uu", "steam"]);
const PROFILE_IDS = Object.freeze(["account-1", "account-2"]);
const copy = value => structuredClone(value);
const failure = (message, code = "ACCOUNT_PROFILE_INVALID") => Object.assign(new Error(message), { code });
function profileId(value) { if (!PROFILE_IDS.includes(value)) throw failure("账户组无效"); return value; }
function platformName(value) { if (!PLATFORMS.includes(value)) throw failure("交易平台无效"); return value; }
function accountId(platform, value) {
  platformName(platform);
  if (typeof value !== "string" || !(platform === "steam" ? /^steam:\d{17}$/ : new RegExp(`^${platform}:[A-Za-z0-9_-]{1,100}$`)).test(value)) throw failure("平台账户标识无效");
  return value;
}
function displayName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 40 || /[\u0000-\u001f]/.test(value)) throw failure("账户组名称须为 1～40 个字符");
  return value.trim();
}
function initialProfiles() {
  return { version: 1, activeProfileId: null, profiles: PROFILE_IDS.map((id, index) => ({ id, name: `账户${index + 1}`, bindings: { buff: null, uu: null, steam: null }, csvScopes: [] })) };
}
function validateProfiles(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length !== 2 || value.activeProfileId !== null && !PROFILE_IDS.includes(value.activeProfileId)) throw failure("账户关联配置无效，原配置已保留");
  const ids = new Set(), assigned = new Set(), csvAssigned = new Set();
  const profiles = value.profiles.map(item => {
    if (!item || ids.has(profileId(item.id)) || !item.bindings || Array.isArray(item.bindings)) throw failure("账户组配置重复或无效");
    ids.add(item.id);
    const bindings = {};
    for (const platform of PLATFORMS) {
      const id = item.bindings[platform] ?? null;
      if (id !== null) {
        accountId(platform, id);
        if (assigned.has(id)) throw failure("同一平台账号不能关联两个账户组", "ACCOUNT_IN_USE");
        assigned.add(id);
      }
      bindings[platform] = id;
    }
    const csvScopes = item.csvScopes ?? [];
    if (!Array.isArray(csvScopes) || csvScopes.length > 100 || csvScopes.some(scope => typeof scope !== "string" || !scope.trim() || scope.length > 300 || /[\u0000-\u001f]/.test(scope))) throw failure("CSV 账户标签无效");
    for (const scope of csvScopes) { if (csvAssigned.has(scope)) throw failure("此终端的同一 CSV 账户标签不能关联两个账户组", "ACCOUNT_IN_USE"); csvAssigned.add(scope); }
    return { id: item.id, name: displayName(item.name), bindings, csvScopes: [...csvScopes] };
  });
  return { version: 1, activeProfileId: value.activeProfileId, profiles: PROFILE_IDS.map(id => profiles.find(item => item.id === id)) };
}
function sessionPartition(platform, id) {
  platformName(platform);
  if (id == null || profileId(id) === "account-1") return `persist:${platform}-orders`;
  return `persist:${platform}-orders-${id}`;
}

class AccountProfiles {
  constructor({ state, notify = () => {} }) {
    this.state = state; this.notify = notify; this.value = initialProfiles(); this.pending = Promise.resolve(); this.ready = this.load();
  }
  async load() {
    const saved = await this.state.get("accountProfiles");
    if (saved.accountProfiles != null) this.value = validateProfiles(saved.accountProfiles);
    // An unconfigured terminal never adopts a group or combines old accounts.
    return this.snapshot();
  }
  snapshot() { return copy(this.value); }
  get(id) { return copy(this.value.profiles.find(item => item.id === profileId(id))); }
  binding(id, platform) { return this.get(id).bindings[platformName(platform)]; }
  update(change) {
    const task = this.pending.then(async () => {
      await this.ready;
      const next = this.snapshot(); await change(next);
      const validated = validateProfiles(next);
      await this.state.set({ accountProfiles: validated });
      this.value = validated; this.notify({ kind: "account-profiles", value: this.snapshot() });
      return this.snapshot();
    });
    this.pending = task.catch(() => {}); return task;
  }
  select(id) { if (id !== null) profileId(id); return this.update(next => { next.activeProfileId = id; }); }
  rename(id, name) { profileId(id); name = displayName(name); return this.update(next => { next.profiles.find(item => item.id === id).name = name; }); }
  assignCsvScopes(id, scopes) { profileId(id); return this.update(next => { next.profiles.find(item => item.id === id).csvScopes = copy(scopes); }); }
  assertAccount(id, platform, actual, { allowUnbound = false } = {}) {
    profileId(id); accountId(platform, actual);
    const target = this.value.profiles.find(item => item.id === id), expected = target.bindings[platform];
    if (this.value.profiles.some(item => item.id !== id && item.bindings[platform] === actual)) throw failure("此平台账号已关联另一个账户组，请使用对应账号登录", "ACCOUNT_IN_USE");
    if (expected && expected !== actual) throw failure(`${target.name} 的平台账号与已关联账号不一致，请重新登录正确账号；本次数据未保存`, "ACCOUNT_MISMATCH");
    if (!expected && !allowUnbound) throw failure("当前账户组尚未关联此平台，请先检查登录完成关联", "ACCOUNT_UNBOUND");
    return actual;
  }
  bind(id, platform, actual) {
    profileId(id); accountId(platform, actual);
    return this.update(next => {
      this.assertAccount(id, platform, actual, { allowUnbound: true });
      next.profiles.find(item => item.id === id).bindings[platform] = actual;
    });
  }
  async bootstrapExisting(id, histories) {
    profileId(id);
    const ambiguous = [];
    const result = await this.update(next => {
      const target = next.profiles.find(item => item.id === id);
      for (const platform of PLATFORMS) {
        const data = histories?.[platform]?.data || histories?.[platform];
        const accounts = Object.keys(data?.accounts || {});
        if (accounts.length > 1) { ambiguous.push({ platform, accountIds: accounts }); continue; }
        if (accounts.length === 1) {
          this.assertAccount(id, platform, accounts[0], { allowUnbound: true });
          target.bindings[platform] = accounts[0];
        }
      }
      next.activeProfileId = id;
    });
    return { ...result, ambiguous };
  }
  reconcileRemoteProfiles(profiles) {
    // CSV scope labels are local import labels. The server namespaces them by
    // profile, so equal labels on two different terminals are not a collision.
    const remote = validateProfiles({ version: 1, activeProfileId: null, profiles: Array.isArray(profiles) ? profiles.map(item => ({ ...item, csvScopes: [] })) : profiles });
    return this.update(next => {
      for (const target of next.profiles) {
        const source = remote.profiles.find(item => item.id === target.id);
        for (const platform of PLATFORMS) {
          const localId = target.bindings[platform], remoteId = source.bindings[platform];
          if (localId && remoteId && localId !== remoteId) throw failure("本机与服务端账户关联不一致，已停止合并，请核对终端所属账户", "ACCOUNT_MISMATCH");
          if (remoteId) target.bindings[platform] = remoteId;
        }
        target.name = source.name;
      }
    });
  }
}

// Shared by all scoped adapters in this process, even when each owns its own
// HistoryRepository revision. External concurrent writers still receive 409.
const saveQueues = new Map();
function serialized(key, run) {
  const previous = saveQueues.get(key) || Promise.resolve();
  const task = previous.then(run), tail = task.catch(() => {});
  saveQueues.set(key, tail);
  void tail.then(() => { if (saveQueues.get(key) === tail) saveQueues.delete(key); });
  return task;
}
class AccountScopedRepository {
  constructor({ repository, profiles, profileId: id, platform, lockKey }) {
    this.repository = repository; this.profiles = profiles; this.profileId = profileId(id); this.platform = platformName(platform);
    this.lockKey = lockKey || (repository.configFile ? `${repository.configFile}:${platform}` : repository);
  }
  async load() {
    await this.profiles.ready;
    return serialized(this.lockKey, async () => {
      const data = await this.repository.load(), expected = this.profiles.binding(this.profileId, this.platform);
      return { version: 1, accounts: expected && data.accounts?.[expected] ? { [expected]: copy(data.accounts[expected]) } : {},
        activeAccount: expected || null, cooldownUntil: data.cooldownUntil || 0 };
    });
  }
  async candidates() {
    return serialized(this.lockKey, async () => {
      const data = await this.repository.load();
      return Object.values(data.accounts || {}).map(item => ({ id: item.account?.id, nickname: item.account?.nickname || "", recordCount: item.records?.length || 0 })).filter(item => item.id);
    });
  }
  save(value) {
    const run = async () => {
      await this.profiles.ready;
      const expected = this.profiles.binding(this.profileId, this.platform);
      if (!value || value.version !== 1 || !value.accounts || Array.isArray(value.accounts)) throw failure("账户历史格式无效");
      const entries = Object.entries(value.accounts);
      for (const [id, saved] of entries) {
        this.profiles.assertAccount(this.profileId, this.platform, id);
        if (saved.account?.id !== id || !Array.isArray(saved.records) || saved.records.some(row => row.accountId !== id)) throw failure("订单账户与账户组关联不一致", "ACCOUNT_MISMATCH");
      }
      if (value.activeAccount != null && value.activeAccount !== expected) throw failure("活动平台账户与账户组关联不一致", "ACCOUNT_MISMATCH");
      const current = await this.repository.load();
      const accounts = { ...(current.accounts || {}) };
      if (expected && value.accounts[expected]) accounts[expected] = copy(value.accounts[expected]);
      await this.repository.save({ ...current, version: 1, accounts,
        activeAccount: value.activeAccount || current.activeAccount || null,
        cooldownUntil: Math.max(current.cooldownUntil || 0, value.cooldownUntil || 0) });
    };
    return serialized(this.lockKey, run);
  }
  names() { return this.repository.names(); }
  async csv() {
    await this.profiles.ready;
    const data = await this.repository.csv(), scopes = new Set(this.profiles.get(this.profileId).csvScopes);
    const rows = (data.rows || []).filter(row => scopes.has(row.scope));
    return { ...data, rows, archiveRowCount: rows.length, imports: (data.imports || []).filter(item => scopes.has(item.scope)),
      ...(Array.isArray(data.bindings) ? { bindings: data.bindings.filter(item => scopes.has(item.scope)) } : {}) };
  }
}

module.exports = { PLATFORMS, PROFILE_IDS, AccountProfiles, AccountScopedRepository, initialProfiles, validateProfiles, sessionPartition };
