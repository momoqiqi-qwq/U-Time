import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => readProductSource(new URL(path, import.meta.url), "utf8");
const api = read("../src/api.js");
const theme = read("../src/theme.js");
const libRs = read("../src-tauri/src/lib.rs");
const systemBarRs = read("../src-tauri/src/system_bar.rs");
const pluginKt = read("../android/gradle/app/src/main/java/com/yile/letime/SystemBarPlugin.kt");
const systemBarsKt = read("../android/gradle/app/src/main/java/com/yile/letime/SystemBars.kt");
const mainActivityKt = read("../android/gradle/app/src/main/java/com/yile/letime/MainActivity.kt");
const syncTool = read("../../tools/sync-android-native.js");

/* ───────────── v0.272.5 回归：导航栏底色被系统 scrim 盖住 ─────────────
   现象（用户反馈）：APK 深色模式时底部是**白色**，浅色模式时底部是**深色** ——
   跟着系统走，不跟网页主题走。图标反而与那条反相色带融成一片。

   根因：v0.51.0 只把**图标明暗**接到网页主题，**底色**没管。
   `Window.isNavigationBarContrastEnforced`（API 29+，默认 true）会在透明导航栏下
   垫一层按**系统深浅**取的 scrim —— 于是「透明浮层露出的网页底色」被盖成系统主题色。
   `enableEdgeToEdge()` 一开始关了它，但 onResume / 配置变化 / 部分 ROM 的窗口重建
   会把它打回默认值。

   修法：SystemBars 把「底色钉成透明 + 关掉两处 scrim + 图标反相」原子地一次写完，
   并在 MainActivity 的 onResume / onConfigurationChanged 重放。

   本测试钉住**五段链路**，任一环断开就报红。 */

/* ① 前端：paintTheme 必须真的发起同步（这是最容易漏的一环 ——
      原生写好了但没人调，症状与没修一模一样）。 */
assert.match(theme, /^import \{ api \} from "\.\/api\.js";$/m,
  "theme.js 必须导入 api 才能调用原生命令");
