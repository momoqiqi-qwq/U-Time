# v0.214.1 · 插件中心的分组不再「只显示一个」：组头计数与视图入口都和侧栏同口径

> `node ../tools/sync-version.js --check` → ✓ 三端版本一致：v0.214.1
> `node ../tools/gen-theme-dark.js --check` → ✓ 派生调色板已同步（15 套深色变体）
> `node ../tools/build-schedule-plugin.js --check` → ✓ shiguang-schedule 生成物与源一致
> `node ../tools/sync-android-native.js --check` → ✓ Android 原生代码与版本化镜像一致
> `npm test` → PASS: 135 个测试脚本全部通过

动的文件：

- `src/shell.js` —— `renderMarket()` 的 `fillCards()`：组头计数改口径（新增 `entryCount`）、组头登记刷新器（`headRefreshers`）、多视图卡片带 `has-views`；两处视图入口去掉平台分叉；`refreshMarketState()` 的增量分支同时刷组头
- `src/styles/feature-layouts.css` —— 视图入口行新增 `@media (min-width: 901px)` 桌面紧凑覆写（基础那套 2 列 / 44px 是照触屏写的）+ 多视图卡片跨两列
- `scripts/test-market-group-count.mjs` —— **新增**回归闸（组头计数 / 计数随视图晚注册刷新 / 桌面入口 / 跨列 / 单视图不挂行 / CSS 顺序）
- `scripts/test-android-plugin-views.mjs` —— 桌面断言反转为「桌面也要列全」，并加静态断言禁止再按平台分叉
- `scripts/test-ui-scale.mjs` —— px 断点对照表 901 由 4 → 5（本版新增一处），按文件里那条「真要新增断点，连着这个表一起改」的规矩改
- `src-tauri/gen/android/app/src/main/assets/tauri.conf.json` —— `node ../tools/sync-android-native.js` 生成物（上次发版漏同步的版本字段，本次一并归位）
- `package.json` / `package-lock.json` —— 0.214.0 → 0.214.1（lock 两处手改）

无新增存储键、无数据迁移。分组元数据（`settings.pluginGroups` / `pluginOverrides[id].color`）读写一字未动。

## 用户要求

> 修复bug，绿色组包含许多插件，但在插件组页面仅显示一个。

两张截图对着看：侧栏「绿色组」计数徽标 **7**，下面 7 行（警大成绩 / 警大创新学分 / 警大获奖名单 /
警大请假 / 警大通知 / 警大选课 / 警大一卡通）；插件中心「绿色组」计数徽标 **1**，只有一张卡
「警大门户通知」。

## 一、根因：两处数的不是同一个东西

| | 成行的单位 | 组头计数 |
|---|---|---|
| 侧栏 `renderNav()` | **视图**（`orderedPluginViews()` 按 `pluginId` 归拢后整组摊开） | `groupFoldButton("plug-group", color, views.length, …)` = 视图条数 |
| 插件中心 `renderMarket()` | **注册插件**（一张卡 = 一个插件） | `colorCount` 按 `pluginColor(rec.id)` 累加 1 = 插件个数 |

`cppu-notify` 这一个插件就注册了 **7 个视图**（`public/plugins/cppu-notify/main.js`：通知、一卡通、
获奖名单，外加 `JW_VIEWS` 循环里的成绩 / 创新学分 / 请假 / 选课），`pluginHost.registerView()` 给
每个视图打的 `pluginId` 都是注册插件的 id —— 所以侧栏那 7 行的图标是同一枚柱式大楼、右侧都挂
`内置`，它们本来就是同一个插件的 7 张脸。

再叠加一条历史决定：卡片上的视图入口原来只在 APK 露（`isAndroidRuntime() && cardViews.length > 1`，
注释写的理由是「APK 没有桌面插件侧栏」）。桌面端于是**既**只显示一张卡、**又**没有任何入口通向
另外 6 个视图 —— 用户看到的「绿色组包含许多插件，但只显示一个」就是这个差。

## 二、修法：三处一起改

1. **组头计数与侧栏同口径**（`src/shell.js`）：`fillCards()` 里新增
   `const entryCount = (id) => Math.max(1, pluginViews.filter((v) => v.pluginId === id).length);`，
   `colorCount` 累加 `entryCount(rec.id)`（原来累加 1）。「一个插件至少计 1」是为了单视图插件
   不被算成 0。同一个 `groupFoldButton()` 被两处复用，现在两处给的是同一个数。
2. **视图入口不再按平台分叉**：卡片创建处与 `refreshCard()` 重建处都去掉 `isAndroidRuntime()`，
   两个端点同一份 DOM。
