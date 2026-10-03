import { readProductSource } from "./lib/read-product-source.mjs";
// 插件颜色分组 · 动效与刷新范围（v0.103.0 打磨）
//
// ① 纯函数：同色吸附每个 ID 只问一次颜色；groupRuns 带颜色分段。
// ② motion.js 行为（假 DOM 实跑）：整段重绘的 FLIP（位移 / 嵌套扣减 / 新节点入场 / 减少动效短路）、
//    折叠段高度动画、批量淡出。
// ③ shell.js 接线（源码断言，与本仓库其它 UI 测试同一写法）：
//    多视图插件整串保留、段内拖拽去重、分组改动不走 switchTo、插件中心同色吸附与 FLIP 重排、
//    侧栏拖拽按缩放系数换算。
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => readProductSource(new URL(rel, import.meta.url), "utf8");
const shell = read("../src/shell.js");
const motionSrc = read("../src/motion.js");
const css = read("../src/styles.css");

/* ── ① 纯函数 ── */
const { groupRuns, groupSegments, normalizePluginOrder } = await import("../src/pluginGroups.js");
const colors = { b: "red", d: "red", e: "blue", f: "red" };
let asked = 0;
const colorOf = (id) => { asked += 1; return colors[id] || ""; };
const order = ["a", "b", "c", "d", "e", "f", "g"];
assert.deepEqual(normalizePluginOrder(order, colorOf), ["a", "b", "d", "f", "c", "e", "g"]);
assert.equal(asked, order.length, "同色吸附每个 ID 只问一次颜色（旧写法对每个上色插件都要整列再扫一遍）");
assert.deepEqual(
  groupRuns(["a", "b", "d", "c", "e"], (id) => colors[id] || ""),
  [{ color: "", ids: ["a"] }, { color: "red", ids: ["b", "d"] }, { color: "", ids: ["c"] }, { color: "blue", ids: ["e"] }],
  "groupRuns 按连续同色分段并带上颜色，无色段为空串",
);
assert.deepEqual(groupSegments(["a", "b", "d"], (id) => colors[id] || ""), [["a"], ["b", "d"]], "groupSegments 与 groupRuns 同源");

/* ── ② motion.js：假 DOM ── */
globalThis.document = { documentElement: { dataset: {} } };
globalThis.window = { matchMedia: () => ({ matches: false }) };
globalThis.getComputedStyle = (node) => node.style;
const { flipByKey, foldOpen, foldClose, fadeAway } = await import("../src/motion.js");

class FakeNode {
  constructor(key, top, { parent = null, height = 30 } = {}) {
    this.key = key; this.top = top; this.height = height; this.parentElement = parent;
    this.calls = []; this.isConnected = true;
    this.style = { paddingTop: "0px", paddingBottom: "4px" };
  }
  getBoundingClientRect() { return { left: 0, top: this.top, width: 100, height: this.height }; }
  animate(frames, options) { this.calls.push({ frames, options }); return { finished: Promise.resolve() }; }
  matches() { return false; }
}
function fakeRoot(nodes) {
  const root = { items: nodes, animate() {}, querySelectorAll: () => root.items };
  return root;
}
const opts = (root, next, extra = {}) => ({ selector: "*", key: (n) => n.key, mutate: () => { root.items = next(); }, ...extra });

