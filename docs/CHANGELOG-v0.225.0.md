# v0.225.0 · 「个人信息」视图（pdata）实测修复轮：复制记录栏建不出来、「复制全部」抄的是原值、身份卡标签在部分主题掉到 3:1

> `node ../tools/sync-version.js --check` → ✓ 三端版本一致：v0.225.0
> `node ../tools/sync-plugins.js --check` → ✓ 17 个内置插件三端同源
> `node ../tools/gen-theme-dark.js --check` → ✓ 派生调色板已同步
> `node ../tools/build-schedule-plugin.js --check` → ✓ 生成物与源一致
> `node ../tools/sync-android-native.js --check` → ✓ Android 原生代码与版本化镜像一致
> `npm test` → PASS: 138 个测试脚本全部通过

功能本体在 **v0.223.0**（`docs/CHANGELOG-v0.223.0.md`）。本档只记那一版之后**实测出来的修复**，
以及为什么版本号从 0.224.0 走到 0.225.0（改动进了 `public/plugins/`，按铁律一必须升）。

## 一、改了什么

| # | 问题 | 改法 |
|---|---|---|
| 1 | **「复制记录」折叠栏永远建不出来** | `histHtml()` 在 `state.history.length === 0` 时返回空串，而复制路径为了保住滚动位置与输入法组合**刻意不重画** ⇒ 第一次复制只更新了计数，折叠栏本身从没进过 DOM。改成 `syncHistFold()`：`flash()` 里发现 `[data-pf-fold]` 不存在就 `insertAdjacentHTML("beforeend", …)` 补插，存在则只改按钮文案与 `[data-pf-histbox]`。因为点击是 `root.onclick` 单点委托，补插后**不需要重新绑定** |
| 2 | **「复制全部」抄的是接口原值** | 原本拼 `state.fields`（`personInfo[dataField]`），于是复制出来是「性别：1」。改成拼 `state.heroTags + state.rows`（`<FIELD>_CN` 优先的那份），与卡片上看到的完全一致，重复项自然去重 |
| 3 | **身份卡标签在部分主题掉到 3:1** | `.pf-tag` 原为 `color:inherit`（继承 `.pf-hero` 的 `--on-accent`）+ `background:color-mix(#fff 18%, transparent)`。但渐变两端的明度方向**随主题翻转**：浅色主题 `--sea` 偏亮，而 night / sakura 那类深色主题的 `--deep` / `--sea` **反而偏亮**（`--on-accent` 是深色）—— 按一个方向叠半透明层，总有一套主题会掉到 3:1 上下。改成 `background:var(--panel)` + `color:var(--ink)` + `b{color:var(--ink-2)}`：这对令牌是主题测试里已按 **≥7:1 / ≥4.5:1** 约束过的组合，两个方向都稳 |
| 4 | 可点区域偏小 | `.pf-tag` 30 → **34px**、`.pf-fold>button` 32 → **34px**、`.pf-search button` 28 → **34px**（`.pf-btn` 38px、`.pf-cell` 57px 未动）。改完 390px 视口下**没有低于 32px 的可见可点元素** |
| 5 | 插件版本号 | `cppu-notify` 1.55.1 → **1.55.2**（`public/` 改动必须升，见 AGENTS.md 铁律一） |

改的文件：`le-time-management/public/plugins/cppu-notify/profile.js`（`syncHistFold` 新增、
`copyAll` 取值、`.pf-tag` / `.pf-fold>button` / `.pf-search button` 三处样式）、
`.../cppu-notify/manifest.json`（版本 + author 里 1.55.2 段）、
`le-time-management/package.json` + `package-lock.json`（两处 version），
以及 `sync-version.js` / `sync-plugins.js` 写出的生成物。

## 二、修复的实测证据

用假 `tide` / `bridge`（`bridge.api` 返回按 pdata `personInfo` 契约合成的数据）驱动**真 `profile.js`**，
页面跑**真 `styles.css`**，脚本点真按钮，每步回报 DOM 状态并 POST 回本地服务落盘：

- **① 折叠栏**：复制前 `foldExistsBeforeCopy = false` → 点第一格后 `foldExistsAfterCopy = true`、
  按钮文案 `▸复制记录（1）`、`histRows = 2`（连点两处后 2 条）。修前是 `false` 恒假。
- **② 复制内容**：`copyAfterCell = ["汉族"]`、`copyAfterTag = ["汉族","2025290058"]`；
  `复制全部` → `copyAllHead = ["学号：2025290058","性别：男","民族：汉族","电话：13800000000"]`、
  22 行。修前首行是「性别：1」。
