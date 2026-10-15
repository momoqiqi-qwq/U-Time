# v0.215.0 · 侧栏颜色组整卡拖动：整组卡片直接拖，融入既有侧栏拖动系统

> `node ../tools/sync-version.js --check` → ✓ 三端版本一致：v0.215.0
> `node ../tools/gen-theme-dark.js --check` → ✓ 派生调色板已同步（15 套深色变体）
> `node ../tools/build-schedule-plugin.js --check` → ✓ shiguang-schedule 生成物与源一致
> `node ../tools/sync-android-native.js --check` → ✓ Android 原生代码与版本化镜像一致
> `npm test` → PASS: 136 个测试脚本全部通过

动的文件：

- 新增 `src/pluginSectionDrag.js` —— 整卡拖动控制器（唯一导出 `attachPluginSectionDrag(list, { onCommit, onMove })`）：
  抓手判定、跟手、让位、落点推演、松手落地与落位动画、Escape / 失焦 / pointercancel / 触屏长按 / Alt+↑↓
- `src/shell.js` —— `renderNav()` 里接线（仅桌面）；新增 `sectionPluginIds(node)` 与 `saveSectionOrder(domIds)`
- `src/styles.css` —— 新增「颜色组整卡拖动」一组规则（让位过渡、浮起卡片、抓手光标），紧随段内拖动那一组
- 新增 `scripts/test-plugin-section-drag.mjs` —— 假 DOM 真跑模块 + 自带块级布局/外边距合并模型，9 组行为用例 + 静态接线断言
- `src-tauri/Cargo.toml` / `Cargo.lock` / `tauri.conf.json`、`gen/android/.../assets/tauri.conf.json`、
  `miniprogram/core/appMeta.js` —— `sync-version.js` 与 `sync-android-native.js` 生成物
- `package.json` / `package-lock.json` —— 0.214.3 → 0.215.0（lock 两处手改）

无新增存储键、无数据迁移。顺序仍写在 `letime-data` 的 `settings.pluginOrder` 里，
置顶顺序仍在 `settings.pinnedPlugins`，两者语义与正交关系都没动。

## 用户要求

> 让侧边栏组合成的颜色组也可以被拖动，或者说，将其融入侧边栏的拖动系统中。

## 一、拖动单位升一级：从「段里的一行插件」到「整张颜色卡片」

段内拖动（v0.197.0）的拖动单位是 `.plug-seg` 里的 `button[data-plugin-id]`，而颜色组卡片
（`.plug-group[data-color]`）当时只做容器：卡片自带的 ↑/↓ 钮整组换位、右键改色，**卡片本身拖不动**。
这次把拖动单位升到卡片的上一层：

| | 拖动单位 | 抓手 | 让位同伴 |
|---|---|---|---|
| 段内（旧） | `button[data-plugin-id]` | 插件行本身 | 同段其余插件行 |
| 整卡（新） | `.plug-list > .plug-group[data-color]` | 组头整行（折叠钮 + 组名 + ↑/↓） | 其余段（含无色段） |

- 卡片**里**的插件按钮仍归段内拖动：`pointerdown` 命中 `button[data-plugin-id]` / `.plug-group-move`
  直接 return，两套互不抢（事件会冒泡到 `.plug-list`，不拦住就会「按一下，插件和整组一起动」）。
- **无色段不是拖动单位**（它没有卡片外壳，视觉上不成块），但它照常让位；要换颜色走右键。
- **置顶段（`.plug-seg-pinned`）既不拖也不让位** —— 它的顺序在 `settings.pinnedPlugins` 里，与
  `pluginOrder` 正交（取消置顶要能回原位）。落点 0 的语义因此是「紧贴置顶段下方」。
- 其余交互与段内拖动同一套：原件自己浮起（**不克隆、不挂 body**）、拖动中 DOM 一行不动、
  松手才 `insertBefore` + 140ms 落位动画；鼠标位移 ≥ 4px 起拖、触屏 240ms 长按、Escape 取消、
  Alt+↑/↓ 键盘换位、`data-motion="off"` 压住拖动期动效、减少动效跳过装饰性动画。

## 二、几何：按测量推，不按等高 / 固定空档递推

段内那套能用一个 `step = 卡片高 + 间隙` 递推，是因为**每个插件行等高**、且 `.plug-seg` 是
`display: flex` 的（间距是真 `gap`）。整卡这一层两条前提都不成立：

1. 段高各不相同（实测夹具 80 / 90 / 120 / 70）；
2. `.plug-list` 是普通块容器，**段间距来自相邻兄弟外边距合并** —— `.plug-group` 上下各 3px、
   `.plug-seg` 0、置顶段下边 6px。空档 = `max(前一段的下边距, 后一段的上边距)`，
   **会随邻居改变**：同一张卡片插在两组之间是 3px，插到置顶段下面是 6px。

做法：

**① 开拖量一次「原件离场后各段落到哪」。** 缓存各段 top/height 后，把原件临时
`card.style.display = "none"`、强制一次布局、读下所有段的新位置，再在**同一个任务里**还回去
（浏览器要等这个任务结束才绘制，中间态不会闪一帧）。摘掉原件会让内容变矮，而 `.nav` 是滚动容器
（`overflow-y: auto`）—— 贴着底部时浏览器会夹住 `scrollTop`，所以量完必须把 `scrollTop` 还回去，
否则侧栏自己跳一下。

**② 落点 `lands[slot]`**：插在 `peers[slot]` 之前 ⇒
`gone[slot] + 原件上边空档 − 摘掉后那两个邻居之间的空档`；插在最末 ⇒ `gone[last] + 段高 + 空档`。

