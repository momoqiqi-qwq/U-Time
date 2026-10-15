# v0.216.0 · 警大校历并入警大通知插件：每个分类各用各的侧栏图标，学期起止并成一张卡、日期绿色大字

> `node ../tools/sync-version.js --check` → ✓ 三端版本一致：v0.216.0
> `node ../tools/gen-theme-dark.js --check` → ✓ 派生调色板已同步（15 套深色变体）
> `node ../tools/build-schedule-plugin.js --check` → ✓ shiguang-schedule 生成物与源一致
> `node ../tools/sync-android-native.js --check` → ✓ Android 原生代码与版本化镜像一致
> `node ../tools/sync-plugins.js --check` → ✓ 17 个内置插件三端同源
> `node ../tools/gen-plugin-icons.py --check` → ✓ 图标无 DIFF（插件 17 + 分类 7）
> `npm test` → PASS: 137 个测试脚本全部通过

动的文件：

- 新增 `public/plugins/cppu-notify/calendar.js`（180 行）—— 原 `public/plugins/cppu-calendar/main.js`
  的 147 行自执行 IIFE 改成 **ES module 工厂**（唯一导出 `createCalendarView(tide)`），
  自己不再 `registerView`
- 删除 `public/plugins/cppu-calendar/`（`main.js` + `manifest.json`）
- `public/plugins/cppu-notify/main.js`（4280 行）—— `loadJwTerm` 增读 `KSRQ` / `JSRQ` / `JXZS`；
  `cppu:term-response` 透传 `termStart` / `termEnd`；新增 `mountCalendarView(el)`（懒加载 calendar.js）
  与第 4 条 `registerView`；`cppu-award` 视图图标 `trophy` → `award`
- `public/plugins/cppu-notify/manifest.json` —— 1.49.0 → 1.50.0；`description` / `author` 改写
- `public/plugins/plugin-guide/main.js` —— 插件清单去掉 `cppu-calendar`，校历改记在警大通知名下
- `src/icons.js` —— 新增 `VIEW_ICONS8` / `VIEW_FA_ICONS`（7 个分类），并入 `ICONS8` 与 `BUNDLED_ICON_KEYS`
- `src/shell.js` —— `viewDef()` 带出 `iconKey: v.id`；`navBtn()` 改用视图 id 取图
- `src/pluginAppearance.js` / `src/navAppearance.js` —— 图标取数增第三个可选参数 `iconKey`
- `tools/gen-plugin-icons.py` —— 新增 `VIEW_ICONS`（7 键）与 ATTRIBUTION 说明
- `scripts/test-cppu-campus.mjs`（285 行）、`scripts/test-cppu.mjs`、`scripts/test-cppu-award.mjs`、
  新增 `scripts/test-plugin-view-icons.mjs`（149 行）、`tools/test-miniprogram-core.js`
- 生成物：`src/pluginCatalog.js`、`miniprogram/core/pluginCatalog.js`、`public/icons/plugins/*.png`、
  `public/icons/plugins/ATTRIBUTION.md`、`miniprogram/images/plugins/*.png`、
  `src-tauri/Cargo.toml` / `Cargo.lock` / `tauri.conf.json`、`miniprogram/core/appMeta.js`

无新增存储键、无数据迁移。校历数据仍写在 `letime-data` 的 `calendar` 键里，结构向后兼容
（`term` 多了两个可选字段 `termStart` / `termEnd`，老数据缺这两个字段时退回推算）。

## 用户要求

> 把警大校历插件也添加进锦达通知插件里面去。
> 请根据警大通知插件的不同分类，侧边栏使用不同的图标，避免使用相同的图标。
> 将起始卡片和结束卡片合并，将日期设置为绿色大字。
> 你的信息来源似乎未参考具有真正效力的校历 `cppu-helper-v15.0.apk`，这里面有真正有效的信息获取方法。

## 一、校历不再单独占一个插件

`cppu-calendar` 过去是一个独立插件（`order: 9.5`），而它的全部取数都靠 cppu-notify 中转：
`emit("cppu:term-request")` → 通知插件登教务 → `emit("cppu:term-response")`。等于一个插件在
替另一个插件做登录，侧栏还多占一行。

并入后的形状与既有的教务分类（选课 / 请假 / 成绩 / 创新学分）**完全一致**：

