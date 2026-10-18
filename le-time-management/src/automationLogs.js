// 自动化日志的撤销快照上限 —— automation.js 与 aiAutomation.js 共用，单独成模块是为了不让两者循环依赖。
//
// 每份 before 都是整个任务 / 时间块 / 收件箱的副本，所以要从两头限住：
//   · 条数：只有最近 LOG_UNDO_KEEP 条保留快照。120 条全留会让 data.json 涨到数 MB，每次自动保存都整份重写；
//     而且撤销一条很早的记录会把之后所有手动修改一起抹掉，本来就不该放开。
//   · 单条体积：任务里带 base64 附件时，一份快照就有几十万字节（v0.247 实测单条 853 KB），超过
//     LOG_SNAPSHOT_MAX 的不留快照，界面上这条记录就不显示「撤销」。
export const LOG_UNDO_KEEP = 5;
export const LOG_SNAPSHOT_MAX = 256 * 1024;

/** 体积在上限内就原样返回，否则返回 null（这条日志不可撤销）。 */
export function snapshotWithinLimit(before) {
  if (!before) return null;
  try { return JSON.stringify(before).length <= LOG_SNAPSHOT_MAX ? before : null; }
  catch { return null; }
}

/**
 * 原地裁剪并返回同一个数组：第 LOG_UNDO_KEEP 条之后的快照置 null（日志条目本身不删）；
 * checkSize 为 true 时连保留的几条也按体积再筛一遍 —— 只在接手旧数据时做，平时写日志只需要裁条数。
 */
export function pruneLogSnapshots(logs, { checkSize = false } = {}) {
  if (!Array.isArray(logs)) return logs;
  for (let i = 0; i < logs.length; i++) {
    const row = logs[i];
    if (row?.before && (i >= LOG_UNDO_KEEP || (checkSize && !snapshotWithinLimit(row.before)))) row.before = null;
  }
  return logs;
}
