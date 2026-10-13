/* 快捷入口面板（顶栏「快捷入口」按钮展开的那块浮层）拖动落位的回归测试 —— v0.206.1。
 *
 * 为什么值得单独钉一个测试文件：
 *   `src/shell.js` 里的 `bindQuickDockDrag()` **曾经存在但从来没有被调用过**（死接线），
 *   而且就算接上也没用 —— 展开面板时 `toggleQuickDock()` 与窗口 resize 都会无条件
 *   `positionQuickDockNear(quickDockToggle)`，把用户拖到的位置当场覆盖掉。
 *   所以这个功能有两层：① 真的绑到头部把手；② 拖动过的落位要能被沿用（`moved` 存档 + 双击恢复）。
 *   两层都容易被后续改动悄悄弄坏，且坏了在肉眼上只表现为「怎么拖都弹回原位」，很难查。
 *
 * 判据分两半：
 *   Ⅰ. **行为**：把 shell.js 里 `positionQuickDock` → `bindQuickDockDrag` 那一段**真实源码**切出来，
 *      用假 window / 假节点跑（本仓库既有写法：test-ui-scale.mjs 也用 new Function 跑真源码）。
 *      不另写一份等价实现来「对比」—— 那测的是测试自己。
 *   Ⅱ. **接线与样式守卫**：源码正则 + styles.css（`touch-action: none` 少了手机上拖不动，
 *      手势会被浏览器当滚动）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const shell = read("../src/shell.js");
const css = read("../src/styles.css");

/* ────────────────────────── Ⅰ. 真源码行为 ────────────────────────── */

