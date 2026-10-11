# v0.194.0 · AI 对话变成「一个真正的对话框」：去掉框里那层小框，点发送必有回音

> `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.194.0`；
> `node tools/sync-plugins.js --check` → `✓ 插件生成物与清单同源（--check 未写盘）：18 个内置插件`。
> 动的文件：桌面插件 `public/plugins/ai-chat/main.js` + `manifest.json`（插件版本 0.7.0 → **0.8.0**）、
> 重写 `scripts/test-ai-chat.mjs` 里「已收集 N 条排在输入框上面」那一段并补 4 组回归守卫、
> 根 `package.json` / `package-lock.json`（0.193.0 → **0.194.0**）、根 `docs/CHANGELOG-v0.194.0.md`。
> `sync-plugins.js` 顺带把两端 `pluginCatalog.js` 里 ai-chat 的目录版本号刷成 0.8.0。

## 用户要求原文

> 「你外面那个对话框真就纯UI啊，没有任何功能啊，还在里面弄一个小框。，请给我一个真正的对话框。」
> （附界面截图：AI 对话视图，紫色渐变大卡里嵌着一个带边框的深色小框，小框里还有一个白色输入框）

## 一、现象读法

截图里那三层不是「装饰 + 输入框」，是**三层同心框**：

| 层 | 元素 | 改前实测（视口 1180×880） |
|---|---|---|
| 外层 | `.aichat` | rect `[311,83,559,767]`，紫渐变底 + 星点纹理，除顶栏三颗按钮外**整块不可交互** |
| 中层 | `.aichat-bar` | rect `[401,679,379,112]`，`border:2px solid #887092` + 独立深底 `#272236ed` + 独立 23px 圆角 |
| 内层 | `.aichat-input` | rect `[420,697,339,38]`，**纯白 rgb(254,255,255) 实心块**（像素取证：`x422..790 y668..708` = 368×40） |

所以用户说「外面那个对话框真就纯 UI」和「里面弄一个小框」是**同一件事的两面**：他看到的大卡是壳，
真正的输入面是壳里那层小框，而小框里还套着一颗白色输入框。再加上第二件事 —— 未配置模型时
`send()` 直接 `return`，点发送、按回车都**一句话都不给**，于是「纯 UI、没有功能」这个判断就成立了。

## 二、根因：内层那颗白框不是插件画的

插件自己的 `.aichat-input` 写的是 `background:transparent`，但计算样式是纯白。原因是宿主的通用输入框规则：

```css
/* le-time-management/src/styles.css:1867 */
input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), select, textarea, … {
  background: var(--control-bg) !important;
  border-radius: 8px !important;
  …
}
```

特异性 `(0,3,1)` 且带 `!important`。**两边都带 `!important` 时比的是特异性，不是先后** ——
插件样式虽然注入在 `<head>` 末尾也压不住它。`--control-bg`（`styles.css:1715`）是
`color-mix(in srgb, var(--panel) 92%, var(--paper))`，浅色主题下就是近白 ⇒ 深紫对话框里嵌一颗白框。
深色主题另有 `styles.css:265` 把 textarea 刷成 `--panel` 实底，`styles.css:255` 还会再画一圈
`:focus-visible` 描边。

这个坑仓库里已经踩过一次并留了记录：`styles.css:2079` 的 `.market-search` 注释写着「光写 `!important` 没用，
下面这条把选择器抬到 `(0,5,1)` 才拿得回来」（v0.176.0 真机探针实测）。本次沿用同款解法。

## 三、改法

全部在 `le-time-management/public/plugins/ai-chat/main.js`：

1. **去掉第二层框**。深色段那条 `.aichat-bar` 从「带边框 + 独立底色 + 23px 圆角的小框」改成
   「只留一条顶部分隔线的输入条」：`border:0;border-radius:0;border-top:1px solid #c9acd32e;background:transparent;box-shadow:none`。
   `.aichat-bar` 这个类名与 `:focus-within` 的写法**刻意保留**（它们是 `scripts/test-ai-chat.mjs` 认的钩子，
   改名要同步改测试），长相换了、名字没换。
