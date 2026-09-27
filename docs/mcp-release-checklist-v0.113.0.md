# 真机回归清单 · v0.113.0

> 本版本验收重点：学习通插件已经验证的登录 Cookie 能否随“浏览器打开（带登录态）”进入应用内网页。
> 构建与自动化测试不等于实体设备验收；目前所有人工项均保持未勾选。

## 学习通登录态转交

- [ ] Android 实体手机：账号密码登录学习通插件，打开一条需要登录的通知，确认无需再次登录并到达目标页。
- [ ] Android 实体手机：打开一门课程门户，确认无需再次登录并到达课程页。
- [ ] Android 实体手机：手动 Cookie 登录后重复通知与课程页面验证。
- [ ] Windows：用插件账号密码登录后，分别打开通知与课程页面，确认应用内浏览器复用会话。
- [ ] 检查学习通登录态只注入 HTTPS `chaoxing.com` 及其子域名；通知外站链接不带 Cookie。

## 构建与自动化验证

- [x] `sync-version.js --check`、`gen-theme-dark.js --check`、`build-schedule-plugin.js --check`、`sync-android-native.js --check` 全部通过。
- [x] `npm test`：82 个测试脚本全部通过。
- [x] Windows NSIS 与 MSI 安装包构建成功。
- [x] Android universal APK 构建成功，包含 arm64-v8a 与 x86_64。
- [ ] 若使用模拟器，仅记录为模拟器冒烟；不得替代上面的实体设备验收。