const paintTheme = theme.match(/function paintTheme\(root, preference, resolved\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
assert.ok(paintTheme, "必须存在 paintTheme");
assert.match(paintTheme, /syncSystemBarIcons\(resolved\.mode\)/,
  "paintTheme 必须把**解析后的亮度**同步给系统栏：这是唯一知道浅色/深色的地方（v0.51.0）");
assert.match(paintTheme, /root\.dataset\.themeMode = resolved\.mode;/,
  "同步用的必须是解析后的 light/dark，不能传主题 id 或 \"system\"");
// 语义必须对上 Android API：浅色背景 ⇒ 深色图标 ⇒ true
const syncFn = theme.match(/function syncSystemBarIcons\(mode\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
assert.ok(syncFn, "必须存在 syncSystemBarIcons");
assert.match(syncFn, /api\.systemBar\(\s*mode === "light"\s*\)/,
  '传参必须是 mode === "light"（浅色 ⇒ 深色图标），与 isAppearanceLightStatusBars 语义一致');
// 装饰性同步失败绝不能打断换主题
assert.match(syncFn, /try\s*\{[\s\S]*catch/,
  "系统栏同步必须被 try 包住：原生命令缺失时不能把换主题一起搞崩");

/* ② API 层：命令名与参数名要和 Rust 侧一致，且非 Tauri 环境安全空转。 */
assert.match(api, /async systemBar\(darkIcons\)\s*\{/,
  "api.js 必须暴露 systemBar(darkIcons)");
assert.match(api, /invoke\("system_bar",\s*\{\s*darkIcons\s*\}\)/,
  "命令名必须是 system_bar、参数名必须是 darkIcons（Rust 侧靠它反序列化）");
const apiFn = api.match(/async systemBar\(darkIcons\)\s*\{([\s\S]*?)\n  \}/)?.[1] ?? "";
assert.match(apiFn, /if \(!isTauri\) return/,
  "非 Tauri（纯浏览器调试）必须提前返回，不能让换主题抛异常");

/* ③ Rust 桥：模块注册 + 命令注册 + 非 Android 恒成功返回。 */
assert.match(libRs, /^mod system_bar;$/m, "lib.rs 必须声明 system_bar 模块");
assert.match(libRs, /builder = builder\.plugin\(system_bar::init\(\)\);/,
  "Android 分支必须注册 system_bar 插件（否则原生插件句柄拿不到）");
assert.match(libRs, /^\s*system_bar::system_bar,$/m,
  "system_bar 命令必须进 invoke_handler，否则前端调不通");
assert.match(systemBarRs, /register_android_plugin\("com\.yile\.letime",\s*"SystemBarPlugin"\)/,
  '原生类名必须与 Kotlin 侧完全一致：com.yile.letime / SystemBarPlugin');
assert.match(systemBarRs, /run_mobile_plugin_async\(\s*"setDarkIcons"/,
  '必须调用 Kotlin 侧的 setDarkIcons 命令（名字写错会静默失败）');
assert.match(systemBarRs, /json!\(\{ "darkIcons": dark_icons \}\)/,
  "传给 Kotlin 的字段名必须是 darkIcons，与 @InvokeArg 的字段名对齐");
// 桌面端不能报错 —— 前端在所有平台无脑调用
const nonAndroid = systemBarRs.split('#[cfg(not(target_os = "android"))]')[1] ?? "";
assert.ok(nonAndroid, "system_bar.rs 必须有非 Android 分支");
assert.match(nonAndroid, /Ok\(serde_json::json!/,
  "非 Android 平台必须恒成功返回（桌面端窗口不铺满整屏，没有这个问题，不该报错）");
// 光有 Ok( 不够 —— 必须确认这个分支**没有任何**错误出口，否则桌面端一换主题就崩。
// （变异实测：只在 Ok 里顺手塞一句 Err::<(), String>(..).unwrap_err() 能骗过上面那条断言 ——
//  注意错误值可能带 turbofish 写成 `Err::<...>(`，所以模式要写成 `Err` + 可选 `::` + `(`。）
assert.doesNotMatch(nonAndroid, /\bErr(?:::[^\s(]*)?\s*\(/,
  "非 Android 分支绝不能有错误出口：桌面端每次换主题都会调它，一旦返错就是换主题直接崩");
assert.doesNotMatch(nonAndroid, /unwrap_err\(\)|\.expect\(|panic!\(|unimplemented!\(|todo!\(/,
  "非 Android 分支不能有 panic 出口：换主题是高频路径，任何 panic 都会把应用带崩");

/* ④ Kotlin：真的去改系统栏图标外观，且状态栏与导航栏同相。
      底部导航栏同样是透明浮层，只修上面会让下面看不见。
      v0.272.5 起实际写窗口的代码在 SystemBars.kt（插件与 MainActivity 都调它）。 */
assert.match(pluginKt, /class SystemBarPlugin\(private val host: Activity\) : Plugin\(host\)/,
  "SystemBarPlugin 必须按 Tauri 插件约定接收 Activity");
assert.match(pluginKt, /@Command\s*\n\s*fun setDarkIcons\(invoke: Invoke\)/,
  "必须有 @Command setDarkIcons");
assert.match(pluginKt, /@InvokeArg\s*\n\s*class SystemBarArgs\s*\{[\s\S]*?var darkIcons: Boolean = false/,
  "SystemBarArgs 必须有 darkIcons 字段（且给默认值，缺参时不崩）");
assert.match(pluginKt, /SystemBars\.setDarkIcons\(host, args\.darkIcons\)/,
  "插件必须把写入委托给 SystemBars（底色与图标要原子地一起设）");

/* ④b SystemBars：底色 + 图标一起钉死（v0.272.5 的核心）。 */
assert.match(systemBarsKt, /object SystemBars\b/,
  "必须有 SystemBars 单例：底色与图标必须在同一处、同一次窗口写入里生效");
assert.match(systemBarsKt, /isAppearanceLightStatusBars = darkIcons/,
  "必须用 isAppearanceLightStatusBars 覆盖状态栏图标明暗");
assert.match(systemBarsKt, /isAppearanceLightNavigationBars = darkIcons/,
  "导航栏也必须同相设置：底部同样是透明浮层，只修状态栏会让底部看不见");
assert.match(systemBarsKt, /WindowInsetsControllerCompat|getInsetsController/,
  "必须走 WindowCompat.getInsetsController（API 26–29 的兼容路径），不能直接碰 window.insetsController");
assert.match(systemBarsKt, /setDecorFitsSystemWindows\(window, false\)/,
  "必须显式声明 edge-to-edge 契约并锁住 appearance 控制权，否则系统会在回前台时重算覆盖");
assert.match(systemBarsKt, /runOnUiThread/,
  "InsetsController 只能在主线程访问，必须切主线程");
assert.match(systemBarsKt, /catch \(_?[a-zA-Z]*: Throwable\)/,
  "原生回调抛异常不能连带拖崩 Activity");

/* ④c 用户报的「深色模式底部变白 / 浅色模式底部变深」的直接根因：
      isNavigationBarContrastEnforced 默认 true ⇒ 系统在透明导航栏下垫一层按**系统深浅**
      取的 scrim，把网页底色的那条盖成系统主题色。必须显式关掉，并把底色钉成透明。 */
assert.match(systemBarsKt, /isNavigationBarContrastEnforced = false/,
  "必须关掉导航栏对比度强制：那层 scrim 就是底部反相色带的直接来源（v0.272.5）");
assert.match(systemBarsKt, /isStatusBarContrastEnforced = false/,
  "状态栏同样要关：两处 scrim 都是按系统深浅画的，与网页主题无关");
assert.match(systemBarsKt, /window\.navigationBarColor = Color\.TRANSPARENT/,
  "导航栏底色必须钉成透明，露出网页 body 的 --bg（否则又回到系统主题色）");
assert.match(systemBarsKt, /window\.statusBarColor = Color\.TRANSPARENT/,
  "状态栏底色也必须透明：顶部是渐变头部，纯色会破坏 edge-to-edge");
assert.match(systemBarsKt, /VERSION_CODES\.Q[\s\S]*isNavigationBarContrastEnforced/,
  "对比度强制是 API 29+ 的属性，必须做版本门控（否则低版本直接崩）");

/* ④d 光在换主题那一刻设一次不够：系统会在 onResume / 配置变化时重算窗口属性，
      把透明底色与 scrim 开关一起打回默认 —— 这正是「重启后/切后台回来又变白」的成因。 */
assert.match(mainActivityKt, /override fun onResume\(\)\s*\{[\s\S]*?SystemBars\.reapply\(this\)/,
  "onResume 必须重放系统栏设置：系统会在这里按系统深浅重算窗口属性");
assert.match(mainActivityKt, /override fun onConfigurationChanged\([^)]*\)\s*\{[\s\S]*?SystemBars\.reapply\(this\)/,
  "系统深浅切换会重建窗口，onConfigurationChanged 也必须重放");

/* ⑤ 同步工具必须收录新 Kotlin 文件。
      gen/android 是 gitignored 生成目录，`tauri android init` 会整个重建 ⇒
      没进 SOURCES 的文件会在下次 init 后静默消失，手机端功能凭空没了。 */
assert.match(syncTool, /"SystemBarPlugin\.kt",/,
  "sync-android-native.js 的 SOURCES 必须收录 SystemBarPlugin.kt，否则重新 init 后会静默丢失");
assert.match(syncTool, /"SystemBars\.kt",/,
  "sync-android-native.js 的 SOURCES 必须收录 SystemBars.kt（v0.272.5 新增），否则重新 init 后底色修复凭空消失");

/* ⑥ 前提校验：这套修法成立的前提是「状态栏确实是覆盖在网页上的透明浮层」。
      若哪天 MainActivity 不再 enableEdgeToEdge()，本修复就变成多余的死代码 —— 
      断言在这里提醒重新评估，而不是继续带病运行。 */
assert.match(mainActivityKt, /enableEdgeToEdge\(\)/,
  "前提：MainActivity 必须仍是 edge-to-edge（状态栏为透明浮层），否则本同步机制失去意义");
assert.match(mainActivityKt, /s\.setProperty\('--sat'/,
  "前提：--sat 仍由原生注入，说明状态栏确实压着网页");

console.log("PASS: Android system-bar background stays transparent and its icons stay in phase with the web theme (nav-bar scrim disabled, re-applied on resume)");
