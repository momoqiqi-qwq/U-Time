# v0.300.0 · 左上角字标改为 U-Time + 一般字形

> 发布日 2026-11-11 · 影响端：Windows / Android（两端同为 v0.300.0）· 无数据迁移

## 改的是什么

用户需求：「把红框的位置的原来的 U Time WorkSpace 改成只显示 U-Time，并且是一般字形。」

| # | 项 | 改前 | 改后 |
|---|---|---|---|
| A | 文案 | `U Time WorkSpace`（v0.183.0 起） | `U-Time`，唯一事实源仍是 `src/brandWordmark.js` 的 `BRAND_NAME`；`src/shell.js` 改为引用常量，不再手写第二份文案 |
| B | 字形 | 随包哥特体 `UnifrakturCook`（OFL-1.1） | 系统无衬线栈 `"Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif` + `font-weight: 700`；刻意不用 `system-ui`，度量与显式 Segoe UI 不一致 |
| C | 字号 | `calc(20px * var(--ui-text-scale))`，过渡带另有一档 18px | `calc(24px * var(--ui-text-scale))`，删掉过渡带那档。Segoe UI Bold 24px 下「U-Time」实测 93.4px（System.Drawing 量得），默认侧栏可用 166px、过渡带 146px，两档都放得下 |
| D | 随包字体 | `public/fonts/`（woff2 + OFL.txt） | 整个目录删除；`styles.css` 的 `@font-face` 一并移除；`public/OPEN_SOURCE_NOTICES.md` 的字体节改为「不随包分发任何字体文件」 |
| E | 装饰线 | `.brand-rule` 宽 `min(100%, 160px)` | `min(100%, 128px)` —— viewBox 仍 160×14，按 0.8 等比缩到新字标宽度，不横向拉伸 |

渐变色、透明字色、深色柔光、装饰线形状与四档配色全部未动。

## 守卫测试

`scripts/test-brand-wordmark.mjs` 断言随改动更新，并新增几条反向断言，防止下次谁顺手改回去：

- `BRAND_NAME === "U-Time"`，且品牌区 `<b>` 必须引用 `BRAND_NAME`（不许再写死文案）。
- `styles.css` 不许有 `@font-face` 规则、不许有指向 UnifrakturCook 的 `url()` 或 `font-family`。
- `public/fonts/` 必须不存在。
- 字标 `font-family` 必须含 `"Segoe UI"` 与 `sans-serif`、必须 `font-weight: 700`；不许出现 UnifrakturCook / Georgia / Times。
- 字号必须是 `calc(24px * var(--ui-text-scale))`，过渡带那档 `calc(18px * ...)` 条数必须为 0。
- `.brand-rule` 宽度必须是 `min(100%, 128px)`。

`scripts/test-refresh-mask.mjs` 与 `scripts/test-wait-mask.mjs` 的字标文案断言同步改为 `U-Time`。

## 迁移

无。文案与字体是纯渲染层，不写存储、不改 `letime-data` 结构；老版本数据原样可用。

## 回退

把 `BRAND_NAME` 改回 `U Time WorkSpace`、恢复 `@font-face` 与 `public/fonts/`、字号回到 20px/18px 两档、线宽回到 160px —— 但 `test-brand-wordmark.mjs` 会全线变红，说明回退本身需要一并改守卫。
