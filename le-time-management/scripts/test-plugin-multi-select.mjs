import { readProductSource } from "./lib/read-product-source.mjs";
/*
 * 设置 → 插件管理「全量多选 + 批量启停」回归测试 —— v0.48.0 批次四
 *
 * 守四件事：
 *   ① 勾选框覆盖**全部**插件（内置插件也能量选），不再给内置插件留 `.plugin-select-spacer` 空位；
 *      「不能删」只限制删除与导出，不等于「不能选」。
 *   ② 批量启停（开启所选 / 关闭所选）走 setEnabled(id, on)，且只翻转状态确实不同的那些；
 *      删除所选仍然只作用于用户插件。
 *   ③ 勾选**不整页 rerender()** —— 只刷新工具栏（计数 / 按钮可用态 / 全选文案）。
 *      每个勾都重建整页在插件多时明显卡顿，还会把滚动位置弹回顶部。
 *   ④ 批量期间压住 onNavChanged 触发的整页重建：setEnabled() 每次都会 emitNavChanged()，
 *      12 个插件就会重建 12 次。settings.js 必须用 isPluginBatchBusy() 挡掉。
 *
 * 静态断言守源码不变量；行为面（真的点勾、真的批量、真的落盘、重建次数）由真浏览器探针
 * `.workbuddy-ai/tmp/probe-plugin-multiselect.cjs` 实测，两边一起才算过。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readProductSource(path.join(here, rel), "utf8");

const pluginsJs = read("../src/views/settings/plugins.js");
const settingsJs = read("../src/views/settings.js");
const styles = read("../src/styles.css");

/* ── ① 全量勾选框 ── */
assert.ok(!/plugin-select-spacer/.test(pluginsJs),
  "插件管理里不许再有 .plugin-select-spacer —— 内置插件也要能勾选（批量启停对两者都有效）");
assert.ok(!/plugin-select-spacer/.test(styles),
  "styles.css 里 .plugin-select-spacer 的样式应随之删除，别留死规则");
assert.match(pluginsJs, /class:\s*"plugin-select"[\s\S]{0,200}type:\s*"checkbox"/,
  "每张插件卡都要有 .plugin-select 包裹的勾选框（含内置插件）");
assert.match(pluginsJs, /for \(const id of \[\.\.\.selectedPlugins\]\) if \(!regs\.some\(/,
  "选择集清理必须对着全量 regs 校验，不能只对 userRegs（否则内置插件的选择会被误删）");

/* ── ② 批量启停 + 删除仍限用户插件 ── */
assert.match(pluginsJs, /const applyBulkEnabled = async \(on\) => \{/,
  "必须有批量启停的统一入口 applyBulkEnabled(on)");
assert.match(pluginsJs, /await setEnabled\(id, on\)/,
  "批量启停必须走 pluginHost 的 setEnabled，别直接改 store（否则插件不会真的加载/卸载）");
assert.match(pluginsJs, /const targets = ids\.filter\(\(id\) => \(S\.pluginState\(id\)\.enabled !== false\) !== on\)/,
  "批量启停只翻转状态确实不同的插件，避免无谓重载");
assert.match(pluginsJs, /onclick: \(\) => applyBulkEnabled\(true\)[\s\S]{0,120}"开启所选"/,
  "「开启所选」按钮必须接到 applyBulkEnabled(true)");
assert.match(pluginsJs, /onclick: \(\) => applyBulkEnabled\(false\)[\s\S]{0,120}"关闭所选"/,
  "「关闭所选」按钮必须接到 applyBulkEnabled(false)");
assert.match(pluginsJs, /const selectedUserIds = \(\) => userRegs\.filter\(/,
  "删除/导出仍只作用于用户插件（内置插件不可删）");
assert.match(pluginsJs, /deleteSelBtn\.disabled = delCount === 0/,
  "只勾了内置插件时「删除所选」必须保持禁用");

/* ── ③ 勾选只刷新工具栏，不整页重建 ── */
const selectorBlock = pluginsJs.slice(pluginsJs.indexOf('class: "plugin-select"'), pluginsJs.indexOf("const enabledForSwitch"));
assert.ok(selectorBlock.length > 0, "没找到勾选框所在代码块");
assert.match(selectorBlock, /paintToolbar\(\)/,
  "勾选框 onchange 必须只调 paintToolbar()，刷新工具栏即可");
assert.ok(!/rerender\(\)/.test(selectorBlock),
  "勾选框 onchange 里不许再调 rerender() —— 每点一个勾重建整页会卡顿并弹回顶部");
assert.match(pluginsJs, /const paintToolbar = \(\) => \{/,
  "必须有 paintToolbar()：同步计数、批量按钮可用态、全选文案、删除所选计数");
assert.match(pluginsJs, /toolbarCount\.textContent = total \? `已选 \$\{total\} \/ \$\{regs\.length\}`/,
  "工具栏要显示「已选 N / 总数」");
assert.match(styles, /\.plugin-toolbar-count\s*\{[^}]*margin-left:auto/,
  "计数要贴工具栏右端（.plugin-toolbar-count { margin-left:auto }）");
// 断点用 px：曾改成 em 试图跟随界面缩放，实测 em 媒体查询不认 zoom（见 styles.css 顶部），已回退。
assert.match(styles, /@media \(max-width: 760px\) \{\s*\.plugin-toolbar-count \{ margin-left:0; flex:1 1 100%; text-align:right; \}/,
  "窄屏下按钮本来就要换行，计数得单独占一行靠右，别跟按钮抢行");

/* ── ④ 批量期间压住整页重建 ── */
assert.match(pluginsJs, /export function isPluginBatchBusy\(\) \{ return pluginBatchBusy; \}/,
  "plugins.js 必须导出 isPluginBatchBusy()");
assert.match(pluginsJs, /pluginBatchBusy = true;[\s\S]{0,600}finally \{\s*pluginBatchBusy = false;/,
  "批量循环必须用 try/finally 置位与复位 pluginBatchBusy（中途抛错也要复位）");
assert.match(settingsJs, /import \{ createPluginSettingsCard, isPluginBatchBusy \} from "\.\/settings\/plugins\.js"/,
  "settings.js 必须引入 isPluginBatchBusy");
assert.match(settingsJs, /onNavChanged\(\(\) => \{ if \(container\.isConnected && !isPluginBatchBusy\(\)\) render\(\); \}\)/,
  "onNavChanged 回调必须跳过批量期间的重建，否则批量 N 个插件就重建 N 次");

console.log("PASS: 插件管理全量多选与批量启停（勾选框覆盖全量 / 批量启停 / 勾选不重建 / 批量期守卫）");
