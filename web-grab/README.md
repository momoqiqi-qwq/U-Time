# web-grab

**把「抓不到」的页面变成「直连它的数据接口」。**

`web-grab` 是一套给 **JS 渲染（SPA）站点**用的抓取工具：

- **`inspect`** —— 先告诉你这页为什么抓不到（静态层只有空壳）；
- **`probe`** —— 再从它的前端 bundle 里，把真正的数据接口/接口域自动挖出来；
- **适配器** —— 每个站点一个插件文件，把接口返回的原始字段，归一化成统一记录；
- **油猴插件** —— 在浏览器里实时嗅探任何站点的 fetch/XHR，一键导出、一键复制 curl。

> 它跟普通爬虫的区别：普通爬虫解析 HTML，而 SPA 的 HTML 里**根本没有数据**。
> 这个工具的思路是 —— 页面自己怎么取数据，我们就照着取一遍。

零依赖，只需 Node >= 20（用到了内建 `fetch`）。已在 Node v24.14.0 实测。

---

## 一、快速开始（以模竞为例）

```bash
cd web-grab

node src/cli.mjs adapters                 # 1. 看看装了哪些站点适配器
node src/cli.mjs inspect  https://www.mojinghub.com/competitions   # 2. 诊断"为什么抓不到"
node src/cli.mjs probe    https://www.mojinghub.com/competitions   # 3. 自动挖出数据接口
node src/cli.mjs fetch    https://www.mojinghub.com/competitions --all --format table   # 4. 取数
```

等价 npm 脚本：`npm run adapters` / `npm run inspect` / `npm run probe` / `npm run fetch`。

### 第 2 步实测输出（这就是"抓不到"的证据）

```
URL          https://www.mojinghub.com/competitions
HTML 体积    9173 字节
可见文本     159 字
挂载点       root
module 脚本  1 个，modulepreload 5 个
判定         spa-shell
  · 去标签可见文本仅 159 字
  · 存在空挂载点 #root
  · 存在 module 脚本 / modulepreload（内容由 JS 运行时获取）

结论：这是个纯前端渲染的页面，抓 HTML 只会拿到空壳 —— 数据在它的接口里。
```

### 第 4 步实测输出

```
ID    标题                             类别    级别    费用    状态     报名截止
──────────────────────────────────────────────────────────────────────────────
40    2026年第十二届数维杯全国大学生数学建模挑战赛（秋季赛）  数学建模  国家级   收费    报名进行中  2026-11-20 06:00
37    2026年第二届全国大学生仿真建模应用挑战赛         仿真建模  国家级   收费    报名进行中  2026-10-16 18:00
...
(17 / 17 条，1 页，耗时 288ms)
```

---

## 二、命令总览

| 命令 | 作用 |
| --- | --- |
| `adapters` | 列出已装适配器与它支持的 `kind` |
| `inspect <url>` | 空壳诊断：HTML 体积、可见文本、挂载点、bundle 清单、判定结论 |
| `probe <url>` | 通用接口探测：从 bundle 里扒 `/api/...` 端点、解开 `atob()` 藏的接口域、给候选打标 |
| `fetch <url>` | 走适配器取列表（支持翻页/过滤/五种输出格式） |
| `detail <url> --id N` | 取详情（正文、附件、奖项、队伍信息） |
| `cates <url>` | 取筛选器目录（类别/级别/参赛方式/费用） |
| `scripts/routes.mjs <url>` | 从 bundle 里扒出前端路由表，用来拼详情页 URL |

### fetch 选项

```
--kind competitions|events   列表类型（默认由 URL 推断）
--all                        自动翻页抓全量
--page N --limit N           手工分页
--title 关键词 --cate ID --level ID --stage N --hot 1    过滤
--format json|csv|md|ics|table
--out 文件                   （按扩展名自动识别格式）
--ics-window run|signup|both 导日历用哪段时间窗（默认 run = 比赛时间）
--ics-tz local|utc           见下方"时区"一节
--ics-days first|all         跨天窗口是否按天展开（长窗口见"ICS"一节）
--alarm 分钟                 提前提醒（写进 ICS 的 VALARM）
```

### 例子

