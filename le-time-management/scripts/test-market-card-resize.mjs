import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";

/* v0.181.0 · 插件中心卡片尺寸（拖动调整）
   行为断言，不做静态字符串匹配：把 src/marketCardResize.js 真跑起来，
   用假 DOM 走一遍「按下 → 小位移不算拖 → 大位移激活 → 松手落盘 / Esc 取消」。
   起点取**卡片当前实际尺寸**（假卡片给 190 × 100），不是偏好值 —— 偏好里的高度 0 只表示「随内容」。

   v0.214.3 补：拖动中整页 resize 光标（按**实际尺寸变化**随方向变，含斜向两个方向）、
   松手落位过渡类、界面缩放换算、高度 0 → auto。 */

const source = readProductSource(new URL("../src/marketCardResize.js", import.meta.url), "utf8");
// 剥掉 import 与 export 关键字，塞进 new Function 由 env 注入依赖。
// ⚠️ 必须带 g：文件里有两段 import（uiPreferences / uiScale），只剥第一段会留下裸 import → new Function 语法报错。
const code = source
  .replace(/^import[\s\S]*?from\s+"[^"]+";\s*/gm, "")
  .replace(/\bexport\s+/g, "");
assert.ok(!/^\s*import\s/m.test(code), "import 语句必须已被剥掉（否则 new Function 会语法报错）");

const CARD_W = 190, CARD_H = 100;
let prefs = { marketCardWidth: 180, marketCardHeight: 0 };
let uiScale = 1;
const writes = [];
let hintNode = null;
const docListeners = new Map();
const winListeners = new Map();
const gridListeners = new Map();

function makeStyle() {
  return {
    props: {},
    setProperty(key, value) { this.props[key] = value; },
    removeProperty(key) { delete this.props[key]; },
  };
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
  documentElement: { style: makeStyle(), classList: makeClassList() },
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
  MARKET_CARD_SIZE_LIMITS: { minWidth: 120, maxWidth: 460, minHeight: 76, maxHeight: 420 },
  getUiPreferences: () => ({ ...prefs }),
  setUiPreferences: (patch) => { writes.push({ ...patch }); prefs = { ...prefs, ...patch }; return prefs; },
  getUiScaleFactor: () => uiScale,
  document: documentStub,
  window: windowStub,
  requestAnimationFrame: (fn) => { fn(); return 1; },
  cancelAnimationFrame: () => {},
};
const api = new Function(
  ...Object.keys(env),
  `${code}\nreturn { resizeCursor, cardSizeFrom, applyCardSizeVars, resetMarketCardSize, attachMarketCardResize };`,
)(...Object.values(env));

/* ── 1. 纯换算：1px 位移 = 1px 变化，且始终落在合法区间 ── */
assert.deepEqual(api.cardSizeFrom(190, 100, 20, -10), { width: 210, height: 90 }, "水平改宽、垂直改高，互不串台");
assert.deepEqual(api.cardSizeFrom(190, 100, -500, 0), { width: 120, height: 100 }, "宽度下限 120");
assert.deepEqual(api.cardSizeFrom(190, 100, 0, -500), { width: 190, height: 76 }, "高度下限 76 —— 拖到下限就停，不会缩成一条线");
assert.deepEqual(api.cardSizeFrom(190, 100, 999, 999), { width: 460, height: 420 }, "上限 460 × 420");