| | 并入前 | 并入后 |
|---|---|---|
| 视图 id | `cppu-calendar`（独立插件） | `cppu-calendar`（cppu-notify 的视图，id 不变） |
| 外壳 | 自己一套 `.cc-*` 布局，没有侧栏 | `sideShellClass()` + `.pp-side` 校园服务侧栏，与其它分类同一条 |
| 取数 | `cppu:term-request` 事件问通知插件 | 同一个 `loadJwTerm()`，直接拿结果 |

- 视图 id 刻意**保持不变**：`QUICK_LINKS` 的「教务 → 警大校历」入口、用户已有偏好都不用动。
- `calendar.js` 是**纯 ES module**，不引用全局 `tide` —— 走 main.js 里既有的懒加载范式
  （与 `award-list.js` / `award-attach.js` / `card-averages.js` 同构），
  `mountCalendarView()` 里 `import("/plugins/cppu-notify/calendar.js")`，加载失败给一条
  「警大校历模块加载失败，请重新打开本视图重试」，并把 `render()` 返回的清理函数接回去
  （月历定时器 / 事件监听都要能被视图切走时拆掉）。
- `cppu:term-request` / `cppu:term-response` 这对事件**保留**（老版缓存里的独立插件已不存在，
  但事件本身是通用接口，留着不碍事，也避免删掉后再想接第二个消费方时又得加回来）。

## 二、取数：从「推算」改成教务官方字段（对齐 cppu-helper v15.0）

用户指出旧实现的信息来源不对，核对 `cppu-helper-v15.0.apk`（jadx 反编译
`com.cppu.helper.XlFragment$load$res$1`）后确认：**同一个端点、同一份 `data.values`，
只是 U-Time 过去只读了其中四个字段。**

```java
// cppu-helper v15.0 XlFragment$load$res$1（真实校历页的取数）
Cache.loadOrCache(ctx, Cache.K_XNXQ, () -> Api.getXnxq());   // POST /je/system/getNowXnxq
JsonObject v = first.getAsJsonObject("data").getAsJsonObject("values");
str(v, "DM"); str(v, "MC"); str(v, "KSRQ"); str(v, "JSRQ"); str(v, "JXZQSRQ"); num(v, "JXZS");
```

| 字段 | 含义 | 并入前 | 并入后 |
|---|---|---|---|
| `DM` / `MC` | 学期代码 / 名称 | ✅ 读了 | ✅ |
| `JXZQSRQ` | 教学周期起始日 = 教学第 1 周第一天 | ✅ 读了 | ✅（周次换算基准不变） |
| `XQZS` | **学期**周数（含军训 / 假期） | ✅ 当教学周数用 | 只在 `JXZS` 缺失时兜底 |
| `JXZS` | **教学周**总数 | ❌ 没读 | ✅ 优先 |
| `KSRQ` | **学期开始日** | ❌ 没读 | ✅ |
| `JSRQ` | **学期结束日** | ❌ 没读 | ✅ 结束日直接用官方值 |

- 过去结束日是 `起始日 + 周数 × 7 − 1 天` **算出来的**，卡上只能写「推算」；现在直接显示
  教务给的 `JSRQ`，卡上写「官方校历学期起止日」。
- 周数从 `XQZS` 换成 `JXZS` 是同一个 bug 的另一半：`XQZS` 含军训与假期，拿它当教学周数会让
  周次整体偏后、末几周多出不存在的一周。
- `KSRQ ≠ JXZQSRQ` 时（学期起始日含军训 / 假期）卡上补一句「（教学第 1 周起始 …）」，
  两个日子的差别不藏着。
- 拿不到官方值时**不假装知道**：退回推算，并在卡上明写「起始日 + N 周推算，非官方放假日期」。
- 法定节假日不在这里管，仍归 `cn-holiday` 插件；`getNowXnxq` 只给学期起止与教学周。

## 三、侧栏：分类各用各的图标

根因在取图口径：`viewDef()` 里图标是 `PLUGIN_ICONS[v.pluginId] || v.icon`，而 `navBtn()` 又把
**插件 id** 交给 `pluginDisplayIcon()` —— 同一个插件的每个分类取到的都是**插件那一张图**，
所以警大通知的 7 个分类在侧栏长得一模一样（彩色 PNG 走 `/icons/plugins/cppu-notify.png`，
窄屏走 FA 轮廓 `building-columns`，两种模式都一样）。

改法是把「图标来源」与「配色 / 自定义覆盖的来源」分开：

