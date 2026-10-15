# v0.214.3 · 插件中心卡片拖动改尺寸：光标跟着方向变、卡片真的跟手、松手有落位过渡

> `node ../tools/sync-version.js --check` → ✓ 三端版本一致：v0.214.3
> `node ../tools/gen-theme-dark.js --check` → ✓ 派生调色板已同步（15 套深色变体）
> `node ../tools/build-schedule-plugin.js --check` → ✓ shiguang-schedule 生成物与源一致
> `node ../tools/sync-android-native.js --check` → ✓ Android 原生代码与版本化镜像一致
> `npm test` → PASS: 135 个测试脚本全部通过

动的文件：

- `src/marketCardResize.js` —— 拖动起点改取「卡片当前实际尺寸 ÷ 界面缩放」；新增 `resizeCursor(dx, dy)`
  与 `--market-resize-cursor`；`paint()` 改读会话上的坐标（rAF 合并不再吃掉位移）；新增
  `.market-settling` / `SETTLE_MS = 240` 落位过渡与 `stopSettling()`
- `src/styles.css` —— `.mcard` 的 `min-height: var(--market-card-h, 0px)` 改成
  `height: var(--market-card-h, auto)` + `overflow: hidden`；拖动期把网格轨道**固定**成拖动值；
  新增落位过渡与 `:root.market-resizing-page` 全局光标；窄屏 `.market-manage-card` 改 `height: auto`
- `src/uiPreferences.js` —— `MARKET_CARD_SIZE_LIMITS.minHeight` 0 → 76；高度 0 作为「随内容自适应」
  哨兵值不再被夹进区间；写变量时 0 → `auto`
- `scripts/test-market-card-resize.mjs` —— 替身补 `documentElement.classList` / `style.removeProperty` /
  `getUiScaleFactor`，新增光标、页面级光标态、缩放换算、落位过渡、Esc 收尾等断言
- `src-tauri/Cargo.toml` / `Cargo.lock` / `tauri.conf.json`、`gen/android/.../assets/tauri.conf.json`、
  `miniprogram/core/appMeta.js` —— `node ../tools/sync-version.js` 与 `sync-android-native.js` 生成物
- `package.json` / `package-lock.json` —— 0.214.2 → 0.214.3（lock 两处手改）

无新增存储键、无数据迁移。偏好仍写在 `letime-data` 的 `marketCardWidth` / `marketCardHeight`
两个既有字段里，老数据（含 `marketCardHeight: 0`）语义不变。

## 用户要求

> 卡片拖动缩小时，鼠标指针需要相应变化。还有卡片没有缩小动画，不跟鼠标。

## 一、根因：两个变量都只是「下限」，拖动改的其实是网格的约束而不是卡片

`--market-card-w` / `--market-card-h` 是 v0.181.0 加进来的，当时接的是两处**下限**：

```css
/* v0.181.0 及以前 */
.market-grid { grid-template-columns: repeat(auto-fill, minmax(var(--market-card-w, 180px), 1fr)); }
.mcard { min-height: var(--market-card-h, 0px); }
.market-grid.market-resizing { cursor: grabbing; }
```

于是拖动时：

1. **宽度**：`minmax(w, 1fr)` 里 `w` 只是下限，**列数不变的区间内卡片宽度由 `1fr` 拉伸决定** ——
   真机实测拖动 40px 卡片宽度纹丝不动，只有跨过列数临界点时阶梯跳一下。这就是「不跟鼠标」。
2. **高度**：`min-height` 只能把卡片**撑高**。往下拖（缩小）时目标值低于内容高度 ⇒ 卡片一点不变；
   往上拖超过内容高度才有一点反应 ⇒ 「没有缩小动画」。
3. **光标**：`grabbing` 是「搬运」语义，不是「调整尺寸」；而且 `cursor` 只作用于指针下的元素，
   指针一移出卡片就变回箭头。

## 二、修法

**① 光标按拖动方向实时变，且挂在 `<html>` 上。** `resizeCursor(dx, dy)` 用整段拖动的**已 clamp 尺寸差**
分档：`|dx| ≥ 1.5|dy|` → `ew-resize`，`|dy| ≥ 1.5|dx|` → `ns-resize`，否则按同/反向给
`nwse-resize` / `nesw-resize`（CSS 斜向只有这两个关键字）。JS 写 `--market-resize-cursor`，
CSS 用 `:root.market-resizing-page, :root.market-resizing-page * { cursor: var(--market-resize-cursor) !important }`
广播到全页 —— 指针拖到卡片外、拖到侧栏上，箭头都不变。按整段拖动的方向算（不是每帧增量），
中途换向不会让箭头闪。

