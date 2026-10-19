# v0.257.0 · 上网记录：概览图标与语义配色、时长折线图、流量柱状图、熬夜统计、明细双层收起

## 改了什么

- `le-time-management/public/plugins/cppu-notify/netlog.js`（原有视图重做展示层，取数与字段口径不变）
  - **概览四张卡各带一个内联 SVG 图标与语义色**：在线时长（时钟 / `--sea`）、总流量（上下箭头 /
    `--mint`×`--q4` 混出的绿）、计费金额（钱 / `--sun`）、上网次数（插头 / `--grape`）。图标走 `svgIcon()`，
    24×24、`currentColor` 上色，随 `data-theme` / `data-theme-mode` 一起变。
    原来四张卡是清一色同色数字，扫一眼分不出哪张是哪项。
    绿为什么是混的：`--mint` 偏青、会和「在线时长」的 `--sea` 撞色，`--q4` 单用偏灰认不出绿，
    两者按 58/42 混出来的绿松石与 `--sea` 色相差约 35°，才是既能认成绿又不撞的那个点。
    深色下四个数字都按 `--c` 混 `--ink` 提亮（34%），绿被稀释成近白就认不出了，所以流量卡单独抬到 80%
    （浅色下直接给本色，不混 ink）。
  - **上网时间折线图**：`lineChart()` 画每日在线时长，`niceMax()` 把纵轴抬到 1/2/5×10ⁿ，
    带 4 条网格线、渐变面积（`#nlog-grad-line`）、峰值竖线与「最高 / 日均」图例；
    横轴取首 / 中 / 末三档（`axisHtml()`，跨天时首尾自动换「今天」）。
  - **流量使用柱状图**：`barChart()` 每日上下行堆叠柱，上行与流量卡同一个绿、下行 `--grape`（两者在暗底上也能分清，
    原先都用青系色调时图例色块几乎一样）；上行按真实比例常常不足 1px，有数据时给 2.2px 的可见下限
    （真值仍在 `<title>` 里），否则柱顶那截绿等于不存在；当天没记录时按基线画一条 1px 浅线，
    避免空柱被误读成漏数据。折线与柱图同屏两栏，窄屏（≤640px）自动上下叠。
  - **深色模式补一层提亮**：`--sun`（计费金额）/ `--grape`（上网次数）这类语义色在暗底上会被吞掉半格对比度，
    数字与卡头按 `ink` 提亮一次，明细里的折算小字、口径说明、熬夜空轨道、按钮描边一并抬高。走的是
    `[data-theme-mode="dark"]`，不是某个主题名 —— 每套主题都有自己的深色变体。
  - **熬夜统计**：`nightSummary()` 把同一夜的多条记录按时间**并集**合并后，只对阈值之后的部分计时 ——
    换 IP 重连时 drcom 会留下首尾相接的两条，按条相加会重复算一遍。阈值按「警大校历」的学期名判断，
    没同步校历时按月份：**春季学期（2–7 月）22:20 后**、**冬学期（8 月–次年 1 月）22:00 后**。
    单夜封顶「阈值后 8 小时」，挂机整夜不会算成几十小时。卡面给累计时长、平均、最晚下线、熬夜率，
    下面按夜列条（最近 7 夜），并写明口径与学期来源。
  - **明细两级收起**：顶层一个「全部收起 / 全部展开」（`data-nlog-fold`）一次折起整块明细；
    每天一个折叠头（`data-nlog-daytoggle`，`aria-expanded` / `aria-controls` 齐备）单独收放；
    单条记录沿用原有的行内展开。折叠走 `.nlog-dwrap` / `.nlog-fold` 的 `max-height` 过渡，
    收 / 展都有中间帧（铁律七），并在 `prefers-reduced-motion: reduce` 里把时长压到 0.01ms。
  - 窗口内一条记录都没有时不再画趋势图：空数据铺满 0 值会画出一条贴底平线和全空柱图，
    看着像「这些天都是 0 小时」，现在只留明细的空态文案。

- `le-time-management/scripts/test-cppu-netlog.mjs`（新文件）
  - 最小 DOM + 假 `tide` / `bridge` 真跑 `render()` → `paint()`，断言：四张卡各带图标、
    折线有 `M…L…` 与渐变面积、柱图上下行两段都在、熬夜累计与阈值后 8 小时封顶、
    两级折叠按钮与 `open` 类、空数据不出图、源码里没有 `position: fixed`。
  - 熬夜期望值在测试脚本里按同一套月份口径独立算一遍，实现与断言互为对账。

- `le-time-management/public/plugins/cppu-notify/manifest.json`：1.68.0 → 1.69.0。
- `le-time-management/package.json`：0.256.0 → 0.257.0。

## 影响哪端

- 桌面端与 Android 端：「警大门户通知」插件的「上网记录」视图（cppu-net），其余视图不变。
- 小程序端不受影响（小程序没有 drcom 取数链路）。
- 权限、存储键、接口参数均未改；`netLogViewPreferences` 仍是原来那个键，
  新增的 `detailOpen` / `collapsedDays` 走同一个对象，老数据缺字段时按「展开」兜底。

## 数据迁移

无。

## 验证

- `node scripts/test-cppu-netlog.mjs` → 概览图标 / 折线 / 流量柱 / 熬夜口径 / 明细折叠 全部通过
- `node ../tools/sync-version.js --check` → v0.257.0 三端一致
- `node ../tools/gen-theme-dark.js --check`
- `node ../tools/build-schedule-plugin.js --check`
- `node ../tools/sync-android-native.js --check`
- `node ../tools/sync-plugins.js`（manifest 版本变了）
- `npm test`
