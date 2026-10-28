"use strict";
const fs = require("node:fs/promises");

// Only the native save dialog supplies a destination. The renderer cannot choose a path.
function validateExport(payload) {
  if (!payload || typeof payload.fileName !== "string" || !/^[^/\\\u0000-\u001f]{1,100}\.csv$/i.test(payload.fileName) || payload.fileName.startsWith(".")) throw new Error("导出文件名无效");
  if (typeof payload.text !== "string" || !payload.text.startsWith("\uFEFF") || Buffer.byteLength(payload.text, "utf8") > 80 * 1024 * 1024) throw new Error("导出内容无效或超过 80 MB，请缩小筛选范围");
  return { fileName: payload.fileName, text: payload.text };
}
async function saveExport(payload, choosePath, write = fs.writeFile) {
  const data = validateExport(payload);
  const choice = await choosePath({ title: "保存交易分析 CSV", defaultPath: data.fileName, filters: [{ name: "CSV 表格", extensions: ["csv"] }] });
  if (choice.canceled || !choice.filePath) return { cancelled: true };
  await write(choice.filePath, data.text, { encoding: "utf8", mode: 0o600 });
  return { cancelled: false };
}
module.exports = { validateExport, saveExport };
