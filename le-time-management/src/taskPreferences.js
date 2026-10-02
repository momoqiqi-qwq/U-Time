// 只提供新建默认值；已有任务与调用方的显式选择不受影响。
export const DEFAULT_TASK_PREFERENCES = Object.freeze({
  defaultQuad: 1,
  defaultEstMin: 30,
  defaultDueTime: "23:59",
  defaultReminderEnabled: true,
  autoScheduleStart: "07:00",
  blankBlockMin: 30,
  blankBlockCategory: "rest",
});

const CATEGORIES = new Set(["work", "study", "sport", "life", "rest"]);
const validTime = (value) => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
function duration(value, fallback) {
  if (value === null || value === "" || typeof value === "boolean") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(15, Math.min(1440, Math.round(n))) : fallback;
}

export function normalizeTaskPreferences(raw = {}) {
  const next = { ...DEFAULT_TASK_PREFERENCES, ...(raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) };
  const quad = Number(next.defaultQuad);
  next.defaultQuad = Number.isInteger(quad) && quad >= 1 && quad <= 4 ? quad : DEFAULT_TASK_PREFERENCES.defaultQuad;
  next.defaultEstMin = duration(next.defaultEstMin, DEFAULT_TASK_PREFERENCES.defaultEstMin);
  next.blankBlockMin = duration(next.blankBlockMin, DEFAULT_TASK_PREFERENCES.blankBlockMin);
  for (const key of ["defaultDueTime", "autoScheduleStart"]) if (!validTime(next[key])) next[key] = DEFAULT_TASK_PREFERENCES[key];
  next.defaultReminderEnabled = next.defaultReminderEnabled !== false;
  if (!CATEGORIES.has(next.blankBlockCategory)) next.blankBlockCategory = DEFAULT_TASK_PREFERENCES.blankBlockCategory;
  return next;
}

export function getTaskPreferences(settings = {}) {
  return normalizeTaskPreferences(settings?.taskDefaults);
}
