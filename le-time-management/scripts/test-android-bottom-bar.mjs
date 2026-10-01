import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shell = fs.readFileSync(path.join(base, "src/shell.js"), "utf8");
const styles = fs.readFileSync(path.join(base, "src/styles.css"), "utf8");

assert.match(shell, /if \(isAndroidRuntime\(\)\) setChromeShown\(true\)/,
  "APK 启动时必须显示底栏");
assert.match(shell, /function setChromeShown\(show\) \{\s*if \(isAndroidRuntime\(\)\) show = true;/,
  "APK 不允许任何收起路径隐藏底栏");
assert.match(shell, /document\.addEventListener\("pointerdown", \(e\) => \{\s*if \(isAndroidRuntime\(\)\) return;/,
  "APK 点击内容时不能自动隐藏底栏");
assert.match(shell, /if \(!isAndroidRuntime\(\)\) attachRailDockDrag\(/,
  "APK 底栏按钮不能被拖动重排");
for (const [id, label] of [["cppu-credit", "成绩"], ["shiguang-schedule", "课表"]]) {
  assert.ok(shell.includes(`"plug:${id}", "${label}"`), `APK 底栏缺少${label}直达入口`);
}
assert.match(styles, /\.app\.android-runtime \.rail \{ display: flex; animation: none; \}/,
  "APK 底栏必须常驻且不播放位移动画");
assert.match(styles, /\.app\.android-runtime\.rail-hidden \.view\s*\{[^}]*padding-bottom:/,
  "沉浸式课表必须为常驻底栏预留空间");
assert.match(styles, /\.app\.android-runtime \.rail-dock > \.rail-dock-btn\s*\{[^}]*touch-action: manipulation;/,
  "APK 底栏快捷键应使用普通点击手势");

console.log("PASS: Android bottom bar stays fixed with Grades and Timetable shortcuts");
