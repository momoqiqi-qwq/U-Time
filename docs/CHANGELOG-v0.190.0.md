# v0.190.0 · 其余警大插件的失败横幅也整条可点，而且配色跟着主题 / Nephele 走

> `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.190.0`；
> 只动两个内置插件（`public/plugins/cppu-notify/`、`public/plugins/cppu-calendar/` 的
> `main.js` + `manifest.json`）与 `scripts/test-cppu.mjs`、`scripts/test-cppu-campus.mjs`、
> 新增的 `scripts/lib/banner-contrast.mjs`；桌面 / 手机端共用的 `src/styles.css`、主题文件、
> 小程序、Rust 侧、`tauri.conf.json` 均无改动。

## 用户要求原文

> 「其他警大插件如果有「登录失败 / 拉取失败」横幅，也添加整条变成刷新入口：点一下 = 工具栏「刷新」，重拉该视图全部数据。
>
> 颜色适配 nephele 风格」

## 一、先确认「其他警大插件」里到底有哪几条这样的横幅

上一个版本（v0.189.0）已经让 `cppu-notify` 的**教务子页**横幅（`.pp-banner`，11 个取数块共用）可点。
这次按「同一插件内其余会写出失败文案的地方」+「同属警大门户家族的校历插件」两路扫：

| 位置 | 改前形态 | 本次处理 |
|---|---|---|
| `cppu-notify` 通知视图 | `<span class="err">登录或连接失败…</span>`（`paintStatus()`） | 升级为可点横幅 |
| `cppu-notify` 一卡通视图 | `.yk-status.warn` 里的纯文字（`cardSetStatus(el,text,true)`） | 升级为可点横幅，并新增 `refresh` 动作 |
| `cppu-notify` 教务视图 | v0.189.0 已可点 | 换成共用助手产出，输出零变化 |
| `cppu-calendar` 校历 | `<p class="cc-status">读取校历失败：…</p>`（读取失败）与教务学期同步超时的状态文字 | 升级为可点横幅 `[data-action="retry"]` |
| 其他警大插件（抄送 / 课表 / 讲座 / 网络 VPN 等） | 错误面是 `.gh-err` / `.ch-err` / `.sn-warn`，或本来就是工具栏可刷新的空态 | 不动（没有「登录失败 / 拉取失败」横幅这回事） |

## 二、改法之一：把「可点失败横幅」抽成一份共用产出

`cppu-notify` 里新增一个助手（教务视图也改用它，所以三处形态天生一致）：

```js
function bannerRefreshHtml(text, action) {
  return `<button type="button" class="pp-banner pp-banner-act" data-${action}><span class="pp-banner-txt">${esc(text)}</span><span class="pp-banner-act-hint">点击刷新</span></button>`;
}
```

- **通知视图**：`paintStatus()` 的错误分支改用它（`data-banner-refresh`）。状态行每次重绘都会换掉内部按钮，
  所以点击用**容器委托**收：`ui.status.addEventListener("click", e => { if (e.target.closest("[data-banner-refresh]")) loadPage(1); })`。
- **一卡通视图**：`cardSetStatus(el, text, warn)` 在 `warn` 时改用 `bannerRefreshHtml(text, "card-refresh")`；
  点击委托的 `names` 数组尾部加 `'refresh'`，新分支先把 `error` / `balanceError` 清空 → 回到「总览」→
  `captureCredentials()` → 没填学工号/密码就提示并聚焦输入框 → 否则 `await sync(false)`。
  这样点一下等于原来的「登录并自动同步」。先填凭据再同步这条顺序不能反，否则会把用户刚改的密码丢掉。
- **教务视图**：`jwStateBlock()` 错误分支改用同一助手，产出与 v0.189.0 逐字节相同（`data-jw-banner-refresh` 不变）。
- **校历**：`state` 多一个 `retry: null | "load" | "term"`；`statusHtml()` 在有 `retry` 时吐
  `<button class="cc-banner" data-action="retry">…<span class="cc-banner-hint">点击重试</span></button>`，
  否则仍是原来那行 `<p class="cc-status" role="status">`；`paint()` 里给横幅接上 `retryFail`。
  `retryFail()` 按 `retry === "term" ? syncTerm() : reload()` 决定重跑哪一步 —— 这是本次唯一「重跑的不是全部数据」的地方：
  校历的失败点有两处，学期同步失败时重跑读取毫无意义。

顺带补掉一个真缺陷：`reload()` 的**成功**分支原来只写 `state.status = ""; requestStats();`，
而 `requestStats()` 只替换统计卡、不重画视图，于是界面会永远停在开头画的那一帧「正在读取校历…」
（`当前学期` 显示「尚未设置」）。用 `git show HEAD:` 的旧版对照过，v0.3.0 就如此，属于老毛病；
但版本新增「点横幅重试」后，成功重试也会卡住，所以补上 `paint()`：

```js
state.status = ""; paint(); requestStats();
```

## 三、改法之二：配色改用主题令牌 + `color-mix`，Nephele 自动跟随

