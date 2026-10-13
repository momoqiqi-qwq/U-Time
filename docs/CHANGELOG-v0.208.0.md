# v0.208.0 · 警大通知新增「获奖名单」：从通知正文里筛出谁获了奖，分个人/团体按数量排名、按时间看奖项项目

> 本次改动（实测输出）：
>
> - `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.208.0`
> - `node ../tools/gen-theme-dark.js --check` → `✓ 派生调色板已同步（15 套深色变体）`
> - `node ../tools/build-schedule-plugin.js --check` → `✓ shiguang-schedule 生成物与源一致`
> - `node ../tools/sync-android-native.js --check` → `✓ Android 原生代码与版本化镜像一致`
> - `npm test` → `PASS: 131 个测试脚本全部通过`
>
> 动的文件：新增 `public/plugins/cppu-notify/award-list.js`（609 行，解析纯函数 + 面板工厂）、
> `public/plugins/cppu-notify/main.js`（+364/−62：抽取共用取数、获奖视图骨架与同步、侧栏与工具栏入口、视图注册）、
> `public/plugins/cppu-notify/manifest.json`（1.41.0 → 1.42.0，描述补「获奖名单」用法）、
> 新增 `scripts/test-cppu-award.mjs`（313 行）、`scripts/test-cppu.mjs` 与 `scripts/test-android-plugin-views.mjs`（把新视图 id 加进清单）、
> 生成物 `src/pluginCatalog.js` / `miniprogram/core/pluginCatalog.js`（经 `tools/sync-plugins.js` 同步）、
> 版本 `package.json`（0.207.0 → 0.208.0，三端已同步、`package-lock.json` 两处已手改）。
> 有新增存储键（`awardBoardCache` / `awardViewPreferences`）；无数据迁移、无插件 API 变更、无宿主存档字段变化。

## 用户要求

> 给警大通知添加 1 个功能，可以查看获奖人员，分团体和个人，可以按获奖数量排名，可以按时间顺序把奖项项目一个个列出来，
> 然后点开下拉栏就可以看到谁获奖【记得筛选通知内容，不要照搬原文】

后一句是这一版的核心约束：**不能把通知正文整段端上来**，要从里面筛出「谁获了什么奖」这类结构化记录。

## 一、数据从哪来：列表接口里没有获奖字段

门户通知列表接口（`/tp_up/up/pim/allpim/getAllPimList`）每条只给 `PIM_TITLE`、`RESOURCE_ID`、`CREATE_TIME`、
`IS_TOP`、`IS_READ`、`CREATE_USER_NAME`、`BELONG_UNIT_NAME`、`TYPE_NAME` —— **没有任何获奖字段**，
名单只在详情接口的 `PIM_CONTENT` / `CONTENT_URL` 正文里。

所以链路是：**候选筛选（标题）→ 逐条取正文 → 正文解析出结构化记录 → 汇总排名**。
标题只是用来决定「值不值得拉正文」，最终有没有条目由正文说了算。

为了不让这一轮同步把通知视图搅乱，获奖视图**自己分页拉列表**（同一个接口、同一套凭据），
合并进 `state.notices` 并落通知缓存，但**不触发**通知列表重画、也不经 `tide.inbox` 推送；
正文取数从 `loadDetail` 里抽成了公用的 `fetchNoticeContent(rid)`，两边共用（`detailVersion` 语义未变，有错 0 / 成功 2）。

## 二、筛什么、不筛什么（口径写清楚，宁缺勿滥）

**候选（标题）**：命中「获奖 / 荣获 / 表彰 / 名单 / 结果 / 揭晓 / 评比 / 竞赛」这类词才拉正文；
「报名 / 征稿 / 招募 / 选拔 / 申报 / 培训 / 会议 / 答辩 / 缴费 / 选课 / 考试安排 / 讲座 / 招聘」一律排除 —— 这些标题里常见的「名单」是参赛名单、分组名单，不是获奖名单。

**条目名不照搬标题**：`cleanAwardTitle()` 反复剥掉「关于 / 公布 / 印发 / 转发 / 公示 / 表彰 / 喜报 / 我校 …」这类外壳与
「…的通知 / 公告 / 公示 / 决定 / 获奖名单 / 受表彰名单」这类尾巴，剥完不足 4 字就退回原标题。
例：`关于公布2025年全国大学生数学建模竞赛获奖名单的通知` → **2025年全国大学生数学建模竞赛**。

**正文解析只认两种行**：

1. **标签行** `获奖人员：张三、李四` / `获奖集体：星火代表队` —— 标签决定归到个人还是团体；
   指导教师 / 领队 / 教练单独一栏（只展示，**不计入排名**，避免"指导教师拿了一等奖"这种错记）。
