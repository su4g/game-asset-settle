#!/usr/bin/env node
"use strict";
const path = require("node:path");
const fs = require("node:fs/promises");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const { PRODUCT_NAME, LEGACY_NAME, APP_VERSION, BUNDLE_ID } = require("../desktop/brand.cjs");
const executableSuffix = `/Contents/MacOS/${PRODUCT_NAME}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function command(file, args) {
  // Packaging may use Electron's embedded Node. A GUI launch must not inherit
  // that mode or the application's lifetime/stdio from this build command.
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 20000, env });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.trim() || `${path.basename(file)} 执行失败`);
  return result.stdout;
}
function runningApps() {
  // Only packaged main processes using the normal profile. Never stop smoke
  // checks, independent test profiles, Electron helpers or development apps.
  return command("/bin/ps", ["-axo", "pid=,command="]).split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+\.app\/Contents\/MacOS\/(?:BUFF 本机助手|饰品交易账本))(?:\s+(--.*))?$/);
    if (!match || /--(?:smoke-test|profile-dir)(?:\s|=|$)/.test(match[3] || "")) return [];
    return [{ pid: Number(match[1]), executable: match[2], bundle: path.dirname(path.dirname(path.dirname(match[2]))) }];
  });
}
function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
async function relaunchFromApplications(bundle, applicationsShortcut) {
  const expected = await fs.realpath(bundle), entry = await fs.realpath(applicationsShortcut);
  if (entry !== expected) throw new Error("应用程序入口不是本次打包版本，保留当前运行状态");
  if (command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", path.join(expected, "Contents/Info.plist")]).trim() !== "local.buffgoods.desktop") throw new Error("应用程序身份不符，未重启");
  const old = [];
  for (const app of runningApps()) {
    if (await fs.realpath(app.bundle) === expected) continue;
    if (command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", path.join(app.bundle, "Contents/Info.plist")]).trim() === "local.buffgoods.desktop") old.push(app);
  }
  if (old.length) {
    console.log("正在正常退出旧版饰品交易账本……");
    const quit = `ObjC.import("AppKit");
      function run(argv) {
        const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("local.buffgoods.desktop");
        for (let i = 0; i < apps.count; i++) {
          const app = apps.objectAtIndex(i);
          if (Number(app.processIdentifier) === Number(argv[0]) && !app.terminate) throw new Error("旧版未接受正常退出请求");
        }
      }`;
    for (const app of old) command("/usr/bin/osascript", ["-l", "JavaScript", "-e", quit, String(app.pid)]);
    const deadline = Date.now() + 20000;
    while (old.some(app => isRunning(app.pid))) {
      if (Date.now() >= deadline) throw new Error("旧版尚未完成退出，未强制结束或启动第二个实例；新版已打包");
      await delay(250);
    }
  }
  command("/usr/bin/open", ["--stdin", "/dev/null", "--stdout", "/dev/null", "--stderr", "/dev/null", applicationsShortcut]);
  const deadline = Date.now() + 20000, expectedExecutable = path.join(expected, executableSuffix.slice(1));
  while (Date.now() < deadline) {
    for (const app of runningApps()) {
      let executable;
      try { executable = await fs.realpath(app.executable); } catch { continue; }
      if (executable === expectedExecutable) {
        await delay(3000);
        if (isRunning(app.pid)) { console.log(`已从「应用程序」打开最新版${PRODUCT_NAME}（进程 ${app.pid}）。`); return; }
      }
    }
    await delay(250);
  }
  throw new Error("新版已打包，但未确认最新版持续运行，请检查应用启动状态");
}

async function ensureApplicationsShortcut(shortcut, name = PRODUCT_NAME) {
  const applicationsShortcut = `/Applications/${name}.app`;
  let existing;
  try { existing = await fs.lstat(applicationsShortcut); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) {
    // Preserve unrelated applications; this entry must keep following the
    // stable project shortcut, never one specific build directory.
    if (!existing.isSymbolicLink() || path.resolve(path.dirname(applicationsShortcut), await fs.readlink(applicationsShortcut)) !== shortcut) {
      throw new Error(`应用程序入口已被其他文件占用，请先检查：${applicationsShortcut}`);
    }
  } else await fs.symlink(shortcut, applicationsShortcut);
  if (await fs.realpath(applicationsShortcut) !== await fs.realpath(shortcut)) throw new Error("应用程序入口未指向最新版");
  const registration = spawnSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", applicationsShortcut], { encoding: "utf8" });
  if (registration.error || registration.status !== 0) throw new Error(`应用程序注册失败：${registration.error?.message || registration.stderr}`);
  return applicationsShortcut;
}

async function updateStableShortcut(shortcut, target, output) {
  let stat;
  try { stat = await fs.lstat(shortcut); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (stat) {
    if (!stat.isSymbolicLink()) throw new Error(`固定入口被其他文件占用：${shortcut}`);
    const old = await fs.realpath(shortcut);
    if (!old.startsWith(path.join(output, "apps") + path.sep) || command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", path.join(old, "Contents/Info.plist")]).trim() !== BUNDLE_ID) throw new Error(`固定入口不属于此应用：${shortcut}`);
  }
  const temporary = `${shortcut}.${process.pid}.tmp`;
  await fs.symlink(target, temporary);
  try { await fs.rename(temporary, shortcut); } finally { await fs.rm(temporary, { force: true }); }
}

async function main() {
  if (process.platform !== "darwin") throw new Error("当前打包脚本用于本机 macOS 预览");
  if (process.argv.includes("--relaunch-only")) {
    const latest = JSON.parse(await fs.readFile(path.join(root, ".desktop-output/latest-app.json"), "utf8"));
    command("/usr/bin/codesign", ["--verify", "--deep", "--strict", latest.bundle]);
    await relaunchFromApplications(latest.bundle, latest.applicationsShortcut);
    return;
  }
  // Electron's embedded Node also lets the existing Node 20 ledger environment package this app.
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || major === 22 && minor < 12) {
    const result = spawnSync(require("electron"), [__filename, ...process.argv.slice(2)], { cwd: root, stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }
  const { packager } = await import("@electron/packager");
  const output = path.join(root, ".desktop-output");
  await fs.mkdir(output, { recursive: true });
  const iconset = path.join(output, "Ledger.iconset");
  await fs.mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) command("/usr/bin/sips", ["-z", String(size * scale), String(size * scale), path.join(root, "desktop/assets/brand/app-icon.png"), "--out", path.join(iconset, `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`)]);
  }
  const icon = path.join(output, "desktop.icns");
  command("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", icon]);
  const results = await packager({
    dir: root, name: PRODUCT_NAME, appBundleId: BUNDLE_ID, appVersion: APP_VERSION,
    platform: "darwin", arch: process.arch, electronVersion: require("electron/package.json").version,
    out: path.join(output, "apps", `build-${Date.now()}`), overwrite: false, prune: true, asar: false, icon,
    // An explicit top-level allowlist: credentials, account data, tests and backups cannot enter the app.
    ignore: [/^\/(?!desktop(?:\/|$)|server(?:\/|$)|node_modules(?:\/|$)|package\.json$|LICENSE$|THIRD_PARTY_NOTICES\.md$|common\.js$|buff-account\.js$|buy-history\.js$|ledger\.html$|ledger\.css$|ledger-ui\.js$|buy-sync-ui\.js$|icon128\.png$)/],
  });
  for (const directory of results) {
    const bundle = path.join(directory, `${PRODUCT_NAME}.app`);
    const resources = path.join(bundle, "Contents/Resources/app");
    for (const name of [".ledger", "ledger-config.js", ".backups", ".env", "tests"]) {
      try { await fs.access(path.join(resources, name)); throw new Error(`打包包含不应发布的文件：${name}`); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    // Load the packaged backend without starting it, so omitted shared modules fail the build.
    require(path.join(resources, "server/store.cjs"));
    require(path.join(resources, "server/index.cjs"));
    const signature = spawnSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { encoding: "utf8" });
    if (signature.status !== 0) throw new Error(`本机应用签名失败：${signature.stderr}`);
    command("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
    const shortcut = path.join(output, `${PRODUCT_NAME}.app`);
    await updateStableShortcut(shortcut, bundle, output);
    // Existing Dock and Applications references keep following the newest build.
    const legacyShortcut = path.join(output, `${LEGACY_NAME}.app`);
    await updateStableShortcut(legacyShortcut, shortcut, output);
    const install = !process.argv.includes("--no-install");
    const applicationsShortcut = install ? await ensureApplicationsShortcut(shortcut) : null;
    if (install) await ensureApplicationsShortcut(legacyShortcut, LEGACY_NAME);
    await fs.writeFile(path.join(output, "latest-app.json"), JSON.stringify({ bundle, shortcut, applicationsShortcut }, null, 2));
    console.log(`已生成本机应用：${bundle}`);
    console.log(`双击入口：${shortcut}`);
    if (install) console.log(`应用程序入口（自动跟随更新）：${applicationsShortcut}`);
    if (install && !process.argv.includes("--no-relaunch")) await relaunchFromApplications(bundle, applicationsShortcut);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
