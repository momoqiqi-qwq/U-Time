import assert from "node:assert/strict";
import { attachPomodoroGlass, pomodoroGlassState } from "../src/pomodoroGlass.js";
import { normalizeUiPreferences } from "../src/uiPreferences.js";

assert.equal(normalizeUiPreferences({}).pomodoroLiquidGlass, false);
assert.equal(normalizeUiPreferences({ pomodoroLiquidGlass: true }).pomodoroLiquidGlass, true);
for (const value of [false, "true", 1, null]) assert.equal(normalizeUiPreferences({ pomodoroLiquidGlass: value }).pomodoroLiquidGlass, false);
const prefs = { pomodoroLiquidGlass: true, motion: "system" };
assert.equal(pomodoroGlassState({}, false, false), "off");
assert.equal(pomodoroGlassState(prefs, false, false), "running");
assert.equal(pomodoroGlassState(prefs, true, false), "paused");
assert.equal(pomodoroGlassState(prefs, false, false, false), "paused");
assert.equal(pomodoroGlassState(prefs, false, true), "static");
assert.equal(pomodoroGlassState({ ...prefs, motion: "reduced" }, false, false), "static");
assert.equal(pomodoroGlassState({ ...prefs, motion: "full" }, false, true), "running");

// An unavailable GPU must preserve the original card, avoid frame loops, and release listeners.
class Events {
  handlers = new Map();
  addEventListener(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(fn); }
  removeEventListener(type, fn) { this.handlers.get(type)?.delete(fn); }
  emit(type, detail) { for (const fn of this.handlers.get(type) || []) fn({ detail }); }
  count() { return [...this.handlers.values()].reduce((sum, set) => sum + set.size, 0); }
}
const doc = new Events(), win = new Events(), media = new Events();
media.matches = false;
let contexts = 0, frames = 0, current = { pomodoroLiquidGlass: false, motion: "system" };
doc.hidden = false; doc.documentElement = { dataset: {} };
doc.createElement = () => ({ style: {}, setAttribute() {}, getContext() { contexts++; return null; }, remove() {}, removeEventListener() {} });
win.matchMedia = () => media;
win.requestAnimationFrame = () => { frames++; return 1; };
win.cancelAnimationFrame = () => {};
const card = { style: { position: "static", isolation: "auto" }, dataset: {}, prepend() { throw new Error("Fallback cannot attach a blank canvas"); } };
const dispose = attachPomodoroGlass(card, { doc, browserWindow: win, preferences: () => current });
assert.equal(contexts, 0, "Disabled effects cannot allocate GPU contexts");
current = { ...current, pomodoroLiquidGlass: true }; win.emit("tide:ui-preferences-changed", current);
assert.equal(card.dataset.liquidGlassState, "fallback");
assert.equal(contexts, 1);
assert.equal(frames, 0);
assert.equal(card.style.position, "static");
win.emit("tide:ui-preferences-changed", current);
assert.equal(contexts, 1, "An unavailable GPU must not be retried continuously");
win.emit("tide:ui-preferences-changed", { ...current, pomodoroLiquidGlass: false });
assert.equal(card.dataset.liquidGlassState, "off");
win.emit("tide:ui-preferences-changed", current);
assert.equal(contexts, 2, "An explicit off/on cycle allows retrying after a context failure");
dispose(); dispose();
assert.equal(win.count() + doc.count() + media.count(), 0);
assert.equal(card.dataset.liquidGlassState, undefined);
console.log("PASS: 番茄玻璃偏好、后台/减少动效状态、GPU 不可用降级、显式重试与释放监听");