// 位移：新节点从旧位置滑到新位置（translate = 旧 − 新）
{
  const root = fakeRoot([new FakeNode("a", 0), new FakeNode("b", 30)]);
  let a2, b2;
  await flipByKey(root, opts(root, () => [b2 = new FakeNode("b", 0), a2 = new FakeNode("a", 30)]));
  assert.equal(a2.calls[0].frames[0].transform, "translate(0px, -30px)", "下移的节点从旧位置出发");
  assert.equal(b2.calls[0].frames[0].transform, "translate(0px, 30px)", "上移的节点从旧位置出发");
  assert.equal(a2.calls[0].frames[1].transform, "none");
}
// 嵌套：父级已在走的位移要扣掉，跟着父级一起动的子节点不再单独动
{
  const g1 = new FakeNode("g", 0, { height: 90 });
  const root = fakeRoot([g1, new FakeNode("x", 10, { parent: g1 }), new FakeNode("y", 40, { parent: g1 })]);
  let x2, y2;
  await flipByKey(root, opts(root, () => {
    const g2 = new FakeNode("g", 40, { height: 120 });
    x2 = new FakeNode("x", 50, { parent: g2 });
    y2 = new FakeNode("y", 100, { parent: g2 });
    return [g2, x2, y2];
  }));
  assert.equal(x2.calls.length, 0, "随父级整体移动的子节点不应叠加第二段位移");
  assert.equal(y2.calls[0].frames[0].transform, "translate(0px, -20px)", "子节点只补相对父级的那一段");
}
// 新节点入场；enter 返回 null 表示不动
{
  const root = fakeRoot([new FakeNode("a", 0)]);
  let fresh;
  await flipByKey(root, opts(root, () => [new FakeNode("a", 0), fresh = new FakeNode("new", 30)]));
  assert.equal(fresh.calls.length, 1, "新出现的节点要有入场动画");
  assert.equal(fresh.calls[0].options.fill, "backwards", "入场的错落延迟期间必须停在首帧");
  const root2 = fakeRoot([]);
  let quiet;
  await flipByKey(root2, opts(root2, () => [quiet = new FakeNode("q", 0)], { enter: () => null }));
  assert.equal(quiet.calls.length, 0, "enter 返回 null 时不出动画");
}
// 减少动效：只执行 mutate，不出任何动画
{
  document.documentElement.dataset.uiMotion = "reduced";
  const root = fakeRoot([new FakeNode("a", 0)]);
  let moved, mutated = false;
  await flipByKey(root, opts(root, () => { mutated = true; return [moved = new FakeNode("a", 60)]; }));
  assert.ok(mutated, "减少动效时 mutate 仍必须执行");
  assert.equal(moved.calls.length, 0, "减少动效时不许出 FLIP");
  const seg = new FakeNode("seg", 0, { height: 80 });
  await foldOpen(seg); await foldClose(seg); await fadeAway([seg]);
  assert.equal(seg.calls.length, 0, "减少动效时折叠与淡出都不出动画");
  delete document.documentElement.dataset.uiMotion;
}
// 折叠段：收起停在 0（fill: forwards，等调用方摘掉）；展开从 0 长回自然高度（fill: none）
{
  const seg = new FakeNode("seg", 0, { height: 80 });
  await foldClose(seg);
  const close = seg.calls[0];
  assert.equal(close.frames[0].height, "80px");
  assert.equal(close.frames[1].height, "0px");
  assert.equal(close.frames[1].paddingBottom, "0px", "内边距也要收掉，否则最后一帧剩一条缝再跳掉");
  assert.equal(close.options.fill, "forwards");
  await foldOpen(seg);
  const open = seg.calls[1];
  assert.equal(open.frames[0].height, "0px");
  assert.equal(open.frames[1].paddingBottom, "4px", "展开的终帧回到计算出的内边距");
  assert.equal(open.options.fill, "none", "展开结束后必须交还给自然高度（height:auto）");
}
// 批量淡出：只动还挂在文档里的节点
{
  const on = new FakeNode("on", 0);
  const off = new FakeNode("off", 0);
  off.isConnected = false;
  await fadeAway([on, off]);
  assert.equal(on.calls.length, 1);
  assert.equal(off.calls.length, 0, "已摘掉的节点不必再播离场");
}
assert.match(motionSrc, /\(old\.left - now\.left\) \/ scale/, "FLIP 位移必须除以界面缩放系数（视觉像素 → CSS 像素）");
assert.match(motionSrc, /import \{ getUiScaleFactor \} from "\.\/uiScale\.js"/);

/* ── ③ shell.js 接线 ── */
const between = (from, to) => {
  const start = shell.indexOf(from);
  assert.ok(start >= 0, `没找到 ${from}`);
  const end = shell.indexOf(to, start + from.length);
  assert.ok(end > start, `没找到 ${to}`);
  return shell.slice(start, end);
};

// 多视图插件（cppu-notify 注册了 6 个视图）整串保留
const renderNavBlock = between("function renderNav()", "function plugSegNode(");
assert.match(renderNavBlock, /viewsOf\.get\(pv\.pluginId\)\.push\(pv\)/, "侧栏必须按插件归拢全部视图");
assert.match(renderNavBlock, /ids\.flatMap\(\(id\) => viewsOf\.get\(id\) \|\| \[\]\)/, "每段要展开成该段插件的全部视图");
assert.doesNotMatch(renderNavBlock, /new Map\(pluginViews\.map\(\(pv\) => \[pv\.pluginId, pv\]\)\)/,
  "按插件 ID 建单值 Map 会让多视图插件只剩最后一个视图");

