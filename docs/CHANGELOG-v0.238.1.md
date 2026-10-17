# v0.238.1 · 一卡通图形统计：容器类名撞了校历的 `.cc-grid`，两张并排卡被挤成 1/7 宽

> 归属说明：改动进 `le-time-management/public/plugins/cppu-notify/card-charts.js` 与
> `le-time-management/scripts/test-cppu-card-charts.mjs`（前者属「必须升版本」的目录），
> 随 v0.238.0 之后的 v0.238.1 发布（修 bug / 样式修正 → patch +1）。
> 插件自身 `manifest.json` 版本 `1.59.0 → 1.59.1`；`node tools/sync-plugins.js` 已重跑，
> 桌面与小程序 pluginCatalog 均为 `1.59.1`。
> 校验：`sync-version.js --check` → ✓ 三端版本一致 v0.238.1；
> `gen-theme-dark.js --check` / `build-schedule-plugin.js --check` → ✓；
> `sync-android-native.js` → ✓（版本号一改，`gen/android/app/src/main/assets/tauri.conf.json`
> 这份运行时副本必须重跑同步，`--check` 会先红）；
> `npm test` → **146 个测试脚本全部通过**（本次是在既有
> `scripts/test-cppu-card-charts.mjs` 上改断言，不新增脚本）。

## 起因

用户发来「一卡通图形统计」的截图 + 一句「有bug修复」。截图上的问题很具体：

- 面板右侧一大片空白，而「消费结构」「消费地点排行」两张卡被挤成两根窄柱；
- 圆环只剩左半段弧，环心金额被裁成「¥6…」，图例「餐饮」竖排成「餐 / 饮」；
- 排行行的「N 次」跑到卡片之外约 90px 的空白处。

## 定位（先用像素量，再回代码对）

| 证据 | 读数 | 说明 |
|---|---|---|
| 两段卡片底色的列区间 | `x13..142` 与 `x147..276`，各 **130 device px** | 面板总宽约 966px，两张卡却只各占 130px |
| 两卡之间 | `x143..146` = 4px 间隙 + 两侧各 1px 边框 | **gap 是 4px** —— 而图形统计自己写的是 `gap:12px` |
| `x277..776` | 纯页面底色，无任何内容 | 右侧不是被裁掉，而是**排了 5 列空轨道** |
| 卡片右侧空白处的文字 | 6 行同形文字位图，行距 34px | 排行卡「N 次」列画在卡片外 |
| 环图蓝色像素 | 只在 `y≈118-122`、`y≈300-302` 出现一小段 | 圆弧被后一张卡整块盖住 |

`gap:4px` 是决定性线索：图形统计自己写的是 `gap:12px`，`4px` 只出现在
`le-time-management/public/plugins/cppu-notify/calendar.js:182`
的 `.cc-weekdays,.cc-grid{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}` 里。

**根因：同一个插件里两个视图用了同一个容器类名 `.cc-grid`。** 两份 `<style>`
（`card-chart-style` 与 `cppu-calendar-style`）都常驻 `<head>`、权重同为 (0,1,0)，
后注入的那份整块生效。用户桌面上打开过校历，于是图形统计的栅格被套上月历的
`repeat(7,minmax(0,1fr))`：两列的概念直接不存在，两张卡各占 1/7，
第 3–7 列空着（底色与页面底一致，看不出来），`cc-wide` 的趋势卡与星期卡铺在可视区外。

溢出算术（面板 966px）：列宽 129.7px → 卡片内容盒约 95px；
`.cc-rank li` 固定轨道 `112px 1fr 74px` + 2×10px gap 最小 206px ⇒ 必溢出；
`.cc-donut-svg` 是 `flex:0 0 auto` 且内联 `width = donutWidth(plot)`
（plot ≈ 900 ⇒ 夹到上限 **248px**）⇒ 248px 塞进 95px，右移出卡、被后一张卡盖住。

## 判断标准（先定边界，再动手）

