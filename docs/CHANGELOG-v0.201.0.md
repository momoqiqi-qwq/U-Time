# v0.201.0 · AI 对话插件的「头像与名称」改成居中弹窗，背后那层蒙版这才真的存在

> `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.201.0`；
> `node ../tools/gen-theme-dark.js --check` → `✓ 派生调色板已同步（15 套深色变体）`；
> `node ../tools/build-schedule-plugin.js --check` → `✓ shiguang-schedule 生成物与源一致`；
> `node ../tools/sync-android-native.js --check` → `✓ Android 原生代码与版本化镜像一致`；
> `node ../tools/sync-plugins.js --check` → `✓ 插件生成物与清单同源（18 个内置插件）`；
> `npm test` → 见文末。
> 动的文件：`le-time-management/public/plugins/ai-chat/main.js`、
> `public/plugins/ai-chat/manifest.json`（0.8.0 → **0.9.0**）、`scripts/test-ai-chat.mjs`（新增一节 29 条断言）、
> `le-time-management/package.json` / `package-lock.json`（0.200.0 → **0.201.0**）、
> 同步器带出的 `src/pluginCatalog.js`、`miniprogram/core/pluginCatalog.js`、`src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json}`、
> `gen/android/app/src/main/assets/tauri.conf.json`、根 `docs/CHANGELOG-v0.201.0.md`。

## 用户要求原文

> 「这个窗口弹出放在中间背后界面蒙版」

附一张 AI 对话插件的截图：右侧「头像与名称」那块内容直接铺在对话面上、几乎占满整宽，
它就是对话流里的一张卡片，看起来不像浮层。用户要的是两件事：**弹到中间** + **背后压一层蒙版**。

---

## 一、改前：它不是弹窗，是对话流里的一张卡

| 项 | 改前 | 问题 |
|---|---|---|
| `.aichat-id` 的定位 | `flex:none` —— 是 `.aichat` 这个 flex 列的普通子项，DOM 位置在消息区与输入区之间 | 它跟对话内容是**同一层**，所以只能"占一行"，不可能居中，也不可能飘在其它内容之上 |
| 开合 | 在侧栏里点「头像与名称」→ `ui.idPanel.hidden = !ui.idPanel.hidden` | `hidden` 是布尔开关，没有中间态，更谈不上动画 |
| `.aichat-backdrop` | `position:absolute;inset:0;z-index:4` + 只有 `visibility` / `pointer-events` | **它是一层看不见的空气**：只负责"点一下能关掉侧栏"，没有任何底色，打开面板时背后根本看不出被压过 |
| 关闭方式 | 只有"再点一次那个按钮" | Esc 只管侧栏、点蒙版只管侧栏，面板没有任何隐式出口 |

所以用户看到的是「咦，这卡片怎么弹出来了」而不是「上面浮起来一块东西」。

## 二、改后：三条口径

### 1. 定位用 absolute，不用 fixed（这条是安全区铁律）

```css
.aichat-id{position:absolute;z-index:8;left:50%;top:50%;
  width:min(520px,calc(100% - 44px));max-height:min(78%,560px);overflow:auto;
  transform:translate(-50%,-50%) scale(.92);opacity:0;visibility:hidden;pointer-events:none;
  transition:opacity 180ms ease-in,transform 220ms ease-in,visibility 0s 220ms}
.id-open .aichat-id{opacity:1;transform:translate(-50%,-50%) scale(1);visibility:visible;pointer-events:auto;
  transition:opacity 220ms cubic-bezier(.22,1,.36,1),transform 320ms cubic-bezier(.34,1.4,.64,1),visibility 0s}
```

`.aichat` 上有 `position:relative`，所以 absolute 的包含块是它的 **padding box** —— 天然落在宿主
`.view` 那四条安全边（`--sat/--sab/--sal/--sar`）里面，**不需要插件自己补任何一条边**。
如果图省事写 `fixed`，包含块会变成视口，弹窗就跑到宿主 `.view` 的 padding 之外、压上状态栏
（铁律四那条「插件自建浮层必须自己让开四边」的坑）。这条有断言拦着。

