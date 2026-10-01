package com.yile.letime

import android.app.Activity
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject

/**
 * 通知与闹钟的 Tauri 桥 —— 让「任务提醒」真正到达 Android 下拉栏，而不只是应用内一条 toast。
 *
 * ## 为什么必须自己写，而不用 window.Notification
 *
 * Android WebView **不实现 Web Notifications API**，`window.Notification` 根本不存在
 * （桌面端 WebView2 同样没有；仓库里 `taskReminder.js` 那句
 * `if ("Notification" in window && ...)` 在 APK 上永远是死分支）。
 * 也没有现成的 Tauri 官方通知插件可用：本项目只依赖 `tauri-plugin-opener`，
 * 引一个新 crate 要把 npm + cargo + capabilities 三处一起动，而我们要的
 * 「渠道 + 常驻 + 按钮回传 + 精确闹钟排期」它一个都不覆盖。所以走仓库既有的
 * 原生桥路线（与 [SystemBarPlugin] / [ApkInstallerPlugin] 同一套五层接线）。
 *
 * ## 参数一律用 org.json 手解，不用 parseArgs
 *
 * `Invoke.parseArgs` 走 Jackson，标量够用，但 `List<自定义类>` 依赖 Jackson 的 Kotlin
 * 泛型推断 —— 这一层在本仓库没有先例，也没有编译期以外的验证手段。
 * 数组类参数（闹钟列表、按钮队列）改从 `invoke.getArgs()`（就是个 JSONObject）手解，
 * 行为完全可预测，写错也只在本地就能看出来。
 */
@TauriPlugin(
  permissions = [
    Permission(strings = ["android.permission.POST_NOTIFICATIONS"], alias = "notifications")
  ]
)
class NotificationPlugin(private val host: Activity) : Plugin(host) {
  private val permissionPrefs get() = host.getSharedPreferences("letime-notification-permission", Context.MODE_PRIVATE)

  private fun runtimeGranted(): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
    host.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

  private fun argsOf(invoke: Invoke): JSObject = try {
    invoke.getArgs()
  } catch (_: Exception) {
    JSObject()
  }

  /** 一条排期记录：{key,title,body,at,urgent,repeatMs,repeatUntil}。 */
  private fun recordOf(obj: JSONObject): ReminderRecord? {
    val key = obj.optString("key")
    if (key.isEmpty()) return null
    return ReminderRecord(
      key = key,
      title = obj.optString("title", "任务提醒"),
      body = obj.optString("body"),
      at = obj.optLong("at", System.currentTimeMillis()),
      urgent = obj.optBoolean("urgent", false),
      repeatMs = obj.optLong("repeatMs", 0L),
      repeatUntil = obj.optLong("repeatUntil", 0L),
    )
  }

  /* ───────────── 状态与授权 ───────────── */

  /**
   * 前端每次进设置页、以及启动后调一次。顺带把两条通知渠道建出来
   * （渠道是懒建的，但用户想看「授权状态」时不该等到第一条提醒才建）。
   */
  @Command
  fun status(invoke: Invoke) {
    ReminderHub.ensureChannels(host)
    invoke.resolve(
      JSObject().apply {
        put("platform", "android")
        put("api", Build.VERSION.SDK_INT)
        put("granted", ReminderHub.notificationsEnabled(host))
        put("permissionAsked", permissionPrefs.getBoolean("asked", false))
        put("canRequest", Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !runtimeGranted())
        put("exact", ReminderHub.canScheduleExact(host))
        put("scheduled", ReminderHub.loadAlarms(host).size)
        put("ringing", ReminderHub.ringActive)
      }
    )
  }

  /**
   * 申请 Android 13+ 的通知权限。13 以下没有运行时权限这一说，直接回当前状态。
   *
   * 系统弹窗一次都没点、或选了「禁止」时，[permissionDone] 仍会回调 —— 那时
   * granted=false，前端负责把「去系统通知设置里打开」的入口亮出来（第二次弹窗
   * 系统可能不再给，这是 Android 的规矩，不是本插件的 bug）。
   */
  @Command
  fun askPermission(invoke: Invoke) {
    if (runtimeGranted()) {
      return resolvePermission(invoke)
    }
    permissionPrefs.edit().putBoolean("asked", true).apply()
    requestPermissionForAliases(arrayOf("notifications"), invoke, "permissionDone")
  }

  @PermissionCallback
  fun permissionDone(invoke: Invoke) {
    resolvePermission(invoke)
  }

  private fun resolvePermission(invoke: Invoke) {
    invoke.resolve(
      JSObject().apply {
        put("granted", ReminderHub.notificationsEnabled(host))
        put("api", Build.VERSION.SDK_INT)
      }
    )
  }

