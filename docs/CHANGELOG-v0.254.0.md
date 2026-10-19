# v0.254.0 · 「上网记录」对齐自助服务那页的字段，并去掉界面里的重复展示

## 改了什么

- `le-time-management/public/plugins/cppu-notify/netlog.js`：明细与统计口径按
  drcom「上网记录」页（`/bill/userOnlineLog`，表格 columns 定义在 `online-log.html:462-543`）
  的列序补齐，同时收紧四处重复。
  - 明细新增：`序号`（本次查询内第几条）、`上线时间` 与 `下线时间`（都带日期 —— 跨天那次
    上网，行内只写 `22:40 → 00:26` 看不出是次日下线）、`使用流量（网页原值）`（网页那列
    就是 `flow`，恒为 0，与「合计流量」不是同一个量，所以两处都留但各自标清来源）。
  - `NASIP` 与 `NASPORT` 拆回两列。之前挤成一项 `10.10.9.13:slot=1;port=5`，网页表格本身
    是两列，拆开后对着抄不会错位。
  - 国际 / 国内的上下行从「国际流量 ↑x ↓y」的合并写法拆成四项 `国际上行流量`、
    `国际下行流量`、`国内上行流量`、`国内下行流量`，与网页四个列名一一对应。
  - 统计卡「总流量」加副行：国际与国内各自的上行 / 下行合计。服务端 `summary` 本来就分
    `INTERNETUPFLOW` / `INTERNETDOWNFLOW` / `CHINANETUPFLOW` / `CHINANETDOWNFLOW` 四个字段给，
    之前只取了加总值。`totals()` 相应改成按四个字段累加（`flow` 一并汇总，多段拉取时
    服务端不给 `summary`，仍走 `rows` 累加）。
  - 去掉重复：① 明细行右侧已经显式显示流量，行内文字里又拼了一遍 —— 行内现在只留
    `时段 · 使用时长`；② 日期分组头的「N 次 · 时长 · 流量」与每日流量细条重复了同一天的
    两个数，分组头只留 `N 次`；③ 每日细条的「时长 · 流量」与统计卡的总量口径重复，细条只留
    流量。现在每个数字只出现在一处：区间总量在统计卡、按天流量在细条、当天次数在分组头、
    单次的时段 / 时长 / 流量在明细行。
  - 删掉因此变成死代码的 `fmtDurTight`。
  - 暗色对比度：卡片标题、卡片副行、明细字段名三处小灰字从 `--ink-3` 换成
    `color-mix(in srgb, var(--ink) 78%, var(--ink-2))`，与每日条 / 分组头同一口径
    （暗色主题下 `--ink-3` 落在 4.5:1 边缘，放大后才读得轻松）。
- `le-time-management/public/plugins/cppu-notify/manifest.json`：版本 1.65.0 → 1.66.0，
  `author` 前缀补本次说明。

## 影响哪端

- 桌面端与 Android 端：只改「上网记录」视图的渲染与一处统计口径，接口、登录链路、权限、
  存储键都没动。
- 小程序端不受影响（该视图不随小程序发布）。

## 数据迁移

无。没有新增存储键，`netLogViewPreferences` 结构不变；旧偏好直接沿用。

## 验证

- 无头 Chrome 渲染真实 CSS（stub `tide` + 8 条真实字段 fixture，含一条跨天、一条未下线、
  一条 `flow` 非 0）：1000px 浅色 / 暗色、500px 窄屏各一版，展开两行看明细列序。
  结论：明细 15 项无重叠、无裁切；窄屏自动两列；统计卡副行固定两行不靠折行。
- `node ../tools/sync-version.js --check` → v0.254.0 三端一致
- `node ../tools/gen-theme-dark.js --check`
- `node ../tools/build-schedule-plugin.js --check`
- `node ../tools/sync-android-native.js --check`
- `node ../tools/sync-plugins.js`（manifest 版本变了，17 个内置插件清单重同步）
- `npm test`
