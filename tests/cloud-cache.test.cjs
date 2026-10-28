"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { ReportCache } = require("../cloud/report-cache.cjs");
const { view } = require("../cloud/views.cjs");
const { validateEnvelope } = require("../cloud/validation.cjs");
const { buildProfitReport } = require("../desktop/profit-report.cjs");
const { fixture } = require("./cloud-fixture.cjs");
const row = (id = "account-1", account = "one", cost = 100) => {
  const checked = validateEnvelope(fixture(id, account, cost));
  return { id, name: checked.profile.name, sequence: 1, hash: checked.hash, snapshot: checked.profile };
};
test("云报表缓存复用总览/持仓/报告且与原口径完全一致，两账户同序号不串用", () => {
  let builds = 0; const cache = new ReportCache({ build: (...args) => { builds++; return buildProfitReport(...args); } }), a = row(), b = row("account-2", "two", 1000);
  for (const name of ["overview", "holdings", "report"]) {
    const query = new URLSearchParams("currency=CNY"); assert.deepEqual(view(a, name, query, cache), view(a, name, query));
  }
  assert.equal(builds, 1); assert.equal(view(b, "overview", new URLSearchParams(), cache).currencies[0].profitCents, -800);
  assert.equal(builds, 2); assert.equal(view(a, "overview", new URLSearchParams(), cache).currencies[0].profitCents, 100); assert.equal(builds, 2);
});
test("新序号/内容hash/日期范围/北京日均严格失效，查询结果不污染缓存", () => {
  let builds = 0, now = Date.parse("2026-10-27T15:59:00Z"); const cache = new ReportCache({ now: () => now, build: (...args) => { builds++; return buildProfitReport(...args); } }), a = row();
  view(a, "report", new URLSearchParams(), cache); view(a, "holdings", new URLSearchParams("currency=USD"), cache); assert.equal(builds, 1);
  view(a, "overview", new URLSearchParams("from=2026-01-01"), cache); assert.equal(builds, 2);
  a.sequence++; a.snapshot.input.buff.accounts["buff:one"].records[0].paidTotalCents = 150;
  assert.equal(view(a, "overview", new URLSearchParams(), cache).currencies[0].profitCents, 50); assert.equal(builds, 3); assert.equal(cache.entries.size, 1);
  a.hash = "f".repeat(64); view(a, "overview", new URLSearchParams(), cache); assert.equal(builds, 4);
  now = Date.parse("2026-10-27T16:01:00Z"); view(a, "overview", new URLSearchParams(), cache); assert.equal(builds, 5); assert.equal(cache.entries.size, 1);
});
test("缓存有条数/字节上限，大对象与没有可信快照版本的输入不会保留", () => {
  const a = row(), cache = new ReportCache({ maxEntries: 2, maxBytes: 32 * 1024 });
  for (const from of ["2026-01-01", "2026-01-02", "2026-01-03"]) view(a, "overview", new URLSearchParams("from=" + from), cache);
  assert.ok(cache.entries.size <= 2); assert.ok(cache.bytes <= 32 * 1024);
  const small = new ReportCache({ maxBytes: 1 }); view(a, "overview", new URLSearchParams(), small); assert.equal(small.entries.size, 0);
  delete a.hash; const unversioned = new ReportCache(); view(a, "overview", new URLSearchParams(), unversioned); assert.equal(unversioned.entries.size, 0);
});
