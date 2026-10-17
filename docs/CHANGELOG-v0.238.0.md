# v0.238.0 · 警大请假：状态标签改用「警大成绩」的四档色相，首屏加汇总卡

> 归属说明：改动进 `le-time-management/public/plugins/cppu-notify/` 与
> `le-time-management/scripts/test-cppu-qj-palette.mjs`（前者属「必须升版本」的目录），
> 随 v0.237.0 之后的 v0.238.0 发布（界面调整 → minor +1）。
> 插件自身 `manifest.json` 版本 `1.58.0 → 1.59.0`；`node tools/sync-plugins.js` 已重跑，
> 桌面与小程序 pluginCatalog 均为 `1.59.0`。
> 校验：`sync-version.js --check` → ✓ 三端版本一致 v0.238.0；
> `gen-theme-dark.js --check` / `build-schedule-plugin.js --check` / `sync-android-native.js --check` → ✓；
> `npm test` → **146 个测试脚本全部通过**（新增 `scripts/test-cppu-qj-palette.mjs`）。

## 起因

用户原话：

> 給警大请假界面按skill修改

「skill」指刚交付的 `letime-cppu-grade-palette`（「警大成绩」的配色与字体事实源）——
即让「警大请假」（`cppu-notify` 的 `cppu-qj` 视图）与「警大成绩」说同一种颜色语言，
而不是各写一套自编色。

## 判断标准（先定边界，再动手）

| 决策 | 选了什么 | 为什么不选另一条 |
|---|---|---|
| 四档怎么来 | 请假状态复用成绩页的分数四档色相：已同意→good、审批中→warn、未同意→bad、已撤销→中性（`--ink-2`） | 请假状态正好也是四态，另起一套只会让同一插件里出现两种「好 / 注意 / 坏」的语言 |
| 文字取哪一档 | 浅色档各**加深一档**（`#15703F` / `#965900` / `#C8102E`），深色档沿用成绩页亮色（`#4ADE80` / `#FBBF24` / `#F87171`） | 直接照抄成绩页的 `#1B7F4B` / `#B06A00`：成绩页是「色字压白卡」（5.02:1），标签是「色字压同色掺底」，实算只有 4.29 / 3.65:1，而且字号更小（10.5px） |
| 掺底比例 | 8%（浅 / 深同一比例），并在测试里钉死 | 10% 时深色红压褐底主题面板只剩 **4.38:1**（fresh / claude / dunhuang / citrus 的深色面板 `#202F2D` / `#2F2A20` 最伤）；8% 时四档最差 4.55:1、浅色最差 4.84:1 |
| 作用域 | 全部加 `.jw-leave` 前缀 | 同一套 `.jw-tag` 选课 / 创新学分页也在用，`test-theme-contrast.mjs` 正数着那条**恰好 3 条**的旧规则（`[data-theme-mode="dark"] .jw-tag.ok|warn|live`）；加前缀才不会把计数打破 |
| 内容色 | 请假理由、课次行课程信息、草稿说明、课程名从 `--ink-3` 提到 `--ink-2` / `--deep` | `--ink-3` 在浅色面板上只有 3.49:1（成绩页那轮已列为该页唯一不达 AA 的一族）；这几处是「内容」不是「注释」 |
| 首屏汇总 | 复用成绩页骨架 `.jg-card + .jg-metrics + .jg-note`，四个指标 + 一句说明 | 请假页过去只有「记录」与「课次」两段，第一眼看不到「总共申请了几次、几个批了」；另写一套骨架会让两页的卡片语言分叉 |
| 无数据时 | `jwLeaveSummaryHtml()` 返回空串 | 没登录 / 没拉过数据时留一张「0 0 0 0」的空卡，比没有卡更误导 |
| 写操作 | 一行没动（申请草稿、去教务提交、存待办照旧） | 本插件对教务**刻意只读**，配色的活儿不该顺手动行为 |

## 改了什么

**`le-time-management/public/plugins/cppu-notify/main.js`**

