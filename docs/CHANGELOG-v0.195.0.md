# v0.195.0 · 模竞（mojinghub.com）竞赛消息接进竞赛消息雷达：不装浏览器插件，站里的新比赛也能弹到桌面

> `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.195.0`；
> `node tools/sync-plugins.js --check` → `✓ 插件生成物与清单同源（--check 未写盘）：18 个内置插件`。
> 动的文件：桌面插件 `public/plugins/gx-news/main.js` + `manifest.json`（插件版本 0.7.0 → **0.8.0**）、
> 新增 `scripts/test-gx-news-mojing.mjs`（7 组用例）、改 `scripts/test-gx-news.mjs` 里「源那一排」的期望值、
> 新增图标 `public/icons/plugins/mojinghub.png` 与 `miniprogram/images/plugins/mojinghub.png`（`tools/gen-plugin-icons.py` 新增 `mojinghub → color/medal` 一条映射）、
> 修 `tools/mojinghub-watch.mjs` 的 `--toast`（新增 `--install-toast`，改 `-EncodedCommand` 与 XML base64）、
> 根 `package.json` / `package-lock.json`（0.194.0 → **0.195.0**）、根 `docs/CHANGELOG-v0.195.0.md`。

## 用户要求原文

> 「https://www.mojinghub.com/competitions，真没办法不用插件就适配这个网站通知吗？」

问的是「不用浏览器插件」，也就是不想再往 Chrome 里装扩展。答案是**不用装**：U-Time 自己就能收。

## 一、为什么浏览器里做不到、U-Time 里做得到

模竞是 React 单页应用，页面 HTML 里只有 SEO 骨架，一条数据都没有；真数据全在它自己的接口域上。
问题出在这家站点的 CORS 上：

| 请求方 | 结果 |
|---|---|
| 浏览器里从别的域 `fetch` 它的接口 | **必被拦**。预检 OPTIONS 回 204、放行方法齐全，但 `Access-Control-Allow-Origin` 被写死成 `https://admin.mojinghub.com`，跟页面来源对不上 |
| 连 `Origin: null`（本地 `file://` 页面） | 一样拦，回给它的 ACAO 还是 admin 域 |
| 服务端本身 | **不校验来源**：不带 Origin 也照常返数据；伪造 `Origin: https://evil.example` 也照样返数据 |

所以「浏览器扩展」其实是绕过这道 CORS 的唯一浏览器内手段 —— 而 U-Time 的插件宿主里，
`tide.http.fetch` 走的是 **Rust 侧 reqwest**，请求根本不经过 WebView，天生不受 CORS 约束。
换句话说：这条路不用插件，是因为**请求不是浏览器发的**。

## 二、模竞接口的四个坑（都实测过）

1. **永远返回 HTTP 200**。业务状态在响应体的 `status` 字段里：`200` 正常、`102`「token解析错误」、`103`「token不能为空」。
   只判 HTTP 码会把「token 过期」当成「本次没新消息」——这是最阴的一个坑，代码里专门为它写了断言。
2. **列表在 Laravel 分页器里**：`data.data`，翻页字段是 `current_page` / `last_page` / `total` / `per_page`，
   跟雷达里原有三家（`data.records` / `data.list`）都不一样，得单独写一层解包。
3. **时间全是 Unix 秒**，不是毫秒也不是字符串。
4. **鉴权接口要 token 且会过期**。个人通知（`/api/Notification.Notification/index`）在 `Authorization` 头里塞裸 token
   （不是 `Bearer`），token 存在浏览器 localStorage 的 `auth-storage` 里。本版**不做**这条通道 —— 让一个桌面应用
   替你保管并续期别人的登录态，得不偿失。

## 三、实际接了三条公开通道

三条都不需要登录、不需要 token，实测直接返数据：

| 通道 | 接口 | 条数 | 主键 | 详情页地址 |
|---|---|---|---|---|
| 模竞竞赛 | `/api/Competition.Competition/index` | 17 | `competition_id` | `/competitions/<id>` |
| 模竞活动 | `/api/Events.Events/index` | 4 | `events_id` | `/events/<id>` |
| 模竞资讯 | `/api/Article.Article/index` | 81 | `article_id` | `/news/<id>` |

竞赛通道还带 `wcompetitionlevel.level_name`（实测取值「国家级 / 国际级 / 全国性」）和 `signup_end`（报名截止），
两者都接进了雷达已有的级别轴与「一键转 U-Time 提醒」的落期逻辑。

## 四、为什么加进「竞赛消息雷达」而不是新建一个插件

雷达（`gx-news`）本来就有：源那一排切换、已读标记、三条互不干涉的分类轴、关键词与月份筛选、
每 10 分钟自动刷新、抓到新消息时 `notice:new` 广播给微信推送插件、一键把消息转成 U-Time 提醒。
新建一个模竞插件等于把这 1300 行外壳重抄一遍，还会多出一个「源」并列在插件中心里。
所以做法是**给雷达加第 4 个源族（3 个源）**，每条通道各占一个源，差分快照 / 已读 / 筛选靠 id 前缀天然隔离。

