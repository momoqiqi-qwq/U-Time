// 任务截止提醒：每个任务可设置截止时刻与多级提前预警。
//
// 触达分两条腿，缺一条都不算「提醒到了」：
//   · 应用内：toast 横幅 + 提示音（Web Audio 现场合成，见 src/sound.js）
//   · 系统级：Android 原生通知 + AlarmManager（见 src/androidNotify.js）——
//     WebView 里没有 Notification API，网页定时器也不跨进程存活，
//     所以「应用被划掉之后到点还响」这件事只能交给原生闹钟。
import * as S from "./store.js";
import { toast } from "./ui.js";
import { playSound, startAlarmLoop, stopAlarmLoop, alarmRinging, DEFAULT_LOOP_SOUND_ID } from "./sound.js";
import {
  isAndroidRuntime, isDesktopRuntime, notifyStatus, askNotifyPermission, postNativeReminder,
  postDesktopReminder, cancelNativeReminder,
  setNativeRingActive, syncNativeAlarms, clearNativeAlarms, takeNativeActions,
} from "./androidNotify.js";

export const PRESET_OFFSETS = [1440, 120, 60, 30, 10, 5, 0];
/** 长鸣可选的最长响铃时长（兜底：按钮点不到时不能真的响一天）。 */
export const RING_MAX_OPTIONS = [
  { ms: 30000, label: "30 秒" },
  { ms: 60000, label: "1 分钟" },
  { ms: 120000, label: "2 分钟" },
  { ms: 300000, label: "5 分钟" },
];
const DEFAULT_RING_MAX_MS = 120000;
/** 应用不在时，到点提醒每隔多久重弹一次催办（原生闹钟侧的持续提醒）。 */
export const NAG_INTERVAL_MS = 5 * 60000;
/** 催办最多持续多久：过了就只留一条通知，不再反复弹。 */
const NAG_WINDOW_MS = 30 * 60000;
/** 往原生排多远的提醒（再远的没意义：用户会改计划，且系统会挤压超远期闹钟）。 */
const ALARM_HORIZON_MS = 14 * 86400000;
/** 与 NotificationPlugin.kt 的 MAX_SCHEDULED 对齐：超出的最远几条不排。 */
export const ALARM_MAX_COUNT = 40;

export const DEFAULT_REMINDER_SETTINGS = {
  enabled: true,
  volume: 0.75,
  sound: "beep",
  customAudio: null,
  defaultOffsets: [60, 10, 0],
  // 到点长鸣（持续提醒）：只有「已到截止时间」这一档走长鸣，提前预警仍是一声短音
  ringEnabled: true,
  ringSound: DEFAULT_LOOP_SOUND_ID,
  ringMaxMs: DEFAULT_RING_MAX_MS,
  // 后台闹钟排期（仅 Android 生效；关掉就只剩应用内提醒）
  nativeAlarm: true,
};

function cfg() {
  const st = S.getState().settings;
  st.taskReminder ??= {};
  const c = st.taskReminder;
  for (const [k, v] of Object.entries(DEFAULT_REMINDER_SETTINGS)) if (c[k] === undefined) c[k] = Array.isArray(v) ? [...v] : v;
  c.volume = Math.min(1, Math.max(0, Number(c.volume) || 0));
  c.defaultOffsets = normalizeOffsets(c.defaultOffsets);
  // 最长响铃只认预设档位：手改坏数据（0、负数、超大）会让长鸣要么立刻停要么停不下来。
  if (!RING_MAX_OPTIONS.some((o) => o.ms === Number(c.ringMaxMs))) c.ringMaxMs = DEFAULT_RING_MAX_MS;
  st.taskReminderLog ??= {};
  return c;
}

export function normalizeOffsets(input) {
  return [...new Set((Array.isArray(input) ? input : []).map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 43200).map(Math.round))].sort((a, b) => b - a);
}

