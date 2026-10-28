"use strict";
const { buildProfitReport } = require("../desktop/profit-report.cjs");
const { reconcileInput } = require("../desktop/steam-reconcile.cjs");

// A process-local bounded cache of the unchanged report calculation. Snapshot
// identity and account ownership are part of every key, never query parameters.
class ReportCache {
  constructor({ maxEntries = 2, maxBytes = 32 * 1024 * 1024, now = Date.now, build = buildProfitReport } = {}) {
    this.maxEntries = maxEntries; this.maxBytes = maxBytes; this.now = now; this.build = build; this.entries = new Map(); this.bytes = 0;
  }
  remove(key) { const old = this.entries.get(key); if (old) { this.bytes -= old.bytes; this.entries.delete(key); } }
  get(row, profile, period) {
    const calculate = () => this.build(reconcileInput(profile.input), { ...profile.options, ...period, quotes: profile.quotes || [], pricingSettings: profile.pricingSettings || {} });
    // Unsaved/empty snapshots have no trusted revision and are cheap to compute.
    if (!row.snapshot || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || !/^[a-f0-9]{64}$/.test(row.hash || "")) return calculate();
    const day = new Date(this.now() + 28800000).toISOString().slice(0, 10);
    const revision = JSON.stringify([row.id, row.sequence, row.hash]);
    const key = JSON.stringify([revision, period.dateFrom || "", period.dateTo || "", day]);
    for (const [storedKey, entry] of this.entries) if (entry.profileId === row.id && (entry.revision !== revision || entry.day !== day)) this.remove(storedKey);
    const hit = this.entries.get(key);
    if (hit) { this.entries.delete(key); this.entries.set(key, hit); return hit.report; }
    const report = calculate(), bytes = Buffer.byteLength(JSON.stringify(report));
    if (bytes > this.maxBytes || this.maxEntries < 1) return report;
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.remove(this.entries.keys().next().value);
    this.entries.set(key, { profileId: row.id, revision, day, report, bytes }); this.bytes += bytes;
    return report;
  }
}
module.exports = { ReportCache };
