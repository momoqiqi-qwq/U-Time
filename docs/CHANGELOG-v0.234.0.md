# v0.234.0 · 隐私展示模式（人脸模糊 / 数字 9 化 / 三维图全满）

> 归属说明：改动进 `le-time-management/src/`、`le-time-management/public/`、`le-time-management/index.html`
> （均属「必须升版本」的目录），随 v0.233.0 之后的 v0.234.0 发布（新增功能与设置分区 → minor +1）。
> 校验：`node ../tools/sync-version.js --check` → ✓ 三端版本一致 v0.234.0；
> `gen-theme-dark.js --check` / `build-schedule-plugin.js --check` / `sync-android-native.js --check` → ✓；
> `npm test` → **143 个测试脚本全部通过**（本次新增 `test-privacy-mask.mjs`）。

## 起因

用户要一个「给别人看屏幕」时用的展示模式：

> 在设置里添加一个展示模式，可以将私人信息进行模糊处理。对人脸进行模糊处理，
> 对数据进行 9 化处理，将所有数字的个位、十位、百位都变成 9。三维图也同样全满处理。

## 判断标准（先定边界，再动手）

| 决策 | 选了什么 | 为什么不选另一条 |
|---|---|---|
| 9 化的规则 | **逐位替换**：每个数字位 0~8 → 9（`128 → 999`，`2026-09-21 → 9999-99-99`） | 「末三位变 999」会漏掉小数与短号（`87.5` 有几位？），且 `128` 的个位/十位/百位**都**要变 9 —— 逐位替换正好是这个描述的直接实现 |
| 数字怎么改 | 遍历文本节点就地改写，`WeakMap` 记原文 | 不改 DOM 结构、不碰属性与表单值，关掉开关能**逐字还原**；重建 DOM 会丢焦点、滚动位置与动画状态 |
| 人脸 / 三维图怎么做 | **纯 CSS**，JS 只打标记 | 宿舍星图每帧旋转、番茄钟每秒刷新；在扫描循环里逐个 `querySelectorAll` 加类会拖慢界面 |
| 设置入口 | 独立的「隐私展示」分区 | 塞进「界面与交互」会与该卡的主题/密度/缩放混在一起，搜索也难命中 |
| 数据会不会被改 | **不动任何数据** | 只改「显示成什么样」；关掉开关立刻还原，导出/同步拿到的仍是原值 |

## 改了什么

### 1. 展示模式引擎（`src/privacyMask.js`，新增）

- `maskDigitsPreserveWidth(text)`：唯一一条 9 化规则（全角数字也一起处理，宽度保持不变，不引起重排）。
- `applyPrivacyMask()` / `restore()`：扫 `document.body` 文本节点；原文进 `WeakMap`，关掉时只回写
  **仍然等于上次掩码值**的节点 —— 应用改写过的内容不会被旧原文盖回去。
- 跳过名单：`script / style / kbd / samp / code / pre`、所有表单控件与 `[contenteditable]`、
  `[data-privacy-skip]` 子树。表单值不参与（改了会污染真实输入）。
- `MutationObserver`（子树 + 文本变化）跟着视图切换与插件渲染走，节流 180ms；
  另有 1200ms 的兜底全量重扫，防止漏掉没走观察器的动态内容。
- `syncPrivacyBadge()`：顶栏 `.privacy-badge` 的显隐与 `aria-live` 文案由它守着。

### 2. 偏好与样式

- `src/uiPreferences.js`：新增 `privacyMask`（默认 `false`），落 `:root[data-privacy-mask="on|off"]`。
- `src/styles/privacy-mask.css`（新增，`index.html` 静态引）：
  - `[data-private-face]` → `blur(7px) saturate(.55) brightness(1.06)` + `scale(1.06)` + `pointer-events: none`；
  - `.privacy-masked` → `opacity: .88` + `tabular-nums`（只做视觉标记，不改字宽）；
  - `[data-private-full] .dd-bed.empty .dd-bed-glyph` → 空位按占用渲染（`opacity: 1`、`fill: var(--dd-star)`、
    `stroke-width: 10`）。**必须 `!important`**：插件目录里的三级选择器排在宿主样式之后，
    不压住只在「刚打开那一帧」是全满的，随后会被插件自己的空位样式盖回去。