2. **压过宿主那条全局规则**（本次的关键修复）：
   `.aichat .aichat-bar textarea.aichat-input.aichat-input:not([type="checkbox"]):not([type="radio"]):not([type="range"])`
   —— 选择器抬到 `(0,6,1)`，`background/border-color/border-radius/box-shadow/outline` 逐条 `!important`。
   聚焦反馈改由 `.aichat-bar:focus-within` 的呼吸光承担（原本那圈描边会和呼吸光叠成两层光）。
3. **空对话不再是一片紫底**。深色段的 `.aichat-empty` 原本是 `border:0;padding:0;background:none`，
   把空态整块抹平 —— 空对话时对话框里只剩一片紫，正是用户看到的「一个空框」。改成一张有底有边的欢迎卡
   （`border:1px solid #b08fc045` + `background:#2b243ba6` + 16px 圆角）。
4. **消息流与输入区成为同一块对话面的上下两段**。新增 `.aichat-flow` 包住 `.aichat-log` + `.aichat-jump`，
   文档流变成 `顶栏 → 消息流 → 输入区 → 快捷提问`；「已收集 N 条」那句状态从输入框下面搬进顶栏
   （跟着标题走，不再在输入区下垫一条）。
   包裹层**不能叫 `.aichat-body`** —— 那个类名早被「单条消息的气泡容器」（`.aichat-row > .aichat-body`）占了，
   同名会把 `display:flex/flex-direction:column/gap:8px` 一并套到每条气泡上（本次已踩并改回 `.aichat-flow`）。
5. **发送永远有回音**（用户那句「没有任何功能」的直接解法）。`send()` 的三条早退路径各给一句话：

   | 情形 | 改前 | 改后 |
   |---|---|---|
   | 上一条还在回 | 静默 return | 提示「上一条还在回，等它说完再发」 |
   | **未配置模型** | **静默 return** | 提示「还没配模型，AI 没法回答」+ 提示条上直接挂「去配置」动作（`tide:open-settings` 的 `section:"ai"`，12 秒） |
   | 输入为空 | 静默 return | 提示「先写点什么，再按发送」并把焦点还给输入框 |

   同时 `paintBusy()` 里 `ui.send.disabled` 从 `busy || !configured` 收回 `busy` —— **未配置也置灰等于又回到
   「点了没反应」**，改成用 `.aichat-send.is-blocked` 换色提示；未配置时占位词也换成
   「还没配模型 —— 先写也行，点发送会带你去配置」。
6. 顺带：`.aichat-menu` 进减少动效白名单（它有 500ms 位移动画）；删掉浅色段那条已被深色段完全覆盖的
   `.aichat-bar` 重复定义（两份同特异性定义谁后谁赢，是「改了没反应」的经典坑）。

## 四、验证

**为什么不用技能里的 `plugin-preview.mjs`**：它对 ai-chat 只能抽到 CSS、视图为空（`hostEl.append(root)`
的子元素被假元素吞掉，且 `render` 是 async 依赖 `tide.storage`）。所以本次在 `tools/aichat-harness/`
临时搭了一套**真浏览器 + 只 stub `tide`** 的验证台：Node 静态服务器 + 真 DOM + 真插件脚本 +
按 `index.html` 顺序补齐的 12 条样式表（少一条 `theme-derived.css` 就没有任何深色调色板，
深浅截图会字节相同 —— 那是自欺），再把计算样式报告经 `postMessage` 回传到 `<pre>`，用
`chrome --headless=new --dump-dom` 抓回来。

- **双层框消失（几何）**：`.aichat-bar` 从 `border 2px rgb(136,112,146) / radius 23px / bg rgba(39,34,54,.93)`
  变成 `border-top 1px rgba(201,172,211,0.18) / radius 0 / bg transparent`；
  `.aichat-input` 在浅色与深色下均为 `bg=rgba(0,0,0,0) radius=0px border=0px shadow=none`。
