# v0.184.0 · 所有搜索框只留放大镜（框内不再写中文占位词）

## 用户要求原文

> 「删除所有搜索框内的中文，仅保留搜索图标。」

## 一、改了什么

应用里 7 处搜索框（顶栏搜索钮 + 6 个输入框）统一成同一套语言：**框内只有一颗跟随主题色的
放大镜，没有任何中文**。

| # | 位置 | 改前（框内中文） | 改后 |
|---|---|---|---|
| 1 | 顶栏搜索钮 `src/shell.js` | 放大镜 + 「搜索」二字（桌面参考布局 / 更新历史页显示文字） | 只剩 34×34 放大镜瓷砖，文字 span 从 DOM 删除 |
| 2 | 插件中心 `.market-search` | `搜索插件名称 / ID / 功能 / 作者…` | 空框 + 左侧放大镜 |
| 3 | 命令面板 `.cmd-input` | `搜索任务、时间块、插件、设置，或输入命令…` | 空框 + 原有 `.cmd-search-ico` 放大镜，提示挪进 `title` |
| 4 | 四象限 `.task-search` | `搜索任务 / 备注 / 项目` | 空框 + 放大镜 |
| 5 | 设置左栏 `.settings-search` | `搜索设置：背景、快捷键、WebDAV…也认拼音缩写（zt → 字体）` | 空框 + 放大镜，提示挪进 `title` |
| 6 | 设置 · 插件管理 `.plugin-search-input` | `搜索插件名称 / ID / 描述 / 作者…` | 空框 + 放大镜 |
| 7 | 设置 · 模型列表（`aiModelPicker.js`） | `搜索模型名称或 ID` | 空框 + 放大镜 |

无障碍没有一起删：每个输入框的 `aria-label`（搜索插件 / 搜索任务 / 搜索设置 / 搜索可用模型…）
原样保留，所以读屏仍然知道这个框是干什么的。

## 二、怎么实现的

新增 `src/searchField.js`，只有三件东西：

- `SEARCH_GLYPH` —— 内联 SVG 放大镜（`stroke="currentColor"`，深浅主题同一份）；
- `searchGlyph(cls)` —— 放大镜节点（顶栏那种「图标本身就是一个按钮」的场合用）；
- `withSearchGlyph(input)` —— 把输入框包进 `div.search-field`，放大镜钉在框内左端。

CSS（`src/styles.css` 新增区块）：

```css
.search-field{position:relative;display:flex;align-items:center;flex:0 1 auto;min-width:0}
.search-ico{position:absolute;left:13px;width:16px;height:16px;pointer-events:none;color:var(--ink-3)}
.search-field > input{padding-left:38px;padding-right:16px}   /* (0,1,1) 压过 .market-search 等的 (0,1,0) */
.market-search-row > .search-field, .plugin-search-row > .search-field{flex:1 1 auto}
.quad-wrap > .search-field{flex:none;margin:0 0 14px}
.search-field > .task-search{margin:0;width:100%}
```

左内边距 38px = 图标左边距 13px + 图标 16px + 间隙 9px，文字永远压在图标右边，不会重叠。

## 三、踩到的一个真坑：容器变成了「纵向伸展」

`.quad-wrap`（四象限视图）是 `display:flex; flex-direction:column` 的容器。第一版把
`.search-field` 写成 `flex:1`，**在列向 flex 里 flex:1 是吃纵向剩余空间**：无头 Chrome 探针
实测容器被撑到 **990×318**，象限网格被整块压扁。

修法是默认 `flex:0 1 auto`，只在真正横排的两个搜索行（插件中心 `.market-search-row`、
插件管理 `.plugin-search-row`）里给 `flex:1 1 auto`，四象限再显式 `flex:none` 兜一道。
探针复测：`.task-search` 容器回到 **990×41**（就是输入框自己的高度）。

## 四、实测（无头 Chrome + 真 DOM 探针）

临时静态服务器 + 驱动页跑**真应用外壳**（真 `src/`、真样式、真 `localStorage` 降级），
逐个视图读每个搜索框的几何与属性：

| 视图 / 框 | 容器尺寸 | 框内有 `.search-ico` | placeholder | padding-left |
|---|---|---|---|---|
| 插件中心 `.market-search` | 982×34 | 1 | 空 | 38px |
| 四象限 `.task-search` | 990×41 | 1 | 空 | 38px |
| 设置左栏 `.settings-search` | 1026×39 | 1 | 空 | 38px |
| 插件管理 `.plugin-search-input` | 738×35 | 1 | 空 | 38px |
| 模型列表搜索框 | 594×21 | 1 | 空 | 38px |
| 命令面板 `.cmd-input`（图标在框外的行里） | 517×33 | — | 空 | — |
| 顶栏 `.top-search`（所有视图） | 34×34 | 1 个 glyph | — | 文本为空、无 CJK |

浅色（classic）与深色（night）各出一版截图，产物在 `output/preview/search/`。

## 五、回归防线

- **新增 `scripts/test-search-field.mjs`**：7 个框的 placeholder 必须为空、旧中文占位串
  一个都不许残留、6 个框必须走 `withSearchGlyph`、SVG 必须 `currentColor`、
  CSS 三条契约（定位 / 不吃点击 / 38px 让位）与「列向容器里不许纵向伸展」都得在。
- `scripts/test-android-layout.mjs`：原「桌面默认布局包含搜索文字」的断言反转成
  **不许再出现 `top-search-label`**（DOM 与 CSS 都不许），并守住桌面参考布局只做水平居中。
- `scripts/test-market-toggle.mjs`：`renderMarket` 的 `new Function` harness 补
  `withSearchGlyph` / `searchGlyph` 两个替身。
- `scripts/test-settings-option-search.mjs`、`scripts/test-nephele-settings.mjs`：设置卡片
  子节点 1 现在是 `.search-field` 容器，断言跟着改成「容器 → 放大镜 → 输入框」三级。
- `node scripts/run-tests.mjs` 全绿；`node ../tools/sync-version.js --check` ✓（v0.184.0）。

## 六、没动的部分（有意留下）

- **内置插件自己的搜索框**（`chaoxing-notify` 的 `.cx2-search`、`shiguang-schedule` 的
  `.school-search`）仍带中文占位词：它们各自有自己的 `manifest.version` 与发布节奏，
  要一并去掉得走插件的版本 + `tools/sync-plugins.js` 流程，属于另一笔改动。
- 输入框的 `aria-label` / `title` 里的中文全部保留 —— 那是读屏与悬停提示，不是「框内的字」。