3. **桌面端另给紧凑形态**（`src/styles/feature-layouts.css`）：基础那套 `display:grid` 两列 +
   `min-height:44px` 是照触屏写的，7 枚竖排会把卡片顶成四倍高（无头 Chrome 实测：364px vs 邻卡 100px），
   所以新增 `@media (min-width: 901px)` 覆写成可换行的小胶囊（`min-height:24px`、11px 字、`border-radius:999px`）。
   ⚠️ 媒体查询**不加特异性**，这条必须写在同文件基础规则之后（同特异性靠顺序取胜），`styles.css`
   反而加载在前 —— 写进 `styles.css` 是死代码。
4. **组头计数要能跟着视图注册走**（`src/shell.js`）：插件 `main.js` 是启动后**异步逐个** `registerView()` 的，
   首帧可能只到位一部分视图。`onNavChanged` → `refreshMarketState()` 在「插件成员没变」时走增量分支，
   只调 `cardRefreshers` —— 卡片被补成 7 枚入口，**组头却冻在首帧那个数字上**。这就是真机上「卡片有 7 个入口、
   组头仍写 1」的机器化解释，也是只改计数口径修不掉的那一半。现在 `fillCards()` 给每个组头登记一个
   `headRefreshers` 刷新器，`refreshMarketState()` 的增量分支与卡片一起推它（没必要为一次注册重排整个网格）。
   实测：修前 `heads=["green=1"]`，修后 `heads=["green=7"]`。
5. **多视图卡片跨两列**（同 CSS）：桌面磁贴 `minmax(--market-card-w, 180px)` 落到实处只有 181px，
   内容宽 147px —— 两枚中文胶囊就要 156px（实测 76 + 76 + gap），不跨列只能一行一枚，卡片照样是 350px 的高塔。
   跨两列后 371px 宽、7 枚入口两行（4 + 3）排完，卡片 179px。类名 `.mcard.has-views` 由 `fillCards()` 建卡时
   与 `refreshCard()` 里 `card.classList.toggle("has-views", views.length > 1)` 两处维护。

侧栏一行的单位**不改**：它按视图成行，改了就是 7 个视图只剩一个能进。

## 守卫

- `scripts/test-market-group-count.mjs`（新增，真跑 `renderMarket()`）：
  绿色组给「A 插件 3 视图 + B 插件 2 视图」，断言组头 `.market-group-count === "5"`（不是插件数 2）；
  `isAndroidRuntime: false` 下 A 卡仍有 3 枚入口、`data-plugin-view` 与视图 id 一致、逐枚点进
  `plug:<id>`；单视图插件不挂入口行；**再 push 两个视图给 A 并调 `refresh()`，断言组头变 `"7"`、卡片入口变 5 枚**
  （这条锁的是「组头不随晚注册刷新」）；静态断言 `renderMarket` 代码块里不许再出现 `isAndroidRuntime`、
  必须登记 `headRefreshers` 且增量分支里同时刷它；CSS 断言桌面覆写存在、`min-height:24px` 排在 `44px` 之后、
  `.mcard.has-views` 跨两列，JS 断言建卡与 `refreshCard()` 都维护 `has-views`。
  变异验证（实测）：①把 `+ entryCount(rec.id)` 还原成 `+ 1` → 组头计数断言红；②把刷新器里的
  `countOf(color)` 改成读旧值 → 晚注册那条断言红（`'5' !== '7'`）。
- `scripts/test-android-plugin-views.mjs`：原来那条
  `assert.equal(draw(false, true), null, "desktop retains existing sidebar navigation")`
  正是这条 bug 的机器化写法，已反转成「桌面同样拿到全部 7 个入口」。
- `scripts/test-ui-scale.mjs`：901px 断点 4 → 5。

## 已知边界（有意接受）

- 多视图插件的卡片更高也更宽（桌面端跨两列、7 枚胶囊占两行，实测 179px vs 邻卡 100px）：
  这是把 7 个视图亮出来的代价；磁贴宽度 180px 装不下两枚中文胶囊，压到一行一枚反而更高（350px）。
- 组里只有一个多视图插件时，那一行右侧的列会空着（卡片跨了两列，组内没有别的卡片去填）——
  网格是 `auto-fill`，补不齐就留白。
- 侧栏与插件中心仍是两种粒度（视图 / 插件），只是**计数口径**统一了：同一个组在两处数字一致，
  卡片数则必然少于侧栏行数 —— 一个插件多个视图时，卡片下面挂着入口行。
