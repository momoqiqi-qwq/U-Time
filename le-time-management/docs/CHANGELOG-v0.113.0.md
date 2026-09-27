# v0.113.0

## 学习通登录态转交

- 学习通插件已登录后，打开通知或课程页面会将插件的 native HTTP 会话 Cookie 注入到新建的应用内 WebView，再导航到目标页面。
- 覆盖账号密码登录与手动 Cookie 登录；手动 Cookie 登录会先恢复到插件 HTTP Cookie Jar。
- Cookie 只在 Rust/native 层处理，并限制到 HTTPS 的 `chaoxing.com` 域名；不会放进 URL 或暴露给网页脚本。Android 使用原生 `CookieManager` 写入，不依赖 Wry Android 的无操作 `set_cookie`。
- 通知中的外站链接不再使用学习通 Cookie 做登录探测。

## 影响范围与迁移

- 影响 Windows 桌面端、Android 客户端；无数据结构迁移。
- 模拟器/构建验证不能替代实体 Android 设备人工验收；发布前仍需在真实设备登录后分别点击一条通知和一门课程，确认自动登录并到达目标页。
