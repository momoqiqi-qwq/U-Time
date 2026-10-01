/*
 * 侧栏操作条（rail dock）回归测试 —— v0.53.0
 *
 * 守住这几件事：
 *   ① railActions：注册表幂等（重复注册覆盖定义但不改插入顺序）、非空 id 校验、
 *      顺序归一化（丢未知 id / 去重 / 新动作补尾部）、moveRailAction 前后插、
 *      slotIndexFor 的落点边界（「落点由指针实时决定」的核心判定）。
 *   ② shell：操作条由注册表驱动、顺序落库走 normalize、拖拽模块存在
 *      （幽灵卡 / 实时让位 / 吞 click 且必须延迟摘监听）、renderRailDock 复用节点不重建。
 *   ③ styles：横排（flex-direction:row + 按钮 flex:none 定宽），
 *      且窄屏必须把 flex 还回 1（否则底栏布局被压坏）。
 *   ④ 反面：旧的竖排建 DOM 代码（createThemeToggle / settingsButton）已彻底消失，
 *      横排按钮没有 width:100% 回潮。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearRailActions,
  listRailActions,
  moveRailAction,
  normalizeRailActionOrder,
  railActionIds,
  registerRailAction,
  slotIndexFor,
  unregisterRailAction,
} from "../src/railActions.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), "utf8");

/* ── ① 注册表 ── */
clearRailActions();
assert.deepEqual(railActionIds(), [], "clear 之后注册表应为空");

registerRailAction({ id: "a", label: "A" });
registerRailAction({ id: "b", label: "B" });
assert.deepEqual(railActionIds(), ["a", "b"], "默认顺序 = 注册顺序");

registerRailAction({ id: "a", label: "A2" });
assert.deepEqual(railActionIds(), ["a", "b"],
  "重复注册同 id 必须覆盖定义但不改插入顺序（renderShell 重建时会再注册一遍）");
assert.equal(listRailActions().find((d) => d.id === "a").label, "A2", "重复注册必须更新定义内容");

assert.throws(() => registerRailAction({ id: "" }), /非空字符串 id/, "空 id 必须拒绝");
assert.throws(() => registerRailAction({}), /非空字符串 id/, "缺 id 必须拒绝");
assert.throws(() => registerRailAction(null), /对象/, "非对象必须拒绝");

assert.equal(unregisterRailAction("b"), true, "卸载已注册动作应返回 true");
assert.equal(unregisterRailAction("b"), false, "重复卸载应返回 false");
assert.deepEqual(railActionIds(), ["a"], "卸载后注册表不再含该 id");

/* ── 归一化：持久化顺序 ↔ 当前注册表 ── */
assert.deepEqual(normalizeRailActionOrder(undefined, ["a", "b", "c"]), ["a", "b", "c"],
  "没有持久化顺序时 = 注册顺序（老数据不需要迁移）");
assert.deepEqual(normalizeRailActionOrder(["c", "a"], ["a", "b", "c"]), ["c", "a", "b"],
  "已记录的保持，未记录的新动作补到尾部（后续添加的按钮自动出现在末尾）");
assert.deepEqual(normalizeRailActionOrder(["zzz", "b", "b", "a"], ["a", "b"]), ["b", "a"],
  "未知 id 丢弃、重复 id 去重");
assert.deepEqual(normalizeRailActionOrder(["a", "b"], ["a", "b"]), ["a", "b"], "顺序完整时不改动");
// 反面：结果必须是 ids 的一个排列（不增不减不重复）
const norm = normalizeRailActionOrder(["b", "nope"], ["a", "b", "c"]);
assert.deepEqual([...norm].sort(), ["a", "b", "c"], "归一化结果必须是当前注册表的一个完整排列");
assert.equal(new Set(norm).size, norm.length, "归一化结果不得有重复 id");

/* ── moveRailAction ── */
assert.deepEqual(moveRailAction(["a", "b", "c"], "a", "b", false), ["b", "a", "c"], "后插：a 移到 b 之后");
assert.deepEqual(moveRailAction(["a", "b", "c"], "c", "a", true), ["c", "a", "b"], "前插：c 移到 a 之前");
assert.deepEqual(moveRailAction(["a", "b"], "a", "b", true), ["a", "b"], "前插到原位置 = 不变");
assert.equal(moveRailAction(["a", "b"], "a", "a"), null, "同一个 → null（调用方据此跳过持久化）");
assert.equal(moveRailAction(["a", "b"], "a", "zzz"), null, "目标不在表里 → null");
assert.equal(moveRailAction(["a", "b"], "zzz", "a"), null, "源不在表里 → null");

/* ── slotIndexFor：落点边界（「落点由指针实时决定」的核心） ── */
// mids = 去掉被拖项后各按钮的中心点（升序）
assert.equal(slotIndexFor([50, 100], 10), 0, "指针在最左中心点左侧 → 插到最前");
assert.equal(slotIndexFor([50, 100], 50), 1, "正好压在中心线上 → 留在后一槽（与 quadrant computeSlot 边界一致）");
assert.equal(slotIndexFor([50, 100], 99), 1, "两槽之间 → 后一槽");
assert.equal(slotIndexFor([50, 100], 100), 2, "正好压在最后一条中心线 → 插到末尾");
assert.equal(slotIndexFor([50, 100], 999), 2, "指针在最右 → 插到末尾");
assert.equal(slotIndexFor([], 42), 0, "没有其他按钮 → 只有 0 号槽");

