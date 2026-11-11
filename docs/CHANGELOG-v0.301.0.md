# v0.301.0 · 字标两态开关（哥特体 / 一般字形）

> 发布日 2026-11-11 · 影响端：Windows / Android（两端同为 v0.301.0）· 无数据迁移
> 修正 v0.300.0 的越界改动：字标不是「删掉哥特体」，而是**两态并存、设置里切**。

## 改的是什么

左上角品牌字标现在有两种形态，在 设置 → 界面 → **品牌字标** 里切换，二选一即时生效：

| 选项 | 文案 | 字体 | 字号 | 装饰线 |
|---|---|---|---|---|
| **哥特体**（默认） | `U Time WorkSpace` | 随包 UnifrakturCook Bold（OFL） | `calc(20px * var(--ui-text-scale))` | `min(100%, 160px)` |
| **一般字形** | `U-Time` | 系统无衬线栈（Segoe UI → 微软雅黑 → 苹方 → Noto CJK），700 | `calc(24px * var(--ui-text-scale))` | `min(100%, 128px)` |

两态共用同一套四档渐变（浅色 #B62394 → #C61557 → #C32A10 → #9C5211；深色 #E781CF → #F17EA9 → #F48A78 → #EDA15E）与同一条 160×14 哥特装饰线 SVG，只是宽度不同；一般字形下线的横向缩放比是 0.8（`preserveAspectRatio` 保证等比，不拉伸）。

## 修法要点

- 文案事实源 `src/brandWordmark.js`：`BRAND_NAME_GOTHIC` / `BRAND_NAME_PLAIN` / `BRAND_STYLES` / `DEFAULT_BRAND_STYLE`，取文案统一走 `brandName(style)`，DOM 里不再出现字面量。`BRAND_NAME` 保留为哥特态别名，旧调用点不动。
- 切换走 `syncBrandName(style)`，**只改 `.brand b.brand-name`**：等待 / 刷新蒙版会把「正在刷新课表…」这类自定义文案塞进同一个 `.brand b`，无差别改写会把它们冲掉。
- 偏好字段 `brandStyle`（`src/uiPreferences.js`）走既有的归一化 + 持久化通道，脏值落回 `gothic`；生效时写 `:root[data-brand-style]`，CSS 用 `:root[data-brand-style="plain"]` 分叉，不靠 JS 逐帧干预。
- 字体回到随包分发：`public/fonts/UnifrakturCook-Bold.woff2` + `public/fonts/OFL.txt`，`@font-face` 用 `font-display: swap`；`OPEN_SOURCE_NOTICES.md` 恢复署名条目。
- 设置里的新单选组按铁律六接 `attachSelectionGlow()`，切换有滑动选中光。

## 守卫测试

`le-time-management/scripts/test-brand-wordmark.mjs` 整体改成两态断言（7 节）：两套文案常量与 DOM 不写死文案、`syncBrandName` 只能命中 `.brand-name`、必须有 `@font-face` 指向随包 woff2 且 `public/fonts` 两文件都在、NOTICES 要列字体、基础规则哥特 20px / 覆盖规则无衬线 24px 且不重复背景、线宽 160 / 128 两档、设置开关（默认值、归一化、`:root[data-brand-style]`、`aria-label="品牌字标"`、两档选项、`setUiPreferences({ brandStyle })`、滑动选中光）。四档渐变的对比度门槛（白面板 ≥4:1、毛玻璃 ≥3.5:1、深色 ≥4:1）在 15 套浅色 / 16 套深色主题上照旧全量核对。

## 没做什么

- 蒙版（刷新 / 等待）里的字标字号覆盖（34px、compact 20px 等）两态共用，未改。
- 一般字形没有另配渐变：两态同色是刻意的，避免「换个字体像换了个品牌」。
