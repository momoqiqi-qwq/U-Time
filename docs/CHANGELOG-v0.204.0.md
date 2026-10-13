# v0.204.0 · AI 对话插件的「带本机数据 / 思考强度」搬进输入区，思考强度改成带动画的下拉栏

> 本次只动插件界面，不动数据：`le-time-management/public/plugins/ai-chat/main.js`（手写入口，非生成物）。
> 校验实跑：
>
> - `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.204.0`
> - `node ../tools/gen-theme-dark.js --check` → `✓ 派生调色板已同步（15 套深色变体）`
> - `node ../tools/build-schedule-plugin.js --check` → `✓ shiguang-schedule 生成物与源一致`
> - `node ../tools/sync-android-native.js --check` → `✓ Android 原生代码与版本化镜像一致`
> - `npm test` → `PASS: 129 个测试脚本全部通过`

## 一、两个胶囊按钮从顶栏搬进对话框

改动前，`.aichat-head` 里塞着四样东西：汉堡菜单、「正在思考…」喂入区（`.aichat-feed`）、`带本机数据`、`思考强度`。
这两颗胶囊离输入框隔着一整屏对话流，用户改一句话的上下文与思考档位，眼睛得往上找。

改后 `.aichat-head` 只留菜单与思考指示，两颗胶囊落进 `.aichat-bar` 内新增的 `.aichat-compose-chips` 一行：
它们与 textarea、👤 个性化、模型选择、发送键同属一张卡，改「这句话怎么问」的东西全在一处。
`.aichat-compose-chips .aichat-chip{padding:5px 12px}` 是按输入区尺度重新调过的（顶栏那颗更大）。

## 二、思考强度：循环点击 → 下拉栏

原先是 `cycleThink()`：点一下在「自动 → 低 → 中 → 高」里转一格，用户想看全四档只能连点四下发呆。
现在胶囊按钮是「显示当前值 + 方向箭头」的展开器：

- 按钮：`class="aichat-chip aichat-effort" data-think`，`aria-haspopup="listbox"`、`aria-controls="aichat-effort-menu"`，内文 `<span class="aichat-effort-lab">` 写出「思考强度 自动 / 低 / 中 / 高」，右侧 `<i class="aichat-effort-arrow">` 是箭头。
- 列表：`<div class="aichat-effort-menu" id="aichat-effort-menu" role="listbox" aria-label="思考强度">`，内层 `.aichat-effort-in` 包着 `THINK_ITEMS` —— 四颗 `role="option"` 的 `.aichat-lv`，带 `data-think-lv="自动的 id"`，每项写 `<b>档位</b><small>hint</small>`，四档的 `hint` 原文照搬，没改文案。
- 选择即收：`pickThink(id)` 只接受 `isThinkLevel(id)` 认得的档位，认不出来直接丢弃 —— **不能让非法值漏到 `tide.ai.chat`**，Rust 侧的档位映射会报错。

## 三、展开与收起都有动画（铁律七）

不是「打开淡入、关闭 `display:none`」，而是可连续插值的折叠容器：

```css
.aichat-effort-menu{display:grid;grid-template-rows:0fr;opacity:0;
  transition:grid-template-rows 260ms cubic-bezier(.22,1,.36,1),opacity 200ms ease}
.aichat-effort-menu.open{grid-template-rows:1fr;opacity:1}
.aichat-effort-in{overflow:hidden;min-height:0;padding:0 8px;
  transition:padding 260ms cubic-bezier(.22,1,.36,1)}
.aichat-effort-menu.open .aichat-effort-in{padding:8px}
```

- 高度：`0fr → 1fr` 让容器高度与内容一起连续变化，输入框下方那一行不会瞬间跳一格，而是平滑让位。
- 方向箭头：`.aichat-effort-arrow` 用 `border-right/bottom` 拼的 7px 方块，`transform:rotate(45deg)`（朝下）→ `[aria-expanded="true"]` 时 `rotate(-135deg)`（朝上），`240ms` 同一根缓动曲线，`margin-top` 微调补齐视觉中心。
- 收起时内容留在 DOM 里直到过渡结束，**不 `display:none`、不删节点**，所以「收起中间帧」是真的看得出高度在收。
- 快速连点：`setThinkMenu(open)` 是对状态赋值再写 DOM 的幂等函数，从当前画面接续，不会回到初始位置、不会叠加动画、不残留临时样式。

## 四、键盘、焦点与可达性

- 未展开时列表带 `aria-hidden="true"` + `inert`：选项既点不到、也 Tab 不到、读屏也不读 —— 收起后它还挂在 DOM 里（为了动画），必须靠 `inert` 挡。
- 展开时两者一起翻面：`aria-hidden="false"`、`inert = false`。
- 选中后 `setThinkMenu(false, true)` 把焦点还回胶囊按钮，焦点不会掉到 `document.body` 上。
- 列表上 `keydown` 支持 ↑/↓ 在选项间移动、Escape 收起。
- Escape 的关层顺序：`thinkOpen ? () => setThinkMenu(false, true) : idOpen ? closeId : sidebarOpen ? …` —— 下拉栏最轻，先关它；它关了才轮到「头像与名称」弹窗，最后才是侧栏。
- 打开头像弹窗时顺手收起下拉栏（`if (open && thinkOpen) setThinkMenu(false)`），不然后面 `setBehindInert` 与焦点还原会跟一份还开着的浮层打架。