| 决策 | 选了什么 | 为什么不选另一条 |
|---|---|---|
| 修哪一层 | 给图形统计换容器类名 `.cc-chart-grid`（DOM + CSS），折线网格线 `line.cc-grid` 一并改成 `.cc-gridline` | 只调 `gap` / 只给图形统计加 `!important`：`repeat(7,…)` 还在，两张卡永远只有 1/7 宽。类名唯一才是根治，且 `.cc-grid` 从此只属于校历 |
| 并排判据 | 由**实测面板宽度**决定：`chartColumns(plot) = plot >= 640 ? 2 : 1`，量得的宽度写成内联 `grid-template-columns:repeat(2,minmax(0,1fr))` | 继续用 `@media(min-width:1080px)`：媒体查询看的是**视口**，不是插件面板 —— v0.227.0 / 1.55.4 那次「放大」修复就是这么判断的，窄面板里照样并排、照样挤；媒体查询是第二层隐患，不是病根 |
| 阈值 640 | 两列时列宽 ≈ (plot−10)/2，plot=640 → 列宽 ≈ 315、卡片内容盒 ≥ 299 | 299 > 248（环图上限）、> 206（排行行最小）—— 阈值取在「两列也不会溢出」的下界 |
| `donutWidth(plot)` | 一行不动 | 它的签名与 176/248 夹取被测试钉着，本次问题不在它 |
| 兜底 | `.cc-donut-svg` 补 `max-width:100%` | 环图是固定像素 + `flex:0 0 auto`，万一将来又被塞进窄容器，至少不会画出卡外 |

## 改了什么

**`le-time-management/public/plugins/cppu-notify/card-charts.js`**

- 容器类 `.cc-grid` → `.cc-chart-grid`（CSS 一处 + `platformHtml()` 与 `paint()` 两处 HTML），
  折线图网格线 `class="cc-grid"` → `class="cc-gridline"`（SVG 一处 + CSS 一处）。
  注释里写清「容器名必须全局唯一，否则校历的 `repeat(7,…)` 会把两张卡挤成 1/7」。
- 删掉 `@media(min-width:1080px){.cc-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}`，
  新增 `export const chartColumns = (plot) => (plot >= 640 ? 2 : 1);` 与内部 `gridCols(plot)`
  （两列时输出内联 `grid-template-columns:repeat(2,minmax(0,1fr))`，单列时不输出任何样式）。
- `.cc-donut-svg` 补 `max-width:100%`。

**`le-time-management/scripts/test-cppu-card-charts.mjs`**

- 原「默认单列 + 1080px 媒体查询两列」两条 CSS 断言，换成：`.cc-chart-grid{display:grid;
  grid-template-columns:1fr;gap:12px}`、**不许再出现** `@media(min-width:1080px)`、
  **不许再出现**图形统计自己的 `.cc-grid` 选择器、网格线已是 `.cc-gridline`、
  `.cc-donut-svg` 带 `max-width:100%`、`class="cc-chart-grid"` 在。
- 新增列数决策断言：`chartColumns(300|639) === 1`、`chartColumns(640|900) === 2`，
  并断言 plot=620（面板 686）的单列态**不写内联列定义**。

## 影响哪端

Windows 与 Android 同源（插件两端 `full`，小程序 `unavailable`）：只有图形统计的布局与一个
容器类名，不动取数、不动写操作、无数据迁移。校历的月历栅格不受影响（`.cc-grid` 现在只属于它，
过去反而是「图形统计后注入就会把月历压成一列」——同族反向 bug 一起没了）。

## 验证怎么做的

复现页不是手搭的：用极简 DOM 把 `card-charts.js` 真跑一遍导出**真产物**
（CSS = `card-chart-style` 的 textContent、markup = 渲染结果的 innerHTML），
改前副本取 `git show HEAD:` 那份，再把校历的真规则 `.cc-weekdays,.cc-grid{…7 列…gap:4px}`
按真实层叠顺序后注入；外壳 CSS 从 `letime-plugin-ui-check` 的预览页里抽。

无头 Chrome 读 `getBoundingClientRect`（比目测裁切可靠）：

| 场景 | 栅格实际列 | 卡宽 | 环图溢出卡右 | 排行「N 次」溢出卡右 |
|---|---|---|---|---|
| 改前 · 面板 966px | **7 列** `129.703px ×7` | 129.7px | **+134.3px** | **+92.3px** |
| 改后 · 面板 966px | 2 列 `460px ×2` | 460px | −106px（在卡内） | −16px（在卡内） |
| 改前 · 面板 560px | **7 列** `71.7px ×7` | 71.7px | **+151.3px** | **+150.3px** |
| 改后 · 面板 560px | 1 列 `526px` | 526px | −303px（在卡内） | −16px（在卡内） |

改前那行的 129.7px 卡宽与用户截图实测的 130px、两卡间 4px 间隙逐项吻合，
即用户那张截图已被稳定复现；改后同一场景恢复正常并排，环图闭合、中心金额完整、
图例一行不折行、排行次数在本行条内。
