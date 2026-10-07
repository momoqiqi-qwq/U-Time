import assert from "node:assert/strict";
import { initNepheleBackground, nepheleBackgroundState } from "../src/nepheleBackground.js";
import { normalizeUiPreferences } from "../src/uiPreferences.js";

assert.equal(normalizeUiPreferences({}).nepheleBackground, true);
assert.equal(normalizeUiPreferences({ nepheleBackground: true }).nepheleBackground, true);
assert.equal(normalizeUiPreferences({ nepheleBackground: "true" }).nepheleBackground, false);
for (const [motion, systemReduced, hidden, expected] of [
  ["system", false, false, "running"], ["system", true, false, "paused"],
  ["full", true, false, "running"], ["reduced", false, false, "paused"],
  ["full", false, true, "paused"],
]) {
  assert.equal(nepheleBackgroundState({ nepheleBackground: true, motion }, hidden, systemReduced), expected);
  assert.equal(nepheleBackgroundState({ nepheleBackground: false, motion }, hidden, systemReduced), "off");
}

class Events {
  listeners = new Map();
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  emit(name, detail) { for (const fn of this.listeners.get(name) || []) fn({ detail }); }
  count() { return [...this.listeners.values()].reduce((n, list) => n + list.size, 0); }
}
const media = new Events(); media.matches = false;
const win = new Events(); win.matchMedia = () => media;
const doc = new Events(); doc.hidden = false;
const attached = [];
doc.body = { prepend(node) { attached.push(node); } };
doc.createElement = () => ({
  dataset: {}, children: [], attrs: {}, style: { setProperty() {} },
  append(node) { this.children.push(node); },
  setAttribute(key, value) { this.attrs[key] = value; },
  remove() { const at = attached.indexOf(this); if (at >= 0) attached.splice(at, 1); },
});
const dispose = initNepheleBackground({ doc, browserWindow: win, preferences: () => ({ nepheleBackground: true, motion: "system" }) });
assert.equal(attached.length, 1, "默认开启，启动时创建动画节点");
const enable = { nepheleBackground: true, motion: "system" };
win.emit("tide:ui-preferences-changed", enable);
const layer = attached[0];
assert.equal(layer.attrs["aria-hidden"], "true", "装饰不能进入辅助阅读树");
assert.equal(layer.dataset.state, "running");
win.emit("tide:ui-preferences-changed", enable);
assert.equal(attached.length, 1, "重复刷新偏好不能叠加背景");
doc.hidden = true; doc.emit("visibilitychange");
assert.equal(layer.dataset.state, "paused");
doc.hidden = false; doc.emit("visibilitychange");
assert.equal(layer.dataset.state, "running");
media.matches = true; media.emit("change");
assert.equal(layer.dataset.state, "paused", "系统减少动态效果变化立即生效");
win.emit("tide:ui-preferences-changed", { ...enable, motion: "full" });
assert.equal(layer.dataset.state, "running");
win.emit("pagehide"); assert.equal(layer.dataset.state, "paused");
win.emit("pageshow"); assert.equal(layer.dataset.state, "running");
win.emit("tide:ui-preferences-changed", { nepheleBackground: false });
assert.equal(attached.length, 0, "关闭应移除整层，避免隐藏动画仍运行");
win.emit("tide:ui-preferences-changed", enable);
assert.equal(attached.length, 1, "重新开启应恢复效果");
dispose();
assert.equal(attached.length, 0);
assert.equal(win.count() + doc.count() + media.count(), 0, "销毁必须注销所有监听");
console.log("PASS: Nephele 背景默认开启、开关重建、减少动效、隐藏暂停与恢复、无重复节点及监听清理");
