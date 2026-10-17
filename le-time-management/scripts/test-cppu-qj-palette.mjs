/*
 * 「警大请假」（cppu-notify 的 cppu-qj 视图）配色回归测试。
 *
 * 用户诉求：「给警大请假界面按 skill 修改」= 让请假页与「警大成绩」说同一种颜色语言：
 *   ① 状态四档（已同意 / 审批中 / 未同意 / 已撤销）复用成绩页分数四档的色相；
 *   ② 首屏加一张与成绩页同构的汇总卡（同一个 .jg-card + .jg-metrics + .jg-note 骨架）；
 *   ③ 请假理由、课次行、课程名这些「内容」不再用 --ink-3（浅色面板上只有 3.49:1）。
 *
 * 事实源：public/plugins/cppu-notify/main.js 的 ensureStyle() 模板串 + jwLeaveHtml/ jwLeaveTone / jwLeaveSummaryHtml。
 * 色板事实源：src/styles.css（浅色，手写）→ tools/lib/theme-tokens.js 的 deriveDark()（深色，派生）。
 * 断言分三层：结构（作用域不能外溢）→ 色相（与成绩页同色系）→ 实算对比度（8% 掺底 + 文字 ≥ 4.5:1，遍历 16 套主题）。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readProductSource } from "./lib/read-product-source.mjs";

const require = createRequire(import.meta.url);
const { parsePalettes, deriveDark, contrastRatio, relativeLuminance, rgbToHsl, hexToRgb } = require("../../tools/lib/theme-tokens.js");

const read = (p) => readProductSource(new URL(p, import.meta.url), "utf8");
const pluginSrc = read("../public/plugins/cppu-notify/main.js");
const lightPal = parsePalettes(read("../src/styles.css"));

/* ── 1. 结构：四档规则只作用在 .jw-leave 内（选课 / 创新学分页的旧 .jw-tag 色有自己的对比度断言） ── */
const rule = (prefix) =>
  new RegExp(`(?:^|\\n)[ \\t]*${prefix}\\.jw-leave \\.jw-tag\\.(ok|warn|bad|muted)\\{([^}]*)\\}`, "g");
