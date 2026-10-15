# v0.222.0 · 警大一卡通下面接上图形统计：照网页的图，不照网页的实现

> `node ../tools/sync-version.js --check` → ✓ 三端版本一致：v0.222.0
> `node ../tools/gen-theme-dark.js --check` → ✓ 派生调色板已同步（15 套深色变体）
> `node ../tools/build-schedule-plugin.js --check` → ✓ shiguang-schedule 生成物与源一致
> `node ../tools/build-exam-calendar-plugin.js --check` → ✓ exam-calendar 生成物与源一致
> `node ../tools/sync-android-native.js --check` → ✓ Android 原生代码与版本化镜像一致
> `node ../tools/sync-plugins.js --check` → ✓ 17 个内置插件三端同源
> `node ../tools/gen-plugin-icons.py --check` → ✓ 图标无 DIFF（插件 17 + 分类 8）
> `npm test` → PASS: 138 个测试脚本全部通过

动的文件：

- 新增 `public/plugins/cppu-notify/card-charts.js`（563 行）—— 一卡通图形统计模块，
  纯 ES module（`import { classifyExpense, DEFAULT_KEYWORDS } from './card-averages.js'`），
  导出 `createCardCharts(tide, bridge)` 与一组可单测的纯函数
  （`chartMonthShift` / `chartTrend` / `chartPlaces` / `chartCategories` / `chartWeekday` /
  `platformTrend` / `platformPlaces` / `niceMaxCents` / `placeName` / `CHART_PALETTE` / `PIE_PALETTE`）
- `public/plugins/cppu-notify/main.js` —— 新增 `cardChartsPanel` / `cardChartsLoading` /
  `cardChartsError` 与 `loadCardChartsPanel(root)`；`cardStatsHtml()` 在流水统计下面插入
  `<div data-card-charts>`；`cardPaintStats()` 里 `cardChartsPanel?.render(...)`；
  `mountCardView()` 的 dispose 里 `cardChartsPanel?.dispose?.()`
- `public/plugins/cppu-notify/manifest.json` —— 1.53.0 → 1.54.0；`description` / `author` 改写
- 新增 `scripts/test-cppu-card-charts.mjs`（274 行）
- 生成物：`src/pluginCatalog.js`、`miniprogram/core/pluginCatalog.js`、
  `src-tauri/Cargo.toml` / `Cargo.lock` / `tauri.conf.json`、`miniprogram/core/appMeta.js`、
  Android `tauri.properties` / `assets/tauri.conf.json` 等三端版本号

**新增存储**：`storage` 的 `cardChartPreferences`（`{kind: 'out' | 'in', months: 6 | 12}`）。
缺失即用默认值 `{kind: 'out', months: 12}`，读到脏值也回落默认。无数据迁移。

## 用户要求

> https://pdata.cppu.edu.cn/stu/dataReport/consumption，一卡通可以参照该网站进行图形统计，
> 放在一卡通界面里的下面图形化显示

## 一、网页画了什么，本视图画什么

`pdata.cppu.edu.cn/stu/dataReport/consumption` 是 umi 3.5.21 的整站 SPA（`umi.js` 单文件
10.6 MB），消费页按 formId 分三块，数据全部走 `GET /tsa/pdp/consume/*`（带 `_USER=`，
学生端恒为空串）：

| 网页区块（formId） | 接口 | 字段 | 本视图 |
|---|---|---|---|
| 消费地点分布 `DistributionOfConsumptionLocations` | `/tsa/pdp/consume/tradingPlaceRanking` | `data.tradingList[]` 的 `{MERCHANT, TRADINGNUM}` | 消费地点排行（横向条 + 次数） |
| 消费金额趋势 `TrendOfConsumptionAmount` | `/tsa/pdp/consume/tradingTrend` | `data.trendList[]` 的 `{LASTMONTH, TOTAL}` | 月度金额趋势（折线 + 面积） |
| 消费明细 `ConsumerDetails` | `/tsa/pdp/consume/tradingDetailGrid` | `data.rowsList[]` 的 `{TRADINGDATE, TRADINGMONEY, MERCHANT}` | 不搬（本视图下面已有「最近 16 条流水」，且它带分页与月份选择） |
| 消费习惯 `consumptionHabit` | — | — | 不搬（与上面三张图重叠） |
| （网页没有） | — | — | 消费结构环形图、星期分布 |

