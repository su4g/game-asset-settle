"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { generate } = require("../scripts/cloud-config.cjs");
const { validateConnection } = require("../desktop/cloud-sync.cjs");
test("公开配置工具每次生成独立的读写凭据，仅写仓库外新目录，不覆盖已有部署", async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "settle-config-test-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const output = path.join(base, "private"), baseURL = "https://self-hosted.example.org/buff-helper-api";
  await generate({ output, baseURL });
  const config = JSON.parse(await fs.readFile(path.join(output, "cloud-server.json")));
  const mobile = JSON.parse(await fs.readFile(path.join(output, "mobile.buffconnection")));
  assert.equal(new Set([config.readToken, ...Object.values(config.ingestTokens), config.database.password]).size, 4);
  assert.equal(mobile.accessToken, config.readToken); assert.equal(mobile.ingestToken, undefined);
  for (const id of ["account-1", "account-2"]) {
    const terminal = validateConnection(JSON.parse(await fs.readFile(path.join(output, id + ".buffdesktop"))));
    assert.equal(terminal.baseURL, baseURL); assert.equal(terminal.ingestToken, config.ingestTokens[id]);
  }
  for (const name of await fs.readdir(output)) assert.equal((await fs.stat(path.join(output, name))).mode & 0o077, 0);
  const before = await fs.readFile(path.join(output, "cloud-server.json"));
  await assert.rejects(generate({ output, baseURL }), { code: "EEXIST" });
  assert.deepEqual(await fs.readFile(path.join(output, "cloud-server.json")), before);
});
test("公开配置工具拒绝仓库内部、符号链接内部目标和不安全地址", async t => {
  const root = path.resolve(__dirname, ".."), baseURL = "https://self-hosted.example.org/buff-helper-api";
  await assert.rejects(generate({ baseURL, output: path.join(root, "private-should-never-exist") }), /仓库外/);
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "settle-config-link-test-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.symlink(root, path.join(base, "link"));
  await assert.rejects(generate({ baseURL, output: path.join(base, "link", "private-should-never-exist") }), /仓库外/);
  await assert.rejects(generate({ baseURL: "http://example.com/buff-helper-api", output: path.join(base, "unsafe") }));
  await assert.rejects(fs.stat(path.join(base, "unsafe")), { code: "ENOENT" });
});