`main.js` 具体改动：

- 新增常量 `MOJING_HOME` / `MOJING_API` / `MOJING_POST`；
- 新增 `mojingPayload(res, what)`：先判 `res.status`，再 `JSON.parse(res.body)`，**再判 `Number(d.status) !== 200`**，
  三处失败各有各的报错文案（`模竞竞赛接口 HTTP 502` / `模竞竞赛接口返回的不是 JSON` / `模竞竞赛接口：token解析错误`）；
- 新增 `secOf(v)`：秒 / 毫秒双认（`n > 1e11` 当毫秒），非有限或 ≤0 归 0；
- 新增 `fetchMojingCompetition` / `fetchMojingEvents` / `fetchMojingArticle`，统一
  `tide.http.fetch(await tide.http.session(), "POST", url, {...MOJING_POST, body: JSON.stringify({page, limit: PAGE_SIZE})})`；
- `LEVEL_NATIVE` 补 `国际级 / 市级赛 / 省赛 / 国赛 / 校赛 / 区域赛 / 地区赛` 等站点自有写法；
- `builtinSources()` 追加三项：`mojing-comp`（模竞竞赛）、`mojing-events`（模竞活动）、`mojing-news`（模竞资讯）。

## 五、测试

新增 `scripts/test-gx-news-mojing.mjs`（自建 vm 桩，`tide.http.fetch` 记录请求并走前缀路由表），7 组用例覆盖：

- POST 形态与请求体 `{page:1, limit:40}`、标题 / 摘要 / 级别归一（国家级→全国、国际级→国际）、
  `created_time` 解成本地日期、卡片 `data-id="mojing-comp:40"`；
- `signup_end` 要落在卡片上；
- 活动 / 资讯各自的主键前缀与通道字段；
- **`status:103`、`status:102`、返回 HTML 三种失败都必须报出来**，不能当成空列表；
- `last_page=2` 时出现「第 2 页」按钮，点后第 2 页并入且不顶掉第 1 页；
- 首次抓取只建基线不广播，有基线且出现新条目时广播 `notice:new`；
- 源那一排必须有「模竞竞赛 / 模竞活动 / 模竞资讯」。

**变异测试**：把 `if (Number(d.status) !== 200) {` 改成 `if (false) {` 后重跑，
测试如实报 `AssertionError: body.status=103 必须当失败报出来，不能当成空列表`，还原后 PASS —— 断言是真的在守东西。

顺带修了旧测试 `test-gx-news.mjs` 里「三内置源」的期望值（现在源那一排是六项 + 添加入口）。

## 六、图标

`tools/gen-plugin-icons.py` 的 `ICONS` 加一条 `"mojinghub": ("color", "medal", "模竞竞赛平台 / 奖牌")`，
`py -3.13 tools/gen-plugin-icons.py` 生成 81×81 透明 PNG（3241 B，sha256 `da2c74375b0c…`）到
`public/icons/plugins/` 与 `miniprogram/images/plugins/`，并重写 `public/icons/plugins/ATTRIBUTION.md`。

## 七、顺手把独立脚本那条「发不出通知」的路修通了

早先试过一条纯 PowerShell 发 Windows 原生 toast 的路子（`tools/mojinghub-watch.mjs --toast`），
当时结论是**发不出去**：`CreateToastNotifier(未注册的 AUMID).Show()` 不报错，但通知中心里不落记录。
这次把根因查清楚了，一共三个坑：

| 坑 | 现象 | 修法 |
|---|---|---|
| AUMID 没注册 | `.Show()` 返回成功，系统静默丢弃，通知中心无记录 | 新增 `--install-toast`：在 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\mojinghub-watch.lnk` 写一个同名快捷方式把 AUMID 注册进系统（快捷方式指向哪里不重要，注册只需跑一次） |
| 命令行编码 | 中文标题存进去变成「妯＄珵鐩戞帶」 | 改走 `powershell.exe -EncodedCommand`（base64 + UTF-16LE），绕开系统 ANSI 代码页 |
| XML 引号 | PowerShell 报 `Missing ')' in method call` | XML 本身也用 base64(UTF-8) 传进去，命令行里不做任何引号转义 |

**验证方式**：注册后发一条中文 toast，直接读 `%LOCALAPPDATA%\Microsoft\Windows\Notifications\wpndatabase.db-wal`，
里面存着 `toast<toast><visual><binding template="ToastGeneric"><text>模竞有新动态</text><text>2026 全国大学生数学建模竞赛（共 3 条） ZWPIPE-OK</text>` —— 中文完整、模板正确、正文齐全。
（对照组：同一套命令在没注册 AUMID 时，同一份 WAL 里什么都搜不到。）

也就是说现在两条路都通：**U-Time 插件那条是正路**（下面六节），独立脚本这条是给「不想开应用、只想命令行看一眼」的场景兜底。
