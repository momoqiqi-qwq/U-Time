import assert from "node:assert/strict";
import { analyze, repairPlan } from "../src/dataHealth.js";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const T = (id, extra = {}) => ({ id, title: `任务${id}`, createdAt: NOW - DAY, ...extra });
const B = (id, date, taskId = "", extra = {}) => ({ id, date, start: "09:00", durMin: 30, title: `块${id}`, taskId, ...extra });

// ── 干净数据：零问题 ──
{
  const tasks = [T("t1"), T("t2", { isNew: true, createdAt: NOW - DAY })];
  const blocks = [B("b1", "2026-09-27", "t1")];
  const { issues } = analyze(tasks, blocks, NOW);
  assert.equal(issues.length, 0, "干净数据不应报任何问题");
}

// ── 四类问题都能检出 ──
{
  const tasks = [T("t1"), T("t1"), T("t2", { isNew: true, createdAt: NOW - 31 * DAY })];
  const blocks = [B("b1", "2026-09-27", "t1"), B("b2", "2026-09-27", "ghost"), B("b3", "2024-02-31"), B("b4", "")];
  const { issues } = analyze(tasks, blocks, NOW);
  const by = Object.fromEntries(issues.map((x) => [x.kind, x]));
  assert.equal(by.orphan?.count, 1, "孤儿块应检出 1（taskId=ghost）");
  assert.equal(by.dup?.count, 1, "重复 id 应检出 1 组");
  assert.equal(by["stale-new"]?.count, 1, "超期 NEW 应检出 1");
  assert.equal(by["bad-date"]?.count, 2, "非法日期应检出 2（02-31 与空）");
}

// ── analyze 不改入参 ──
{
  const tasks = [T("t1")];
  const blocks = [B("b1", "2026-09-27", "ghost")];
  analyze(tasks, blocks, NOW);
  assert.equal(blocks.length, 1, "analyze 不许动入参");
}

// ── 修复计划：孤儿删除 / 重复重编号并重定向 / NEW 摘除 / 非法日期剔除 ──
{
  const tasks = [T("t1", { note: "保留我" }), T("t1", { note: "重复我" }), T("t2", { isNew: true, createdAt: NOW - 40 * DAY })];
  const blocks = [B("b1", "2026-09-27", "t1"), B("b2", "2026-09-27", "ghost"), B("b3", "2024-02-31", "t1")];
  const plan = repairPlan(tasks, blocks, NOW);
  assert.equal(plan.tasks.length, 3, "重复任务重编号而不是删除（3 条都保留）");
  const ids = plan.tasks.map((t) => t.id);
  assert.equal(new Set(ids).size, 3, "修复后 id 唯一");
  assert.ok(plan.tasks.some((t) => t.note === "重复我"), "重复条目保留（给了新 id）");
  // 时间块的 taskId 仍指向「首个保留任务」
  const b1 = plan.blocks.find((b) => b.title === "块b1");
  assert.equal(b1.taskId, plan.tasks.find((t) => t.note === "保留我").id, "块引用重定向到首个任务");
  assert.equal(plan.blocks.some((b) => b.title === "块b2"), false, "孤儿块被移除");
  assert.equal(plan.blocks.some((b) => b.title === "块b3"), false, "非法日期块被移除");
  assert.equal(plan.tasks.find((t) => t.id === "t2")?.isNew, undefined, "超期 NEW 被摘除");
  const kinds = plan.fixed.map((f) => f.kind).sort().join(",");
  assert.equal(kinds, "bad-date,dup,orphan,stale-new", "修复计数四类齐全");
  // 修复后再扫：干净
  const { issues } = analyze(plan.tasks, plan.blocks, NOW);
  assert.equal(issues.length, 0, "修复后的数据再次体检应为零问题");
}

// ── 修复计划不改入参 ──
{
  const tasks = [T("t1")];
  const blocks = [B("b1", "2026-09-27", "ghost")];
  repairPlan(tasks, blocks, NOW);
  assert.equal(blocks.length, 1, "repairPlan 不许动入参");
}

console.log("PASS: 数据体检 —— 孤儿块/重复id/超期NEW/非法日期的检出与修复（纯函数行为面，修复后再扫为零问题）");
