import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// 执行产品里的完整光块控制器，复现 observe(新按钮) 的首次通知。
const shell = readFileSync(new URL("../src/shell.js", import.meta.url), "utf8");
const source = shell.slice(shell.indexOf("  const NAV_GLOW_SLIDE_MS"), shell.indexOf("  /* 一段可拖拽容器"));
const animations = [];
const classes = new Set();
let observer;
let currentTop = null;
let factor = 1;
let reduced = false;
const box = {
  clientLeft: 0, clientTop: 0, scrollLeft: 0, scrollTop: 0,
  getBoundingClientRect: () => ({ left: 0, top: 0 }),
};
const button = (top, height = 40) => ({
  dataset: { view: `plug:${top}` }, isConnected: true,
  getBoundingClientRect: () => ({ left: 10 * factor, top: top * factor, width: 200 * factor, height: height * factor }),
});
let selected = button(40);
const nav = { querySelectorAll: () => [selected] };
const navGlow = {
  offsetParent: box, style: {},
  classList: { contains: value => classes.has(value), add: value => classes.add(value), remove: value => classes.delete(value) },
  getBoundingClientRect() {
    return { left: parseFloat(this.style.left) * factor, top: (currentTop ?? parseFloat(this.style.top)) * factor,
      width: parseFloat(this.style.width) * factor, height: parseFloat(this.style.height) * factor };
  },
  animate(frames, options) {
    const animation = { frames, options, cancelled: false, cancel() { this.cancelled = true; } };
    animations.push(animation);
    return animation;
  },
};
const context = vm.createContext({
  nav, navGlow, activeView: selected.dataset.view,
  layoutBoxOf: node => node.getBoundingClientRect(),
  getUiScaleFactor: () => factor, reducedMotion: () => reduced,
  ResizeObserver: class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() {} unobserve() {}
  },
});
vm.runInContext(`${source}\nthis.sync = syncNavGlow;`, context);
context.sync(); observer.callback();
assert.equal(animations.length, 0, "首次显示直接落位");
selected = button(160);
context.activeView = selected.dataset.view;
context.sync();
assert.equal(animations.length, 1, "切换插件启动位移动画");
assert.equal(animations[0].options.duration, 500);
currentTop = 65;
observer.callback();
assert.equal(animations[0].cancelled, false, "新按钮的首次尺寸通知不能取消正在移动的光块");
context.sync();
assert.equal(animations.length, 1, "相同目标的重复刷新不能重启动画");
selected = button(280, 48);
context.activeView = selected.dataset.view;
context.sync();
assert.equal(animations[0].cancelled, true, "快速切换取消上一段动画");
assert.equal(animations[1].frames[0].transform, "translate3d(0px, -215px, 0)", "从当前视觉位置继续移动");
assert.equal(animations[2].options.duration, 400, "行高变化仍走独立尺寸通道");
observer.callback();
assert.equal(animations[1].cancelled, false);
assert.equal(animations[2].cancelled, false);
selected = button(280, 56);
currentTop = null;
observer.callback();
assert.equal(animations[1].cancelled, true, "真实行高变化要立即重新对齐");
assert.equal(navGlow.style.height, "56px");
factor = 1.25;
selected = button(360, 56);
context.activeView = selected.dataset.view;
context.sync();
assert.equal(navGlow.style.top, "360px", "缩放后坐标仍使用布局像素");
reduced = true;
observer.callback();
assert.equal(animations.at(-1).cancelled, true, "减少动效立即停止移动");
navGlow.offsetParent = null;
context.sync();
assert.equal(classes.has("on"), false, "隐藏侧栏后光块淡出");
console.log("PASS: 新按钮首次尺寸通知、重复刷新、快速切换连续性、双通道、真实尺寸变化、缩放、减少动效与隐藏侧栏");
