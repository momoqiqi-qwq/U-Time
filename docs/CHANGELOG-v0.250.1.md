# v0.250.1 · 侧边栏插件图标退回上一版（Icons8 Color）

## 改了什么

- `le-time-management/public/icons/plugins/*.png` 共 26 张（17 个内置插件 + 9 个插件内视图）整体回到
  v0.243.0 的 **Icons8 Color** 素材，与 v0.250.0 引入的扁平双色母版相比就是「外观退回上一版」。
- 删掉这 26 张对应的扁平母版 `tools/icon-masters/<id>.png`。生成器是「母版优先、缺失回落 Icons8」，
  母版留着的话下次 `gen-plugin-icons.py` 会把侧栏图标静默覆盖回扁平风格。
- 主导航（四象限 / 时间线 / 时间块 / 收件箱 / 插件 / 设置 / 快速捕获）**不动**，仍是自有扁平母版
  （`tools/icon-masters/nav/`）；本轮只回退插件侧。
- 台账与来源标注随之分家：`public/icons/plugins/ATTRIBUTION.md` 回到 Icons8 口径（含每张图的
  sha256 前缀），`src/icons.js` 的 `data-icon-source` 改为插件 `bundled plugin PNG (Icons8 Color)`、
  导航保持 `bundled nav PNG (flat masters)`。
- `scripts/test-icon-masters.mjs` 口径反转：不再要求插件母版，改为断言
  **插件/视图不得存在母版**、随包 PNG 是 81×81 且与台账 sha256 一致、导航母版齐全。

## 影响哪端

- 只影响**桌面端 / Android 端左侧栏插件图标**。插件清单、界面布局、功能、配色、数据全部未动。
- 小程序 `miniprogram/images/plugins/*.png` 同步回同一份旧素材 —— 三端图标必须字节一致
  （`test-plugin-view-icons.mjs` 等 5 个测试卡这条），生成器本来就是一次写两端。

## 数据迁移

无。图标是随包静态资源，不涉及 storage / data.json。

## 版本

- 应用：`0.250.0` → **`0.250.1`**（`package.json` / `package-lock.json` 两处 / `Cargo.toml` / `Cargo.lock` /
  `tauri.conf.json` / `appMeta.js` / `tauri.properties` / `strings.xml` / `README.md` 已同步）

## 验证

```
node ../tools/sync-version.js --check         ✓ 三端版本一致：v0.250.1
node ../tools/gen-theme-dark.js --check       ✓ 15 套深色变体
node ../tools/build-schedule-plugin.js --check ✓
node ../tools/sync-android-native.js --check  ✓ Android 原生代码与版本化镜像一致
py -3 tools/gen-plugin-icons.py --offline --check ✓ 33 个图标全部 OK（0 DIFF）
npm test                                      ✓ 全部测试脚本通过
```
