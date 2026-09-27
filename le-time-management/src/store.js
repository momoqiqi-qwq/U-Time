// 全局状态 + 持久化 + 派生数据
import { api } from "./api.js";
import { migrateState } from "./migrations.js";

let state = null;
const subs = new Set();
let saveTimer = null;
let saveFail = 0;
let saveChain = Promise.resolve();
let batchDepth = 0;
let batchDirty = false;
const blockIndexByDate = new Map();

export function uid(p = "id") {
  return `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/* ── 日期工具 ── */
export function fmtDate(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
export function todayStr() { return fmtDate(new Date()); }
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d + n);
  return fmtDate(dt);
}
export function weekdayCN(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return "日一二三四五六"[new Date(y, m - 1, d).getDay()];
}
export function mmOf(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
export function hhmmOf(min) {
  min = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
export function durLabel(m) {
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h} 小时`;
}

/* ── 初始化 / 结构归一化 ── */
export function normalizeState(raw = {}) {
  const next = raw && typeof raw === "object" ? raw : {};
  next.tasks = Array.isArray(next.tasks) ? next.tasks : [];
  next.blocks = Array.isArray(next.blocks) ? next.blocks : [];
  next.settings = next.settings && typeof next.settings === "object" && !Array.isArray(next.settings) ? next.settings : {};
  // 自定义背景已移除（v0.55.0）：这个键里可能压着几百 KB 的 base64 图片，留着只会白占备份体积。
  // 删在归一化处而不是写一次性迁移，是因为它同时覆盖「打开本地数据」与「导入旧备份」两条路径，
  // 而且幂等 —— 归一化每次加载都跑，删一个本来就不存在的键没有任何副作用。
  delete next.settings.background;
  next.plugins = next.plugins && typeof next.plugins === "object" && !Array.isArray(next.plugins) ? next.plugins : {};
  next.inbox = Array.isArray(next.inbox) ? next.inbox : [];
  next.automation = next.automation && typeof next.automation === "object" && !Array.isArray(next.automation) ? next.automation : {};
  return next;
}
function invalidateBlockIndex(dateStr = null) {
  if (dateStr) blockIndexByDate.delete(dateStr);
  else blockIndexByDate.clear();
}
export async function initStore(seed) {
  let loaded;
  try {
    loaded = await api.loadData();
  } catch {
    loaded = seed;
  }
  // 迁移放在 try 之外：数据来自更新版本时要显式报错，而不是静默换成种子数据
  state = normalizeState(migrateState(loaded));
  invalidateBlockIndex();
  // 归一化剥掉 settings.background 只改了内存里的对象；不主动写一次的话，那份 base64 图片
  // 会一直躺在数据文件里，直到用户下次改点什么才顺手落盘。导入路径（replaceAll）自带 changed()，
  // 只有启动这条路径需要补这一下。
  if (loaded && typeof loaded === "object" && loaded.settings && "background" in loaded.settings) {
    queueSave().catch(() => {});
  }
  return state;
}
export function getState() { return state; }
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
function queueSave() {
  saveChain = saveChain.catch(() => {}).then(() => api.saveData(state));
  return saveChain.then(() => { saveFail = 0; }).catch((e) => { if (++saveFail === 1) console.error("保存失败", e); throw e; });
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { queueSave().catch(() => {}); }, 350);
}
function emitChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("tide:state-changed"));
  subs.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
}
function changed() {
  if (batchDepth > 0) { batchDirty = true; return; }
  emitChanged();
  scheduleSave();
}
// 仅请求持久化，不触发界面刷新/自动化。适合滑块、导航位置等高频设置。
export function persistSoon() { scheduleSave(); }
export function touch() { changed(); }
// 批量修改期间合并刷新与写盘，避免循环中每条记录都触发一次全局更新。
export async function batchChanges(fn) {
  batchDepth++;
  try { return await fn(); }
  finally {
    batchDepth--;
    if (batchDepth === 0 && batchDirty) {
      batchDirty = false;
      emitChanged();
      scheduleSave();
    }
  }
}

/* ── 任务 ── */
export function addTask(patch) {
  const t = {
    id: uid("t"), title: "新任务", note: "", quad: 1, done: false, estMin: 30,
    tags: [], project: "", due: null, dueTime: "23:59", reminderEnabled: true, reminderOffsets: null,
    createdAt: Date.now(), isNew: true, ...patch,
  };
  state.tasks.unshift(t); changed(); return t;
}
export function updateTask(id, patch) {
  const t = state.tasks.find((x) => x.id === id);
  if (t) {
    Object.assign(t, patch);
    if (patch.title !== undefined) state.blocks.filter((b) => b.taskId === id).forEach((b) => { b.title = t.title; });
    changed();
  }
  return t;
}
export function removeTask(id) {
  const i = state.tasks.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const [t] = state.tasks.splice(i, 1);
  const affectedDates = new Set(state.blocks.filter((b) => b.taskId === id).map((b) => b.date));
  state.blocks = state.blocks.filter((b) => b.taskId !== id);
  affectedDates.forEach(invalidateBlockIndex);
  changed(); return t;
}
export function toggleTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (t) { t.done = !t.done; changed(); }
  return t;
}