2. **名单行** —— 整行就是人名或队名。这类行最容易误收，所以逐行先过筛：
   长度 ≤ 90 字、必须含中文、不能夹数字/字母/@、不能含「的 / 了 / 是 / 和 / 与 / 及 / 请 / 根据 / 按照 / 经 / 由 / 希望 / 要求」一类说明词；
   拆逗号/顿号/分号后**任一**片段不合格，整行作废（一处不对就不猜）。

**人名判定**：2–4 个汉字，且不含「学院 / 校 / 系 / 室 / 部 / 中心 / 队伍 / 组 / 队 / 班 / 级 / 年」等机构或年级用字 ——
这一条把「侦查学院」「2022 级」这类词挡在名单外。
**团体判定**：4–30 字，且以「代表队 / 团队 / 小组 / 队伍 / 支队 / 大队 / 中队 / 学院 / 学部 / 班级 / 团支部 / 党支部 / 社团 / 协会 / 教研室 / 实验室 / 中心 / 委员会 / 队 / 组」收尾。

**级别与层级**从通知文字归类：级别按 特等奖 / 金奖 / 一等奖 / 银奖 / 二等奖 / 铜奖 / 三等奖 / 优秀奖 / 入围奖 排序，
层级按 国际 / 国家 / 省 / 市 / 校 / 院 收窄；同一段文字里新出现的级别会成为后续名单行的上下文。

**括号与编号一起洗**：`张三（侦查学2022级一班）`、`1.王五`、`张三、李四` 都能拆成人名。

**统计口径**：同一奖项里同一个人只记 1 项（防「张三、张三」重复计数）；命中次数相同的人/队共享同一次名次。

**明确说清楚会漏的情况**：通知只说「取得佳绩」「再创辉煌」却没有逐字列人，就不会有条目 ——
所以面板底部常驻一句「读到的通知里没有明确名册段落不等于无人获奖」，并给出「去通知视图确认是否加载了更早的通知」。

## 三、界面：两个模式，三组单选

新视图 `cppu-award`（标题「警大获奖名单」，图标 `trophy`），入口两处：侧栏「校园服务」新增「获奖名单」，
以及通知视图工具栏的「获奖名单」按钮（都走 `tide.util.navigate("plug:cppu-award")`）。

- **奖项项目**（默认）：按时间把奖项一条条列出来，顶部可选「最新在前 / 最早在前」；
  每条显示条目名 + 日期 + 级别 + 层级 + 个人/团体标记，**点一下展开**看谁获奖（团体条目额外列出已知成员），
  展开区里还有「回到原通知」——点了跳回通知视图并展开那一条，方便逐字核对。
- **获奖排名**：切「个人 / 团体」，按获奖数量降序排，名次并列同名次；展开可以看到这个人/队是靠哪几个项目上的榜。
- 顶部三组单选（模式 / 顺序 / 类别）用同一套分段按钮，顺序与类别两组按当前模式显隐（同一个位置，不重建）。

状态条与横幅沿用仓库风格：进度（`正在读正文筛选获奖名单 3/12（已命中 1 条）`）、失败（整条可点重试）、
同步时间都写在面板里；偏好存 `awardViewPreferences`，解析结果缓存到 `awardBoardCache`（记 `username`，换账号自动作废）。

## 四、铁律六：单选切换走宿主的滑动选中光

三组单选按钮接的是**宿主同一套实现** —— `src/selectionGlow.js` 的 `attachSelectionGlow()`。
插件拿不到宿主源码，宿主把它开在 `tide.ui.selectionGlow(box, { selector })` 上（插件权限集合里已有 `ui`），
所以面板这边只做三件事：把 `.aw-seg` 容器交给它、把 `aria-pressed="true"` 的按钮标出来、切换后 `sync()` 让光块从上一个选项滑过来。

为此**壳只建一次**：模式/顺序/类别换选项时只切 `aria-pressed` 与 `hidden` 属性，**不重建 `innerHTML`** ——
一旦重建，光块和它的观察者就成了孤儿，位移动画会被截断。列表内容走签名比对（模式 | 类别 | 顺序 | 统计 | 进度 | 条目 id 串），
只有内容真变了才重建那一块，连点分组按钮不会把已经展开的条目推倒重来。
宿主要是没有这个 API（旧版本），面板照常工作，只是没有滑动光（`tide.ui.selectionGlow?.()` 返回空即降级）。

## 五、铁律七：下拉栏展开与收起都有动画

