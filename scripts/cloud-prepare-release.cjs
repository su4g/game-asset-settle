"use strict";
// Code-only release. Provisioning secrets is a separate, explicit operation.
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
async function main() {
  const output = path.join(root, ".releases"); await fs.mkdir(output, { recursive: true });
  const stage = await fs.mkdtemp(path.join(output, "cloud-"));
  const release = path.join(stage, "release"); await fs.mkdir(release);
  const files = ["common.js", "LICENSE", "THIRD_PARTY_NOTICES.md", "package-lock.json", "cloud/README.md",
    ...["game-asset-settle.service", "nginx-location.conf", "game-asset-settle-backup.service", "game-asset-settle-backup.timer"].map(f => "cloud/deploy/" + f),
    ...["index.cjs", "schema.sql", "store.cjs", "validation.cjs", "views.cjs", "alchemy-view.cjs", "report-cache.cjs", "provision-db.cjs", "backup.sh", "restore-check.sh", "verify-deployment.cjs"].map(f => "cloud/" + f),
    ...["buff-analysis.cjs", "order-ledger-insights.cjs", "order-ledger.cjs", "pricing.js", "profit-report.cjs", "report-analytics.js", "steam-reconcile.cjs", "alchemy.cjs", "steam-inventory.cjs", "cloud-endpoint.cjs"].map(f => "desktop/" + f)];
  const manifest = {};
  for (const file of files) {
    const bytes = await fs.readFile(path.join(root, file));
    await fs.mkdir(path.dirname(path.join(release, file)), { recursive: true });
    await fs.writeFile(path.join(release, file), bytes);
    manifest[file] = createHash("sha256").update(bytes).digest("hex");
  }
  const modules = execFileSync("npm", ["ls", "--omit=dev", "--parseable", "--all"], { cwd: root, encoding: "utf8" }).trim().split("\n").slice(1);
  for (const from of modules) {
    const relative = path.relative(root, from);
    if (!relative.startsWith("node_modules/") || relative.includes("..")) throw new Error("生产依赖路径无效");
    await fs.mkdir(path.dirname(path.join(release, relative)), { recursive: true });
    await fs.cp(from, path.join(release, relative), { recursive: true });
  }
  await fs.writeFile(path.join(release, "release-manifest.json"), JSON.stringify({ files: manifest, pg: require("pg/package.json").version }, null, 2) + "\n");
  const archive = path.join(stage, "release.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", stage, "release"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  console.log(`纯代码发布包：${archive}`);
}
main().catch(() => { console.error("云端发布包生成失败，请先安装依赖；未读取或修改任何连接凭据。"); process.exitCode = 1; });
