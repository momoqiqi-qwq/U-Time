# public/icons/nav 素材台账（主导航图标）

共 7 个图标，全部来自 **Icons8 / iGoutu** 的 **Color 彩色风格**，与插件图标同一套方案（v0.42.0 起随包化，此前导航走 iOS Filled CDN 直链）。

`capture`（快速捕获）与 `inbox`（收件箱）同形，是刻意为之的两份独立文件。

图标集入口：<https://igoutu.cn/icons/set/标志--style-color> ｜ CDN 直链格式：`https://img.icons8.com/color/96/<slug>.png`

生成方式：`tools/gen-plugin-icons.py`（Pillow，输出 81×81 透明 PNG，图形最长边 58px）。**不要手工替换这些 PNG** —— 重新生成会覆盖。

| key | 生效 slug | 说明 | sha256 |
|---|---|---|---|
| `quadrant` | `four-squares` | 四象限 / 田字格 | `87f8d428b956369e…` |
| `timeline` | `timeline` | 时间线 / 垂直时间轴（v0.52.0 新增，APK 端核心视图） | `da49b96098a2e683…` |
| `timeblock` | `clock` | 时间块 / 时钟 | `dca38110e1ddb25b…` |
| `inbox` | `inbox` | 收件箱 / 收件托盘 | `8ddd590b416ac546…` |
| `market` | `puzzle` | 插件中心 / 拼图 | `9066968d72c032de…` |
| `settings` | `settings` | 设置 / 齿轮 | `52e0a8b0eec63461…` |
| `capture` | `inbox` | 快速捕获（与收件箱同形） | `8ddd590b416ac546…` |

## 许可与消费方

Icons8 License（免费使用需在产品内署名）。署名入口见设置 → 关于（`src/aboutData.js`）与 `public/OPEN_SOURCE_NOTICES.md`。素材仅作为本产品界面的组成部分使用，**不得作为独立图标库转售或再分发**。

消费方：`le-time-management/public/icons/nav/*.png` ← `src/icons.js` 的 `appIcon()` 按导航 key 直读，加载失败才回落 CDN 同风格直链（候选清单在 `NAV_ICONS8`，须与本台账 slug 对齐）。
微信小程序不需要这批 PNG（tabBar 是 FA 单色成对图标，由 `miniprogram/tools/sync-tab-icons.py` 管）。
