import assert from "node:assert/strict";
import { attachSelectionGlow } from "../src/selectionGlow.js";

const frames = [];
const animations = [];
const observers = [];
globalThis.requestAnimationFrame = callback => { frames.push(callback); };
globalThis.document = {
  documentElement: { dataset: { uiMotion: "full" } },
  createElement: () => new Element(),
};
globalThis.window = { matchMedia: () => ({ matches: false }) };
globalThis.ResizeObserver = class {
  constructor(callback) { this.callback = callback; observers.push(this); }
  observe() {}
  unobserve() {}
  disconnect() {}
};

class Element {
  constructor(left = 0, width = 60) {
    this.offsetLeft = left;
    this.offsetTop = 0;
    this.offsetWidth = width;
    this.offsetHeight = 30;
    this.offsetParent = {};
    this.isConnected = true;
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.attrs = {};
    this.scrollLeft = this.scrollTop = this.clientLeft = this.clientTop = 0;
    const values = new Set();
    this.classList = {
      add: value => values.add(value),
      remove: value => values.delete(value),
      contains: value => values.has(value),
    };
    this.shift = 0;
  }
  append(child) { this.children.push(child); }
  setAttribute(name, value) { this.attrs[name] = value; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  removeEventListener(name) { this.listeners.delete(name); }
  querySelector() { return this.active; }
  getBoundingClientRect() {
    const styledLeft = Number.parseFloat(this.style.left);
    return {
      left: (Number.isFinite(styledLeft) ? styledLeft : this.offsetLeft) + this.shift,
      top: Number.parseFloat(this.style.top) || this.offsetTop,
      width: Number.parseFloat(this.style.width) || this.offsetWidth,
      height: Number.parseFloat(this.style.height) || this.offsetHeight,
    };
  }
  animate(keyframes, options) {
    const animation = { keyframes, options, cancelled: false, cancel() { this.cancelled = true; } };
    animations.push(animation);
    return animation;
  }
}

function group(left = 0) {
  const container = new Element();
  container.active = new Element(left);
  return container;
}
function flush() { while (frames.length) frames.shift()(); }

const tabs = group();
const control = attachSelectionGlow(tabs, { selector: ".on" });
flush();
assert.equal(animations.length, 0, "first selection lands without a slide");
tabs.active = new Element(120);
control.sync();
assert.equal(animations.at(-1).options.duration, 500);
const firstSlide = animations.at(-1);
observers[0].callback();
assert.equal(firstSlide.cancelled, false, "first ResizeObserver delivery preserves the slide");
control.sync();
assert.equal(animations.at(-1), firstSlide, "same target does not restart the slide");
tabs.active = new Element(230);
tabs.children.at(-1).shift = -60;
control.sync();
assert.equal(firstSlide.cancelled, true, "a new choice replaces the previous slide");
assert.equal(animations.at(-1).keyframes[0].transform, "translate(-170px, 0px)", "rapid switch starts at the visible position");

const oldGroup = group();
attachSelectionGlow(oldGroup, { selector: ".on", persistKey: "density" });
flush();
oldGroup.listeners.get("click")({ target: { closest: () => ({}) } });
const replacement = group(100);
const replacementControl = attachSelectionGlow(replacement, { selector: ".on", persistKey: "density" });
flush();
assert.equal(animations.at(-1).options.duration, 500, "rebuilt choices retain the previous glow position");
assert.equal(animations.at(-1).keyframes[0].transform, "translate(-100px, 0px)");

document.documentElement.dataset.uiMotion = "reduced";
const before = animations.length;
replacement.active = new Element(200);
replacementControl.sync();
assert.equal(animations.length, before, "reduced motion adds no animation");
assert.equal(replacement.children.at(-1).style.left, "200px", "reduced motion still lands on the choice");
control.dispose();
console.log("PASS: selection glow first paint, observer, repeated/rapid switch, rebuilt choices and reduced motion");
