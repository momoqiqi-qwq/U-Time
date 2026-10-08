// Tauri 命令封装 —— 在纯浏览器里跑时自动降级到 localStorage（便于前端独立调试）
import { decodeWebBody } from "./webContent.js";
import { isMobilePreview, loadMobilePreviewData, saveMobilePreviewData } from "./mobilePreview.js";

const mobilePreview = typeof window !== "undefined" && window.parent !== window
  && /(?:^|[?&])mobile-preview=1(?:&|$)/.test(window.location?.search || "") && isMobilePreview();
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && !mobilePreview;

// 内嵌手机预览仅借用同源宿主的登录能力；数据保存和其他原生功能仍保持隔离。
const loginCommands = new Set(["http_session_new", "http_fetch", "http_session_export", "http_session_restore", "des_ecb_encrypt_hex", "plugin_vault_get"]);
function previewLoginHost() {
  if (!mobilePreview) return null;
  try {
    const host = window.parent;
    return host.location.origin === window.location.origin && typeof host.__TAURI_INTERNALS__?.invoke === "function" ? host : null;
  } catch { return null; }
}
async function invokeLogin(cmd, args = {}) {
  if (isTauri) return invoke(cmd, args);
  const host = previewLoginHost();
  if (!host || !loginCommands.has(cmd)) throw new Error(`命令 ${cmd} 的原生登录能力不可用`);
  return host.__TAURI_INTERNALS__.invoke(cmd, args);
}
const previewVault = new Map();
const previewVaultKey = (pluginId, key) => JSON.stringify([pluginId, key]);

async function invoke(cmd, args = {}) {
  if (!isTauri) throw new Error(`命令 ${cmd} 仅在 Tauri 环境可用`);
  return window.__TAURI_INTERNALS__.invoke(cmd, args);
}

async function cppuBridge(op, args) {
  const response = await fetch(`/__cppu/${op}`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(args)});
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || "本地警大网络桥不可用");
  return data.result;
}

const LS_KEY = "letime-data";
const LEGACY_LS_KEY = "tidebalance-data";

