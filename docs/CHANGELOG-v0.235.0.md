# v0.235.0 · AI 对话：常驻侧边栏 + 会话右键菜单（改名 / 归档 / 删除）+ 回答卡片配色

> 归属说明：改动进 `le-time-management/public/plugins/ai-chat/`（属「必须升版本」的目录），
> 随 v0.234.0 之后的 v0.235.0 发布（新增功能与布局调整 → minor +1）。
> 插件自身 `manifest.json` 版本 `0.10.0 → 0.11.0`（`node tools/sync-plugins.js` 已重跑）。
> 校验：`sync-version.js --check` → ✓ 三端版本一致 v0.235.0；
> `gen-theme-dark.js --check` / `build-schedule-plugin.js --check` / `sync-android-native.js --check` → ✓；
> `npm test` → **143 个测试脚本全部通过**。

## 起因

用户四条原话：

> ai对话上面还可以再窄一点，让对话能看到更多地方。
> 添加对话侧边栏。
> 右键对话题可改名、删除或归档。
> 给AI的回答内容的多表现为对话卡片，颜色多样化一些。

## 判断标准（先定边界，再动手）

| 决策 | 选了什么 | 为什么不选另一条 |
|---|---|---|
| 「上面再窄一点」改什么 | 对话面自己那圈的 `padding` 与头部高度（`26px clamp(22px,9%,100px) 18px` → `10px clamp(16px,5%,64px) 12px`，头部 `34px → 26px`，汉堡 `32px → 26px`） | 用户说的是「对话上面」，即对话卡片顶部那段留白；去改插件 `.view` 或宿主外壳会牵动全部 19 个插件 |
| 侧栏怎么加 | **两态同一个 DOM**：宽屏（`>720px`）是 `.side-docked` 的常驻列，窄屏退回原来的 absolute 抽屉 | 另起一套常驻侧栏 = 两份会话列表状态要同步；一套 DOM 只用一条媒体查询切 class |
| 布局怎么容纳一整列 | `.aichat` 从 `flex` 列改 **grid**，`grid-template-areas: "side head" / "side flow" / "side bar" / "side quick"` | flex 列做不到「侧栏跨满整高、其余四段仍在右侧各自成行」；四个浮层是 absolute，本来就不参与轨道分配 |
| 列宽怎么动 | `grid-template-columns` 轨道插值（`260px` ↔ `0px`）+ 内层固定 `236px` + `overflow-x:clip` | 用 `width` 过渡会让文字一路重排、视觉上「抽动」；固定内层只被裁掉，不重排 |
| 归档是什么 | **会话上的一个布尔位**（`archived`），侧栏里落进可折叠的「已归档」分组 | 删掉再想找回就没了；单开一个「归档页」对小数据量过重 |
| 改名怎么存 | `title` 从「首条用户消息自动取」变成**可被用户覆盖**，一旦手改就再也不被自动标题盖掉 | 让自动标题继续覆盖手改的名字，等于改名白改 |
| 卡片做在哪 | **`md()` 之外**：新增 `cardHtml()` 把 `md()` 的输出按空行切段、逐段装进 `<section class="aichat-card">` | `test-ai-chat.mjs` 里 `md()` 的精确输出是硬约束（十几条 `deepStrictEqual`），往 `md()` 塞分支会全线红 |
| 颜色怎么定 | 色相 = **内容哈希 + 段落序号**（`(h + i*3) % 6`，六色） | 纯按序号取色，同一条回答重绘时会跳色；纯按哈希，相邻同长段落可能撞色。哈希+序号两条都躲开 |
| 右键菜单的位置口径 | `position:absolute`，包含块是 `.aichat` 的 padding box | 铁律四：插件里 `position:fixed` 必须自己让开 `--sat/--sab/--sal/--sar` 四条边；absolute 天然落在宿主 `.view` 的安全边内，一行都不用写 |

## 改了什么

### 1. 顶部收紧（第 1 条）

| 选择器 | 旧 | 新 |
|---|---|---|
| `.aichat` 的 `padding` | `26px clamp(22px,9%,100px) 18px` | `10px clamp(16px,5%,64px) 12px` |
| `.aichat-head` 的 `min-height` | `34px` | `26px` |
| `.aichat-menu` | `32×32` | `26×26`（三条横线的 `::before` 光晕同步收） |
| `.aichat-sidebar` 的锚点 | `left:clamp(22px,9%,100px); top:70px` | `left:clamp(16px,5%,64px); top:52px`（跟着新 padding 走，否则抽屉飘在头部上方） |
| `.aichat-log` | — | 新增 `padding:6px 2px 0`（把腾出来的高度给对话流，而不是全给空白） |

`scripts/test-ai-chat.mjs` 里那条 `padding:26px clamp(22px,9%,100px) 18px;` 的断言已同步改成新串 ——
它是**故意钉住**的：改顶部留白就必须改这条，防止有人只改一处。

### 2. 常驻侧边栏（第 2 条，`main.js`）

- `render()` 里按 `matchMedia("(min-width: 720px)")` 挂 `.side-docked`，并监听它的 `change`：
  变宽 → 自动展开侧栏；变窄 → 收回抽屉态。**不在 JS 里读 `innerWidth`**
  （`test-plugin-safe-area.mjs` 会盯视口尺寸的读法，且 `matchMedia` 本身更准）。
- 常驻态下：`.aichat-sidebar` 从浮层变 `position:relative; grid-area:side`，宽度交给轨道；
  `.aichat-sidebar-close` 隐藏（常驻列不需要「收起」按钮，汉堡就是开关）；
  **遮罩被钳掉**（`.side-docked .aichat-backdrop{opacity:0;visibility:hidden}`）——
  常驻侧栏不是浮层，把对话面压暗是错的。