改前横幅是浅米黄硬编码 + 两个专用文字色，与 Nephele（把 `--panel` / `--bg` 换成紫色系）或深色主题放在一起就脱节。
现在底色 = `--deep` 按比例混进 **`--bg`**（不是 `--panel`），文字直接吃 `--ink`：

```css
background: color-mix(in srgb, var(--deep,#0F4C5C) 14%, var(--bg,#F2EFEA));
border: 1px solid color-mix(in srgb, var(--deep,#0F4C5C) 38%, var(--bg,#F2EFEA));
color: var(--ink,#22303A);
/* :hover 22% / :active 32% / :focus-visible outline:3px solid var(--deep) */
/* 右提示：color-mix(in srgb, var(--deep) 30%, var(--ink)) */
```

**为什么是 `--bg` 而不是 `--panel`**：横幅挂在插件视图的最顶部、**不在卡片里**（`.plugview` 自身没有背景，
`src/styles.css:909`），所以它周围的可见面是页面底色 `--bg`。首版混的是 `--panel`，在 Nephele 浅色下撞了色：
`--panel #fbf8ff` 与 `--bg #ece5f4` 在紫色调下几乎同档，算出来横幅底 `#ECE4F3`、周边 `#ECE5F4` ——
**只差 1 个通道，等于横幅没画出来**。改成混 `--bg` 后同一处差 20 个通道。实测同一行像素（宿主 1100px，`y=132`）：

```
改前(混 --panel 12%)  #ECE5F4 ×104 | #ECE4F3 ×872 | #ECE5F4 ×61   通道差 1
改后(混 --bg    14%)  #ECE5F4 ×104 | #DDD1E8 ×872 | #ECE5F4 ×61   通道差 20
```

- 两个插件用同一套比例，`@media(prefers-reduced-motion:reduce)` 里都补了
  `.pp-banner-act,.pp-banner-act-hint::before{transition-duration:.01ms!important}` /
  `.cc-banner,.cc-banner-hint::before{…}`。
- 校历的横幅要压过既有的 `.cc-wrap button`（0,1,1），所以选择器写成 `.cc-wrap .cc-banner`。
- 顺手修掉两个插件里 `color:#fff` 压浅强调色的问题，改成 `var(--on-accent,#fff)`。
- 兜底值就是这个仓库的默认全局色（`#0F4C5C` / `#F2EFEA` / `#22303A`，`--bg` 的默认值取自
  `src/styles.css:7`），主题没定义变量时长相不变。

**34 张色板 × 3 态实测最低对比度**（16 主题 × 浅/深 + Nephele 浅/深，全部过 AA 4.5）。
混比越大底色越偏 `--deep`，对比度越低，所以按下态就是全局下限：

| | 正文 `--ink` | 右提示（`--deep` 30% 混 `--ink`） |
|---|---|---|
| 常态（14%） | ≥ 6.23:1 | ≥ 5.03:1 |
| 悬停（22%） | ≥ 6.23:1 | ≥ 5.03:1 |
| **按下（32%）最低** | **6.23:1**（nephele 浅色） | **5.03:1**（nephele 浅色） |

同时还有一条**底色与视图底色至少差 16 个通道**的守卫（34 张 × 3 态实测最小 19，forest 深色静止态），
它专门守上面那次「Nephele 只差 1 个通道」的坑：把比例压到 2/3/4% 只有它会红。
提示色一开始用的是 `--deep` 55%，深色主题按下态只有 4.30–4.43:1，所以降到 30%（正文维持 `--ink` 不动）；
纯 `--deep` 当提示色更是只有 3.86:1，不能用。这些数字不是写死的常数：
`scripts/lib/banner-contrast.mjs` 从 `src/styles.css` / `src/styles/theme-derived.css` /
`src/styles/nephele-settings.css` 里现读色板、现算，测试再按 CSS 里真实的百分比重跑矩阵，
所以「改比例」「改主题」「把 `color-mix` 换成硬编码」都会红。

## 四、验证

真渲染（无头 Chrome + 真 `src/styles.css` + `theme-derived.css` + `nephele-settings.css`，宿主是
真实的 `<main class="plugview">`；最小 tide 替身复现有缓存、登录失效、取数一律 `connection refused` 的状态）：