```bash
# 全量导出竞赛，四种格式
node src/cli.mjs fetch https://www.mojinghub.com/competitions --all --format json --out out/competitions.json
node src/cli.mjs fetch https://www.mojinghub.com/competitions --all --format csv  --out out/competitions.csv
node src/cli.mjs fetch https://www.mojinghub.com/competitions --all --format md   --out out/competitions.md

# 只抓"数学建模"分类（cate_id=6），直接打在终端看
node src/cli.mjs fetch https://www.mojinghub.com/competitions --all --cate 6 --format table

# 抓活动（同一套适配器，kind=events）
node src/cli.mjs fetch https://www.mojinghub.com/events --all --format md

# 详情 + 正文 + 附件
node src/cli.mjs detail https://www.mojinghub.com/competitions --id 40 --format md --out out/detail-40.md
```

---

## 三、日历导出 & 导入「时间管理软件」

竞赛天然是"有开始有结束的日程"，所以 `--format ics` 是主用途：

```bash
# 比赛时间 + 报名时间都进日历，跨天的比赛按天各出一条，提前 1 天提醒
node src/cli.mjs fetch https://www.mojinghub.com/competitions --all \
  --format ics --ics-window both --ics-days all --alarm 1440 --out out/competitions.ics
```

然后：**时间管理软件 → 设置 → 数据 → 导入 ICS**（`le-time-management/src/dataCenter.js` 的 `importIcs()`）。

### ⚠️ 时区（踩过的坑）

`--ics-tz` 两个值，别选错：

| 值 | 输出 | 给谁用 |
| --- | --- | --- |
| `local`（默认） | 浮动时间，无 `Z`，固定按东八区取字段 | 时间管理软件、国产日历 —— 它们把无时区时间当本地时间，**正确** |
| `utc` | 标准 UTC，带 `Z` | Google / Apple Calendar —— 它们会自己做时区换算 |

默认选 `local` 是因为：站点时间戳是 unix 秒，转成 `Z` 后导进"把无时区当本地"的客户端，会**整整差 8 小时**。

其他两个细节也照顾到了：

- **RFC 5545 折行**：每行 ≤ 75 字节，续行以空格开头。`importIcs()` 的第一步就是 `replace(/\r?\n[ \t]/g,'')` 还原长行，所以中文长标题不会断。
- **`--ics-days all`**：比赛窗口跨天时（如 11-20 09:00 → 11-24 10:00），按天各出一条事件，比赛期间每天都能在日历里看到。
  但**超过 21 天的长窗口不按天展开**——只在窗口末尾前 1 小时出一条「（截止）」事件（UID 带 `-deadline`）。理由：报名期常常长达三个月，按天展开会让 17 条赛事瞬间炸出上千个日历块（实测 1112 块 → 改后 114 块，文件 644 KB → 66 KB），而长窗口真正要记的只有截止那一刻。

---

## 四、模竞（mojinghub.com）适配器：逆向记录

**结论：站点自己的数据全在 `https://admin.mojinghub.com` 上，接口免登录。**

| 项 | 值 |
| --- | --- |
| 站点 | `www.mojinghub.com` = Vite + React SPA（HTML 9173 B，可见文本 159 字） |
| 接口域 | `https://admin.mojinghub.com`，藏在 `/platform-patch.js` 的 `atob('aHR0cHM6Ly9hZG1pbi5tb2ppbmdodWIuY29t')` |
| 请求形态 | `POST` + `application/json`；带 `Origin: https://www.mojinghub.com` 即可（CORS 白名单就是它） |
| 登录 | 列表 / 详情 / 分类接口**全部免登录**，无需 token |
| 通用 helper | 入口 bundle：`` fetch(`${R}${e}`) ``，`R = "https://admin.mojinghub.com"` |

### 用到的接口

| 用途 | 接口 | body |
| --- | --- | --- |
| 竞赛列表 | `/api/Competition.Competition/index` | `{lite:1,page,limit,title,cate_id,level_id,stage,is_hot}` |
| 竞赛详情 | `/api/Competition.Competition/detail` | `{competition_id:N}` |
| 竞赛分类 | `/api/Competition.CompetitionCate/index` | `{}` |
| 活动列表 | `/api/Events.Events/index` | 同上，过滤字段换成 `events_id` |
| 活动详情 | `/api/Events.Events/detail` | `{events_id:N}` |
| 站点配置 | `GET /api/SiteConfig/getFullConfig` | — |

`probe` 一次能捞出 **95 个** `/api/...` 端点（含 Adminuser / Signups / WxPay 等，本适配器用不到）。

