# v0.272.6 · 警大按钮可用性点查 + 刷新反馈

## 改了什么

- **刷新按钮有反馈了**（`public/plugins/cppu-notify/main.js`，`jwRefreshWithFeedback`）：
  按下立刻变「刷新中…」并禁用，请求回来再给一句结果 —— 数据变了「已刷新」，
  没变「已是最新，教务那边没有新数据」。工具栏「刷新」与横幅上的「点刷新重试」
  共用这一条通路，仍然是 `jwEnsureKeys(keys, true)`，没有第二套取数。
  原因：真机（尤其 APK）取一次数要好几秒，原来那几秒按钮毫无动静，
  用户会当成按钮坏了并连点，反倒把请求叠起来。
- **当前学期胶囊**去掉手型光标并加 `aria-current="true"`：点了本来就不会有动作
  （`main.js` 的 `if (term && d && term !== d.current)`），别暗示还能点。
- 触屏 `<44px` 检查：390 宽下考试 / 学分两页**没有**任何可点元素低于 44px
  （既有 `@media(max-width:600px)` 已把 `.pp-chip` 提到 44）。

## 点查工具（`le-time-management/dev/audit-cppu-buttons.mjs`，不进测试套件）

无头 Chrome 真渲染 + 逐元素点一遍，三条判据：

1. `visible` —— 有 `getClientRects`、有尺寸，且没被祖先 `overflow:hidden/clip/auto/scroll` 裁掉；
2. `reachable` —— `elementFromPoint(中心)` 命中自己或后代（没被浮层盖住）；
3. `effect` —— 点击前后 DOM 长度、`tide.*` 调用数、`examOpen`/`expandedCredit`/
   `creditHideDone`/`examFilter`/`current` 任一变化。输入框走「focus + 赋值 + dispatch input」。

`AUDIT_W=390` 切窄屏。考试 / 学分两页跑「默认 / 全展开 / 侧栏展开」三形态，
其余视图跑默认态。

## 跑出来的结论（117 个可点元素）

- **正文没有死按钮**：刷新 / 去教务 / 回通知 / 重新登录 / 学期胶囊 / 搜索框 /
  每张考试卡 / 学分三张分类卡 /「隐藏已修完」全部有反应。
- 剩下的 3 条「点了没反应」是设计如此：当前学期胶囊、本周胶囊（已经是该值）。
- `data-grade-export` 在无头环境里卡在 `canvas.toBlob`，是探针的限制：
  真机上没数据会提示「成绩还没加载好」。
- 侧栏收起后子项被 `.pp-main` 盖住 —— 探针「点所有 `[data-side-sub]`」自己造成的，
  不是产品缺陷（裁剪感知已能把这类标成「被 … 裁掉」而不是「点了没反应」）。

## 回归断言

- `scripts/test-cppu.mjs`：横幅与工具栏两条通路都必须走 `jwRefreshWithFeedback`，
  且它内部必须 `await jwEnsureKeys(keys, true)`（防止在这层偷写第二套取数）。
- `npm test` → 159 个测试脚本全部通过。

## 未做

- 没给「点了没反应」的当前值胶囊加 toast：那会在误触时刷屏，改用去掉手型 + `aria-current`。
- 其余视图（选课 / 请假 / 成绩 / 创新学分 / 自习室）的空状态按钮没做数据种子，
  只验到「接线在、点了会走同一条刷新通路」。
