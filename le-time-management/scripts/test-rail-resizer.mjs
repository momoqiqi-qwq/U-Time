import { readProductSource } from "./lib/read-product-source.mjs";
/* 侧栏宽度分隔条（v0.58.0）的回归测试。
 *
 * 分两块：
 *  1. `src/railWidth.js` 的纯逻辑 —— 落盘值闸门 / 拖动夹取 / 键盘步进 / DOM 应用出口。
 *  2. **源码守卫** —— 最容易回归的部分：
 *     - 窄屏（≤900px）媒体查询里必须 `.rail-resizer { display: none; }`：flex 子元素
 *       默认 order:0 会排到底栏上方，漏掉这条分隔条会横在窄屏顶部；
 *     - 桌面几何必须有 `touch-action: none`（否则触摸拖动变成滚动、pointermove 断流）
 *       与 `cursor: col-resize`；
 *     - 拖拽会话必须有 document 捕获阶段的 pointerup 兜底 + iframe 禁命中
 *       （插件 iframe 会吞指针，拖到一半卡死）；
 *     - 两条落盘路径（拖动松手 / 键盘）都必须写 settings.railWidth。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  RAIL_WIDTH_LIMITS,
  RAIL_WIDTH_STEP,
  applyRailWidth,
  clampRailWidth,
  normalizeRailWidth,
  steppedRailWidth,
} from "../src/railWidth.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/* ── 1. 纯逻辑 ── */

// 落盘值闸门：合法值原样（取整），越界夹取，脏数据一律 null（= 恢复 CSS 默认）
assert.equal(normalizeRailWidth(224), 224);
assert.equal(normalizeRailWidth("224"), 224);
assert.equal(normalizeRailWidth(224.4), 224); // 取整
assert.equal(normalizeRailWidth(100), RAIL_WIDTH_LIMITS.min); // 越下界夹取
assert.equal(normalizeRailWidth(9999), RAIL_WIDTH_LIMITS.max); // 越上界夹取
assert.equal(normalizeRailWidth(0), null); // Number("") === 0，同当「没设置过」
assert.equal(normalizeRailWidth(""), null);
assert.equal(normalizeRailWidth(-5), null); // 负数不是合法自定义
assert.equal(normalizeRailWidth("abc"), null);
assert.equal(normalizeRailWidth(NaN), null);
assert.equal(normalizeRailWidth(Infinity), null);
assert.equal(normalizeRailWidth(null), null);
assert.equal(normalizeRailWidth(undefined), null);
assert.equal(normalizeRailWidth(true), null); // 布尔不许被 Number() 收编成 0/1
assert.equal(normalizeRailWidth({}), null);
assert.equal(normalizeRailWidth([]), null);

// 拖动实时值：0/负数是往左拖过头的合法中间态 → 夹到下限；非有限值拒收
assert.equal(clampRailWidth(224.4), 224);
assert.equal(clampRailWidth(167.6), 168);
assert.equal(clampRailWidth(-50), RAIL_WIDTH_LIMITS.min);
assert.equal(clampRailWidth(9999), RAIL_WIDTH_LIMITS.max);
assert.equal(clampRailWidth(Infinity), null);
assert.equal(clampRailWidth(NaN), null);

// 键盘步进：±STEP；落盘值非法时用现测宽度作基准；方向非法拒收
assert.equal(steppedRailWidth(224, 1), 224 + RAIL_WIDTH_STEP);
assert.equal(steppedRailWidth(224, -1), 224 - RAIL_WIDTH_STEP);
assert.equal(steppedRailWidth("224", 1), 224 + RAIL_WIDTH_STEP); // 字符串落盘值也认
assert.equal(steppedRailWidth(null, 1, 224.2), 224 + RAIL_WIDTH_STEP); // 未自定义 → 现测基准
assert.equal(steppedRailWidth(null, -1, 179), RAIL_WIDTH_LIMITS.min); // 基准贴下限
assert.equal(steppedRailWidth(null, 1, null), null); // 连基准都没有 → 不动
assert.equal(steppedRailWidth(224, 0), null);
assert.equal(steppedRailWidth(224, "up"), null);
assert.equal(steppedRailWidth(RAIL_WIDTH_LIMITS.max, 1), RAIL_WIDTH_LIMITS.max); // 上界钳住
assert.equal(steppedRailWidth(RAIL_WIDTH_LIMITS.min, -1), RAIL_WIDTH_LIMITS.min); // 下界钳住