export function markTaskSeen(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (t?.isNew) { t.isNew = false; changed(); }
  return t;
}

// 删除与撤销作为一个操作，完整保留关联排程。
export function deleteTaskUndoable(id) {
  const task = taskById(id);
  if (!task) return null;
  const snapshot = structuredClone({ task, blocks: state.blocks.filter((b) => b.taskId === id) });
  removeTask(id);
  return () => {
    if (taskById(id)) return;
    state.tasks.unshift(snapshot.task);
    state.blocks.push(...snapshot.blocks.filter((b) => !state.blocks.some((x) => x.id === b.id)));
    snapshot.blocks.forEach((b) => invalidateBlockIndex(b.date));
    changed();
  };
}

// 一键清理已完成任务。整批走 batchChanges：一次刷新 + 一次写盘，而不是 N 条任务各触发一遍。
// 撤销按「任务 + 它自己的排程」成对放回，且只恢复已经不存在的条目，避免覆盖用户事后重建的任务。
export function deleteDoneTasksUndoable() {
  const done = state.tasks.filter((t) => t.done);
  if (!done.length) return null;
  const snapshot = structuredClone(done.map((t) => ({
    task: t,
    blocks: state.blocks.filter((b) => b.taskId === t.id),
  })));
  batchChanges(() => { done.forEach((t) => removeTask(t.id)); });
  return () => {
    const tasks = [], blocks = [];
    for (const entry of snapshot) {
      if (taskById(entry.task.id)) continue;
      tasks.push(entry.task);
      blocks.push(...entry.blocks.filter((b) => !state.blocks.some((x) => x.id === b.id)));
    }
    if (!tasks.length) return;
    state.tasks.unshift(...tasks);
    state.blocks.push(...blocks);
    blocks.forEach((b) => invalidateBlockIndex(b.date));
    changed();
  };
}

export function placeTask(t, date, startMin = null, cat = "work") {
  const dur = Math.max(15, Number(t.estMin) || 30);
  const busy = blocksOf(date).filter((b) => !t.id || b.taskId !== t.id);
  let cursor = startMin ?? 420;
  if (startMin === null) {
    for (const b of busy) {
      const start = mmOf(b.start), end = start + b.durMin;
      if (end <= cursor) continue;
      if (start - cursor >= dur) break;
      cursor = Math.max(cursor, end);
    }
  }
  if (!Number.isFinite(cursor) || cursor < 0 || cursor + dur > 1440) throw new Error("这一天没有足够的空闲时间");
  if (busy.some((b) => cursor < mmOf(b.start) + b.durMin && cursor + dur > mmOf(b.start))) throw new Error("这个时段已有安排，请选择空闲时段");
  // 验证成功后再替换所选日期的安排，保留其他日期的记录。
  if (t.id) {
    state.blocks = state.blocks.filter((b) => b.taskId !== t.id || b.date !== date);
    invalidateBlockIndex(date);
  }
  return addBlock({ date, start: hhmmOf(cursor), durMin: dur, title: t.title, taskId: t.id || null, cat });
}

/* ── 时间块 ── */
export function blocksOf(dateStr) {
  const cached = blockIndexByDate.get(dateStr);
  if (cached) return cached.slice();
  const blocks = state.blocks.filter((b) => b.date === dateStr).sort((a, b) => mmOf(a.start) - mmOf(b.start));
  blockIndexByDate.set(dateStr, blocks);
  return blocks.slice();
}
export function addBlock(patch) {
  const b = {
    id: uid("b"), date: todayStr(), start: "09:00", durMin: 30, title: "新时间块",
    taskId: null, cat: "work", createdAt: Date.now(), isNew: true, ...patch,
  };
  state.blocks.push(b); invalidateBlockIndex(b.date); changed(); return b;
}
export function updateBlock(id, patch) {
  const b = state.blocks.find((x) => x.id === id);
  if (b) {
    const oldDate = b.date;
    const orderChanged = patch.start !== undefined && patch.start !== b.start;
    Object.assign(b, patch);
    if (oldDate !== b.date) {
      invalidateBlockIndex(oldDate);
      invalidateBlockIndex(b.date);
    } else if (orderChanged) invalidateBlockIndex(b.date);
    changed();
  }
  return b;
}
export function removeBlock(id) {
  const i = state.blocks.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const [b] = state.blocks.splice(i, 1); invalidateBlockIndex(b.date); changed(); return b;
}

export function markBlockSeen(id) {
  const b = state.blocks.find((x) => x.id === id);
  if (b?.isNew) { b.isNew = false; changed(); }
  return b;
}

