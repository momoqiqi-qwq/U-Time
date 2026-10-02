import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../src/store.js";
import { DEFAULT_TASK_PREFERENCES, getTaskPreferences, normalizeTaskPreferences } from "../src/taskPreferences.js";
import { SETTINGS_SEARCH_ENTRIES } from "../src/settingsSearchIndex.js";

assert.deepEqual(normalizeTaskPreferences(), DEFAULT_TASK_PREFERENCES);
for (const bad of [null, [], "bad"]) assert.deepEqual(normalizeTaskPreferences(bad), DEFAULT_TASK_PREFERENCES);
const invalid = normalizeTaskPreferences({ defaultQuad: 8, defaultEstMin: Infinity, blankBlockMin: "", defaultDueTime: "25:10", autoScheduleStart: "09:99", blankBlockCategory: "bad" });
assert.deepEqual(invalid, DEFAULT_TASK_PREFERENCES);
assert.equal(normalizeTaskPreferences({ defaultEstMin: 1 }).defaultEstMin, 15);
assert.equal(normalizeTaskPreferences({ blankBlockMin: 9999 }).blankBlockMin, 1440);

const memory = new Map();
globalThis.localStorage = { getItem: (k) => memory.get(k), setItem: (k, v) => memory.set(k, v) };
S.replaceAll({ tasks: [], blocks: [], settings: { unrelated: "keep" }, plugins: {} });
const old = S.addTask({ title: "existing" });
S.getState().settings.taskDefaults = {
  defaultQuad: 2, defaultEstMin: 47, defaultDueTime: "18:20", defaultReminderEnabled: false,
  autoScheduleStart: "05:30", blankBlockMin: 38, blankBlockCategory: "study",
};
const task = S.addTask({ title: "custom defaults", due: "2026-10-02" });
assert.equal(task.quad, 2);
assert.equal(task.estMin, 47);
assert.equal(task.dueTime, "18:20");
assert.equal(task.reminderEnabled, false);
assert.equal(old.estMin, 30, "existing tasks are never rewritten");
assert.equal(old.reminderEnabled, true);
const explicit = S.addTask({ quad: 4, estMin: 90, dueTime: "09:00", reminderEnabled: true });
assert.equal(explicit.quad, 4);
assert.equal(explicit.estMin, 90);
assert.equal(explicit.dueTime, "09:00");
assert.equal(explicit.reminderEnabled, true);
S.addBlock({ date: "2026-10-02", start: "05:30", durMin: 30 });
assert.equal(S.placeTask(task, "2026-10-02").start, "06:00", "auto placement respects configured start and busy intervals");
assert.equal(S.placeTask(task, "2026-10-02", 480).start, "08:00", "manual start takes priority");
S.getState().settings.taskDefaults.autoScheduleStart = "23:50";
const before = JSON.stringify(S.getState().blocks);
assert.throws(() => S.placeTask(task, "2026-10-02"));
assert.equal(JSON.stringify(S.getState().blocks), before, "failed placement preserves prior schedule");
S.getState().settings.taskDefaults.autoScheduleStart = "05:30";

// Run the real settings-card event handlers with a minimal DOM fixture.
class Node {
  constructor(tag, attrs = {}, ...children) { this.tag = tag; this.attrs = attrs; this.children = children.flat(); this.value = String(attrs.value ?? ""); this.handlers = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, fn) { this.handlers[type] = fn; }
  checkValidity() { return this.attrs.type !== "number" || (Number.isInteger(Number(this.value)) && Number(this.value) >= 15 && Number(this.value) <= 1440); }
}
const messages = [];
const source = readFileSync(new URL("../src/views/settings/tasks.js", import.meta.url), "utf8");
const create = new Function("S", "el", "toast", "QUADS", "toggleSwitch", "DEFAULT_TASK_PREFERENCES", "getTaskPreferences", "normalizeTaskPreferences",
  source.slice(source.indexOf("export function")).replace("export function", "function") + "\nreturn createTaskSettingsCard;")(
    S, (...args) => new Node(...args), (msg) => messages.push(msg), [{ q: 1, title: "Important" }, { q: 2, title: "Planned" }],
    (opts) => new Node("switch", opts), DEFAULT_TASK_PREFERENCES, getTaskPreferences, normalizeTaskPreferences);
const card = create();
const descendants = (node) => [node, ...node.children.filter((c) => c instanceof Node).flatMap(descendants)];
const find = (label) => descendants(card).find((n) => n.attrs["aria-label"] === label || n.attrs.ariaLabel === label);
const input = find("默认预估时长");
input.value = "73"; input.handlers.change();
assert.equal(getTaskPreferences(S.getState().settings).defaultEstMin, 73);
input.value = "0"; input.handlers.change();
assert.equal(input.value, "73");
assert.equal(getTaskPreferences(S.getState().settings).defaultEstMin, 73, "invalid UI values do not persist");
find("空白时间块默认分类").value = "sport";
find("空白时间块默认分类").handlers.change();
find("新任务默认开启提醒").attrs.onChange(true);
assert.equal(S.addTask({}).reminderEnabled, true);
assert.equal(getTaskPreferences(S.getState().settings).blankBlockCategory, "sport");
await S.saveNow();
await S.initStore({});
assert.equal(getTaskPreferences(S.getState().settings).defaultEstMin, 73, "settings survive reload");
assert.equal(getTaskPreferences(S.getState().settings).blankBlockCategory, "sport");
const defaultsBefore = getTaskPreferences(S.getState().settings);
for (const label of ["默认任务象限", "默认预估时长", "默认截止时刻", "新任务默认开启提醒", "自动排程起始时间", "空白时间块默认时长", "空白时间块默认分类"]) {
  assert.ok(find(label), `missing setting: ${label}`);
  assert.ok(SETTINGS_SEARCH_ENTRIES.some((entry) => entry.section === "tasks" && entry.title === label));
}
assert.equal(defaultsBefore.defaultEstMin, 73);
descendants(card).find((n) => n.tag === "button").attrs.onclick();
assert.deepEqual(getTaskPreferences(S.getState().settings), DEFAULT_TASK_PREFERENCES);
assert.equal(S.getState().settings.unrelated, "keep", "reset is limited to task defaults");
await S.saveNow();
console.log("PASS: task defaults, overrides, scheduling, failed placement, settings handlers, validation, search, persistence and isolated reset");