/* ── 1.5 指针形状：按**实际尺寸变化**给 resize 光标（拖动缩小时必须给「可调整」而不是「搬运」的指针） ── */
assert.equal(api.resizeCursor(30, 0), "ew-resize", "只有宽度变了 → 左右调整光标");
assert.equal(api.resizeCursor(-40, 0), "ew-resize", "往左缩同样是左右调整光标（看绝对值）");
assert.equal(api.resizeCursor(0, 30), "ns-resize", "只有高度变了 → 上下调整光标");
assert.equal(api.resizeCursor(30, 25), "nwse-resize", "两轴同向（右下拉大）→ 西北-东南对角光标");
assert.equal(api.resizeCursor(-30, -25), "nwse-resize", "两轴同向（左上缩小）→ 同一个对角光标");
assert.equal(api.resizeCursor(30, -25), "nesw-resize", "两轴反向（右上）→ 东北-西南对角光标");
assert.equal(api.resizeCursor(-30, 25), "nesw-resize", "两轴反向（左下）→ 同一个对角光标");
assert.equal(api.resizeCursor(0, 0), "default", "两轴都没变（已顶到上下限）→ 交给调用方保持上一个光标，不跳回箭头");

/* ── 2. CSS 变量：拖动只写这两个变量，全部卡片跟着变 ── */
const varTarget = { style: makeStyle() };
api.applyCardSizeVars(240, 200, varTarget);
assert.equal(varTarget.style.props["--market-card-w"], "240px");
assert.equal(varTarget.style.props["--market-card-h"], "200px");
// 高度 0 = 随内容，必须写 auto：写 0px 会把卡片压成一条线（正是「拖动缩小没有反馈」的同族坑）
const varTarget0 = { style: makeStyle() };
api.applyCardSizeVars(180, 0, varTarget0);
assert.equal(varTarget0.style.props["--market-card-h"], "auto", "高度 0 → auto（随内容自适应）");

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
// 光标挂在 <html> 上（指针拖到卡片外也要保持），按**实际尺寸变化**实时变：
assert.equal(documentStub.documentElement.classList.contains("market-resizing-page"), true, "拖动中整页进入调整尺寸光标态");
assert.equal(documentStub.documentElement.style.props["--market-resize-cursor"], "nwse-resize", "宽高都变了 → 对角调整光标（不是 grabbing）");

move({ pointerId: 7, clientX: 130, clientY: 220 });
assert.equal(documentStub.documentElement.style.props["--market-resize-cursor"], "nwse-resize", "看整段拖动方向（宽高都动过）→ 一直是对角光标，指针中途换向不闪");
assert.equal(documentStub.documentElement.style.props["--market-card-w"], "220px", "垂直拖动不改宽度");
assert.equal(documentStub.documentElement.style.props["--market-card-h"], "220px", "起点 100 + 120");

up({ pointerId: 7 });
assert.deepEqual(writes.at(-1), { marketCardWidth: 220, marketCardHeight: 220 }, "松手必须落盘（重启后保持）");
assert.equal(grid.classList.contains("market-resizing"), false, "松手退出调整态");
assert.equal(hintNode, null, "松手收起提示");
assert.equal(documentStub.documentElement.classList.contains("market-resizing-page"), false, "松手整页光标态必须收干净，否则全页指针会一直停在 resize");
assert.equal(documentStub.documentElement.style.props["--market-resize-cursor"], undefined, "松手清掉光标变量");
assert.equal(grid.classList.contains("market-settling"), true, "松手挂落位过渡：拖动值 → 落位值（auto）要过渡，不能硬弹");
assert.ok(docListeners.get("click"), "pointerup 后要拦一次 capture click —— 拖动不能顺带打开插件");

/* ── 3.5 纯垂直拖动：宽度全程没变 → 光标必须是上下调整（不是 grabbing、也不是对角） ── */
down({ pointerType: "mouse", button: 0, pointerId: 12, clientX: 100, clientY: 100, target: card });
move({ pointerId: 12, clientX: 100, clientY: 160 });
assert.equal(documentStub.documentElement.style.props["--market-resize-cursor"], "ns-resize", "只拖高度 → 上下调整光标");
assert.equal(documentStub.documentElement.style.props["--market-card-w"], "190px", "dx = 0 → 宽度保持起点值");
assert.equal(documentStub.documentElement.style.props["--market-card-h"], "160px", "起点 100 + 60");
key({ key: "Escape" }); // 收尾，别把偏好改掉（下一节要断言「还原到本次拖动前的偏好」）