```js
// src/shell.js
const iconKey = isPlug ? (def.pluginView?.id || def.pluginView?.pluginId) : id;
pluginDisplayIcon(def.pluginView.pluginId, def.title, iconKey);        // 图按视图 id
pluginDisplayOutlineIcon(def.pluginView.pluginId, def.title, iconKey); // accent 仍按插件 id
```

- `pluginDisplayIcon(id, title, iconKey = "")` / `pluginDisplayOutlineIcon(...)` 的第三参缺省时
  行为与过去**逐字节相同** —— 所以这是纯增量改动。
- **accent 色与用户自定义图标仍按插件 id**：用户给警大通知换的图标要对它所有分类生效，
  不能只改一个分类。
- 只有「一个插件注册多个视图」时才会看到差别；其余 16 个插件的视图 id == 插件 id，
  取图结果与过去完全一致（零影响）。
- 手机窄屏（≤900px）走 FA 轮廓图标，分类之间同样两两不同：两套名字空间分别给了表
  （`VIEW_ICONS8` 是 Icons8 slug，`VIEW_FA_ICONS` 是 sprite 里的 symbol id），**不能混用**。

7 个分类的图标（彩色 PNG / FA 轮廓），同一个侧栏里两两不同、也不与其余 17 个插件相撞：

| 分类 | 视图 id | 彩色 | FA 轮廓 |
|---|---|---|---|
| 警大通知 | `cppu-notify` | university | building-columns |
| 警大一卡通 | `cppu-card` | bank-cards | credit-card |
| 警大获奖名单 | `cppu-award` | prize | award |
| 学生选课 | `cppu-xk` | todo-list | list-check |
| 学生请假 | `cppu-qj` | calendar-delete | calendar-xmark |
| 警大成绩 | `cppu-credit` | line-chart | chart-line |
| 创新学分 | `cppu-cx` | medal | medal |
| 警大校历 | `cppu-calendar` | calendar | calendar-week |

两处刻意避开的重名：`cppu-award` 的轮廓图标从 `trophy` 改成 `award`（`trophy` 已是「竞赛消息」
`gx-news` 的侧栏图标）、`cppu-calendar` 从 `calendar-days` 改成 `calendar-week`
（`calendar-days` 已是「课程表」`shiguang-schedule` 的）。同一个侧栏里撞图标 = 用户认不出来。

## 四、起止合并成一张卡 + 绿色大字

原来的 `.cc-summary` 是**四列**：①「当前学期」（副行写起始日）②「学期教学结束日 · 推算」
③ 当前教学周 ④ 本周课次统计。用户要的「起始卡片和结束卡片合并」就是①②并成一张：

```
┌─ 当前学期 · 起止 ────────────────────┐ ┌─ 当前教学周 ─┐ ┌─ 本周课程 ─┐
│ 2026-2027 学年第 1 学期              │ │ 第 12 周      │ │ 18 节      │
│ 起始 2026-09-01  →  结束 2027-01-17  │ │ 按今天         │ │ 剩 42 节   │
│ 官方校历学期起止日 · 教学 20 周       │ │               │ │            │
└──────────────────────────────────────┘ └───────────────┘ └────────────┘
```

- 日期是**绿色大字**：`font-size: 24px` / `font-weight: 800` / `font-variant-numeric: tabular-nums`
  （两个日期等宽对齐，不会因数字宽度不同而参差）；窄屏 20px。
- 绿色用 `light-dark()` 成对给值：浅色 `#0f7a43`、深色 `#4ade80`。
  **不引新令牌**是有原因的：现有语义色里唯一偏绿的是 `--mint`（浅色 `#2EC4B6`），
  落在白卡上只有约 1.9:1，当文字色根本看不清；而 `#0f7a43` 在白卡上约 5.3:1、
  `#4ade80` 在深色 `--card` 上约 8.6:1，都过 AA。这与本文件既有的
  `.cc-now strong{color:#b42c3c;color:light-dark(#b42c3c,#ff8995)}` 是同一套路。
- 网格从 4 列改 3 列（`minmax(0,1.5fr) minmax(0,1fr) minmax(0,1fr)`），起止卡拿宽的那一列；
  窄屏单列不变。

## 守卫

`scripts/test-plugin-view-icons.mjs`（新增，149 行）：用最小 DOM 替身真跑
`src/pluginAppearance.js`（先 `initStore` + 假 `localStorage`），从 `cppu-notify/main.js`
正则取出 4 条字面 `registerView` 与 `JW_VIEWS` 块的 `id/title/icon`，断言：

