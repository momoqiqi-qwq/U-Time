import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { attachToolbarDrag, toolbarItems, toolbarSlot, animateToolbarReorder } from "../src/toolbarDrag.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const shell = read("../src/shell.js"), css = read("../src/styles.css");
const orderSource = shell.slice(shell.indexOf("const TOPBAR_PARTS ="), shell.indexOf("function viewDef("));
const state = { settings: { topbarOrder: ["quick", "search", "theme", "stats", "window"] } };
let saves = 0;
const { topbarOrderState, moveTopbarPart } = new Function("S", `${orderSource}; return { topbarOrderState, moveTopbarPart };`)(
  { getState: () => state, persistSoon: () => saves++ },
);
assert.deepEqual(topbarOrderState(), ["quick", "search", "theme", "stats", "history", "sync", "logs", "settings", "window"], "自定义顺序保留，新增入口插在窗口控制之前");
state.settings.topbarOrder = ["theme", "theme", "missing", "window"];
assert.deepEqual(topbarOrderState(), ["theme", "history", "sync", "search", "logs", "settings", "quick", "stats", "window"], "去重并丢弃未知部件");
assert.equal(moveTopbarPart(["settings", "quick", "search", "theme", "stats"]), true);
assert.equal(state.settings.topbarOrder.at(-1), "window", "浏览器未渲染窗口键时仍保留它的存档位置");
assert.equal(moveTopbarPart(state.settings.topbarOrder), false, "相同顺序不重复写盘");
assert.equal(saves, 1);
state.settings = {};
const defaultOrder = ["history", "sync", "search", "logs", "theme", "settings", "quick", "stats", "window"];
assert.deepEqual(topbarOrderState(), defaultOrder, "新用户采用图片对应默认顺序");
assert.equal(state.settings.topbarLayout, "reference");
state.settings = { topbarOrder: ["search", "quick", "theme", "settings", "stats", "window"] };
assert.deepEqual(topbarOrderState(), defaultOrder, "旧默认升级到新默认");
state.settings = { topbarOrder: ["settings", "search", "quick", "theme", "stats", "window"] };
assert.equal(topbarOrderState()[0], "settings", "自定义顺序不被新默认覆盖");
assert.equal(state.settings.topbarLayout, undefined);
assert.match(shell, /class: "top-mini-btn top-settings-trigger"/);
assert.match(shell, /onclick: \(\) => openSettingsModal\(\)/, "顶栏复用原设置面板");
assert.match(shell, /attachToolbarDrag\(topbarActionCard/);
assert.doesNotMatch(shell, /text\/topbar-part/, "不能再同时保留另一套原生拖放事件");
assert.match(css, /:root\[data-theme-mode="dark"\] \.rail-dock > \.rail-dock-btn\.window-focus-btn \.ic,[\s\S]*?color: #fff;/);
assert.match(css, /:root\[data-theme-mode="dark"\] \.rail-dock-ghost\.window-focus-btn \.ic/);

const widths = new Map([["a", 34], ["b", 120], ["c", 34]]);
const spaced = new Map([["b", { left: 200, right: 200 }]]);
assert.equal(toolbarSlot(["a", "b", "c"], "a", widths, 100, 4, 200, spaced), 0, "搜索前的空白不能误判为移到右侧工具");
assert.equal(toolbarSlot(["a", "b", "c"], "a", widths, 100, 4, 600, spaced), 1, "搜索后的空白对应中间槽位");
assert.equal(toolbarSlot(["a", "b", "c"], "a", widths, 100, 4, 122), 0, "起拖时不要自动让第一个按钮右移");
assert.equal(toolbarSlot(["a", "b", "c"], "a", widths, 100, 4, 199), 1, "越过不同宽度的部件中心才换位");
assert.equal(toolbarSlot(["b", "a", "c"], "a", widths, 100, 4, 199), 1, "换位后指针停住不抖动");
assert.equal(toolbarSlot(["a", "b", "c"], "b", widths, 100, 4, 0), 0);
assert.equal(toolbarSlot(["a", "b", "c"], "b", widths, 100, 4, 900), 2);
const scaled = new Map([...widths].map(([id, w]) => [id, w * 1.5]));
assert.equal(toolbarSlot(["a", "b", "c"], "a", scaled, 150, 6, 199 * 1.5), 1, "槽位统一使用缩放后的视口坐标");

class Target {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  fire(type, event = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn(event); }
}
class Element extends Target {
  constructor(id = "", classes = "rail-dock-btn", width = 40) {
    super(); this.id = id; this.classes = new Set(classes.split(" ").filter(Boolean)); this.width = width;
    this.children = []; this.parentElement = null; this.attrs = new Map(); this.moves = []; this.position = "static";
    this.tagName = classes.includes("rail-dock-btn") ? "BUTTON" : "DIV";
    if (id) this.attrs.set("id", id);
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.classList = { add: (...xs) => xs.forEach(x => this.classes.add(x)), remove: (...xs) => xs.forEach(x => this.classes.delete(x)), contains: x => this.classes.has(x) };
  }
  matches(selector) {
    return selector.split(",").some(raw => {
      const s = raw.trim();
      if (s.startsWith(".")) return this.classes.has(s.slice(1));
      if (s === "[role='button']") return this.attrs.get("role") === "button";
      if (s.startsWith("[") && s.endsWith("]")) return this.attrs.has(s.slice(1, -1));
      if (s === "a[href]") return this.tagName === "A" && this.attrs.has("href");
      return this.tagName === s.toUpperCase();
    });
  }
  closest(s) { return this.matches(s) ? this : this.parentElement?.closest(s); }
  get nextSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
  get isConnected() { return this === doc.body || Boolean(this.parentElement?.isConnected); }
  getClientRects() { return this.hidden || !this.isConnected ? [] : [this.getBoundingClientRect()]; }
  getBoundingClientRect() {
    let left = 100;
    if (this.parentElement) for (const node of this.parentElement.children) { if (node === this) break; left += node.width + 4; }
    return { left, top: 10, width: this.width, height: 40, right: left + this.width, bottom: 50 };
  }
  getAttribute(k) { return this.attrs.get(k) ?? null; }
  setAttribute(k, v) { this.attrs.set(k, v); }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); if (k === "id") this.id = ""; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  insertBefore(node, before) { node.remove(); node.parentElement = this; const i = before ? this.children.indexOf(before) : this.children.length; this.children.splice(i, 0, node); }
  remove() { if (this.parentElement) { const p = this.parentElement; p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
  cloneNode(deep = false) {
    const copy = new Element(this.id, [...this.classes].join(" "), this.width);
    copy.attrs = new Map(this.attrs); copy.tagName = this.tagName;
    if (deep) copy.append(...this.children.map(node => node.cloneNode(true)));
    return copy;
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  setPointerCapture() {}
  releasePointerCapture() {}
  focus() { document.activeElement = this; }
  animate(frames, options) { const result = { cancelled: false, cancel() { this.cancelled = true; } }; this.moves.push({ frames, options, result }); return result; }
}
const doc = new Target(), win = new Target();
doc.documentElement = { dataset: { uiMotion: "full" } }; doc.body = new Element("body", "");
win.matchMedia = () => ({ matches: false });
globalThis.document = doc; globalThis.window = win;
globalThis.getComputedStyle = (node) => ({ position: node.position, columnGap: "4px", padding: "0px", gap: "4px", font: "14px sans-serif", color: "white" });
let serial = 0; const frames = new Map();
globalThis.requestAnimationFrame = fn => { frames.set(++serial, fn); return serial; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
const tick = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
const pointer = (target, x, extra = {}) => ({ target, clientX: x, clientY: 25, pointerId: 1, pointerType: "mouse", button: 0, preventDefault() { this.prevented = true; this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra });
const fixture = (options) => {
  const list = new Element("list", ""); const buttons = ["a", "b", "c"].map(id => new Element(id));
  if (options?.selector) for (const button of buttons) button.setAttribute("data-topbar-part", button.id);
  list.append(...buttons); doc.body.append(list); let commits = 0;
  const binding = attachToolbarDrag(list, () => commits++, options);
  return { list, buttons, binding, order: () => list.children.map(x => x.id), commits: () => commits };
};
const ghosts = () => doc.body.children.filter(x => x.classes.has("rail-dock-ghost") || x.classes.has("topbar-drag-ghost"));

let f = fixture();
f.buttons[1].position = "absolute";
assert.deepEqual(toolbarItems(f.list, ".rail-dock-btn"), [f.buttons[0], f.buttons[2]], "居中的统计不能占排序槽位");
f.buttons[1].position = "static";
f.list.fire("pointerdown", pointer(f.buttons[0], 120));
doc.fire("pointerup", pointer(f.buttons[0], 120));
assert.equal(f.commits(), 0, "普通点击不能触发换位或写盘");
assert.equal(doc.listeners.get("pointermove").size, 0);
f.buttons[0].focus();
f.list.fire("keydown", pointer(f.buttons[0], 120, { altKey: true, key: "ArrowRight" }));
assert.deepEqual(f.order(), ["b", "a", "c"]);
assert.equal(f.commits(), 1);
assert.ok(f.buttons[0].moves.length && f.buttons[1].moves.length, "键盘换位也应播放 FLIP");
assert.equal(doc.activeElement, f.buttons[0]);
f.binding.destroy(); f.list.remove();

for (const options of [undefined, { selector: "[data-topbar-part]", ghostClass: "topbar-drag-ghost", dragClass: "topbar-dragging", liveClass: "topbar-drag-live" }]) {
  f = fixture(options);
  f.list.fire("pointerdown", pointer(f.buttons[0], 120));
  doc.fire("pointermove", pointer(f.buttons[0], 170)); tick();
  assert.deepEqual(f.order(), ["b", "a", "c"]);
  assert.equal(ghosts().length, 1, "两个工具区都必须有跟手副本");
  const click = pointer(f.buttons[0], 170); doc.fire("click", click);
  assert.ok(click.prevented && click.stopped, "拖动中不能触发原按钮点击");
  doc.fire("pointerup", pointer(f.buttons[0], 230));
  assert.deepEqual(f.order(), ["b", "c", "a"]);
  assert.equal(f.commits(), 1);
  assert.equal(ghosts().length, 0);
  assert.equal(frames.size, 0);
  assert.equal(f.buttons[0].getAttribute("data-motion"), null, "松手恢复原动效属性");
  assert.equal(f.buttons[0].moves.at(-1).options.duration, 210, "松手有落位动画");
  assert.ok(doc.listeners.get("click").size, "pointerup 后的 click 仍须吞掉");
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(doc.listeners.get("click").size, 0);
  f.binding.destroy(); f.list.remove();
}

for (const end of [() => doc.fire("pointercancel", pointer(f.buttons[0], 180)), () => doc.fire("keydown", pointer(f.buttons[0], 180, { key: "Escape" })), () => win.fire("blur")]) {
  f = fixture();
  f.list.fire("pointerdown", pointer(f.buttons[0], 120));
  doc.fire("pointermove", pointer(f.buttons[0], 180)); tick();
  end();
  assert.deepEqual(f.order(), ["a", "b", "c"], "取消/失焦必须回滚原顺序");
  assert.equal(f.commits(), 0); assert.equal(ghosts().length, 0); assert.equal(frames.size, 0);
  f.binding.destroy(); f.list.remove();
}
await new Promise(resolve => setTimeout(resolve, 1));

f = fixture(); doc.documentElement.dataset.uiMotion = "reduced";
f.list.fire("pointerdown", pointer(f.buttons[0], 120));
doc.fire("pointermove", pointer(f.buttons[0], 220)); tick();
doc.fire("pointerup", pointer(f.buttons[0], 220));
assert.deepEqual(f.order(), ["b", "c", "a"]);
assert.equal(f.commits(), 1); assert.equal(ghosts().length, 0);
assert.ok(f.buttons.every(x => !x.moves.length), "减少动效模式不播放位移动画");
f.binding.destroy(); f.list.remove(); doc.documentElement.dataset.uiMotion = "full";
await new Promise(resolve => setTimeout(resolve, 1));

f = fixture();
f.list.fire("pointerdown", pointer(f.buttons[0], 120, { pointerType: "touch" }));
await new Promise(resolve => setTimeout(resolve, 260));
assert.equal(ghosts().length, 1, "触屏长按可进入拖拽");
doc.fire("pointercancel", pointer(f.buttons[0], 120));
f.binding.destroy(); f.list.remove();
await new Promise(resolve => setTimeout(resolve, 1));

const node = new Element("flip"); let left = 60;
node.getBoundingClientRect = () => ({ left, top: 0 });
animateToolbarReorder([node], () => { left = 120; }, { scale: 1.5 });
assert.equal(node.moves.at(-1).frames[0].transform, "translate(-40px, 0px)", "FLIP 位移须补偿界面缩放");
const previous = node.moves.at(-1).result;
animateToolbarReorder([node], () => { left = 150; }, { scale: 1.5 });
assert.ok(previous.cancelled, "连续换位必须取消旧动画，不能叠加偏移");


// v0.82.0: boundary keys belong to the toolbar, not browser history.
for (const options of [undefined, { selector: "[data-topbar-part]" }]) {
  f = fixture(options);
  for (const [button, key] of [[f.buttons[0], "ArrowLeft"], [f.buttons[2], "ArrowRight"]]) {
    const keyEvent = pointer(button, 120, { altKey: true, key });
    f.list.fire("keydown", keyEvent);
    assert.equal(keyEvent.defaultPrevented, true, "换位到边界仍须拦截 Alt+方向键");
  }
  assert.equal(f.commits(), 0);
  assert.deepEqual(f.order(), ["a", "b", "c"]);
  assert.ok(f.buttons.every(button => !button.moves.length));
  f.buttons[1].remove(); f.buttons[2].remove();
  const singleton = pointer(f.buttons[0], 120, { altKey: true, key: "ArrowRight" });
  f.list.fire("keydown", singleton);
  assert.equal(singleton.defaultPrevented, true, "单项工具栏也不能触发历史前进");
  const outside = pointer(new Element("outside", ""), 120, { altKey: true, key: "ArrowLeft" });
  f.list.fire("keydown", outside);
  assert.notEqual(outside.defaultPrevented, true, "工具栏之外的后退快捷键不受影响");
  f.buttons[0].disabled = true;
  const disabled = pointer(f.buttons[0], 120, { altKey: true, key: "ArrowLeft" });
  f.list.fire("keydown", disabled);
  assert.notEqual(disabled.defaultPrevented, true);
  f.binding.destroy(); f.list.remove();
}

// Stationary drags do zero per-frame work; many input events share a single frame.
f = fixture();
f.list.fire("pointerdown", pointer(f.buttons[0], 120));
doc.fire("pointermove", pointer(f.buttons[0], 170));
assert.equal(frames.size, 1);
tick();
assert.equal(frames.size, 0, "处理输入后不自行排下一帧");
const realRects = Element.prototype.getClientRects, realStyle = globalThis.getComputedStyle;
let rectReads = 0, styleReads = 0, transformWrites = 0;
Element.prototype.getClientRects = function () { rectReads++; return realRects.call(this); };
globalThis.getComputedStyle = node => { styleReads++; return realStyle(node); };
const ghostStyle = ghosts()[0].style, realSetProperty = ghostStyle.setProperty;
ghostStyle.setProperty = function (key, value) { if (key === "transform") transformWrites++; return realSetProperty.call(this, key, value); };
for (let i = 0; i < 60; i++) tick();
assert.deepEqual([rectReads, styleReads, transformWrites], [0, 0, 0], "静止 60 帧不得测量或写入 transform");
for (let i = 0; i < 100; i++) doc.fire("pointermove", pointer(f.buttons[0], 171 + i));
assert.equal(frames.size, 1, "高频移动最多保留一个待执行帧");
assert.deepEqual([rectReads, styleReads, transformWrites], [0, 0, 0]);
tick();
assert.deepEqual([rectReads, styleReads, transformWrites], [3, 3, 1]);
assert.deepEqual(f.order(), ["b", "c", "a"], "这一帧使用最后坐标");
assert.equal(frames.size, 0);
Element.prototype.getClientRects = realRects; globalThis.getComputedStyle = realStyle;
f.binding.destroy(); f.list.remove();
await new Promise(resolve => setTimeout(resolve, 1));

// pointerup flushes the latest coordinates even before the queued frame executes.
// RAF id 0 is valid too; cancellation must not depend on truthiness.
serial = -1;
f = fixture();
f.list.fire("pointerdown", pointer(f.buttons[0], 120));
doc.fire("pointermove", pointer(f.buttons[0], 170));
assert.ok(frames.has(0));
doc.fire("pointerup", pointer(f.buttons[0], 240));
assert.deepEqual(f.order(), ["b", "c", "a"]);
assert.equal(f.commits(), 1); assert.equal(frames.size, 0);
tick(); assert.equal(f.commits(), 1, "残留帧不能重复提交");
f.binding.destroy(); f.list.remove();
await new Promise(resolve => setTimeout(resolve, 1));

for (const stop of [
  () => win.fire("resize"),
  () => f.list.fire("lostpointercapture", pointer(f.list, 170)),
  () => f.binding.destroy(),
]) {
  f = fixture();
  f.list.fire("pointerdown", pointer(f.buttons[0], 120));
  doc.fire("pointermove", pointer(f.buttons[0], 170));
  stop();
  assert.equal(frames.size, 0); assert.equal(ghosts().length, 0); assert.equal(f.commits(), 0);
  assert.deepEqual(f.order(), ["a", "b", "c"]);
  f.binding.destroy(); f.list.remove();
}
await new Promise(resolve => setTimeout(resolve, 1));

for (const invalidate of [() => f.list.remove(), () => f.buttons[0].remove(), () => { f.buttons[0].hidden = true; }]) {
  f = fixture();
  f.list.fire("pointerdown", pointer(f.buttons[0], 120));
  doc.fire("pointermove", pointer(f.buttons[0], 170));
  invalidate();
  doc.fire("pointerup", pointer(f.buttons[0], 240));
  assert.equal(f.commits(), 0, "失效节点不能提交排序");
  assert.equal(frames.size, 0); assert.equal(ghosts().length, 0);
  assert.equal(doc.listeners.get("pointermove").size, 0);
  f.binding.destroy(); f.list.remove();
}
await new Promise(resolve => setTimeout(resolve, 1));

f = fixture();
f.list.fire("pointerdown", pointer(f.buttons[0], 120, { pointerType: "touch" }));
f.buttons[0].hidden = true;
await new Promise(resolve => setTimeout(resolve, 260));
assert.equal(ghosts().length, 0, "长按期间变为隐藏，不得启动拖拽");
assert.equal(frames.size, 0); assert.equal(doc.listeners.get("pointermove").size, 0);
f.binding.destroy(); f.list.remove();

// A composite toolbar item must not copy focusable window controls into the Tab order.
f = fixture({ selector: "[data-topbar-part]", ghostClass: "topbar-drag-ghost" });
const inner = new Element("minimize", "window-control"); inner.tagName = "BUTTON";
inner.setAttribute("autofocus", ""); inner.classList.add("motion-pressing", "motion-clicked");
const ripple = new Element("", "motion-ripple"); inner.append(ripple);
f.buttons[0].tagName = "DIV"; f.buttons[0].append(inner);
f.list.fire("pointerdown", pointer(inner, 120));
doc.fire("pointermove", pointer(inner, 170)); tick();
const copy = ghosts()[0], copiedButton = copy.querySelectorAll("button")[0];
assert.ok(copy.hasAttribute("inert"));
assert.equal(copy.getAttribute("aria-hidden"), "true");
assert.equal(copy.querySelectorAll("[id]").length, 0);
assert.equal(copiedButton.getAttribute("tabindex"), "-1");
assert.equal(copiedButton.hasAttribute("autofocus"), false);
assert.equal(inner.classList.contains("motion-pressing"), false);
assert.equal(inner.classList.contains("motion-clicked"), false);
assert.equal(inner.querySelectorAll(".motion-ripple").length, 0);
f.binding.destroy(); f.list.remove();
await new Promise(resolve => setTimeout(resolve, 1));
// Losing the child's implicit touch capture is normal when the list takes over.
f = fixture();
f.list.fire("pointerdown", pointer(f.buttons[0], 120));
doc.fire("pointermove", pointer(f.buttons[0], 170));
f.list.fire("lostpointercapture", pointer(f.buttons[0], 170));
assert.equal(ghosts().length, 1, "子节点捕获转移不能取消容器的拖拽");
assert.equal(frames.size, 1);
tick();
doc.fire("pointerup", pointer(f.list, 170));
assert.deepEqual(f.order(), ["b", "a", "c"]);
assert.equal(f.commits(), 1);
f.binding.destroy(); f.list.remove();
await new Promise(resolve => setTimeout(resolve, 1));
console.log("PASS: toolbar controls, boundary keys, demand-driven frames, last-coordinate flush, invalidation, capture transfer, inert ghosts and prior behavior");
