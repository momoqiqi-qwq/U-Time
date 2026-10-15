# v0.221.0

## 功能

- **警大邮箱内置网页窗口**：警大通知插件「校园服务 → 警大邮箱」不再甩到系统浏览器，改为在应用内 WebView 里打开 Coremail 新版前端 Sirius Web（`/static/sirius-web/?version=…#mailbox`）。点一下仍先用插件密钥库里的账号密码在 native 会话里自动登录，再由宿主把该会话 `mail.cppu.edu.cn` 域的 Cookie 注入窗口，窗口里不用再登一遍；`sid` 不出现在窗口 URL 与浏览历史里。
- **登录态注入改成站点白名单**：宿主 `open_internal_with_http_session` 过去只认学习通域名，现在按站点白名单注入（学习通 / 警大邮箱），白名单外的站点一律拿不到这批凭据。
- **新宿主 API**：`tide.util.openMailPage(url, sid)` —— 仅对警大通知插件开放；不带会话时只要 `openUrl` 权限，带会话时同时要求 `http` 权限（与 `openUrlWithSession` 同一口径）。窗口打开失败时插件退回不带会话的内置窗口，入口不会点了没反应。

## 影响范围

- 桌面端（Windows）与 Android 走同一套内置 WebView 窗口；Android WebView 仍由宿主注入 `--sat/--sab/--sal/--sar`，插件侧不重复垫。
- 小程序端插件标记为 unavailable，无变化。
- 无数据迁移。
