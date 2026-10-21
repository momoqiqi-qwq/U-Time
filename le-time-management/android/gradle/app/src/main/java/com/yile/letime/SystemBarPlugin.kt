package com.yile.letime

import android.app.Activity
import android.os.Build
import androidx.core.view.WindowCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

/**
 * 系统栏（状态栏 / 导航栏）图标明暗桥。
 *
 * ## 这个文件解决什么问题
 *
 * `MainActivity` 调了 `enableEdgeToEdge()`，状态栏与导航栏变成**透明浮层**盖在 WebView 上：
 * 系统栏里那些图标（时间、信号、电量、返回手势条）**直接压在网页顶部/底部那一条上**。
 *
 * 而图标的颜色是 Android 按**应用主题的 light/dark** 决定的，`Theme.letime` 继承
 * `Theme.MaterialComponents.DayNight.NoActionBar` —— 它只跟随**系统深色模式**
 * （即 `prefers-color-scheme`），**完全不知道网页里的 `data-theme-mode`**。
 *
 * 于是「网页主题」与「系统深色模式」一旦不一致，状态栏图标必然消失在背景里：
 *
 * | 系统 | 网页 | 状态栏带底色 | 图标色 | 结果 |
 * |---|---|---|---|---|
 * | 深色 | 浅色 | 浅（rgb 253,253,252） | 白 | 对比 **1.02** ⇒ 看不见 |
 * | 浅色 | 深色 | 深（rgb 42,38,32）  | 近黑 | 对比 **1.16** ⇒ 看不见 |
 * | 深色 | 深色 | 深 | 白 | 15.04 ✓ |
 * | 浅色 | 浅色 | 浅 | 近黑 | 17.10 ✓ |
 *
 * （对比度由真浏览器探针实测，判据 3.0 是图形元素的下限。设置弹窗是 `inset:0` 全屏浮层，
 * 头部直接顶到屏幕绝对顶部，所以「设置 → API Key」那一页最容易撞上。）
 *
 * ## 修法
 *
 * 网页每次解析出真实亮度（`resolved.mode`）就调一次 [setDarkIcons]，
 * 实际的窗口写入在 [SystemBars] 里完成 —— **底色（透明）与图标明暗一起设**。
 * 这样无论系统是深色还是浅色，底部/顶部那条永远是网页自己的背景色，
 * 图标与它反相 —— 根治。
 *
 * ## 为什么状态栏与导航栏一起设
 *
 * 底部导航栏同样是透明浮层盖在网页上，底栏区域的底色也跟着主题走，两个必须保持同相，
 * 否则修好上面、下面又看不见了。两者一起设，用同一个布尔值。
 *
 * ## ⚠️ 只设图标不够（v0.272.5）
 *
 * 用户反馈：**深色模式时底部是白色，浅色模式时底部是深色** —— 图标反而不重要，
 * 是导航栏**底色**被系统按系统深色模式垫了一层 scrim（`isNavigationBarContrastEnforced`）。
 * 只看图标明暗的旧实现在这种场景下永远修不好，必须连底色一起钉成透明。详见 [SystemBars]。
 *
 * ## 为什么用 WindowInsetsControllerCompat 而不是 window.insetsController
 *
 * 前者对 API 26–29 走 `SYSTEM_UI_FLAG_LIGHT_STATUS_BAR`，API 30+ 走
 * `WindowInsetsController`，一套代码全兼容 —— 本项目 minSdk 覆盖了这个区间，
 * 直接写 `window.insetsController` 在 API 30 以下会崩。
 *
 * ## 时序
 *
 * [`light`] 初值取 **false**（即「深色图标」不合语义，这里语义是 "light icons" 的反面）
 * —— 具体见参数注释；前端在首帧就会同步一次真实值，且 `applyInsets` 走
 * `onPageFinished` 补注入的同一条路径，所以不存在长时间留错的窗口。
 */
@InvokeArg
class SystemBarArgs {
  /**
   * 图标是否要用**深色**（`true` = 深色图标，配浅背景）。
   *
   * 命名刻意与 `isAppearanceLightStatusBars` 一致：Android 的 API 叫
   * `isAppearanceLightStatusBars`，语义是「状态栏外观是否为浅色（把图标画成深色）」。
   * 前端传 `mode === "light"` 正好对上 —— 浅色主题 ⇒ 深色图标 ⇒ 传 true。
   */
  var darkIcons: Boolean = false
}

@TauriPlugin
class SystemBarPlugin(private val host: Activity) : Plugin(host) {

  /**
   * 设置状态栏与导航栏的图标明暗。
   *
   * 前端在**每次**主题/亮度变化后调用（`paintTheme` 里），需幂等 —— 重复设同一个值无害。
   */
  @Command
  fun setDarkIcons(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(SystemBarArgs::class.java)
    } catch (error: Exception) {
      return invoke.reject("系统栏参数不合法：${error.message}")
    }
    // 底色 + 图标的实际写入都在 SystemBars 里（v0.272.5 把底色一起接管了）。
    SystemBars.setDarkIcons(host, args.darkIcons)
    invoke.resolve(JSObject().apply { put("darkIcons", args.darkIcons) })
  }

  /**
   * 只读查询当前生效值，供探针 / 自检使用。
   *
   * 注意 `isAppearanceLightStatusBars` 的读取在 API 30+ 依赖 `InsetsController`，
   * 拿不到时返回 null —— 前端不要把 null 当 false。
   */
  @Command
  fun getDarkIcons(invoke: Invoke) {
    val controller = WindowCompat.getInsetsController(host.window, host.window.decorView)
    invoke.resolve(
      JSObject().apply {
        put("platform", "android")
        put("api", Build.VERSION.SDK_INT)
        put("darkIcons", controller.isAppearanceLightStatusBars)
      }
    )
  }

  /**
   * 实际写值已迁到 [SystemBars]（v0.272.5）。
   *
   * 原因：只设图标明暗不够 —— 导航栏在 `isNavigationBarContrastEnforced=true` 时
   * 会被系统垫一层**按系统深浅取的 scrim**，露出与网页主题反相的色带，
   * 图标照样融进去。底色也必须由我们钉成透明，两件事必须原子地一起做，
   * 且要能在 `onResume` 后从 [MainActivity] 重放 —— 所以抽成对象而不是留在插件里。
   */
}
