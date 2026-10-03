import { readProductSource } from "./lib/read-product-source.mjs";
/*
 * 插件管理「批量勾选错落动画」回归测试 —— v0.52.0
 *
 * 守住这几件事：
 *   ① 全选/取消全选不再整页 rerender —— 就地翻勾选框 + paintToolbar()（与单个勾选同一条
 *      「不重建整页」的优化路线，v0.48.0 批次四确立）。
 *   ② 错落动画：状态变化的卡片按 --bi 延迟逐个弹起（bulk-pop），勾选框本体也有弹跳（bulk-check）；
 *      动画类用完即摘（animationend + setTimeout 兜底），连续点击全选可重启动画。
 *   ③ 隐藏卡（搜索/筛选后 hidden）状态照翻但不出动画；reducedMotion 时整段动画短路。
 *   ④ 全选范围仍 = 全部插件（内置 + 用户），与 v0.48.0 语义一致。
 *   ⑤ 卡片必须带 data-pid（全选循环靠它定位勾选框）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readProductSource(path.join(here, rel), "utf8");

const pluginsJs = read("../src/views/settings/plugins.js");
const styles = read("../src/styles.css");

/* ── ① 全选不重建整页 ── */
const selAt = pluginsJs.indexOf('const selectAllBtn = el("button"');
assert.ok(selAt > -1, "没找到全选按钮");
const selBlock = pluginsJs.slice(selAt, pluginsJs.indexOf('const deleteSelBtn', selAt));
assert.ok(selBlock.length > 0, "全选按钮代码块定位失败");
assert.ok(!/rerender\(\)/.test(selBlock),
  "全选/取消全选不许再 rerender() —— 就地翻勾选框即可，整页重建会卡顿并弹回顶部");
assert.match(selBlock, /paintToolbar\(\)/, "全选后必须 paintToolbar() 同步工具栏计数与按钮态");
assert.match(selBlock, /const reduced = reducedMotion\(\)/, "全选动画必须先问 reducedMotion()");
assert.match(pluginsJs, /import \{ reducedMotion \} from "\.\.\/\.\.\/motion\.js"/,
  "plugins.js 必须引入 reducedMotion()");

/* ── ② 错落动画与就地翻勾 ── */
assert.match(selBlock, /card\.style\.setProperty\("--bi", `\$\{bi \* 45\}ms`\)/,
  "错落延迟必须按序写 --bi（45ms 递增），否则不是「错落」");
assert.match(selBlock, /card\.classList\.add\("bulk-pop"\)/, "状态变化的卡片必须加 bulk-pop 动画类");
assert.match(selBlock, /void card\.offsetWidth;/, "重启动画前必须强制 reflow（连续点击全选也能从头弹）");
assert.match(selBlock, /addEventListener\("animationend", \(\) => card\.classList\.remove\("bulk-pop"\), \{ once: true \}\)/,
  "动画类必须用完即摘（animationend once），不能永久挂在卡片上");
assert.match(selBlock, /setTimeout\(\(\) => card\.classList\.remove\("bulk-pop"\), 1200\)/,
  "animationend 不发时要有 setTimeout 兜底摘类");
assert.match(selBlock, /if \(changed && !reduced && !card\.hidden\)/,
  "动画只给「状态变化 + 可见」的卡片；隐藏卡与 reducedMotion 都不出动画");
assert.match(selBlock, /if \(input\) input\.checked = now;/,
  "就地翻勾：必须直接改勾选框 checked，不重建 DOM");
assert.match(selBlock, /now \? selectedPlugins\.add\(pid\) : selectedPlugins\.delete\(pid\)/,
  "选择集 Set 必须与勾选框同步更新");

/* ── ③ 全选范围仍 = 全部插件 ── */
assert.match(selBlock, /const allOn = regs\.length > 0 && regs\.every\(\(r\) => selectedPlugins\.has\(r\.id\)\)/,
  "全选范围必须仍是全部插件（内置 + 用户），v0.48.0 语义不变");
assert.match(selBlock, /const now = !allOn;/, "取消全选必须完整可逆");

/* ── ④ data-pid ── */
assert.match(pluginsJs, /"data-pid": rec\.id,/, "插件卡必须带 data-pid（全选循环靠它定位）");

/* ── ⑤ CSS ── */
assert.match(styles, /\.plug-card\.bulk-pop \{ animation: plug-bulk-pop/, "bulk-pop 动画类必须有 CSS 定义");
assert.match(styles, /\.plug-card\.bulk-pop \.plugin-select input \{ animation: plug-bulk-check/,
  "勾选框本体的弹跳动画必须有 CSS 定义");
assert.match(styles, /animation-delay: var\(--bi, 0ms\)/, "CSS 必须消费 --bi 错落延迟变量");
assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\.plug-card\.bulk-pop/,
  "CSS 必须有 prefers-reduced-motion 兜底");

console.log("PASS: 插件管理批量勾选错落动画（全选不重建 / 就地翻勾 / --bi 错落 / 隐藏卡与 reducedMotion 短路 / data-pid）");