网页把 `LASTMONTH` 拼成 `TIME: LASTMONTH + "月"` 后 `.reverse()` 成时间正序，本视图的
`platformTrend()` 抄的是同一步（接口按新→旧下发）。

## 二、为什么不引 echarts

网页的图是 echarts 画的，插件里不引：

1. 仓库既有先例是 `growth.js` 的六维图用内联 SVG 重画（`pdataRadarSvg`），插件 bundle
   不该再挂一个 1 MB 级的图表库；
2. echarts 的默认主题不吃 U-Time 的主题令牌，深色模式要再写一整套 option，而内联 SVG 只要
   `.cc-panel` 上一组 CSS 变量 + `[data-theme-mode="dark"] .cc-panel` 一段覆盖。

所以三张图各自手写，配色直接抄网页那两套色板：

- `CHART_PALETTE`（排行八色，照抄网页 `consumptionRank` 的取色顺序）
  `#29aadf #1dffd4 #f1d53c #ffad5c #34da62 #00e9db #00c0e9 #0096f3`
- `PIE_PALETTE`（环形五色，照抄网页 `consumptionTrend` 的饼图）
  `#1FA2FE #F5972B #7D6AEF #FC5B5B #2CC772`

几何按网页观感复刻：折线 2px + 面积渐变到透明 + 峰值点橙色（`#FF9F1C`）高亮；环形
`r=74 / 环宽 24`、中心写「累计总消费」+ 金额；排行的条是 `repeating-linear-gradient(90deg, … 0 3px, … 3px 5px)`
的 3px 色块 / 2px 间隙重复纹理（网页那张图就是这种斜纹感）。

## 三、口径：本机流水优先，网页口径按需

一卡通视图本来就有一条本地链路（`cardSync` → 充值 / 消费流水 → `cardState.rows`），
离线可用、与账单统计同源。图形统计**默认就画它**：切「消费 / 充值」与「近 6 / 近 12 个月」
都在本地算，不联网、不登录。

另给一个「平台口径」按钮（`data-cc-platform`）：点了才走 pdata 的 `/tsa/pdp/consume/*`
（复用已有的 `growthBridge.api` → `pdataApi`，同一份 CAS 换票通道），拿官网那三张图的原数据。
两条口径的差别写清楚，不混着画：

| | 本机流水 | 平台口径 |
|---|---|---|
| 来源 | 一卡通接口 `personal/turnover` 分页 | pdata `/tsa/pdp/consume/*` |
| 口径 | 充值 + 消费都有（`kind` 由 `typeFrom` 定） | 只有消费 |
| 粒度 | 逐笔，带日期 | 月号 `LASTMONTH`（1–12，无年份）/ 地点次数 |
| 鉴权 | 一卡通自己的 token | 统一身份认证会话（pdata token） |

拿不到票时明说「统一身份认证会话已失效」+「先在「警大通知」里登录一次」，
**不画一张空图**；三条接口全挂才算失败，有一条能用就照画。

## 四、脏数据不许进图

一卡通接口偶尔会回 `""`、`"0.00"` 或负数，报表口径的月份字段也可能缺：

- **金额**：`toCents` 只认正的安全整数分，`0 / -5 / Infinity / NaN / 'abc' / null` 一律归 0，
  任何图都不计入；