### 数据结构要点

- `lite:1` 保留关联对象（`wcompetitionlevel.level_name` / `wcompetitioncate.cate_name` / `wcompetitionmethod.method_name`），去掉正文，**体积小、够用**；不加 `lite` 才是详情。
- 时间字段全是 **unix 秒**；`fee_type: 1=免费 2=收费`；`signup_mode: 0=站内报名 1=官网报名`。
- 过滤参数实测有效：`title`（标题搜索）、`cate_id`、`level_id`、`stage`、`is_hot`；**`keyword` / `search` 无效**（别用）。

### 两个坑

1. **`stage` 码不可信**。站点用 `PREPARING/REGISTERING/...` 渲染，但枚举数值被激进混淆、78 个 chunk 里搜不到字面量。所以适配器只把 `stage` 当参考（`statusCode`/`stageLabel`），真正的 `status` **用时间戳现算**（`computeStatus()`：报名未开始 / 报名进行中 / 报名已截止 / 比赛进行中 / 已结束）。
2. **详情页 URL 不在列表里**，得自己拼。路由表实测（`scripts/routes.mjs` 从入口 bundle 扒出）：
   - `/competitions/:competition_name/:created_time` ← `competition_name` 就是 `title_sub`，`created_time` 也来自列表行
   - `/events/:events_name/:created_time`，老链接 `/events/:id` 仍可访问（作为兜底）

---

## 五、加一个新站点（插件化，5 步）

适配器 = 一个文件 + 一行注册。**不改核心代码**。

```bash
cp src/adapters/_template.mjs src/adapters/newsite.mjs
```

1. **诊断**：`node src/cli.mjs inspect https://newsite.com/list` —— 确认是 `spa-shell`
2. **探测**：`node src/cli.mjs probe https://newsite.com/list` —— 拿到候选接口与接口域
3. **验证**：拿 probe 给出的 curl 打一发，确认字段（这一步别跳，很多接口要特定 header）
4. **映射**：在 `src/adapters/newsite.mjs` 里实现
   - `match(url)` / `resolve(url)` —— 域名命中与 kind 分流
   - `list(kind, params)` → `{total, page, lastPage, rows, raw}`
   - `detail(kind, id)` → 归一化记录
   - 可选的 `catalog(kind)`
5. **注册**：在 `src/adapters/index.mjs` 的 `ADAPTERS` 里加一行

归一化记录（渲染层只认这些字段，见 `src/adapters/_template.mjs`）：

```
kind id title subtitle category level method organizer publisher
feeType feeAmount status statusCode stageLabel
signupStart signupEnd runStart runEnd                 (ISO，给 ICS)
signupStartCn signupEndCn runStartCn runEndCn         (东八区可读，给表格/CSV)
isHot isRecommended signupMode externalSignupUrl pageUrl
```

**只要你填了 `runStart/runEnd/signupStart/signupEnd`，五种导出格式就都能用** —— 渲染层是通用的。

---

## 六、油猴插件：给任何站点装上"接口嗅探"

`userscript/spa-grab-enhancer.user.js`

安装（任选一种）：

1. **本机一键安装**（推荐，已在真实 Chrome + Tampermonkey 5.4.1 上验证过）：
   ```bash
   node scripts/serve.mjs        # 起本地静态服务（8788 被占会自动让位，命令行会打印真实端口）
   ```
   然后浏览器打开 `http://127.0.0.1:8789/userscript/spa-grab-enhancer.user.js`，Tampermonkey 弹安装页 → 点「安装」。
   `.js` 用 `text/plain` 发（和 GitHub raw 一致），Tampermonkey 照样拦截；`file://` 反而要额外开「允许访问文件网址」。
2. **手动**：Tampermonkey → 新建脚本 → 粘贴 → 保存。
3. **升级**：脚本没配 `@updateURL`（本地文件，没有可轮询的远端），所以升级 = 重新打开上面那个 URL 点「更新/安装」。

装好后任意页面右下角出现「抓取增强」浮标（或按 `Alt+G` 开关面板）。`@run-at document-start` + `@grant none` + `@noframes`，跑在页面主世界，页面自己的 fetch 一个字都不改。

它做三件事：

