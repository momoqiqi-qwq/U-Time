package com.yile.letime

import android.content.res.Configuration
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * 主 Activity。
 *
 * ## 本文件是「版本化镜像」，不是生成物
 *
 * `src-tauri/gen/android/` 是 Tauri 的生成目录（gitignored），**重新 `tauri android init`
 * 会把它整个清掉** —— 而手机端真正干活的代码只活在那里。所以原生代码的事实源放在
 * `le-time-management/android/gradle/`（本文件就是），由 `tools/sync-android-native.js`
 * 幂等同步进 `gen/android/`；`scripts/build-android-apk.sh` 构建前会先跑一次 `--check`。
 *
 * **改这份文件，不要去改 gen 里的副本**（改了会在下次同步时被覆盖，且提交不进 git）。
 *
 * ## 为什么要手动注入安全区（v0.37.15）
 *
 * `enableEdgeToEdge()` 让窗口铺满整屏、状态栏/导航栏变成**透明浮层**画在 WebView 之上。
 * Android 的约定是：既然应用声明了 edge-to-edge，就该由应用自己消费 WindowInsets。
 *
 * 但 **Android WebView 不实现 CSS 环境变量 `env(safe-area-inset-*)`** —— 无论
 * `viewport-fit=cover` 写不写，取值恒为 0。于是 `styles.css` 里那一整套
 * `padding-top: env(safe-area-inset-top, 0px)` 在手机上全部退化成 `0px`：
 * 顶栏从屏幕绝对顶部开始绘制，「设置」标题与副标题正好压在状态栏图标（信号/电量）下面，
 * 右上角的窗口按钮也被状态栏覆盖。
 *
 * 修复：在原生侧读真实 inset，通过 `--sat/--sab/--sal/--sar` 四个 CSS 变量注入网页。
 * 前端把 `env(safe-area-inset-top, 0px)` 写成 `var(--sat, env(safe-area-inset-top, 0px))`
 * —— Android 走注入值，桌面 / iOS 走原生 `env()` 兜底，两条路径互不干扰。
 *
 * 用 `onWebViewCreate` 钩子而不是反射取 WebView：WryActivity 已经暴露了这个回调点。
 *
 * ## 返回键与双指缩放（v0.37.17）
 *
 * 三件事都落在同一个 Activity 上，一起记在这里：
 *
 * 1. **返回键**：Tauri 的 `TauriActivity` 把 wry 的 `handleBackNavigation` 固定成了 `false`
 *    （wry 自己的默认值是 `true`），于是 Android 返回键完全不碰 WebView 历史，直接结束
 *    Activity —— 用户看到的就是「一按返回就退出软件」。这里覆盖回 `true`，wry 的策略即
 *    「WebView 能回退就 goBack()，不能回退才 finish」。前端 `src/backNav.js` 负责压历史
 *    （切视图 / 浮层哨兵），所以返回键会先回上一个界面、关掉最上层弹窗，全部退完才退出。
 *    教务导入窗口（SchoolImportActivity）直接继承 TauriActivity，仍是 `false`，
 *    保持「返回键 = 关闭该窗口」，这是刻意的。
 *
 * 2. **双指缩放**：WebView 默认不启用内置缩放机制（`builtInZoomControls = false`），
 *    叠加 index.html 里 viewport 的 `user-scalable=no`，就完全缩放不了。这里打开内置缩放
 *    并隐藏它自带的 +/- 悬浮件，由前端 `src/mobileViewport.js` 在 Android 下放开
 *    `user-scalable`；两边缺一不可。
 *
 * 3. **安全区注入**：见上文。
 */
class MainActivity : TauriActivity() {

  /** 返回键交回 wry 处理（详见类注释第 1 条）。 */
  override val handleBackNavigation: Boolean = true

  private var webView: WebView? = null
  private var appliedInsetSignature: String? = null