- 蒙版仍然只在**抽屉态**出现，`ui.closeSidebar()` 在常驻态直接 no-op（点空白不该关掉它）。
- 侧栏内层加了 `.aichat-sidebar-in`（`width:236px; flex:none`）：收起时靠外层 `overflow-x:clip` 裁掉。
- 展开/收起两个方向都有动画（铁律七），常驻态额外用 `grid-template-columns` 插值；
  `prefers-reduced-motion` 与 `:root[data-ui-motion="reduced"]` 两处白名单都补了新类名。

### 3. 会话右键菜单（第 3 条，`main.js`）

- 新 DOM：`.aichat-ctx`（`role="menu"`，三个 `role="menuitem"`：`data-ctx-act="rename|archive|remove"`）。
  它挂在 `.aichat` 下、`.aichat-id` 之后 —— 仍在 `<div class="aichat-flow">` **之前**，
  不破坏「head → backdrop → flow → bar → shortcuts」的顺序断言。
- 打开时给目标卡片加 `.ctx-on` 高亮（菜单是浮层，不给锚点看不出它要对哪一条动手）。
  位置由 JS 按 `.aichat` 的矩形夹取：`left/top = clamp(6, 指针 - 卡片原点, 卡片尺寸 - 菜单尺寸 - 6)`。
- 三个动作：
  - **重命名** → 卡片原地换成 `<input class="aichat-rename">`，Enter / 失焦提交、Esc 取消；
    空串或未改动就换回原样（`renameSession()` 只在真的改了时才自己重画）。
  - **归档** → 与「已取消归档」同一个键切换；侧栏里出现可折叠的「已归档 N」分组
    （`0fr ↔ 1fr` 连续插值 + 箭头连续旋转，铁律七），归档时自动展开一次并 `tide.notify`。
  - **删除** → 二次确认（`window.confirm`），删的若是当前会话就把内存里的 `thread / draft` 一起清掉
    再开一个新的空会话 —— 否则会留下一块「指向已删会话」的界面。
- 交互细节：`Esc` 分层关闭链里插在 `thinkOpen / idOpen` 之后、`sidebarOpen` 之前；
  点菜单外部关闭；菜单内 `↑/↓` 切项、`Home/End` 跳首尾。
  `setBehindInert()` 里显式跳过 `ctxMenu`（它的 `inert` 由 `openCtx/closeCtx` 自己管，宿主插手会死锁）。

### 4. 回答卡片与配色（第 4 条，`main.js`）

- `bodyHtml()` 里 AI 侧改走 `cardHtml()`，用户侧仍是 `md(s)` —— 自己写的话不需要被排版。
- `cardHtml()`：按空行切段，逐段包 `<section class="aichat-card" data-tone="0~5">`。
  只有第一段保留 `md()` 给的 `<p class="lead">`（结论），后续段把 `.lead` 摘成 `<p>` ——
  否则一条回答里会冒出好几个加粗大标题。
- `toneOf(text, i) = (hash(text) + i*3) % 6`：六个色相各自「左竖条 + 同色晕染底 + 同色小标题」，
  同一条回答重绘**不跳色**，相邻段落**必然不同色**。
- CSS 排在 `.aichat-msg .lead / .sec` **之后**（同特异性比先后），并带 `:last-child` 去尾边距。
- `md()` 一行未动，`node()`、`genuiHtml()` 的调用路径也未动 —— 生成式界面（`dsh-ui` 围栏）继续照旧渲染。

## 测试

- `scripts/test-ai-chat.mjs`：新增 154 行断言 —— 卡片切段与色相稳定性（同一文本两次 `cardHtml` 同色、
  相邻段不同色、`md()` 输出未被污染）、会话 `rename/archive/delete` 的真跑断言
  （改名后不再被自动标题覆盖、归档后落进分组、删当前会话会清 `thread/draft`）、
  右键菜单接线守卫（`ctxMenu` / `openCtx` / `closeCtx` / `ctx-on` / 分层 Esc / `setBehindInert` 跳过）。
  顶部 padding 断言按新值更新。
- 既有硬约束全部保留：`main.js` 里的 `md()` 精确输出、模板顺序（head → backdrop → flow → bar → shortcuts）、
  `.aichat-flow{display:flex;…}`、`.aichat-bar{position:relative;…}`、`.aichat-id` 的居中弹窗串、
  `.aichat-backdrop` 那条「不得出现 `transition:visibility 0s 220ms`」、减少动效白名单 240 字符上限
  （新类名追加后仍在限内）。
- `test-plugin-safe-area.mjs`：新代码只用 `position:absolute` 与 `getBoundingClientRect`，
  无 `position:fixed`、无裸 `env(safe-area-inset-*)`、无视口尺寸读取 → 通过。
- `npm test`：**143 个测试脚本全部通过**。

## 影响面

- 只动 `ai-chat` 一个插件（`main.js` + `manifest.json`），宿主 `src/`、`tide.*` API、存储键一处未动。
- 数据兼容：`sessions.items[]` 多了可选的 `archived` 与「已被用户手改」标记，老数据缺字段按 `false` 处理，
  **无需迁移**；`SESSIONS_KEY` / `THREAD_KEY` 等键名不变。
- 窄屏（Android 手机）：`≤720px` 不挂 `.side-docked`，行为与 v0.234.0 完全一致，仍是点汉堡出抽屉。
  常驻侧栏只在桌面/平板宽度生效。
- 小程序端该插件本就是 `platforms.miniprogram: "unavailable"`，不受影响。
