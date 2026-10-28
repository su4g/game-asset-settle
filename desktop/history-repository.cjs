"use strict";
const fs = require("node:fs/promises");
const { ledgerRequest } = require("./runtime.cjs");
class HistoryRepository {
  constructor(configFile, legacyFile, kind = "buff") { if (!["buff", "uu", "steam"].includes(kind)) throw new Error("历史平台无效"); this.kind = kind; this.configFile = configFile; this.legacyFile = legacyFile; this.revision = 0; }
  async load() {
    const saved = await ledgerRequest(this.configFile, { path: `/history/${this.kind}` });
    this.revision = saved.revision;
    if (saved.exists || !this.legacyFile) return saved.data;
    let legacy;
    try {
      if ((await fs.stat(this.legacyFile)).size > 40 * 1024 * 1024) throw new Error("旧 BUFF 历史文件过大");
      legacy = JSON.parse(await fs.readFile(this.legacyFile, "utf8"));
    } catch (error) { if (error.code === "ENOENT") return saved.data; throw new Error("旧 BUFF 历史无法读取，原文件已保留"); }
    await this.save(legacy);
    return legacy;
  }
  csv() { return ledgerRequest(this.configFile, { path: "/history/csv" }); }
  names() { return ledgerRequest(this.configFile, { path: "/history/names" }); }
  async save(data) {
    const result = await ledgerRequest(this.configFile, { path: `/history/${this.kind}`, method: "POST", body: { revision: this.revision, data } });
    this.revision = result.revision;
  }
}
module.exports = { HistoryRepository };
