# v0.175.0 · Nephele 侧栏有自己的底色 / 插件中心去容器框 / 设置键转白 / AI 对话可设思考强度

## 改了什么

### 1. Nephele 风格下，侧栏终于有了「自己的背景色」

此前侧栏用的是 `--nephele-glass`（= `--panel` 混透明的通用玻璃底），和内容区是同一族颜色，
两块板并排看不出谁是谁。现在另起一个令牌 `--nephele-rail`（旧的 `--nephele-glass` 已无消费方，
随本次打磨一并删除，见下「发布前打磨」）：

| 模式 | 侧栏底色 | 内容区（不变） |
|---|---|---|
| 浅色 | `#e4d7f4`（薰衣草紫） | `--bg` `#ece5f4` 58% 透 |
| 深色 | `#342350`（浓紫） | `--bg` `#211b2b` 58% 透 |

侧栏以 90% 不透明度压在云雾背景上，毛玻璃模糊照旧保留 —— 观感是「一条有自己颜色的竖栏」，
而不是「又一块卡片」。`data-nav-glass="solid"` 的实色逃生口同步指到新令牌。

### 2. 插件中心（插件页）不再套容器框

插件中心此前被 `.main` 那圈 1px 描边 + 大圆角 + 阴影整个圈住，筛选钮、搜索框和工具栏按钮
全落在这个「盒子」里，读起来像一张浮在窗口上的大卡片。现在插件页把外壳那层板撤掉
（背景透明、描边透明、去阴影、去模糊），顶栏那条约 54px 的板一并撤掉，**按钮与界面连成一体**。

用的是 `:root[data-nephele-settings="on"] .main:has(> .view > .market)` —— 只认「当前视图
确实是插件中心」，四象限 / 时间线 / 任意插件页照旧保留原来的圆角卡片外壳（已实测）。

### 3. 顶栏设置键改成白色单色图标

顶栏那颗齿轮此前走 `appIcon("settings")` → 随包 PNG `public/icons/nav/settings.png`，
是 Icons8 **Color** 彩色图（主色 `#607888` / `#405860` 的青灰齿轮）。同一个工具栏里
搜索、闪电、月亮、时钟、云全是白色单色 FA 图标，**只有齿轮是彩色的**。
现在改用 `outlineAppIcon("settings")`（FontAwesome `gear`，走 `currentColor`），
与邻居同色、同粗细，且跟着 `--ink-2` / hover 的 `--deep` 自动变色，深浅色与 Nephele 下都不用特判。

### 4. AI 对话界面可以设置思考强度

AI 对话头部多了一颗胶囊：**思考强度 自动 → 低 → 中 → 高**，点一次换一档，档位直接写在按钮上，
选中的档位跟着这一轮请求走。链路是四段的，四段都接齐了：

```
插件 (reasoningEffort) → tide.ai.chat → api.aiChat → Rust ai_chat → 请求体 reasoning_effort
```

- `自动`（默认）与 `低`/`中`/`高` 之外的值，Rust 侧**只放行三档**，其余报中文错误；
- `自动` 档**一个字段都不加** —— `reasoning_effort` 是 OpenAI 兼容侧的约定字段，
  但并非所有自建网关都认它，多塞一个它不认识的键常常直接 400；
- `tide.ai.chat` 的第二个参数是可选扩展，老插件只传 `temperature` 行为逐位不变，
  `api.aiChat` 的 `temperature = 0.2` 默认值原样保留。

为什么做成「一颗按钮循环」而不是分段控件 / 下拉栏：分段控件属于铁律六（选中光要滑动），
而那个光块是宿主 `selectionGlow.js` 的 `attachSelectionGlow()`，插件侧拿不到；
下拉栏属于铁律七，且本视图的硬纪律是「不建浮层」（`test-ai-chat` 与 `test-plugin-safe-area`
都盯着）。一颗按钮循环既设置了档位，又不引入浮层、也不产生需要滑动高亮的选项组。

## 发布前打磨（同一版本内，不另起版本号）

以下四处改动与上面同属一份未发布的 v0.175.0，所以**版本号不动**，只是把这次的活干完：

- **修掉一个真实的类名撞车**：AI 对话那颗新按钮初版写成 `class="aichat-chip aichat-think"`，
  而 `.aichat-think` 是「正在思考…」三个跳动圆点的类（CSS 里 `.aichat-think i` 挂着
  `animation: aichat-dot …`）。当时没出事只是因为按钮里没有 `<i>`：白蹭了 `display` / `gap`
  而已，可哪天往按钮里放个图标就会当场冒出三个点。按钮改用 `.aichat-effort` 并补一条等价样式，
  圆点指示器继续用 `.aichat-think`。
- **删掉本次自己造出来的死令牌**：`--nephele-glass` 的两处定义（浅色 78% / 深色 74%）在侧栏
  改用 `--nephele-rail` 之后已无任何 `var()` 消费方 —— 留着比没有更容易误导，直接删，注释同步改写。
