import assert from "node:assert/strict";
import * as S from "../src/store.js";

const memory = new Map();
globalThis.localStorage = { getItem: (k) => memory.get(k), setItem: (k, v) => memory.set(k, v) };
const day = "2026-10-01", otherDay = "2026-10-02";
const count = 2000;
const blocks = Array.from({ length: count }, (_, i) => ({
  id: `owned-${i}`, taskId: "target", date: day, start: "09:00",
}));
blocks.push(...Array.from({ length: count }, (_, i) => ({
  id: `other-${i}`, taskId: null, date: otherDay, start: "10:00",
})));
S.replaceAll({ tasks: [{ id: "target", title: "Task", done: false }], blocks, settings: {}, plugins: {} });
const state = S.getState();
S.blocksOf(day);
S.blocksOf(otherDay);
const undo = S.deleteTaskUndoable("target");
assert.equal(state.blocks.length, count);
assert.equal(S.blocksOf(day).length, 0, "deletion invalidates the date cache");
S.addBlock({ id: "owned-0", taskId: null, date: otherDay, start: "11:00", title: "replacement" });

// Count existing ID reads to detect nested scans independently of machine speed.
let visits = 0;
for (const block of state.blocks) {
  const id = block.id;
  Object.defineProperty(block, "id", { enumerable: true, configurable: true, get() { visits++; return id; } });
}
let notifications = 0;
const unsubscribe = S.subscribe(() => { notifications++; });
undo();
assert.ok(visits <= count + 1, `undo must read each existing block ID at most once, got ${visits}`);
assert.equal(notifications, 1, "undo emits one notification");
assert.equal(state.tasks.length, 1);
assert.equal(state.blocks.length, count * 2);
assert.equal(state.blocks.filter((b) => b.id === "owned-0").length, 1);
assert.equal(state.blocks.find((b) => b.id === "owned-0").title, "replacement", "ID collisions preserve new data");
assert.equal(S.blocksOf(day).length, count - 1, "restored date cache is invalidated");
assert.equal(S.blocksOf(otherDay).length, count + 1);
const snapshot = JSON.stringify(state);
notifications = 0;
undo();
assert.equal(JSON.stringify(state), snapshot);
assert.equal(notifications, 0, "repeated undo is a no-op");

// Recreating the task after deletion must prevent stale snapshots from taking over.
const staleUndo = S.deleteTaskUndoable("target");
S.addTask({ id: "target", title: "recreated" });
notifications = 0;
staleUndo();
assert.equal(S.taskById("target").title, "recreated");
assert.equal(S.blocksOf(day).length, 0);
assert.equal(notifications, 0);
unsubscribe();
await S.saveNow();
await S.initStore({});
assert.equal(S.taskById("target").title, "recreated");
assert.equal(S.getState().blocks.length, count + 1, "result survives reload");
console.log("PASS: single-task undo linear scans, collision safety, cache invalidation, notifications and persistence");