### 3. 标记点

| 位置 | 标记 |
|---|---|
| `src/shell.js` | 顶栏 `.privacy-badge`（`role=status` / `aria-live=polite` / `data-privacy-skip`）；顶栏头像 `data-private-face` |
| `public/plugins/ai-chat/main.js` | `.gui-avatar` 两支都加 `data-private-face` |
| `public/plugins/inbox-drop/main.js` | `.id-preview`（截图预览）/ `.id-thumb` 加 `data-private-face` |
| `public/plugins/dorm-duty/main.js` | `.dd-room`（3D 宿舍床位星图）加 `data-private-full` |

插件侧**不需要知道开关状态**：标记常驻，谁生效由宿主的 `[data-privacy-mask="on"]` 决定。

### 4. 设置分区「隐私展示」

`src/views/settings/appearance.js` 新增 `createPrivacyCard()`，`src/views/settings.js` 注册分区
（`icon: "user-shield"`，`src/settingsNavIcons.js` 新增该图标），搜索索引 `src/settingsSearchIndex.js`
加两行 + `SETTINGS_SECTION_LABELS.privacy`。

- `toggleRow()` 扩出第 4 个参数 `description`（原先只支持标签），隐私卡用它写「人脸模糊 · 数字 9 化 · 三维图全满」。
- 卡片里的样例串由 `maskDigitsPreserveWidth("学号 2021005 · 成绩 87.5")` **现场算**：文案与行为同源，改规则不会与说明脱节。
- 样例行与「边界」说明带 `data-privacy-skip`：模式开着时它们自己也会被 9 化，左右一起变 9 就让箭头失去意义了。

## 测试

- `scripts/test-privacy-mask.mjs`（新增）：纯函数逐位断言（`128→999`、`2021005→9999999`、`87.5→99.9`、
  全角 `１２８→９９９`）+ 最小 DOM 替身真跑开/关/还原/「应用改写过的节点不回滚」+ 源码接线守卫。
  替身必须**真跑 `acceptNode`**：漏掉过滤器时「跳过 code / 表单 / 可编辑区」会全变成空断言。
- `scripts/test-settings-global-search.mjs`：分区集合加 `privacy`，必含词 `隐私展示 / 人脸模糊 / 数字 9 化 / 三维图全满`。
- `scripts/test-settings-nav-icons.mjs`：分区数与图标数 15 → 16。
- 无头 Chrome 实景（390×844 与 1280×800 两档，探针页用完即删）：开关 → `data-privacy-mask` 由 `off` 变 `on`、
  徽标 `hidden=false` + `display:inline-flex`、`[data-private-face]` 计算样式命中 `blur(7px)` 且 `pointer-events:none`、
  被标 `.privacy-masked` 的文本节点 0 → 21 → 0（关掉全还原）、`scrollWidth - clientWidth = 0`（窄屏不溢出）；
  宿舍星图 4 张空床在模式开着时 `opacity: 1` / `fill: rgb(143,99,184)` / `stroke-width: 10px`、床位号 `1,2,3,4 → 9,9,9,9`。

## 影响面

- 关掉时近乎零开销：不扫节点、不打 `privacy-blur` 标记、不挂 `MutationObserver` 与兜底定时器
  （只有把 `data-privacy-mask` 写成 `off` 这一步）。
- 桌面 / Android / 小程序三端共用同一份 `uiPreferences`，但标记点只在桌面外壳与插件里，小程序端不显示该分区内容。
- 不改数据结构、不改存储键、不改插件 API（`tide.*` 一处没动），**无数据迁移**。
