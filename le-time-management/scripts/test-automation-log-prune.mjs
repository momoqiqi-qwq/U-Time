// 自动化日志的撤销快照：只给最近 LOG_UNDO_KEEP 条保留整份副本；截止任务排程只在真正排进去后才拍快照。
import assert from "node:assert/strict";

const memory = new Map();
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: (k) => memory.delete(k),
};

const S = await import("../src/store.js");
const A = await import("../src/automation.js");

// 1) 裁剪：前 N 条保留 before，其余置 null，日志条目本身不删
const logs = Array.from({ length: A.LOG_UNDO_KEEP + 3 }, (_, i) => ({ id: `l${i}`, before: { tasks: [] } }));
A.pruneLogSnapshots(logs);
assert.equal(logs.length, A.LOG_UNDO_KEEP + 3);
assert.ok(logs.slice(0, A.LOG_UNDO_KEEP).every((l) => l.before), "最近几条保留撤销快照");
assert.ok(logs.slice(A.LOG_UNDO_KEEP).every((l) => l.before === null), "更早的日志去掉整份快照");

// 2) 截止任务自动排程：排进去的那条日志带的是排程前的时间块，撤销后新块消失、原有块保留
await S.initStore({ tasks: [], blocks: [], settings: {}, plugins: {} });
const tomorrow = S.addDays(S.todayStr(), 1);
S.addBlock({ id: "keep", date: S.addDays(S.todayStr(), 30), start: "08:00", durMin: 30, title: "原有安排" });
S.addTask({ id: "due", title: "交报告", due: tomorrow, estMin: 30 });
await A.runAutomation("change");
const placed = S.getState().blocks.filter((b) => b.taskId === "due");
assert.equal(placed.length, 1, "截止任务被自动排进时间块");
const row = A.getLogs().find((l) => l.rule === "deadline-auto-schedule");
assert.ok(row?.before, "排程日志带撤销快照");
assert.deepEqual(row.before.blocks.map((b) => b.id), ["keep"], "快照是排程之前的时间块");
assert.notEqual(row.before.blocks[0], S.getState().blocks.find((b) => b.id === "keep"), "快照是深拷贝，不与当前数据共享对象");
await A.undoLog(row.id);
assert.deepEqual(S.getState().blocks.map((b) => b.id), ["keep"], "撤销后只剩原有安排");

// 3) 排不进去（当天全满）时不产生日志
const before = A.getLogs().length;
S.replaceAll({ tasks: [], blocks: [{ id: "full", date: tomorrow, start: "00:00", durMin: 1440, title: "占满" }], settings: {}, plugins: {}, automation: S.getState().automation });
for (let i = 0; i <= 3; i++) {
  const date = S.addDays(S.todayStr(), i);
  if (date !== tomorrow) S.addBlock({ date, start: "00:00", durMin: 1440, title: "占满" });
}
S.addTask({ id: "nope", title: "排不下", due: tomorrow, estMin: 30 });
await A.runAutomation("change");
assert.equal(S.getState().blocks.filter((b) => b.taskId === "nope").length, 0);
assert.equal(A.getLogs().length, before, "排不进去时不写排程日志");

console.log("PASS automation log prune");
