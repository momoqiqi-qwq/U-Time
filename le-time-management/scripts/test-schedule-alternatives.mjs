import assert from "node:assert/strict";
import { conflictsFor, findAlternatives, hhmmOf, previewSchedule } from "../src/scheduleConflict.js";

const options = { dayStart: 480, dayEnd: 720, step: 15, limit: 4 };
const blocks = [
  { id: "late", start: "10:00", durMin: 60 },
  { id: "nested", start: "09:15", durMin: 15 },
  { id: "early", start: "09:00", durMin: 60 },
  { id: "overlap", start: "10:30", durMin: 30 },
];
const snapshot = structuredClone(blocks);
const proposal = { startMin: 570, durMin: 30 };
assert.deepEqual(findAlternatives(blocks, proposal, options).map((b) => b.start),
  ["08:30", "08:15", "11:00", "08:00"], "候选保留原距离顺序，同距优先之后的时段");
assert.deepEqual(blocks, snapshot, "排序和合并占用区间不能改动源数组或时间块");
assert.deepEqual(conflictsFor(blocks, proposal).map((b) => b.id), ["early"],
  "冲突列表仍保留原始时间块和输入顺序");
assert.equal(previewSchedule(blocks, proposal, options).conflicts[0], blocks[2]);
assert.deepEqual(findAlternatives([{ id: "self", start: "09:00", durMin: 60 }], proposal,
  { ...options, ignoreId: "self", limit: 1 }).map((b) => b.start), ["09:30"]);
assert.deepEqual(findAlternatives(blocks, { startMin: 570, durMin: 300 }, options), [],
  "时长超过日程窗口时没有候选");
assert.deepEqual(findAlternatives(null, { startMin: 563, durMin: 30 }, { ...options, limit: 3 })
  .map((b) => b.start), ["09:30", "09:45", "09:15"], "非网格时间保持既有四舍五入顺序");
assert.equal(findAlternatives([{ startMin: NaN, durMin: 30 }], proposal, { ...options, limit: 1 })[0].start,
  "09:30", "无效区间不产生伪冲突");

// 用穷举全部网格再按距离排序的独立参照，检查边界、重叠、忽略自身及候选数量。
let seed = 20261026;
const random = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
for (let run = 0; run < 120; run++) {
  const items = Array.from({ length: random(40) }, (_, i) => ({
    id: `b${i}`, startMin: 420 + random(48) * 15, durMin: (random(8) + 1) * 15,
  }));
  const p = { startMin: 420 + random(48) * 15, durMin: (random(8) + 1) * 15 };
  const opts = { dayStart: 480, dayEnd: 1080, step: 15, limit: 1 + random(8), ignoreId: `b${random(40)}` };
  const desired = Math.max(opts.dayStart, Math.min(p.startMin, opts.dayEnd - p.durMin));
  const expected = [];
  for (let start = opts.dayStart; start + p.durMin <= opts.dayEnd; start += opts.step) {
    if (items.every((b) => b.id === opts.ignoreId || start >= b.startMin + b.durMin || start + p.durMin <= b.startMin)) {
      expected.push(start);
    }
  }
  expected.sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired) || b - a);
  assert.deepEqual(findAlternatives(items, p, opts), expected.slice(0, opts.limit)
    .map((startMin) => ({ startMin, start: hhmmOf(startMin), durMin: p.durMin })), `穷举参照 ${run}`);
}

// 一天排满时仍只解析每个时间块一次；不用机器耗时作为性能断言。
let reads = 0;
const crowded = Array.from({ length: 1500 }, (_, i) => ({
  id: `busy${i}`, get start() { reads++; return "00:00"; }, durMin: 1440,
}));
assert.deepEqual(findAlternatives(crowded, { start: "12:00", durMin: 30 }), []);
assert.equal(reads, crowded.length, "候选扫描不能逐候选重新解析全量时间块");
console.log("PASS: 排程候选顺序、边界、输入保护、120 组穷举参照与单次区间解析");