1. **嗅探** —— hook `window.fetch` 与 `XMLHttpRequest`，把返回 JSON 的请求全记下来（含 method、body、status、耗时）；
2. **识别** —— 自动判断哪个接口在返回**列表**（找行数最多、且带 `*_id` 字段的数组），打绿色标签 `N 行 @ data.list`；
3. **导出** —— 选中接口后一键：复制 curl / 复制原始 JSON / 导出 JSON / CSV / Markdown / 复制 fetch 复现代码。

外加一件：**面板自己会跟着页面换肤**（见下面「面板配色」）—— 在你的时间管理软件里就是 Nephele 紫调云雾风，在别的站点就借那个站点的主题色。

对 `mojinghub.com` 额外多一个 **「模竞全量抓取」** 按钮：直连 `admin.mojinghub.com` 翻页拉全量并下载 JSON。

> 典型用法：遇到一个抓不到的站点 → 打开页面点两下 → 面板里找到那个 `N 行 @ xxx` 的接口 → 复制 curl →
> 用 `web-grab` 的适配器模板（第五节）把它固化下来，以后就是一条命令的事。

### 控制台入口 `window.__spaGrab`

面板能做的事，`F12` 控制台里都能做（也方便被脚本/测试驱动）：

```js
__spaGrab.best()          // 行数最多的那个列表接口（含 url / listPath / rowCount / fields）
__spaGrab.lists()         // 所有被识别成列表的接口
__spaGrab.records()       // 全部嗅探记录
__spaGrab.toCsv(rows)     // 导出 CSV 文本（带 BOM）
__spaGrab.toMarkdown(rows)
__spaGrab.fetchSnippet(e) // 生成 curl / fetch 复现代码
__spaGrab.pause(true)     // 暂停嗅探（比如页面自己在轮询，刷屏了）
__spaGrab.clear()
```

配色也能从控制台调（`v1.1.0` 起）：

```js
__spaGrab.theme()                  // 当前配色：来源(page/builtin)、深浅、是否 Nephele、解析后的全部色值
__spaGrab.setTheme({ nephele:'on', mode:'dark' })   // 手动锁定（'auto' 恢复跟随）
__spaGrab.resetTheme()             // 清掉锁定，回到自动跟随
__spaGrab.palettes()               // 四套内置调色板的原始色值
```

### 面板配色：自动跟随宿主页面主题 + Nephele

面板不写死颜色，所有颜色都是 `--wg-*` 令牌，取值顺序：

1. **借宿主页面的令牌**（优先）—— 在页面 `html`/`body` 上读 `--panel/--ink/--line/--deep/--accent` 等真实计算值。
   在「时间管理软件」里换任何主题（潮汐/夜航/敦煌/蓝图…）、切深浅、开关 Nephele，面板同步变色；在 shadcn/Tailwind 系站点则读 `--card/--border/--primary`。
   > 只接受**老实颜色字面量**（`#hex` / `rgb()` / `hsl()` / `oklch()`）。`var()`、`color-mix()` 这类「引用型」值一律丢弃 —— 搬进 Shadow DOM 后解析不出来，所以产品的 `--accent: var(--deep)` 会自动退到 `--deep`。
2. **内置兜底** —— 页面没有令牌时用内置四套：浅色 / 深色 / Nephele 浅 / Nephele 深。深浅判定顺序：`data-theme-mode` → `html/body` 的 `dark|night` class → 页面底色明度 → `prefers-color-scheme`。
3. **Nephele 模式** —— 页面有 `data-nephele-settings="on"`（或暴露了 `--nephele-edge`）就自动切紫调：换 `--nephele-accent` 描边、圆角 14→20px、上 `backdrop-filter: blur(22px) saturate(1.12)` 毛玻璃，面板内部自带**云雾 + 星尘**（3 朵漂移云、16 颗固定种子的闪烁星，取值与 `nephele-background.css` 的浅/深两组完全一致）。

面板头部有两个按钮：`主题·自动/浅/深` 与 `Nephele·自动/跟随/开/关`，手动选的会记在 `localStorage['web-grab:panel-theme']`；页面换主题、切深浅、开关 Nephele 时靠 `MutationObserver` + `matchMedia` 自动重算，不需要重开面板。派生色（悬浮层、按钮底、选中态、标签底、描边、阴影）全部用 `color-mix()` 在面板自己的 Shadow DOM 里混出来，不依赖页面。

想直接看四种配色长什么样：

```bash
node scripts/make-panel-preview.mjs          # 生成 docs/panel-preview.html
node scripts/make-panel-preview.mjs --check  # 只校验能不能从插件里取出 CSS/调色板/派生色
```

