# v0.220.0 · 学生个人成长中心（pdata.cppu.edu.cn）整合进警大通知插件：做成独立界面，不照搬网页

> `node ../tools/sync-version.js --check` → ✓ 三端版本一致：v0.220.0
> `node ../tools/gen-theme-dark.js --check` → ✓ 派生调色板已同步（15 套深色变体）
> `node ../tools/build-schedule-plugin.js --check` → ✓ shiguang-schedule 生成物与源一致
> `node ../tools/build-exam-calendar-plugin.js --check` → ✓ exam-calendar 生成物与源一致
> `node ../tools/sync-android-native.js --check` → ✓ Android 原生代码与版本化镜像一致
> `node ../tools/sync-plugins.js --check` → ✓ 17 个内置插件三端同源
> `node ../tools/gen-plugin-icons.py --check` → ✓ 图标无 DIFF（插件 17 + 分类 8）
> `npm test` → PASS: 138 个测试脚本全部通过（写本档时是 137，另一个会话后来又加了一个脚本）

动的文件：

- 新增 `public/plugins/cppu-notify/growth.js`（约 560 行）—— 学生个人成长中心的视图主体，
  纯 ES module（唯一导出 `createGrowthView(tide, bridge)`），走 main.js 既有的懒加载范式
- `public/plugins/cppu-notify/main.js` —— 新增常量 `PDATA` / `PDATA_HOME`；新增 pdata 鉴权段
  （`PDATA_VAULT_KEY` / `mintPdataTicket` / `loadPdataAuth` / `ensurePdataAuth` / `pdataApi` /
  `openPdataLink` / `growthBridge`）与 `mountGrowthView(el)` + 第 5 条 `registerView`；
  `saveCookies()` 的 `exportCookies` 主机白名单加 `PDATA`；`QUICK_LINKS` 新增「学生成长」入口
- `public/plugins/cppu-notify/manifest.json` —— 1.50.0 → 1.51.0；`description` / `author` 改写
- `src/icons.js` —— `VIEW_ICONS8` / `VIEW_FA_ICONS` 各加 `cppu-growth`
- `tools/gen-plugin-icons.py` —— `VIEW_ICONS` 加 `cppu-growth`
- `scripts/test-plugin-view-icons.mjs` —— 分类视图从 7 个改 8 个
- 生成物：`src/pluginCatalog.js`、`miniprogram/core/pluginCatalog.js`、`public/icons/plugins/cppu-growth.png`、
  `public/icons/plugins/ATTRIBUTION.md`、`miniprogram/images/plugins/cppu-growth.png`、
  `src-tauri/Cargo.toml` / `Cargo.lock` / `tauri.conf.json`、`miniprogram/core/appMeta.js` 等三端版本号

**新增存储**：`vault` 的 `pdataToken` 键（`{token, userId, at}`）。无数据迁移。
`storage` 的 `growthViewPreferences` 是视图自己的偏好（消费 / 上网选中的那个 tab），
缺失即用默认值。

## 用户要求

> https://pdata.cppu.edu.cn/stu/home/ ，把学生个人成长也整合进警大通知插件里面，
> 做独立的界面，而不是把网页照搬上去。但 UI 参考网页，网页的 UI 其实就很好，不用怎么改。

## 一、为什么不能照搬网页

`pdata.cppu.edu.cn` 是 umi 3.5.21 + antd 的**整站 SPA**（`umi.js` 单文件 10.6 MB，
学生端路由 30 余条）：左侧导航 + 顶部栏 + 首页十几张可折叠卡片。它的信息架构是为
1440px 桌面浏览器设计的，塞进插件只会得到一个**更窄的浏览器** —— 顶部栏和侧栏吃掉一半宽度，
卡片在小屏上折成一列，用户还得在里面滚两屏才看到学分。

所以取的是「**同一份数据、同一套视觉语言、重新排版**」：

| 网页 | 本视图 | 取数 |
|---|---|---|
| 顶部 `NewHomeMainTop`（头像 + 三张背景图 + 标签） | 身份卡（头像 / 姓名 / 学号 / 档案字段标签，多出的可展开） | `personInfo` |
| 无（KPI 卡里混着） | 学业概览四格：累计已修 / 应修学分 / GPA / 本学期已获得 | `learnSituation` |
| `topCard` 轮播，每行 4 个，点开 520/1000px 弹窗看明细表 | 指标卡每行 4 个 + 翻页，点卡片开明细弹层（可翻页） | `getKpiList` + `getKpiDetailInfo` |
| `.xbox` 消费 / 上网两张卡 + 「查看更多」跳整页 | 一张卡内两个单选 tab，消费看当月消费与余额、上网看累计时长，各带地点排行 | `cardConsume` + `onlineState` |
| 考勤卡 + 奖惩卡（各占一屏） | 合成一屏两栏 | `getMyAttendance` + `bonusPenaltyList` |
| 左侧导航 30 余个入口 | 数据中心入口（按后台配的模块清单列出，点了带会话开浏览器） | `getModuleList` |

