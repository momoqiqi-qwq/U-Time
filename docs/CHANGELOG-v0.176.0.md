# v0.176.0 · 插件中心：删掉「显示 18 / 18」，搜索框紧跟标签行并改成胶囊

## 改了什么

- **删掉「显示 N / N」计数行**。它原来是 `.market-head` 里唯一的文字
  （`src/shell.js:2045` 写的 `显示 ${rows.length} / ${getRegistry().length}`）。
  筛选档每枚**自带数量**（`全部 18 / 已启用 18 / 已停用 0 / 内置 18 / 用户插件 0`，
  见 `src/shell.js:1965-1987`），所以这行没有新增信息，实际作用只是把搜索框和标签行隔开一行。
- **搜索框改到标签行后面**。`wrap.append(...)` 的可见顺序由「标签行 → 计数行 → 搜索行 → 网格」
  变成「标签行 → 搜索行 → 网格」（`src/shell.js:2239-2246`）。
  手机端那个搜索开关按钮（`⌕`，`.market-search-toggle`）仍留在中间那一行 —— 它是手机上
  唯一的搜索入口，`@media(max-width:700px)` 下 `.market:not(.open-search) .market-search-row{display:none}`
  会把输入框收起来，删掉按钮就等于删掉入口。桌面端该行零高（按钮 `display:none`），不占位置。
- **搜索框改成和图3 那枚筛选胶囊同一套语言**（`src/styles.css` 第 1932 行那条单行规则）：
  `.market-search` 由 `height:38px / padding:0 12px` 改为 `height:34px / padding:0 16px`，
  描边仍是 `1px solid var(--line)`；新增 `.market-search::placeholder{color:var(--ink-2)}`，
  让框内提示文字与 `.market-filter` 的文字色一致；`.market-search-row` 的 margin 由 `12px 0 9px`
  收到 `4px 0 12px`，避免搜索框和标签行之间空出一整行的距。
- **圆角/底色必须另起一条抬高特异性的规则**（这条是踩出来的，见下）：
  ```css
  input.market-search:not([type="checkbox"]):not([type="radio"]):not([type="range"]) {
    border-radius: 999px !important;
    background: var(--panel) !important;
  }
  ```

### 🔴 踩坑：`.market-search` 自己写圆角等于白写

`styles.css:1745-1751` 有一条通用输入框规则：

```css
input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), select, textarea, .task-search, … {
  background: var(--control-bg) !important;
  border-color: var(--line) !important;
  border-radius: 8px !important;
}
```

它带 `!important`、特异性 (0,3,1)，而 `.market-search` 只有 (0,1,0)。**两边都带 `!important` 时
比的是特异性而不是先后**，所以第一版只把 `.market-search` 写成 `border-radius:999px`（甚至
`999px !important`）真机量出来的 computed 值仍然是 **8px**，搜索框照旧是方块状
（顺带发现：原来那句 `background: var(--panel)` 也一直是死声明，实际底色是 `--control-bg`）。
把选择器抬到 (0,5,1) 才拿得回来。新加的回归断言会同时拦住「删掉这条规则」和
「把圆角塞回 `.market-search`」两种改法。
- 框内提示文字仍是原来那句 `搜索插件名称 / ID / 功能 / 作者…`，位置不变（在输入框内部）。

## 影响范围与数据迁移

- 只改 `src/shell.js` 的 `renderMarket()` 与 `src/styles.css` 一条规则，Windows / Web / Android
  三端同时生效（插件中心三端共用同一份 DOM 与样式）。
- **无数据迁移**，不碰任何存储字段；筛选/搜索状态（`marketFilter` / `marketQuery` / `marketSearchOpen`）契约未变。
- 小程序端不共用这份界面，未动。
- **设置 › 插件管理**里那个同样叫 `.market-count` 的计数（`src/views/settings/plugins.js:75`）
  **刻意保留** —— 那边只有一行文字计数、没有筛选档自带数量，删了就没地方看总数；CSS 规则因此也保留。

## 验证

- 扩展 `scripts/test-market-toggle.mjs`（真跑 `renderMarket` 段的迷你 DOM 脚手架）：
  搜索行必须排在标签行之后且 `searchRow === head + 1`；市场里 `.market-count` 必须为 `null`；
  市场代码里不许再出现 `显示 ${rows.length}`；`.market-head-tools` 只剩 1 个子节点且必须是手机端搜索开关。
  CSS 契约：抬高特异性的那条胶囊规则必须存在且含 `border-radius:999px !important` 与
  `background:var(--panel) !important`；`.market-search` 自己**不许**再写 `border-radius`（写了也是死代码）；
  必须存在 `.market-search::placeholder{color:var(--ink-2)}`；`.market-search-row` margin 必须是 `4px 0 12px`。
- 变异测试（逐条注入回归）：① 顶栏工具区加回计数；② 标签行与搜索行之间再插一条计数行；
  ③ 删掉抬高特异性的胶囊规则；④ 胶囊规则里圆角改回 `8px`；⑤ 把圆角/底色塞回 `.market-search`（看着更直白、实际被压掉的改法）；
  ⑥ 去掉 placeholder 配色；⑦ 搜索行 margin 退回 `12px 0 9px` —— **7/7 全部被拦下**，还原后测试仍通过。
- **真机复验**（临时静态服务器 + 无头 Chrome 跑真应用真 CSS，探针 + 截图，产物见 `output/preview/`）：

  | 判据 | 桌面 1280 | 手机 390 |
  |---|---|---|
  | 市场里还有 `.market-count` 吗 | 否 | 否 |
  | 页面文字里还有「显示 N / N」吗 | 否 | 否 |
  | 市场子节点顺序 | filters → head(高 0) → search-row → grid | 同左 |
  | 标签行底 → 搜索框顶 | 16px | 搜索框默认收起（`.market-search-toggle` 显示，`display:flex`） |
  | 搜索框 computed 圆角 | **999px（与 `.market-filter` 完全相同）** | 999px |
  | 搜索框 computed 底色 | `rgb(49, 38, 63)`＝`--panel`＝未选中胶囊底色 | 同左 |
  | 框内提示文字 | `搜索插件名称 / ID / 功能 / 作者…`，色 `--ink-2` | 同左 |
  | 横向溢出 | 0 | 0 |

  截图再走一遍本地 OCR 复核：桌面截图里只出现标签行的「全部 18 / 已启用 18 / 已停用 0 / 内置 18」
  与 y 更低的「搜索插件名称 / ID / 功能 / 作者…」，**没有任何「显示 … / …」文字**。
- 三端版本一致 v0.176.0（Android `versionCode 17600`），全量 120 个测试脚本通过。
