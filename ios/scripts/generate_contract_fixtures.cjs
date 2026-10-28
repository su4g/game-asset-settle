"use strict";
// Synthetic cloud DTOs only. Never read the production database or connections.
const fs = require("node:fs"), path = require("node:path");
const { fixture, alchemyFixture } = require("../../tests/cloud-fixture.cjs");
const { view, profileInfo } = require("../../cloud/views.cjs");
const envelope = fixture(), profile = envelope.profiles[0];
const row = { id: profile.id, name: profile.name, snapshot: profile, collectedAt: envelope.collectedAt, uploadedAt: envelope.collectedAt };
const directory = path.join(__dirname, "../Tests/BuffReaderCoreTests/Fixtures");
fs.mkdirSync(directory, { recursive: true });
const save = (name, result) => fs.writeFileSync(path.join(directory, name + ".json"), JSON.stringify({ ok: true, result }, null, 2));
save("profiles", { profiles: [profileInfo(row), profileInfo({ id: "account-2", name: "账户二", snapshot: null, collectedAt: null, uploadedAt: null })] });
for (const kind of ["overview", "orders", "report", "sync-status"]) save(kind, view(row, kind, new URLSearchParams(kind === "report" ? { days: "3" } : {})));
const holdingRow = structuredClone(row);
holdingRow.snapshot.input.buff.accounts[profile.bindings.buff].records = holdingRow.snapshot.input.buff.accounts[profile.bindings.buff].records.filter(record => record.direction === "buy");
save("holdings", view(holdingRow, "holdings"));
save("alchemy", view({ ...row, snapshot: alchemyFixture().profiles[0] }, "alchemy"));
