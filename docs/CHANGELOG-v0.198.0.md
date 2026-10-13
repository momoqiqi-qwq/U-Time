# v0.198.0 · 总学期视图改成周视图的等比缩略图：同一节课在总览与真实课表里落在同一格

> `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.198.0`；
> `node ../tools/gen-theme-dark.js --check` → `✓ 派生调色板已同步（15 套深色变体）`；
> `node ../tools/build-schedule-plugin.js --check` → `✓ shiguang-schedule 生成物与源一致`；
> `node ../tools/sync-android-native.js --check` → `✓ Android 原生代码与版本化镜像一致`；
> `node ../tools/sync-plugins.js --check` → `✓ 插件生成物与清单同源（18 个内置插件）`；
> `npm test` → `PASS: 128 个测试脚本全部通过`。
> 动的文件：`le-time-management/public/plugins/shiguang-schedule/ui.js`（事实源，107 行改动）、
> `main.js`（`tools/build-schedule-plugin.js` 重新生成的产物）、
> `manifest.json`（3.15.0 → **3.16.0**）、
> `scripts/test-schedule.mjs`（总学期视图那一段断言整段重写）、
> `le-time-management/package.json` / `package-lock.json`（0.197.0 → **0.198.0**）、
> 同步器带出的 `src/pluginCatalog.js`、`miniprogram/core/pluginCatalog.js`、`src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json}`、
> 根 `docs/CHANGELOG-v0.198.0.md`。

## 用户要求原文

> 「显示像素和真实课表对应课的位置相同」

## 一、问题形态：总学期视图的色块和真实课表对不上

用户给的是「总学期视图」的截图（共 20 周、每行 4 张周卡、每张卡里一排彩色小方块）。
诉求是：卡里那些小方块的位置，要和周视图（真实课表）里对应的那节课**落在同一个位置**。
量测之后，老实现有三处不一致，其中一处是硬伤：

| # | 位置 | 现象 | 量测证据（视口 500×749，即 ≤620 断点） |
|---|---|---|---|
| A | `semBar()` 的纵向公式 | **符号写反**：算的是 `minM - start` 而不是 `start - minM`，负 top 撞上 `.sem-mini{overflow:hidden}` ⇒ 除第 1 节以外的课**全被画到卡片上方裁掉** | 实验课 top −15.79%、线性代数A −15.79%、大学英语 −47.37%、数据结构 −63.16%；只有 08:00 的两门课 top=0 正常 |
| B | 纵向口径 | 迷你图按「真实分钟 ÷ 全天时间轴（08:00–20:40 = 760 分钟）」，周视图按「节次行等分（10 行）」 | 3–4 节在迷你图 15.8%–28.9%，在周视图 25%–45%，差 10 个百分点以上 |
| C | 横向列序 | 周视图在 `firstDayOfWeek===7` 时列序变成「日一二三四五六」，迷你图恒按「一二三四五六日」，`.sem-dow` 标签也是硬编码 | 6/6 门课**列全部错位**（体育：周视图第 1 列 vs 迷你图第 7 列，Δx +0.7754） |
| — | 横向比例 | 迷你图没有节次列，周视图被 `--sg-label-w`（42–60px）推开 | 归一化 x 偏差 −0.0097 ～ −0.0743，越靠左越大 |

判定：用户诉求当前不成立，A 和 C 是必须修的缺陷，B 是口径分歧（两边画的根本不是同一套坐标）。

## 二、修法：格子坐标只算一份，两处共用

关键认识：**绝对像素不可能相同**（迷你卡内容宽 234px、真实网格 1184px 宽，列宽 31px vs 65px），
能精确对齐的是**归一化坐标** `(x/W, y/H)` —— 也就是「同一节课落在同一格」。
所以把总学期视图定义成周视图的**等比缩略图**：同一套网格模板、同一个坐标函数。

### 2.1 新增三个共享函数（`ui.js`）

```js
function slotMapOf(){return new Map(table.timeSlots.map((s,i)=>[s.number,i]));}
function weekOrder(){return table.config.firstDayOfWeek===7?[6,0,1,2,3,4,5]:[0,1,2,3,4,5,6];}
/* 列 = 星期在列序里的位置（+2，第 1 列是节次列），行 = 起始节次序号（+2，第 1 行是表头带） */
function courseCell(c,slotMap){
  let startIdx=c.isCustomTime?slotIndexForTime(c.start,false):slotMap.get(c.startSection);
  let endIdx=c.isCustomTime?slotIndexForTime(c.end,true):slotMap.get(c.endSection);
  if(!Number.isInteger(startIdx))startIdx=0;if(!Number.isInteger(endIdx))endIdx=startIdx;endIdx=Math.max(startIdx,endIdx);
  return {col:weekOrder().indexOf(c.day-1)+2,row:startIdx+2,span:Math.max(1,endIdx-startIdx+1)};
}
```

`gridCourse(c,overlap,slotMap)` 改成 `const {col,row,span}=courseCell(c,slotMap);`（丢掉 `order` 参数），
`semBar(c,slotMap)` 也从同一个函数拿坐标，输出 `style="grid-column:${col};grid-row:${row}/span ${span}"`。
这样「两边各写一份坐标」的可能性被结构性排除了 —— 老实现正是各写一份才写出 A 和 C。

### 2.2 迷你图复刻周视图的两处留白

迷你卡宽 234px、周视图网格 1184px，但**占比**必须一致：

- 左侧节次列占比 = `--sg-label-w ÷ 网格宽度`；
- 顶部表头带占比 = `--sg-head-h ÷ 网格高度`。

