"use strict";
// Audit the Git candidate set, including force-added ignored files. No matched values are printed.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const files = [...new Set(execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean))];
const blocked = /(^|\/)(?:node_modules|\.ledger|\.backups|\.desktop-output|\.releases|\.audit-output|private-connections|xcuserdata|\.build|DerivedData|build|dist|Network|Local Storage|Session Storage)(\/|$)|(?:^|\/)(?:ledger-config\.js|cloud-(?:server|connection|pending|sync-state)\.json|postgres\.env|account-(?:bootstrap|onboarding)\.json|Cookies(?:-journal)?|Login Data|\.DS_Store)$|\.(?:buffdesktop|buffconnection|pem|key|p12|p8|pfx|cer|mobileprovision|dump|backup|sqlite3?|db|har|ipa|dmg|zip|tar\.gz|csv|tsv)$/i;
const rules = [
  ["private-key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
  ["cloud-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["database-url-with-password", /\b(?:postgres(?:ql)?|mysql):\/\/[^\s/:]+:[^\s/@]+@/i],
  ["personal-home-path", /\/(?:Users|home)\/(?!example(?:[\/\s]|$)|runner(?:[\/\s]|$)|user(?:[\/\s]|$))[A-Za-z0-9._-]+\//],
  ["email-in-source", /(?<![A-Z0-9._%+:/-])[A-Z0-9._%+-]+@(?![A-Z0-9.-]*(?:example\.(?:com|org|net)|users\.noreply\.github\.com)\b)[A-Z0-9.-]+\.(?:com|net|org|cn)\b/i],
];
const problems = [];
for (const file of files) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) { problems.push({ file, rule: "tracked-file-missing" }); continue; }
  if (fs.lstatSync(full).isSymbolicLink()) { problems.push({ file, rule: "symlink" }); continue; }
  if (blocked.test(file) || /(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith(".env.example")) { problems.push({ file, rule: "private-or-generated-file" }); continue; }
  const bytes = fs.readFileSync(full);
  if (bytes.includes(0)) continue; // Binary screenshots require a separate visual/metadata review.
  const content = bytes.toString("utf8");
  for (const [rule, pattern] of rules) {
    for (const match of content.matchAll(new RegExp(pattern.source, pattern.flags + "g"))) {
      // Explicitly public maintainer contact, approved for the open-source project.
      if (rule === "email-in-source" && match[0].toLowerCase() === "suag725@163.com") continue;
      problems.push({ file, line: content.slice(0, match.index).split("\n").length, rule });
    }
  }
}
if (problems.length) {
  for (const p of problems) console.error(`${p.file}${p.line ? ":" + p.line : ""}: ${p.rule}`);
  console.error(`公开检查未通过：${problems.length} 项。未输出匹配内容。`); process.exitCode = 1;
} else console.log(`公开候选文件 ${files.length} 个：禁止文件与高置信凭据模式检查通过。另需 Gitleaks、已知私密值比对、历史与截图检查。`);