export function dueAt(task) {
  if (!task?.due) return null;
  const time = /^\d{2}:\d{2}$/.test(task.dueTime || "") ? task.dueTime : "23:59";
  const d = new Date(`${task.due}T${time}:00`);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

export function taskOffsets(task) {
  if (task?.reminderEnabled === false) return [];
  const own = Array.isArray(task?.reminderOffsets) ? normalizeOffsets(task.reminderOffsets) : null;
  return own ?? cfg().defaultOffsets;
}

export function reminderLabel(offset) {
  if (offset === 0) return "已到截止时间";
  if (offset < 60) return `还有 ${offset} 分钟截止`;
  if (offset % 1440 === 0) return `还有 ${offset / 1440} 天截止`;
  if (offset % 60 === 0) return `还有 ${offset / 60} 小时截止`;
  return `还有 ${Math.floor(offset / 60)} 小时 ${offset % 60} 分钟截止`;
}

function dueReminderEvents(tasks, now = Date.now(), windowMs = 90000) {
  const out = [];
  for (const task of tasks || []) {
    if (!task || task.done || task.reminderEnabled === false) continue;
    const due = dueAt(task);
    if (!due) continue;
    for (const offset of taskOffsets(task)) {
      const at = due - offset * 60000;
      if (now >= at && now - at <= windowMs) out.push({ task, offset, at, due, key: `${task.id}:${due}:${offset}` });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * 播放提醒音。音效目录与合成逻辑在 src/sound.js（插件侧的 tide.sound 走的是同一份）。
 * @param {boolean} test 设置页的「试听」：忽略「启用提醒」开关，且音量有可听见的下限，
 *   否则用户关着提醒点试听会毫无反应、以为坏了。
 */
export async function playReminderSound(test = false) {
  const c = cfg();
  const level = test ? Math.max(c.volume, 0.3) : c.volume;
  if ((!test && !c.enabled) || level <= 0) return "silent";
  return playSound({ sound: c.sound, volume: level, customAudio: c.customAudio });
}

/**
 * 遍历所有任务的提醒时刻（不管到没到点）。
 * 到点判定、下一次唤醒时间、原生排期三处共用这一份，免得三处算出三套结果。
 */
function* reminderPoints(tasks) {
  for (const task of tasks || []) {
    if (!task || task.done || task.reminderEnabled === false) continue;
    const due = dueAt(task);
    if (!due) continue;
    for (const offset of taskOffsets(task)) {
      yield { task, offset, due, at: due - offset * 60000, key: `${task.id}:${due}:${offset}` };
    }
  }
}

/** 通知正文：只说「什么时候要做什么」，标题已经是任务名。 */
function reminderBody(task, offset) {
  return `${reminderLabel(offset)}${/^\d{2}:\d{2}$/.test(task.dueTime || "") ? ` · 截止 ${task.dueTime}` : ""}`;
}

/**
 * 提醒点 → 原生侧的记录（通知与闹钟共用一个形状）。
 * urgent（已到截止时间）才带催办：提前预警重弹只会变成骚扰。
 */
function reminderRecord(point) {
  const urgent = point.offset === 0;
  return {
    key: point.key,
    at: point.at,
    title: point.task.title,
    body: reminderBody(point.task, point.offset),
    urgent,
    repeatMs: urgent ? NAG_INTERVAL_MS : 0,
    repeatUntil: point.at + NAG_WINDOW_MS,
  };
}

/** 提醒事件的主文案（应用内横幅与通知共用）。 */
export function reminderText(ev) {
  return `${ev.task.title} · ${reminderLabel(ev.offset)}`;
}

/** 从幂等键反解出任务 id（原生按钮回传只带得回这个键）。 */
export function parseReminderKey(key) {
  const m = /^(.+):(\d+):(\d+)$/.exec(String(key || ""));
  return m ? { taskId: m[1], due: Number(m[2]), offset: Number(m[3]) } : null;
}

/**
 * 未来要响的提醒点 → 推给 Android AlarmManager 的排期列表。
 *
 * 纯函数，可单测。上限 ALARM_MAX_COUNT 与 NotificationPlugin.kt 的 MAX_SCHEDULED 一致：
 * 超出的最远几条这一轮不排，等近一点了下次数据变动自然会排上。
 */
export function upcomingAlarmPlan(tasks, now = Date.now()) {
  const c = cfg();
  if (!c.enabled || !c.nativeAlarm) return [];
  return [...reminderPoints(tasks)]
    .filter((p) => p.at > now && p.at - now <= ALARM_HORIZON_MS)
    .sort((a, b) => a.at - b.at)
    .slice(0, ALARM_MAX_COUNT)
    .map(reminderRecord);
}

let lastPlanSignature = "";
/** 整份重推排期（内容没变就不碰原生，避免每次输入都跨进程刷一遍闹钟）。 */
async function syncNativePlan() {
  if (!isAndroidRuntime()) return;
  const plan = upcomingAlarmPlan(S.getState().tasks);
  const signature = JSON.stringify(plan);
  if (signature === lastPlanSignature) return;
  lastPlanSignature = signature;
  if (!plan.length) await clearNativeAlarms();
  else await syncNativeAlarms(plan);
}

/* ───────────── 长鸣（持续提醒） ───────────── */

let ring = null;

/**
 * 开始长鸣。三条停止路径，缺一不可：
 * ① 应用内横幅上的「停止响铃」；② 原生通知上的同名按钮（经 [drainNativeActions] 转回来）；
 * ③ 到 ringMaxMs 自动停 —— 通知被折叠、系统静音、人在开车都点不到按钮，
 *    没有上限就是一只关不掉的闹钟。
 *
 * 一次只响一条：新的到点事件会先把旧的换掉（而不是叠着响），
 * 否则两条长鸣交叠起来用户既听不清也关不掉。
 */
function startRing(ev, c = cfg()) {
  stopRing({ silent: true });
  const banner = toast(reminderText(ev), {
    ms: 0,
    class: "alarm",
    actionLabel: "停止响铃",
    action: () => stopRing(),
  });
  startAlarmLoop({ sound: c.ringSound, volume: c.volume, customAudio: c.customAudio });
  // 告诉原生别在退后台时冻结页面定时器（见 MainActivity.onPause），并把这条升级成常驻通知
  setNativeRingActive(true);
  if (isAndroidRuntime()) postNativeReminder(reminderRecord(ev));
  else if (isDesktopRuntime()) postDesktopReminder(reminderRecord(ev));
  const maxMs = Math.max(5000, Number(c.ringMaxMs) || DEFAULT_RING_MAX_MS);
  ring = { ev, banner, maxTimer: setTimeout(() => stopRing(), maxMs), poll: setInterval(() => { drainNativeActions(); }, 1000) };
}

/**
 * 停止长鸣并收尾。
 * @param {boolean} silent true = 不补一条「已停止」回执横幅（内部换条重响时用）
 */
function stopRing({ silent = false } = {}) {
  const current = ring;
  ring = null;
  if (!current) return false;
  clearTimeout(current.maxTimer);
  clearInterval(current.poll);
  stopAlarmLoop();
  setNativeRingActive(false);
  current.banner?.close();
  // 常驻通知滑不掉，必须就地降级成一条可滑走的普通通知（静默：刚按停止又响一声像坏了）。
  // 不直接撤掉是留给用户回看「刚才到底到点了什么」。
  postNativeReminder({ ...reminderRecord(current.ev), urgent: false, repeatMs: 0, at: Date.now() }, { silent: true });
  if (!silent) toast(`已停止「${current.ev.task.title}」的响铃，任务还留着`);
  return true;
}

/** 当前是否正在长鸣。 */
export function ringActive() {
  return !!ring || alarmRinging();
}

/**
 * 设置页「试听长鸣」：响几秒自动停。
 * 真长鸣正在进行时直接返回 —— 试听不该把正在催办的那条掐掉。
 */
export async function previewRingSound(ms = 3000) {
  const c = cfg();
  if (ring) return "ringing";
  startAlarmLoop({ sound: c.ringSound, volume: Math.max(c.volume, 0.3), customAudio: c.customAudio });
  await new Promise((r) => setTimeout(r, ms));
  stopAlarmLoop();
  return "done";
}

/**
 * 取回用户在原生通知按钮上点过的动作并执行。
 *
 * 点击很可能发生在应用被杀之后，所以队列存在 SharedPreferences 里，
 * 这里每次醒过来（巡检、回前台、长鸣轮询）清一次。
 */
export async function drainNativeActions() {
  if (!isAndroidRuntime()) return 0;
  const items = await takeNativeActions();
  let handled = 0;
  for (const item of items) {
    const parsed = parseReminderKey(item.key);
    if (!parsed) continue;
    handled++;
    if (ring?.ev.key === item.key) stopRing({ silent: true });
    if (item.action === "done") {
      const task = S.taskById(parsed.taskId);
      if (task && !task.done) {
        S.updateTask(task.id, { done: true });
        toast(`已标记完成：${task.title}`);
      }
      cancelNativeReminder(item.key);
    }
  }
  if (handled) S.persistSoon();
  return handled;
}

function notifyEvent(ev) {
  const c = cfg();
  const text = reminderText(ev);
  toast(text);
  // 只有「已到截止时间」这一档走长鸣；提前预警仍旧是一声短音。
  if (ev.offset === 0 && c.ringEnabled) {
    startRing(ev, c);
  } else {
    playReminderSound();
    if (isAndroidRuntime()) postNativeReminder(reminderRecord(ev));
    else if (isDesktopRuntime()) postDesktopReminder(reminderRecord(ev));
    else if ("Notification" in window && Notification.permission === "granted") {
      // 桌面浏览器调试才走得到：Tauri（WebView2 与 Android WebView）都不实现 Notification API。
      try { new Notification("U-Time · 任务提醒", { body: text }); } catch {}
    }
  }
}

/**
 * 设置页的端到端测试入口：应用内横幅、提示音和当前平台系统通知各走一遍。
 * 用提前预警档而不是到点档，避免测试时触发持续长鸣。
 */
export async function testTaskReminder() {
  const now = Date.now();
  const ev = {
    task: { id: "notification-test", title: "测试任务提醒", dueTime: "" },
    offset: 5,
    at: now,
    due: now + 5 * 60000,
    key: `notification-test:${now}:5`,
  };
  toast("测试任务提醒 · 这是应用内右下角横幅");
  await playReminderSound(true);
  if (isAndroidRuntime()) return postNativeReminder(reminderRecord(ev));
  if (isDesktopRuntime()) return postDesktopReminder(reminderRecord(ev));
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification("U-Time · 测试任务提醒", { body: reminderBody(ev.task, ev.offset) });
      return { applied: true, platform: "browser" };
    } catch {}
  }
  return { applied: false, reason: "当前环境不支持系统通知" };
}

let timer = null;
function nextReminderDelay(tasks, now = Date.now()) {
  let next = Infinity;
  for (const p of reminderPoints(tasks)) {
    if (p.at > now && p.at < next) next = p.at;
  }
  // 没有临近提醒时最多每 5 分钟巡检一次；有提醒则精准唤醒。
  return Number.isFinite(next) ? Math.max(1000, Math.min(300000, next - now)) : 300000;
}
export function initTaskReminders() {
  cfg();
  let disposed = false;
  const schedule = (delay) => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, delay);
  };
  const tick = () => {
    if (disposed) return;
    const c = cfg();
    const now = Date.now();
    drainNativeActions();
    if (c.enabled) {
      const log = S.getState().settings.taskReminderLog;
      let dirty = false;
      for (const ev of dueReminderEvents(S.getState().tasks, now)) {
        if (log[ev.key]) continue;
        log[ev.key] = now; dirty = true;
        notifyEvent(ev);
      }
      const cutoff = now - 90 * 86400000;
      for (const [k, t] of Object.entries(log)) if (Number(t) < cutoff) { delete log[k]; dirty = true; }
      if (dirty) S.persistSoon();
    }
    syncNativePlan();
    schedule(nextReminderDelay(S.getState().tasks, now));
  };
  const onVisibility = () => { if (!document.hidden) { if (timer) clearTimeout(timer); tick(); } };
  const unsub = S.subscribe(() => schedule(250));
  document.addEventListener("visibilitychange", onVisibility);
  // Android 上没给通知权限时提一次去开启：没有权限，原生通知与闹钟全都是哑的，
  // 而这件事用户在设置页里看不到任何异常（应用内提醒照常响，很容易以为已经提醒过了）。
  if (isAndroidRuntime()) {
    notifyStatus().then((st) => {
      if (!disposed && st.supported && !st.granted) {
        toast("任务提醒还需要「通知」权限，开启后才能进下拉栏", {
          ms: 9000, actionLabel: "去开启", action: () => askNotifyPermission(),
        });
      }
    });
  }
  tick();
  return () => {
    disposed = true;
    if (timer) clearTimeout(timer); timer = null;
    stopRing({ silent: true });
    unsub();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
