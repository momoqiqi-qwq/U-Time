# v0.239.0 · 刷新等待蒙版只盖右界面：蒙版期间侧边栏照旧可选

> 归属说明：改动进 `le-time-management/src/waitMask.js`、`le-time-management/src/styles.css`
> 与 `le-time-management/scripts/test-wait-mask.mjs`（均在「必须升版本」的目录里），
> 界面行为调整 → minor +1：`0.238.1 → 0.239.0`。
> 校验：`sync-version.js --check` → ✓ 三端版本一致 v0.239.0；
> `npm test` → 146 个测试脚本全部通过。

## 起因

用户需求原文：

> 蒙板仅在右界面使用，不在侧边栏使用。蒙版期间，依然可以选择侧边栏的其他项目。

当时 `.wait-mask` 是 `position: fixed; inset: 0`，DOM 直接挂在 `<body>` 上 —— 它铺满**整个窗口**，
侧边栏（`.rail`）被一起蒙住；而且它 `pointer-events: auto`，所以侧栏上的项目在蒙版期间
**点不动**。插件刷新（课表拉到一半、通知还在拉）时，用户被锁在当前页，只能等。

## 判断标准（先定边界，再动手）

| 决策 | 选了什么 | 为什么不选另一条 |
|---|---|---|
| 范围怎么收 | 蒙版节点搬进 `.main`（顶栏 + 视图），`.main` 补 `position: relative` 当包含块，蒙版改 `position: absolute; inset: 0` | 保留 fixed + 挖洞（`clip-path` / `inset` 偏移量算侧栏宽度）：侧栏宽度是用户可调的（`--rail-w` / `data-nav-width`、`--ui-scale` 缩放），常量一漂就露馅；而且 fixed 层依旧在侧栏之上，`pointer-events` 还得再给侧栏开一条豁免，越改越脆 |
| 为什么不只是关掉 `pointer-events` | 关指针只能「点得动」，侧栏**仍然被蒙住看不清** —— 用户要的是「不在侧边栏使用」 | 需求是可见 + 可点两件事 |
| 窄屏底栏 | ≤900px 时 `.rail` 是 `position: fixed` 浮层（z-index 55）、几何上正压在 `.main` 上，蒙版期间给 `body.wait-mask-open .rail` 抬到 2501 | 不抬的话手机上底栏被蒙版反向盖住，`pointer-events` 再怎么样也点不到 —— 「依然可以选择」在 APK 上落不了地 |
| 抬升只在这一刻生效 | 用 `body` 上的 `wait-mask-open` 标记，蒙版撤掉就摘 | 直接把 `.rail` 的 z-index 改成 2501：弹窗/抽屉/命令面板（≥1000）与底栏的层级关系会被永久改掉 |
| 空壳位置 | `index.html` 那颗仍写在 `<body>`（首帧就在，弱机不闪半成品），首次 `show` 时搬进 `.main` | 把空壳直接写进 `index.html` 的 `.main` 里：`.main` 由 `shell.js` 运行时创建，HTML 里没有这颗容器 |

## 改了什么

**`le-time-management/src/waitMask.js`**

- 新增 `MASK_HOST_SELECTOR = ".main"` 与 `maskHost()`：优先 `.main`，拿不到（index 被改坏 / 单测无壳）退回 `document.body` —— 宁可铺满也不能不显示。
- `ensureNode()` 把节点 `append` 到 `.main`（已连接时若被挪走就拉回来）。
- 新增 `BODY_FLAG = "wait-mask-open"`：`showNow()` 挂上，`hideNow()` / `resetWaitMask()` 摘掉（淡出结束、节点真正移除那一刻才摘）。

**`le-time-management/src/styles.css`**

- `.main` 加 `position: relative`（含注释：禁止改成 transform / filter 之类，否则全站 fixed 浮层的包含块会被改掉）。
- `.wait-mask`：`position: fixed` → `absolute`，`inset: 0` 保留，z-index 2500 不变。
- ≤900px 块新增 `body.wait-mask-open .rail { z-index: 2501; }`。

**`le-time-management/scripts/test-wait-mask.mjs`**

- DOM 替身的 `append` 改成真 DOM 语义（搬走而非复制父节点），并新增 `.main` 容器；`maskEl()` 改为递归查找。
- 新增「8b」一组断言：节点必须挂 `.main`、`body` 必须带 `wait-mask-open`、撤下后两者都清干净、切换视图后 `.main` 里不残留。
- CSS 契约断言由 `position: fixed` 改为 `absolute` + `doesNotMatch fixed`，并钉住 `.main{position:relative}`、`MASK_HOST_SELECTOR`、`BODY_FLAG`、底栏抬升那条规则。

## 边界

- 启动蒙版（`loadingMask.js` / `.refresh-mask`，z-index 2600）**不动**：那一次是全屏接管首屏，此时本来也没有「侧栏可选」的语义。
- 弹层类（对话框 2400、命令面板 1900 等）不受影响：蒙版仍在它们之上，只是不再越界到侧栏。