const lightRules = [...pluginSrc.matchAll(rule(""))];
const darkRules = [...pluginSrc.matchAll(rule('\\[data-theme-mode="dark"\\] '))];
assert.equal(lightRules.length, 4, "浅色四档规则应为 4 条（ok / warn / bad / muted）");
assert.equal(darkRules.length, 4, "深色四档规则应为 4 条");
assert.deepEqual(lightRules.map((m) => m[1]), ["ok", "warn", "bad", "muted"]);
assert.deepEqual(darkRules.map((m) => m[1]), ["ok", "warn", "bad", "muted"]);
// 未加 `.jw-leave` 作用域的旧三条仍然只有三条、且仍是硬编码色 —— test-theme-contrast.mjs 数着它们
const legacy = [...pluginSrc.matchAll(/(?:^|\n)[ \t]*\.jw-tag\.(ok|warn|live)\{[^}]*color:#[0-9A-Fa-f]{6}/g)];
assert.equal(legacy.length, 3, "旧 .jw-tag.ok/.warn/.live 浅色规则被动过了（应为 3 条硬编码色）");
// 「内容字号」提到 --ink-2 的四处
for (const sel of [".jw-leave .jw-why", ".jw-leave .jw-row small", ".jw-leave .jw-leave-draft small"]) {
  assert.match(pluginSrc, new RegExp(sel.replace(/[.\\]/g, "\\$&") + "\\{color:var\\(--ink-2\\)\\}"), `${sel} 应提到 --ink-2`);
}
assert.match(pluginSrc, /\.jw-leave \.jw-card-t\{color:var\(--deep\)\}/, "请假页课程名应与成绩页卡片标题同色（--deep）");

/* ── 2. 色相：四档与成绩页同色系（色相差 ≤ 2°，"未同意" 直接用成绩页 bad 原值） ── */
const gradeTone = (cls, dark) => {
  // 成绩页四档写在同一行里（.jg-good{…}.jg-mid{…}.jg-warn{…}），所以不能按行首锚定
  const re = new RegExp(`${dark ? '\\[data-theme-mode="dark"\\] ' : ""}\\.jg-${cls}\\{color:(#[0-9A-Fa-f]{6})\\}`);
  const m = pluginSrc.match(re);
  assert.ok(m, `成绩页 .jg-${cls}${dark ? "（深色）" : ""} 规则没找到`);
  return m[1];
};
const leaveTone = (name, dark) => {
  const src = dark ? darkRules : lightRules;
  const body = src.find((m) => m[1] === name)[2];
  const color = body.match(/color:(#[0-9A-Fa-f]{6})/);
  assert.ok(color, `.jw-leave .jw-tag.${name} 应有硬编码文字色（深色才对，浅色也各有一档）`);
  return color[1];
};
const pairs = [
  ["ok", "good"], ["warn", "warn"], ["bad", "bad"],
];
for (const dark of [false, true]) {
  for (const [leaveName, gradeName] of pairs) {
    const a = leaveTone(leaveName, dark), b = gradeTone(gradeName, dark);
    const dh = Math.abs(rgbToHsl(hexToRgb(a)).h - rgbToHsl(hexToRgb(b)).h);
    const hue = Math.min(dh, 360 - dh);
    assert.ok(hue <= 2, `${dark ? "深色" : "浅色"} ${leaveName} ${a} 与成绩页 ${gradeName} ${b} 色相差 ${hue.toFixed(1)}°（要求 ≤2°，即同一色系）`);
  }
}
// 未同意 / 已同意 深色档与成绩页同值，浅色档是「加深一档」的压底版本，必须比成绩页版本更深（更压得住浅掺底）
const lum = (hex) => {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
for (const [leaveName, gradeName] of [["ok", "good"], ["warn", "warn"]]) {
  assert.ok(lum(leaveTone(leaveName, false)) < lum(gradeTone(gradeName, false)), `浅色 ${leaveName} 应比成绩页 ${gradeName} 更深一档`);
  assert.equal(leaveTone(leaveName, true), gradeTone(gradeName, true), `深色 ${leaveName} 应直接沿用成绩页 ${gradeName}`);
}

/* ── 3. 对比度：文字 vs「同色 8% 实底」，覆盖 16 套主题真正渲染到的那一两套色板 ──
 *    坑 1：hexToRgb() 返回 {r,g,b}，不是数组 —— 用 f[i] 取通道会得到 #NaNNaNNaN 和假的 3.42:1。
 *    坑 2：浅色要叠 theme-derived.css 的 :root[data-theme="id"]{…} 修正块（--ink-2 的运行时值来自它，
 *          src/styles.css 里的 #7E8B94 不是渲染值）；深色用 deriveDark() 派生，但 night 主题本身就是深色，
 *          它渲染的是自己的面板（#1C2833），deriveDark(night) 的 #21272E 不是它。 */
const over = (tint, alpha, base) => {
  const f = hexToRgb(tint), b = hexToRgb(base);
  const ch = [f.r, f.g, f.b], bc = [b.r, b.g, b.b];
  return "#" + ch.map((v, i) => Math.round(alpha * v + (1 - alpha) * bc[i]).toString(16).padStart(2, "0")).join("");
};
const toneOf = (list, name) => {
  const body = list.find((m) => m[1] === name)[2];
  const color = body.match(/color:(#[0-9A-Fa-f]{6})/)[1];
  const bg = body.match(/background:rgba\((\d+),(\d+),(\d+),\.(\d+)\)/);
  assert.ok(bg, `.jw-leave .jw-tag.${name} 的底应是「同色实底」的 rgba()`);
  return { color, alpha: parseFloat("0." + bg[4]), tint: "#" + [1, 2, 3].map((i) => Number(bg[i]).toString(16).padStart(2, "0")).join("") };
};
const TINT = 0.08; // 8%：10% 时褐底主题（fresh / claude / dunhuang / citrus）的深色红只有 4.38:1，8% 时最差 4.55:1
for (const [label, list] of [["浅色", lightRules], ["深色", darkRules]]) {
  for (const name of ["ok", "warn", "bad"]) {
    assert.equal(toneOf(list, name).alpha, TINT, `${label} ${name} 的掺底透明度应为 ${TINT}（改了要重算 16 套主题的最差值）`);
  }
}
const fixes = {};
for (const m of read("../src/styles/theme-derived.css").matchAll(/:root\[data-theme="([\w-]+)"\]\s*\{([^}]*)\}/g)) {
  fixes[m[1]] = Object.fromEntries([...m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()]));
}
const surfaces = [];
for (const id of Object.keys(lightPal)) {
  const light = { ...lightPal[id], ...(fixes[id] || {}) };
  if (relativeLuminance(light["--panel"]) > 0.5) surfaces.push([`${id}/浅色`, lightRules, light]);
  surfaces.push([`${id}/深色`, darkRules, id === "night" ? light : { ...deriveDark(lightPal[id], {}) }]);
}
assert.ok(surfaces.length >= 30, `应覆盖 16 套主题的浅/深色板（现 ${surfaces.length}）`);
let worstTone = 99, worstAt = "";
for (const [label, list, pal] of surfaces) {
  const panel = pal["--panel"];
  for (const name of ["ok", "warn", "bad"]) {
    const { color, alpha, tint } = toneOf(list, name);
    const ratio = contrastRatio(color, over(tint, alpha, panel));
    if (ratio < worstTone) { worstTone = ratio; worstAt = `${label} ${name}`; }
    assert.ok(ratio >= 4.5, `${label} ${name}：${color} 压在 ${alpha * 100}% 掺底上只有 ${ratio.toFixed(2)}:1（要求 ≥4.5，字号只有 10.5px）`);
  }
  // muted 走中性底：--ink-2 on --paper
  assert.match(list.find((m) => m[1] === "muted")[2], /background:var\(--paper\)/, `${label} muted 底应为 --paper`);
  assert.match(list.find((m) => m[1] === "muted")[2], /color:var\(--ink-2\)/, `${label} muted 文字应为 --ink-2`);
  const mutedRatio = contrastRatio(pal["--ink-2"], pal["--paper"]);
  assert.ok(mutedRatio >= 4.5, `${label} muted：--ink-2 压 --paper 只有 ${mutedRatio.toFixed(2)}:1`);
  // 请假理由 / 课次行 / 草稿说明落在面板上
  const ink2Panel = contrastRatio(pal["--ink-2"], panel);
  assert.ok(ink2Panel >= 4.5, `${label}：--ink-2 压 --panel 只有 ${ink2Panel.toFixed(2)}:1`);
}
assert.ok(worstTone >= 4.5, `四档最差值 ${worstTone.toFixed(2)}:1 出现在 ${worstAt}`);

/* ── 4. 行为接线：四档映射、汇总卡骨架、请假页整体包在 .jw-leave 里 ── */
assert.match(
  pluginSrc,
  /const jwLeaveTone = \(code\) => \(\{ "2": "ok", "1": "warn", "3": "bad", "0": "muted" \}\[String\(code \?\? ""\)\.trim\(\)\] \|\| ""\)/,
  "jwLeaveTone 的四档映射（已同意/审批中/未同意/已撤销）变了",
);
assert.match(pluginSrc, /jwTag\(jwDict\("SQZT", r\.SQZT\), jwLeaveTone\(r\.SQZT\)\)/, "记录卡状态标签应走 jwLeaveTone");
assert.match(pluginSrc, /function jwLeaveSummaryHtml\(\)/, "缺少请假页首屏汇总卡");
assert.match(pluginSrc, /<section class="jg-card"><div class="jg-metrics">/, "汇总卡应与成绩页同构（.jg-card + .jg-metrics）");
assert.match(pluginSrc, /<div class="jg-note">可请假课次 \$\{courses\.length\} 节/, "汇总卡说明行缺失");
assert.match(pluginSrc, /if \(!rec\.length && !courses\.length\) return ""/, "无数据时汇总卡应返回空串，不留空卡");
assert.match(pluginSrc, /return `<div class="jw-leave">`\s*\n\s*\+ jwLeaveSummaryHtml\(\)\s*\n\s*\+ jwSection\("请假记录"/, "请假页应由 .jw-leave 包裹「汇总 + 请假记录 + 可请假课次」");
assert.match(pluginSrc, /\+ jwSection\("可提请假的课次"[\s\S]{0,80}\+ `<\/div>`;/, "请假页少了 .jw-leave 的闭合");

console.log(`PASS: 警大请假四档配色（.jw-leave 作用域 / 与成绩页同色系 / 8% 掺底对比度最差 ${worstTone.toFixed(2)}:1 ≥4.5，覆盖 ${surfaces.length} 套主题色板）、--ink-2 内容色、汇总卡与成绩页同构接线`);
