# v0.175.1 · 右下角那块「已保存」不再常驻

## 改了什么

- 右下角一直挂着一块「已保存」，看着像「没保存成功」。根因不是保存失败，而是这块保存状态
  浮标**从启动第一帧起就是可见的**：`mountStorageStatus()` 里 `subscribeSaveStatus()` 注册时
  会**同步**先回执一次当前状态（`{ phase: "saved" }`，`src/persistence.js:45`），而
  `src/views/storageStatus.js:16` 的 `saved` 分支把它渲染成「已保存」，CSS 只把不透明度压到
  `.7`（`src/styles/storage-status.css:18`）—— **没有任何一处负责收起来**，于是它永久留在屏幕上。
- 现在改成「有话说才露面」：
  - `pending`（有更改待保存）/ `saving`（正在保存…）：立刻出现，常驻；
  - `saved`：亮 `1600ms` 回执后自己淡出 —— **但启动首帧那次回执不算「刚刚保存过」，直接不露面**；
  - `error`：常驻不退场，连同「重试保存」「导出备份」两个按钮一起留着（退场等于把按钮带走）。
- 显隐由新属性 `data-visible` 单独负责，`data-phase` 只表示语义状态。收起时
  `visibility` 等淡出（`.18s`）走完再撤，避免过渡途中还能点到按钮；展开时把
  `transition-delay` 清零，否则会先隐身再淡入。应用内「减少动效」与系统
  `prefers-reduced-motion` 只掐掉位移与淡出，**保留停留时长**（不然信息就没了）。
- **不再有单独的 `saved` 不透明度**：显隐只归 `data-visible` 管，避免两条路径互相绕过。

## 影响范围与数据迁移

- 只改 `src/views/storageStatus.js` 与 `src/styles/storage-status.css`，Windows / Web / Android
  三端同时生效（`index.html` 直接 link 这张样式表）。
- **无数据迁移**，不碰任何存储字段；`persistence.js` 的相位与 `subscribeSaveStatus` 契约一个字没动
  —— 改动全在「怎么显示」这一层。
- 小程序端不共用这套样式，未动。

## 验证

- 新增 `scripts/test-storage-status.mjs`（真跑 `src/views/storageStatus.js` + 真 `store.js`，
  迷你 DOM 替身）：启动首帧 `data-visible === "false"`；`addTask` 后立刻 `pending` + 可见；
  `saveNow()` 后 `saved` 可见，`SAVED_LINGER_MS + 300ms` 后 `=== "false"`；注入 `disk full` 后
  `error` 常驻、`重试保存` 露出，**同样等过停留时长仍可见**；重试成功再退场。
- CSS 契约断言：`[data-visible="false"]` 必须同时有 `visibility: hidden` / `opacity: 0` /
  `pointer-events: none`；基类必须是 `visibility 0s linear .18s` 的延迟写法；
  `[data-visible="true"]` 必须 `transition-delay: 0s, 0s, 0s`；`[data-phase="saved"]` **不许再出现
  `opacity`**（就是这条老写法让浮标永久留在屏幕上）；减少动效两条规则齐全。
- 变异测试（逐条注入回归，确认都被拦下）：① 删掉 `setTimeout(hide, …)` → 被「保存成功后必须自己
  退场」拦下；② 删掉「首帧不露面」那条分支 → 被「启动首帧不许露面」拦下；
  ③ 让 `error` 也走回执分支 → 被「失败态绝不能自己退场」拦下；④ CSS `visibility: hidden` 换成只写
  `opacity: 0` → 被 `[data-visible=false]` 契约断言拦下；⑤ 去掉 `transition-delay: 0s, 0s, 0s`
  → 被展开延迟断言拦下。
- 保存失败这条链路仍由既有 `scripts/verify-optimization-ui.js`（真无头浏览器）看着：注入
  `disk full` 后 `重试保存` 可见、状态文案含错误原文、点重试后回到 `saved` 且按钮收起。
- 三端版本一致 v0.175.1（Android `versionCode 17501`），120 个测试脚本全部通过。