宽度 `min(520px, calc(100% - 44px))`：宽屏是一张 520px 的卡；窄屏退化成"左右各留 22px"，
不会顶到屏幕边。再配两条窄屏/矮屏的收口：

```css
@media (max-width:640px){.aichat-id{width:calc(100% - 36px);padding:12px 13px}}
@media (max-height:480px){.aichat-id{max-height:calc(100% - 32px);gap:8px;padding:12px 13px}}
```

两个数都对得上 `.aichat` 自己在该断点下的内边距（`16px 18px 14px` / `12px …10px`），
所以是"贴着内容区"而不是"贴到屏幕边"。

### 2. 展开与收起两向都有动画（铁律七）

- **收起**：`opacity 180ms ease-in` + `transform 220ms ease-in`，`visibility` 延迟 220ms 才切 —— 过渡走完才隐藏。
- **展开**：`opacity 220ms cubic-bezier(.22,1,.36,1)` + `transform 320ms cubic-bezier(.34,1.4,.64,1)`（回弹），`visibility` 立刻生效。
- **没用 `display:none`**，也没用 `hidden` 属性：面板收起来时内容留在 DOM 里，所以两向动画都播得出来。
- 减少动效（系统 `prefers-reduced-motion` / 应用内 `data-ui-motion=reduced`）下把 `.aichat-id` 一并放进 `transition:none`，开合变瞬切。

同时删掉了 `<div class="aichat-id" hidden>` 上的 `hidden`，开合状态改由 `.aichat` 上的
`.id-open` 一个类驱动 —— 一个状态源，不会出现"类说开着、属性说关着"的双头。

### 3. 蒙版：从"空气"变成真的一层

改前那条 `.aichat-backdrop` 只有 `visibility` / `pointer-events`，没有任何视觉。现在：

```css
.aichat-backdrop{position:absolute;inset:0;z-index:4;background:#1c13286b;backdrop-filter:blur(3px);
  opacity:0;visibility:hidden;pointer-events:none;transition:opacity 200ms ease,visibility 0s 220ms}
.sidebar-open .aichat-backdrop,.id-open .aichat-backdrop{opacity:1;visibility:visible;pointer-events:auto;transition:opacity 220ms ease,visibility 0s}
.id-open .aichat-backdrop{z-index:7}
```

- 底色 `#1c13286b` + `blur(3px)`：背后界面真的暗下去、糊一点，浮层关系一眼可见（侧栏也顺带受益 —— 它以前同样没有蒙版视觉）。
- `z-index` 从 4 抬到 7：汉堡键是 `z-index:6`，**弹窗开着时它不该还能点** —— 不抬这一下，蒙版盖不住它，用户还能从"浮层背后"把侧栏拉出来。
- 蒙版本身配上 `opacity` 过渡，淡入淡出而不是瞬间跳黑。

## 三、交互：Esc / 点蒙版 / 焦点 / 背后那层 inert

```js
const setBehindInert = (on) => {
  [...root.children].forEach((child) => {
    if (child === idPanel || child === backdrop) return;
    if (on) child.inert = true;
    else child.inert = child === sidebar ? !sidebarOpen : false;
  });
};
```

- **弹窗开着时，背后所有兄弟节点进 `inert`**：不接点击、不进 Tab 序。
  `.aichat-backdrop` 特意排除在外 —— 它是"点一下关掉"的落点，inert 掉就没人接这一下。
- **恢复时侧栏按自己的状态写回**（不是一律 `false`）：侧栏关着的时候本来就该是 inert，
  一把清成 false 会让收起的侧栏变成"Tab 得到、却看不见"的幽灵。
- **Esc 一次只关最上面那层**：`const top = idOpen ? closeId : sidebarOpen ? () => setSidebar(false, true) : null;`
- **点蒙版**同理：`if (idOpen) setIdOpen(false); else setSidebar(false, true);`
- **焦点**：打开时进弹窗（`tabindex="-1"` + `idPanel.focus()`，不抢输入框、手机上不弹键盘）；
  关闭时回触发按钮 —— 从侧栏里点开的会先把侧栏收起，那就回汉堡键
  （`idReturnTo = from === ui.idBtn ? menu : from`），回一个已经藏起来的按钮等于把焦点丢了。
