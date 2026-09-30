// Android 原生通知与后台闹钟的桥接层。
//
// 这一层**只管通道**：知道「是不是 Android」「命令怎么发」「失败怎么兜底」，
// 完全不知道任务、截止、提前量这些概念 —— 那些在 src/taskReminder.js。
// 反过来 taskReminder.js 也不碰任何 Android 细节，两边靠「提醒事件」这一份数据对上。
//
// 为什么要单独一层：纯浏览器调试必须能安全空转。Android 继续走 Kotlin 通知与
// AlarmManager；桌面 Tauri 的即时通知走同一个 Rust 命令，但不参与 Android 排期。
import { api } from "./api.js";

/** 是否需要原生通知（只有 Android APK：桌面走 WebView2，浏览器走 localStorage 调试）。 */
export function isAndroidRuntime() {
  if (!api.isTauri) return false;
  return /Android/i.test(String(typeof navigator !== "undefined" ? navigator.userAgent : ""));
}

/** Windows / macOS / Linux Tauri 壳。当前主要消费方是 Windows 任务系统弹窗。 */
export function isDesktopRuntime() {
  return Boolean(api.isTauri) && !isAndroidRuntime();
}

const OFF = { applied: false, reason: "非 Android 平台不使用原生通知" };

/** 原生命令统一出口：非 Android 直接空转，异常一律吞成 {applied:false, error}。 */
async function call(action, payload) {
  if (!isAndroidRuntime()) return { ...OFF };
  try {
    const r = await api.notification(action, payload);
    return r && typeof r === "object" ? r : { applied: true, raw: r };
  } catch (e) {
    // 原生桥缺失（旧 APK 升级上来、或 gen/android 被 init 重建过丢了 Kotlin）时
    // 绝不能把调用方一起打断：提醒的兜底路径永远是应用内 toast。
    return { applied: false, error: String(e?.message || e) };
  }
}

/** 通知授权与排期状态。设置页与每次同步前都读它，所以顺手把渠道创建也做了。 */
export async function notifyStatus() {
  if (!isAndroidRuntime()) return { ...OFF, supported: false, granted: false, exact: false };
  const r = await call("status");
  return { ...r, supported: true, granted: !!r.granted, exact: !!r.exact };
}

/** 弹 Android 13+ 的通知授权框。用户拒过第二次系统不再弹，只能走 openNotifySettings。 */
export async function askNotifyPermission() {
  const r = await call("askPermission");
  return { ...r, granted: !!r.granted };
}

export function openNotifySettings() {
  return call("openSettings");
}

/** 「允许精确闹钟」授权页。没这个授权时后台提醒会退化成 Doze 维护窗口才醒（晚几分钟）。 */
export function openExactAlarmSettings() {
  return call("openExactAlarmSettings");
}

/**
 * 把未来要响的提醒点整份推给原生 AlarmManager。
 * @param {Array<{key:string,at:number,title:string,body:string,urgent:boolean,repeatMs:number,repeatUntil:number}>} records
 */
export function syncNativeAlarms(records) {
  return call("syncAlarms", { alarms: Array.isArray(records) ? records : [] });
}

export function clearNativeAlarms() {
  return call("clearAlarms");
}

/**
 * 立刻弹（或就地升级）一条通知。urgent 的那条会带「停止响铃 / 标记完成」两个按钮且滑不掉。
 * @param {{silent?:boolean}} opts silent = 更新时不出声：刚点完「停止响铃」又响一声，
 *   在用户眼里等于停止按钮没生效。
 */
export function postNativeReminder(record, { silent = false } = {}) {
  return call("post", { ...record, silent: !!silent });
}

/**
 * 桌面即时系统通知。桌面端没有 AlarmManager，只在网页巡检命中提醒点时调用。
 * Rust 侧负责把它送进 Windows 通知中心；异常吞掉后仍保留应用内横幅与声音。
 */
export async function postDesktopReminder(record) {
  if (!isDesktopRuntime()) return { ...OFF };
  try {
    const r = await api.notification("post", record || {});
    return r && typeof r === "object" ? r : { applied: true, raw: r };
  } catch (e) {
    return { applied: false, error: String(e?.message || e) };
  }
}

export function cancelNativeReminder(key) {
  return call("cancel", { key });
}

/**
 * 告诉原生「网页正在长鸣 / 已经停了」。
 *
 * 唯一作用：MainActivity.onPause 据此决定要不要立刻 WebView.onResume()。
 * WebView 一暂停就挂起页面定时器，长鸣的自动停 watchdog 会一起被冻住。
 */
export function setNativeRingActive(active) {
  return call("setRing", { active: !!active });
}

/**
 * 取回用户在通知按钮上点过的动作（`[{key, action}]`，取完即在原生侧清空）。
 *
 * 点击可能发生在应用被杀之后，所以原生把队列落在 SharedPreferences 里，
 * 这里取回来交给 taskReminder 真正执行（改任务状态、停 Web Audio 循环）。
 */
export async function takeNativeActions() {
  const r = await call("takeActions");
  return Array.isArray(r.actions) ? r.actions : [];
}
