import assert from "node:assert/strict";
import { readProductSource } from "./lib/read-product-source.mjs";

/* 设置页控件的「框体」契约（v0.188.0）。
 *
 * 用户口径：「只有输入数字才是『裸值 + 聚焦才显框』，其他都是[框]」。
 * 仓库历史也这么走：v0.162.0 让文本 / 数字 / 时间 / 下拉 / 多行一起裸着，
 * v0.167.1 又把裸值收回到**数字输入**（见 docs/CHANGELOG-v0.167.1.md）。
 * 但 styles.css 里的选择器一直写成 `input:not([type="checkbox"]):not([type="radio"])…`，
 * 把设置页**所有**文本 / URL / 密码 / 搜索 / 多行输入都吃掉 —— 真渲染实测（1280×900、
 * nephele 风格 + 暮光紫深色 + 文字大小 125%）有 **27 个非数字输入框**是透明无描边的裸值，
 * 连自带框体的 `.plugin-search-input`（styles.css:2082 有 border/background）都变透明。
 * 这条守卫把「只吃数值类」钉住，防止再被写宽。 */

const styles = readProductSource(new URL("../src/styles.css", import.meta.url), "utf8");

const bareRule = styles.match(/\.set-wrap \.settings-section :is\([^{}]*\)\s*\{[^}]*\}/)?.[0] ?? "";
assert.ok(bareRule, "设置区「裸值」规则必须存在（数字 / 时间框平时融入面板）");
assert.match(bareRule, /:is\(input\[type="number"\], input\[type="time"\]\)/,
  "裸值规则只许匹配数字与时间输入");
assert.doesNotMatch(bareRule, /\[type="checkbox"\]|\[type="radio"\]|textarea|select/,
  "回归：裸值规则不许再连文本 / URL / 密码 / 搜索 / 多行 / 下拉一起吃掉");
assert.match(bareRule, /background: transparent !important/,
  "数字框未编辑时要真的透明（要压过全局控件的 --control-bg !important）");
assert.match(bareRule, /border-color: transparent !important/,
  "数字框未编辑时不许有可见描边");

const focusRule = styles.match(/\.set-wrap \.settings-section :is\([^{}]*\):focus \{[\s\S]*?\n\}/)?.[0] ?? "";
assert.ok(focusRule, "设置区的聚焦规则必须存在");
assert.match(focusRule, /background: var\(--control-bg\) !important/, "聚焦时要显出输入框底色");
assert.match(focusRule, /box-shadow: 0 0 0 3px var\(--focus-ring\)/, "聚焦要保留焦点环");

// 非数字输入框的常驻框体来自全局控件规则，别把它从这条规则里漏掉
assert.match(styles, /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\), select, textarea,/,
  "全局控件规则要覆盖 input / select / textarea（文本类的框体由它提供）");

console.log("PASS: 设置页框体契约 —— 只有数字 / 时间输入是裸值，文本 / URL / 密码 / 搜索 / 多行一律常驻框体");