/* ── 派生：某天的任务池（未安排且未完成） ── */
export function poolOf(dateStr) {
  const scheduled = new Set(blocksOf(dateStr).map((b) => b.taskId).filter(Boolean));
  return state.tasks.filter((t) => !t.done && !scheduled.has(t.id));
}
export function taskById(id) { return state.tasks.find((t) => t.id === id); }

/* ── 象限取任务 ── */
// v0.52.0 拖拽排序：显式 order 优先（无 order 兜底 Infinity → 落回原 due 规则），
// done 仍是最外层分组键（完成的永远沉底），order 只在「同象限 + 同完成态」内生效。
export function tasksOfQuad(q) {
  return state.tasks
    .filter((t) => t.quad === q)
    .sort((a, b) => Number(a.done) - Number(b.done) ||
      ((a.order ?? Infinity) - (b.order ?? Infinity)) ||
      (a.due || "9999").localeCompare(b.due || "9999"));
}

// 拖拽落点：把 dragId 的任务移到 overId 的前/后。
// 懒回填：本象限同完成态首次拖拽时才给整组写 order（0..n-1），老数据无感、无迁移。
// 只允许同象限 + 同完成态之间换位，跨组调用是 no-op（完成沉底语义不破坏）。
export function moveTaskRelative(dragId, overId, before = true) {
  if (!dragId || dragId === overId) return;
  const drag = state.tasks.find((t) => t.id === dragId);
  const over = overId ? state.tasks.find((t) => t.id === overId) : null;
  if (!drag || (overId && !over)) return;
  if (over && (over.quad !== drag.quad || over.done !== drag.done)) return;
  const group = state.tasks.filter((t) => t.quad === drag.quad && t.done === drag.done);
  // seq 排序键必须与 tasksOfQuad 完全一致（done→order→due，无尾键、稳定排序保持数组序）：
  // 首次回填 order 的基准 = 渲染序，否则「插到相邻卡前面」在 DOM 序与 store 序里落点不同
  // （实测探针抓到：createdAt 尾键让回填基准与 DOM 错位，拖拽落点跳位）
  const seq = group.sort((a, b) => Number(a.done) - Number(b.done) ||
    ((a.order ?? Infinity) - (b.order ?? Infinity)) ||
    (a.due || "9999").localeCompare(b.due || "9999"));
  seq.forEach((t, i) => { t.order = i; });
  const rest = seq.filter((t) => t.id !== dragId);
  const at = over ? rest.findIndex((t) => t.id === overId) : rest.length;
  if (at < 0) return;
  rest.splice(before ? at : at + 1, 0, drag);
  rest.forEach((t, i) => { t.order = i; });
  changed();
}

// 跨象限拖放：保留任务的完成态，并按落点插入目标象限的同完成态分组。
// overId 为 null 表示落在该分组末尾；与本象限拖放一样回填 order，不影响另一完成态分组。
export function moveTaskToQuad(dragId, targetQuad, overId = null, before = true) {
  const drag = state.tasks.find((t) => t.id === dragId);
  const quad = Number(targetQuad);
  if (!drag || !Number.isInteger(quad) || quad < 1 || quad > 4) return drag || null;
  if (quad === drag.quad) {
    if (overId) moveTaskRelative(dragId, overId, before);
    return drag;
  }
  const over = overId ? state.tasks.find((t) => t.id === overId) : null;
  if (overId && (!over || over.quad !== quad || over.done !== drag.done)) return drag;
  const seq = state.tasks
    .filter((t) => t.quad === quad && t.done === drag.done)
    .sort((a, b) => ((a.order ?? Infinity) - (b.order ?? Infinity)) ||
      (a.due || "9999").localeCompare(b.due || "9999"));
  seq.forEach((t, i) => { t.order = i; });
  const at = over ? seq.findIndex((t) => t.id === overId) : seq.length;
  if (at < 0) return drag;
  drag.quad = quad;
  seq.splice(before ? at : at + 1, 0, drag);
  seq.forEach((t, i) => { t.order = i; });
  changed();
  return drag;
}

/* ── 插件状态 ── */
export function pluginState(id) {
  if (!state.plugins[id]) state.plugins[id] = { enabled: true, storage: {} };
  state.plugins[id].storage ??= {};
  return state.plugins[id];
}
export function setPluginEnabled(id, on) {
  pluginState(id).enabled = on; changed();
}
export function removePluginState(id) {
  if (state.plugins[id]) {
    delete state.plugins[id];
    changed();
  }
}
export function replaceAll(next) {
  state = normalizeState(migrateState(next));
  invalidateBlockIndex();
  changed();
}
export function saveNow() {
  clearTimeout(saveTimer);
  return queueSave();
}

export const CATEGORIES = [
  { id: "work", label: "工作" },
  { id: "study", label: "学习" },
  { id: "sport", label: "运动" },
  { id: "life", label: "生活" },
  { id: "rest", label: "休息" },
];
export function catLabel(c) { return (CATEGORIES.find((x) => x.id === c) || {}).label || c; }