```
主题令牌（读 <html> 上的 computed）
  light   --deep #0F4C5C  --panel #FFFFFF  --bg #F2EFEA  --ink #22303A
  dark    --deep #37A6A0  --panel #1C2833  --bg #111820  --ink #E7F0EE   （data-theme=night + data-theme-mode=dark）
  nephele --deep #81559b  --panel #fbf8ff  --bg #ece5f4  --ink #3e344f   （data-nephele-settings=on）
  nephele 深 --deep #d3afe9 --panel #31263f --bg #211b2b --ink #f6eefc

横幅计算色（两插件逐项相同）
  light   bg color(srgb .824392 .847765 .839686)  color rgb(34,48,58)    hint color(srgb .11098 .221176 .267451)
  dark    bg color(srgb .0875294 .172078 .195765) color rgb(231,240,238) hint color(srgb .698824 .854118 .841569)
  nephele bg color(srgb .866745 .81898 .908)      color rgb(62,52,79)    hint color(srgb .321961 .242745 .399216)
  nephele 深 bg color(srgb .268392 .21349 .327059) color rgb(246,238,252) hint color(srgb .916667 .846863 .962157)
  → 与公式逐位吻合（浅色 .14*15+.86*242 = 210.22 → .824392；提示 .30*15+.70*34 = 28.3 → .11098），
    换主题 / 切深浅 / 开 Nephele 全自动跟随，插件里没有任何配色分支。校历与通知两个插件的
    计算色逐项相同，证明用的是同一套令牌配方。
  → 底色 vs 视图底色通道差：light 32、dark 20、nephele 20、nephele 深若干（截图逐像素量过）

几何（宿主 1100px，全部无横向溢出 overflow=false / docOverflow=false）
  notify   BUTTON[data-banner-refresh]        880×69.2  x=162  （正文折两行）
  card     BUTTON[data-card-refresh]          880×47.6  x=162  （与 v0.189.0 教务横幅同尺寸）
  jw       BUTTON[data-jw-banner-refresh]     880×47.6  x=162
  calendar BUTTON[data-action="retry"]       1084×44    x=8
  四条都 min-height 44px、cursor pointer、radius 12px、touch-action manipulation，hint ::before "↻"

真点击（同一份页面里 banner.click()）
  notify   http 9 → 12（+3）        点后文案 登录或连接失败… → 连接失败…         横幅仍在
  card     http +1（session + fetch）                                             横幅仍在
  jw       http +2                                                                横幅仍在
  calendar http +0，storage.get 1 → 2（+1）  点后「当前学期 2026 秋季学期」、横幅消失
```

「改前 vs 改后」的可见性证据：把渲染后的页面按旧配色（混 `--panel` 12%）重做一份静态壳、逐像素量同一行，
得到上面那段 `#ECE4F3` vs `#ECE5F4`（差 1）与 `#DDD1E8` vs `#ECE5F4`（差 20）的对照 —— Nephele 下改前
横幅确实是「隐形的」。

校历的「改前 vs 改后」用 `git show HEAD:public/plugins/cppu-calendar/main.js` 单独跑了一遍：
旧版在读取成功时同样是 `当前学期=尚未设置` + `status=正在读取校历…`（证明上一节那一行 `paint()` 是补缺陷，
不是行为变化），改后在成功与「先失败 → 点横幅 → 这次成功」两条路径上都得到 `当前学期=2026 秋季学期`、
状态行清空、横幅消失。

回归测试：

- `node scripts/test-cppu.mjs`：横幅形态（button 前缀 / `.pp-banner-txt` / `.pp-banner-act-hint`）、
  转义、加载态仍是不可点的 `.pp-empty`、教务视图标题位置、假 DOM 真跑点横幅（换新数据后 error 清空、
  `at` 盖新时间戳、横幅自己消失）；新增通知视图 `paintStatus()` 与一卡通 `cardSetStatus(...,true)` 的
  形态断言、「点横幅必须真的重跑一轮」的行为断言，以及按选择器取规则的配色矩阵守卫。
- `node scripts/test-cppu-campus.mjs`：新增一整节 —— `statusHtml()` 两种形态、读取失败后状态行变横幅且
  `onclick === retryFail`、读取成功后**必须重画**（`/测试学期/` 必须在 `innerHTML` 里、
  `/正在读取校历/` 必须不在，删掉那行 `paint()` 就红）、坏事件被过滤、`retryFail()` 两种模式分别重跑
  `schedule:week-request` 与 `cppu:term-request`（含 30s 超时置 `retry="term"`）、`cppu:term-response`
  的成功/失败/过期 requestId 三分支、`render()` 挂载即出横幅与 60s 轮询清理、34 色板矩阵。
- 变异测试都人工确认过 exit code 与断言文案：点横幅分支改 `if (false && …)` / 改成空 `return;`、
  `retryBtn.onclick = retryFail` 被断开、横幅退回 `<div>`、提示混比 30%→55%、三档比例压到 2/3/4%
  （只有「底色与视图底色通道差」守卫会红，说明它是独立的一条）、底色写死 hex、
  `if (warn)` 改 `if (false)`、`name==='refresh'` 改名、助手把 `data-${action}` 写死、
  成功分支删掉 `paint()` —— 全部被抓；改完用 `Get-FileHash` 逐字节证明还原。

## 五、影响面

- 用户能点到横幅的入口：通知视图、一卡通视图、教务五个子页、校历 —— 一共 8 个视图。
- 三端（桌面 / Android / 小程序）的视图注册与数据链路没动；插件号 `cppu-notify` 1.38.0 → 1.39.0、
  `cppu-calendar` 0.3.0 → 0.4.0，由 `tools/sync-plugins.js` 同步进两端的 `pluginCatalog.js`。
- 主题：16 套内置主题 × 浅/深 + Nephele 浅/深都用同一套令牌公式，插件不再自带配色分支；
  `src/styles.css` 的「内置插件深色兼容层」不覆盖 `pp-*` / `cc-*` 横幅，所以不会互相抢权。
- 存储 / 数据迁移：无（未动 `noticeCache`、`jwCache`、`cardRechargeCache`、`calendar` 的结构）。