- **`styles.css` 注释与代码对齐**：设置键图标的注释写「与隔壁 `.fa-ic`（15px）同档」，实际是 16px
  （顶栏 15px 的是搜索 / 月亮，16px 的是历史 / 同步），改成按实际写；顺手删掉同处的
  `.top-settings-trigger .app-icon` 死规则 —— 该键的内容写死在 `shell.js` 的
  `outlineAppIcon("settings")` 里，不存在「插件 / 旧快照再塞彩色 PNG 进来」的路径。
- **切换提示提成常量**：`paintThink()` 每次重绘都会跑，原先在函数体里
  `THINK_LEVELS.map(...).join(...)` 拼一遍「自动 → 低 → 中 → 高」，提到模块级 `THINK_CYCLE`。

回归断言同步补齐，把上面几条钉住，改回去就判红：

- `scripts/test-ai-chat.mjs`：按钮必须是 `class="aichat-chip aichat-effort" data-think`、
  全文不许出现 `aichat-chip aichat-think`、圆点指示器仍挂 `.aichat-think`、按钮类名必须真有
  对应样式、`THINK_LEVELS.map(` 全文件只准出现在常量定义处（出现在重绘路径上就是每次重绘重拼）。
- `scripts/test-nephele-settings.mjs`：`--nephele-rail` 的浅色 / 深色取值、`.rail` 与 solid 档
  真的用 `var()` 消费它、`--nephele-glass` 不许残留；插件中心去框必须挂在
  `.main:has(> .view > .market)` 上（连 topbar 那条一起）。
- 另外**跨文件**钉住那条 `:has()` 的前提：`shell.js` 必须仍有 `renderMarket(view)` 与
  `container.replaceChildren(wrap)`。这层「`.market` 正好是 `.view` 的直接子节点」的关系样式表
  自己保证不了 —— 一旦被改成 `append` 或中间多包一层，`:has()` 会**静默失效**（选择器不报错，
  只是不再命中），界面看起来就退回「框套框」。

## 影响范围与数据迁移

- 三端一致（Windows / Web / Android）：1 / 3 在 `src/styles/` 与 `src/shell.js`，2 在
  `src/styles/nephele-settings.css`，4 跨 `public/plugins/ai-chat/` + `src/pluginHost.js` +
  `src/api.js` + `src-tauri/src/lib.rs`。
- **无数据迁移**。新增的只有一个插件级存储键 `thinkEffort`（AI 对话插件私有，
  `""` / `low` / `medium` / `high`），缺省 `""` = 自动档；老数据没有就走自动，不需要迁移。
- 1 / 2 只在 `data-nephele-settings="on"` 时命中（关掉开关逐像素回到原样）；
  另外 1 的侧栏底色只写在 `@media (min-width: 901px)` 里 —— 窄屏（≤900px）的侧栏是**底部
  导航栏**、材质由 `data-nav-glass` 那套管着，本次未动（桌面侧栏才是左侧竖栏）；
  3 是全局改动，深浅色与所有主题下都生效。
- 小程序端不共用这份 CSS、也没有 AI 配置面，本次未动。
- 插件清单版本未变（AI 对话插件只改实现，不改清单能力集）。

## 验证

- **真宿主截图比对**（`npm run dev` + 无头 Chrome + CDP，1244×993，Nephele + 深色）：
  - 插件页 `.main` 计算值由 `rgb(49,38,63)/0.58 + 1px 描边 + 阴影` 变为
    `rgba(0,0,0,0) / 透明描边 / 无阴影 / 无模糊`，18 张插件卡片照常渲染；
  - 切回「任务表」后 `.main` 的计算值**原样回到** `bg 0.58 透 + 1px 描边`
    —— 去框没有漏到别的视图；
  - 侧栏计算值 `rgb(52,35,80)/0.9`（= `#342350`），与内容区明显分层；
  - 顶栏设置键的 DOM 由 `<img class="app-icon">` 变为 `<svg class="app-outline-icon"><use href="…/solid.svg#gear">`；
  - 浅色模式另截一张：侧栏 `rgb(228,215,244)/0.9`，底部操作条无「深色断层」。
- **思考强度真跑**（`scripts/test-ai-chat.mjs` 新增一组用例）：
  档位顺序 `"" / low / medium / high`；点四下回到自动（`low,medium,high,`）且每次都落盘；
  选中 `high` 后 `tide.ai.chat` 收到的 `opts.reasoningEffort === "high"`，自动档收到 `""`；
  存进脏值 `super-high` 再重进页面会退回自动。四段链路各一条源码断言（插件 / 宿主 / api / Rust），
  外加 Rust 里「三档才落字段」「`""`/`auto` 一个字段都不加」两条。
- **浏览器实测**：AI 对话页点两下，按钮文字 `思考强度 自动 → 低 → 中`，
  刷新页面后仍停在「中」（跨重启保留），布局零抖动。
- `cargo check` 通过（`letime v0.175.0`；唯一一条 warning 是 `vault.rs` 既有的未用变量，
  与本次改动无关）。
- 三端版本一致 v0.175.0（Android `versionCode 17500`），119 个测试脚本全部通过。
- 发布前打磨后又复跑了一遍：`sync-version.js --check`、`gen-theme-dark.js --check`、
  `build-schedule-plugin.js --check`、`sync-android-native.js --check` 四项校验全过，
  `npm test` 仍 119 个脚本全绿（含上面新增的断言）。
