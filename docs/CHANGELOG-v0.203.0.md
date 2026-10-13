# v0.203.0 · AI 对话插件会「画图」了：模型在回复里写一段 ```dsh-ui 围栏，气泡里直接长出告警卡 / 数字表 / ✅ 清单

> `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.203.0`；
> `node ../tools/gen-theme-dark.js --check` → `✓ 派生调色板已同步（15 套深色变体）`；
> `node ../tools/build-schedule-plugin.js --check` → `✓ shiguang-schedule 生成物与源一致`；
> `node ../tools/sync-android-native.js --check` → `✓ Android 原生代码与版本化镜像一致`；
> `node ../tools/sync-plugins.js --check` → `✓ 插件生成物与清单同源（18 个内置插件）`；
> `npm test` → `PASS: 129 个测试脚本全部通过`。
> 动的文件：`le-time-management/public/plugins/ai-chat/main.js`（+约 700 行：解析 190 行 + 渲染 250 行 + CSS 约 230 行）、
> `public/plugins/ai-chat/manifest.json`（0.9.0 → **0.10.0**）、`scripts/test-ai-chat.mjs`（新增一节 **70 条断言**）、
> `le-time-management/package.json` / `package-lock.json`（0.202.0 → **0.203.0**）、
> 同步器带出的 `src/pluginCatalog.js`、`miniprogram/core/pluginCatalog.js`、`src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json}`、
> `gen/android/app/src/main/assets/tauri.conf.json`、根 `docs/CHANGELOG-v0.203.0.md`。

## 用户要求原文

> 「对话参考我们的dsh-genui插件」
> 「让ai对话插件参考」

附一张 `dsh-genui` 渲染出来的深色验收报告截图，三段式：**红描边告警卡**（标题「老实话 3 处不一致（前两个是硬伤）」）→
**四列数字表**（负偏差标红、正偏差标绿、`0/6` 列错位计数）→ **左侧竖线串起来的 ✅ 清单**（加粗白标题 + 灰说明）。

要求不是"把那份 React 组件库搬过来"，而是：**这个插件也要长这样** —— 模型能把结论画成卡、把对比画成表、把通过项画成清单。

---

## 一、为什么不能照搬：三个物理限制

| | `dsh-genui` | `ai-chat` 插件 |
|---|---|---|
| 运行时 | React 组件树 + 自带 bundle | 宿主 `new Function("tide", src)` 沙箱，**只有 `tide.*` 和 `document`**，没有 React、没有 `import` |
| 图表 | 内联 `echarts-core` / `mermaid` / `three` | 没有任何依赖注入渠道，也不该为一个插件塞 1 MB 图表库 |
| 定位 | 页面级，可以自己铺全屏 | **不许建浮层**：`scripts/test-plugin-safe-area.mjs` 按字面量拦 `position:fixed` / `document.body.append` / `innerWidth` / `innerHeight` |
| 安全区 | 自己算 | 宿主 `.view` 已经让开四条边，插件**零代码**就落在安全区内 |

所以口径定成三句：**只复刻原生 DOM + CSS 画得准的那部分**；**规格先过白名单再画**；**交互只做本地的，要模型参与的按钮就渲染成禁用态**。

## 二、管线：先摘围栏，再按原位置拼回去

模型回复里现在可以出现三种块，顺序不定：

```
一段正文
```dsh-ui
{"title":"…","items":[…]}
```
又一段正文
```json
{"suggestions":[{"action":"create-task",…}]}
```
```

处理链（`main.js` 新增节「生成式界面：dsh-ui 围栏（v0.203.0）」）：

