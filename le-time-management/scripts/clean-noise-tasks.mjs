#!/usr/bin/env node
/* 清掉待办池里的「名单碎片」（capture 守卫上线前已经被粘贴进来的历史数据）。
 *
 * 用法：
 *   node scripts/clean-noise-tasks.mjs            # 实际删除（先备份）
 *   node scripts/clean-noise-tasks.mjs --dry-run  # 只看会删哪些
 *   node scripts/clean-noise-tasks.mjs --file <path>  # 指定别的 data.json
 *
 * 为什么必须先关应用：运行中的 U-Time 把状态放在内存里，任何一次操作
 * 都会把整份 data.json 重新写回 —— 这时候改文件等于白改，还会让人以为
 * 脚本没生效。所以检测到进程就直接拒绝（--dry-run 不受限制）。
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { looksLikeNoise } from "../src/captureNoise.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fileAt = args.indexOf("--file");
const dataFile = fileAt >= 0 && args[fileAt + 1]
  ? path.resolve(args[fileAt + 1])
  : path.join(process.env.APPDATA || "", "com.yile.letime", "data.json");

if (!fs.existsSync(dataFile)) {
  console.error(`找不到数据文件：${dataFile}`);
  process.exit(1);
}

/** 运行中的 U-Time 会抢写 data.json，写入前必须确认它不在。 */
function appRunning() {
  if (process.platform !== "win32") return false;
  try {
    const out = execSync("tasklist /FO CSV /NH", { encoding: "utf8", windowsHide: true });
    return /UTime|le-time/i.test(out);
  } catch {
    return false;
  }
}

const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
const tasks = Array.isArray(data.tasks) ? data.tasks : [];
/** 以原始粘贴文本（note）为准；note 为空时退回标题。 */
const noisy = tasks.filter((t) => looksLikeNoise(t?.note || t?.title || ""));
const noisyIds = new Set(noisy.map((t) => String(t.id)));

if (!noisy.length) {
  console.log("没有需要清理的碎片待办。");
  process.exit(0);
}

console.log(`发现 ${noisy.length} 条碎片待办：`);
noisy.forEach((t) => {
  console.log(`  - [${t.id}] ${t.title || "(无标题)"}  ← note：${JSON.stringify(String(t.note || "").slice(0, 40))}`);
});

if (dryRun) {
  console.log("\n--dry-run：只列出，不改文件。");
  process.exit(0);
}

if (appRunning()) {
  console.error("\nU-Time 正在运行：它会把内存里的状态盖回 data.json。");
  console.error("请先完全退出 U-Time（不要只关窗口留托盘），再运行本脚本。");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const backup = `${dataFile}.bak-${stamp}`;
fs.copyFileSync(dataFile, backup);

const beforeBlocks = Array.isArray(data.blocks) ? data.blocks.length : 0;
data.tasks = tasks.filter((t) => !noisyIds.has(String(t.id)));
// 连带清掉这些任务自己的时间块（理论上碎片没有时间块，防御性处理）
if (Array.isArray(data.blocks)) {
  data.blocks = data.blocks.filter((b) => !noisyIds.has(String(b?.taskId)));
}

fs.writeFileSync(dataFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
console.log(`\n已删除 ${noisy.length} 条任务${beforeBlocks - (data.blocks?.length || 0) ? "，连带 " + (beforeBlocks - data.blocks.length) + " 个时间块" : ""}。`);
console.log(`备份：${backup}`);
