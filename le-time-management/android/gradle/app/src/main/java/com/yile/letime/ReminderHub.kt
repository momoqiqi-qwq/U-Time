package com.yile.letime

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * 一条「到点要弹通知」的提醒记录。
 *
 * 事实源永远是网页里的 data.json（任务 + 提前量），本对象只是它在原生侧的**投影**：
 * 网页每次改动都通过 [ReminderHub.saveAlarms] 整份重推，原生不自己算。
 * 之所以要在原生留一份，是为了让 `AlarmManager` 在应用被系统划掉之后仍然知道
 * 「该弹什么」—— 广播接收器醒过来时进程里没有任何网页状态可读。
 *
 * @param key         与网页 `settings.taskReminderLog` 同格式的幂等键 `任务id:截止时刻:提前量`
 * @param urgent      是否「已到截止时间」那一档：走长鸣渠道（系统闹铃音 + 常驻 + 催办重弹）
 * @param repeatMs    催办间隔，0 = 不重弹
 * @param repeatUntil 催办截止时刻（epoch ms），超过就不再重弹
 */
data class ReminderRecord(
  val key: String,
  val title: String,
  val body: String,
  val at: Long,
  val urgent: Boolean,
  val repeatMs: Long,
  val repeatUntil: Long,
) {
  fun toJson(): JSONObject = JSONObject().apply {
    put("key", key)
    put("title", title)
    put("body", body)
    put("at", at)
    put("urgent", urgent)
    put("repeatMs", repeatMs)
    put("repeatUntil", repeatUntil)
  }

  companion object {
    fun fromJson(obj: JSONObject): ReminderRecord = ReminderRecord(
      key = obj.optString("key"),
      title = obj.optString("title"),
      body = obj.optString("body"),
      at = obj.optLong("at"),
      urgent = obj.optBoolean("urgent"),
      repeatMs = obj.optLong("repeatMs"),
      repeatUntil = obj.optLong("repeatUntil"),
    )
  }
}

/**
 * 通知与闹钟的原生中枢：渠道、通知构建、AlarmManager 排期、按钮回传队列都在这里。
 *
 * ## 为什么单独一个 object 而不是全塞进 NotificationPlugin
 *
 * 插件类只在 Activity 存活时存在，而**广播接收器醒过来时可能根本没有 Activity**
 * （闹钟在应用被杀后触发、开机恢复）。所以「存哪、怎么弹、怎么排」必须与
 * Tauri 插件解耦，两边共用这一份。
 *
 * ## 两条触达路径，同一个 key
 *
 * · 应用被杀 / 后台沉睡：`AlarmManager` → [ReminderAlarmReceiver] → 本文件 [postReminder]。
 *   声音用**系统默认闹钟铃声**（`TYPE_ALARM`，走闹钟音量通道，静音键管不着）。
 * · 应用活着：网页自己的定时器命中 → 调 `post` 命令，用**同一个 key** 重发同一条通知，
 *   于是上面那条被就地升级成「常驻 + 停止响铃 / 标记完成」两个按钮，不会出现两条。
 *   持续长鸣由网页的 Web Audio 循环负责（见 src/sound.js 的 startAlarmLoop）。
 *
 * ## 为什么渠道声音用系统闹铃而不是自带音频
 *
 * 项目里七种内置音效全是 Web Audio 现场合成的，仓库没有任何音频文件；原生侧要自带
 * 声音就得往 res/raw 塞资产，还要扩 sync-android-native.js 同步二进制。用系统
 * `TYPE_ALARM` 既零资产，又正好是用户说的「默认时钟的提示音」—— 用的是手机自己那只闹钟。
 */
object ReminderHub {
  /** 提前预警档：普通 heads-up。 */
  const val CHANNEL_REMINDER = "letime-reminder"

  /** 到点档：系统闹铃声 + 常驻 + 催办重弹。 */
  const val CHANNEL_ALARM = "letime-alarm"

  const val ACTION_STOP = "stop"
  const val ACTION_DONE = "done"

  const val EXTRA_KEY = "key"
  const val EXTRA_ACTION = "action"

  private const val PREFS = "letime-reminders"
  private const val KEY_ALARMS = "alarms"
  private const val KEY_ACTIONS = "actions"

  /**
   * 网页的长鸣循环是否正在进行。
   *
   * MainActivity.onPause() 靠它决定要不要立刻把 WebView 拉回 running ——
   * `WebView.onPause()` 会挂起页面定时器，响到一半定时器被冻住，
   * 「持续提醒」就退化成一响即停。见 MainActivity.onPause 的注释。
   */
  @Volatile
  var ringActive: Boolean = false

  private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun manager(ctx: Context) = NotificationManagerCompat.from(ctx)

  private fun alarmManager(ctx: Context) =
    ctx.getSystemService(Context.ALARM_SERVICE) as? AlarmManager

  /** 通知 id：同一 key 永远同一个 id，这是「升级而非新增」的前提。 */
  private fun idOf(key: String): Int = key.hashCode() and 0x7fffffff