预览页里的 CSS、调色板、派生色都是**从 userscript 现取的原文**（不是抄一份），所以它画的就是插件真颜色。

### 单实例（v1.1.1 修的一个真 bug）

`@run-at document-start` 时 `<html>` 可能还没被解析出来，启动逻辑会 `setTimeout(boot, 20)` 重试；而 `DOMContentLoaded` 又会调一次 `boot` —— 于是 `buildUI()` 跑两遍，页面上出现**两个宿主、两个浮标**，`state.root` 只指向后一个，**前一个的计数永远停在 `0`**。

症状：同一页面里无障碍树/截图能同时读到 `抓取增强 0` 和 `抓取增强 13` 两个浮标 —— 很容易被误判成「插件在真实站点抓不到」。

现在：`boot` 一次性（`booted` 标志）、`buildUI` 幂等（`if (state.root) return`），并顺手把页面里残留的同 id 旧宿主清掉。断言在 `scripts/check-userscript.mjs` 的「单实例」两项里（模拟 document-start 重试 + DOMContentLoaded 双触发、以及预置一个残留宿主）。

---

## 七、文件结构

```
web-grab/
├─ src/
│  ├─ cli.mjs                   命令行入口（adapters/inspect/probe/fetch/detail/cates）
│  ├─ render.mjs                渲染层：json / csv / md / ics / 终端表格
│  ├─ core/
│  │  ├─ http.mjs               带超时+指数退避重试+cookie 的请求层
│  │  ├─ shell.mjs              空壳判定 analyzeHtml / inspectUrl
│  │  └─ probe.mjs              通用接口探测 probe
│  └─ adapters/
│     ├─ index.mjs              适配器注册表
│     ├─ _template.mjs          新站点模板（含接入流程）
│     └─ mojinghub.mjs          模竞适配器
├─ userscript/
│  └─ spa-grab-enhancer.user.js 油猴增强插件
├─ scripts/
│  ├─ selftest.mjs              自检（离线 28 项 + 联网 8 项）
│  ├─ routes.mjs                从 bundle 扒前端路由表
│  ├─ check-app-import.mjs      把导出的 ICS 喂给产品自己的 importIcs 验证兼容
│  ├─ check-userscript.mjs      在 Node 假页面里真跑一遍油猴插件（28 项）
│  ├─ make-panel-preview.mjs    从插件现取 CSS/调色板/派生色，生成配色预览页
│  └─ serve.mjs                 零依赖静态服务：把插件挂到 http://127.0.0.1:8788/ 供油猴一键安装
├─ docs/
│  ├─ panel-preview.html        四种配色的静态预览（截图/给眼睛看）
│  ├─ panel-preview.png         上面那张预览的截图
│  ├─ userscript-check.html     验收页：本身不含任何插件文案，用来证明面板确实注入了
│  ├─ sniff-test.html           自测页：自己发 1 个 fetch + 1 个 XHR 到 api-demo.json，浮标应显示 2
│  ├─ api-demo.json             sniff-test.html 打的假接口（列表形状）
│  ├─ click-test.html           合成点击排障页（普通按钮 / 复现浮标 / 对照浮标）
│  └─ panel-live.png            真机截图残留（右下角被别的窗口压住，仅留档）
└─ out/                         导出结果
```

---

## 八、自检

```bash
npm run selftest           # 离线：纯函数断言，不联网
npm run selftest:online    # 离线 + 真实接口验收
```

当前状态：**离线 28 项 + 联网 8 项，全部通过**。

离线部分覆盖：空壳判定三种情形、五种渲染格式（含 CSV 转义、Markdown 转义、ICS 的 75 字节折行/UID/时区/按天展开/长窗口截止/缺时间不出事件）、`computeStatus` 五个状态边界、字段映射、路由拼接（含活动老链接兜底）、适配器命中。

联网部分覆盖：列表体量、`title`/`cate_id` 过滤真的生效、分类目录、活动接口、详情正文、翻页聚合无重复、ICS 全量落地。

另外还有两项跨项目验收 —— 证明导出的日历**真能导进「时间管理软件」**、油猴插件**真能跑**：

```bash
npm run export:ics                            # 生成 out/competitions.ics
npm run check:app-ics                         # 用产品真实的 importIcs 解析它
npm run check:userscript                      # 在 Node 假页面里真跑一遍油猴插件
```