/* ── 4. Esc 取消：还原到本次拖动开始前的偏好值，且不落盘 ── */
const writesBefore = writes.length;
down({ pointerType: "mouse", button: 0, pointerId: 8, clientX: 100, clientY: 100, target: card });
assert.equal(grid.classList.contains("market-settling"), false, "落位过渡没走完就再按下：必须先收掉，否则这次拖动每帧都被 200ms 过渡拖住");
move({ pointerId: 8, clientX: 200, clientY: 200 });
assert.equal(documentStub.documentElement.style.props["--market-card-w"], "290px", "取消前确实改过尺寸（起点 190 + 100）");
assert.equal(documentStub.documentElement.style.props["--market-resize-cursor"], "nwse-resize", "斜拉 → 对角光标");
key({ key: "Escape" });
assert.equal(writes.length, writesBefore, "Esc 取消不许落盘");
assert.equal(documentStub.documentElement.style.props["--market-card-w"], "220px", "Esc 还原到本次拖动前的偏好值");
assert.equal(documentStub.documentElement.style.props["--market-card-h"], "220px");
assert.equal(documentStub.documentElement.classList.contains("market-resizing-page"), false, "取消也要把整页光标态收掉");
assert.equal(documentStub.documentElement.style.props["--market-resize-cursor"], undefined, "取消也要清掉光标变量");

/* ── 5. 界面缩放：clientX / rect 是屏幕视觉 px，CSS 变量是布局 px，位移要除以缩放系数 ── */
uiScale = 1.25;
down({ pointerType: "mouse", button: 0, pointerId: 9, clientX: 100, clientY: 100, target: card });
move({ pointerId: 9, clientX: 125, clientY: 100 });
assert.equal(documentStub.documentElement.style.props["--market-card-w"], "172px", "起点 190/1.25 = 152，位移 25/1.25 = 20 → 172（布局 px）");
up({ pointerId: 9 });
assert.deepEqual(writes.at(-1), { marketCardWidth: 172, marketCardHeight: 80 }, "缩放下的落盘值同样是布局 px");
uiScale = 1;

/* ── 6. 取消回「随内容」默认值：高度 0 要还原成 auto，不能还原成 0px ── */
prefs = { marketCardWidth: 180, marketCardHeight: 0 };
down({ pointerType: "mouse", button: 0, pointerId: 10, clientX: 100, clientY: 100, target: card });
move({ pointerId: 10, clientX: 120, clientY: 180 });
assert.equal(documentStub.documentElement.style.props["--market-card-h"], "180px", "拖动中先写确定像素（起点 100 + 80）");
key({ key: "Escape" });
assert.equal(documentStub.documentElement.style.props["--market-card-w"], "180px", "取消还原偏好宽");
assert.equal(documentStub.documentElement.style.props["--market-card-h"], "auto", "取消还原偏好高：0 = 随内容 → auto");
assert.deepEqual(writes.at(-1), { marketCardWidth: 172, marketCardHeight: 80 }, "取消不落盘");

/* ── 7. 恢复默认 + 卸载 ── */
api.resetMarketCardSize();
assert.deepEqual(writes.at(-1), { marketCardWidth: 180, marketCardHeight: 0 }, "恢复默认回到 180 × 0（高度随内容）");
assert.equal(documentStub.documentElement.style.props["--market-card-h"], "auto", "恢复默认同样写 auto");

detach();
assert.equal(gridListeners.has("pointerdown"), false, "卸载后不再监听 pointerdown");
assert.equal(grid.classList.contains("market-settling"), false, "卸载要连落位过渡的定时器一起收掉");

console.log("PASS: plugin market card resize —— 水平改宽 / 垂直改高（起点取卡片实际尺寸）、拖动中整页 resize 光标按实际尺寸变化随方向变（含斜向）、阈值区分点击与拖动、触屏与控件不介入、松手落盘与落位过渡、Esc 取消、缩放换算、高度 0 → auto、恢复默认");