**② 拖动期把轨道固定成拖动值，宽度才真的跟手：**

```css
.market-grid.market-resizing { grid-template-columns: repeat(auto-fill, min(var(--market-card-w, 180px), 100%)); }
.market-grid.market-resizing .mcard,
.market-grid.market-resizing .mcard:hover {
  transition: none; transform: none;
  width: min(var(--market-card-w, 100%), 100%);
}
```

只在 `.market-resizing` 期间生效：平时仍是 `minmax(w, 1fr)`（卡片铺满整行，右边不留豁口），
拖动期才切成确定值。真机实测 `dx = -20 / -40 / -60` → 卡片宽度 `170 / 150 / 130`，**1:1 跟手**，
且 `grid-template-columns` 与拖动值逐帧一致。

**③ 高度从「下限」改成「精确高度」：** `.mcard` 的 `min-height: var(--market-card-h, 0px)` 换成
`height: var(--market-card-h, auto)` + `overflow: hidden`。像素值 = 精确高度（拖动缩小后保持），
`auto`（偏好值 0）= 随内容自适应（拖动前的行为）。新增 `MARKET_CARD_SIZE_LIMITS.minHeight = 76`，
拖动可以一路缩到「只剩图标行 + 操作行」，不会缩到 0 变没；`normalizeUiPreferences()` 里 0 是哨兵值，
不再被夹进 `[76, 420]`，否则默认高度会变成 76。

**④ 松手后 240ms 落位过渡**（`SETTLE_MS`，与 CSS 的 `.2s` 一致）：`finish()` 摘掉 `.market-resizing` 时
挂上 `.market-settling`，让「固定轨道 → `minmax(拖动值, 1fr)`」这一跳有过渡（真机实测宽度
`120 → 124.9 → 128.8 → 131.2 → 132.8` 五帧以上收敛，不是瞬间跳）。`interpolate-size: allow-keywords`
供「双击恢复默认尺寸」时高度回到 `auto` 能插值；不支持的浏览器直接跳变，无副作用。
快速重新按下会先 `stopSettling()` 收掉上一轮，不会叠加。减少动效由既有的全局规则
（`data-ui-motion="reduced"` 与 `prefers-reduced-motion` 两条，styles.css:2665 / 1524）统一压到 .01ms。

**⑤ 界面缩放（zoom）下仍 1:1：** 起点尺寸取 `rect.width / getUiScaleFactor()`（视觉 px → 布局 px），
位移也除以同一个系数。手机窄屏的自适应缩放（<360px 时系数可到 0.7）不会再让拖动放大 1/0.7 倍。

**⑥ rAF 合并顺手修了一个「差一帧」：** 原实现每帧只按本帧第一条 `pointermove` 画，
快速拖动时卡片永远落后一帧；现在把最新坐标存到会话上、帧内读它。

## 守卫

`scripts/test-market-card-resize.mjs`（DOM 替身 + 真跑模块）新增：

- `resizeCursor` 八例（含 `(0,0)` → `ew-resize`、两轴都变给 `nwse` / `nesw`）；
- 拖动中 `<html>` 必须带 `market-resizing-page`、`--market-resize-cursor` 随方向变（斜向 → 横向主导
  变 `ew-resize`）、松手后两者都清干净；
- 落位：`pointerup` 后 `.market-settling` 在场、`onDown` 会先收掉上一轮的它、`detach()` 后也不残留；
- 缩放：`getUiScaleFactor() = 1.25` 时视觉位移 25px 只能改 20 布局 px（落盘 172 而不是 197）；
- Esc 取消：不落盘、尺寸与光标态都还原。

变异验证（实测）：把 `paint()` 里的 `dx / st.scale` 改回 `dx`，缩放那条断言立刻红；
把 `.market-settling` 的 `startSettling()` 注释掉，「落位过渡」断言红。还原后绿。

## 已知边界（有意接受）

- 拖动到最小高度（76px）后卡片只留「图标 + 标题」行与操作行，描述与版本号被挤掉 —— 这是
  「精确高度」的语义（和宽度一样，拖动值就是最终值），双击网格空白处即恢复默认。
- 宽度松手后仍会被 `1fr` 拉宽（`120 → 132.8`）：偏好值是**列宽**而不是卡片最终宽度，铺满整行
  是既有布局契约；这次让这一跳有了过渡，没有改契约。
- 手机端（≤900px）的紧凑条目忽略桌面拖出来的像素高度（`height: auto`），否则一个 76px 的设定
  会把两行条目裁掉一半。
