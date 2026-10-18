# public/icons/nav 素材台账（主导航图标）

共 7 个图标，其中 7 个来自**本项目自有扁平母版**（`tools/icon-masters/nav/`，与插件图标同一套风格，无需第三方署名）；其余（如有）来自 **Icons8 / iGoutu** 的 **Color 彩色风格**。

`capture`（快速捕获）与 `inbox`（收件箱）同形，是刻意为之的两份独立文件。

图标集入口：<https://igoutu.cn/icons/set/标志--style-color> ｜ CDN 直链格式：`https://img.icons8.com/color/96/<slug>.png`

生成方式：`tools/gen-plugin-icons.py`（Pillow，输出 81×81 透明 PNG，图形最长边 58px）。**不要手工替换这些 PNG** —— 重新生成会覆盖。

| key | 来源（母版路径 / Icons8 slug） | 说明 | sha256 |
|---|---|---|---|
| `quadrant` | `icon-masters/nav/quadrant.png` | 四象限 / 田字格 | `043338f64de2da8c…` |
| `timeline` | `icon-masters/nav/timeline.png` | 时间线 / 垂直时间轴（v0.52.0 新增，APK 端核心视图） | `9deff7e16ab704a8…` |
| `timeblock` | `icon-masters/nav/timeblock.png` | 时间块 / 时钟 | `1fec800378131a93…` |
| `inbox` | `icon-masters/nav/inbox.png` | 收件箱 / 收件托盘 | `1af7b8872c99e9fc…` |
| `market` | `icon-masters/nav/market.png` | 插件中心 / 拼图 | `0e34156ee1706f34…` |
| `settings` | `icon-masters/nav/settings.png` | 设置 / 齿轮 | `6c424e3183aea1dc…` |
| `capture` | `icon-masters/nav/inbox.png` | 快速捕获（与收件箱同形） | `1af7b8872c99e9fc…` |

## 许可与消费方

母版图标为本项目自有素材。加载失败时回落的 CDN 直链仍是 Icons8 Color，按 Icons8 License 署名（设置 → 关于 `src/aboutData.js` 与 `public/OPEN_SOURCE_NOTICES.md`），仅作为本产品界面的组成部分使用，**不得作为独立图标库转售或再分发**。

消费方：`le-time-management/public/icons/nav/*.png` ← `src/icons.js` 的 `appIcon()` 按导航 key 直读，加载失败才回落 Icons8 Color 的 CDN 直链（候选清单在 `NAV_ICONS8`）。
微信小程序不需要这批 PNG（tabBar 是 FA 单色成对图标，由 `miniprogram/tools/sync-tab-icons.py` 管）。