// DOM 应用出口：写值 / 删值 / 拒收 / 无环境
function fakeStyleTarget() {
  const calls = [];
  return {
    calls,
    style: {
      setProperty: (...a) => calls.push(["set", ...a]),
      removeProperty: (...a) => calls.push(["remove", ...a]),
    },
  };
}
{
  const t = fakeStyleTarget();
  assert.equal(applyRailWidth(300, t), 300);
  assert.deepEqual(t.calls, [["set", "--rail-w", "300px"]]);
}
{
  const t = fakeStyleTarget();
  assert.equal(applyRailWidth(null, t), null);
  assert.deepEqual(t.calls, [["remove", "--rail-w"]]);
  assert.equal(applyRailWidth(undefined, t), null);
  assert.equal(t.calls.length, 2);
}
{
  const t = fakeStyleTarget();
  assert.equal(applyRailWidth("abc", t), null); // 非法值 = 无操作，不动现有内联值
  assert.deepEqual(t.calls, []);
}
assert.equal(applyRailWidth(300, undefined), null);
assert.equal(applyRailWidth(300, {}), null);

/* ── 2. 源码守卫 ── */

const css = readProductSource(path.join(here, "../src/styles.css"), "utf8");
const shell = readProductSource(path.join(here, "../src/shell.js"), "utf8");

/** 按brace配平抽出 `@media (max-width: 900px) { ... }` 的块体（可能有多处，全取）。 */
function extractMedia900Blocks(text) {
  const blocks = [];
  let from = 0;
  for (;;) {
    const head = text.indexOf("@media (max-width: 900px)", from);
    if (head === -1) break;
    const open = text.indexOf("{", head);
    let depth = 0;
    let end = open;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    blocks.push(text.slice(open + 1, end));
    from = end + 1;
  }
  return blocks;
}

// 窄屏必须整条隐藏（至少一个 ≤900px 块里有 display:none）
const narrowBlocks = extractMedia900Blocks(css);
assert.ok(narrowBlocks.length > 0, "styles.css 应存在 @media (max-width: 900px) 块");
assert.ok(
  narrowBlocks.some((b) => /\.rail-resizer\s*\{[^}]*display:\s*none/.test(b)),
  "≤900px 媒体查询里必须有 .rail-resizer { display: none }（否则分隔条横在窄屏顶部）",
);

// 桌面几何：触摸手势必须交给指针事件、光标必须是横向调整
assert.match(css, /\.rail-resizer\s*\{[^}]*touch-action:\s*none/s);
assert.match(css, /\.rail-resizer\s*\{[^}]*cursor:\s*col-resize/s);
// 拖拽会话：全局光标/禁选中 + iframe 禁命中
assert.match(css, /body\.rail-resizing\s*\{[^}]*cursor:\s*col-resize/s);
assert.match(css, /body\.rail-resizing iframe\s*\{[^}]*pointer-events:\s*none/s);

// shell.js：会话兜底与落盘路径
assert.match(shell, /role: "separator"/, "分隔条必须有 separator 语义");
assert.match(shell, /railResizer\.setPointerCapture\(/, "必须尝试指针捕获");
assert.match(
  shell,
  /document\.addEventListener\("pointerup", resizeSess\.docUp, true\)/,
  "document 捕获阶段必须兜底 pointerup（指针在元素外松手不能挂死会话）",
);
assert.match(
  shell,
  /document\.addEventListener\("pointercancel", resizeSess\.docCancel, true\)/,
  "document 捕获阶段必须兜底 pointercancel（触摸被打断要回滚）",
);
assert.match(shell, /settings\.railWidth = st\.last/, "拖动松手必须落盘");
assert.match(shell, /settings\.railWidth = next/, "键盘调整必须落盘");
assert.match(shell, /delete S\.getState\(\)\.settings\.railWidth/, "双击重置必须删落盘值");
assert.match(shell, /getUiScaleFactor\(\) \|\| 1/, "指针位移必须除以生效缩放系数");

console.log("PASS: test-rail-resizer.mjs");
