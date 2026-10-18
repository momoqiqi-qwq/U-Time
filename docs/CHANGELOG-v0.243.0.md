# v0.243.0

> 三条用户诉求（原话）：「把侧边栏再左移一点，宽度可以自由拖动、拉长或拉大。」／
> 「将下面的对话框设置为圆角。」／「右边再拉长一点，顶到界面差不多位置。」
> 全部落在 AI 对画插件（`public/plugins/ai-chat`）的布局层，无逻辑改动。

## 改了什么

### 1. 对话面左右边距收窄，侧栏与消息流同时往外吃

`.aichat` 的左右内边距从 `clamp(16px,5%,64px)` 收到 `clamp(10px,1.6%,24px)`，并抽成 `--pad-x`。
上下仍是 `10px/12px`（v0.235.0 定的口径）。

- 侧栏左缘因此左移约 10~40px（视窗口宽），抽屉态 `.aichat-sidebar` 的 `left` 也改用它，
  否则抽屉会比常驻列多一块空隙。
- 右侧消息流同时右移，卡片/输入卡更贴近对话面右缘 —— 这就是用户说的「右边再拉长一点」。
- 抽屉态宽度改为 `min(360px, calc(100% - var(--pad-x) - 12px))`：左右边距变小了，
  360px 的抽屉在 390px 视口里会贴边、在更窄的屏幕里会溢出。

### 2. 侧栏宽度可自由拖动（新能力）

常驻态（`.aichat.side-docked`）第一列从写死 `260px` 改成 `var(--side-w)`，新增一条 16px 宽的
拖拽条 `.aichat-rail-resizer`（`role="separator"`）贴在列右边缝里。

- 拖动实时写 root 内联 `--side-w`，内层 `.aichat-sidebar-in` 跟着算 `calc(var(--side-w) - 24px)`，
  所以拖的过程中卡片不做文字重排（外层 `overflow-x:clip` 照旧裁切）。
- 夹取 `min(480px, max(200px, 0.55 × 容器宽))`；双击（或聚焦后按 Home）回默认 260px；
  聚焦后 `←` / `→` 每次 ±16px。
- 落盘键 `aichat-rail-w`，**只在 pointerup / 键盘改动时写一次**，pointermove 不写。
- 位移要除过「矩形宽 ÷ offsetWidth」现算的缩放比：插件的指针坐标是视觉 px、`offsetWidth`
  是布局 px，UI 缩放下不等，不除就会拖得比指针慢/快。

### 3. 输入区改成圆角输入卡

`.aichat-bar` 从「只有一条顶部分隔线」改成自带 18px 圆角 + 1px 描边 + 12%alpha 底的卡片，
左右各 12px 内边距。

- 仍是**一层**边界：里面那颗 `textarea` 继续透明、圆角归零，不会回到「框里套小框」
  （v0.193.0 修过的老毛病）。
- `box-shadow` 只在**聚焦后**（`.aichat-bar:focus-within`）出现，未聚焦时不抢视觉重量。

## 关键决策

| 决策 | 选了什么 | 为什么不选另一条 |
|---|---|---|
| 宽度落地方式 | 内联 `--side-w` 写 root，样式表只留默认 260px | 走 `data-` 属性 + 枚举档位（宿主 `.rail` 的多档路子）做不到「自由拖动」；而内联值天然压过任何档位，用户显式拖过的优先 |
| 缩放补偿 | 就地 `getBoundingClientRect().width / offsetWidth` | 读宿主 `uiScale` 需要宿主 API，插件侧拿不到；本地现算与缩放来源无关 |
| 落盘时机 | 抬起 + 键盘改动各一次 | 每帧写：拖动几十秒会往 localStorage 打上千次 |
| 落盘闸门 | `normalizeRailW()` 只存有效值，脏数据回 `null`（删键回默认） | 直接存拖动中间值：拖到 0 或负数会留下一个 200px 的"记忆"，用户以为坏了 |

## 影响哪端

Windows / Android / 小程序三端的 AI 对话插件视图（同一份 `main.js`）。无新增权限，
新增一个存储键 `aichat-rail-w`（值为数字或缺失）。

## 数据迁移

无。旧版本没写过 `aichat-rail-w`，缺失即回默认 260px。

---

## 追加：考试日历整卡可点 + 考试名红色高亮

### 改了什么

