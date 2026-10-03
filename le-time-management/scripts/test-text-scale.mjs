import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeUiPreferences } from "../src/uiPreferences.js";
import { TEXT_SCALE_LIMITS } from "../src/uiPreferences.js";

/* ═══════════════════════════════════════════════════════════════
   「文字大小」(--ui-text-scale) 全量覆盖守卫（v0.55.0）

   背景：v0.54.0 及以前，--ui-text-scale 只乘 8 条手写 font-size，
   其余几百条字号（含全部插件）对「文字大小」无感 —— 用户要求
   「文字放缩影响所有文字」。v0.55.0 起每一条 px font-size 都必须
   写成 calc(Npx * var(--ui-text-scale))。

   本守卫四件事：
   ① 覆盖：扫 styles.css + 内联字号的 JS + mobile.html + 全部插件，
      任何「裸 px font-size」都算失败（豁免：注释、font-size:0、
      .wk-* 课表族内跟随已缩放父级的 em）。
   ② 动态字号：JS 里 `.fontSize =` 赋值必须引用 var(--ui-text-scale)。
   ③ 契约：滑杆 min/max/step 来自 TEXT_SCALE_LIMITS（不许写死 90/120）。
   ④ 行为：normalizeUiPreferences 对新区间的夹取与步进对齐。
   ═══════════════════════════════════════════════════════════════ */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const APP_FILES = [
  "src/styles.css",
  "src/views/settings.js",
  "src/capture.js",
  "src-tauri/src/mobile.html",
  "public/plugins/shiguang-schedule/ui.js",
  "public/plugins/exam-calendar/src/main.template.js",
];
const PLUGIN_IDS = [
  "cppu-notify", "inbox-drop", "rss-reader", "chaoxing-notify", "dorm-duty",
  "cn-holiday", "gx-news", "pomodoro", "school-notice", "weekly-report",
  "plugin-guide", "wechat-push", "web-collector",
];
const ALL_FILES = [
  ...APP_FILES,
  ...PLUGIN_IDS.map((id) => `public/plugins/${id}/main.js`),
];

/** 判断该行是否处于注释中（行首是注释标记，或匹配点之前出现行注释起始）。 */
function inComment(line, matchIndex) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return true;
  const before = line.slice(0, matchIndex);
  if (before.includes("//")) return true; // 行尾注释
  return false;
}

let totalScaled = 0;
const violations = [];
const emOutsideWeek = [];

for (const rel of ALL_FILES) {
  const raw = readProductSource(join(root, rel), "utf8");
  // CSS 块注释整段剥掉（styles.css 的说明注释里会出现示例值）
  const content = rel.endsWith(".css") ? raw.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)) : raw;
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    // ① 每一条 px font-size 都必须带乘数
    const re = /font-size\s*:\s*[^;}]+/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const decl = m[0];
      if (inComment(line, m.index)) continue;
      if (/var\(--ui-text-scale/.test(decl)) { totalScaled++; continue; }
      if (/font-size\s*:\s*0\s*($|[;}\s])/.test(decl)) continue; // 图标占位隐藏，乘不乘都是 0
      if (/font-size\s*:\s*[\d.]+em\b/.test(decl)) {
        // em 跟随父级：只允许 .wk-* 课表族（其根 .wakeup-grid 已乘两个因子）
        if (/\.wk-|\.wakeup-/.test(line)) continue;
        emOutsideWeek.push(`${rel}:${i + 1}: ${decl.trim().slice(0, 80)}`);
        continue;
      }
      violations.push(`${rel}:${i + 1}: ${decl.trim().slice(0, 100)}`);
    }
    // ② JS 动态字号必须走 var
    if (/\.fontSize\s*=\s*[^;]+;/.test(line) && !/var\(--ui-text-scale/.test(line) && !inComment(line, 0)) {
      violations.push(`${rel}:${i + 1}: 动态 fontSize 未接 --ui-text-scale: ${line.trim().slice(0, 100)}`);
    }
  });
}

assert.deepEqual(violations, [], [
  `发现 ${violations.length} 条未接 --ui-text-scale 的 px font-size（新增字号请写成 calc(Npx * var(--ui-text-scale))）：`,
  ...violations,
].join("\n"));
assert.deepEqual(emOutsideWeek, [], "em 字号只允许出现在 .wk-* 课表族（其根已乘 --ui-text-scale）：" + emOutsideWeek.join("\n"));
// 体量兜底：整批改写约 630+8 处，若大面积回退（比如被旧版本覆盖）这里先红
assert.ok(totalScaled >= 600, `已接入乘数的 font-size 仅 ${totalScaled} 处（应 ≥600），疑似大面积回退`);

// ④ mobile.html 是独立文档（没有 uiPreferences 注入），必须自带兜底
const mobileHtml = readProductSource(join(root, "src-tauri/src/mobile.html"), "utf8");
assert.match(mobileHtml, /:root\{[^}]*--ui-text-scale:1/, "mobile.html 独立加载，:root 必须自带 --ui-text-scale:1 兜底");

// ③ 契约：设置页滑杆从 TEXT_SCALE_LIMITS 取值，不许写死 90/120
const appearance = readProductSource(join(root, "src/views/settings/appearance.js"), "utf8");
assert.match(appearance, /min:\s*String\(TEXT_SCALE_LIMITS\.min\)/, "滑杆 min 必须来自 TEXT_SCALE_LIMITS");
assert.match(appearance, /max:\s*String\(TEXT_SCALE_LIMITS\.max\)/, "滑杆 max 必须来自 TEXT_SCALE_LIMITS");
assert.match(appearance, /step:\s*String\(TEXT_SCALE_LIMITS\.step\)/, "滑杆 step 必须来自 TEXT_SCALE_LIMITS");
assert.doesNotMatch(appearance, /type:\s*"range",\s*min:\s*"9\d"/, "滑杆不许再写死旧下限 90");
// normalizeUiPreferences 必须引用 TEXT_SCALE_LIMITS（单一事实源），不许出现字面量 90/120 夹取
const uiPrefs = readProductSource(join(root, "src/uiPreferences.js"), "utf8");
assert.match(uiPrefs, /clamp\(next\.textScale,\s*TEXT_SCALE_LIMITS\.min,\s*TEXT_SCALE_LIMITS\.max\)/,
  "textScale 夹取必须用 TEXT_SCALE_LIMITS");
assert.doesNotMatch(uiPrefs, /clamp\(next\.textScale,\s*9\d\s*,\s*1\d\d\)/, "textScale 不许写死旧区间 90~120");

// ④ 行为：新区间 80~150、步进 5
assert.deepEqual(TEXT_SCALE_LIMITS, { min: 80, max: 150, step: 5 });
assert.equal(normalizeUiPreferences({ textScale: 79 }).textScale, 80);
assert.equal(normalizeUiPreferences({ textScale: 151 }).textScale, 150);
assert.equal(normalizeUiPreferences({ textScale: 100 }).textScale, 100);

console.log(`PASS: text-scale 全量覆盖守卫 —— ${totalScaled} 条 font-size 已接 --ui-text-scale，区间 80~150，滑杆契约与动态字号契约成立`);