const START = "function positionQuickDock(";
const END = "function updatePinButtonState(";
const from = shell.indexOf(START), to = shell.indexOf(END);
assert.ok(from > -1 && to > from, "在 shell.js 里找不到 positionQuickDock / updatePinButtonState 锚点");
const dragSource = shell.slice(from, to);
for (const fn of ["function positionQuickDock(", "function placeQuickDock(", "function resetQuickDockPosition(", "function bindQuickDockDrag("]) {
  assert.ok(dragSource.includes(fn), `切出来的源码里缺 ${fn}（改动把这一段的顺序打乱了吗？）`);
}
assert.doesNotMatch(dragSource, /pinActionBtn|await import\(/, "这一段的切法要求它不碰置顶按钮与动态 import");

class Target {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  fire(type, event = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn(event); }
  count(type) { return (this.listeners.get(type) || new Set()).size; }
}

const win = new Target();
win.innerWidth = 1280;
win.innerHeight = 800;

let inset = 0, saves = 0, nearCalls = 0;
const toasts = [];
const state = { left: null, top: 92, collapsed: false, alwaysOnTop: false, moved: false };

const dock = {
  style: {},
  classes: new Set(),
  rect: { left: 400, top: 150, width: 292, height: 320 },
  classList: {
    add: (...xs) => xs.forEach((x) => dock.classes.add(x)),
    remove: (...xs) => xs.forEach((x) => dock.classes.delete(x)),
    contains: (x) => dock.classes.has(x),
  },
  getBoundingClientRect() { return { ...dock.rect }; },
};
const syncRectToStyle = () => {
  dock.rect.left = Number.parseFloat(dock.style.left);
  dock.rect.top = Number.parseFloat(dock.style.top);
};

const api = new Function(
  "window", "bottomInsetPx", "S", "quickDockState", "quickDock", "quickDockToggle", "positionQuickDockNear", "toast",
  `${dragSource}
   return { positionQuickDock, placeQuickDock, resetQuickDockPosition, bindQuickDockDrag };`,
)(
  win, () => inset, { persistSoon: () => saves++ }, state, dock, null,
  () => nearCalls++, (message) => toasts.push(message),
);

const head = new Target();
api.bindQuickDockDrag(dock, head);

const pointer = (x, y, extra = {}) => ({
  pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: y, prevented: false,
  preventDefault() { this.prevented = true; }, ...extra,
});
const down = (x, y, extra) => head.fire("pointerdown", pointer(x, y, extra));
const move = (x, y, extra) => win.fire("pointermove", pointer(x, y, extra));
// 真实 DOM 事件自带 type，而 pointerup / pointercancel 共用同一个处理函数 —— 假事件必须补上它。
const up = (x, y, extra = {}) => win.fire("pointerup", pointer(x, y, { type: "pointerup", ...extra }));
const cancel = (x, y) => win.fire("pointercancel", pointer(x, y, { type: "pointercancel" }));

/* ① 跟手位移 + 右下角钳制（宽屏 margin 20，底部再让开 --sab） */
down(500, 200);
move(540, 230); // 相对起拖点 +40/+30
assert.equal(dock.style.left, "440px", "拖动必须跟手：左 = 起拖左 + 指针位移");
assert.equal(dock.style.top, "180px");
assert.ok(dock.classes.has("dragging"), "拖动期间要挂 .dragging（CSS 负责光标与加重的投影）");
move(5500, 5200);
assert.equal(dock.style.left, `${1280 - 292 - 20}px`, "右边界要钳在里面（margin 20）");
assert.equal(dock.style.top, `${800 - 320 - 20}px`, "下边界要钳在里面");
assert.equal(saves, 0, "拖动过程中不写盘，松手才写一次");
up(5500, 5200);
assert.equal(saves, 1, "松手写一次存档");
assert.equal(state.moved, true, "拖动过的落位必须记住，否则下次展开又被贴回触发按钮");
assert.equal(dock.classes.has("dragging"), false, "松手摘掉 .dragging");
assert.equal(win.count("pointermove") + win.count("pointerup") + win.count("pointercancel"), 0, "松手后三个 window 监听必须摘干净");
syncRectToStyle();

/* ② 左上角钳制 + 窄屏参数（margin 12 / safeTop 72 / 底部再让开 --sab） */
win.innerWidth = 390; win.innerHeight = 720; inset = 48;
down(200, 300);
move(-9999, -9999);
assert.equal(dock.style.left, "12px", "窄屏用 margin 12");
assert.equal(dock.style.top, "72px", "窄屏顶部让开顶栏（safeTop 72）");
move(9999, 9999);
assert.equal(dock.style.left, `${390 - 292 - 12}px`);
assert.equal(dock.style.top, `${720 - 320 - 12 - 48}px`, "底部钳制必须叠加 --sab（三键导航栏），否则面板被导航栏压住");
up(9999, 9999);
syncRectToStyle();
win.innerWidth = 1280; win.innerHeight = 800; inset = 0;

/* ③ 几像素抖动不算拖动：不能因为「点了一下把手」就留下 moved 存档 */
const beforeJitter = saves;
down(500, 200);
move(501, 201);
assert.equal(state.moved, true, "（此刻仍是上一步的存档状态）");
up(501, 201);
assert.equal(saves, beforeJitter, "抖动不写盘");
assert.equal(win.count("pointermove"), 0);
state.moved = false; // 手动归零，单独验「抖动 → 不置 moved」

/* ④ 双击把手 = 恢复跟随触发按钮 */
// ③ 的「点一下」也记了 lastTapAt，先等过 350ms 的双击窗口，免得把上一段的手势算进来。
await new Promise((resolve) => setTimeout(resolve, 380));
state.moved = true;
dock.rect = { left: 700, top: 260, width: 292, height: 320 };
const nearBefore = nearCalls, savesBefore = saves, toastsBefore = toasts.length;
down(700, 260); up(700, 260);
down(700, 260); up(700, 260);
assert.equal(state.moved, false, "双击把手必须把落位交还给自动跟随");
assert.equal(nearCalls, nearBefore + 1, "恢复后立即贴回触发按钮位置");
assert.equal(saves, savesBefore + 1, "恢复跟随要写盘");
assert.equal(toasts.length, toastsBefore + 1, "要给一句反馈（否则用户不知道刚才那两下做了什么）");

/* ⑤ 中途被打断（指针被系统抢走）→ 回滚到起拖位置，且不改存档 */
state.moved = false;
dock.rect = { left: 600, top: 200, width: 292, height: 320 }; // 起拖点就是这里（不走 syncRectToStyle）
const saves5 = saves;
down(600, 200);
move(760, 380);
assert.equal(dock.style.left, "760px", "拖动中先跟手");
cancel(760, 380);
assert.equal(dock.style.left, "600px", "打断必须回滚到起拖位置");
assert.equal(state.moved, false, "打断不写「已拖动」存档");
assert.equal(saves, saves5, "打断不写盘");
assert.equal(win.count("pointermove"), 0);

/* ⑥ 非主键（右键 / 中键）不启动拖动，触屏与手写笔可以 */
down(500, 200, { button: 2 });
assert.equal(win.count("pointermove"), 0, "右键不能触发拖动");
move(900, 500);
assert.equal(dock.style.left, "600px", "右键拖动不改落位");
up(900, 500);
down(500, 200, { pointerType: "touch" });
assert.equal(win.count("pointermove"), 1, "触屏必须能拖（pointer 事件统一鼠标与手指）");
move(540, 200);
up(540, 200);
assert.equal(state.moved, true, "触屏拖动同样要记住落位");

/* ⑦ placeQuickDock 的两条分支：拖动过沿用落位 / 没拖动过贴按钮 */
state.moved = true; state.left = 820; state.top = 300;
const near7 = nearCalls;
api.placeQuickDock();
assert.equal(dock.style.left, "820px", "拖动过就沿用存档落位");
assert.equal(dock.style.top, "300px");
assert.equal(nearCalls, near7, "拖动过不该再去贴触发按钮");
state.moved = false;
api.placeQuickDock();
assert.equal(nearCalls, near7 + 1, "没拖动过就贴触发按钮");
assert.equal(dock.style.left, "820px", "贴按钮那条路交给 positionQuickDockNear（在它内部写样式）");

/* ⑧ 老存档没有 moved 字段 ⇒ 当「没拖动过」处理（与拖动接线前行为一致） */
const legacy = { left: 640, top: 210, collapsed: false, alwaysOnTop: false };
const near8 = nearCalls;
new Function("window", "bottomInsetPx", "S", "quickDockState", "quickDock", "quickDockToggle", "positionQuickDockNear", "toast",
  `${dragSource}; return { placeQuickDock };`)(
  win, () => 0, { persistSoon: () => {} }, legacy, dock, null, () => nearCalls++, () => {},
).placeQuickDock();
assert.equal(nearCalls, near8 + 1, "老存档（无 moved）必须落回自动跟随，不能因为读到 undefined 就乱用存档坐标");

/* ────────────────────────── Ⅱ. 接线与样式守卫 ────────────────────────── */

// 根因守卫：这个函数以前就存在，只是没人调用 —— 所以「被调用」本身要钉住，且把手必须是头部条。
assert.match(shell, /bindQuickDockDrag\(dock, head\)/, "mountQuickDock 必须把拖动绑到头部把手（这正是 v0.206.1 修的死接线）");
assert.match(shell, /const head = el\("div", \{ class: "quick-dock-head",/, "把手就是 .quick-dock-head（里面只有头像与标题，没有可点元素）");
assert.match(shell, /root\.append\(dock\);\s*\n\s*bindQuickDockDrag\(dock, head\);/, "绑定必须发生在面板进 DOM 之后");

// 落位沿用：展开与 resize 都不能再无条件贴触发按钮。
assert.equal((shell.match(/positionQuickDockNear\(quickDockToggle\)/g) || []).length, 1, "positionQuickDockNear(quickDockToggle) 只许出现在 placeQuickDock 里");
assert.match(shell, /if \(!quickDockState\.collapsed\) placeQuickDock\(\);/, "展开面板必须走统一落位（否则拖动被当场覆盖）");
assert.match(shell, /window\.addEventListener\("resize", \(\) => \{ if \(quickDock\?\.isConnected && !quickDockState\.collapsed\) placeQuickDock\(\); \}, \{ passive: true \}\)/, "窗口缩放也要走统一落位（拖动过的面板被缩小时只会被钳制，不会跳回按钮下）");
assert.match(shell, /function placeQuickDock\(\) \{\s*\n\s*if \(quickDockState\.moved\) positionQuickDock\(quickDock\);/, "placeQuickDock 必须按 moved 分流");

// 存档字段：新档带 moved，老档补 false。
assert.match(shell, /settings\.quickDock \?\?= \{[^}]*moved: false[^}]*\}/, "新存档必须带 moved");
assert.match(shell, /quickDockState\.moved \?\?= false;/, "老存档必须在渲染时补 moved（??= 而不是 ||=，false 不该被改写成别的值）");

// 样式：缺 touch-action 的手机表现是「按着拖变滚动页面」，肉眼很像功能没做。
const headRule = css.match(/\.quick-dock-head \{[^}]*\}/g) || [];
assert.ok(headRule.length >= 1, "找不到 .quick-dock-head 规则");
assert.ok(headRule.some((rule) => /cursor:\s*grab;/.test(rule)), ".quick-dock-head 要有 grab 光标（拖动把手的手感）");
assert.ok(headRule.some((rule) => /touch-action:\s*none;/.test(rule)), ".quick-dock-head 必须有 touch-action:none，否则手机上拖不动（手势被当滚动）");
assert.ok(headRule.some((rule) => /user-select:\s*none;/.test(rule)), ".quick-dock-head 要禁选中（拖动时不选中标题文字）");
assert.match(css, /\.quick-dock\.dragging \.quick-dock-head \{ cursor: grabbing; \}/, "拖动中光标要变 grabbing");

console.log("PASS: 快捷入口面板拖动落位（跟手位移 / 四边钳制含 --sab / 抖动不落档 / 双击恢复跟随 / 打断回滚 / 触屏可拖 / 非主键不拖 / 监听不留 / 老存档兼容 / 接线与样式守卫）");