## 五、单选高亮走宿主的滑动选中光（铁律六）

四个档位是**单选组**，所以选中高亮必须像侧栏插件、设置分类一样滑过去，而不是瞬间换底色：

```js
const THINK_ON = "button.aichat-lv.on";
thinkGlow = tide.ui.selectionGlow?.(ui.thinkMenu, { selector: THINK_ON }) || null;
```

`paintThink()` 改完 `.on` 之后 `thinkGlow?.sync()`，插件重建时 `thinkGlow?.dispose()`。
宿主没给 `selectionGlow`（老宿主 / 测试环境）时退化成静态背景：`.aichat-effort-menu:not(.has-selection-glow) .aichat-lv.on` 自带底色，行为不塌。

光块的**落位时机**是这一节里最容易写错的一处：展开的那一帧容器还是 0 高、内边距也还在从 0 长到 8px，
「下一帧就同步」量出来的落点比终态少 8px（换档后重新展开，高亮会贴着选项上沿偏出去一截）。
所以 `setThinkMenu(true)` 改成等最长那条过渡（行高与内边距都是 260ms）走完再量：

```js
clearTimeout(thinkGlowTimer);
if (open) thinkGlowTimer = setTimeout(() => thinkGlow?.sync(), 300);
```

连点只留最后一次（旧 timer 被 `clearTimeout` 掉），重建与卸载时也一并清掉。用定时器而不是 `transitionend`，
是因为开了减少动效时过渡被砍掉、`transitionend` 根本不触发，光块会永远等不到落位。

> 真应用探针实测（无头 Chrome 跑真外壳 + 真插件，直接读宿主的 `style.top`）：
> 钉在「展开第一帧」同步得到 `114px`，等过渡走完同步得到 `122px` —— 而「高」那一项的 `offsetTop` 正是 `122`。
> 顺带一条测量教训：`getBoundingClientRect()` 在这里会骗人，宿主的光块滑动是 Web Animations 动画，
> 无头环境不推进、停在起始帧，于是 rect 读出来永远像「贴在顶上、宽度还少一截」；判定落位只能用 `offsetTop` / `style.*`。

## 六、减少动效与窄屏

- `prefers-reduced-motion: reduce` 的瞬切白名单里补进 `.aichat-effort-arrow`、`.aichat-effort-menu`、`.aichat-effort-in`；
- 跟随应用内开关的那份 `:root[data-ui-motion="reduced"] …` 规则同样补上这三个选择器 —— **系统偏好与应用设置两条路都要覆盖**，少了任何一条，用户开了「减少动效」还会看到滑出来的动画。
- `@media (max-width:640px)`：`.aichat-compose-chips` 收窄间距，`.aichat-lv` 缩小内边距，并把 `.aichat-lv small`（档位说明）藏掉 —— 手机上四行副文案会把列表撑成半屏。

## 七、宿主契约没变

`thinkEffort` 仍是那个 `"" / "low" / "medium" / "high"` 的字符串，落盘键仍是 `thinkEffort`，请求仍是
`tide.ai.chat(messages, { temperature: 0.3, reasoningEffort: thinkEffort })`，文档
`public/plugins/plugin-guide/plugin-development.md` 里 `reasoningEffort` / `reasoning_effort` 的说明一字未改。
换的是**选档方式**，不是**请求链路** —— 所以本次没有数据迁移，老会话的档位照常在。

## 八、测试

`scripts/test-ai-chat.mjs` 里那条「点四下要转回自动」的循环断言已经作废（不再有循环），换成下拉栏**真跑**：
用假 DOM（只记账 `classList` / 属性 / `inert` / `focus`）去调插件真函数，走完
「展开 → 快速连点 → 换档 → 收起 → 非法档位」整条链，逐项断言 `.open`、`aria-expanded`、`aria-hidden`、
`inert` 两侧、焦点回收、落盘、选中态唯一。按钮抓取正则加了 `(?![-\w])`，否则会抓到列表里的
`data-think-lv` 选项；减少动效那条 `{0,80}` 容差放宽到 `{0,240}`（白名单后面又接了新控件，但要求的仍然是
「被列的类与 `{transition:none}` 之间不夹别的规则」）。

光块落位的时序另有一组断言：展开当帧不许同步（那会儿量到的位置是过渡中的偏移），过渡走完必须补一次，
收起不必再同步，连点只留最后一次 —— 用假 `thinkGlow` 记账 `sync` 次数来验，避免「改错了但测试照样绿」。
`test-version-release-history.mjs` 要的是 `docs/CHANGELOG-v0.204.0.md` 与 `package.json` 的版本号对得上，所以这份文件是版本校验的一部分。

---

**一句话**：两颗离输入框很远的胶囊搬到了该在的地方，思考档位从「连点四下发呆」变成一眼看全、可键盘操作、开合都带连续动画的下拉栏，选中高亮跟着走，减少动效与窄屏都没落下。