- **像素铁证**：改前 `A-old-light.png` 在输入区扫出 368×40 的纯白 `rgb(254,255,255)` 实心块
  （外面还套着 400×116 的 `rgb(42,37,57)`）；改后 `B-new-light.png` / `D-new-dark.png` 里这些实心块
  全部消失，只剩紫色渐变本身的色带（同一 y 扫描线从 5 段变成 28 段、全是渐变与文字）。
  深浅各一对对照图：`CMP-light.png`（差异 15.7%）、`CMP-dark.png`（差异 15.0%）。
- **发送有回音**：未配置时点发送 → `toasts=["还没配模型，AI 没法回答"]`，点提示条上的「去配置」→
  `openedSettings={"section":"ai"}`（真的把设置面板的 AI 分区叫出来了）。
- **真网关跑通一轮**：`cfg=1&shot=turn` 走真上游 `http://127.0.0.1:8788/v1`，得到
  `me|今天该先干啥？只回一句` + `ai|先花 10 分钟回老师邮件，再交 18:00 截止的报名表。`，无错误气泡。
  （过程中先撞到一次 `这次没成功：[object Object]`，查出来是**验证台自己**的代理没带 `Authorization`
  导致 401 —— Rust 侧非 2xx 返回的是可读字符串，不是产品缺陷；补上 Bearer 后通过。）

**回归测试**：`scripts/test-ai-chat.mjs` 里原来那条「`<div class="aichat-log">` 到 `<div class="aichat-shortcuts"`
之间必须同时有 feed 与 bar 且 feed 在前」的断言**必然失败**（feed 已搬进顶栏，切片里找不到它），
本次把它重写成**对话框结构契约**并补三组守卫：

- 结构：`顶栏 → .aichat-flow → .aichat-bar → .aichat-shortcuts` 顺序必须成立；feed 必须在顶栏内、
  在 backdrop 之前；`.aichat-flow` 必须可伸缩；包裹层不许用 `.aichat-body` 这个名字。
- 长相：`.aichat-bar` 必须逐字等于「只留顶部分隔线」那条规则；压过宿主全局规则的那条选择器必须存在
  且 `background:transparent !important` / `border-radius:0 !important` / `outline:none !important` 齐全；
  `.aichat-empty` 不许回到 `border:0;padding:0;background:none`。
- 行为：三条早退路径的提示文案、`ui.send.disabled = busy`（且不许把 `!configured` 加回去）、
  `is-blocked` 换色、占位词，逐条断言。

另修正两处随本次改动失配的既有断言（减少动效白名单两条正则里补上 `.aichat-menu`）。

```
PASS: AI 对话插件 —— 权限 / 快照 / 建议写入撤销 / 一轮问答 / 历史迁移 / 会话与草稿隔离 / 思考强度 / 请求保护 / 滑动选中光
PASS: 127 个测试脚本全部通过
```

四项 `--check` 全绿：`sync-version.js --check` → v0.194.0；`gen-theme-dark.js --check` → 15 套深色变体同步；
`build-schedule-plugin.js --check`；`sync-android-native.js --check`；`sync-plugins.js --check` → 18 个内置插件同源。

## 五、影响面

- 只影响「AI 对话」这一个视图的外观与「点发送没反应」的反馈；桌面端与 Android 同源
  （`public/plugins/ai-chat/main.js` 一份代码两端跑），小程序端该插件是 `unavailable`，不受影响。
- **没有动**发送链路本身：`send → ask → tide.ai.chat → parseReply → 建议勾选落库 → 撤销` 一行未改，
  后端 `ai_chat` / `ai_vault_status` 与密钥库格式未动，**无数据迁移**。
- 改动的都是长相与早退分支：对话历史、会话列表、草稿、头像名称、思考强度档位、快照与建议逻辑全部不变。
- 其它插件不受影响；`.aichat-flow` 是新类名，不与宿主或其它插件的选择器冲突。