保留的网页视觉：KPI 卡的四色渐变（`KUCard` 那四条，按位次轮转）、指标数字大号 + 单位小号、
消费 / 上网卡那张浅蓝渐变底、档案标签的描边胶囊。全部换算成 U-Time 的主题令牌
（`--panel` / `--ink` / `--line` / `--ui-text-scale`），所以换主题、切深浅、开 Nephele 都跟随。

没做的：签署状态、笔记 / 消息中心、纠错填报、搜索、轨迹、个人中心。它们是**整页级应用**
（各自有分页表格与表单），做成卡片只会得到一堆「去网页看」的按钮 —— 这些留在「数据中心入口」里
一键开浏览器，不假装能在这里操作。

## 二、鉴权：本插件的第三条链路

pdata 和门户 / 教务**不是一套东西**，这是本次最大的坑：

```js
// pdata 自己的 settings.js
window.school = "cppu"; window.theme = "red";
window._CONFIG.casType = 1;
window._CONFIG.casPrefixUrl = "https://sso.cppu.edu.cn/tpass";   // ← 主 SSO，不是 sso-jw
window._CONFIG.serviceUrl  = "https://pdata.cppu.edu.cn";
window.BASE_API = "/tsa";
```

- 它是**独立 SPA + 独立 CAS 客户端**，`casType=1` 对应 `validateLogin` 端点；
- 登录成功后**不发会话 Cookie**，而是把 token 放进每个 `/tsa/**` 请求的
  `Authentication` 头里（`v.a.defaults.headers.common["Authentication"] = token`）；
- 学生端 `sessionStorage` 里的 `studentId` 被 `removeItem` 清掉 ⇒ 请求里 `_USER=` 恒为空，
  **服务端按 token 认人**（教师端才有值）。

所以链路是两步，两步都必须在本插件的会话里走（Rust 侧发起，不受 CORS 限制）：

```
① GET https://sso.cppu.edu.cn/tpass/login?service=<encodeURIComponent(https://pdata.cppu.edu.cn/stu/home/)>
     → 302 Location: https://pdata.cppu.edu.cn/stu/home/?ticket=ST-xxxx
     ↑ followRedirects:false —— 只看 Location，绝不把票消费掉
② GET https://pdata.cppu.edu.cn/tsa/validateLogin?ticket=ST-xxxx&service=<同一个 service>
     → { code: 2000, data: { token, userId, signingStatus, identification, isAdmin, role, ... } }
     ↑ 这一步才消费 ticket
```

`service` 用 `https://pdata.cppu.edu.cn/stu/home/` —— 就是裸开该页时 302 里带的那个值，
不是自己编的。② 的 service 必须与 ① 逐字节相同，否则 CAS 拒票。

实现要点（`main.js`）：

- `mintPdataTicket()` 复用既有的 `redirectTarget(res, base, origin, path)` —— 它要求
  `status ∈ 300–399`、`location` 存在、`protocol === "https:"`、`origin` 与 `pathname` 精确匹配，
  比 `includes("ticket=")` 可靠得多。
- `ensurePdataAuth(force)` 有**并发闸门**（`pdataAuthPending`）：本视图进页就并发拉八个接口，
  不能各换一次票。
- **token 只进 vault**（`PDATA_VAULT_KEY = "pdataToken"`，与教务密码同一把锁），
  不进 `storage`、不进日志、不写进 DOM。`saveCookies()` 的主机白名单加了 `PDATA`，
  是为了让 pdata 自己种的 Cookie 也随会话一起存取，不是为了让 token 走 Cookie。
- **失效自愈**：`pdataApi()` 拿到非 2000（或响应根本不是 JSON，多半是落回登录页）时，
  清 token 重走一遍 ①②，只重试一次（`retried` 闸门），用户无感。
- **换不到票时不假装**：`bridge.relogin()` 返回 `"form"`，视图**不重画**、只提示
  「请先在「警大通知」里登录一次，再回到本页刷新」。这里要是重画，用户看到的是一片空白，
  连该去哪儿登录的提示都读不到。票换不到的原因很明确：本插件的 SSO 会话不在
  （没勾「5天内自动登录」，或已过期）。

**「数据中心入口」开网页时不换票。** pdata 的 SPA 必须自己在浏览器里跑 `validateLogin`，
把票交给我们反而没人消费。只要 SSO 会话还在，裸开 `/stu/xxx` 就会
`302 sso → 302 带票回来 → SPA 自证`，一次跳转的事。

## 三、界面

六块，全部落在 `[data-pg-host]` 里；校园服务侧栏由 main.js 画（与校历 / 获奖名单同一套外壳）：

