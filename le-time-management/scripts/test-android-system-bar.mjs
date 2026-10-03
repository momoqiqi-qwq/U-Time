import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => readProductSource(new URL(path, import.meta.url), "utf8");
const api = read("../src/api.js");
const theme = read("../src/theme.js");
const libRs = read("../src-tauri/src/lib.rs");
const systemBarRs = read("../src-tauri/src/system_bar.rs");
const pluginKt = read("../android/gradle/app/src/main/java/com/yile/letime/SystemBarPlugin.kt");
const mainActivityKt = read("../android/gradle/app/src/main/java/com/yile/letime/MainActivity.kt");
const syncTool = read("../../tools/sync-android-native.js");

/* ───────────── v0.51.0 回归：状态栏图标看不见 ─────────────
   现象（用户反馈）：手机端「设置 → API Key」页，状态栏的文字/电量看不见。

   根因（真浏览器实测）：Android 端 MainActivity 调 enableEdgeToEdge()，状态栏与导航栏
   是**透明浮层**盖在 WebView 上，系统栏图标直接压在网页顶部那一条的**实际底色**之上。
   而图标颜色是 Android 按**应用主题的 light/dark** 决定的（Theme.letime 继承
   Theme.MaterialComponents.DayNight.NoActionBar，只跟随**系统深色模式**），
   **完全不知道网页的 data-theme-mode**。两者不一致时图标必然消失在背景里：

   | 系统 | 网页 | 状态栏带底色 | 图标 | 对比度 | |
   |---|---|---|---|---|---|
   | 深色 | 浅色 | 浅 rgb(253,253,252) | 白 | 1.02 | 看不见 |
   | 浅色 | 深色 | 深 rgb(42,38,32) | 近黑 | 1.16 | 看不见 |
   | 深色 | 深色 | 深 | 白 | 15.04 | ✓ |
   | 浅色 | 浅色 | 浅 | 近黑 | 17.10 | ✓ |

   判据 3.0 = 图形元素对比度下限。设置弹窗是 inset:0 全屏贴顶，「设置 → API Key」
   那一页最容易撞上（用户报的就是这页）。

   修法：网页每次解析出真实亮度就同步给原生，由 isAppearanceLightStatusBars 覆盖
   系统默认值 ⇒ 无论系统深色/浅色，图标永远与网页实际背景反相。

   本测试钉住**四段链路**，任一环断开就报红。 */

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
      底部导航栏同样是透明浮层，只修上面会让下面看不见。 */
assert.match(pluginKt, /class SystemBarPlugin\(private val host: Activity\) : Plugin\(host\)/,
  "SystemBarPlugin 必须按 Tauri 插件约定接收 Activity");
assert.match(pluginKt, /@Command\s*\n\s*fun setDarkIcons\(invoke: Invoke\)/,
  "必须有 @Command setDarkIcons");
assert.match(pluginKt, /@InvokeArg\s*\n\s*class SystemBarArgs\s*\{[\s\S]*?var darkIcons: Boolean = false/,
  "SystemBarArgs 必须有 darkIcons 字段（且给默认值，缺参时不崩）");
assert.match(pluginKt, /isAppearanceLightStatusBars = darkIcons/,
  "必须用 isAppearanceLightStatusBars 覆盖状态栏图标明暗");
assert.match(pluginKt, /isAppearanceLightNavigationBars = darkIcons/,
  "导航栏也必须同相设置：底部同样是透明浮层，只修状态栏会让底部看不见");
assert.match(pluginKt, /WindowInsetsControllerCompat|getInsetsController/,
  "必须走 WindowCompat.getInsetsController（API 26–29 的兼容路径），不能直接碰 window.insetsController");
assert.match(pluginKt, /setDecorFitsSystemWindows\(host\.window, false\)/,
  "必须显式声明 edge-to-edge 契约并锁住 appearance 控制权，否则系统会在回前台时重算覆盖");
assert.match(pluginKt, /runOnUiThread/,
  "InsetsController 只能在主线程访问，必须切主线程");
assert.match(pluginKt, /catch \(_?[a-zA-Z]*: Throwable\)/,
  "原生回调抛异常不能连带拖崩 Activity");

/* ⑤ 同步工具必须收录新 Kotlin 文件。
      gen/android 是 gitignored 生成目录，`tauri android init` 会整个重建 ⇒
      没进 SOURCES 的文件会在下次 init 后静默消失，手机端功能凭空没了。 */
assert.match(syncTool, /"SystemBarPlugin\.kt",/,
  "sync-android-native.js 的 SOURCES 必须收录 SystemBarPlugin.kt，否则重新 init 后会静默丢失");

/* ⑥ 前提校验：这套修法成立的前提是「状态栏确实是覆盖在网页上的透明浮层」。
      若哪天 MainActivity 不再 enableEdgeToEdge()，本修复就变成多余的死代码 —— 
      断言在这里提醒重新评估，而不是继续带病运行。 */
assert.match(mainActivityKt, /enableEdgeToEdge\(\)/,
  "前提：MainActivity 必须仍是 edge-to-edge（状态栏为透明浮层），否则本同步机制失去意义");
assert.match(mainActivityKt, /s\.setProperty\('--sat'/,
  "前提：--sat 仍由原生注入，说明状态栏确实压着网页");

console.log("PASS: Android system-bar icon contrast follows the web theme (all four system/web brightness combinations stay legible)");
