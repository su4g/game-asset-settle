"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { normalizeBaseURL } = require("../desktop/cloud-endpoint.cjs");
const { validateConfig } = require("../cloud/index.cjs");
async function generate({ baseURL, output }) {
  baseURL = normalizeBaseURL(baseURL);
  if (!output || !path.isAbsolute(output)) throw new Error("请指定仓库外的新建绝对目录 --output");
  const root = await fs.realpath(path.resolve(__dirname, ".."));
  const parent = await fs.realpath(path.dirname(output));
  const directory = path.join(parent, path.basename(output));
  if (directory === root || directory.startsWith(root + path.sep)) throw new Error("连接凭据必须保存在仓库外");
  await fs.mkdir(directory, { mode: 0o700 }); // Existing credentials are never overwritten.
  const secret = () => randomBytes(36).toString("base64url");
  const config = validateConfig({ port: 3327,
    database: { host: "127.0.0.1", port: 15439, user: "buff_cloud_app", password: secret(), database: "buff_goods_cloud" },
    readToken: secret(), ingestTokens: { "account-1": secret(), "account-2": secret() },
    profiles: [{ id: "account-1", name: "账户一" }, { id: "account-2", name: "账户二" }] });
  const write = (name, value) => fs.writeFile(path.join(directory, name), value, { mode: 0o600, flag: "wx" });
  const json = value => JSON.stringify(value, null, 2) + "\n";
  await write("cloud-server.json", json(config));
  await write("postgres.env", `POSTGRES_USER=buff_cloud_admin\nPOSTGRES_PASSWORD=${secret()}\nPOSTGRES_DB=postgres\n`);
  for (const { id } of config.profiles) await write(`${id}.buffdesktop`, json({ version: 1, profileId: id, baseURL, ingestToken: config.ingestTokens[id], readToken: config.readToken }));
  await write("mobile.buffconnection", json({ version: 1, baseURL, accessToken: config.readToken }));
  return directory;
}
if (require.main === module) {
  const value = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  generate({ baseURL: value("--base-url"), output: value("--output") })
    .then(() => console.log("已在指定私有目录生成五个文件，权限 0600；凭据未输出。请按 cloud/README.md 分发。"))
    .catch(error => { console.error(error.code === "EEXIST" ? "输出目录已存在；原连接凭据未覆盖。" : "配置生成失败，请检查 HTTPS 地址、仓库外新目录及其父目录权限。已有文件保留，请勿混用两批配置。"); process.exitCode = 1; });
}
module.exports = { generate };