// 段内拖拽：同插件多按钮先去重再回填
assert.match(shell, /function saveSegmentOrder\(domIds\) \{\s*const ids = \[\.\.\.new Set\(domIds\)\];/,
  "回填前必须按首次出现去重，否则重复 ID 会把别的插件挤出排列");

// 分组改动只刷侧栏与插件中心，不走 switchTo（不重挂插件页、不把插件中心滚回顶部）
const groupsRefresh = between("function refreshPluginGroups()", "function refreshCorePresentation()");
assert.doesNotMatch(groupsRefresh, /switchTo\(/, "分组改动不许走 switchTo");
assert.match(groupsRefresh, /flipNav\(renderNav\)/);
const applyColor = between("function applyPluginColor(", "function openPluginContextMenu(");
assert.match(applyColor, /const order = currentPluginOrder\(\);\s*setPluginColor\(/, "改色要以改色前的显示顺序为底");
assert.match(applyColor, /refreshPluginGroups\(\)/);
assert.doesNotMatch(applyColor, /refreshPluginPresentation\(|switchTo\(/, "改色不许重挂当前视图");
assert.match(shell, /renameGroup\(currentColor, value\);\s*refreshPluginGroups\(\);/, "改组名也只刷侧栏与插件中心");
const groupBlock = between("function plugGroupNode(", "function navBtn(");
assert.doesNotMatch(groupBlock, /switchTo\(|refreshPluginPresentation\(/, "收放 / 换位不许重挂当前视图");
assert.match(groupBlock, /foldClose\(seg\)\.then\(\(\) => \{ seg\.remove\(\); done\(\); \}\)/, "收起要先播完高度动画再摘成员段");
assert.match(groupBlock, /foldOpen\(seg\)/, "展开要有高度动画");
assert.match(groupBlock, /disabled: atEdge \? true : null/, "到顶 / 到底的整组移动按钮要置灰");
assert.match(groupBlock, /focus\(\{ preventScroll: true \}\)/, "整组换位重绘后焦点要还回去");

// 插件中心：同色吸附、FLIP 就地重排、就地重排不重播入场
const market = between("function renderMarket(", "function fillCards(");
assert.match(market, /flipByKey\(grid, \{/, "插件中心的分组改动要走 FLIP 就地重排");
assert.match(shell, /normalizePluginOrder\(sorted\.map\(\(rec\) => rec\.id\), pluginColor\)/, "插件中心也要同色吸附");
assert.match(shell, /\$\{entrance \? " market-card-enter" : ""\}/, "就地重排时不许重播卡片入场动画");
assert.match(shell, /"data-card-id": rec\.id/, "FLIP 需要卡片的稳定 key");

// 侧栏拖拽：按缩放系数换算（与 toolbarDrag.js 同一口径）
const drag = between("function attachPluginListDrag", "function attachRailDockDrag");
assert.match(drag, /st\.scale = getUiScaleFactor\(\) \|\| 1;/);
assert.match(drag, /translate3d\(\$\{\(st\.x - st\.gx\) \/ st\.scale\}px, \$\{\(st\.y - st\.gy\) \/ st\.scale\}px, 0\)/, "浮起项要按缩放系数跟手");
assert.match(drag, /st\.ghost\.style\.width = `\$\{rect\.width \/ st\.scale\}px`/, "浮起项尺寸要换回 CSS 像素");
assert.match(drag, /const dy = \(before\.get\(node\) - node\.getBoundingClientRect\(\)\.top\) \/ st\.scale;/);

// 折叠钮退出全局按钮反馈（整行宽的钮不能跟着按下缩放、松手旋转）
assert.match(shell, /class: `\$\{prefix\}-fold`,\s*type: "button",\s*"data-motion": "off",/, "折叠钮必须 data-motion=off");
// 插件中心：颜色段结束回到未分组时封口
assert.match(shell, /if \(sectionColor && !recColor\) grid\.append\(el\("div", \{ class: "market-group-end"/,
  "颜色段后面的未分组卡片必须另起一行");

/* ── CSS ── */
assert.match(css, /\.fold-chev \{[^}]*transition: transform/, "折叠箭头要有旋转过渡");
assert.match(css, /\.collapsed \.fold-chev \{ transform: rotate\(-90deg\); \}/);
assert.match(css, /\.nav\.nav-flip \.plug-group \{ overflow: visible; \}/, "FLIP 期间要放开颜色卡片的裁切");
assert.match(css, /\.nav \.plug-group-move:disabled \{/);
assert.match(css, /\.market-group-end \{ grid-column: 1 \/ -1; height: 0; \}/, "颜色段封口是零高的整行");

console.log("PASS: 插件分组动效（线性吸附 / FLIP 位移与嵌套扣减 / 折叠高度 / 减少动效短路 / 多视图保留 / 不走 switchTo / 缩放换算）");