  /**
   * 在 `enableEdgeToEdge()` 之前生效的兜底 inset。
   *
   * `onWebViewCreate` 早于第一帧 WindowInsets 分发，此时 `ViewCompat.getRootWindowInsets`
   * 可能返回 null。这份从系统资源读出的高度能让首屏就不重叠，之后被真实 inset 覆盖。
   */
  private val fallbackTopPx: Int by lazy {
    val id = resources.getIdentifier("status_bar_height", "dimen", "android")
    if (id > 0) resources.getDimensionPixelSize(id) else 0
  }

  private val fallbackBottomPx: Int by lazy {
    val id = resources.getIdentifier("navigation_bar_height", "dimen", "android")
    if (id > 0) resources.getDimensionPixelSize(id) else 0
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // 竖屏吸顶是主场景；但横屏 / 折叠屏展开时状态栏会跑到侧边（左刘海），
    // 所以四个方向一起监听，不能只取 top/bottom。
    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      // ⚠️ --sab 只代表导航栏高度，绝不能掺 ime（v0.49.0 修的黑屏 bug）：
      // 旧写法 maxOf(bars.bottom, ime.bottom) 在键盘弹出时把 --sab 撑到 ~370px，
      // .view 的 padding-bottom、toast、抽屉底栏全部跟着暴涨 —— 页面被凭空撑长一大截，
      // 聚焦输入框时 Chrome 的 scrollIntoView 把 WebView 滚进这段空白 → 整屏只剩背景色。
      // 键盘避让的职责已移交给下面的 WebView ime listener（压缩网页视口）。
      val bottom = bars.bottom
      applyInsets(bars.top, bottom, bars.left, bars.right)
      // 交还系统继续分发：WebView 自己也要拿到 insets，否则软键盘避让会失效。
      ViewCompat.onApplyWindowInsets(view, insets)
    }
    // 主动请求一次，避免只依赖被动回调。
    ViewCompat.requestApplyInsets(window.decorView)
  }

  /**
   * 回到前台后重放系统栏设置（v0.272.5）。
   *
   * 系统会在 `onResume` / 配置变化时按**系统深色模式**把窗口属性重算一遍：
   * `navigationBarColor` 回到主题背景色、`isNavigationBarContrastEnforced` 回到 true。
   * 结果就是底部导航栏露出一条与网页主题反相的色带 —— 深色模式时变白、浅色模式时变深，
   * 图标同时融进去。前端只会在换主题那一刻同步一次，回来时没人补，所以这里必须重放。
   *
   * [SystemBars.reapply] 幂等，代价只有几次窗口属性赋值。
   */
  override fun onResume() {
    super.onResume()
    SystemBars.reapply(this)
  }

  /** 系统深浅模式切换会走这里（DayNight 主题重建窗口），同样要重放。 */
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    SystemBars.reapply(this)
  }

  /**
   * 长鸣进行中不能把 WebView 冻住（v0.73.0）。
   *
   * `WryActivity.onPause()` 会调 `mWebView.onPause()` 挂起页面定时器，而持续提醒的
   * 循环调度与「最长响铃」自动停 watchdog 全跑在这些定时器上 —— 用户一退到后台或
   * 按灭屏幕，铃声就响到一半静掉，「持续提醒」直接退化成一响即停。
   * 所以这里在长鸣期间立刻把 WebView 拉回 running；只补这一句，其余生命周期行为不动
   * （Activity 该暂停照常暂停，只是网页不被冻）。
   */
  override fun onPause() {
    super.onPause()
    if (ReminderHub.ringActive) {
      try {
        webView?.onResume()
      } catch (_: Throwable) {
      }
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView

    // 键盘避让（v0.49.0）：把 ime inset 真正消费掉 —— 压缩网页视口而不是挪窗口。
    //
    // 为什么必须自己做：enableEdgeToEdge() 即 decorFitsSystemWindows=false，
    // 此模式下系统的 `adjustResize` 不再生效（不会压缩内容视图），默认的
    // `adjustPan` 只把窗口整体上移、网页视口毫无变化 —— 输入框照样被键盘物理盖住，
    // 叠加 scrollIntoView 后就是「键盘弹出整屏只剩背景色」的黑屏。
    // 官方姿势是监听 ime() inset 由应用自己消费；消费方式用 WebView 的
    // bottomMargin 而不是 setPadding —— **WebView 不尊重 padding**（网页铺满
    // view 边界，padding 会被无视），而它父容器是 FrameLayout（wry 的实现），
    // MATCH_PARENT 高度会减去 bottomMargin，等于把网页视口压短。
    //
    // 网页侧的连锁反应都是现成的：视口变矮 → window resize → uiScale.js 重算
    // --ui-vh/--ui-vw → 媒体查询与 fixed 浮层自动重排；Chrome 会把聚焦的输入框
    // scrollIntoView 到键盘上方的可见区。键盘收起时 ime.bottom 回 0，margin 复原。
    ViewCompat.setOnApplyWindowInsetsListener(webView) { v, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      val lp = v.layoutParams
      if (lp is ViewGroup.MarginLayoutParams) {
        if (lp.bottomMargin != ime.bottom) {
          lp.bottomMargin = ime.bottom
          v.layoutParams = lp
        }
      }
      // ime 已由我们消费：剥掉再往下传，防止子层级二次消费（WebView 无子级，纯防御）。
      WindowInsetsCompat.Builder(insets)
        .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
        .build()
    }

    // 双指缩放：打开内置缩放机制并隐藏 +/- 悬浮件（配合 mobileViewport.js 放开 user-scalable）
    webView.settings.apply {
      setSupportZoom(true)
      builtInZoomControls = true
      displayZoomControls = false
    }

    // WebView 刚建好时页面还没加载，注入会丢失；用兜底值先铺一层底，
    // 真实值会在 WindowInsets 回调里补上（那时页面早已 ready）。
    // 另挂 WebViewClient：每次页面加载完补注入一次，覆盖导航 / 前端热重载把
    // documentElement 内联样式重置掉的场景。
    webView.webViewClient = object : android.webkit.WebViewClient() {
      override fun onPageFinished(view: WebView, url: String?) {
        super.onPageFinished(view, url)
        appliedInsetSignature = null   // 新文档会丢掉内联变量，清签名强制重发
        lastKnownInsets?.let { applyInsets(it.top, it.bottom, it.left, it.right) }
      }
    }
    applyInsets(fallbackTopPx, fallbackBottomPx, 0, 0)
  }

  /** 最近一次已知的真实 inset，供 onPageFinished 补注入用。 */
  private var lastKnownInsets: InsetBox? = null

  private data class InsetBox(val top: Int, val bottom: Int, val left: Int, val right: Int)

  /** 把 inset 写成 CSS 变量。重复值不重发，避免每次 insets 回调都跨进程 eval。 */
  private fun applyInsets(top: Int, bottom: Int, left: Int, right: Int) {
    lastKnownInsets = InsetBox(top, bottom, left, right)
    val signature = "$top|$bottom|$left|$right"
    if (signature == appliedInsetSignature) return
    appliedInsetSignature = signature

    val js = buildString {
      append("(function(){var s=document.documentElement.style;")
      append("s.setProperty('--sat','${top}px');")
      append("s.setProperty('--sab','${bottom}px');")
      append("s.setProperty('--sal','${left}px');")
      append("s.setProperty('--sar','${right}px');")
      append("})();")
    }

    // 跨进程 IPC，必须在主线程，且 WebView 未就绪时要吞掉异常 ——
    // 这里出问题不能连带把 Activity 拖崩。
    val view = webView ?: return
    view.post {
      try {
        view.evaluateJavascript(js, null)
      } catch (e: Throwable) {
        // 页面正在销毁 / 尚未 attach：忽略，并清掉签名让下一次 insets 回调重试。
        appliedInsetSignature = null
      }
    }
  }
}
