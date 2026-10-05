import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isSelfActivationKey } from "../src/ui.js";
import { initMotionInteractions } from "../src/motion.js";

// Pure activation policy: only the focused card, never an inner native control.
const card = {}, button = {}, input = {};
for (const key of ["Enter", " "]) {
  assert.equal(isSelfActivationKey({ key, target: card, currentTarget: card }), true);
  for (const target of [button, input]) {
    assert.equal(isSelfActivationKey({ key, target, currentTarget: card }), false, "内部按钮/输入框保留自己的键盘行为");
  }
  assert.equal(isSelfActivationKey({ key, target: card, currentTarget: card, defaultPrevented: true }), false);
  assert.equal(isSelfActivationKey({ key, target: card, currentTarget: card, isComposing: true }), false, "输入法确认不能打开卡片");
}
assert.equal(isSelfActivationKey({ key: "Escape", target: card, currentTarget: card }), false);
assert.equal(isSelfActivationKey({ key: "Enter", target: null, currentTarget: null }), false);
const shell = readFileSync(new URL("../src/shell.js", import.meta.url), "utf8");
assert.match(shell, /!pv \|\| !enabled \|\| !isSelfActivationKey\(e\)/, "插件卡片必须接入经过行为测试的激活判断");

// Minimal event/control fixture. CSS and native bubbling are covered separately in Chromium.
class Target {
  listeners = new Map();
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  fire(type, event = {}) { for (const fn of this.listeners.get(type) || []) fn(event); }
}
class Control extends Target {
  constructor(tagName = "BUTTON") {
    super();
    this.tagName = tagName; this.attrs = new Map(); this.children = []; this.parentElement = null;
    this.style = {}; this.classes = new Set(); this.geometryReads = 0; this.layoutReads = 0;
    this.animations = [];
    this.classList = {
      add: (...xs) => xs.forEach(x => this.classes.add(x)),
      remove: (...xs) => xs.forEach(x => this.classes.delete(x)),
      contains: x => this.classes.has(x),
      toggle: (x, force) => {
        const add = force ?? !this.classes.has(x);
        if (add) this.classes.add(x); else this.classes.delete(x);
        return add;
      },
    };
  }
  getAttribute(key) { return this.attrs.get(key) ?? null; }
  setAttribute(key, value) { this.attrs.set(key, value); }
  removeAttribute(key) { this.attrs.delete(key); }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (selector === '[data-motion="off"]' ? node.getAttribute("data-motion") === "off"
        : node.tagName === "BUTTON" || node.getAttribute("role") === "button") return node;
    }
    return null;
  }
  getBoundingClientRect() { this.geometryReads++; return { left: 10, top: 10, width: 40, height: 34 }; }
  get offsetWidth() { this.layoutReads++; return 40; }
  matches() { return false; }
  animate(frames, options) {
    const animation = { frames, options, cancelled: false, finished: Promise.resolve(), cancel() { this.cancelled = true; } };
    this.animations.push(animation);
    return animation;
  }
  append(node) { node.parentElement = this; this.children.push(node); }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter(node => node !== this);
    this.parentElement = null;
  }
}
const doc = new Target(), win = new Target();
doc.documentElement = { dataset: { uiMotion: "full" } };
doc.createElement = tag => new Control(tag.toUpperCase());
let systemReduced = false;
win.matchMedia = () => ({ matches: systemReduced });
const timers = [];
win.setTimeout = fn => { timers.push(fn); return timers.length; };
globalThis.document = doc; globalThis.window = win;
globalThis.getComputedStyle = () => ({ transform: "matrix(0.98, 0, 0, 0.98, 0, 1)" });
initMotionInteractions(); initMotionInteractions();
assert.equal(doc.listeners.get("pointerdown").size, 1, "全局监听初始化必须幂等");
const event = (target, extra = {}) => ({ target, button: 0, clientX: 25, clientY: 24, detail: 1, ...extra });
const clear = () => { doc.fire("pointerup"); while (timers.length) timers.shift()(); };
const expectQuiet = (control, label) => {
  const down = event(control), click = event(control, { detail: 0 });
  doc.fire("pointerdown", down); doc.fire("click", click);
  assert.equal(control.classList.contains("motion-pressing"), false, label);
  assert.equal(control.classList.contains("motion-clicked"), false, label);
  assert.equal(control.children.length, 0, `${label}：不生成波纹`);
  assert.equal(control.geometryReads, 0, `${label}：不测量波纹几何`);
  assert.equal(control.layoutReads, 0, `${label}：不强制读取 offsetWidth`);
  assert.equal(control.animations.length, 0, `${label}：不创建释放动画`);
  assert.equal(timers.length, 0, `${label}：不创建动效定时器`);
  assert.notEqual(down.defaultPrevented, true); assert.notEqual(click.defaultPrevented, true);
};

let control = new Control(); control.setAttribute("data-motion", "off");
expectQuiet(control, "自身 off");
const parent = new Control("DIV"); parent.setAttribute("data-motion", "off");
control = new Control(); parent.append(control);
expectQuiet(control, "祖先 off");

doc.documentElement.dataset.uiMotion = "reduced";
expectQuiet(new Control(), "应用减少动效");
doc.documentElement.dataset.uiMotion = "system"; systemReduced = true;
expectQuiet(new Control(), "系统减少动效");
doc.documentElement.dataset.uiMotion = "full";

control = new Control();
doc.fire("pointerdown", event(control));
assert.ok(control.classList.contains("motion-pressing"));
assert.equal(control.children.length, 1, "正常按钮仍有波纹；full 可覆盖系统减少动效");
doc.fire("click", event(control));
assert.equal(control.animations.length, 1, "正常点击保留释放反馈");
assert.equal(control.animations[0].frames[0].transform, "matrix(0.98, 0, 0, 0.98, 0, 1)", "释放从当前视觉状态开始");
assert.equal(control.layoutReads, 0, "正常点击也不强制刷新布局");
doc.fire("click", event(control));
assert.equal(control.animations[0].cancelled, true, "连续点击取消旧动画，避免叠加");
assert.equal(control.animations.length, 2);
clear();
assert.equal(control.children.length, 0);
assert.equal(control.classList.contains("motion-pressing"), false);
assert.equal(control.classList.contains("motion-clicked"), false);

control = new Control();
doc.fire("click", event(control, { detail: 0 }));
assert.equal(control.children.length, 1, "普通键盘激活仍有反馈");
clear();

control = new Control();
const dynamicParent = new Control("DIV"); dynamicParent.append(control);
doc.fire("pointerdown", event(control));
assert.ok(control.classList.contains("motion-pressing"));
dynamicParent.setAttribute("data-motion", "off");
doc.fire("click", event(control, { detail: 0 }));
assert.equal(control.layoutReads, 0, "按下后进入拖拽，不再计算点击动画");
assert.equal(control.children.length, 1, "按下时的波纹之外，不生成新波纹");
win.fire("blur");
assert.equal(control.classList.contains("motion-pressing"), false, "off 后失焦仍清理已按下状态");
clear();

const css = readFileSync(new URL("../src/styles/interactions.css", import.meta.url), "utf8");
assert.match(css, /button\.motion-pressing:not\(\[data-motion="off"\], \[data-motion="off"\] \*\)/);
assert.match(css, /\[data-motion="off"\] \.motion-ripple \{ display: none; animation: none; \}/);
console.log("PASS: card activation boundaries, nested controls, motion off/inheritance, reduced motion, cleanup and normal feedback");
