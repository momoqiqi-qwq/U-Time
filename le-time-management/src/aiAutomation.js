import * as S from "./store.js";
import { api } from "./api.js";

const clone = (x) => structuredClone(x);
const MAX_AI_RULES = 30;
const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

/**
 * 合法分类 id，直接取自 `store.js` 的 `CATEGORIES`。
 *
 * ⚠️ 这里曾经手抄过一份白名单，抄成了 `["work","study","life","exercise","rest"]` ——
 * 应用里**没有** `exercise` 这个分类（真实 id 是 `sport`）。后果是 AI 生成的时间块
 * 拿到一个没有 `--cat-*` 变量的分类，渲染出来没有配色、`catLabel` 直接回显 id，
 * 而且全程不报错。别再手抄，用事实源。
 */
const CAT_IDS = new Set(S.CATEGORIES.map((c) => c.id));

function automationState() {
  const st = S.getState();
  st.automation ??= {};
  st.automation.aiRules ??= [];
  st.automation.logs ??= [];
  return st.automation;
}

function cleanTime(v) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || "")) ? String(v) : "09:00";
}

function cleanDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "";
}

function normalizeWeekdays(raw) {
  const out = [...new Set((Array.isArray(raw) ? raw : []).map(Number).filter((n) => n >= 0 && n <= 6))].sort((a, b) => a - b);
  return out.length ? out : [1, 2, 3, 4, 5];
}

export function normalizeAiRule(raw = {}) {
  const type = ["daily", "weekdays", "weekly", "once"].includes(raw.schedule?.type) ? raw.schedule.type : "daily";
  const now = new Date();
  return {
    id: String(raw.id || S.uid("ai-rule")),
    name: String(raw.name || "AI 自动任务").slice(0, 80),
    enabled: raw.enabled !== false,
    instruction: String(raw.instruction || "").slice(0, 6000),
    schedule: {
      type,
      time: cleanTime(raw.schedule?.time || "09:00"),
      date: cleanDate(raw.schedule?.date || S.todayStr()),
      weekdays: normalizeWeekdays(raw.schedule?.weekdays),
      weekday: Math.max(0, Math.min(6, Number(raw.schedule?.weekday ?? now.getDay()))),
    },
    createdAt: Number(raw.createdAt) || Date.now(),
    lastRunKey: String(raw.lastRunKey || ""),
    lastRunAt: Number(raw.lastRunAt) || 0,
    lastResult: String(raw.lastResult || "").slice(0, 1200),
    lastError: String(raw.lastError || "").slice(0, 1200),
    nextRetryAt: Number(raw.nextRetryAt) || 0,
  };
}

export function getAiAutomationRules() {
  const a = automationState();
  a.aiRules = a.aiRules.map(normalizeAiRule).slice(0, MAX_AI_RULES);
  return a.aiRules;
}

export function saveAiAutomationRule(raw) {
  const list = getAiAutomationRules();
  const next = normalizeAiRule(raw);
  const i = list.findIndex((x) => x.id === next.id);
  if (i >= 0) list[i] = next;
  else {
    if (list.length >= MAX_AI_RULES) throw new Error(`最多可创建 ${MAX_AI_RULES} 个 AI 自动任务`);
    list.unshift(next);
  }
  S.touch();
  return next;
}

export function deleteAiAutomationRule(id) {
  const a = automationState();
  const before = a.aiRules.length;
  a.aiRules = a.aiRules.filter((x) => x.id !== id);
  if (a.aiRules.length !== before) S.touch();
}

export function setAiAutomationEnabled(id, enabled) {
  const r = getAiAutomationRules().find((x) => x.id === id);
  if (!r) return;
  r.enabled = !!enabled;
  r.lastError = "";
  r.nextRetryAt = 0;
  S.touch();
}

export function aiScheduleLabel(rule) {
  const s = normalizeAiRule(rule).schedule;
  if (s.type === "once") return `${s.date} ${s.time} · 仅一次`;
  if (s.type === "weekly") return `每周${WEEKDAY_NAMES[s.weekday]} ${s.time}`;
  if (s.type === "weekdays") return `周${s.weekdays.map((x) => WEEKDAY_NAMES[x]).join("、")} ${s.time}`;
  return `每天 ${s.time}`;
}

