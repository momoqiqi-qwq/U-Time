import assert from "node:assert/strict";
import { createSettingsNavigator } from "../src/views/settings/navigator.js";
import { normalizeUiPreferences } from "../src/uiPreferences.js";

assert.equal(normalizeUiPreferences({}).nepheleSettings, false);
assert.equal(normalizeUiPreferences({ nepheleSettings: "true" }).nepheleSettings, false);
assert.equal(normalizeUiPreferences({ nepheleSettings: true, nepheleBackground: false }).nepheleBackground, false);

class Node {
  nodeType = 1; children = []; attrs = {}; listeners = new Map(); hidden = false; value = ""; textContent = "";
  classes = new Set();
  classList = { add: (...xs) => xs.forEach(x => this.classes.add(x)),
    toggle: (x, force) => { if (force) this.classes.add(x); else this.classes.delete(x); } };
  setAttribute(key, value) { this.attrs[key] = value; if (key === "value") this.value = value; if (key === "hidden") this.hidden = true; }
  removeAttribute(key) { delete this.attrs[key]; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  closest() { return null; }
  scrollIntoView() {}
  focus() { focused = this; }
}
let focused;
const media = { matches: false, addEventListener() {}, removeEventListener() {} };
globalThis.window = { matchMedia: () => media };
globalThis.document = { createElement: () => new Node(), createElementNS: () => new Node(),
  createTextNode: text => Object.assign(new Node(), { textContent: text }), documentElement: { dataset: { uiMotion: "reduced" } } };
globalThis.requestAnimationFrame = fn => fn();
function fixture(options = {}) {
  const state = {};
  const entries = ["ui", "theme", "data"].map(id => ({ id, label: id, node: new Node() }));
  const nav = createSettingsNavigator(entries, state, options);
  nav.apply();
  const search = nav.node.children[0].children[1];
  const buttons = nav.node.children[0].children[2].children;
  const visible = () => nav.panels.filter(p => !p.hidden && !p.children[1].hidden);
  return { nav, state, search, buttons, visible, entries };
}
// Desktop: only active panel, retain original DOM and unfinished input while toggling.
const desktop = fixture();
desktop.entries[1].node.value = "unfinished";
desktop.nav.select("theme");
desktop.nav.setTabs(true);
assert.equal(desktop.state.active, "theme");
assert.equal(desktop.visible().length, 1);
assert.equal(desktop.entries[1].node.value, "unfinished");
desktop.buttons[1].listeners.get("keydown")({ key: "ArrowRight", preventDefault() {} });
assert.equal(desktop.state.active, "data");
assert.equal(focused, desktop.buttons[2]);
desktop.search.value = "ui"; desktop.nav.apply();
assert.equal(desktop.visible().length, 1);
assert.equal(desktop.state.active, "ui");
desktop.nav.setTabs(false);
assert.equal(desktop.search.value, "ui");
assert.equal(desktop.entries[1].node.value, "unfinished");
desktop.nav.dispose();

// Android: opt-in replaces directory with tabs; turning it off restores detail/back flow.
media.matches = true;
const mobile = fixture({ pages: true, tabs: true });
assert.equal(mobile.visible().length, 1);
mobile.nav.select("theme");
assert.equal(mobile.nav.node.hidden, false);
assert.equal(mobile.nav.node._back(), false);
mobile.nav.setTabs(false);
assert.equal(mobile.nav.node.hidden, true);
assert.equal(mobile.visible().length, 1);
assert.equal(mobile.nav.node._back(), true);
assert.equal(mobile.visible().length, 0);
mobile.nav.dispose();
const filteredMobile = fixture({ pages: true, tabs: true });
filteredMobile.nav.select("theme");
filteredMobile.search.value = "data"; filteredMobile.nav.apply();
filteredMobile.nav.setTabs(false);
assert.equal(filteredMobile.state.page, "data", "退出标签布局时，保留搜索后的当前分类");
assert.equal(filteredMobile.visible().length, 1);
filteredMobile.nav.dispose();
// Browser narrow accordion remains available with switch off.
const narrow = fixture();
assert.equal(narrow.visible().length, 0);
narrow.nav.setTabs(true);
assert.equal(narrow.visible().length, 1);
narrow.nav.setTabs(false);
assert.equal(narrow.visible().length, 0);
narrow.nav.dispose();
console.log("PASS: Nephele 设置独立开关、保留分类与草稿、搜索、键盘切换、Android 返回及窄屏目录恢复");