- `ensureStyle()` 模板串新增请假页配色段（插在 `.jw-leave-draft small` 那条之后）：
  浅色四条 `.jw-leave .jw-tag.ok|warn|bad|muted`（`rgba(21,112,63,.08)` / `rgba(150,89,0,.08)` /
  `rgba(200,16,46,.08)` 掺底 + 同色 `.34` 描边 + 加深一档的文字色；muted 走 `--paper` + `--line-soft` + `--ink-2`），
  深色四条 `[data-theme-mode="dark"] .jw-leave .jw-tag.*`（`rgba(74,222,128,.08)` /
  `rgba(251,191,36,.08)` / `rgba(248,113,113,.08)` + 成绩页亮色文字；muted 同浅色）。
  注释里写清「8% 是算了 16 套主题才定下来的」与「为什么浅色要加深一档」。
- 四处内容色提升：`.jw-leave .jw-why{color:var(--ink-2)}`、`.jw-leave .jw-row small{color:var(--ink-2)}`、
  `.jw-leave .jw-leave-draft small{color:var(--ink-2)}`、`.jw-leave .jw-card-t{color:var(--deep)}`。
- 新增 `const jwLeaveTone = (code) => ({"2":"ok","1":"warn","3":"bad","0":"muted"}[String(code ?? "").trim()] || "");`
  —— 状态字典 `JW_DD.SQZT` 的 `0/1/2/3` 映射到四档；记录卡的状态标签改走它
  （`jwTag(jwDict("SQZT", r.SQZT), jwLeaveTone(r.SQZT))`，过去是内联三元式，`未同意`/`已撤销` 两态无色）。
- 新增 `jwLeaveSummaryHtml()`：申请总数 / 已同意 / 审批中 / 未通过·已撤销 四个指标
  （`count(code)` 统计 `SQZT`）+ 说明行「可请假课次 N 节 · 汇总按教务返回的申请状态统计，提交入口仍在学校教务。」；
  `jwLeaveHtml()` 把它与两段 `jwSection` 一起包进 `<div class="jw-leave">`。

**`le-time-management/scripts/test-cppu-qj-palette.mjs`（新增）**

- 结构：浅 / 深各 4 条 `.jw-leave .jw-tag.*`；未加作用域的旧 `.jw-tag.ok|warn|live` 仍为 3 条硬编码色；
  四处 `--ink-2` / `--deep` 提升规则在。
- 色相：四档与成绩页同色系（`rgbToHsl` 色相差 ≤ 2°）；浅色 ok / warn 必须比成绩页版本更深，深色与成绩页同值。
- 对比度：**遍历 16 套主题**真正渲染到的那一两套色板（浅色叠 `theme-derived.css` 的
  `:root[data-theme="id"]` 修正块、深色用 `deriveDark()`、`night` 主题取它自己的面板），共 31 套：
  四档文字 vs 8% 掺底、muted（`--ink-2` on `--paper`）、`--ink-2` on `--panel` 全部 ≥ 4.5:1；
  同时断言掺底透明度就是 8%（改它必须重算最差值）。
- 接线：`jwLeaveTone` 映射、`jwTag(...)` 调用点、汇总卡骨架与空数据返回空串、`.jw-leave` 包裹与闭合。

## 影响哪端

Windows 与 Android 同源（插件两端 `full`，小程序 `unavailable`）：只有配色与首屏多一张汇总卡，
不动取数、不动写操作、无数据迁移；未登录 / 没拉过数据时界面与过去一致（汇总卡不出现）。

## 验证怎么做的

`letime-plugin-ui-check` 的 `plugin-preview.mjs` 跑真 CSS + 真插件源码出预览页
（`--view cppu-qj --themes "classic:light,night:dark"`），配合给插件源码打补丁的 fixture
（预填 5 条覆盖四态的请假记录 + 4 门课次、掐断触网）；改前副本由「从当前工作区精确减去本次三处改动」
生成（工作区领先 HEAD 约 20 个改动块，`git show HEAD:` 不可用）。整页截图按卡边界裁切做四档特写对照，
几何落位用注入探针读 `getBoundingClientRect`（比目测裁切可靠）。