每条奖项的展开沿用仓库事实标准：`.aw-shell{display:grid;grid-template-rows:0fr;opacity:0}` →
`.aw-item.open .aw-shell{grid-template-rows:1fr;opacity:1}`，`.aw-clip` 负责裁切，箭头跟着转。
**双向都有中间帧**（打开和收起都跑 0.42s 的 `grid-template-rows` + 0.24s 的 opacity，下方内容随布局让位），
**不靠 `display:none` 收尾**；`aria-expanded` / `aria-controls` 同步维护，点开只改类名、不重画列表。

展开态存在面板自己维护的 `openKeys` 集合里，而不是从 DOM 里读 —— 因为换模式 / 换类别会重画列表，
那时 DOM 里已经没有原来那些条目了，从 DOM 读等于把用户折开的条目又收回去。重画后按 key 复现展开态。
`@media(prefers-reduced-motion:reduce)` 白名单里带上了 `.aw-arrow / .aw-shell / .aw-row`，跟着应用的减少动效设置走。

## 六、证据

**单测** `scripts/test-cppu-award.mjs`（313 行）：

- 纯函数：标题清洗（含「洗没了退回原标题」）、级别与层级归类、名单行拆分与「整行作废」、
  团体成员提取、`buildAwardBoard` 汇总、排名并列规则、时间正倒序。
- 面板：用迷你 DOM（`closest / classList / getAttribute / contains` 都有，够跑就地改类名的展开逻辑）真跑 `render()` ——
  断言三组单选常驻壳里、**宿主滑动光被接了 3 次且带 `selector`**、切换后 `sync()` 被调、
  展开/收起后 `aria-expanded` 与 `.open` 类同步、来源回跳拿到 rid、偏好节流后最终落盘的是最后一次选择、
  空态与失败态都说人话。
- 静态接线：视图注册 / 两条入口 / 共用 `fetchNoticeContent` / 候选与解析调用点 / 缓存键 /
  徽标刷新按钮 / 与通知列表同一分页参数；面板侧断言 0fr→1fr 三条动画规则与 reduced-motion 白名单、
  `.aw-seg .selection-glow` 与 `has-selection-glow` 两条光块规则、宿主 `tide.ui.selectionGlow` 的传参写法。

**全量**：`npm test` → `PASS: 131 个测试脚本全部通过`（新增本测试；`test-cppu.mjs` 与
`test-android-plugin-views.mjs` 各加了一条 `cppu-award` 断言，确认 APK 卡片也暴露这个视图）。

## 七、兼容与影响面

- 插件版本 1.41.0 → 1.42.0（新增用户可见视图）；宿主 0.207.0 → 0.208.0（本版独立于竞赛雷达筛选面板那一版）。
- **只新增，不改通知视图既有行为**：`loadDetail` 抽出取数函数后行为与 `detailVersion` 语义不变，
  通知视图的展开、附件、缓存、微信推送链路都没动。
- **小程序端不涉及**：`cppu-notify` 在 `platforms.miniprogram` 里本就是 `unavailable`，清单描述同步即可。
- 新增两个存储键（`awardBoardCache` / `awardViewPreferences`），都带 `username`，换账号自动作废，不碰宿主数据。

## 八、本版没动、但记下来的一笔

正文里的**表格型名单**（HTML 表格或制表符对齐）没有专门解析 —— 这类通知目前只会在标签行 / 名单行命中时才出现条目，
表格里排得整整齐齐的「姓名 获奖等级」可能整段漏掉。真要做，得在正文里保留表格行的列结构再逐列判定，
本版先守住「宁可少列、不要错列」。

## 九、验证命令

```bash
cd le-time-management
node ../tools/sync-version.js --check
node ../tools/gen-theme-dark.js --check
node ../tools/build-schedule-plugin.js --check
node ../tools/sync-android-native.js --check
npm test
```

> 升版本后 `sync-android-native.js --check` 可能先红一次：`sync-version.js` 会改 `src-tauri/tauri.conf.json` 的 version，
> 而 `src-tauri/gen/android/app/src/main/assets/tauri.conf.json` 是它的镜像副本 —— 跑一次不带 `--check` 的同步命令即可。

---

**一句话**：列表接口里没有获奖数据，所以这一版是从通知正文里**筛**出结构化记录 ——
标题先刷掉报名/征稿/选拔一类（它们的「名单」不是获奖名单），正文只认标签行与整行名册，
人名与队名各有硬判定（机构词、年级数字、说明词一律不要），再由两个模式承载：
按时间把奖项项目一条条列出来、点开看谁获奖，或者切个人/团体按获奖数量排名；
三组单选切换走宿主的滑动选中光，下拉栏开与收都有连续动画。
