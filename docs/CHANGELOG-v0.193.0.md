# v0.193.0 · 警大一卡通视图只留统计：顶部装饰、说明段与九个按钮的工具栏一起删掉

> `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.193.0`；
> `node tools/sync-plugins.js --check` → `✓ 插件生成物与清单同源（--check 未写盘）：18 个内置插件`。
> 动的文件：桌面插件 `public/plugins/cppu-notify/main.js` + `manifest.json`（插件版本 1.40.0 → **1.41.0**）、
> 重写回归测试 `scripts/test-cppu-card-buttons.mjs`、修订 `scripts/test-cppu.mjs` 里一条名不副实的断言、
> 根 `package.json` / `package-lock.json`（0.192.1 → **0.193.0**）、根 `docs/CHANGELOG-v0.193.0.md`。
> `sync-plugins.js` 顺带把两端 `pluginCatalog.js` 的目录版本号刷成 1.41.0。

## 用户要求原文

> 「删除图上所有元素。只有统计有用，但这个小按钮不用建，直接显示总界面即可。」
> （附界面截图：一卡通视图顶部 —— 「校 园 服 务 · 一 卡 通」小标 + 「一卡通 / 慧新易校 / 新中新 H5」标题行 +
> 「统计 / 账单 / 同步账单 / 首页 / 充值 / 账户中心 / 刷新 / 应用内新窗打开 / 回通知」九个按钮的工具栏 +
> 那段「U-Time 会自动登录一卡通并读取平台账单…」说明段）

## 一、现象读法

截图里那四样东西（小标、标题行、工具栏、说明段）是**视图自己的壳**，不是宿主给的；它们在
`public/plugins/cppu-notify/main.js` 的 `cardShellHtml()` 里一次性拼出来，渲染进
`plug:cppu-card`（视图标题「警大一卡通」）的容器。用户说的是「图上所有元素都删掉，只留统计」，
并且点名「统计」那个按钮**不用建** —— 因为统计本来就是这个视图唯一的主体，让用户先点一下按钮才能看到统计，
等于给唯一的内容加了一道门。所以这不是「隐藏几个按钮」，是**把统计从「一个标签页」提升成「整个视图」**。

## 二、改法：删壳、留核

一处结构性改动 + 一批文案同步，都在 `public/plugins/cppu-notify/main.js`：

1. **`cardShellHtml()` 顶部整条删除**：`<div class="jw-kicker">校 园 服 务 · 一 卡 通</div>`、
   `<div class="jw-head"><h3>一卡通</h3><span>慧新易校 / 新中新 H5</span></div>`、
   整个 `<div class="pp-toolbar">`（统计 / 账单 / 同步账单 / 首页 / 充值 / 账户中心 / 刷新 /
   应用内新窗打开 / 回通知，连同尾部那根 `<span style="flex:1">` 撑杆）、
   `<div class="jw-tip">U-Time 会自动登录一卡通并读取平台账单…</div>`。
   删完外壳的第一行直接就是状态行：`<div class="pp-wrap">` → `<div class="yk-status" data-card-status …>`。
2. **保留**：左侧「校园服务」侧栏（`sideHtml()` / `sideToggleHtml()`，它在 `pp-shell` 里，是各视图共用的导航，
   不属于截图里的那一块）、状态行 `[data-card-status]`、登录区 `[data-card-login-box]`、
   内嵌网页容器 `[data-card-web]`、统计区 `[data-card-stats]`（`cardStatsHtml()`：总充值量 / 已花费 /
   当前余额 / 账单来源 + 日均餐费面板 + 流水统计柱状图 + 流水列表）。统计现在是**进入视图立刻可见**，
   不再需要点「统计」按钮。
3. **文案同步**（旧文案还在教用户点已经不在的按钮）：空态改成「…记录。连接校园网后重新进入本视图会自动再同步一次。」；
   日均统计失败改成「日均统计暂不可用，不影响账单与流水统计」；切回本地数据改成「已切回本地账单与统计。」；
   内嵌网页的三条提示与 `onFrameLoad`/`onFrameError` 改成「请在浏览器中打开官方页面 / 请在浏览器中完成官方登录 /
   请改用浏览器打开」；缓存读失败改成「可填写账号后重新登录同步。」；首次进入改成
   「首次使用请填写一卡通学/工号和密码，登录后会自动同步平台账单。」。
4. **JS 逻辑一行没删**（刻意的）。`selectPage` / `showWeb` / `onFrameLoad` / `onFrameError` / `setSyncBusy`、
   以及 `summary` / `billing` / `sync` / `home` / `recharge` / `center` / `reload` / `open` / `back`
   这些**旧工具栏分支现在不可达但保留备用**。理由：删掉内嵌网页子系统会牵动 `navSequence` / `syncFlight`
   这两道**仍然可达**的竞态守卫（`login` / `change` / `refresh` / `mode` / `kind` 都走它们），
   风险大于收益；保留之后，如果以后要把「账单 / 充值」放回来，加个入口即可，不必重写。