```
┌ 身份卡 ───────────────────────────────────────────────┐
│  [头像]  张三            学号 2025000001               │
│          警察大学 · 特警学院 · 男 · 2006-05-12         │
│          学院 / 专业 / 班级 / 电话 …（更多可展开）      │
└──────────────────────────────────────────────────────┘
┌ 学业概览 ─────────────────────────────────────────────┐
│  累计已修学分 168.5   应修 180    GPA 3.62   本学期 24 │
└──────────────────────────────────────────────────────┘
┌ 成长指标 ────────────────────────────────  ‹ 1/2 › ───┐
│ [蓝] 图书借阅 12 册  [橙] 竞赛获奖 5 项  [绿] 志愿 86h  │  ← 点开明细表
└──────────────────────────────────────────────────────┘
┌ 校园生活 ─────────────────────────────────────────────┐
│  [我的消费] 我的上网                                  │
│  当月消费 486.30 元   一卡通余额 132.05 元             │
│  · 第一食堂  2026-03-12 12:04            消费 18 元    │
└──────────────────────────────────────────────────────┘
┌ 我的考勤 ───────────────┐ ┌ 奖惩记录 ─────────────────┐
│ 事假 2026-03-01—03-02   │ │ 2026-01-10  记过  处分     │
└─────────────────────────┘ └───────────────────────────┘
```

- **指标卡**每行 4 个（与网页一致），底色优先用后台配的 `KPI_COLOR`（hex 或渐变串直接用），
  没配或配了非法值就按位次轮转网页那四条渐变。图标是后台给的 iconfont HTML，
  `iconHtml()` **只放行 `<svg>` 开头且不含 `<script|onload=|onerror=|javascript:`** 的串 ——
  这段内容来自服务端配置，不直接 `innerHTML`。
- **明细弹层**：列取 `data.dataField[].DATAFIELDNAME/DATAFIELD`，行取 `data.dataDetail.rowsList`，
  总数取 `data.dataDetail.total`（与网页 `onClickKpi` 逐字段对齐）。弹层是**单例复用**：
  开新的一页时先 `clearTimeout` 再复用同一节点，否则旧节点会盖在新节点上淡出。
- **消费 / 上网**是同一张卡里的单选切换，用 `attachSelectionGlow()`（铁律六）——
  只切 `aria-pressed`、不重建 DOM，否则光块与观察者会成孤儿、位移动画被截断。
- 空态与网页同款措辞：「当月无消费」「当月无上网记录」「暂无出勤记录」。

## 四、边界

- **`_USER` 恒为空是学生端的正常形态**，不是 bug。服务端按 `Authentication` 认人。
  参数位留着（教师端 / 以后有值时不至于漏参）。
- **部分失败不清空**：八条接口有一条挂了，其余照常显示，顶部标一行「部分数据获取失败」。
  八条全挂才进失败态，并且区分「未登录」与「站点不通」两种提示。
- **没有实时性承诺**：站点自己写着「部分数据获取滞后于部门系统实时数据，敬请谅解」，
  本视图把这句原样放在页脚。
- **KPI 明细只做翻页，不做排序 / 筛选**：网页的 antd 表格也只有分页。
- **`miniprogram` 仍为 `unavailable`**（与 cppu-notify 一致）。
- **Android 安全区**：视图里唯一 `position:fixed` 的是明细弹层，四边都走
  `calc(Npx + var(--sat, env(safe-area-inset-top, 0px)))` 双路，`scripts/test-plugin-safe-area.mjs` 通过。

## 五、图标

`cppu-growth` 的彩色 PNG 用 Icons8 `color/sprout`，轮廓图标用 FA `seedling`。

**不用 `sprout` 做 FA 名**：它已经是「成长 / 习惯」类插件的侧栏轮廓图标，同一个侧栏里撞图标
= 用户认不出来（这条是 v0.216.0 立的规矩，见那份档的「两处刻意避开的重名」）。
`seedling` 在现有 17 个插件 + 8 个分类里没人用。

## 六、界面验证（无头 Chrome 真 CSS + 几何 / 对比度 / 交互探针）

本机视觉模型不可用（`vision_describe` 返回「当前模型不支持图像输入」），所以不看图，
改用可复算的数字自证。三条互补通道：

| 通道 | 做法 | 结果 |
|---|---|---|
| 真外壳 + 全部视图 | 技能 `letime-plugin-ui-check` 的 `plugin-preview.mjs --dry` | `cppu-notify` CSS 38162 字符 / 9 个视图（含新增 `cppu-growth`）/ 文本 3085 字 |
| 几何 + 对比度 | 假 `tide`/`bridge` 驱动**真 `growth.js`**，八个接口喂真结构夹具 | 390px 视口 `vw === scrollW === 390`、`spillCount: 0`；七个区块高 166 / 228 / 302 / 340 / 143 / 143 / 372 |
| 交互 | 脚本点真按钮，每步回报 DOM 状态 | 见「三条铁律的实测证据」 |

