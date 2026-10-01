package com.yile.letime

import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/**
 * 普通网页的应用内 WebView 容器（open_internal 在 Android 上通过
 * `activity_name("BrowserActivity")` 指定）。与教务导入窗口隔离，避免普通网页
 * 继承教务桥接脚本或专用生命周期；系统返回键由 TauriActivity 负责关闭本页。
 *
 * 本文件是版本化镜像，tools/sync-android-native.js 会同步到 gen/android。
 */
class BrowserActivity : TauriActivity() {
  private val prefs get() = getSharedPreferences("letime-browser-favorites", Context.MODE_PRIVATE)
  private val handler = Handler(Looper.getMainLooper())
  private var page: WebView? = null
  private var zoom = 100
  private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
  private fun valid(url: String) = url.startsWith("https://") || url.startsWith("http://")
  private fun favorites(): MutableList<JSONObject> = try {
    val rows = JSONArray(prefs.getString("items", "[]"))
    (0 until rows.length()).mapNotNull { rows.optJSONObject(it) }.filter { valid(it.optString("url")) }.toMutableList()
  } catch (_: Exception) { mutableListOf() }
  private fun save(items: List<JSONObject>) { prefs.edit().putString("items", JSONArray(items.take(200)).toString()).apply() }
  private fun seedFavorites() {
    if (prefs.getBoolean("defaults-v2", false)) return
    val saved = favorites()
    for ((title, id) in listOf("选课" to "37mz91XBnBIljahBQSs", "我的学分" to "RMX4lNNDjXaz3b2oz8B")) {
      val url = "https://jw.cppu.edu.cn/index.html#utime-menu=$id"
      if (saved.none { it.optString("url") == url }) saved.add(JSONObject().put("title", title).put("url", url))
    }
    save(saved); prefs.edit().putBoolean("defaults-v2", true).apply()
  }
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    page = webView
    seedFavorites()
    webView.post {
      val parent = webView.parent as? ViewGroup ?: return@post
      val index = parent.indexOfChild(webView)
      val params = webView.layoutParams
      parent.removeView(webView)
      val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setBackgroundColor(Color.rgb(23, 24, 28)) }
      row.addView(webView, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
      val rail = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
      val scroll = ScrollView(this).apply { isFillViewport = true; addView(rail) }
      row.addView(scroll, LinearLayout.LayoutParams(dp(48), ViewGroup.LayoutParams.MATCH_PARENT))
      parent.addView(row, index, params)
      fun button(text: String, label: String, run: () -> Unit): Button {
        val button = Button(this).apply {
          this.text = text; contentDescription = label; textSize = 20f
          setTextColor(Color.rgb(215, 217, 223)); setBackgroundColor(Color.TRANSPARENT)
          minWidth = 0; minimumWidth = 0; minHeight = 0; minimumHeight = 0; setPadding(0, 0, 0, 0)
          setOnClickListener { run() }
        }
        rail.addView(button, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)))
        return button
      }
      button("↻", "刷新网页") { webView.reload() }
      button("‹", "后退") { if (webView.canGoBack()) webView.goBack() }
      button("›", "前进") { if (webView.canGoForward()) webView.goForward() }
      val favorite = button("☆", "收藏当前页") {
        val url = webView.url ?: return@button
        if (!valid(url)) return@button
        val saved = favorites(); val existing = saved.indexOfFirst { it.optString("url") == url }
        if (existing >= 0) saved.removeAt(existing) else saved.add(0, JSONObject().put("url", url).put("title", webView.title ?: url))
        save(saved)
      }
      button("☰", "查看收藏") { showFavorites(webView) }
      button("⧉", "复制网页地址") {
        (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("网页地址", webView.url ?: ""))
      }
      val minus = button("−", "缩小网页") { val next = (zoom - 10).coerceAtLeast(75); webView.zoomBy(next.toFloat() / zoom); zoom = next }
      button("＋", "放大网页") { val next = (zoom + 10).coerceAtMost(150); webView.zoomBy(next.toFloat() / zoom); zoom = next }
      val update = object : Runnable {
        override fun run() {
          if (isFinishing || isDestroyed) return
          val url = webView.url ?: ""
          favorite.text = if (favorites().any { it.optString("url") == url }) "★" else "☆"
          minus.contentDescription = "缩小网页，当前 $zoom%"
          if (valid(url) && webView.progress == 100) {
            val uri = android.net.Uri.parse(url); val origin = "${uri.scheme}://${uri.authority}"
            if (!prefs.getBoolean("imported:$origin", false)) {
              webView.evaluateJavascript("(() => {try{return JSON.parse(localStorage.getItem('__utime_browser_favorites_v1')||'[]')}catch(_){return []}})()") { raw ->
                try {
                  val old = JSONTokener(raw).nextValue() as? JSONArray ?: return@evaluateJavascript
                  val saved = favorites()
                  for (i in 0 until old.length().coerceAtMost(100)) {
                    val entry = old.optJSONObject(i) ?: continue
                    if (valid(entry.optString("url")) && saved.none { it.optString("url") == entry.optString("url") }) saved.add(entry)
                  }
                  save(saved); prefs.edit().putBoolean("imported:$origin", true).apply()
                } catch (_: Exception) {}
              }
            }
          }
          handler.postDelayed(this, 1000)
        }
      }
      handler.post(update)
    }
  }
  private fun showFavorites(webView: WebView) {
    val saved = favorites()
    AlertDialog.Builder(this).setTitle("收藏网页（长按移除）")
      .setItems(saved.map { it.optString("title", it.optString("url")) }.toTypedArray()) { _, index -> webView.loadUrl(saved[index].optString("url")) }
      .setNegativeButton("关闭", null)
      .create().also { dialog ->
        dialog.setOnShowListener { dialog.listView.setOnItemLongClickListener { _, _, index, _ -> saved.removeAt(index); save(saved); dialog.dismiss(); showFavorites(webView); true } }
        dialog.show()
      }
  }
  override fun onDestroy() { handler.removeCallbacksAndMessages(null); page = null; super.onDestroy() }
}