export const api = {
  isTauri,
  async setTaskbarBadge(count) {
    if (!isTauri) return false;
    return invoke("set_taskbar_badge", { count: Math.max(0, Math.floor(Number(count) || 0)) });
  },
  nativeSchedule: (action, bounds) => invoke("native_schedule", { action, bounds }),

  async loadData() {
    if (mobilePreview) return loadMobilePreviewData();
    if (isTauri) {
      const data = await invoke("load_data");
      if (data == null) throw new Error("本机数据为空或损坏，请恢复有效备份");
      return data;
    }
    const raw = localStorage.getItem(LS_KEY) ?? localStorage.getItem(LEGACY_LS_KEY);
    if (raw != null) {
      const data = JSON.parse(raw);
      if (data == null) throw new Error("本机数据为空或损坏，请恢复有效备份");
      return data;
    }
    return null;
  },

  async saveData(data) {
    if (mobilePreview) return saveMobilePreviewData(data);
    if (isTauri) return invoke("save_data", { data });
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  },

  async recoverData(data) {
    if (mobilePreview) return saveMobilePreviewData(data);
    if (isTauri) return invoke("recover_data", { data });
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    for (const key of [LS_KEY, LEGACY_LS_KEY]) {
      const raw = localStorage.getItem(key);
      if (raw != null) localStorage.setItem(`${key}:recovery:${suffix}`, raw);
    }
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  },

  // 托盘菜单「退出」的存盘回执：写完（或失败）后敲一下，Rust 收到就立即退出。
  // 浏览器里没有这个通道，退化成空操作。
  async quitAck() {
    if (isTauri) return invoke("quit_ack");
  },

  async listPlugins() {
    if (!isTauri) return [];
    return invoke("list_plugins");
  },

  async readPluginFile(relPath) {
    return invoke("read_plugin_file", { relPath });
  },

  async deletePlugin(id) {
    if (!isTauri) throw new Error("插件删除仅在 Tauri 环境可用");
    return invoke("delete_plugin", { id });
  },

  async importPluginZip(bytes) {
    if (!isTauri) throw new Error("插件导入仅在 Tauri 环境可用");
    return invoke("import_plugin_zip", { bytes });
  },

  async exportPluginsZip(ids) {
    if (!isTauri) throw new Error("插件导出仅在 Tauri 环境可用");
    return invoke("export_plugins_zip", { ids });
  },

  // 文本真正落盘到系统下载目录（<a download> 在 WebView 里对 blob: 不可靠）
  async saveDownload(name, contents) {
    if (!isTauri) throw new Error("保存文件仅在 Tauri 环境可用");
    return invoke("save_download", { name, contents });
  },

  // 二进制落盘：收 base64（与 httpFetch 的 binary: true 同格式），走同一个下载目录
  async saveDownloadBase64(name, base64) {
    if (!isTauri) throw new Error("保存文件仅在 Tauri 环境可用");
    return invoke("save_download_base64", { name, base64 });
  },

  async appInfo() {
    if (!isTauri) return { version: "web-dev", os: "browser", arch: navigator.platform || "web", dataDir: "localStorage（浏览器调试模式）" };
    return invoke("app_info");
  },

  /* 应用内更新（Rust 侧 src-tauri/src/update.rs，消费方 src/updateChecker.js）。
     全部「仅 Tauri」：浏览器里 return null 而不是抛错，让 updateChecker 的
     isUpdaterSupported() 判断能安静降级，不用到处 try/catch。 */
  async updateCheck() {
    if (!isTauri) return null;
    return invoke("update_check");
  },
  // 返回下载后落盘的绝对路径；size + digest 交给 Rust 做完整性校验。
  async updateDownload(url, name, size, digest) {
    if (!isTauri) return null;
    return invoke("update_download", { url, name, size, digest: digest || "" });
  },
  // Windows 上 Rust 会启动安装器后立刻 app.exit(0)，这个 Promise 可能等不到 resolve。
  async updateInstall(path) {
    if (!isTauri) return null;
    return invoke("update_install", { path });
  },
  // Android 专有：{ready, platform, reason}。其它平台恒为 {ready:true}。
  async updateReady() {
    if (!isTauri) return null;
    return invoke("update_ready");
  },
  // Android 专有：跳到「安装未知来源应用」授权页。
  async updateOpenInstallSettings() {
    if (!isTauri) return null;
    return invoke("update_open_install_settings");
  },

  /**
   * 把本应用交给系统卸载程序（Android 专有，见 src-tauri/src/uninstaller.rs）。
   * resolve 只代表「系统卸载界面已拉起」，用户在界面里点取消我们收不到。
   * 非 Android 平台返回 `{launched:false, reason}`，不是错误。
   */
  async appUninstall() {
    if (!isTauri) return null;
    return invoke("app_uninstall");
  },

  // 插件网络桥：Tauri 端由 Rust 发请求（绕开 CORS），浏览器端直接 fetch
  async httpGet(url) {
    if (isTauri) return invoke("http_get", { url });
    const r = await fetch(url);
    const contentType = r.headers.get("content-type") || "";
    // 不能直接用 r.text()：它按规范恒按 UTF-8 解，gb2312 站点会变乱码。
    return { status: r.status, body: decodeWebBody(new Uint8Array(await r.arrayBuffer()), contentType), finalUrl: r.url, contentType };
  },

  /**
   * 抓远程图标并返回 data URL。
   *
   * 为什么不让前端 `<img src>` 直接引用图标地址：Android 上页面来源是
   * `https://tauri.localhost`，WebView 默认禁混合内容 ⇒ 学校网站常见的
   * `http://…/favicon.ico` 会被静默拦掉（桌面端页面来源是 http，看不出问题）。
   * 走这里则由 Rust 抓取，不受 WebView 策略约束。
   */
  async httpGetIcon(url) {
    if (isTauri) return invoke("http_get_icon", { url });
    // 浏览器端兜底：网页版没有 WebView 那套混合内容限制。
    // 读 blob 仍受 CORS 约束，失败时上层会退回首字母兜底，不额外处理。
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    if (!/^image\//.test(blob.type) || /svg/.test(blob.type)) throw new Error("不是可用的图标格式");
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("读取图标失败"));
      reader.readAsDataURL(blob);
    });
  },

  async openExternal(url) {
    if (isTauri) return invoke("open_external", { url });
    window.open(url, "_blank");
  },

  /** 普通网页统一入口：按「应用内打开网页」偏好选择内置网页窗口或系统浏览器。 */
  async openUrl(url) {
    // uiPreferences 每次应用设置都会同步此 dataset；api.js 不反向 import store，避免循环依赖。
    const inApp = typeof document !== "undefined"
      && document.documentElement.dataset.openLinksInApp === "on";
    if (isTauri && inApp) {
      try { return await invoke("open_internal", { url }); }
      catch { /* 站点或平台不支持内置 WebView 时，保证链接仍然能打开 */ }
    }
    return api.openExternal(url);
  },

  /** 校园网站插件使用原生网页窗口：官方认证与资源访问在同一浏览器中完成。
   * 不导出 Cookie，不代理/重写登录页，不绕过官方页面的 CSP / X-Frame-Options。
   * 与普通链接偏好分离，失败时明确报错，不悄悄切到不共享会话的外部浏览器。
   */
  async openCampusSite(site) {
    const urls = { webvpn: "https://webvpn.cppu.edu.cn/", website: "https://www.cppu.edu.cn/" };
    if (!Object.hasOwn(urls, site)) throw new Error("不支持的校园网站入口");
    const url = urls[site];
    if (isTauri) { await invoke("open_internal", { url }); return { mode: "native" }; }
    const win = window.open(url, "_blank");
    if (!win) throw new Error("浏览器拦截了弹窗，请允许此页面打开窗口后重试");
    win.opener = null;
    return { mode: "browser" };
  },

  /** 一卡通固定站点的应用内窗口；不受普通链接打开偏好影响。 */
  async openCardPage(url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error("一卡通网页地址无效"); }
    if (parsed.origin !== "https://yktcard.cppu.edu.cn" || parsed.username || parsed.password || !parsed.pathname.startsWith("/campus-card/")) throw new Error("仅支持一卡通官方页面");
    if (isTauri) {
      try { await invoke("open_internal", { url: parsed.href }); } catch { throw new Error("应用内网页窗口打开失败，请重试"); }
      return { mode: "native" };
    }
    const win = window.open(parsed.href, "_blank");
    if (!win) throw new Error("请允许打开弹窗后重试");
    win.opener = null;
    return { mode: "browser" };
  },

  /** 插件专用会话打开：Rust 原生端从指定 HTTP Cookie Jar 注入后再打开 WebView。 */
  async openUrlWithHttpSession(url, sid) {
    if (!isTauri) return api.openUrl(url);
    return invoke("open_internal_with_http_session", { sid, url });
  },

  async schoolImportOpen(url, adapterScript, title) {
    if (isTauri) return invoke("school_import_open", { url, adapterScript, title });
    window.open(url, "_blank");
    throw new Error("在线教务脚本导入需要在 Le 时间管理客户端中使用");
  },

  async schoolImportListen(handler) {
    if (!isTauri) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    return listen("school-import-message", (event) => handler(event.payload));
  },

  // 会话化 HTTP：Tauri 端带 Cookie Jar（登录态跨请求保持）；浏览器端用 include 凭据
  async httpSessionNew() {
    if (isTauri || previewLoginHost()) return invokeLogin("http_session_new");
    return "browser-" + crypto.randomUUID();
  },

  async httpFetch(sid, method, url, opts = {}) {
    if (isTauri || previewLoginHost()) {
      return invokeLogin("http_fetch", {
        sid, method, url,
        headers: opts.headers || null,
        body: opts.body || null,
        binary: opts.binary || null,
        followRedirects: opts.followRedirects ?? null,
      });
    }
    if (import.meta.env.DEV && /^https:\/\/(sso|sso-jw|portal-jw)\.cppu\.edu\.cn(?:\/|$)/.test(url)) {
      api._cppuSessions ||= new Map();
      if (!api._cppuSessions.has(sid)) api._cppuSessions.set(sid, cppuBridge("session", {}));
      const cppuSid = await api._cppuSessions.get(sid);
      return cppuBridge("fetch", { sid: cppuSid, method, url, ...opts });
    }
    const r = await fetch(url, {
      method, headers: opts.headers, body: opts.body, credentials: "include",
      redirect: opts.followRedirects === false ? "manual" : "follow",
    });
    const contentType = r.headers.get("content-type") || "";
    const buf = new Uint8Array(await r.arrayBuffer());
    // 非二进制同样按声明编码解（见 decodeWebBody），别用 r.text() 恒按 UTF-8 解。
    const body = opts.binary ? btoa(String.fromCharCode(...buf)) : decodeWebBody(buf, contentType);
    return {
      status: r.status, body, finalUrl: r.url,
      contentType,
      location: r.headers.get("location") || "", cookies: [],
    };
  },

  async desEncryptHex(plain, key) {
    if (isTauri || previewLoginHost()) return invokeLogin("des_ecb_encrypt_hex", { plain, key });
    throw new Error("DES 加密仅支持在 Tauri 环境使用");
  },

  // 会话 Cookie 导出/恢复：让插件登录态跨应用重启（免验证码续期）
  async httpSessionExport(sid, urls) {
    if (!isTauri && !previewLoginHost()) return [];
    return invokeLogin("http_session_export", { sid, urls });
  },
  async httpSessionRestore(cookies) {
    if (!isTauri && !previewLoginHost()) return api.httpSessionNew();
    return invokeLogin("http_session_restore", { cookies });
  },

  // 插件密钥库：密码、会话票据等敏感数据保存在 Rust 侧 AES-256-GCM 加密文件，
  // 不进入 data.json / 普通备份。浏览器调试环境降级为 null（功能不可用但不崩）。
  async pluginVaultSet(pluginId, key, value) {
    if (mobilePreview) { previewVault.set(previewVaultKey(pluginId, key), value); return; }
    if (!isTauri) throw new Error("插件密钥库仅在 Tauri 应用中可用");
    return invoke("plugin_vault_set", { pluginId, key, value });
  },
  async pluginVaultGet(pluginId, key) {
    if (mobilePreview) {
      const id = previewVaultKey(pluginId, key);
      if (previewVault.has(id)) return previewVault.get(id);
      if (previewLoginHost()) return invokeLogin("plugin_vault_get", { pluginId, key });
      return null;
    }
    if (!isTauri) return null;
    return invoke("plugin_vault_get", { pluginId, key });
  },
  async pluginVaultDel(pluginId, key) {
    if (mobilePreview) { previewVault.set(previewVaultKey(pluginId, key), null); return; }
    if (!isTauri) return;
    return invoke("plugin_vault_del", { pluginId, key });
  },

  // 局域网联动服务
  async lanStart(port, token, allowPush = false) {
    if (!isTauri) throw new Error("仅 Tauri 环境可用");
    return invoke("lan_start", { port, token, allowPush });
  },
  async lanStop() {
    if (isTauri) return invoke("lan_stop");
  },
  async lanStatus() {
    if (!isTauri) return { running: false };
    return invoke("lan_status");
  },

  // 手机推回来的快照：桌面端确认后取原文 / 把决定回给手机。服务端从不自己写盘。
  async lanPushTake(id) {
    if (!isTauri) throw new Error("仅 Tauri 环境可用");
    return invoke("lan_push_take", { id });
  },
  async lanPushResolve(id, approve, note = "") {
    if (!isTauri) return false;
    return invoke("lan_push_resolve", { id, approve, note });
  },

  // AI 凭据只保存在 Rust 侧加密保险箱；不会进入 data.json / 普通备份。
  async aiVaultStatus() {
    if (!isTauri) return { configured: false, baseUrl: "", model: "", keyMasked: "" };
    return invoke("ai_vault_status");
  },
  async aiVaultSave(baseUrl, apiKey, model) {
    if (!isTauri) throw new Error("AI 加密凭据仅在 Tauri 应用中可用");
    return invoke("ai_vault_save", { baseUrl, apiKey, model });
  },
  async aiVaultClear() {
    if (!isTauri) return;
    return invoke("ai_vault_clear");
  },
  async aiChat(messages, temperature = 0.2) {
    if (!isTauri) throw new Error("AI 请求仅在 Tauri 应用中可用");
    return invoke("ai_chat", { messages, temperature });
  },
  async aiListModels(baseUrl, apiKey = "", forceRefresh = false) {
    if (!isTauri) throw new Error("模型列表查询仅在 Tauri 应用中可用");
    return invoke("ai_list_models", { baseUrl, apiKey, forceRefresh });
  },

  /**
   * 把网页的实际亮度同步给系统栏（状态栏 / 导航栏）的图标。
   *
   * 为什么必须同步：Android 端 enableEdgeToEdge() 后系统栏是**透明浮层**盖在 WebView 上，
   * 图标颜色却由 Android 按**系统深色模式**决定，与网页 `data-theme-mode` 无关。
   * 两者不一致时图标就消失在背景里（实测对比度 1.02 / 1.16，判据 3.0）。详见
   * `src-tauri/src/system_bar.rs` 与 `android/gradle/.../SystemBarPlugin.kt`。
   *
   * `darkIcons` 语义与 Android 的 `isAppearanceLightStatusBars` 一致：
   * **浅色背景 ⇒ true（要深色图标）**。
   *
   * 非 Tauri（纯浏览器调试）与桌面端都安全无副作用 —— 桌面端窗口不铺满整屏，
   * Rust 侧对非 Android 平台直接返回 `{applied:false}`，不报错。
   */
  async systemBar(darkIcons) {
    if (!isTauri) return { applied: false };
    return invoke("system_bar", { darkIcons });
  },

  /**
   * Android 系统通知与后台闹钟（Rust 侧 src-tauri/src/notification.rs → NotificationPlugin.kt）。
   *
   * 为什么非走原生不可：Android WebView **不实现 Web Notifications API**，
   * `window.Notification` 压根不存在；而且网页定时器不跨进程存活，应用被系统划掉之后
   * 到点不会有任何动静。要让提醒进下拉栏、要被杀了也响，只能交给原生通知 + AlarmManager。
   *
   * `action` 是原生命令名（status / askPermission / openSettings / openExactAlarmSettings /
   * post / cancel / setRing / syncAlarms / clearAlarms / takeActions），
   * `payload` 的字段原样透传给 Kotlin，字段名必须与 NotificationPlugin.kt 里读的键名一致。
   *
   * 非 Tauri 与桌面端都安全无副作用：Rust 侧对非 Android 平台直接返回 `{applied:false}`，
   * 不报错，所以调用方不必到处写平台判断（真正的门禁在 src/androidNotify.js）。
   */
  async notification(action, payload) {
    if (!isTauri) return { applied: false };
    return invoke("notification", { action, payload: payload || null });
  },
};