5. **视图仍然活着的交互**：进入视图自动登录 + 自动同步平台账单；拉取失败时状态行整条变成刷新入口
   （点一下 = 清错 + 重新登录 + 重拉）；登录表单的「登录并自动同步 / 更换账号」；
   统计里的「充值 / 消费」与「年 / 月 / 日」两组切换（只重画统计，不触发网络）。

## 三、验证

**重写 `le-time-management/scripts/test-cppu-card-buttons.mjs`**（原版断言「外壳里必须有那九个按钮」，
现在必然失败，且它守的正是被删掉的东西）。新版用真源码跑：`vm` 里执行插件、假 DOM 认外壳 HTML、
运行时节点（登录区 / 状态行 / 统计区 / 失败横幅）由 `cardPaintLogin()` / `cardStatsHtml()` /
`bannerRefreshHtml()` 生成后注入，`tide.http` / `tide.vault` / `tide.util.openCardPage` 全部打桩。

- **Block A 外壳契约**（本次用户要求的回归守卫）：外壳 HTML 不含 `pp-toolbar` / `jw-kicker` / `jw-head` /
  `data-card-{summary,billing,sync,home,recharge,center,reload,open,back}`；且 `pp-wrap` 后紧跟的就是
  `yk-status`；`pp-side` / `data-card-status` / `data-card-login-box` / `data-card-stats` / `data-card-web`
  都在；统计区**不隐藏**、内嵌网页容器**隐藏**；点击委托挂 1 个、dispose 后 0 个。
- **Block B 可达交互**：缓存与日均模块双双失败时状态行仍有可读提示、统计区照常显示、委托不丢；
  无凭据点失败横幅 → 提示「请先填写」且不发请求；有凭据 → 真重新登录重拉；年/月/日 + 充值/消费
  只重画统计（`paint` +2、`sync` 不变）；「更换账号」清空凭据并删密钥；dispose 后定时器归零。
- **Block C 竞态**：有凭据时进入即同步；同步未返回时连点失败横幅**只跑一趟**；重复挂载不堆积委托。
- **Block D 保留备用分支**：`home` / `reload` / `summary` / `sync` / `billing` / `recharge` / `center` /
  `open` / `back` 逐条驱动一遍（外壳已不渲染，但处理器留着就得防腐烂）。
- **Block E 深链鉴权**：`cardAuthedUrl` 的 `synjones-auth` 覆盖 / 移除 / 拒恶意域，以及
  `src/api.js` 的 `openCardPage` 原生白名单。

```
PASS: card view renders statistics as the whole view (no kicker, no title head, no toolbar, no tip), keeps status/login/stats, auto-syncs on entry, retries from the failure banner, switches 年/月/日 and 充值/消费, and still honors deep-link auth
```

**变异测试**证明 Block A 真在守这件事：把删掉的那四块（小标 / 标题行 / 工具栏 / 说明段）任意一块塞回
`cardShellHtml()`，该脚本立刻变红；复原后转绿。

**全量**：`npm test` → **126/127** 个脚本通过（含本条 CHANGELOG，`test-release-history.mjs` 校验
「新版本记录必须位于首条」）。唯一变红的是 `test-ai-chat.mjs`（断言「已收集 N 条」要排在输入框上面），
那是**同一时间正在被编辑的 `public/plugins/ai-chat/main.js` 未完成改动**（该文件落盘时间与本次改动重叠），
与一卡通无关，本次未触碰。cppu 相关的 7 个脚本（`test-cppu.mjs` / `test-cppu-cache.mjs` /
`test-cppu-campus.mjs` / `test-cppu-card-averages.mjs` / `test-cppu-card-buttons.mjs` /
`test-cppu-jw-login-once.mjs` / `test-cppu-login-settings.mjs`）全部通过。

## 四、影响面

- 只影响「警大一卡通」这一个视图的外观；桌面端与 Android 同源（`public/plugins/cppu-notify/main.js` 一份代码两端跑）。
- 数据、缓存、密钥库、同步逻辑、失败横幅刷新入口全部不变，**无数据迁移**。
- 「账单 / 充值 / 首页 / 账户中心 / 应用内新窗打开 / 回通知」这六个入口在界面上消失；
  内嵌网页仍会在需要时（如深链进入）显示，只是不再有按钮主动打开它。
- 其它视图（通知、教务各视图、宿舍值日等）不受影响：被删的 `jw-kicker` / `jw-head` / `jw-tip` 的 CSS
  **保留未删**，它们同时被教务视图的通用壳 `jwShellHtml()` 使用。