**③ 让位 `shiftOf(st, slot, i)` 逐段算**，口径是「该段落位后的自然位置 − 它此刻的自然位置」，
而不是「跨过的段各让一截」。落位后的位置在①那一量上推：插进 slot 位后，**slot 及之后**的段
整体下移 `deltas[slot] = lands[slot] + 原件高 + 下边空档 − gone[slot]`。这样写有两个好处：

- 松手时清零位移**永远不跳**（位移的定义就是「到落位后位置的差」）；
- 连**没被跨过**、只因相邻空档合并关系变了而挪一两像素的段也一起算进去 —— 夹具里就有一个后段
  挪 3px（原件两边都是无色段时，摘掉它省下的空档不是「高 + 下边距」）。按「跨过的段各让一截」
  递推会漏掉它，松手那一下就是一跳。

**④ 界面缩放（zoom）下 1:1。** 外边距来自 `getComputedStyle`（计算值**不跟 zoom 走**），
而 `getBoundingClientRect` 已经乘过 zoom ⇒ 两者混算前必须 `× getUiScaleFactor()` 换成视口像素。
150% 下漏乘会让落点歪 1.5 视口像素，正好是「松手那一下」的一跳。

## 三、接线：松手写哪张表

```js
attachPluginSectionDrag(box, {
  onCommit: () => saveSectionOrder([...box.querySelectorAll(":scope > .plug-group, :scope > .plug-seg:not(.plug-seg-pinned)")]
    .flatMap(sectionPluginIds)),
  onMove: (card, delta) => moveNavGroup(card.dataset.color, delta),   // Alt+↑/↓ 走 ↑/↓ 那条老路
});
```

- `sectionPluginIds(node)`：**收起的分组卡片里一个成员按钮都没有**（`plugGroupNode` 的 collapsed
  分支不渲染成员段），只能从 `group._views` 取插件 —— 去 DOM 里读按钮会把整组插件漏掉，回填时
  它们原地不动、与别的插件交错，下一次重绘就跳。
- `saveSectionOrder(domIds)`：按 `saveSegmentOrder` 同一套「只回填非置顶插件占的那几个格子」写
  `settings.pluginOrder`；顺序没变就直接 return（不写库、不弹提示）；变了才 `persistSoon()` +
  `repaintMarket()` + toast。
- 整卡拖动只在桌面挂（`desktopWindow`）：手机窄屏侧栏是 `display: contents` 的横排、`.plug-list`
  整体 `display: none`，没有「上下」可言。
- CSS 与段内那组对称：`.plug-list.plug-section-drag-live > .plug-group, > .plug-seg:not(.plug-seg-pinned)`
  吃 `transform 140ms cubic-bezier(.22,.8,.22,1)`；被拖的那张 `.nav-dragging` 用 `(0,4,0)` 压掉过渡；
  浮起的卡片底色取 `color-mix(in srgb, var(--gc) 16%, var(--panel))` —— **必须不透明**，
  默认那条只掺 9% 到 `transparent`，浮起来会透出下面正在让位的卡片；左边那道组色条要留住，
  所以不能用一条 `box-shadow` 覆盖掉它。

## 守卫

`scripts/test-plugin-section-drag.mjs`（假 DOM 真跑模块）。替身自带**块级布局 + 相邻兄弟外边距
合并**模型，rect 乘 zoom、计算值不乘，所以两条硬不变量都由假布局**独立算出**，不抄模块的算术：

- ① 让位过的段：松手后的自然位置 == 它松手前的视觉位置；
- ② 原件的落位动画首帧 == 原件松手前的视觉位置 − 它松手后的自然位置。

9 组用例：往下拖两格、往上拖到置顶段下面、置顶段与无色段不是拖动单位、卡片里的插件按钮不抢、
Alt+↑/↓ 不双触发、Escape / 失焦 / pointercancel、点击与触屏长按（含滑动取消长按）、
减少动效（跳过动画但照样落地）、缩放 150%、两边都是无色段（空档合并差异 + 未被跨过的后段挪 3px）。
另有静态断言守住：不克隆 / 不挂 body、拖动中 `frame()` 里不许 `insertBefore`、`gone` 必须实测、
量完必须还 `scrollTop`、落点必须用「空档之差」、外边距必须乘缩放、置顶段不进让位集合、
shell 三处接线（`_views` / `pluginOrder` / `moveNavGroup`）与 CSS 四条规则都在。

## 变异验证（实测）

| 变异 | 结果 |
|---|---|
| `edgePx` 去掉 `* st.scale` | 150% 缩放那条落位断言立刻红 |
| 让位退回「只让跨过的段」 | ⑨ 的「E 不跳（挪 3px）」红 |
| `gone` 换成 `tops − (高 + 3)` 的递推 | 红（空档合并差异没算对） |
| `insertBefore(..., peers[slot])` 改成 `peers[st.from]` | 「松手才把 DOM 顺序落地」红 |

四条还原后全绿。

## 已知边界（有意接受）

- 整卡拖动只在桌面侧栏可用；手机窄屏的横排侧栏不挂（那里没有上下顺序，段内拖动也只在桌面挂）。
- 拖动期间组头不可点（折叠 / ↑↓ 都归拖动），松手即恢复；拖动只改 `pluginOrder`，不动
  `pinnedPlugins`，所以置顶段在拖动前后都钉在最上面。
- 卡片位置跨过置顶段需要两次操作：先把卡片拖到最上面，再取消置顶 —— 置顶段不让位是它的语义
  （否则「取消置顶回原位」就失去落点）。
- 段内拖动的 4px 起拖阈值在这里是「整卡起拖」阈值：想在卡片空白处点选/点折叠钮而不起拖，
  位移保持在 4px 以内即可（点击本身也不会改顺序）。
