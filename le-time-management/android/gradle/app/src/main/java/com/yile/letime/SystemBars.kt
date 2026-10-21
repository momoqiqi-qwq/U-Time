package com.yile.letime

import android.app.Activity
import android.graphics.Color
import android.os.Build
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * 系统栏（状态栏 / 导航栏）的**底色 + 图标明暗**统一控制点。
 *
 * ## 为什么需要这个文件（v0.272.5）
 *
 * v0.51.0 把系统栏**图标**的明暗接到了网页主题（`isAppearanceLightStatusBars` /
 * `isAppearanceLightNavigationBars`），但没管**底色**。于是「系统深色模式 ≠ 网页主题」时，
 * 底部导航栏会露出一条**与主题反相**的色带，图标同时与它融成一片：
 *
 * | 系统 | 网页 | 导航栏带底色 | 图标色 | 用户看到 |
 * |---|---|---|---|---|
 * | 浅色 | 深色 | 浅（scrim） | 白 | 底部一条**白**带，白图标消失 |
 * | 深色 | 浅色 | 深（scrim） | 近黑 | 底部一条**深**带，近黑图标消失 |
 * | 浅色 | 浅色 | 浅 | 近黑 | ✓ |
 * | 深色 | 深色 | 深 | 白 | ✓ |
 *
 * ## 那条色带是谁画的
 *
 * `Window.isNavigationBarContrastEnforced`（API 29+，**默认 true**）：
 * 即使把 `navigationBarColor` 设成透明，系统仍会在导航栏下面垫一层
 * **按系统深浅取的 scrim**。于是「透明浮层露出的网页底色」被这层 scrim 盖掉，
 * 看到的就是系统主题色 —— 与网页主题无关的那条带。
 *
 * `enableEdgeToEdge()` 一开始确实关了它，但只要之后有任何一处重设窗口属性
 * （切回前台、系统深浅切换、部分 ROM 的窗口重建），它就会回到默认 true。
 * 这也是为什么 v0.51.0 只修图标、症状仍在：**图标对了，底色是错的**。
 *
 * ## 修法
 *
 * 一个入口 [apply]，四件事一起做，**幂等**，可被反复调用：
 *
 * 1. 锁住 edge-to-edge 契约（`setDecorFitsSystemWindows(false)`）；
 * 2. 关掉状态栏 / 导航栏的**对比度强制**（那层 scrim）；
 * 3. 底色显式钉成**透明** —— 露出的就是网页 `body` 的 `--bg`，与主题天然同色；
 * 4. 图标明暗设为「与网页背景反相」。
 *
 * 调用点三处：前端换主题（[SystemBarPlugin]）、`onResume` 与 `onConfigurationChanged`
 * （[MainActivity] —— 系统正好在这两处重算窗口属性）。
 */
object SystemBars {

  /**
   * 最近一次前端告知的亮度（`true` = 深色图标，配浅色背景）。
   *
   * `onResume` 重放时用它：那时不该再去问网页一次（WebView 可能还没恢复，跨进程 eval 会丢）。
   */
  @Volatile
  private var darkIcons: Boolean = false

  /** 前端换主题 / 首帧同步时调用，记住并立即生效。 */
  fun setDarkIcons(activity: Activity, value: Boolean) {
    darkIcons = value
    apply(activity)
  }

  /** 系统可能重算窗口属性之后（`onResume` / 配置变化）重放一次当前值。 */
  fun reapply(activity: Activity) = apply(activity)

  private fun apply(activity: Activity) {
    // InsetsController 与窗口属性只能在主线程碰 —— 前端可能在任何时机调进来。
    activity.runOnUiThread {
      // 原生回调里抛异常不能连带拖崩 Activity：最坏退回系统默认，不影响可用性。
      try {
        val window = activity.window

        // ① 明确声明 edge-to-edge 契约：保持 decorFitsSystemWindows=false，
        //    并把 appearance 控制权留在我们手里。
        WindowCompat.setDecorFitsSystemWindows(window, false)

        // ② 关掉「透明系统栏下垫 scrim」。API 29 才有这个属性，默认是 true。
        //    底部那条与主题反相的色带就是它画的。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          window.isStatusBarContrastEnforced = false
          window.isNavigationBarContrastEnforced = false
        }

        // ③ 底色钉成透明：浮层下露出的就是网页 body 的 --bg，与主题同色。
        //    Android 15（API 35）起系统强制 edge-to-edge，这两行是 no-op —— 写了也无害。
        @Suppress("DEPRECATION")
        window.statusBarColor = Color.TRANSPARENT
        @Suppress("DEPRECATION")
        window.navigationBarColor = Color.TRANSPARENT

        // ④ 图标与网页背景反相：浅色背景 ⇒ 深色图标 ⇒ true。
        //    状态栏与导航栏必须同相，否则修好上面、下面又看不见。
        val controller: WindowInsetsControllerCompat =
          WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = darkIcons
        controller.isAppearanceLightNavigationBars = darkIcons
      } catch (_: Throwable) {
      }
    }
  }
}
