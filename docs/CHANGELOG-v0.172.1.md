# v0.172.1 · 插件中心的介绍也吃「显示介绍」开关

## 改了什么

- 「设置 → 插件 → 显示介绍」关掉后，**插件中心的卡片照旧满屏描述** —— 这个开关从加进来那天起就只管一半。
- 原因是两处列表不是同一套 DOM。设置页那份是 `.settings-section .plug-card .pd`，CSS 里的 off 规则写的就是它；插件中心是 `.market` → `.market-grid` → `.mcard.market-manage-card` → `.market-card-desc`，从来没有任何规则把它跟 `data-plugin-descriptions` 关联过。
- 现在同一条 off 规则同时覆盖两个选择器。插件中心那条**不能带 `.settings-section` 前缀** —— 它在 `.view` 里渲染，不在设置区内，加了前缀就又管不上了。
- 补了回归断言：`scripts/test-ui-preferences.mjs` 直接读 `src/styles.css`，要求这条 off 规则同时含 `.settings-section .plug-card .pd` 与 `.market-card-desc`，且动作为 `display: none !important`。以后谁再往其中一处改类名，测试会红。
- 窄屏（≤ 900px）另有媒体查询会把描述与作者行一起收起，那是版面取舍、与开关无关，本次未改。

## 影响范围与数据迁移

- Windows / Web / Android 共用 `src/styles.css`，三端同时生效。开关默认关，所以升级后插件中心会**从「一直显示描述」变成「默认收起」**，需要看说明的把「显示介绍」打开即可。
- 小程序端是另一套实现（`settings.showPluginDesc` + `wx:if`，自 v0.91.0 起就正常），本次未动。
- 无数据迁移；不改任何存储字段，开关值仍走 `uiPreferences` 原有的 `showPluginDescriptions` 键。

## 验证

- 浏览器实测（临时 dev 实例，插件中心 18 张卡片）：关掉窄屏媒体查询后，`data-plugin-descriptions="off"` 时 18/18 张描述 `display: none`，切到 `on` 时 18/18 恢复可见，单张实测 160×53、三行截断。
- 反向验证：把新增的那条选择器从规则里剥掉，新断言立即报红。
- 三端版本一致 v0.172.1（Android `versionCode 17201`），118 个测试脚本全部通过。