`check:app-ics` 直接从 `../le-time-management/src/dataCenter.js` 里取出真实的 `parseIcsDate` + `importIcs` 源码执行（不是重写的仿制品），断言：能解析、字段齐全、无 `undefined`、无 `Z` 残留、中文长标题没被 75 字节折行截断、数维杯秋季赛落在 **2026-11-20 09:00（北京时间）**、跨天被拆成多块、`[报名]` 事件在。当前：114 个日程块，8 项断言全绿。

`check:userscript` 用 `node:vm` 造一个够用的假页面（含 `fetch`/`XMLHttpRequest`/Shadow DOM 桩），把油猴脚本**原样执行**，再拿**模竞接口的真实响应**（列表 17 行、详情 id=40）喂给被 hook 的 fetch，28 项断言覆盖：面板构建不抛错、**启动双触发也只建一个面板**、**残留旧宿主被清掉**、请求透传不改写、真实列表被识别（行数与字段）、详情不被误判、`text/html` 响应被忽略、XHR 分支、暂停开关、CSV/Markdown 转义、生成的复现代码语法合法、「模竞全量抓取」翻页落盘，以及配色/Nephele 那 11 项。

真机验收（Chrome + Tampermonkey 5.4.1，2026-10-11）：装好后打开 `https://www.mojinghub.com/competitions`，浮标显示 `抓取增强 13`（页面自己发的 13 个 JSON 请求被嗅探到）；打开 `docs/sniff-test.html` 显示 `2`。

配色那 11 项单列一节，其中最关键的一条是**对账**：把插件内置的 Nephele 调色板逐项跟 `../le-time-management/src/styles/nephele-settings.css` 里 `[data-nephele-settings="on"]` 两个色块的真实值比对 —— 以后动产品主题色，这里会立刻报出差异，不会悄悄跑偏。其余覆盖：裸环境（没有 `localStorage`/`getComputedStyle`/`matchMedia`）不报错、借页面令牌（`--accent` 是 `var()` 时退到 `--deep`）、Nephele 浅/深两组、shadcn 系站点借色 + `class=dark`、只有深色底时按明度判深、令牌只在 `body` 上也读得到、**样式注入消毒**（带 `}`/`;`/`var()` 的页面值一概不采信，且注入的声明必须全是 `--wg-` 前缀）、手动锁定与 `resetTheme`、页面换主题时自动重算。

---

## 九、FAQ / 排错

**Q：`inspect` 说不是 spa-shell，但内容还是抓不到？**
可能不是 SPA 问题，而是 WAF 拦截（返回 403/521 或验证页）。换 profile / 带完整浏览器头再试；本目录的 `probe` 是针对空壳型页面的。

**Q：接口返回 403 或 `status != 200`？**
先补 `Origin` + `Referer` 头（本站 CORS 白名单写死了 `https://www.mojinghub.com`）。有的接口还要 `Authorization`，那就在 `_template.mjs` 里加 token 读取。

**Q：导出的时间差 8 小时？**
`--ics-tz` 用错了。导进时间管理软件用默认 `local`；给 Google/Apple 才用 `utc`。

**Q：比赛是跨天的，日历里只有一条？**
加 `--ics-days all`。

**Q：`stage` 显示的状态跟我看到的不一样？**
正常，站点那个码被混淆过。以适配器算出来的 `status`（按时间戳）为准。

**Q：浮标显示 `0`，是不是没抓到？**
先看页面有没有发 JSON 请求（F12 → Network → Fetch/XHR）。`1.1.1` 之前有个真 bug：启动被触发两次会建两个浮标，前一个的计数永远停在 `0` —— 所以「同时看到 `0` 和真实数字」是插件自己的问题，不是站点抓不到。现在只有一个浮标。

**Q：浮标/面板点不动？**
`Alt+G` 是键盘通道，不依赖鼠标命中。鼠标点不动通常是**别的窗口压在页面右下角**（真机排障时遇到过：`WindowFromPoint` 打到的是另一个 Chrome 窗口 + 任务栏占了屏幕底部 132px），跟插件无关。

**Q：能给别的站点用吗？**
能。`inspect` / `probe` / 油猴插件 / 渲染层 / ICS 导出全是通用的；只有 `src/adapters/*.mjs` 是站点专属，按第五节加一个即可。