- **月份**：`chartMonthShift('2026-13', 1)` 直接抛错 —— 不然位移会静默滚成 `2027-01`，
  图上多出一个不存在的月份；`chartTrend` 里 `2026-13-45` 这类行的月份不在 01–12 就跳过；
- **空月记 0，不跳过**：趋势图的 x 轴必须是连续自然月，否则「3 月」与「8 月」会被连成
  一条误导的斜线；
- 商户名截 40 字、图例名截 12 字，全部过 `esc()`（有 XSS 断言守着）。

## 五、界面

一卡通视图从上到下：

```
[data-card-status]      状态条
[data-card-login-box]   登录框（未登录时）
[data-card-stats]
  ├ .yk-stat            总充值量 / 已花费 / 当前余额
  ├ .yk-account         余额来源
  ├ [data-card-averages]日均统计（card-averages.js）
  ├ .yk-groups          流水统计（口径 + 粒度芯片 + 横向条）
  ├ [data-card-charts]  图形统计（card-charts.js）  ← 本次新增
  └ .yk-ledger          最近 16 条流水
```

图形统计面板内部：标题行（「一卡通图形统计」+ 两个单选组）→ 四张卡（趋势 `cc-wide` /
消费结构 / 地点排行 / 星期分布）→ 底部 `.cc-note`（写清「一卡通接口单次最多回 5000 笔，
更早的历史可能不完整」）→ 平台口径块 → 状态行。

## 六、接线与降级

- `loadCardChartsPanel(root)` 动态 `import("/plugins/cppu-notify/card-charts.js")`，
  与日均模块完全同一条路径；加载失败只在面板里写「图形统计模块加载失败，请重新打开一卡通重试」，
  账单与流水统计照常；
- `render()` 抛错时兜一句「图形统计暂不可用，不影响账单与流水统计」；
- 视图卸载时 `dispose()` 摘掉滑动光句柄与缓存（日均模块没有 dispose，这是新增能力）；
- 模块没有 `bridge` 时**整块「平台口径」都不渲染**（`if (!bridge?.api) return "";`），
  而不是渲染一个点了没反应的按钮。

## 七、两个单选组走滑动光

按铁律六，「消费 / 充值」与「近 6 / 近 12 个月」都用
`tide.ui.selectionGlow(box, { selector: 'button[aria-pressed="true"]' })` 挂滑动光，
切完把偏好写进 `cardChartPreferences`（`saving` 闸门防并发写）。
按钮用 `data-cc-*` 前缀，**避开 `mountCardView` 的 `data-card-*` 前缀点击委托**
（`test-cppu-card-charts.mjs` 有 `/data-card-(kind|mode|months)="?cc/` 的反向断言守着）。

## 版本归属

本次与并行会话的 **v0.221.0**（警大邮箱改为应用内网页窗口 + 宿主站点白名单）同处一个
未提交的工作树：v0.221.0 已被那条改动占用（`docs/CHANGELOG-v0.221.0.md` 已存在），
本条让号到 **v0.222.0**。插件 `manifest.json` 的 1.53.0 归警大邮箱、1.54.0 归本条。

## 边界

- 小程序端本插件标记 unavailable，无变化；
- 一卡通接口单次最多回 5000 笔（`CARD_MAX_PAGES`），更早的历史可能不完整 —— 面板底部明写；
- 网页的「消费明细」带月份选择与分页，本视图不搬：下面已有最近 16 条流水，
  要看全量在网页里看；
- 「平台口径」的月号没有年份，跨年时 `platformTrend` 只按接口给的下发顺序取最近 12 条，
  不强行补年份（补了会编造数据）。

## 测试

新增 `scripts/test-cppu-card-charts.mjs`：纯函数聚合（趋势补月 / 排行排序 / 环形分类 /
星期分布 / 平台口径翻转）、脏数据不进图、月份越界抛错、面板渲染与两个单选组落盘、
XSS 转义、无 bridge 不渲染平台块、以及 6 条 main.js 源码级接线断言。
