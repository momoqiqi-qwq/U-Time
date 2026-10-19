# v0.254.1 · 「上网记录」每条时长下补 d / h 折算值

## 改了什么

- `le-time-management/public/plugins/cppu-notify/netlog.js`
  - 新增 `fmtHours()` / `fmtDays()`：把记录里的分钟数换算成小时（`1.77h`）与天（`0.07d`）。
    小时保留两位小数、100 小时以上取整（避免出现 `1284.33h` 这种没人读的数字），
    天固定两位小数（`1.00d` / `0.04d`，单位对齐才好竖着比）。
  - 明细行第二行原来只有 `1 小时 46 分`，现在下面再挂一行 `.nlog-alt`：
    `1.77h · 0.07d`。分钟仍是事实源（接口给的就是分钟），折算只做展示，不改任何计算。
  - 新样式 `.nlog-hit .nlog-alt`：块级、10px、`color-mix(ink 68%, ink-2)` —— 比主行再弱一档，
    但暗色下仍能读（与卡片副行、明细字段名同一套混合口径）。
- `le-time-management/public/plugins/cppu-notify/manifest.json`：版本 1.66.0 → 1.66.1，
  `author` 前缀补本次说明。

## 影响哪端

- 桌面端与 Android 端：「上网记录」明细行高度略增（多一行小字），其余不变；接口、登录、
  权限、存储键都没动。
- 小程序端不受影响。

## 数据迁移

无。

## 验证

- 无头 Chrome 真实渲染（stub `tide` + 6 条 fixture，覆盖 1435 分钟整天挂机 / 166 分钟 /
  52 分钟 / 106 分钟 / 225 分钟 / 9 分钟）：1000px 浅色与 430px 暗色各一版。
  实测输出 `23.92h · 1.00d` / `2.77h · 0.12d` / `0.87h · 0.04d` / `1.77h · 0.07d` /
  `3.75h · 0.16d` / `0.15h · 0.01d`，窄屏下与右侧流量数字不挤压、不裁切。
- `node ../tools/sync-version.js --check` → v0.254.1 三端一致
- `node ../tools/gen-theme-dark.js --check`
- `node ../tools/build-schedule-plugin.js --check`
- `node ../tools/sync-android-native.js --check`
- `node ../tools/sync-plugins.js`（manifest 版本变了）
- `npm test`
