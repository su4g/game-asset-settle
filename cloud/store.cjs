"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");
const { CloudError, validateEnvelope, validateReplacement } = require("./validation.cjs");
const { buildProfitReport } = require("../desktop/profit-report.cjs");
const { reconcileInput } = require("../desktop/steam-reconcile.cjs");
const recordCount = profile => ["buff", "uu", "steam"].reduce((count, kind) => count + Object.values(profile.input[kind].accounts).reduce((n, a) => n + a.records.length, 0), profile.input.csv.rows.length);
const resultRow = row => row && ({ id: row.id, name: row.name, deviceId: row.device_id, sequence: Number(row.sequence), hash: row.content_hash,
  snapshot: row.snapshot, collectedAt: row.collected_at?.toISOString?.() || row.collected_at || null, uploadedAt: row.uploaded_at?.toISOString?.() || row.uploaded_at || null });

class CloudStore {
  constructor(config, profiles = [{ id: "account-1", name: "账户一" }, { id: "account-2", name: "账户二" }]) {
    if (!config || !/^(?:buff_goods_cloud(?:_[a-z0-9_]+)?|buff_goods_test_[a-z0-9_]+)$/.test(config.database || "")) throw new Error("云服务只允许连接独立 buff_goods_cloud 数据库或隔离测试库");
    // Keep the four established local DB connections available: synchronous
    // report calculation must not race a fresh handshake's five-second timer.
    // The bounded acquisition budget also covers a short burst from mobile tabs.
    this.pool = new Pool({ ...config, max: 4, min: 4, idleTimeoutMillis: 0, connectionTimeoutMillis: 15000, statement_timeout: 30000 }); this.profiles = profiles;
  }
  async warm() {
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => this.pool.connect()));
    const clients = results.filter(result => result.status === "fulfilled").map(result => result.value);
    try {
      const failed = results.find(result => result.status === "rejected"); if (failed) throw failed.reason;
      await Promise.all(clients.map(client => client.query("SELECT 1")));
    } finally { for (const client of clients) client.release(); }
  }
  async migrate() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(await fs.readFile(path.join(__dirname, "schema.sql"), "utf8"));
      for (const p of this.profiles) await client.query("INSERT INTO buff_cloud.profiles(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING", [p.id, p.name]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async health() { await this.pool.query("SELECT 1 FROM buff_cloud.profiles LIMIT 1"); }
  async list() { return (await this.pool.query("SELECT * FROM buff_cloud.profiles ORDER BY id")).rows.map(resultRow); }
  async get(id) {
    const row = resultRow((await this.pool.query("SELECT * FROM buff_cloud.profiles WHERE id=$1", [id])).rows[0]);
    if (!row) throw new CloudError(404, "PROFILE_NOT_FOUND", "账户组不存在"); return row;
  }
  async save(value, allowedProfile) {
    const { envelope, profile, ownership, hash } = validateEnvelope(value);
    if (profile.id !== allowedProfile) throw new CloudError(403, "PROFILE_FORBIDDEN", "此终端只能同步已授权账户组");
    try { buildProfitReport(reconcileInput(profile.input), { ...profile.options, quotes: profile.quotes || [], pricingSettings: profile.pricingSettings || {} }); }
    catch { throw new CloudError(400, "INVALID_REPORT_INPUT", "账户快照无法按现有收益口径核算，请检查本机数据"); }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Serializes ownership changes across both profiles, not unrelated business tables.
      await client.query("SELECT pg_advisory_xact_lock(728104627, 1)");
      const old = resultRow((await client.query("SELECT * FROM buff_cloud.profiles WHERE id=$1 FOR UPDATE", [profile.id])).rows[0]);
      if (!old) throw new CloudError(404, "PROFILE_NOT_FOUND", "账户组不存在");
      if (old.deviceId && old.deviceId !== envelope.deviceId) throw new CloudError(409, "DEVICE_CONFLICT", "该账户组已绑定其他终端，请先处理终端迁移");
      if (envelope.sequence < old.sequence) throw new CloudError(409, "STALE_SEQUENCE", "云端已有较新版本，拒绝旧快照覆盖");
      if (envelope.sequence === old.sequence) {
        if (hash !== old.hash) throw new CloudError(409, "SEQUENCE_CONFLICT", "同一同步序号对应不同数据");
        await client.query("COMMIT"); return { profileId: profile.id, deviceId: envelope.deviceId, sequence: old.sequence, hash, uploadedAt: old.uploadedAt, duplicate: true };
      }
      validateReplacement(old.snapshot, profile);
      for (const binding of ownership) {
        const existing = (await client.query("SELECT profile_id FROM buff_cloud.bindings WHERE platform=$1 AND account_id=$2", [binding.platform, binding.accountId])).rows[0];
        if (existing && existing.profile_id !== profile.id) throw new CloudError(409, "ACCOUNT_OWNERSHIP_CONFLICT", "平台账号或 CSV 来源已属于另一个账户组");
        await client.query("INSERT INTO buff_cloud.bindings(platform,account_id,profile_id) VALUES($1,$2,$3) ON CONFLICT(platform,account_id) DO NOTHING", [binding.platform, binding.accountId, profile.id]);
      }
      const updated = resultRow((await client.query("UPDATE buff_cloud.profiles SET name=$2,device_id=$3,sequence=$4,content_hash=$5,snapshot=$6,collected_at=$7,uploaded_at=now() WHERE id=$1 RETURNING *", [profile.id, profile.name, envelope.deviceId, envelope.sequence, hash, profile, envelope.collectedAt])).rows[0]);
      await client.query("INSERT INTO buff_cloud.sync_audit(profile_id,device_id,sequence,content_hash,record_count) VALUES($1,$2,$3,$4,$5)", [profile.id, envelope.deviceId, envelope.sequence, hash, recordCount(profile)]);
      await client.query("COMMIT");
      return { profileId: profile.id, deviceId: envelope.deviceId, sequence: updated.sequence, hash, uploadedAt: updated.uploadedAt, duplicate: false };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async close() { await this.pool.end(); }
}
module.exports = { CloudStore, recordCount };
