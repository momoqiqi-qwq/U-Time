# v0.177.0 · 值日星图：旋转条 + 「停止」按钮 + 点名字改名

## 改了什么

三件事都在 **dorm-duty（轮换值日）插件的「宿舍床位 · 值日星图」** 里，桌面端与 APK 同源，
只动 `le-time-management/public/plugins/dorm-duty/main.js`（该插件不是生成物，直接改这里）。

### 1. 星图下面多了一条「旋转条」

- 新增 `<input type="range" data-room-turn min="0" max="360" step="1">`，排在 `.dd-room` **之后**
  （用户要的「下面」），旁边显示当前角度（`data-room-turn-val`，如 `24°`）。
- 拖动即把方位角 `state.roomView.th` 改到对应度数，星图当场跟着转（走 `roomDraw()` 原地重画，
  不重建 DOM，名字不会闪）。
- 拖动期间停掉自动旋转（`roomStopSpin()`），并且**不许每帧回写把手指顶回去**
  —— `roomSyncTurn()` 第一行就是 `if (!root || roomTurnDragging) return;`。
- 自动旋转开着时滑杆会跟着走（每帧 `roomDraw()` 末尾同步一次），所以它同时是「当前角度」的读数。
- 滑杆已填充的那一段靠 `--range-progress`：宿主 `src/styles/interactions.css:270` 那条
  `input[type="range"]::-webkit-slider-runnable-track` 读的就是这个变量，插件必须自己喂。

### 2. 新增「停止 / 继续旋转」按钮（替换原来的「自动旋转」勾选框）

- 原来只有一个勾选框：要么一直转，要么完全不动，**想停在某个角度只能等它转过去**。
- 现在星图工具栏那颗按钮在自动旋转时写「**停止**」（`class="dd-room-stop spinning"`），
  按下就把当前角度钉住、不再自动旋转；停下来之后它写「**继续旋转**」，再按一下恢复。
- 同一件事只留一个控件，所以 `data-room-spin` 从 `<input type="checkbox">` 变成了
  `<button type="button">`（`data-room-spin` 这个钩子名保留，测试与落盘字段 `roomView.spin` 都不变）。
- 按按钮要整页 `paint()`：按钮文案与滑杆的停摆状态要一起换过来。**重画不动 `th`**，
  所以「钉住的位置」就是按下的那一刻看到的位置。

### 3. 点星上的名字就能就地改名

- 星上的名字从 `<span class="dd-bed-name">` 变成一颗按钮
  `<button class="dd-bed-name" data-room-rename="<成员 id>" title="点击名字以改名">`。
- 点名字 → `promptFn()` 弹改名框（Android 侧 Tauri 的 `RustWebChromeClient` 实现了 `onJsPrompt`，
  APK 上是真能用的），规则与成员列表里那个输入框完全一致：空名 / 没变 / 取消都什么都不做。
- **点星星本身仍然是「跳到成员列表那一行」** —— 两个动作的热区必须分开。

### 🔴 为此把星点的 DOM 拆成了两层（踩坑记录）

HTML 不允许 `button` 里再嵌 `button`，而「点星跳行」与「点名字改名」是两颗不同的热区。
所以：

- 外层 `<button class="dd-bed …">` → `<div class="dd-bed …">`（**只负责定位与缩放**：
  `position:absolute` + `left/top` 百分比 + `--k` + `translate(-50%,-50%)`，与原来逐字节等价）；
- 里层新增 `<button class="dd-bed-star" data-room-bed data-room-id>`（**只负责「点星跳行」**）；
- 名字那颗按钮是外层的第二个子节点（`position:absolute` 挂在星外侧的规则一个字没改）。

⚠️ **连带修的一处真回归**：`roomDraw()` 里原本是 `el.style.left/top` 与
`el.classList.toggle("now"/"empty")` 都打在 `[data-room-bed]` 上。拆层之后这个元素变成了
**里层星点按钮**，类名再打在它身上，样式 `.dd-bed.now .dd-bed-glyph`（当班绿 + 虚线轨道）
就永远匹配不到 —— 表现是「自动旋转一转，今天当班那颗星就不绿了」。现在位置与类名一律落到
`el.closest(".dd-bed")`，`disabled` / `data-room-id` / `aria-*` 仍留在里层按钮上。

## 影响哪端

| 端 | 影响 |
|---|---|
| 桌面（Win） | 星图工具栏 + 星图下方 |
| Android / APK | 同上（插件同源；窄屏把旋转条的间距与度数宽度各让了一点） |
| 小程序 | **无影响**。小程序不画这张星图，只跟着归一化 `roomSize`（`miniprogram/core/plugins/dormDuty.js:30` 有注明），本次没动任何存储字段 |

## 数据迁移

**没有**。`roomView` 的字段仍是 `{ view, spin, th, ph, dist, beds }`，
旧数据（`spin: true` 缺 `beds` 等）由 `roomView()` 逐字段挡脏值，行为与以前一致。
`data-room-spin` 由勾选框变成按钮不影响落盘。

## 测试

`le-time-management/scripts/test-dorm-duty.mjs` 新增：

- `roomTurnDeg()` 的纯函数用例（0 / π / 2π / 负角 / `NaN` → 一律落在 0..359）；
- 旋转条必须排在星图容器**之后**、值域 0..360、旁边有度数；
- 正在旋转时按钮写「停止」并带 `spinning`，停下后写「继续旋转」；
- 每颗有人的星都要有 `data-room-rename` 与 `title="点击名字以改名"`；
- **结构断言**：星点必须是 `<button class="dd-bed-star">`，外层容器不许再是 `<button>`
  （防以后有人把两层又合回去）；
- 源码级断言：`roomTurnDragging` 期间不回写滑杆、松手落位走 `roomTurnSettleSoon()`、
  `roomDraw()` 的类名落在 `wrap`（外层）上。

顺带把插件说明（`public/plugins/plugin-guide/main.js` 的 dorm-duty 条目）改成新的说法。