- **一次只开一个浮层**：蒙版只有一块，从侧栏打开弹窗时先 `setSidebar(false)`。
- 换会话（`startSession`）里补 `ui.closeId?.()`，跟原来的 `ui.closeSidebar()` 一起收干净。

### 结构

```html
<div class="aichat-id" id="aichat-id-panel" role="dialog" aria-modal="true" aria-label="头像与名称"
     aria-hidden="true" tabindex="-1" inert>
  <div class="aichat-id-head"><b>头像与名称</b><button type="button" class="aichat-id-close" data-id-close aria-label="关闭头像与名称">×</button></div>
  …（两行头像 + 名称 + 恢复默认，原样）…
```

- `role="dialog" aria-modal="true"` + 自己的标题 + 自己的关闭键（`data-id-close`）：
  蒙版和 Esc 都是隐式出口，**只有一个隐式出口的浮层等于没有出口**。
- 初始 `inert` 是兜底：脚本还没跑起来时它也进不了 Tab 序。
- 触发按钮同步维护 `aria-expanded` / `aria-controls="aichat-id-panel"`。

## 四、测试

`scripts/test-ai-chat.mjs` 新增最后一节「「头像与名称」是一块居中弹窗 + 背后蒙版（v0.201.0）」，
**29 条断言**，分五组：

| 组 | 拦什么 |
|---|---|
| ① 弹窗本体 | 必须真的居中（`left/top:50%`）；收起态与展开态的居中偏移都不能丢（丢了就跑右下角）；两向过渡都要在；**不许用 `display:none` 收** |
| ② 位置口径 | 必须是 `absolute`，出现 `fixed` 就红（fixed 会跳出 `.view` 安全区） |
| ③ 蒙版 | 必须有底色与模糊（"只有 pointer-events 的是空气"）；侧栏与弹窗共用一块；`.id-open` 下 `z-index:7` 要压过汉堡键；不许退回"只切 visibility"的老写法 |
| ④ 结构 | dialog 语义 / inert 兜底 / 标题 / 自己的关闭键；不许再出现 `<div class="aichat-id" hidden>`；不许留下 `.aichat-id{flex:none;` |
| ⑤ 交互 | Esc 只关最上层；背后 inert 且排除蒙版；侧栏状态要按 `sidebarOpen` 写回；焦点回触发按钮；点蒙版 = 关；一次只开一个浮层；`ui.closeId` 存在；减少动效下瞬切 |

## 五、验证

```
node ../tools/sync-version.js --check          ✓ 三端版本一致：v0.201.0
node ../tools/gen-theme-dark.js --check        ✓ 派生调色板已同步（15 套深色变体）
node ../tools/build-schedule-plugin.js --check ✓ shiguang-schedule 生成物与源一致
node ../tools/sync-android-native.js --check   ✓ Android 原生代码与版本化镜像一致
node ../tools/sync-plugins.js --check          ✓ 插件生成物与清单同源（18 个内置插件）
npm test                                       → 见下
```

`npm test` 结果：**127/129 通过**。红的两条都与本版无关：

- `test-chaoxing-card-color.mjs` —— 这是上一批 chaoxing「卡片上色」工作留下的**未跟踪新脚本**
  （`?? le-time-management/scripts/test-chaoxing-card-color.mjs`），它用 `vm` 加载 chaoxing 插件源码，
  失败点是 `assert.deepStrictEqual` 的跨 realm 原型比较（`Values have same structure but are not reference-equal`），
  属于 chaoxing 那条线的 WIP，本版一行都没碰。
- `test-release-history.mjs` —— 它要求 `docs/CHANGELOG-v<package.json 版本>.md` 存在且排首条；
  补上本文件即通过（已补）。

---

**一句话**：弹窗从"对话流里的一张卡"变成"宿主容器里居中的浮层"，蒙版从"一层空气"变成"真的暗下去的一层"，
代价是 `absolute` 而不是 `fixed`，换回宿主四条安全边天生生效。
