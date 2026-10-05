/* 侧栏插件置顶（v0.152.0）：置顶表的读写自愈 + 与顺序表正交的行为，
 * 以及「行尾悬停操作条」这条链路的接线守卫。
 *
 * 两条断言各自守着一次真实踩过的坑：
 *  1. 操作条只能长在导航按钮**内部**，而外层已经是 <button> —— 内层再用真 button
 *     会被 `.nav button` 的基线规则（display:flex + width:100% + padding 9px 12px）命中，
 *     行尾鼓成两个大块；pluginListDrag 的 closest("button[data-plugin-id]") 还会把它
 *     当成拖拽把手，按下去松手就把插件挪位。
 *  2. 置顶只许动 pinnedPlugins。一旦顺手改写 pluginOrder，「取消置顶回原位」就失效了
 *     （插件会被扔到列表末尾），用户拖过的顺序与分组白做。
 */
import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as S from "../src/store.js";
import { isPluginPinned, pinnedOrderOf, pinnedPluginIds, setPinnedPluginOrder, togglePluginPin } from "../src/pluginPins.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const shell = readProductSource(path.join(here, "..", "src", "shell.js"), "utf8");
const drag = readProductSource(path.join(here, "..", "src", "pluginListDrag.js"), "utf8");
const css = readProductSource(path.join(here, "..", "src", "styles.css"), "utf8");

function between(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `没找到 ${from}`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `没找到 ${to}`);
  return source.slice(start, end);
}

const memory = new Map();
globalThis.localStorage = { getItem: (k) => memory.get(k), setItem: (k, v) => memory.set(k, v) };
await S.initStore({ tasks: [], blocks: [], settings: {}, plugins: {} });

/* ── 空状态 ── */
assert.deepEqual(pinnedPluginIds(), [], "没置顶过就是空表");
assert.equal(isPluginPinned("pomodoro"), false);
assert.deepEqual(pinnedOrderOf(["pomodoro", "rss-reader"]), [], "空置顶表过滤后还是空");

/* ── 置顶 / 取消：追加在末尾，再按一次回原位（不是把表清空） ── */
assert.equal(togglePluginPin("pomodoro"), true, "第一次是置顶");
assert.equal(isPluginPinned("pomodoro"), true);
assert.deepEqual(pinnedPluginIds(), ["pomodoro"]);
assert.equal(togglePluginPin("rss-reader"), true);
assert.deepEqual(pinnedPluginIds(), ["pomodoro", "rss-reader"], "新置顶的追加到末尾，不抢已有置顶的位置");
assert.equal(togglePluginPin("pomodoro"), false, "再按一次是取消");
assert.deepEqual(pinnedPluginIds(), ["rss-reader"], "取消只摘自己，别人的置顶不受影响");

assert.equal(isPluginPinned(""), false, "空 ID 不算置顶");
assert.equal(togglePluginPin(""), false, "空 ID 不写表");
assert.deepEqual(pinnedPluginIds(), ["rss-reader"]);

/* ── 置顶表与 pluginOrder 正交：互不改写 ── */
S.getState().settings.pluginOrder = ["pomodoro", "rss-reader", "gx-news"];
togglePluginPin("pomodoro");
assert.deepEqual(S.getState().settings.pluginOrder, ["pomodoro", "rss-reader", "gx-news"],
  "置顶不许动 pluginOrder —— 取消置顶要靠它回原位");
assert.deepEqual(pinnedPluginIds(), ["rss-reader", "pomodoro"], "置顶表自己维护顺序");
togglePluginPin("pomodoro");
assert.deepEqual(S.getState().settings.pluginOrder, ["pomodoro", "rss-reader", "gx-news"], "取消置顶同样不动顺序");

/* ── 置顶段内拖拽落库 ── */
assert.deepEqual(pinnedPluginIds(), ["rss-reader"]);
togglePluginPin("gx-news");
assert.deepEqual(pinnedPluginIds(), ["rss-reader", "gx-news"]);
assert.equal(setPinnedPluginOrder(["gx-news", "rss-reader"]), true, "换了顺序要落库");
assert.deepEqual(pinnedPluginIds(), ["gx-news", "rss-reader"]);
assert.equal(setPinnedPluginOrder(["gx-news", "rss-reader"]), false, "顺序没变不必写盘");
assert.equal(setPinnedPluginOrder(["gx-news", "gx-news", "rss-reader"]), false, "重复 ID 去重后顺序没变");
assert.deepEqual(pinnedPluginIds(), ["gx-news", "rss-reader"], "去重后不写脏数据");

/* ── 渲染时按「当前有视图」过滤：停用 / 已删除的插件不留空槽 ── */
assert.deepEqual(pinnedOrderOf(["gx-news"]), ["gx-news"], "只剩一个有视图的");
assert.deepEqual(pinnedOrderOf([]), []);
assert.deepEqual(pinnedOrderOf(null), [], "非数组不炸");

/* ── 脏数据自愈 ── */
S.getState().settings.pinnedPlugins = ["a", "a", null, 7, "", "b"];
assert.deepEqual(pinnedPluginIds(), ["a", "b"], "去重 + 丢掉非字符串与空串");
S.getState().settings.pinnedPlugins = { a: 1 };
assert.deepEqual(pinnedPluginIds(), [], "不是数组就当没置顶");
assert.equal(isPluginPinned("a"), false);
assert.equal(togglePluginPin("c"), true, "脏数据之后依然能正常置顶");
assert.deepEqual(pinnedPluginIds(), ["c"]);
S.getState().settings.pinnedPlugins = "gx-news";
assert.deepEqual(pinnedPluginIds(), [], "字符串也不是数组");
assert.equal(setPinnedPluginOrder(null), false, "null 不写盘");
assert.deepEqual(pinnedPluginIds(), []);

