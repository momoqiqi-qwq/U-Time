# v0.186.0 · 搜索框只留放大镜（补齐 8 个内置插件 + 小程序）

> 版本号说明：本工作区有几条改动并行。`0.182.0`（Nephele 主区底色）、`0.183.0`（品牌字标与装饰线）、
> `0.184.0`（主应用搜索框只留放大镜）各被别的改动占用；`0.185.0` 记「警大插件下载附件横幅可点」。
> 本次改动是 `0.184.0` 那笔的续集（当时那份说明里明写「插件搜索框属于另一笔改动」），
> 落地时版本已到 `0.185.0`，故再抬一格记在 **`0.186.0`**
> （`node ../tools/sync-version.js --check` 输出 `✓ 三端版本一致：v0.186.0`）。

## 用户要求原文

> 「删除所有搜索框内的提示中文，仅保留或添加搜索图标在搜索框前面」

## 一、这一版补的是什么

`0.184.0` 只做了主应用自己的 7 处搜索框，插件与小程序当时**有意留着**。本版把那笔补完 ——
**8 个内置插件的 9 处 + 小程序 6 个页面的 8 处**搜索框，框内中文占位词一个不留，
全部换成框内左端的放大镜。主应用那 7 处不动（已达标）。

| # | 位置 | 改前框内中文 | 改后 |
|---|---|---|---|
| 1 | 学习通通知 `chaoxing-notify`（收件箱） | `搜索课程 / 教师 / 作业 / 考试 / 正文…` | 空框 + 放大镜，提示挪 `title` |
| 2 | 学习通通知（课程页） | `搜索课程 / 教师 / 班级…` | 空框 + 放大镜，提示挪 `title` |
| 3 | 警大门户通知 `cppu-notify` | `关键词过滤：标题 / 发布人 / 单位 / 分类…` | 空框 + 放大镜，提示挪 `title` / `aria-label` |
| 4 | 竞赛消息雷达 `gx-news` | `关键词过滤：如 答辩 / 数学 / 报名 / 截止…` | 同上 |
| 5 | RSS 信息流 `rss-reader` | `关键词过滤：标题与摘要…` | 同上 |
| 6 | 网页收集 `web-collector` | `搜索已收藏网站` | 同上 |
| 7 | 学校通知聚合 `school-notice` | `搜索通知` | 同上 |
| 8 | 时光课程表 `shiguang-schedule` | `搜索学校名称或拼音首字母` | 同上 |
| 9 | 考试日历 `exam-calendar` | `搜索考试名称` | 同上 |
| 10 | 小程序：收件箱 / 资料库 / 插件中心 / 四象限 / 课程表 / 插件页（考试、竞赛、学习通两处） | `搜索标题、内容或来源` / `搜索标题、摘要或备注` / `搜索插件名称 / ID / 功能…` / `搜索任务 / 备注 / 项目 / 标签` / `搜索课程、教师、地点、备注` / `搜索考试名称` / `关键词：答辩 / 数学 / 报名 / 截止…` / `搜索标题 / 正文 / 发送者…` / `搜索课程 / 教师 / 班级…` | 空框 + 放大镜，提示挪 `aria-label` |

无障碍没有一起删：每个输入框的 `aria-label`（搜索学习通通知 / 搜索学校 / 搜索通知…）
与悬停用的 `title` 原样保留，读屏与鼠标悬停仍然知道这个框能搜什么。

## 二、怎么实现的

内置插件各自打包成单文件，**import 不了** `src/searchField.js`，也拿不到宿主的 `.search-field` 样式；
小程序连内联 SVG 都没有。所以三处各写一套，做法同构：

**桌面插件（9 处）** —— 容器接管占宽与定位，图标钉在框内左端，输入框让出内边距：

```html
<span class="cx2-searchbox">
  <span class="cx2-search-ico" aria-hidden="true"><svg …>…</svg></span>
  <input class="cx2-search" … placeholder="">
</span>
```

```css
.cx2-searchbox{position:relative;display:flex;align-items:center;flex:1;min-width:220px}
.cx2-searchbox>.cx2-search{flex:1;min-width:0;padding-left:36px}
.cx2-search-ico{position:absolute;left:12px;width:15px;height:15px;display:inline-flex;color:var(--ink-3);pointer-events:none}
.cx2-search-ico svg{width:100%;height:100%;display:block}
```