**对比度（WCAG，前景 → 底色）**：主内容全部 ≥ 4.5 —— 身份卡姓名与标签 5.44（浅）/ 6.17（深）、
指标卡名与数字 4.71 / 7.47 / 5.02 / 6.03、区块标题与列表正文 13.53 / 11.08、
数据中心入口 12.67 / 10.5、学业概览 12.46 / 10.35。次级小字（11–11.5px）3.49（浅）/ 4.27（深）——
那是宿主主题里 `--ink-2` / `--ink-3` 这两档令牌本身的水平，跟随主题是刻意选择，不另造一套灰。

**三条铁律的实测证据**

- **铁律七（下拉栏双向动画）**：`[data-pg-toggle]` 展开后 `.pg-shell` 计算值
  `grid-template-rows: 31px` / `opacity: 1`（内容高 23px + 8px 上边距），再点一次回到 `0px`；
  展开瞬间 `document.getAnimations()` 返回 `transform@running`、`grid-template-rows@running`、
  `opacity@running` —— 三条过渡都真的被创建，`0fr ↔ 1fr` 可连续插值，中间帧存在。
- **铁律六（选中光）**：`我的消费 / 我的上网` 切换后 `.pg-tabs` 里始终只有 1 个 `.selection-glow`，
  类名带 `on`、尺寸跟着新按钮走（78×36 → 79×36），容器上 `_disposeSelectionGlow` 存在（观察者已挂）；
  切换只改 `aria-pressed`，不重建 `.pg-tabs` 本身。
- **减少动效**：`prefers-reduced-motion: reduce` 时 `.pg-shell`、`.pg-chev`、`.pg-kpi`、`.pg-modal`、
  `.pg-tabs button` 的 `transition-duration` 归零。

**本轮改掉的三个真问题**

1. **Escape 关不掉指标卡明细弹层**：`keydown` 原本只绑在 `modalEl` 上，焦点一旦用 Tab 走出弹层
   就收不到键。改为打开时挂 `document` 捕获阶段监听，`closeModal()` 与 teardown 里立刻摘掉。
   实测：Escape 后类名从 `pg-modal on` 回到 `pg-modal`，420ms 后节点被移除。
2. **迟到的 rAF 会把 `.on` 加回正在删除的节点**：`showModal` 里
   `raf(() => modalEl.classList.add("on"))` 补一句 `&& state.detail`，同一帧内被关掉时不再闪一下。
3. **安全区**：`.pg-modal` 是文件里唯一引用 `--s*` 的规则，四边都是
   `calc(Npx + var(--sat|sab|sal|sar, env(safe-area-inset-*, 0px)))`，符合
   `scripts/test-plugin-safe-area.mjs` 的 B / C 判据（`inset:0` + padding 含 calc ⇒ 不进 need 列表）。

> 三条踩坑记下来，免得下次重踩（都是工具侧的假象，不是代码问题）：
> ① 无头 Chrome 的 `--virtual-time-budget` **不推进 CSS 过渡**，直接量展开态 / 选中光会读到过渡
> 起点（`0px` / `opacity: 0`），量终态前必须先注入 `transition: none !important`；中间帧则用
> `document.getAnimations()` 证明过渡对象存在。
> ② `--screenshot` 给中文绝对路径（本仓库路径里有「时间管理软件」）会**静默不写文件**，
> 先写到 `$env:TEMP` 再拷回来。
> ③ `--dump-dom` 在本机完全无输出，取测量结果只能走本地 HTTP 服务 + `<img>` 信标
> （`fetch` 在 `--screenshot` 收尾前会被掐掉）。

> 验证用的夹具页、探针服务与临时脚本是**临时文件，收尾已删**；
> 上面每个数字都能按本节做法复算，`output/preview/growth-m390-light.png` / `-dark.png`
> 是同源截图（`output/` 已在 `.gitignore` 里）。

## 版本归属

v0.216.0 是「警大校历并入 + 分类图标各用各的」，v0.219.0 是「网页收集 / GitHub 文档 / 插件说明
三张卡片改成抽屉」，本次（v0.220.0）是「学生个人成长中心」，三份档各管各的功能。
`package.json` 从 0.216.0 到 0.220.0。

> ⚠️ 本次改动与另外两个会话在**同一个工作树**上并行（v0.219.0 那批卡片抽屉、`cppu-notify/main.js`
> 里的成绩雷达图都不是本次的）。版本号因此让开 0.218.0 / 0.219.0，取 0.220.0；
> 如果 `package.json` 又被别人抬走，本档的编号与它一起改，别只改一边。
