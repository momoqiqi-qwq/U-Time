# v0.252.0 · 左下角一键关闭隐私展示模式

## 改了什么

- `le-time-management/src/shell.js`：新增侧栏操作条动作 `privacy-off`（走 `registerRailAction` 注册表，
  与深浅色切换 / 设置 / 缩放视图同一条路径，因此同样可拖动重排、可用 Alt+←/→ 调位）。
  - 图标 `shield-halved`，类名 `privacy-off-btn`，`title` / `aria-label` 为「关闭隐私展示模式」；
    Android 底栏文字标签「展示模式」。
  - 显隐读**偏好** `settings.ui.privacyMask`，只在该模式开启时出现；订阅
    `tide:ui-preferences-changed`（与 `initPrivacyMask` 同一个事件源），所以设置页开关、
    启动时已开着模式这两种情况都能正确显隐。
  - 点击写 `setPrivacyMask(false)`（走偏好 → 事件回流 → `applyPrivacyMask` 还原），并 toast 提示。
  - 按钮自身带 `data-privacy-skip`：整屏数字被 9 化、校名被模糊时，这个入口必须仍然认得出。
  - 注册表里**常驻**、只靠 `hidden` 收放 —— 动态注册/注销会连带触发 `renderRailDock` 重建与
    顺序归一化，拖拽落点也会跳。
- `le-time-management/src/styles/feature-layouts.css`：新增
  `.rail-dock > .rail-dock-btn[hidden] { display: none; }`。`styles.css` 的
  `.rail-bottom > button` 给了 `display:flex`，作者样式压得过 UA 的 `[hidden]{display:none}`，
  不补这条，关掉模式后仍会留一颗 34px 空槽把设置键挤到右边。
- `le-time-management/src/styles.css`：`.privacy-off-btn` 的 FA 图标补 15px 尺寸，
  图标色走 `var(--ink)`（与 `.theme-toggle-btn` 同一条对比度根因：写死 `#17323A` 在深色磁贴下仅 1.07:1）。
- `le-time-management/scripts/test-privacy-mask.mjs`：新增「⑤ 左下角一键关闭键」一组断言
  （走注册表 / 偏好驱动显隐 / `data-privacy-skip` / 真写偏好 / 订阅事件 / hidden 显式
  display:none / 图标尺寸与配色）。

## 影响哪端

- 桌面端与 Android 端：模式开启时左下角操作条多出一颗盾牌键，点一下即关闭并还原全部隐私遮罩。
- 窄屏 / Android 底栏：按钮隐藏时按 `display:none` 退出流，其余按钮按 `flex:1` 重新均分，
  不会留空位。
- 不涉及插件、业务表、同步协议与小程序端。

## 数据迁移

无。`settings.railActionOrder` 里的 `privacy-off` 首次渲染时由
`normalizeRailActionOrder` 自动补到尾部（老存档无此 id 也不需要迁移）。

## 版本

- 应用：`0.251.0` → **`0.252.0`**（`package.json` / `package-lock.json` 两处 / `Cargo.toml` / `Cargo.lock` /
  `tauri.conf.json` / `appMeta.js` / `tauri.properties` / `strings.xml` / `README.md` 已同步）

## 验证

```
node ../tools/sync-version.js --check         ✓ 三端版本一致：v0.252.0
node ../tools/gen-theme-dark.js --check       ✓ 深色变体与 styles.css 同步
node ../tools/build-schedule-plugin.js --check ✓
node ../tools/sync-android-native.js --check  ✓ Android 原生代码与版本化镜像一致
npm test                                       ✓ 全部测试脚本通过
```