/* ── 接线：shell 侧 ── */
assert.match(shell, /import \{[^}]*togglePluginPin[^}]*\} from "\.\/pluginPins\.js"/, "shell 必须走 pluginPins 的取数口径");

const navBlock = between(shell, "function navBtn(", "function pluginNavActions(");
assert.match(navBlock, /b\.append\(pluginNavActions\(def\.pluginView\.pluginId, def\.title\)\)/, "插件条目必须挂上操作条");
const desktopBranch = between(navBlock, "if (desktopWindow && isPlug && def.pluginView?.pluginId) {", "return b;");
assert.match(desktopBranch, /b\.append\(pluginNavActions\(/,
  "操作条只在桌面分支里挂：手机端侧栏是底栏、没有 hover，长按已归拖拽排序");

const actionsBlock = between(shell, "function pluginNavActions(", "function togglePin(");
assert.doesNotMatch(actionsBlock, /el\("button"/,
  "操作条不许用真 <button>：外层已是 button，HTML 不允许嵌套，且会被 .nav button 基线规则命中");
assert.match(actionsBlock, /role: "button"/, "内层要自带按钮语义");
assert.match(actionsBlock, /pointerdown.*stopPropagation|addEventListener\("pointerdown", \(event\) => event\.stopPropagation\(\)\)/s,
  "操作条必须挡下 pointerdown，否则按下就变成插件拖拽");
assert.match(actionsBlock, /openPluginContextMenu\(anchor, pluginId\)/, "「更多」要复用现有插件菜单");
assert.match(actionsBlock, /togglePin\(pluginId\)/, "📌 要接置顶动作");
assert.match(actionsBlock, /isPluginPinned\(pluginId\)/, "📌 的激活态取自置顶表");

const renderNavBlock = between(shell, "function renderNav()", "function plugSegNode(");
assert.match(renderNavBlock, /const pinnedIds = pinnedOrderOf\(\[\.\.\.viewsOf\.keys\(\)\]\)/, "置顶顺序来自置顶表，且只取有视图的");
assert.match(renderNavBlock, /if \(pinnedIds\.length\) box\.append\(plugSegNode\(pinnedIds\.flatMap\(\(id\) => viewsOf\.get\(id\) \|\| \[\]\), \{ pinned: true \}\)\)/,
  "置顶段必须渲染在常规分段之前");
assert.match(renderNavBlock, /\.filter\(\(id\) => !pinned\.has\(id\)\)/,
  "置顶插件要从事个常规分段里摘掉，否则同一个插件在侧栏出现两次");

const segBlock = between(shell, "function plugSegNode(", "function savePinnedOrder(");
assert.match(segBlock, /class: `plug-seg\$\{pinned \? " plug-seg-pinned" : ""\}`/, "置顶段要有自己的类名");
assert.match(segBlock, /pinned \? savePinnedOrder\(readIds\(\)\) : saveSegmentOrder\(readIds\(\)\)/, "按段选落库目标");

const savePinnedBlock = between(shell, "function savePinnedOrder(", "function saveSegmentOrder(");
assert.match(savePinnedBlock, /setPinnedPluginOrder\(\[\.\.\.new Set\(domIds\)\]\)/, "置顶段拖拽落进置顶表");
assert.doesNotMatch(savePinnedBlock, /pluginOrder/, "置顶段拖拽不许回填 pluginOrder");

assert.match(shell, /contextMenuItem\(isPluginPinned\(pluginId\) \? "取消置顶" : "置顶在最上方", \(\) => togglePin\(pluginId\)\)/,
  "右键菜单也要有置顶项 —— 键盘与触屏走那条路（悬停操作条它们够不着）");
assert.match(shell, /toast\(nowPinned \? .*已置顶.* : .*已取消置顶.*\)/, "置顶要有结果反馈");

/* ── 接线：拖拽控制器与样式 ── */
assert.match(drag, /if \(event\.target\.closest\?\.\("\.nav-act"\)\) return;/,
  "拖拽控制器必须放行操作条上的按下，否则点「更多」会顺带把插件拖走");

assert.match(css, /\.nav \.nav-actions \{ position: absolute;[^}]*pointer-events: none;/s,
  "操作条必须绝对定位悬浮：占文档流会把插件标签挤折行（.nav-kbd 踩过同一个坑）");
assert.match(css, /\.nav button:hover > \.nav-actions, \.nav button:focus-within > \.nav-actions \{\s*opacity: 1; pointer-events: auto; transition-delay: \.3s; \}/,
  "鼠标要停一会儿才现身（延迟只写在现身那条上，移开立即消失）");
assert.match(css, /\.nav button:hover:has\(> \.nav-actions\) > \.nav-kbd \{ opacity: 0; \}/,
  "操作条占住行尾时快捷键徽标必须让位，否则两行字叠在一起");
assert.match(css, /\.nav \.nav-act\.on \{ color: var\(--sun\); \}/, "已置顶的 📌 要有激活态");
assert.match(css, /\.nav \.plug-seg-pinned \{/, "置顶段要有视觉区块（脱离颜色分组后靠它提示「这是置顶区」）");
assert.match(css, /\.plugin-nav-ghost \.nav-actions \{ display: none; \}/,
  "拖拽浮起副本要藏掉操作条：ghost 不在 .nav 里，会退回无样式的 inline span 露出图标");
assert.match(css, /\.nav \.nav-actions \{ background: var\(--paper\); box-shadow: 0 0 0 1px var\(--line\); \}/,
  "≥901px 浅色侧栏必须覆盖操作条配色（不透明底才盖得住底下的「内置 / 导入」徽标）");

console.log("PASS: 侧栏插件置顶（置顶表读写自愈 / 与顺序表正交 / 悬停操作条接线与样式守卫）");
