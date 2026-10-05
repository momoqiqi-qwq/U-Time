import assert from "node:assert/strict";

const listeners = new Map();
globalThis.document = {
  documentElement: { dataset: { uiMotion: "full" } },
  addEventListener(type, fn) { listeners.set(type, fn); },
};
globalThis.window = {
  matchMedia: () => ({ matches: false }),
  addEventListener(type, fn) { listeners.set(type, fn); },
};
globalThis.getComputedStyle = () => ({ transform: "matrix(.97,0,0,.97,0,0)" });
const { initMotionInteractions, enterPage } = await import("../src/motion.js");
const classes = new Set();
const animations = [];
const control = {
  tagName: "DIV", // role=button，不创建波纹
  classList: {
    add: value => classes.add(value), remove: value => classes.delete(value),
    toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); },
  },
  closest(selector) { return selector.includes("data-motion") ? null : this; },
  getAttribute: () => null,
  matches: () => false,
  animate(frames, options) {
    const animation = { frames, options, cancelled: false, finished: new Promise(() => {}),
      cancel() { this.cancelled = true; } };
    animations.push(animation);
    return animation;
  },
};
initMotionInteractions();
const down = () => listeners.get("pointerdown")({ button: 0, target: control });
down();
assert.ok(classes.has("motion-pressing"));
listeners.get("pointerup")({ type: "pointerup", target: null });
assert.equal(classes.has("motion-pressing"), false);
assert.equal(animations.length, 1, "拖出控件后释放也归位");
assert.equal(animations[0].frames[0].transform, "matrix(.97,0,0,.97,0,0)");
listeners.get("click")({ target: control, detail: 1 });
assert.equal(animations.length, 1, "pointerup + click 只释放一次");
down();
assert.ok(animations[0].cancelled, "再按下取消旧动画");
listeners.get("pointercancel")({ type: "pointercancel" });
assert.equal(animations.length, 1, "取消手势不启动释放动效");
assert.equal(classes.size, 0);
down();
document.documentElement.dataset.uiMotion = "reduced";
listeners.get("pointerup")({ type: "pointerup" });
assert.equal(animations.length, 1, "手势中切减少动效立即恢复");
assert.equal(classes.size, 0);
enterPage(null);
enterPage(control);
assert.equal(animations.length, 1);
console.log("PASS: release outside, click deduplication, interrupted press, cancellation and reduced motion");