/* ── ② shell 源码不变量 ── */
const shellJs = read("../src/shell.js");
const dragJs = read("../src/toolbarDrag.js");
const styles = read("../src/styles.css");

assert.match(shellJs, /import \{[^}]*registerRailAction[^}]*\} from "\.\/railActions\.js"/,
  "shell 必须从 railActions 引入注册接口");
assert.match(shellJs, /registerRailAction\(\{\s*\n\s*id: "theme-toggle"/, "深浅色切换必须走注册表（id: theme-toggle）");
assert.match(shellJs, /registerRailAction\(\{\s*\n\s*id: "settings"/, "设置必须走注册表（id: settings）");
assert.match(shellJs, /class: "rail-bottom rail-dock"/,
  "容器必须同时带 rail-bottom（窄屏底栏那批规则挂在它上面）与 rail-dock（横排）");
// ⚠️ 这条必须**收窄到拖拽落库的回调里**再断言：全局正则会被 railActionOrderState()
// 里那句 `settings.railActionOrder = normalizeRailActionOrder(settings.railActionOrder)`
// 匹配到 —— 把落库改成裸赋值照样通过（变异测试实测漏过一条）。
const dockCommit = shellJs.slice(
  shellJs.indexOf("attachRailDockDrag(railDock, () => {"),
  shellJs.indexOf("// Alt+←/→ 键盘重排"),
);
assert.ok(dockCommit.length > 0, "没找到拖拽落库回调");
assert.match(dockCommit, /railActionOrder = normalizeRailActionOrder\(/,
  "拖拽落库必须走 normalizeRailActionOrder（保证存的是当前注册表的完整排列）");
assert.ok(!/railActionOrder = \[\.\.\.railDock\.querySelectorAll/.test(dockCommit),
  "反面：落库不得把 DOM 序裸赋值（未注册 / 已注销的 id 会被一起写进 settings）");
assert.match(shellJs, /function attachRailDockDrag\(list, onCommit\)/, "必须存在操作条拖拽模块");
assert.match(dragJs, /slotIndexFor\(mids, x\)/, "落点判定必须复用 railActions 的 slotIndexFor");
assert.match(shellJs, /return attachToolbarDrag\(list, onCommit\)/, "侧栏必须接入共享拖拽实现");
assert.match(dragJs, /ghostClass = "rail-dock-ghost"/, "侧栏幽灵卡样式必须保留");
assert.match(dragJs, /ghost\.classList\.add\(ghostClass\)/, "拖拽必须建幽灵卡跟随指针");
assert.match(dragJs, /list\.insertBefore\(st\.card, peers\[slot\] \?\? null\)/, "其余按钮必须实时让位（重排 DOM）");
assert.match(dragJs, /st\.card\.classList\.add\(dragClass\)/, "被拖按钮必须留成空槽");
// 吞 click：进入拖拽就挂捕获监听，且必须延迟到下一个宏任务才摘（pointerup 先于 click 派发）
assert.match(dragJs, /st\.swallowClick = \(event\) => \{ event\.preventDefault\(\); event\.stopPropagation\(\); \}/,
  "拖拽激活后必须吞掉紧随其后的 click（否则松手会顺带触发按钮动作）");
assert.match(dragJs, /setTimeout\(\(\) => document\.removeEventListener\("click", st\.swallowClick, true\), 0\)/,
  "吞 click 的监听必须在下一个宏任务里摘（在 pointerup 处理器里同步摘会让 click 漏过去）");
// 触屏长按 + 桌面阈值：两种指针类型都要有入口
assert.match(dragJs, /pd\.longTimer = setTimeout\(\(\) => \{[^}]*\}, 240\)/, "触屏必须长按 240ms 进入拖拽");
assert.match(dragJs, /Math\.hypot\(dx, dy\) >= 6\) beginDrag/, "桌面必须移动 ≥6px 进入拖拽");
// 节点复用：renderRailDock 不许 replaceChildren 重建
const dockRender = shellJs.slice(shellJs.indexOf("function renderRailDock()"), shellJs.indexOf("renderRailDock();"));
assert.ok(dockRender.length > 0, "没找到 renderRailDock 定义");
assert.ok(!/replaceChildren/.test(dockRender),
  "renderRailDock 不得用 replaceChildren 重建按钮 —— theme-toggle 的 MutationObserver 会漏");
assert.match(dockRender, /railDock\.append\(\.\.\.nodes\)/, "renderRailDock 必须用 append 复用节点重排");
assert.match(dockRender, /child\.remove\(\)/, "renderRailDock 必须清掉已注销动作的按钮");

// 反面：旧的竖排建 DOM 代码必须彻底消失（留着就是两份实现并存）
assert.ok(!/function createThemeToggle\(/.test(shellJs), "旧的 createThemeToggle 必须删除");
assert.ok(!/function settingsButton\(/.test(shellJs), "旧的 settingsButton 必须删除");
assert.ok(!/themeToggleBtn = createThemeToggle\(\)/.test(shellJs), "rail 里不得再直接塞按钮");

/* ── ③ styles ── */
const dockBlock = styles.slice(styles.indexOf(".rail-dock {"), styles.indexOf(".rail-dock-ghost {"));
assert.ok(dockBlock.length > 0, "没找到 .rail-dock 规则块");
assert.match(dockBlock, /display: flex;/, "操作条必须是 flex 容器");
assert.match(dockBlock, /flex-direction: row;/, "操作条必须横排（左右）");
assert.match(dockBlock, /flex-wrap: nowrap;/,
  "不许折行 —— 落点推演按单行算，折行会让槽位判定失效");

const dockBtnRule = styles.match(/^\.rail-dock > \.rail-dock-btn \{[^}]*\}/m)?.[0] || "";
assert.ok(dockBtnRule.length > 0, "没找到操作条按钮规则");
assert.match(dockBtnRule, /width: 40px;/, "横排按钮必须定宽");
assert.match(dockBtnRule, /flex: none;/, "按钮必须禁止伸缩（否则被 flex 拉伸变形）");
assert.ok(!/width: 100%/.test(dockBtnRule), "反面：横排按钮不得 width:100%（会把整条撑成一颗超宽按钮）");

assert.match(styles, /\.rail-dock-ghost \{[\s\S]{0,400}?position: fixed;/,
  "幽灵卡必须 fixed 定位（不受 .rail 的 flex 布局影响）");
assert.match(styles, /\.rail-dock > \.rail-dock-btn\.dragging \{ opacity: \.3;/,
  "被拖按钮必须留成半透明空槽");
assert.match(styles, /\.rail-dock-ghost \.ic \{[\s\S]{0,300}?color-mix\(in srgb, var\(--panel\) 86%, transparent\)/,
  "幽灵卡图标底色必须跟随主题（与 .rail-bottom > button .ic 同表达式）");

// 窄屏还原：`.rail-dock > .rail-dock-btn`(0,2,0) 压得过 `.rail-bottom > button`(0,1,1)，
// 不还回去底栏就只剩两颗 40px 的钮挤在左侧。
const narrowBlock = styles.slice(styles.lastIndexOf("@media (max-width: 760px)"));
assert.ok(narrowBlock.length > 0, "没找到文件末尾的窄屏媒体查询");
assert.match(narrowBlock, /\.rail-bottom\.rail-dock > \.rail-dock-btn \{ width: auto; flex: 1; min-width: 0; \}/,
  "窄屏必须把 flex 还回 1，否则底栏布局被压坏");

/* ── ④ 深浅色键的图标（2026-09-19 用户指定）──
   字形按**当前生效亮度**取：浅色 = 太阳、深色 = 月亮。
   旧逻辑是反的（浅色显月亮 = 「点下去会去哪」），而 Font Awesome 的 sun 在 15~18px 下
   就是「圆盘 + 8 道短射线」，与隔壁设置键的真齿轮几乎同形 —— 深色模式里再压上
   「深字压深底」（见下条 color 断言）就成了用户口中的「深色的齿轮」。
   两颗键（顶栏 + 左下角）共用一个 helper，别各写一份 ternary。 */
assert.match(shellJs, /const themeModeGlyph = \(\) => \(resolveThemeMode\(\) === "dark" \? "moon" : "sun"\)/,
  "字形必须由单一 helper 给出：浅色=sun、深色=moon");
const glyphCalls = (shellJs.match(/faIcon\(themeModeGlyph\(\)\)/g) ?? []).length;
assert.ok(glyphCalls >= 3,
  `顶栏 1 处 + 左下角建图标 1 处 + MutationObserver 刷新 1 处都要走 helper，实测 ${glyphCalls} 处`);
assert.equal((shellJs.match(/"sun"|"moon"/g) ?? []).length, 2,
  "shell.js 里 sun / moon 字面量只许出现在 helper 内各一次（多出来就是又分叉了一份映射）");
// 磁贴底色早就跟主题走了（.rail-bottom > button .ic 的 color-mix），图标色却还写死 #17323A
// ⇒ 深色模式 --panel:#2D2922 上压深字，实测对比 1.07:1（走 --ink 后 11.08:1）。
const toggleIcAt = styles.indexOf(".rail-bottom > .theme-toggle-btn .ic {");
assert.ok(toggleIcAt >= 0, "没找到 .rail-bottom > .theme-toggle-btn .ic 规则");
const toggleIcRule = styles.slice(toggleIcAt, toggleIcAt + 160);
assert.match(toggleIcRule, /color:\s*var\(--ink\)/,
  "深浅色键的图标色必须走 --ink 随主题反色（浅色磁贴深字、深色磁贴白字）");
assert.ok(!/color:\s*#17323A/i.test(toggleIcRule),
  "反面：不许在这条规则里写死深色（那正是深色模式下「看不见」的根因）");

console.log("✓ rail dock：注册表 / 归一化 / 落点边界 / 拖拽源码不变量 / 深浅色键图标 全部通过");
