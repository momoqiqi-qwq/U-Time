import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";

/* v0.181.0 · 插件中心卡片尺寸（拖动调整）
   行为断言，不做静态字符串匹配：把 src/marketCardResize.js 真跑起来，
   用假 DOM 走一遍「按下 → 小位移不算拖 → 大位移激活 → 松手落盘 / Esc 取消」。
   起点取**卡片当前实际尺寸**（假卡片给 190 × 100），不是偏好值 —— 偏好里的高度 0 只表示「不设下限」。 */

const source = readProductSource(new URL("../src/marketCardResize.js", import.meta.url), "utf8");
// 剥掉 import 与 export 关键字，塞进 new Function 由 env 注入依赖。
const code = source
  .replace(/^import[\s\S]*?from\s+"[^"]+";\s*/m, "")
  .replace(/\bexport\s+/g, "");
assert.ok(!/^\s*import\s/m.test(code), "import 语句必须已被剥掉（否则 new Function 会语法报错）");

const CARD_W = 190, CARD_H = 100;
let prefs = { marketCardWidth: 180, marketCardHeight: 0 };
const writes = [];
let hintNode = null;
const docListeners = new Map();
const winListeners = new Map();
const gridListeners = new Map();

function makeStyle() {
  return { props: {}, setProperty(key, value) { this.props[key] = value; } };
}
function makeClassList() {
  const set = new Set();
  return { set, add(c) { set.add(c); }, remove(c) { set.delete(c); }, contains(c) { return set.has(c); } };
}
function makeNode(tag = "div") {
  const node = {
    tag,
    className: "",
    textContent: "",
    style: makeStyle(),
    classList: makeClassList(),
    setAttribute() {},
    append() {},
    remove() { if (hintNode === node) hintNode = null; },
  };
  return node;
}
function makeCard() {
  const node = makeNode("div");
  node.closest = (selector) => (selector.includes(".mcard") ? node : null);
  node.getBoundingClientRect = () => ({
    width: CARD_W, height: CARD_H, left: 0, top: 0, right: CARD_W, bottom: CARD_H,
  });
  return node;
}
function makeGrid() {
  const node = {
    classList: makeClassList(),
    contains: (child) => child === card,
    addEventListener(type, fn) { gridListeners.set(type, fn); },
    removeEventListener(type) { gridListeners.delete(type); },
  };
  return node;
}

const documentStub = {
  documentElement: { style: makeStyle() },
  body: { append(node) { hintNode = node; } },
  createElement: (tag) => makeNode(tag),
  addEventListener(type, fn) { docListeners.set(type, fn); },
  removeEventListener(type) { docListeners.delete(type); },
};
const windowStub = {
  addEventListener(type, fn) { winListeners.set(type, fn); },
  removeEventListener(type) { winListeners.delete(type); },
};

const env = {
  DEFAULT_UI_PREFERENCES: { marketCardWidth: 180, marketCardHeight: 0 },
  MARKET_CARD_SIZE_LIMITS: { minWidth: 120, maxWidth: 460, minHeight: 0, maxHeight: 420 },
  getUiPreferences: () => ({ ...prefs }),
  setUiPreferences: (patch) => { writes.push({ ...patch }); prefs = { ...prefs, ...patch }; return prefs; },
  document: documentStub,
  window: windowStub,
  requestAnimationFrame: (fn) => { fn(); return 1; },
  cancelAnimationFrame: () => {},
};
const api = new Function(
  ...Object.keys(env),
  `${code}\nreturn { cardSizeFrom, applyCardSizeVars, resetMarketCardSize, attachMarketCardResize };`,
)(...Object.values(env));

/* ── 1. 纯换算：1px 位移 = 1px 变化，且始终落在合法区间 ── */
assert.deepEqual(api.cardSizeFrom(190, 100, 20, -10), { width: 210, height: 90 }, "水平改宽、垂直改高，互不串台");
assert.deepEqual(api.cardSizeFrom(190, 100, -500, 0), { width: 120, height: 100 }, "宽度下限 120");
assert.deepEqual(api.cardSizeFrom(190, 100, 0, -500), { width: 190, height: 0 }, "高度下限 0 —— 0 表示随内容自适应");
assert.deepEqual(api.cardSizeFrom(190, 100, 999, 999), { width: 460, height: 420 }, "上限 460 × 420");