| 步 | 函数 | 干什么 |
|---|---|---|
| ① | `splitGenui(raw)` | 正则扫 ```` ```lang\n…``` ````，lang 命中 `dsh-ui` / `genui` **且规格解析成功**才摘；正文里原位留下 `\u0001GUIn\u0001` 占位符（`GENUI_MARK`） |
| ② | `parseGenui(inner)` | 找第一个 `{` → `giBalanced()` 配平括号（跳字符串与转义，容忍围栏外多一句解释）→ `JSON.parse`；失败只修尾随逗号再试一次 |
| ③ | `parseReply(text)` | **先** ①，**再**在剥离后的正文里从后往前找 ```json 建议块 |
| ④ | `bodyHtml(m)` | 按占位符把正文段交给 `md()`、把规格段交给 `genuiHtml()`，**按原顺序**拼 |
| ⑤ | `wireGenui(box, m)` | `wireMessage` 开头调用，只接本地交互 |

两个必须写下来的坑：

- **顺序不能反**。原来的 `parseReply` 会把第一个能 `JSON.parse` 的块当建议块，而 `dsh-ui` 规格恰好也是合法 JSON ——
  以数组为根的规格会被 `Array.isArray(parsed)` 那条分支**误认成建议列表**。所以摘围栏必须发生在找建议之前。
- **围栏可以在正文中间**，不能像建议块那样"从它开始往后切"。占位符就是为了保住这个位置（断言按字符偏移钉住）。

## 三、护栏：模型写错也不许把界面带崩

| 护栏 | 值 / 行为 |
|---|---|
| 未知 `type` | **丢**（不渲染、不透出文本），避免把模型的自造标签糊在界面上 |
| 节点上限 | `GENUI_MAX_NODES = 200`，超出截断（宿主一次只收 ≤60000 字符，但别让一个坏规格撑爆 DOM） |
| 层级上限 | `GENUI_MAX_DEPTH = 8`，超出截断 |
| 要外部库的类型 | `GENUI_AS_CODE = echart / mermaid / diagram / scene3d / plot / image / audio / video` → 降级成 `<pre class="gui-code" data-lang="mermaid">` 代码块，内容先 `esc()` |
| 字符串 | 一律先 `esc()` 再补内联（`**粗**` / `` `码` `` / `==高亮==` / `[文字](https://…)`）；`giInline` 只认 `https?:`，`javascript:` 不成链接 |
| 规格顶层 | 只留 `title`(≤120) / `gap`(4–28) / `items`(也认 `children`)；数组根、`items: []`、坏 JSON 一律当作"没有规格"，围栏原样留在正文里 |
| 布局 | 不建浮层、不用 `fixed`、不读视口尺寸 —— 四条禁用字面量一个字都没出现 |

## 四、画得出来的组件（约 35 个）

| 组 | type | 画法 |
|---|---|---|
| 容器 | `text` `card` `hero` `row` `col` `grid` `divider` `spacer` | flex / grid；`grid` 子节点带 `span` 时包一层 `grid-column:span N`（夹 1–4） |
| 结论 | `callout`(tone) `badge` `stat` `progress` | 告警卡＝圆角 + 左色条 + 6–16% 语气底色；`progress` 支持 `bars` 与 `ring` |
| 数据 | `table` `keyvalue` `list` `steps` `timeline` `breadcrumb` `file-tree` | 表格 `types[]` 支持 `text/num/delta/bar/group/index/badge`，另有 `total` / `filter` / `export`(复制 TSV) |
| 图表 | `chart` | `bars` / `line` / `donut`，**全部内联 SVG**（320×96 与 36×36 两种 viewBox），不引任何库 |
| 代码 | `code` `diff` `json` | `pre > code`，`::before` 出语言标签；`diff` 逐行 old/new 底色 |
| 交互 | `tabs` `accordion` `copy` `link` `button` `input` `textarea` `select` `checkbox` `switch` `radio` `quiz` | 全部**本地就地完成**：切页签、折叠、记值、筛表格行、复制、判卷 |

`quiz` 是唯一"像在考你"的组件：`radio` + `data-gui-answer`，按钮点了当场比对、标 `ok`/`no`、展开解释、文案变
「答对 N / M」，**零模型往返**。`button` 若带宿主 `action`（本轮不接活）渲成禁用态 —— 宁可不响应，也不给一个点了没反应的按钮。

## 五、配色：亮版常驻，**故意**不跟主题走

这是本版最反直觉的一条决定，写在这里免得以后有人"顺手改对"。

`ai-chat` 视图的外壳配色是**恒定深紫**的（`.aichat{--panel:#2b243b;…}` 无条件生效，气泡 `#2b243bd9`），
它**不随宿主明暗切换** —— 这是插件早就定下的长相。

所以组件色板**不能**挂在 `[data-theme-mode="dark"]` 上：宿主切到浅色主题时，深色分支不生效，
组件就会拿到 `#0F4C5C` / `#C0392B` 这类**深色语义色压在深底气泡上**，红字糊成一团看不清。改法：

```css
.aichat-gui{--gui-1:#8FD0E0;--gui-2:#7FD3A8;--gui-3:#E9BE72;--gui-4:#C4B5FD;--gui-5:#F09C93;--gui-6:#9EC5EA}
.gui-callout.error{border-color:#F09C9366;border-left-color:#F09C93;background:color-mix(in srgb,#C0392B 16%,var(--panel,#fff))}
.gui-callout.error>b{color:#F09C93}
.gui-delta.up{color:#7FD3A8}   /* 正偏差 */
.gui-delta.down{color:#F09C93} /* 负偏差 */
```

- **全部亮版常驻，一条 `[data-theme-mode="dark"] .gui-*` 都不留**（有反断言盯着，加回去就红）。
- 底色用 `color-mix(in srgb, <语义色> N%, var(--panel))` 就地稀释，深底上是暗底纹、浅底上也不会脏。
- 红＝`error`／负偏差，绿＝`success`／正偏差，与用户给的截图口径一致。

## 六、提示词：新增第 ⑧ 条

`systemPrompt()` 原来第 ⑥ 条明令"不要 Markdown 标题、表格、emoji、加粗和斜体"，现在补一句——**真要摆表格就改用第 ⑧ 条的围栏，别在正文里画**，
并新增第 ⑧ 条：四种情况该用围栏（横向对比两组以上数字 / 结论或风险要单独框 / 清单超过 6 条 / 有趋势占比），
根节点 `{"title":"…","items":[…]}`，可用 type 与字段清单，最外层 ≤8 个组件、≤200 节点、字符串里不要半角双引号、围栏外不复述。

第 ⑧ 条只写进发出去的提示词，`buildMessages()` 会把占位符从历史里**再抹一次**（`replace(GENUI_MARK…, "")`）——
所以模型在后续轮次看到的是干净的正文，不会去猜 `\u0001GUI0\u0001` 是什么。

## 七、测试

`scripts/test-ai-chat.mjs` 新增最后一节「生成式界面：模型能在正文里画组件（dsh-ui 围栏，v0.203.0）」，**70 条断言**，九组：

| 组 | 拦什么 |
|---|---|
| ① 摘围栏 | 占位符留下、**位置按字符偏移不许挪**（围栏在正文中间） |
| ② 容错 | 尾随逗号 + 围栏外多一句能解析；数组根 / 空 items / 坏 JSON / 无 items 一律 `null`；**坏规格原样留在正文里**（不许把内容吃掉） |
| ③ 与建议块共存 | `parseReply` 同时返回 genui 1 条 + suggestions 1 条，body 留占位符与中间正文，且不含 ```` ``` ```` 与规格字段 |
| ④ 占位符不外泄 | 设好历史后 `buildMessages()` 里不含 `GENUI_MARK`，正文仍在 |
| ⑤ 三段式 | 外壳属性逐字（`data-gui-block="g0"` + `--gui-gap:14px`）、`gui-bar-dot` 角标、`class="gui-callout error"`、`<thead><tr><th>视口(inner)</th>`、`<span class="gui-delta down">-0.0001</span>` / `up` 版、`<ul class="gui-list rail">`、条目 `<b>标题</b><span>说明</span>`、`icon:"✅"` 渲成 `gui-li-i`、`rail:false` 不画竖线 |
| ⑥ 白名单 | 未知 type 内容不透出；`mermaid` 降级成代码块；`<img>` 被转义成 `&lt;img`；200 节点与 8 层封顶（第 10 层那句"最深处"被截断） |
| ⑦ 内联与图表 | `**粗**` / `` `码` `` / `==高亮==` / 链接四种；`javascript:` 不成链接；donut 与 bars 都出内联 SVG |
| ⑧ 接线静态 | `bodyHtml(m)`、`wireGenui(box, m)`、占位符 replace、`const { body: stripped, blocks } = splitGenui(text)`、`genui:` 落盘、第 ⑧ 条的提示词字样 |
| ⑨ 样式 | callout error 亮版红边、`--gui-gap`、`--gui-1:#8FD0E0`、**反断言** `doesNotMatch(/\[data-theme-mode="dark"\] \.gui-/)`、表格 `overflow-x:auto`、折叠用 `grid-template-rows:0fr→1fr`（**不是** `display:none`）、减少动效覆盖、窄屏内边距 |

## 八、验证

界面用 `letime-plugin-ui-check` 的路子：`vm` 跑**真 main.js**（注入 `__fx`）取它自己的
`genuiHtml(spec, {} , "g0")` 与插件整段 CSS，再内联 `src/styles.css` + `theme-derived.css` 出真样式页，
headless Chrome 截图逐段核对：

- `.workbuddy/preview/aichat-genui-night-dark.png`（night 主题 / 深色宿主）：告警卡圆角红描边 + 红左条 + 暗红底、
  标题红字、正文灰白；表头 + 横向分隔线、三行对齐、`-0.0001/-0.0002` 偏红、`+0.0001` 偏绿、右边缘未被裁；
  清单左侧竖线 + 圆点、每颗绿色 ✅、加粗白标题 + 灰说明。**无文字重叠、无被裁、无退化成纯文本的段落。**
- `.workbuddy/preview/aichat-genui-light-host.png`（classic 主题 / **浅色**宿主）：气泡里仍是那套亮版配色，
  红/绿/白字都读得清 —— 就是上面那条"色板不许挂 `data-theme-mode`"的现场证据。
- 顺手排掉一次误报：截图里"引导语前面那条红色竖条"其实是外壳的紫色强调条（取色 `#504060` 系），不是错色。

## 九、验证命令

```
node scripts/run-tests.mjs                     → PASS: 129 个测试脚本全部通过
node ../tools/sync-version.js --check          ✓ 三端版本一致：v0.203.0
node ../tools/gen-theme-dark.js --check        ✓ 派生调色板已同步（15 套深色变体）
node ../tools/build-schedule-plugin.js --check ✓ shiguang-schedule 生成物与源一致
node ../tools/sync-android-native.js --check   ✓ Android 原生代码与版本化镜像一致
node ../tools/sync-plugins.js --check          ✓ 插件生成物与清单同源（18 个内置插件）
```

---

**一句话**：模型现在可以在回复中间放一段 ```dsh-ui 围栏，插件用原生 DOM + CSS 把它画成告警卡、数字表和 ✅ 清单；
规格先过白名单、字符串先转义、不建浮层不读视口，颜色一律亮版常驻（因为这个视图的外壳恒为深底）。