`exam-calendar` 插件两处界面调整（`public/plugins/exam-calendar/src/main.template.js`，产物 `main.js` 由
`tools/build-exam-calendar-plugin.js` 重建；插件版本 `0.4.0` → `0.5.0`）：

1. **整张卡片可点**：有官方链接的场次，点卡片任意空白处直达该场考试的官方公告 / 报名入口；
   行内按钮（考试名 → 全流程筛选、排进日程、公告/报名）用 `closest("button, a, input, select, textarea, summary")`
   挡在整卡点击之外，不会被截胡。可点行加 `.clickable`（`cursor:pointer`，悬停描边换成 `--sea`），
   并把完整 URL 写进 `title`，鼠标悬停即可看清将要去哪里。没有 `url` 的行不加任何点击行为。
2. **考试名红色高亮**：`.ecal-name` 由 `color:inherit` 改成 `color:var(--danger,#B03535)`。

### 为什么红色走 `--danger` 令牌，不是硬编码

`.ecal-name` 是正文级文字（13px / 600），红色必须在 16 套主题 × 浅深两态下都可读。
直接写 `#C8102E` 一类的固定红，在深色面板上只有 1.4~1.9:1（`--danger` 定义处那条注释记的就是这个坑）。
`--danger` 浅色是 `#B03535`，深色由 `tools/gen-theme-dark.js` 按各主题深色面板反解亮度写进
`theme-derived.css`（night 自己给亮版）—— 实测本机浅色算得 `rgb(176,53,53)`、
深色 `rgb(226,123,123)`，两边都在 AA 以上。

### 影响哪端

- **Windows / Android**（桌面壳与 App 内的考试日历视图）：整卡可点 + 红色考名都已生效。
- **微信小程序**：考试名同样改红（`.exam-title` → `var(--danger-ink)`，浅 `#C43C3C` / 深 `#E08A8A`，
  与桌面端同一口径）。**整卡点击没有跟**——小程序不能直接打开任意外链，现有「复制链接」按钮
  （`wx.setClipboardData`）是同一目的的合规做法；把整卡点击改成复制链接会与行内按钮的 tap 冒泡打架，
  且语义上更让人意外，故这一端保持原样。

无新增权限、无新增存储键、无新增数据字段。

### 数据迁移

无。只改交互与配色，`settings` / `reminded` / `events` 三个存储键的结构与口径不变。

### 验证

- 真插件 + 真 tide 桩在无头 Chrome 里跑：16 行中 10 行有官方链接、`clickable` 也是 10 行（一一对应）；
  点日期列 → `openUrl` 收到恰好 1 个该场 URL；点「排进日程」→ `openUrl` 0 次（未被截胡）；
  点考试名 → `openUrl` 0 次（仍只做全流程筛选）。
- 考试名计算色：浅色 `rgb(176,53,53)`、深色 `rgb(226,123,123)`；宽屏与真 390px 窄屏 `scrollW == clientW`，零溢出。
- `node tools/build-exam-calendar-plugin.js --check` ✓（产物与源一致），`npm run test` 的
  `test-exam-calendar` 通过。

## 插件说明文案统一简化

「插件使用说明」页与设置 › 插件里，卡片直接显示清单的 `description`，长文案（警大门户通知 1721 字、
学习通 1068 字、竞赛雷达 543 字…）会把卡片撑成一面墙，同一组里各卡高度相差数倍。

- 17 个内置插件的 `description` 全部改成用途优先的短文案，长度收敛到 **33–56 字**：
  一句话说清「这是干什么的」，再补 1–2 个关键动作（能转提醒、能导入、能跨端等），
  去掉版本演进史、CSS 实现细节与重复的能力清单。
- 单一事实源仍是各插件 `manifest.json`；已重跑 `node tools/sync-plugins.js` 同步
  `src/pluginCatalog.js` 与 `miniprogram/core/pluginCatalog.js`（`--check` 通过）。
- 保留了两条测试钉住的描述词：课程表的「彩色课程块」、学习通的
  「右键卡片（手机端长按）可给卡片上色」，功能说明不因简化丢失。
- 文案只影响展示与插件搜索的 `data-search` 文本，无权限、存储键或数据字段变化。

验证：`sync-plugins --check` ✓（17 个内置插件同源）、`sync-version --check` ✓（v0.243.0）、
`gen-theme-dark --check` ✓、`build-schedule-plugin --check` ✓、`sync-android-native --check` ✓。