这两个量只能在**周视图在场时**量到（迷你视图 DOM 里只有卡片，没有网格；而 `--sg-head-h` 是 CSS 变量、
节次行高在 fit-height 下会被拉伸，光靠变量算不准）。所以新增 `measureGrid()`：每次渲染出网格就实测一次存进 `gridGeom`，
总学期视图直接复用；宿主宽度变了（`gridGeom.hw !== host.clientWidth`）就作废，转用按 CSS 变量估算的兜底值。

CSS 侧对应三条，每条都有明确的「为什么不能省」：

```css
.sg .sem-mini{grid-template-columns:calc(var(--sg-sem-label,0) * 1%) repeat(7,minmax(0,1fr));
              grid-template-rows:calc(var(--sg-sem-head,0) * 1%) repeat(var(--sg-slot-count,10),minmax(0,1fr));
              height:96px;padding:0;overflow:hidden}
.sg .sem-dow{grid-template-columns:calc(var(--sg-sem-label,0) * 1%) repeat(7,minmax(0,1fr));gap:0;padding:0}
```

- **gap 必须为 0**：百分比轨道 + 7×1fr 就是周视图 `--sg-label-w + 7×1fr` 的复刻；留下间隙，间隙会先吃掉宽度，越靠右的列偏得越多。
- **padding 必须为 0**：内边距会把内容盒整体右移又压窄，缩略图上就是恒定几个像素的错位。
- 比例由 JS 实测写进 CSS 变量，每张周卡自带 `--sg-slot-count / --sg-sem-label / --sg-sem-head`。

### 2.3 星期标签跟着列序走

`.sem-dow` 从硬编码「一二三四五六日」改成 `order.map((dayIndex,visualIndex)=>...)`，
`grid-column` 与色块用同一条列序 —— 否则 `firstDayOfWeek===7` 时标签和色块会分处两套语义。

## 三、跑一遍的结果

量测装置是临时搭的（`.workbuddy/probe-shiguang/`：stub `window.tide` + 固定课表 fixture + 无头 Chrome，
量完周视图再点进总学期视图，两个视图共用同一次 render ⇒ 容器尺寸完全一致才可比），收尾已删。

改后「同一节课在两处的归一化坐标差」：

| 视口 | 断点 | `--sg-label-w` 占比（实测 vs 写入变量） | 表头带占比（实测 vs 写入变量） | 最大 Δx | 最大 Δy | 6 门课列错位 |
|---|---|---|---|---|---|---|
| 390×844（inner 500×749） | ≤620 | 0.084 / 8.400 | 0.0563 / 5.634 | −0.0001 | −0.0002 | 0/6 |
| 700×900（inner 684×805） | ≤900 | 0.0852 / 8.525 | 0.0601 / 6.005 | 0 | −0.0002 | 0/6 |
| 1200×900（inner 1184×805） | >900 | 0.097 / 9.709 | 0.0763 / 7.636 | +0.0001 | −0.0001 | 0/6 |

`firstDayOfWeek = 1` 与 `= 7` 各跑一遍：两种情况 Δx/Δy 都 ≤ 0.02%（**亚像素**），
且 `firstDayOfWeek=7` 时迷你图的星期标签已变成「日一二三四五六」、与周视图表头逐字一致。
fix 前同一装置量到的是 Δx 最大 +0.7754、Δy 最大 −1.273。

```
✓ 三端版本一致：v0.198.0
✓ 派生调色板已同步（15 套深色变体）
✓ shiguang-schedule 生成物与源一致
✓ Android 原生代码与版本化镜像一致（… / 校务窗口与提醒接收器 / assets 配置与启动器图标）
✓ 插件生成物与清单同源（18 个内置插件）
PASS: 128 个测试脚本全部通过
```

`sync-android-native.js --check` 第一次报 `[不一致] app/src/main/assets/tauri.conf.json`（内嵌的还是 0.197.0），
跑一次同步器刷新后全绿 —— 与 v0.197.0 那次同源，属预期。

## 四、测试

`le-time-management/scripts/test-schedule.mjs` 的总学期视图那一段整段重写（原来是 v0.42.0 的断言）：
断言从「有 7 列迷你网格 / 百分比 top」改成「与 `course-block` 同格 / 无留白误差」，并补了三条**反向守卫**：

```js
assert.doesNotMatch(ui, /semBounds|sem-col/, '按分钟压轴的旧迷你图与 .sem-col 包装必须彻底移除');
assert.doesNotMatch(ui, /<span class="sem-bar[^>]*style="top:/, '迷你条不能再按百分比 top 定位');
assert.match(ui, /\.sg \.sem-mini\{[^}]*height:96px;padding:0;/, '.sem-mini 的 padding 必须为 0');
```

`test-release-history.mjs` 要求「新版本记录位于首条」，所以本文件必须存在（否则 128 条里会挂两条）。

## 五、影响面

- **桌面端 / 手机端**：总学期视图从「按真实时间轴压出来的条形图」变成「周视图的等比缩略图」；
  观感变化是色块从「细长条」变成「小方块」（96px 高 ÷ 10 行 ≈ 8.7px 一行，缩略图本该如此），
  换来的是「哪一周、星期几、第几节」扫一眼就能和真实课表对上。
- **数据**：`model.js`、存储结构、导入导出、ICS 全部未动，无迁移。
- **小程序**：`miniprogram/core/schedule.js` 只有周视图数据、没有总学期视图，本次无同源改动，
  只跟着 `pluginCatalog.js` 的版本号走。
- **已知边界**：`measureGrid()` 的缓存按宿主宽度失效。旋屏/分屏时若**正停在总学期视图**上，
  该帧用的是按 CSS 变量估算的比例（误差约 1%，因为 fit-height 会把节次行拉伸），
  回到周视图再进总学期视图即恢复精确值。手机端旋屏通常由宿主重挂视图，实际很难停在中间态。
