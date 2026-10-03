import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";

/* 五层接线的静态断言（与 test-android-system-bar.mjs 同一套范式）。
   行为断言在文件末尾，会真的把 store 拉起来跑一遍排期计算。 */

const read = (path) => readProductSource(new URL(path, import.meta.url), "utf8");
const api = read("../src/api.js");
const bridge = read("../src/androidNotify.js");
const taskReminder = read("../src/taskReminder.js");
const sound = read("../src/sound.js");
const settings = read("../src/views/settings.js");
const ui = read("../src/ui.js");
const styles = read("../src/styles.css");
const libRs = read("../src-tauri/src/lib.rs");
const notifyRs = read("../src-tauri/src/notification.rs");
const hubKt = read("../android/gradle/app/src/main/java/com/yile/letime/ReminderHub.kt");
const pluginKt = read("../android/gradle/app/src/main/java/com/yile/letime/NotificationPlugin.kt");
const receiversKt = read("../android/gradle/app/src/main/java/com/yile/letime/ReminderReceivers.kt");
const mainActivityKt = read("../android/gradle/app/src/main/java/com/yile/letime/MainActivity.kt");
const syncTool = read("../../tools/sync-android-native.js");
const mirrorManifest = read("../android/gradle/app/src/main/AndroidManifest.xml");
const iconXml = read("../android/gradle/app/src/main/res/drawable/ic_stat_letime.xml");

/* ───────── v0.73.0 需求：安卓也要能像别家应用那样弹系统通知 ─────────
   现象（用户反馈，附下拉栏截图）：微信 / 日历 / 闲鱼的通知都在下拉栏里，
   本应用的「任务提醒」只有应用内一条 toast —— 应用一退到后台就等于没提醒。

   根因（两条都是硬的）：
   ① Android WebView **不实现 Web Notifications API**，`window.Notification` 不存在，
      所以 taskReminder.js 里那句 `if ("Notification" in window && ...)` 在 APK 上
      永远是死分支（桌面 WebView2 同样不实现）。
   ② 就算能弹，网页定时器也不跨进程存活：应用被系统划掉后没有任何东西会醒。

   修法：Android 侧自建原生通知桥 + AlarmManager 排期（与 system_bar 同一套五层接线）。
   持续提醒（长鸣）分两段：应用活着时由 Web Audio 循环负责（零音频资产，与七种内置
   音效同一机制），应用不在时由原生闹钟按固定间隔重弹通知催办。

   本测试钉住五层链路，任一环断开就报红。 */

/* ① Kotlin：渠道、闹钟、按钮回传都真的落到原生 API 上。 */
assert.match(hubKt, /const val CHANNEL_REMINDER = "letime-reminder"/, "必须有「任务提醒」渠道常量");
assert.match(hubKt, /const val CHANNEL_ALARM = "letime-alarm"/, "必须有「到点长鸣」独立渠道：提前预警不该用闹铃声");
assert.match(hubKt, /RingtoneManager\.getDefaultUri\(RingtoneManager\.TYPE_ALARM\)/,
  "长鸣渠道必须用系统**闹钟**默认铃声（用户说的「默认时钟的提示音」），不是通知音");
assert.match(hubKt, /setUsage\(AudioAttributes\.USAGE_ALARM\)/,
  "必须标 USAGE_ALARM：只有走闹钟音量通道才不受「媒体音量=0」和静音键影响");