  /* ───────────── 渠道 ───────────── */

  /**
   * 幂等创建两条渠道。**渠道的 importance / sound 一旦建立系统就不允许应用再改**，
   * 所以这里只在缺失时创建；用户后来在系统设置里改过音量或横幅，一律以用户的为准。
   */
  fun ensureChannels(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val alarmSound = try {
      RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
        ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
    } catch (_: Throwable) {
      null
    }
    val alarmAttributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ALARM)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()

    if (nm.getNotificationChannel(CHANNEL_REMINDER) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_REMINDER, "任务提醒", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "截止前的提前预警（还有 1 小时、10 分钟这类）"
          enableVibration(true)
        }
      )
    }
    if (nm.getNotificationChannel(CHANNEL_ALARM) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_ALARM, "到点长鸣", NotificationManager.IMPORTANCE_HIGH).apply {
          description = "已到截止时间，会一直催办到处理为止"
          enableVibration(true)
          setSound(alarmSound, alarmAttributes)
          lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
      )
    }
  }

  /** 系统层面「这个应用能不能发通知」（含 Android 13 的 POST_NOTIFICATIONS 与用户手动关渠道）。 */
  fun notificationsEnabled(ctx: Context): Boolean = try {
    manager(ctx).areNotificationsEnabled()
  } catch (_: Throwable) {
    false
  }

  /** API 31 起精确闹钟变成用户可撤销的授权；没批就只能退化成非精确（Doze 下会晚几分钟）。 */
  fun canScheduleExact(ctx: Context): Boolean = try {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      alarmManager(ctx)?.canScheduleExactAlarms() == true
    } else {
      true
    }
  } catch (_: Throwable) {
    false
  }

  /* ───────────── 通知 ───────────── */

  private fun openAppIntent(ctx: Context): PendingIntent {
    val intent = Intent(ctx, MainActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    return PendingIntent.getActivity(
      ctx, idOf("open"), intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun actionIntent(ctx: Context, key: String, action: String): PendingIntent {
    val intent = Intent(ctx, ReminderActionReceiver::class.java).apply {
      putExtra(EXTRA_KEY, key)
      putExtra(EXTRA_ACTION, action)
    }
    return PendingIntent.getBroadcast(
      ctx, idOf("$key|$action"), intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  /**
   * 弹（或就地更新）一条提醒通知。
   *
   * @param ongoing 常驻 = 下拉栏里滑不掉，这是长鸣期间的正确形态；
   *                用户点「停止响铃」后由 [ReminderActionReceiver] 降级成可滑走。
   * @param silent  静默更新。降级那条必须走这条：换渠道重发会按新渠道再响一次铃，
   *                用户刚点「停止响铃」就又响一声，等于按钮没起作用。
   */
  fun postReminder(ctx: Context, rec: ReminderRecord, ongoing: Boolean = rec.urgent, silent: Boolean = false, taskActions: Boolean = true): Boolean {
    ensureChannels(ctx)
    val channelId = if (rec.urgent) CHANNEL_ALARM else CHANNEL_REMINDER
    if (!notificationsEnabled(ctx)) return false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      ctx.getSystemService(NotificationManager::class.java).getNotificationChannel(channelId)?.importance == NotificationManager.IMPORTANCE_NONE) return false
    val builder = NotificationCompat.Builder(ctx, channelId)
      .setSmallIcon(R.drawable.ic_stat_letime)
      .setContentTitle(rec.title)
      .setContentText(rec.body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(rec.body))
      .setPriority(if (rec.urgent) NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_HIGH)
      .setCategory(if (rec.urgent) NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_REMINDER)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setContentIntent(openAppIntent(ctx))
      .setWhen(rec.at)
      .setShowWhen(true)
      .setAutoCancel(!ongoing)
      .setOngoing(ongoing)
    if (silent) builder.setSilent(true)
    if (ongoing) {
      builder.addAction(R.drawable.ic_stat_letime, "停止响铃", actionIntent(ctx, rec.key, ACTION_STOP))
    }
    if (taskActions) builder.addAction(R.drawable.ic_stat_letime, "标记完成", actionIntent(ctx, rec.key, ACTION_DONE))
    return try {
      manager(ctx).notify(idOf(rec.key), builder.build())
      true
    } catch (_: Throwable) {
      // 没通知权限（用户在系统里刚关掉）或系统通知服务异常：
      // 闹钟链路不能因此把广播接收器拖崩，最坏是这一次不响。
      false
    }
  }

  fun cancel(ctx: Context, key: String) {
    try {
      manager(ctx).cancel(idOf(key))
    } catch (_: Throwable) {
    }
  }

  /* ───────────── 闹钟记录与排期 ───────────── */

  fun saveAlarms(ctx: Context, records: List<ReminderRecord>) {
    val arr = JSONArray()
    for (rec in records) arr.put(rec.toJson())
    prefs(ctx).edit().putString(KEY_ALARMS, arr.toString()).apply()
  }

  fun loadAlarms(ctx: Context): List<ReminderRecord> {
    val text = prefs(ctx).getString(KEY_ALARMS, null) ?: return emptyList()
    return try {
      val arr = JSONArray(text)
      (0 until arr.length()).mapNotNull { i ->
        arr.optJSONObject(i)?.let { ReminderRecord.fromJson(it) }?.takeIf { it.key.isNotEmpty() }
      }
    } catch (_: Throwable) {
      emptyList()
    }
  }

  fun findAlarm(ctx: Context, key: String): ReminderRecord? =
    loadAlarms(ctx).firstOrNull { it.key == key }

  /** 覆盖式写入单条（催办重排时只改 at，不动其它字段）。 */
  fun putAlarm(ctx: Context, rec: ReminderRecord) {
    saveAlarms(ctx, loadAlarms(ctx).filterNot { it.key == rec.key } + rec)
  }

  private fun alarmIntent(ctx: Context, key: String): PendingIntent {
    val intent = Intent(ctx, ReminderAlarmReceiver::class.java).putExtra(EXTRA_KEY, key)
    return PendingIntent.getBroadcast(
      ctx, idOf(key), intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  /**
   * 排一次闹钟。已过点的直接跳过 —— 补发是网页侧 90 秒窗口的职责，
   * 原生不重复补，否则重启一次就把历史提醒全炸一遍。
   */
  fun schedule(ctx: Context, rec: ReminderRecord) {
    val am = alarmManager(ctx) ?: return
    if (rec.at <= System.currentTimeMillis()) return
    try {
      val pi = alarmIntent(ctx, rec.key)
      if (canScheduleExact(ctx)) {
        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, rec.at, pi)
      } else {
        // 没给精确闹钟授权：setAndAllowWhileIdle 仍会在 Doze 的维护窗口里醒来，
        // 代价是最多晚几分钟。前端会把这个降级状态显示出来引导用户去开。
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, rec.at, pi)
      }
    } catch (_: Throwable) {
    }
  }

  fun cancelSchedule(ctx: Context, key: String) {
    try {
      alarmManager(ctx)?.cancel(alarmIntent(ctx, key))
    } catch (_: Throwable) {
    }
  }

  /** 整份重排：先撤掉系统里所有本应用的闹钟，再按新列表排。 */
  fun rescheduleAll(ctx: Context, records: List<ReminderRecord>) {
    val previous = loadAlarms(ctx).map { it.key }.toSet()
    for (key in previous) cancelSchedule(ctx, key)
    saveAlarms(ctx, records)
    for (rec in records) schedule(ctx, rec)
  }

  /** 开机恢复：闹钟不跨重启，只能从持久化的记录里重排。 */
  fun restoreFromStore(ctx: Context) {
    val now = System.currentTimeMillis()
    val alive = loadAlarms(ctx).filter { it.at > now }
    rescheduleAll(ctx, alive)
  }

  /* ───────────── 按钮回传队列 ───────────── */

  /**
   * 接收器把用户点过的按钮记在这里，网页下次巡检时取走。
   *
   * 为什么不用 Tauri 的插件事件（Plugin.trigger）：事件要求网页活着且已注册监听，
   * 而「点了停止但应用当时已被杀」是常态。落 SharedPreferences 才能跨进程、跨重启
   * 把这一次点击送到网页手里。
   */
  fun pushAction(ctx: Context, key: String, action: String) {
    // 队列字符串可能被旧版本写坏（或被用户清数据时截断）：坏就整份重来，
    // 绝不能让接收器在 put() 上抛异常 —— 那等于用户的「停止响铃」按了没反应。
    val arr = try {
      JSONArray(prefs(ctx).getString(KEY_ACTIONS, "[]") ?: "[]")
    } catch (_: Throwable) {
      JSONArray()
    }
    arr.put(
      JSONObject().apply {
        put("key", key)
        put("action", action)
        put("at", System.currentTimeMillis())
      }
    )
    prefs(ctx).edit().putString(KEY_ACTIONS, arr.toString()).apply()
  }

  /** 取走并清空（返回空列表表示没有待处理）。 */
  fun drainActions(ctx: Context): List<PendingAction> {
    val text = prefs(ctx).getString(KEY_ACTIONS, null) ?: return emptyList()
    prefs(ctx).edit().remove(KEY_ACTIONS).apply()
    return try {
      val arr = JSONArray(text)
      (0 until arr.length()).mapNotNull { i ->
        val obj = arr.optJSONObject(i) ?: return@mapNotNull null
        val key = obj.optString("key")
        if (key.isEmpty()) null else PendingAction(key, obj.optString("action"))
      }
    } catch (_: Throwable) {
      emptyList()
    }
  }
}

/** [ReminderHub.drainActions] 的返回元素：一条「用户在通知上点过什么」。 */
data class PendingAction(val key: String, val action: String)
