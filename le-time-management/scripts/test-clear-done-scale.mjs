import assert from "node:assert/strict";
import * as S from "../src/store.js";

const memory = new Map();
globalThis.localStorage = { getItem: (k) => memory.get(k), setItem: (k, v) => memory.set(k, v) };
const day = "2026-10-01", otherDay = "2026-10-02";
const tasks = Array.from({ length: 2000 }, (_, i) => ({ id: `t${i}`, done: i % 2 === 0, title: `Task ${i}` }));
const blocks = tasks.map((t) => ({ id: `b${t.id}`, taskId: t.id, date: day, start: "09:00" }));
blocks.push({ id: "independent", taskId: null, date: otherDay, start: "10:00" });
S.replaceAll({ tasks, blocks, settings: {}, plugins: {} });
const state = S.getState();
S.blocksOf(day);
S.blocksOf(otherDay);
// Count visits rather than wall-clock time: deterministic even on busy CI hosts.
let visits = 0;
for (const block of state.blocks) {
  const taskId = block.taskId;
  Object.defineProperty(block, "taskId", { enumerable: true, configurable: true, get() { visits++; return taskId; } });
}
let notifications = 0;
const unsubscribe = S.subscribe(() => { notifications++; });
const undo = S.deleteDoneTasksUndoable();
assert.equal(state.tasks.length, 1000);
assert.equal(state.blocks.length, 1001);
assert.ok(visits <= blocks.length * 4, `bulk delete must scan blocks a bounded number of times, got ${visits}`);
assert.equal(notifications, 1, "deletion notifies synchronously exactly once");
assert.equal(S.blocksOf(day).length, 1000, "affected date cache invalidated");
assert.deepEqual(S.blocksOf(otherDay).map((b) => b.id), ["independent"]);
// A replacement task must keep its new data and must not regain the deleted schedule.
S.addTask({ id: "t0", title: "replacement" });
// A block ID reused by another task must not be overwritten by undo.
S.addBlock({ id: "bt2", taskId: "t1", date: day, start: "11:00" });
notifications = 0;
undo();
assert.equal(notifications, 1);
assert.equal(state.tasks.length, 2000);
assert.equal(S.taskById("t0").title, "replacement");
assert.ok(!state.blocks.some((b) => b.id === "bt0"));
assert.equal(state.blocks.filter((b) => b.id === "bt2").length, 1);
assert.equal(state.blocks.find((b) => b.id === "bt2").taskId, "t1");
assert.equal(S.blocksOf(day).length, 1999);
assert.deepEqual(state.tasks.slice(0, 3).map((t) => t.id), ["t2", "t4", "t6"], "snapshot task order preserved");
const snapshot = JSON.stringify(state);
notifications = 0;
undo();
assert.equal(JSON.stringify(state), snapshot);
assert.equal(notifications, 0, "repeated undo is a no-op");
unsubscribe();
await S.saveNow();
await S.initStore({});
assert.equal(S.getState().tasks.length, 2000, "result survives reload");
console.log("PASS: bulk cleanup linear scans, notification count, cache invalidation, collision-safe undo and persistence");