容器 / 图标类名：`.cx2-searchbox`（学习通）、`.pp-kwbox`（警大门户）、`.gx-kwbox`（竞赛雷达）、
`.rss-kwbox`（RSS）、`.wc-searchbox`（网页收集）、`.sn-searchbox`（学校通知）、
`.sg .school-searchbox`（时光课程表）、`.ecal-searchbox`（考试日历）。
图标颜色一律跟随主题变量（`var(--ink-3)` / `var(--sg-faint)` / `currentColor`），
只有 cppu-notify 与 gx-news 沿用它们自己原有的硬编码 `#7E8B94`。

**小程序（8 处）** —— 图标改成纯 CSS 画的放大镜（圆环 + 斜柄），一套样式放 `app.wxss` 给六个页面共用：

```css
.search-wrap{position:relative;display:flex;align-items:center;min-width:0}
.search-wrap > input{flex:1 1 auto;min-width:0;padding-left:62rpx}
.search-ico{position:absolute;left:20rpx;top:50%;width:30rpx;height:30rpx;margin-top:-15rpx;pointer-events:none}
.search-ico::before{content:"";…;width:21rpx;height:21rpx;border:3rpx solid var(--ink-3);border-radius:50%}
.search-ico::after{content:"";…;width:13rpx;height:3rpx;background:var(--ink-3);transform:rotate(45deg)}
```

横排工具条里的搜索框需要容器吃满剩余宽度，三处 wxss 各补一条：`.plugin-search-wrap`、
`.exam-tools .search-wrap, .gx-toolbar .search-wrap, .cx-toolbar .search-wrap`、`.searchbar .search-wrap`。

## 三、踩到的坑

1. **两个插件入口是生成物**：`shiguang-schedule/main.js` 由 `tools/build-schedule-plugin.js`
   （`ui.js` + `model.js`）生成、`exam-calendar/main.js` 由 `tools/build-exam-calendar-plugin.js`
   （`src/main.template.js` + `src/exam-data.json`）生成 —— 只改源、再跑生成器；直接改 `main.js` 会被下次生成覆盖，
   `--check` 也会红。
2. **两个插件文件是 CRLF**：`web-collector/main.js` 与 `school-notice/main.js` 用 `\r\n`，
   插入的多行 CSS 必须跟着 `\r\n`，否则一个文件里混两种行尾。
3. **样式风格不同**：小程序 WXSS 是格式化风格（`position: relative;` 带空格），桌面插件是紧凑风格
   （`position:relative`）—— 契约测试的正则要写 `position:\s*relative`，否则只过一半。
4. **验证页抽 CSS 抽错**：考试日历的样式写在 JS 字符串数组里（`".ecal-searchbox{…}" +`），
   按行整行取会把引号与 `+` 一起塞进 `<style>`，语法一坏**整段 CSS 静默失效** ——
   首测探针里那个框的图标是 `static`、尺寸 300×300（SVG 默认尺寸）。先摘引号内的片段才正常。
5. **无头 Chrome 两个坑**：`--screenshot` 不认相对路径（报「系统找不到指定的路径」，必须传绝对路径）；
   PowerShell 里拼查询串要写 `"${url}?mode=dark"`，写成 `` "$url`?mode=dark" `` 时 `$url?` 会被当成变量，
   两张截图会一模一样（首测 `diffRatio = 0` 就是这么来的）。

## 四、实测（真 CSS 渲染 + 几何探针）

无头 Chrome 打开一张验证页（内联真 `src/styles.css` + `src/styles/theme-derived.css` + 各插件真 CSS 行 +
小程序按 390px 视口把 `rpx` 换算成 `px` 的 `app.wxss`），逐框读几何与计算样式：