assert.match(hubKt, /setSound\(alarmSound, alarmAttributes\)/, "渠道声音必须带 AudioAttributes 一起设");
assert.match(hubKt, /setExactAndAllowWhileIdle\(AlarmManager\.RTC_WAKEUP/, "必须用精确闹钟：非精确的在 Doze 下会晚几分钟");
assert.match(hubKt, /canScheduleExactAlarms\(\)/, "API 31 起必须先问精确闹钟授权，否则 setExact 直接抛 SecurityException");
assert.match(hubKt, /setAndAllowWhileIdle\(AlarmManager\.RTC_WAKEUP/,
  "没批精确闹钟时要有兜底排期，不能整条链路静默失效");
assert.match(hubKt, /PendingIntent\.FLAG_IMMUTABLE/,
  "targetSdk 31+ 起 PendingIntent 必须显式声明可变性，缺了运行时直接崩");
assert.match(hubKt, /private fun idOf\(key: String\)/,
  "通知 id 必须由 key 推出：这是「应用活着时把原生那条升级成常驻版」而不是多出一条的前提");
assert.match(hubKt, /fun postReminder\(ctx: Context, rec: ReminderRecord, ongoing: Boolean = rec\.urgent, silent: Boolean = false, taskActions: Boolean = true\): Boolean/,
  "postReminder 必须带 silent：刚点「停止响铃」又响一声，用户会以为按钮没生效");
assert.match(hubKt, /setOngoing\(ongoing\)/, "到点那条必须常驻（滑不掉），否则用户一划就丢了催办");
assert.match(hubKt, /areNotificationsEnabled\(\)/, "授权状态必须问 areNotificationsEnabled（含用户手动关渠道的情况）");
assert.match(hubKt, /getSharedPreferences\(PREFS/, "闹钟记录与按钮队列必须落 SharedPreferences：接收器醒过来时进程里没有网页");
assert.match(hubKt, /fun drainActions\(ctx: Context\)/, "必须有取走并清空按钮队列的入口");
assert.match(hubKt, /@Volatile\s+var ringActive: Boolean = false/,
  "长鸣进行中必须有一个原生可见的标志，MainActivity 才敢在 onPause 里放行");
assert.match(hubKt, /R\.drawable\.ic_stat_letime/, "必须用我们自己给的单色小图标（启动器图标会被染成一坨白块）");

/* ② 插件命令名必须与 Rust 侧的路由表逐一对上：写错一边是运行期才炸的静默失败。 */
const rustActions = [...notifyRs.matchAll(/^\s*"(\w+)",$/gm)].map((m) => m[1]);
assert.ok(rustActions.length >= 8, "notification.rs 必须解析出 KNOWN_ACTIONS 列表");
for (const action of rustActions) {
  assert.match(pluginKt, new RegExp(`@Command\\s*\\n\\s*fun ${action}\\(invoke: Invoke\\)`),
    `Kotlin 侧必须有与 Rust 路由表同名的 @Command ${action}`);
}
assert.match(pluginKt, /@TauriPlugin\(\s*permissions = \[\s*Permission\(strings = \["android\.permission\.POST_NOTIFICATIONS"\], alias = "notifications"\)/,
  "插件必须声明 POST_NOTIFICATIONS 权限别名，否则 requestPermissionForAliases 找不到授权");
assert.match(pluginKt, /requestPermissionForAliases\(arrayOf\("notifications"\), invoke, "permissionDone"\)/,
  "授权必须走 Tauri 的别名机制并回到 permissionDone 回调");
assert.match(pluginKt, /@PermissionCallback\s*\n\s*fun permissionDone\(invoke: Invoke\)/,
  "必须有 @PermissionCallback 的回调方法（名字要与上一行的回调名一致）");
assert.match(hubKt, /builder\.addAction\([^,]+, "停止响铃", actionIntent\(ctx, rec\.key, ACTION_STOP\)\)/,
  "常驻通知必须带「停止响铃」按钮：这是应用不在时唯一的静音出口");
assert.match(hubKt, /builder\.addAction\([^,]+, "标记完成", actionIntent\(ctx, rec\.key, ACTION_DONE\)\)/,
  "通知必须带「标记完成」：点完这条提醒就该彻底消失");
assert.match(hubKt, /if \(ongoing\) \{[\s\S]*停止响铃[\s\S]*\}[\s\S]*标记完成/,
  "「停止响铃」只在常驻（到点）那条上出现：提前预警不该有响铃可停");
assert.match(pluginKt, /optJSONArray\("alarms"\)/,
  "闹钟列表必须从 args 的 JSON 手解：parseArgs 走 Jackson，嵌套 List 的泛型推断在本仓库没有先例");
assert.match(pluginKt, /rescheduleAll\(host, records\)/, "syncAlarms 必须整份重排（撤干净再按新列表排）");

/* ③ 三个接收器：类名、注册、行为。漏注册的症状最难查 —— PendingIntent 构造照样成功。 */
for (const cls of ["ReminderAlarmReceiver", "ReminderActionReceiver", "ReminderBootReceiver"]) {
  assert.match(receiversKt, new RegExp(`class ${cls} : BroadcastReceiver\\(\\)`), `必须有 ${cls}`);
  assert.match(mirrorManifest, new RegExp(`android:name="\\.${cls}"`), `${cls} 必须在清单里注册`);
  assert.match(syncTool, new RegExp(`android:name="\\.${cls}"`), `${cls} 的注册块必须由同步工具写进 gen`);
}
assert.match(receiversKt, /ReminderHub\.findAlarm\(context, key\) \?: return/,
  "闹钟到点必须先查记录：记录被前端重排掉/标记完成之后不能再弹（否则删了任务还在响）");
assert.match(receiversKt, /rec\.urgent && rec\.repeatMs > 0 && next < rec\.repeatUntil/,
  "催办重排必须同时受间隔与截止窗口约束，不能无限重弹");
assert.match(receiversKt, /ongoing = false, silent = true/,
  "「停止响铃」必须把常驻降级成可滑走且静默：内容留着回看，但不再响");
assert.match(receiversKt, /ReminderHub\.restoreFromStore\(context\)/, "开机必须从持久化记录重排闹钟（排期不跨重启）");
assert.match(mirrorManifest, /android:name="\.ReminderBootReceiver"\s*\n\s*android:exported="true"/,
  "开机接收器必须 exported=true（API 31 起缺这一条系统根本不投递）");
for (const permission of ["POST_NOTIFICATIONS", "VIBRATE", "SCHEDULE_EXACT_ALARM", "RECEIVE_BOOT_COMPLETED"]) {
  assert.ok(mirrorManifest.includes(`android.permission.${permission}`), `清单必须声明 ${permission}`);
  assert.ok(syncTool.includes(`android.permission.${permission}`), `同步工具必须幂等补齐 ${permission}`);
}

/* ④ 同步工具：新文件没进清单 = 下次 tauri android init 之后手机端功能静默消失。 */
for (const name of ["ReminderHub.kt", "NotificationPlugin.kt", "ReminderReceivers.kt"]) {
  assert.match(syncTool, new RegExp(`"${name}",`), `SOURCES 必须收录 ${name}`);
}
assert.match(syncTool, /"app\/src\/main\/res\/drawable\/ic_stat_letime\.xml"/,
  "RESOURCES 必须收录通知小图标：gen 是 gitignored 生成目录，不列进去就会被 init 冲掉");
assert.ok(iconXml.includes("<vector"), "小图标必须是矢量图（通知小图标只认 alpha）");

/* ⑤ Rust 桥：模块声明 + Android 注册 + 命令注册 + 非 Android 恒成功。 */
assert.match(libRs, /^mod notification;$/m, "lib.rs 必须声明 notification 模块");
assert.match(libRs, /builder = builder\.plugin\(notification::init\(\)\);/,
  "Android 分支必须注册通知插件（否则拿不到原生句柄，所有命令静默无效）");
assert.match(libRs, /^\s*notification::notification,$/m, "notification 命令必须进 invoke_handler");
assert.match(notifyRs, /register_android_plugin\("com\.yile\.letime",\s*"NotificationPlugin"\)/,
  "原生类名必须与 Kotlin 侧完全一致");
assert.match(notifyRs, /run_mobile_plugin_async\(&action, args\)/, "必须按 action 路由到同名 Kotlin 命令");
assert.match(notifyRs, /未知通知操作/, "未知 action 必须报错，不能静默无操作");
const desktop = notifyRs.split('#[cfg(desktop)]')[2]?.split('#[cfg(all(not(target_os = "android"), not(desktop)))]')[0] ?? "";
assert.ok(desktop, "notification.rs 必须有桌面分支");
assert.match(desktop, /action == "post"[\s\S]*\.show\(\)/,
  "桌面 post 必须发送系统通知，不能继续空转");
assert.match(desktop, /Ok\(json!\(\{/, "桌面不支持的 Android 专属动作必须成功空转");
const unsupported = notifyRs.split('#[cfg(all(not(target_os = "android"), not(desktop)))]')[1] ?? "";
assert.ok(unsupported, "notification.rs 必须保留非 Android、非桌面平台的安全降级分支");
assert.doesNotMatch(unsupported, /\bErr(?:::[^\s(]*)?\s*\(/,
  "未支持平台不能有错误出口，否则通知巡检会被打断");

/* ⑥ api 层与桥接层：非 Tauri / 非 Android 必须安全空转。 */
assert.match(api, /async notification\(action, payload\)\s*\{/, "api.js 必须暴露 notification(action, payload)");
assert.match(api, /invoke\("notification",\s*\{\s*action,\s*payload:/, "命令名必须是 notification，参数名 action/payload 与 Rust 对齐");
const apiNotify = api.match(/async notification\(action, payload\)\s*\{([\s\S]*?)\n  \}/)?.[1] ?? "";
assert.match(apiNotify, /if \(!isTauri\) return/, "纯浏览器调试必须提前返回，不能让提醒链路抛异常");
assert.match(bridge, /export function isAndroidRuntime\(\)\s*\{[\s\S]*api\.isTauri[\s\S]*\/Android\/i/,
  "平台判定必须同时要求 Tauri 与 UA 里的 Android：浏览器里跑 Android 模拟器不该走原生桥");
assert.match(bridge, /catch \(e\) \{[\s\S]*applied: false/,
  "原生调用失败必须吞成 {applied:false}：旧 APK 缺桥时提醒要退回应用内，而不是把 tick 打断");
for (const fn of ["notifyStatus", "askNotifyPermission", "openNotifySettings", "openExactAlarmSettings",
  "syncNativeAlarms", "clearNativeAlarms", "postNativeReminder", "cancelNativeReminder",
  "setNativeRingActive", "takeNativeActions"]) {
  assert.match(bridge, new RegExp(`export (async )?function ${fn}\\(`), `androidNotify.js 必须导出 ${fn}`);
}

/* ⑦ 前端接线：最容易漏的一环 —— 原生写好了但没人调，症状与没修一模一样。 */
assert.match(taskReminder, /import \{[\s\S]*\} from "\.\/androidNotify\.js"/,
  "taskReminder 必须引桥接层（这条断言在，漏 import 会当场报红）");
assert.match(taskReminder, /if \(isAndroidRuntime\(\)\) postNativeReminder\(reminderRecord\(ev\)\)/,
  "提前预警必须真的发原生通知");
assert.match(taskReminder, /ev\.offset === 0 && c\.ringEnabled[\s\S]*startRing\(ev, c\)/,
  "只有「已到截止时间」这一档走长鸣：提前预警长鸣会变成骚扰");
assert.match(taskReminder, /function startRing\(ev, c = cfg\(\)\)\s*\{[\s\S]*startAlarmLoop\(/,
  "startRing 必须真的起循环音");
assert.match(taskReminder, /setNativeRingActive\(true\)/, "长鸣开始必须告诉原生别冻结 WebView 定时器");
assert.match(taskReminder, /setNativeRingActive\(false\)/, "长鸣结束必须撤销那个标志");
assert.match(taskReminder, /maxTimer: setTimeout\(\(\) => stopRing\(\), maxMs\)/,
  "必须有「最长响铃」自动停：按钮点不到时不能真的一直响");
assert.match(taskReminder, /poll: setInterval\([\s\S]*drainNativeActions/,
  "长鸣期间必须轮询原生按钮队列，否则通知上的「停止响铃」在应用活着时也没人接");
assert.match(taskReminder, /syncNativePlan\(\);/, "tick 必须把排期推给原生（应用被杀后全靠这份列表）");
assert.match(taskReminder, /drainNativeActions\(\);/, "tick 必须回捞用户在通知按钮上的点击");
assert.match(taskReminder, /if \(!c\.enabled \|\| !c\.nativeAlarm\) return \[\]/,
  "总开关或后台闹钟开关关掉时排期必须是空列表（配合下面的 clear 才会撤掉系统里的闹钟）");
assert.match(taskReminder, /await clearNativeAlarms\(\)/, "排期为空必须显式清空原生侧，不能只留着不管");
assert.match(taskReminder, /if \(item\.action === "done"\)[\s\S]*S\.updateTask\(task\.id, \{ done: true \}\)/,
  "通知上的「标记完成」必须真的改任务状态");
assert.match(read("../src/main.js"), /await initAndroidNotifications\(\)/,
  "启动时必须初始化系统通知授权");
assert.match(bridge, /if \(!status\.granted\) toast\([\s\S]*action: openNotifySettings/,
  "未授权时必须保留系统设置入口");

/* ⑧ 长鸣音效：零资产 + 无缝循环的两个前提。 */
assert.match(sound, /\{ id: "clock", label: "时钟长鸣"[\s\S]*loop: \{/, "必须有「时钟长鸣」可循环预设");
assert.match(sound, /source\.loop = true/, "内置长鸣必须用 AudioBufferSourceNode 的硬件循环，不靠 JS 定时器排");
assert.match(sound, /function renderLoopBuffer\(ctx, loop, level\)/, "必须把一个 period 直接渲染成采样");
assert.match(sound, /export function stopAlarmLoop\(\)\s*\{\s*const current = ring;\s*ring = null;[\s\S]*if \(!current\) return false/,
  "stopAlarmLoop 必须先清状态再收尾（幂等：watchdog 与按钮会同时调它）");
assert.match(sound, /audio\.loop = true/, "自定义音频长鸣走 <audio loop>");
assert.match(sound, /audio\.play\(\)\.catch\(/,
  "自定义音频 play() 被自动播放策略拒时必须退回合成闹铃，不能变成「按了没声音」");

/* ⑨ 设置页与样式。 */
assert.match(settings, /"到点持续长鸣"/, "设置页必须有长鸣开关");
assert.match(settings, /"最长响铃"/, "设置页必须能选最长响铃时长");
assert.match(settings, /if \(isAndroidRuntime\(\)\)\s*\{/, "原生那一节只在 Android 出现");
assert.match(settings, /"系统通知"/, "设置页必须显示通知授权状态");
assert.match(settings, /"精确闹钟"/, "精确闹钟没授权时提醒会晚几分钟，必须显式亮出来引导");
assert.match(settings, /BUILTIN_SOUNDS\.filter\(\(p\) => p\.loop\)/, "长鸣音效只列可循环的预设");
assert.match(styles, /\.toast\.alarm \{/, "长鸣横幅必须有区别于普通 toast 的样式");
assert.match(styles, /\.set-hint \{/, "设置页说明文字必须有样式（不能裸 class 名没规则）");
assert.match(ui, /if \(opts\.ms !== 0\) timer = setTimeout\(close/,
  "toast 必须支持 ms:0 常驻：长鸣横幅不能自己消失");

/* ───────── 行为断言：真的算一遍排期 ───────── */
globalThis.window = { AudioContext: class {} };
globalThis.document = { createElement: () => ({ classList: { add() {}, remove() {}, toggle() {} }, append() {}, addEventListener() {} }) };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const S = await import("../src/store.js");
await S.initStore({ tasks: [], blocks: [], settings: {}, plugins: {} });
const R = await import("../src/taskReminder.js");

const now = new Date("2026-09-19T08:00:00").getTime();
const tasks = [{ id: "t_1", title: "交报告", due: "2026-09-19", dueTime: "10:00", done: false, reminderEnabled: true }];
const plan = R.upcomingAlarmPlan(tasks, now);

assert.deepEqual(plan.map((r) => r.key.split(":").pop()), ["60", "10", "0"],
  "默认三档提前预警都要排上，且按时间先后");
assert.deepEqual(plan.map((r) => r.at), [now + 3600000, now + 6600000, now + 7200000],
  "排期时刻 = 截止时刻 − 提前量");
assert.deepEqual(plan.map((r) => r.urgent), [false, false, true], "只有「到点」那档是 urgent");
assert.equal(plan[2].repeatMs, R.NAG_INTERVAL_MS, "urgent 档必须带催办间隔（应用被杀时的持续提醒就靠它）");
assert.equal(plan[1].repeatMs, 0, "提前预警不许重弹：那是骚扰");
assert.ok(plan.every((r) => r.at > now), "已过点的提醒绝不排给原生（否则每次重启都把历史提醒炸一遍）");
assert.ok(plan[2].repeatUntil > plan[2].at, "催办窗口必须从到点时刻往后算");
assert.equal(R.upcomingAlarmPlan([{ id: "t_2", title: "无截止" }], now).length, 0, "没有截止日期的任务不排");
assert.equal(R.upcomingAlarmPlan([{ ...tasks[0], done: true }], now).length, 0, "已完成的任务不排");
assert.equal(R.upcomingAlarmPlan([{ ...tasks[0], reminderEnabled: false }], now).length, 0, "单任务关掉提醒就不排");

// 上限：超出 ALARM_MAX_COUNT 的最远几条不排（与 NotificationPlugin.kt 的 MAX_SCHEDULED 一致）
const many = Array.from({ length: 30 }, (_, i) => ({
  id: `m_${i}`, title: `任务${i}`, due: "2026-09-20", dueTime: "09:00", done: false, reminderEnabled: true,
}));
assert.equal(R.upcomingAlarmPlan(many, now).length, R.ALARM_MAX_COUNT, "排期条数必须卡在上限，且保留的是最近的");
assert.equal(R.ALARM_MAX_COUNT, Number(pluginKt.match(/MAX_SCHEDULED = (\d+)/)?.[1]),
  "前端上限必须与 Kotlin 的 MAX_SCHEDULED 同一个数（不一致会静默丢排期）");

assert.deepEqual(R.parseReminderKey("t_1:1789783200000:0"), { taskId: "t_1", due: 1789783200000, offset: 0 },
  "幂等键必须能反解出任务 id（通知按钮回传只带得回这个键）");
assert.equal(R.parseReminderKey("坏键"), null, "解不开的键要返回 null，不能让 drain 抛异常打断 tick");
assert.equal(R.reminderText({ task: tasks[0], offset: 0 }), "交报告 · 已到截止时间");

// 长鸣预设必须在一个 period 末尾留白：循环接缝落在静音上，才不会每圈一声咔哒。
const { BUILTIN_SOUNDS } = await import("../src/sound.js");
const clock = BUILTIN_SOUNDS.find((s) => s.id === "clock");
assert.ok(clock?.loop, "必须有可循环的 clock 预设");
const lastEnd = clock.loop.tones.reduce((acc, t) => Math.max(acc, (t.t || 0) + (t.d || 0.18)), 0);
assert.ok(lastEnd < clock.loop.period,
  `最后一个音（${lastEnd}s）必须早于 period（${clock.loop.period}s），否则循环接缝会响`);

console.log("PASS: Android native notifications + alarm scheduling are wired end to end (Kotlin / sync tool / Rust / api / frontend)");