- **③ 标签配色**：六套主题（classic 浅/深、night 深、sakura 深、frost 浅、dunhuang 浅）实测
  标签正文 **11.08–13.53**、标签名 **5.24–7.31**（修前最低 3.96）。用 canvas `fillStyle` + `getImageData`
  取渐变两个色标分别算、取最差的那个。
- 值里带**引号与换行**的字段（`备注 = 引号 " 与换行\n也在值里`）复制正常 —— 所有可复制项只带数组下标
  （`data-pf-tag` / `data-pf-cell` / `data-pf-hist`），值统一从 `state` 取，不进 DOM 属性。
- 全程 `err = 0`、`notices = 0`，`style#pf-profile-style` 只 1 个（样式注入幂等）。

## 三、同一轮实测的两条铁律

- **铁律七（下拉栏双向动画）**：展开 `0px / opacity 0` → 中间帧 `60.73px / 0.7534` → 终态 `90px / 1 / visible`；
  收起 `0.52px / 0.0676` → `0px / 0 / hidden`。**两个方向都有真中间帧**（`grid-template-rows` 0fr↔1fr 可连续插值）。
  390px 视口下同样验过：`90px/1 → 2.86px/0.2469 → 0px/0/hidden`。
  `visibility` 与高度一起过渡，收起后内部按钮既不可点也不进 Tab 序（`0fr + overflow:hidden` 只裁不封）。
- **铁律六（选中光）**：本视图没有「同一组选项选一项」的控件（复制记录是列表、筛选是即时显隐），
  因此**刻意不引入** `selectionGlow` —— 不为了凑规则给非单选控件加光块。

## 四、界面几何与对比度

| 项 | 1280 视口 | 390 视口 |
|---|---|---|
| 字段网格列数 | 3 列（228px） | 2 列（159.5px） |
| 横向溢出 | 0 | 0 |
| 文字被裁 | 0 | 0 |
| 可点高度 | cell 57 / tag 34 / btn 38 / toggle 34 | 同 |

对比度（浅色最低 / 深色最低）：字段值 12.67 / 11.08、字段名 3.27 / 4.05、标签正文 13.53 / 11.08、
身份卡姓名与学号 3.19 / 6.17（20px 半粗，大字门槛 3:1）、复制记录键 3.49 / 4.27。
次级小字（11–11.5px）落在 3.27–4.27 —— 那是宿主主题 `--ink-3` / `--ink-2` 两档令牌本身的水平
（仓库 `scripts/test-theme-contrast.mjs` 对 `--ink-3` 的门槛就是 **3.0**），跟随主题是刻意选择。

截图：`le-time-management/output/preview/cppu-profile-light.png` / `-dark.png` / `-m390.png`
（`output/` 已在 `.gitignore` 里）。

## 五、工具侧踩坑（不是代码问题，记下来免得重踩）

1. **模块里给 `navigator.clipboard` 赋值会抛**（只读访问器 + 严格模式）——
   要用 `Object.defineProperty(navigator, "clipboard", { value: {…}, configurable: true })`。
2. `--virtual-time-budget` 会**快进定时器但不推进 CSS 过渡时钟** ⇒ 展开/收起的中间帧一律读到 `0px`。
   要量中间帧只能**按真实时间跑**，再用 `fetch` 把结果 POST 回本地服务落盘（`--screenshot` 收尾前会掐掉 `fetch`）。
3. Chrome 会缓存模块 ⇒ 每次加 `?v=<random>`。
4. `color(srgb 0.96 …)` 这种新语法**不能用正则解析**（会算出 `1965874050.61` 这种离谱对比度），
   必须 `ctx.fillStyle = c; ctx.getImageData(0,0,1,1)` 让浏览器自己转。
5. 本机主题 id 里**没有 `mint`**（`mint` 是强调色令牌，不是主题）—— 传一个不存在的 `data-theme`
   会静默退回 `:root` 基色板，量出来的数没有意义。合法主题 id 共 16 个：
   classic / fresh / night / ocean / sakura / forest / lavender / mono / chatgpt / claude / shadcn /
   celadon / dunhuang / blueprint / citrus / frost。

## 六、版本归属

v0.223.0 是「个人信息」视图本体、v0.224.0 是「学生成长」视图的实测修复轮，
本次 **v0.225.0 是 v0.223.0 那块功能的实测修复轮**。`package.json` 从 0.224.0 到 0.225.0。

> ⚠️ 本轮与另外的会话在**同一个工作树**上并行。版本号取「下一个空闲号」；
> 如果 `package.json` 又被别人抬走，本档的编号与它一起改，别只改一边。