/* ── 2. CSS 变量：拖动只写这两个变量，全部卡片跟着变 ── */
const varTarget = { style: makeStyle() };
api.applyCardSizeVars(240, 200, varTarget);
assert.equal(varTarget.style.props["--market-card-w"], "240px");
assert.equal(varTarget.style.props["--market-card-h"], "200px");

/* ── 3. 手势：按下 → 小位移不算拖 → 大位移激活 → 松手落盘 ── */
const card = makeCard();
const grid = makeGrid();
const detach = api.attachMarketCardResize(grid, {});
const down = gridListeners.get("pointerdown");
assert.ok(down, "必须监听网格上的 pointerdown（事件委托到卡片）");

down({ pointerType: "touch", button: 0, pointerId: 1, clientX: 10, clientY: 10, target: card });
assert.equal(docListeners.size, 0, "触屏拖动 = 滚动，必须完全不介入");

down({ pointerType: "mouse", button: 0, pointerId: 1, clientX: 10, clientY: 10, target: { closest: (s) => (s.includes("button") ? {} : null) } });
assert.equal(docListeners.size, 0, "按在滑块 / ⋯ 上不能开始改尺寸");

down({ pointerType: "mouse", button: 2, pointerId: 1, clientX: 10, clientY: 10, target: card });
assert.equal(docListeners.size, 0, "右键（上下文菜单）不介入");

down({ pointerType: "mouse", button: 0, pointerId: 7, clientX: 100, clientY: 100, target: card });
const move = docListeners.get("pointermove"), up = docListeners.get("pointerup"), key = docListeners.get("keydown");
assert.ok(move && up && key, "会话开始后要挂 pointermove / pointerup / keydown");

move({ pointerId: 7, clientX: 103, clientY: 100 });
assert.equal(grid.classList.contains("market-resizing"), false, "位移小于阈值算点击，不进入调整态");
assert.equal(documentStub.documentElement.style.props["--market-card-w"], undefined, "未激活时不许改尺寸");
assert.equal(hintNode, null, "未激活时不弹尺寸提示");

move({ pointerId: 7, clientX: 130, clientY: 120 });
assert.equal(grid.classList.contains("market-resizing"), true, "越过阈值进入调整态");
assert.equal(documentStub.documentElement.style.props["--market-card-w"], "220px", "起点是卡片实际宽 190 + 30");
assert.equal(documentStub.documentElement.style.props["--market-card-h"], "120px", "起点是卡片实际高 100 + 20");
assert.ok(hintNode, "拖动中要有尺寸提示");
assert.equal(hintNode.textContent, "宽 220 × 高 120");

up({ pointerId: 7 });
assert.deepEqual(writes.at(-1), { marketCardWidth: 220, marketCardHeight: 120 }, "松手必须落盘（重启后保持）");
assert.equal(grid.classList.contains("market-resizing"), false, "松手退出调整态");
assert.equal(hintNode, null, "松手收起提示");
assert.ok(docListeners.get("click"), "pointerup 后要拦一次 capture click —— 拖动不能顺带打开插件");

/* ── 4. Esc 取消：还原到本次拖动开始前的偏好值，且不落盘 ── */
const writesBefore = writes.length;
down({ pointerType: "mouse", button: 0, pointerId: 8, clientX: 100, clientY: 100, target: card });
move({ pointerId: 8, clientX: 200, clientY: 200 });
assert.equal(documentStub.documentElement.style.props["--market-card-w"], "290px", "取消前确实改过尺寸（起点 190 + 100）");
key({ key: "Escape" });
assert.equal(writes.length, writesBefore, "Esc 取消不许落盘");
assert.equal(documentStub.documentElement.style.props["--market-card-w"], "220px", "Esc 还原到本次拖动前的偏好值");
assert.equal(documentStub.documentElement.style.props["--market-card-h"], "120px");

/* ── 5. 恢复默认 + 卸载 ── */
api.resetMarketCardSize();
assert.deepEqual(writes.at(-1), { marketCardWidth: 180, marketCardHeight: 0 }, "恢复默认回到 180 × 0（高度随内容）");

detach();
assert.equal(gridListeners.has("pointerdown"), false, "卸载后不再监听 pointerdown");

console.log("PASS: plugin market card resize —— 水平改宽 / 垂直改高（起点取卡片实际尺寸）、阈值区分点击与拖动、触屏与控件不介入、松手落盘、Esc 取消、恢复默认");
