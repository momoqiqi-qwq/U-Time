// 数据体检（v0.111.0）：扫描与修复「导入残留 / 历史 bug / 手改数据文件」造成的数据问题。
// 设计：analyze / repairPlan 是**纯函数**（输入数组、输出报告/新数组，不改入参）——
// 测试不需要 stub localStorage 或 DOM；scanHealth / repairHealth 只是 store 上的薄封装。
// 修复永远是「先建恢复点再动手」（调用方负责，与导入/恢复的既有安全网一致）。

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD 且是真实存在的日历日期（拦 2024-02-31 这类）。 */
function isRealDate(s) {
  if (!DATE_RE.test(String(s || ""))) return false;
  const d = new Date(`${s}T00:00:00`);
  return !Number.isNaN(d.getTime()) && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` === s;
}

/** 扫描：返回 issue 列表（每类一条，含数量与说明）。只报告，不改数据。 */
export function analyze(tasks = [], blocks = [], now = Date.now()) {
  const issues = [];
  const taskIds = new Set(tasks.map((t) => t.id));
  const orphanBlocks = blocks.filter((b) => b.taskId && !taskIds.has(b.taskId));
  if (orphanBlocks.length) {
    issues.push({ kind: "orphan", count: orphanBlocks.length, label: "孤儿时间块",
      detail: "引用的任务已不存在（常见于导入合并或异常退出）", fixable: true });
  }
  const dupIds = (arr) => {
    const seen = new Set(), dups = new Set();
    for (const x of arr) { if (seen.has(x.id)) dups.add(x.id); seen.add(x.id); }
    return dups;
  };
  const dupCount = dupIds(tasks).size + dupIds(blocks).size;
  if (dupCount) {
    issues.push({ kind: "dup", count: dupCount, label: "重复编号",
      detail: "任务/时间块存在重复 id（会互相覆盖、撤销串位）", fixable: true });
  }
  const stale = tasks.filter((t) => t.isNew && Number(t.createdAt) < now - 30 * DAY_MS);
  if (stale.length) {
    issues.push({ kind: "stale-new", count: stale.length, label: "超期 NEW 标记",
      detail: "标记「新」超过 30 天仍未查看", fixable: true });
  }
  const badDates = blocks.filter((b) => !isRealDate(b.date));
  if (badDates.length) {
    issues.push({ kind: "bad-date", count: badDates.length, label: "非法日期时间块",
      detail: "日期缺失或不是真实日期（不会显示在任何一天）", fixable: true });
  }
  return { issues, checked: { tasks: tasks.length, blocks: blocks.length } };
}

/** 修复计划：返回**新的**任务/时间块数组与逐类修复计数；不做任何 IO。
 *  原则：宁可保守 —— 无法确定归属的数据删除而不是猜（删除有恢复点兜底）。 */
export function repairPlan(tasks = [], blocks = [], now = Date.now()) {
  const fixed = [];
  // ① 非法日期块：直接移除
  const keptBlocksA = blocks.filter((b) => isRealDate(b.date));
  const removedBadDate = blocks.length - keptBlocksA.length;
  if (removedBadDate) fixed.push({ kind: "bad-date", count: removedBadDate });
  // ② 重复 id：首个保留、后续重新编号（数据不删）；时间块的 taskId 重定向到首个。
  const seenTask = new Map(); // 原始 id → 首个保留 id
  let seq = 0, dupFixed = 0;
  const tasksA = tasks.map((t) => {
    if (!seenTask.has(t.id)) { seenTask.set(t.id, t.id); return t; }
    dupFixed++;
    return { ...t, id: `t_fix${now.toString(36)}${seq++}` };
  });
  const seenBlockSet = new Set();
  const blocksA = keptBlocksA.map((b) => {
    let nb = b;
    if (seenBlockSet.has(b.id)) { nb = { ...b, id: `b_fix${now.toString(36)}${seq++}` }; dupFixed++; }
    else seenBlockSet.add(b.id);
    if (nb.taskId && seenTask.has(nb.taskId) && seenTask.get(nb.taskId) !== nb.taskId) {
      nb = { ...nb, taskId: seenTask.get(nb.taskId) };
    }
    return nb;
  });
  if (dupFixed) fixed.push({ kind: "dup", count: dupFixed });
  // ③ 孤儿时间块：任务集合定稿后再筛
  const ids = new Set(tasksA.map((t) => t.id));
  const keptBlocks = blocksA.filter((b) => !b.taskId || ids.has(b.taskId));
  const removedOrphan = blocksA.length - keptBlocks.length;
  if (removedOrphan) fixed.push({ kind: "orphan", count: removedOrphan });
  // ④ 超期 NEW：摘标记
  let staleFixed = 0;
  const tasksC = tasksA.map((t) => {
    if (t.isNew && Number(t.createdAt) < now - 30 * DAY_MS) { staleFixed++; const { isNew, ...rest } = t; return rest; }
    return t;
  });
  if (staleFixed) fixed.push({ kind: "stale-new", count: staleFixed });
  return { tasks: tasksC, blocks: keptBlocks, fixed };
}

import * as S from "./store.js";

/** 扫描当前库。 */
export function scanHealth() {
  const st = S.getState();
  return analyze(st.tasks, st.blocks);
}

/** 应用修复计划（调用方必须已建恢复点）。返回逐类修复计数。 */
export async function repairHealth() {
  const st = S.getState();
  const plan = repairPlan(st.tasks, st.blocks);
  st.tasks.splice(0, st.tasks.length, ...plan.tasks);
  st.blocks.splice(0, st.blocks.length, ...plan.blocks);
  await S.saveNow();
  return plan.fixed;
}
