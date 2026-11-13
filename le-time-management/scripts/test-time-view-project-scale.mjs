import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/views/timeViews.js", import.meta.url), "utf8");
const modelSource = source.slice(source.indexOf("function collectTimelineData("), source.indexOf("function taskCat("));
let state;
const context = vm.createContext({
  S: { getState: () => state, durLabel: (n) => `${n} 分钟` },
  taskCat: () => "work",
  safeDateFromCreated: () => "2026-01-01",
});
vm.runInContext(`var sortedItems = 0; const nativeSort = Array.prototype.sort;
  Array.prototype.sort = function (...args) { sortedItems += this.length; return nativeSort.apply(this, args); };`, context);
const collect = vm.runInContext(`(${modelSource.trim()})`, context);
const plain = (value) => JSON.parse(JSON.stringify(value));
state = {
  tasks: [
    { id: "a", title: "逆序排程", project: "项目 A" },
    { id: "b", title: "截止优先", tags: ["学习"], due: "2026-02-01T09:00" },
    { id: "c", title: "没有排程" },
    { id: "d", title: "已完成", done: true },
    { id: "a", title: "重复 ID", project: "项目 A" },
  ],
  blocks: [
    { id: "a3", taskId: "a", date: "2026-12-31", title: "最后", start: "09:00", durMin: 30 },
    { id: "a1", taskId: "a", date: "2026-01-02", title: "最早", start: "09:00", durMin: 30 },
    { id: "a2", taskId: "a", date: "2026-06-01", title: "中间", start: "09:00", durMin: 30 },
    { id: "b1", taskId: "b", date: "2026-03-01", title: "截止后", start: "09:00", durMin: 30 },
    { id: "orphan", taskId: "missing", date: "2026-04-01", title: "独立安排", start: "09:00", durMin: 30 },
  ],
};
const before = structuredClone(state);
const result = collect("2026-06-01");
assert.deepEqual(plain(result.projects), [
  ["项目 A", [
    { id: "a", group: "项目 A", title: "逆序排程", start: "2026-01-02", end: "2026-12-31", cat: "work" },
    { id: "a", group: "项目 A", title: "重复 ID", start: "2026-01-02", end: "2026-12-31", cat: "work" },
  ]],
  ["学习", [{ id: "b", group: "学习", title: "截止优先", start: "2026-02-01", end: "2026-03-01", cat: "work" }]],
  ["未分类任务", [{ id: "c", group: "未分类任务", title: "没有排程", start: "2026-01-01", end: "2026-01-01", cat: "work" }]],
]);
assert.equal(result.events.length, 6, "保留独立时间块和截止事件");
assert.equal(result.blocks, state.blocks, "时间块引用保持不变");
assert.deepEqual(state, before, "统计不能修改原始任务和排程");

// 重复 ID 会共享同一组排程；逐任务复制并排序会退化为平方复杂度。
const count = 1500;
let dateReads = 0;
state = {
  tasks: Array.from({ length: count }, (_, i) => ({ id: "shared", title: `任务 ${i}` })),
  blocks: Array.from({ length: count }, (_, i) => ({
    id: `b${i}`, taskId: "shared", title: `排程 ${i}`, start: "09:00", durMin: 30,
    get date() { dateReads++; return i % 2 ? "2026-12-31" : "2026-01-01"; },
  })),
};
context.sortedItems = 0;
const scaleResult = collect("2026-06-01");
assert.ok(dateReads <= count * 4, `日期读取应随排程数线性增长，实际 ${dateReads}`);
assert.equal(scaleResult.projects[0][1].length, count);
assert.equal(scaleResult.projects[0][1].at(-1).end, "2026-12-31");
assert.ok(context.sortedItems <= count * 2,
  `项目日期统计不应重复排序排程；实际送入排序 ${context.sortedItems} 项`);
console.log(`PASS: 项目日期边界、截止优先、孤立排程、重复 ID 和输入保护；${count} 条排程读取日期 ${dateReads} 次`);