  /** 跳「本应用的通知设置」页（Android 8 以下退到应用详情页）。 */
  @Command
  fun openSettings(invoke: Invoke) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      openPage(
        invoke, "通知设置",
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, host.packageName)
      )
    } else {
      openPage(invoke, "应用详情", packageDetailIntent())
    }
  }

  /**
   * 跳「允许精确闹钟」授权页。
   *
   * 没这个授权时 [ReminderHub.schedule] 退化成 `setAndAllowWhileIdle`：Doze 深睡后
   * 最坏晚几分钟才响。对「还有 10 分钟截止」这类提醒可以接受，对到点长鸣不行，
   * 所以前端要把这个状态显式亮出来引导用户开。
   */
  @Command
  fun openExactAlarmSettings(invoke: Invoke) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      return invoke.resolve(JSObject().apply { put("opened", false); put("reason", "当前系统不需要单独授权精确闹钟") })
    }
    openPage(
      invoke, "精确闹钟",
      Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${host.packageName}"))
    )
  }

  private fun packageDetailIntent(): Intent =
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${host.packageName}"))

  private fun openPage(invoke: Invoke, label: String, intent: Intent) {
    host.runOnUiThread {
      try {
        host.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        invoke.resolve(JSObject().apply { put("opened", true); put("page", label) })
      } catch (error: Exception) {
        // 国产 ROM 精简掉系统设置页是真实存在的场景：退到应用详情页再试一次，
        // 那里至少能关掉/打开通知总开关。
        try {
          host.startActivity(packageDetailIntent().addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
          invoke.resolve(JSObject().apply { put("opened", true); put("page", "应用详情（$label 页不可用）") })
        } catch (_: Exception) {
          invoke.reject("打不开「$label」页面：${error.message}")
        }
      }
    }
  }

  /* ───────────── 通知 ───────────── */

  /**
   * 立刻弹一条通知。应用活着时网页用它把原生闹钟弹的那条**就地升级**成常驻版
   * （同一个 key ⇒ 同一个通知 id，不会多出第二条），
   * 也用它把常驻那条降级回可滑走的普通通知（带 silent=true）。
   */
  @Command
  fun post(invoke: Invoke) {
    val a = argsOf(invoke)
    val rec = recordOf(a) ?: return invoke.reject("缺少通知标识 key")
    val posted = ReminderHub.postReminder(host, rec, silent = a.optBoolean("silent", false), taskActions = a.optBoolean("taskActions", true))
    invoke.resolve(JSObject().apply {
      put("posted", posted); put("applied", posted); put("key", rec.key); put("ongoing", rec.urgent)
      if (!posted) put("reason", "通知未发送：请检查系统通知权限及通知渠道")
    })
  }

  /** 撤掉一条通知（网页处理完提醒后收尾用）。 */
  @Command
  fun cancel(invoke: Invoke) {
    val key = argsOf(invoke).getString("key", "") ?: ""
    if (key.isEmpty()) return invoke.reject("缺少通知标识 key")
    ReminderHub.cancel(host, key)
    invoke.resolve(JSObject().apply { put("cancelled", true) })
  }

  /**
   * 告诉原生「网页这边正在长鸣 / 已经停了」。
   *
   * 唯一作用是 MainActivity.onPause 判断要不要立刻把 WebView 拉回 running：
   * `WebView.onPause()` 会挂起页面定时器，长鸣的循环调度与自动停 watchdog 全在
   * 定时器上，冻住就等于响到一半静掉。
   */
  @Command
  fun setRing(invoke: Invoke) {
    ReminderHub.ringActive = argsOf(invoke).getBoolean("active", false)
    invoke.resolve(JSObject().apply { put("active", ReminderHub.ringActive) })
  }

  /* ───────────── 闹钟排期 ───────────── */

  /**
   * 整份重推排期。前端是事实源：每次任务数据变化后重算一遍未来要响的提醒点推过来，
   * 原生只负责「撤干净 + 按这份列表重排」。
   *
   * 为什么不做增量：增量要处理「前端删了任务、原生还留着旧闹钟」的对账，
   * 而整份重排天然幂等，列表条数又只有几十条，代价可以忽略。
   */
  @Command
  fun syncAlarms(invoke: Invoke) {
    val arr = argsOf(invoke).optJSONArray("alarms") ?: JSONArray()
    val records = (0 until arr.length())
      .mapNotNull { i -> arr.optJSONObject(i)?.let { recordOf(it) } }
      .sortedBy { it.at }
      .take(MAX_SCHEDULED)
    ReminderHub.rescheduleAll(host, records)
    invoke.resolve(
      JSObject().apply {
        put("scheduled", records.size)
        put("exact", ReminderHub.canScheduleExact(host))
        // 被上限截掉的条数：前端可以据此提示「排得太满，只保留了最近的 N 条」
        put("dropped", (arr.length() - records.size).coerceAtLeast(0))
      }
    )
  }

  /** 撤掉全部排期（用户在设置里关掉提醒总开关时用）。 */
  @Command
  fun clearAlarms(invoke: Invoke) {
    ReminderHub.rescheduleAll(host, emptyList())
    invoke.resolve(JSObject().apply { put("cleared", true) })
  }

  /**
   * 取走用户在通知按钮上点过的动作并清空队列。
   *
   * 前端在每次巡检与回到前台时调；点击可能发生在应用被杀之后，所以队列落在
   * SharedPreferences 而不是内存里（见 [ReminderHub.pushAction]）。
   */
  @Command
  fun takeActions(invoke: Invoke) {
    val pending = ReminderHub.drainActions(host)
    val out = JSONArray()
    for (item in pending) {
      out.put(JSONObject().put("key", item.key).put("action", item.action))
    }
    invoke.resolve(JSObject().apply { put("actions", out) })
  }

  private companion object {
    /**
     * 排期上限。系统对 PendingIntent 数量没有硬上限，但 Doze 会挤压非精确闹钟，
     * 排太多只会让最远的几条失去意义；40 条足够覆盖「未来两周 × 每任务三档」。
     */
    const val MAX_SCHEDULED = 40
  }
}