| 搜索框 | 容器 | 图标 (x, y, 宽, 高) | 定位 | 输入框 padding-left | 占位符 | 图标右缘 → 文字起点 |
|---|---|---|---|---|---|---|
| 学习通 · 收件箱 | 220×21 | 12, 3, 15, 15 | absolute | 36px | 空 | 9px |
| 警大门户 · 关键词 | 188×44 | 11, 15, 14, 14 | absolute | 32px | 空 | 7px |
| 竞赛雷达 · 关键词 | 176×37 | 11, 12, 14, 14 | absolute | 32px | 空 | 7px |
| RSS · 关键词 | 188×21 | 11, 4, 14, 14 | absolute | 32px | 空 | 7px |
| 网页收集 · 搜索 | 200×42 | 12, 14, 15, 15 | absolute | 34px | 空 | 7px |
| 学校通知 · 搜索 | 190×21 | 12, 3, 15, 15 | absolute | 34px | 空 | 7px |
| 时光课程表 · 学校搜索 | 190×21 | 11, 3, 15, 15 | absolute | 34px | 空 | 8px |
| 考试日历 · 搜索 | 184×21 | 9, 4, 14, 14 | absolute | 28px | 空 | 5px |
| 小程序 · 收件箱 / 资料库 / 插件中心 / 四象限 / 课程表 / 考试 / 竞赛 / 学习通（8 处） | 338×21 | 10, 3, 16, 16 | absolute | 32.24px | 空 | 6px |

16 个框**全部**满足：图标绝对定位且真的渲染出可见尺寸（14~16px）、占位符为空、
图标右缘到文字起点留 5~9px 余量（文字永不压住图标）。深浅两色各截一张，图标颜色跟着主题走：

| 出处 | 浅色（classic） | 深色 |
|---|---|---|
| `var(--ink-3)`（学习通 / RSS / 网页收集 / 学校通知） | `#7D8B97` | `#908B83` |
| 硬编码（警大门户 / 竞赛雷达） | `#7E8B94` | `#7E8B94` |
| `currentColor` 继承（时光课程表 / 考试日历） | `#22303A` | `#E3E1DE` |
| 小程序 `var(--ink-3)` | `#A9B2BA` | `#61707A` |

截图产物：`output/preview/search-verify-light.png`、`output/preview/search-verify-dark.png`
（两图像素差 100%，确认深色确实生效，不是「截了两次浅色」）。

## 五、回归防线

`scripts/test-search-field.mjs` 从「只管主应用」扩成「三端一起管」，新增两段：

- **④ 内置插件**：8 处逐条查 `容器{position:relative}`、`图标{position:absolute}`、
  `容器>input{padding-left}` 与真的渲染出 `class="图标"`；再加 9 条旧中文占位串黑名单
  （`placeholder="搜索通知"` 这类**精确到属性**的匹配，改名 / 搬家式的假删除也会被抓住），
  同时正向断言提示确实挪进了 `title` / `aria-label`。
- **⑤ 小程序**：`app.wxss` 五条 CSS 契约（定位上下文 / 绝对定位不吃点击 / 圆环 / 斜柄 / 62rpx 让位），
  6 个页面必须同时出现容器与图标，9 条旧占位串黑名单，插件页那一页的四处计数要对。

三处硬编码的插件版本断言跟着升版：`test-chaoxing.mjs`（2.17.0 → 2.18.0）、
`test-rss-reader.mjs`（1.6.1 → 1.7.0）、`test-web-collector.mjs`（1.5.0 → 1.6.0）。
`npm test` 全绿（125 个测试脚本），`node ../tools/sync-version.js --check` ✓、`sync-plugins.js --check` ✓、
两个插件生成器 `--check` ✓、`gen-theme-dark.js --check` ✓、`sync-android-native.js --check` ✓。

## 六、版本

- 应用：`0.184.0` → `0.185.0`（本次改动抬的，随后被并行的附件横幅改动借用）→ **`0.186.0`**（本次记入）
- 插件：学习通通知 `2.18.0`、警大门户通知 `1.37.0`、考试日历 `0.4.0`、竞赛消息雷达 `0.6.0`、
  RSS 信息流 `1.7.0`、学校通知聚合 `1.8.0`、时光课程表 `3.15.0`、网页收集 `1.6.0`
- 影响端：Windows / Android（8 个内置插件）+ 微信小程序（6 个页面）
- 数据迁移：无。只改搜索框的装饰与占位词，字段、持久化、筛选逻辑都没动。