- 7 个分类的**彩色 PNG src 与 FA 轮廓名都两两不同**，且不等于插件自己那张；
- `VIEW_FA_ICONS` / `VIEW_ICONS8` 的键与视图一一对应、声明与消费口径一致；
- 把 17 个插件 manifest 的轮廓名 + 7 个分类建成 21 项占用表查重（同一侧栏不许撞）；
- 7 张 PNG 存在、字节两两不同、与 `miniprogram/images/plugins/<key>.png` 同源；
- FA sprite 含全部 8 个 symbol；`shell.js` / `pluginAppearance.js` 的接线正则还在。

`scripts/test-cppu-campus.mjs`（改）：第 7 行改读并入后的 `cppu-notify/calendar.js`；新增
`calendarHarness(box)`（把 `export function createCalendarView(tide) {` 换成全局赋值再追加
`;globalThis.test = createCalendarView(tide);`）替代原来两处 `calendar.replace(/\}\)\(\);\s*$/, …)`；
新增三组断言：

- **起止合并成一张卡**：`class="cc-term"` 恰好 1 个、`class="cc-date"` 恰好 2 个、
  官方 `JSRQ` 优先、`KSRQ ≠ JXZQSRQ` 时补注、无官方值时含「非官方放假日期」；
- **绿色大字**：`.cc-date b` 的 24px / 800 字重 / `tabular-nums` / `light-dark(#0f7a43,#4ade80)`，
  并遍历 `bannerPalettes()` 的 34 张色板对 `--card` 取两档绿的较优值算 AA
  —— **实测最低 5.14:1**（nephele(浅色) 用 `#0f7a43`）；
- **并入结构**：`cppu-calendar` 的 manifest 已不存在、两端 `pluginCatalog` 里没有
  `"cppu-calendar"` 插件条目、`registerView` 用 `calendar-week`、
  `import("/plugins/cppu-notify/calendar.js")`、`KSRQ` / `JSRQ` / `JXZS` 三条正则都在。

同一条测试里的横幅配色断言（沿用）也复跑：34 张色板 × 3 态，正文最低 6.23:1、提示 5.03:1，
底色与视图底色最小通道差 19。

## 变异验证（实测）

| 变异 | 结果 |
|---|---|
| `termEndOf()` 不看官方 `term.termEnd`（退回推算） | RED（结束日断言） |
| 起始日改读 `jxStart`（丢掉 `KSRQ`） | RED |
| `loadJwTerm` 丢掉 `KSRQ`（不再读 `termStart`） | RED |
| `.cc-date b` 24px → 20px | RED（绿色大字断言） |
| 侧栏取图退回插件级（`iconKey` → `pluginId`） | RED（7 个分类两两不同断言） |

五条还原后 `test-cppu-campus.mjs` 与 `test-plugin-view-icons.mjs` 均 PASS。

## 已知边界（有意接受）

- **侧栏图标只在「一个插件有多个视图」时才有差别。** 其余 16 个插件每插件一个视图、视图 id
  等于插件 id，取图结果与过去逐字节相同 —— 这次改的是口径，不是外观。
- **置顶 / 排序表里若残留旧插件 id `cppu-calendar`，它不会再出现。** 校历现在是 `cppu-notify`
  的视图，按插件 id 索引的置顶与排序对那个残留项失效（视图本身照常出现在「警大通知」下）。
- **官方起止日依赖教务登录。** 未登录 / 会话过期时只显示缓存或退回推算，卡上会明写「推算」。
- **`getNowXnxq` 给的是学期起止与教学周，不是放假安排。** 法定节假日仍由 `cn-holiday` 负责。
- **`JXZS` 缺失才用 `XQZS`。** 两者口径不同（教学周 vs 学期周），兜底值可能让末周偏差一周，
  这种情况卡上写的是「推算」。

## 版本归属

`docs/CHANGELOG-v0.215.0.md` 是**侧栏颜色组整卡拖动**（`src/pluginSectionDrag.js`）的档，
本次校历 / 图标改动另立 v0.216.0，两份档各管各的功能。工作树里三份未提交的版本说明因此是
v0.214.3（插件中心卡片拖动改尺寸）→ v0.215.0（侧栏颜色组整卡拖动）→ v0.216.0（本次），
`package.json` 停在 0.216.0，覆盖三者。
