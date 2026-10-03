import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (relativePath) => readProductSource(new URL(relativePath, import.meta.url), "utf8");
const css = read("../src/styles/interactions.css");
const motion = read("../src/motion.js");
const ui = read("../src/ui.js");
const commandPalette = read("../src/commandPalette.js");
const capture = read("../src/capture.js");
const drawer = read("../src/views/drawer.js");
const timeblock = read("../src/views/timeblock.js");
const automationPanel = read("../src/views/aiAutomationPanel.js");
const shell = read("../src/shell.js");

assert.match(css, /\.motion-pressing/);
assert.match(css, /\.motion-ripple/);
assert.match(css, /motion-button-release/);
assert.match(css, /motion-close-button-release/);
assert.match(css, /motion-drawer-in/);
assert.match(css, /motion-drawer-out/);
assert.match(css, /motion-center-layer-in/);
assert.match(css, /motion-top-layer-out/);
assert.match(css, /motion-page-forward-in/);
assert.match(css, /motion-page-back-in/);
assert.match(css, /motion-plugin-card-in/);
assert.match(css, /market-card-enter/);
assert.match(css, /prefers-reduced-motion:\s*reduce/);
assert.match(css, /data-ui-motion="reduced"/);
assert.match(motion, /export function initMotionInteractions/);
assert.match(motion, /export function observePluginMotion/);
assert.match(motion, /new MutationObserver/);
assert.match(motion, /export function closeLayer/);
assert.match(motion, /function addRipple/);
assert.match(motion, /panel\.dataset\.motionLayer = layerKind/);
assert.match(motion, /event\.target !== target/);
assert.match(ui, /removeWithMotion\(t\)/);
assert.match(shell, /removeWithMotion\(menu\)/);
assert.match(shell, /observePluginMotion\(box\)/);

/* 「弹 2 下」修复守卫（用户视频反馈：打开插件/切侧边栏界面弹两下）：
   1) 切视图不再播放旧页出场动画——出场 + 入场 + 插件首绘三层叠加 = 弹两下；
   2) 插件重绘动画挂载宽限期（视图入场期间插件首绘不叠加）；
   3) 重绘动画只留淡入，不许再有 7px 位移的「弹跳」。 */
assert.doesNotMatch(shell, /shouldAnimateExit/, '切视图不许再播旧页出场动画——和入场叠加就是「弹 2 下」');
assert.match(motion, /settleMs = 350/, 'observePluginMotion 必须有挂载宽限期');
assert.doesNotMatch(motion, /translate3d\(0, 7px, 0\)/, '插件重绘动画不许带位移——淡入即可，位移就是「弹」');
assert.match(motion, /startedAt/, '宽限期需要挂载时间戳');
for (const source of [commandPalette, capture, drawer, timeblock, automationPanel]) {
  assert.match(source, /closeLayer\(/);
}

console.log("PASS: smooth button feedback, layered enter/exit motion and reduced-motion fallback");