/**
 * 从模型回复里抠出 JSON。
 *
 * 导出给 `aiIngest.js` 共用 —— 两家解析器（定时任务 / 内容解析）面对的是同一批
 * 「不听话的模型」，有的裹 ```json 围栏、有的前面加一句「好的，这是结果：」，
 * 两处各写一份迟早会分叉。
 */
export function extractJson(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("AI 没有返回内容");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || raw;
  try { return JSON.parse(candidate); } catch {}
  const a = candidate.indexOf("{");
  const b = candidate.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(candidate.slice(a, b + 1));
  throw new Error("AI 返回内容不是可解析的 JSON");
}

export async function aiPlanAutomation(text) {
  const prompt = String(text || "").trim();
  if (!prompt) throw new Error("先描述你想让 AI 什么时候做什么");
  const now = new Date();
  const system = `你是时间管理应用里的“自动任务计划器”。当前本地时间：${now.toLocaleString("zh-CN")}。
把用户自然语言转换为一个自动任务定义，只返回 JSON，不要 Markdown。
JSON 格式：{"name":"简短名称","instruction":"执行时让 AI 做什么","schedule":{"type":"daily|weekdays|weekly|once","time":"HH:MM","date":"YYYY-MM-DD","weekday":0-6,"weekdays":[0-6]}}。
规则：daily=每天；weekdays=指定多个星期；weekly=每周单日；once=仅执行一次。星期日=0，星期一=1。
只负责时间管理应用内的任务、时间块、收件箱整理。禁止设计任何本地文件读取/写入/删除、命令执行或任意脚本行为。`;
  const content = await api.aiChat([
    { role: "system", content: system },
    { role: "user", content: prompt },
  ], 0.1);
  const parsed = extractJson(content);
  return normalizeAiRule({
    name: parsed.name,
    instruction: parsed.instruction || prompt,
    schedule: parsed.schedule || {},
  });
}

function compactContext() {
  const st = S.getState();
  const today = S.todayStr();
  const end = S.addDays(today, 14);
  const tasks = (st.tasks || []).slice(0, 100).map((t) => ({
    id: t.id,
    title: t.title,
    done: !!t.done,
    quad: Number(t.quad) || 1,
    estMin: Number(t.estMin) || 30,
    due: t.due || null,
    dueTime: t.dueTime || null,
    tags: Array.isArray(t.tags) ? t.tags.slice(0, 8) : [],
    project: t.project || "",
  }));
  const blocks = (st.blocks || []).filter((b) => b.date >= today && b.date <= end).slice(0, 160).map((b) => ({
    id: b.id,
    date: b.date,
    start: b.start,
    durMin: b.durMin,
    title: b.title,
    taskId: b.taskId || null,
    cat: b.cat || "work",
  }));
  const inbox = (st.inbox || []).filter((x) => x.status !== "done").slice(0, 30).map((x) => ({
    id: x.id,
    title: x.title,
    source: x.source,
    when: x.when || null,
  }));
  return { now: new Date().toISOString(), today, tasks, blocks, inbox };
}

function opSystemPrompt(rule) {
  return `你是 U-Time 的 AI 自动任务执行器。请根据用户自动任务和当前应用数据，生成允许的操作。
你没有、也绝不能请求任何本地文件权限；不能读取、写入、删除本地文件；不能执行 shell/系统命令；不能打开插件文件；不能自行访问其他网络资源。你唯一能做的是返回下面白名单中的 JSON 操作，由应用审核后执行。
只返回 JSON：{"summary":"一句话结果","operations":[...]}
允许 operations：
1) {"type":"create_task","title":"...","due":"YYYY-MM-DD|null","dueTime":"HH:MM|null","quad":1-4,"estMin":分钟,"tags":["..."]}
2) {"type":"update_task","id":"现有任务ID","patch":{"title":"可选","done":true|false,"due":"YYYY-MM-DD|null","dueTime":"HH:MM|null","quad":1-4,"estMin":分钟}}
3) {"type":"create_timeblock","date":"YYYY-MM-DD","start":"HH:MM","durMin":分钟,"title":"...","taskId":"可选现有任务ID|null","cat":"${[...CAT_IDS].join("|")}"}
4) {"type":"add_inbox","title":"...","when":"YYYY-MM-DD|null","note":"..."}
最多返回 12 个操作。不要返回文件路径、脚本、URL 请求或未列出的操作。自动任务名称：${rule.name}`;
}

function validDateOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function validTimeOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null;
}

function beforeSnapshot() {
  const st = S.getState();
  return { tasks: clone(st.tasks || []), blocks: clone(st.blocks || []), inbox: clone(st.inbox || []) };
}

function addAutomationLog(rule, message, before = null) {
  const a = automationState();
  a.logs.unshift({ id: S.uid("log"), at: Date.now(), rule: `ai:${rule.id}`, message, before });
  a.logs = a.logs.slice(0, 120);
}

function applyOperations(rule, operations) {
  const ops = Array.isArray(operations) ? operations.slice(0, 12) : [];
  const st = S.getState();
  const before = beforeSnapshot();
  let applied = 0;
  let skipped = 0;

  for (const op of ops) {
    if (!op || typeof op !== "object") { skipped++; continue; }
    try {
      if (op.type === "create_task") {
        const title = String(op.title || "").trim().slice(0, 160);
        if (!title) { skipped++; continue; }
        S.addTask({
          title,
          due: validDateOrNull(op.due),
          dueTime: validTimeOrNull(op.dueTime) || "23:59",
          quad: Math.max(1, Math.min(4, Number(op.quad) || 2)),
          estMin: Math.max(5, Math.min(1440, Math.round(Number(op.estMin) || 30))),
          tags: Array.isArray(op.tags) ? op.tags.map((x) => String(x).slice(0, 30)).slice(0, 8) : ["AI"],
        });
        applied++;
      } else if (op.type === "update_task") {
        const task = st.tasks.find((x) => x.id === String(op.id || ""));
        if (!task) { skipped++; continue; }
        const src = op.patch && typeof op.patch === "object" ? op.patch : {};
        const patch = {};
        if (typeof src.title === "string" && src.title.trim()) patch.title = src.title.trim().slice(0, 160);
        if (typeof src.done === "boolean") patch.done = src.done;
        if (src.due === null || validDateOrNull(src.due)) patch.due = validDateOrNull(src.due);
        if (src.dueTime === null || validTimeOrNull(src.dueTime)) patch.dueTime = validTimeOrNull(src.dueTime) || "23:59";
        if (src.quad !== undefined) patch.quad = Math.max(1, Math.min(4, Number(src.quad) || task.quad || 2));
        if (src.estMin !== undefined) patch.estMin = Math.max(5, Math.min(1440, Math.round(Number(src.estMin) || task.estMin || 30)));
        if (!Object.keys(patch).length) { skipped++; continue; }
        S.updateTask(task.id, patch);
        applied++;
      } else if (op.type === "create_timeblock") {
        const date = validDateOrNull(op.date);
        const start = validTimeOrNull(op.start);
        const title = String(op.title || "").trim().slice(0, 160);
        const durMin = Math.max(5, Math.min(720, Math.round(Number(op.durMin) || 30)));
        if (!date || !start || !title) { skipped++; continue; }
        const startMin = S.mmOf(start);
        const conflict = S.blocksOf(date).some((b) => startMin < S.mmOf(b.start) + Number(b.durMin || 0) && startMin + durMin > S.mmOf(b.start));
        if (conflict) {
          st.inbox ??= [];
          st.inbox.unshift({ id: S.uid("in"), status: "new", createdAt: Date.now(), source: "AI自动任务", title: `排程冲突：${title}`, when: date, note: `${start} · ${durMin} 分钟，未自动覆盖已有时间块。` });
          skipped++;
          continue;
        }
        const taskId = op.taskId && st.tasks.some((x) => x.id === op.taskId) ? op.taskId : null;
        S.addBlock({ date, start, durMin, title, taskId, cat: CAT_IDS.has(op.cat) ? op.cat : "work" });
        applied++;
      } else if (op.type === "add_inbox") {
        const title = String(op.title || "").trim().slice(0, 160);
        if (!title) { skipped++; continue; }
        st.inbox ??= [];
        st.inbox.unshift({ id: S.uid("in"), status: "new", createdAt: Date.now(), source: "AI自动任务", title, when: validDateOrNull(op.when), note: String(op.note || "").slice(0, 1000) });
        S.touch();
        applied++;
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }
  return { applied, skipped, before };
}

function cycleKey(rule, now = new Date()) {
  const s = rule.schedule;
  const date = S.fmtDate(now);
  if (s.type === "once") return `${s.date}@${s.time}`;
  if (s.type === "weekly") return `${date}@weekly-${s.weekday}`;
  return `${date}@${s.type}`;
}

function isDue(rule, now = new Date()) {
  if (!rule.enabled) return false;
  if (rule.nextRetryAt && Date.now() < rule.nextRetryAt) return false;
  const s = rule.schedule;
  const date = S.fmtDate(now);
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (s.type === "once") {
    if (!s.date) return false;
    if (`${date} ${hhmm}` < `${s.date} ${s.time}`) return false;
  } else {
    if (hhmm < s.time) return false;
    if (s.type === "weekdays" && !s.weekdays.includes(now.getDay())) return false;
    if (s.type === "weekly" && Number(s.weekday) !== now.getDay()) return false;
  }
  return rule.lastRunKey !== cycleKey(rule, now);
}

export async function runAiAutomationRule(id, { force = false } = {}) {
  const rule = getAiAutomationRules().find((x) => x.id === id);
  if (!rule) throw new Error("AI 自动任务不存在");
  if (!force && !isDue(rule)) return { skipped: true };
  if (!rule.instruction.trim()) throw new Error("自动任务没有执行说明");
  const context = compactContext();
  try {
    const content = await api.aiChat([
      { role: "system", content: opSystemPrompt(rule) },
      { role: "user", content: `自动任务要求：\n${rule.instruction}\n\n当前时间管理数据（仅应用内任务/时间块/收件箱，不含任何本地文件）：\n${JSON.stringify(context)}` },
    ], 0.15);
    const parsed = extractJson(content);
    const result = applyOperations(rule, parsed.operations);
    if (!force) rule.lastRunKey = cycleKey(rule);
    rule.lastRunAt = Date.now();
    rule.lastResult = String(parsed.summary || `执行了 ${result.applied} 项操作`).slice(0, 1200);
    rule.lastError = "";
    rule.nextRetryAt = 0;
    if (rule.schedule.type === "once" && !force) rule.enabled = false;
    addAutomationLog(rule, `AI 自动任务「${rule.name}」：${rule.lastResult}（执行 ${result.applied}，跳过 ${result.skipped}）`, result.before);
    S.touch();
    return { ...result, summary: rule.lastResult };
  } catch (err) {
    rule.lastError = String(err?.message || err).slice(0, 1200);
    rule.nextRetryAt = Date.now() + 10 * 60 * 1000;
    addAutomationLog(rule, `AI 自动任务「${rule.name}」失败：${rule.lastError}`);
    S.touch();
    throw err;
  }
}

let dueRunner = null;
export async function runDueAiAutomations() {
  if (dueRunner) return dueRunner;
  dueRunner = (async () => {
    const due = getAiAutomationRules().filter((r) => isDue(r)).slice(0, 5);
    const results = [];
    for (const rule of due) {
      try { results.push(await runAiAutomationRule(rule.id)); }
      catch (error) { results.push({ error: String(error?.message || error), id: rule.id }); }
    }
    return results;
  })();
  try { return await dueRunner; } finally { dueRunner = null; }
}
