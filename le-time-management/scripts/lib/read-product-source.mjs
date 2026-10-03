import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 静态接线断言同时读取实际拆分模块，行为测试仍直接导入公开入口。
export function readProductSource(file, options) {
  const source = fs.readFileSync(file, options);
  if (typeof source !== "string") return source;
  const filename = file instanceof URL ? fileURLToPath(file) : String(file);
  const normalized = filename.replaceAll("\\", "/");
  let relatives = [], prepend = false;
  if (normalized.endsWith("/src/views/settings.js")) relatives = ["settings/reminders.js", "settings/data.js", "settings/shortcuts.js", "settings/lan.js"];
  if (normalized.endsWith("/src/shell.js")) { relatives = ["pluginListDrag.js"]; prepend = true; }
  if (normalized.endsWith("/core/pluginRuntime.js")) relatives = ["plugins/common.js", "plugins/reports.js", "plugins/exams.js", "plugins/dormDuty.js", "plugins/inboxDrop.js"];
  if (normalized.endsWith("/pages/plugin/index.js")) relatives = ["dormDuty.js"];
  if (normalized.endsWith("/src/styles.css")) relatives = ["styles/feature-layouts.css"];
  if (normalized.endsWith("/src-tauri/src/lib.rs")) relatives = ["vault.rs", "storage.rs"];
  const modules = relatives.map(rel => fs.readFileSync(path.join(path.dirname(filename), rel), options)).join("\n");
  const combined = prepend ? modules + "\n// 横向工具区\n" + source : source + (modules ? "\n" + modules : "");
  return combined.replace(/\r\n/g, "\n");
}
