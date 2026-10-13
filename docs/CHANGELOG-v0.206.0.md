# v0.206.0 · 代码优化：删掉一批死代码、统一日期工具、补上三处真实泄漏

> 本次改动（实测输出）：
>
> - `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.206.0`
> - `node ../tools/gen-theme-dark.js --check` → `✓ 派生调色板已同步（15 套深色变体）`
> - `node ../tools/build-schedule-plugin.js --check` → `✓ shiguang-schedule 生成物与源一致`
> - `node ../tools/sync-android-native.js --check` → `✓ Android 原生代码与版本化镜像一致`
> - `npm test` → `PASS: 129 个测试脚本全部通过`
>
> 动的文件（产品代码 14 个）：`src/shell.js`、`src/pluginHost.js`、`src/theme.js`、`src/store.js`、
> `src/taskReminder.js`、`src/searchField.js`、`src/disclaimer.js`、`src/automation.js`、`src/main.js`、
> `src/views/quadrant.js`、`src/keywordHighlights.js`、`src/webContent.js`、`src/views/settings.js`、
> `src/views/settings/appearance.js`；测试 4 个：`scripts/test-{ui-scale,keyword-highlights,web-content,store-cache}.mjs`；
> 版本：`package.json`（0.205.0 → 0.206.0，三端已同步、`package-lock.json` 两处已手改）。
> 无数据迁移、无插件 API 变更、无界面行为变更。

## 用户要求原文

> 优化代码

（未给更多限定。范围按仓库里已有的只读审计结论 `docs/audit-optimization-v0.196.0.md` 定：取其中
**有明确证据、能当场验证、不改变用户可见行为**的那一批 —— §6.10「白捡级」+ 第 2/3 批里属于 `src/` 的真实泄漏。
只有「删了就少一个功能」的项被排除，见文末第七节。）

## 一、删掉的死代码

判定标准不是「名字看起来没人用」，而是**全仓 grep（含 `scripts/`、`public/plugins/`）只命中声明处**：

| 位置 | 符号 | 判定 |
|---|---|---|
| `src/shell.js` | `movePluginBefore` | 仅声明处命中；插件排序早在 v0.103.0 就走了另一条路径，函数成孤儿 |
| `src/pluginHost.js` | `onTaskActionsChanged` + `listeners.taskActionsChanged` | 声明、注册、两处 `forEach` 全在同一文件内闭环，无外部订阅者、无插件调用 |
| `src/theme.js` | `effectiveThemeId` | 仅声明处命中（`@deprecated` 注释一并删） |
| `src/store.js` | `getSaveStatus` | 仅声明处命中；`subscribeSaveStatus` 才是活的那条 |
| `src/taskReminder.js` | `ringActive()` | 仅声明处命中（文档里的同名是 Kotlin 侧，不是这个 JS 导出） |
| `src/automation.js` | `unsub` | 仅声明处命中 |

另外两处**只去掉 `export`、常量保留**（它们是本文件内部在用的，导出没人接）：
`searchField.js` 的 `SEARCH_GLYPH`、`disclaimer.js` 的 `DISCLAIMER_UPDATED`。

> 测试专用导出一律没动：`pluginGroups.groupSegments`、`pluginPins.pinnedPluginIds`、`railActions.*`、
`uiScale.viewportHeight / __resetUiScaleForTest`、`sound.soundLabel` —— 它们「看起来没人用」是因为用户是测试脚本。

## 二、三处真实泄漏 / 重复初始化

### 1. 拖动会话的 window 监听（`src/views/settings/appearance.js`）

「界面缩放」滑杆的拖动稳定映射（v0.58.0）需要在 window 上听 `pointermove / pointerup / pointercancel`。
问题是**设置页每次重渲染都新建一张卡片，而这三个监听挂在 window 上、会活过卡片本身**。

- 修法：`pointermove` 的匿名回调提为具名 `onDragMove`，新增 `disposeDragSession()` 用**同一对函数引用**摘掉三个监听；
  卡片根元素带 `class="card set-card"`，末尾 `card._dispose = disposeDragSession;`
- 认领方：`src/views/settings.js` 的 `disposeContents(root)` 白名单原来是 `.sync-card / .ai-settings-card / .update-panel`，
  现在加进 `.set-card`，按名单 `matches?.()` + `querySelectorAll()` 遍历并调 `_dispose?.()`。

实测（直接执行 `appearance.js` 里那段真实源码，配假 window 数监听）：

```
建卡 → window 上 3 个监听        registered=3
销毁一次                          after_one=0
建/销 4 轮循环                    after_four=0
不销毁（改动前的行为）× 3 张卡     accumulated=9   ← 每次 pointermove 白跑 9 遍旧会话
```

### 2. 启动回调被调两次（`src/main.js`）

```js
// 改前：f 抛错时 .catch(f) 会把 f 再调一次 —— 初始化跑两遍（automation.js 定时器翻倍的根因）
api.appInfo().then((x) => initAutomation(x?.version || "")).catch(() => initAutomation(""));
// 改后：两参数形态，onFulfilled 抛错不再触发 onRejected，调用次数恒为 1
api.appInfo().then((x) => initAutomation(x?.version || ""), () => initAutomation(""));
```

同一处坑还有 `initLanPushGate`。实测旧写法调用 2 次、新写法 1 次。

### 3. 自动化的定时器句柄（`src/automation.js`）

`initAutomation` 里两个 `setInterval` 原来不保存句柄，重复进入就是两份定时器。现在模块级持
`minuteTimer / hourTimer`，进入先 `clearInterval` 再重设；`tide:state-changed` 监听用 `listenerBound` 幂等；
`runAutomation('startup')` 仍只跑一次。自动备份的 `createAutoBackup` + `localStorage.setItem`
补了 `try/catch`（存储写满时不再把整条启动链掀掉，只 `console.warn`）。

## 三、重复计算与每帧重算

| 项 | 改前 | 改后 | 实测依据 |
|---|---|---|---|
| 关键词正则 | `highlightSegments` 对每条规则每次调用 `new RegExp(escapeRegExp(...))`（四象限每张卡一次） | 模块级 `KEYWORD_RE_CACHE`（10 规则上限 64，满则整体清空），取用前 `re.lastIndex = 0` | 同函数只换这一行做 A/B：**15.78µs/次 → 10.86µs/次，省 31.1%**，两版分段结果逐字段一致 |
| 网页属性正则 | `webContent.attr(tag, name)` 每次 `new RegExp`，解析一页要编译几十次同一个模式 | 模块级 `ATTR_RE_CACHE`（上限 32）按 name 取 | 3000 次 `parseSiteMeta` 复用缓存正则，冷热结果一致（20.8ms） |
| 四象限卡片排期 | `taskCard` 内 `state.blocks.find(b => b.taskId === t.id)`，每张卡 O(全部 block) | `renderList` 已有首块优先的 `scheduled` Map，直接作为第二参数传进去 | 首块优先 Map 与逐卡 `find` 同解（含重复 `taskId` / 无排期任务） |
| 课程时间槽 | `courseSync` 每门课重建一次 `slotMap` | `slotMap` 提到课程循环外 | `courseTimes(slotMap, c)` 接预算好的映射 |
| 底栏让位 | `ResizeObserver` + `MutationObserver` 回调里直接同步读几何；观察 `document.documentElement` 全部属性 | 合成一帧（rAF 门闩 `scheduleDockClearance`）+ `attributeFilter: ["style"]`；首帧仍同步调一次 | 不设过滤时每次聚焦输入框写 `data-kbd` 都会触发一轮同步布局回读；Android 的 `--sat/--sab` 与界面缩放都写在 `documentElement.style`，其余偏好走已监听的 `tide:ui-preferences-changed`，不漏事件 |
| 插件市场卡片 | 同一渲染路径里重复取注册表 | 取一次 `registrySnapshot` 存局部变量复用 | 单次渲染内值不变，语义等价 |

## 四、日期工具统一到 store

`automation.js` 原本自带 `dateAdd` / `daysDiff` 两份私有实现，跨月、跨年、闰年各写各的。
现在统一到 `src/store.js`（18-51 行的日期工具区），并新增：

```js
/** 两个 `YYYY-MM-DD` 之间的整天数（后者减前者）。用本地零点构造，躲开夏令时与时刻分量。 */
export function daysBetween(fromStr, toStr) { ... }
```

调用点：`scheduleDue` → `S.daysBetween(today, t.due)`；`examReminderFromStorage` → `S.daysBetween(S.todayStr(), date)`；
`monday` / `courseSync` → `S.addDays`。

边界用例（真跑）：同一天 0 / 相邻 1 / 反向 −1 / 跨月 1 / 闰年 2 月 2 / 跨年 1 / 夏令时切换日 2；
并与旧 `daysDiff` 在三个区间上逐例比对同解。

## 五、证据（一次性脚本 `.audit/opt-evidence/run-evidence.mjs`，不进产品也不进测试套件）

原则：**不另写一套「等价实现」来对比**——那测的是我写的代码。能 import 的就真 import，
能切源码片段执行的就直接从产品文件里切出来 `new Function` 跑（拖动会话片段、`daysBetween` 都是真的产品源码）。

```
PASS  拖动会话监听不泄漏 — 建卡挂 3 → 销毁 0；4 轮循环后 0（改前同条件攒到 9）
PASS  关键词正则缓存（A/B，同函数替换取正则那一行） — 10 规则 × 3000 轮：缓存 10.86µs/次 vs 每次编译 15.78µs/次（省 31.1%，分段结果逐字段一致）
PASS  daysBetween 日期工具 — 8 个边界用例 + 与旧 daysDiff 同解（含闰年 / 跨年 / 夏令时）
PASS  启动回调不再双初始化 — 旧 .then(f).catch(f) 调用 2 次 → 新 .then(f, f) 调用 1 次
PASS  四象限预索引 — 首块优先的 Map 取值与逐卡 find 同解（含无排期 / 重复 taskId）
PASS  webContent 属性正则缓存 — 3000 次 parseSiteMeta 复用缓存正则，冷热结果一致（20.8ms）

6/6 项证据全部真跑通过
```

**新增的测试断言还做了变异验证**（改坏产品源码 → 测试必须红 → 还原后必须绿），
证明「新断言不是怎么写都绿」：

```
变异 test-ui-scale        / src/views/settings/appearance.js（把 card._dispose 改名）      => exit=1 被拦下
变异 test-keyword-highlights / src/keywordHighlights.js（改回就地 new RegExp）            => exit=1 被拦下
变异 test-web-content     / src/webContent.js（绕过属性缓存）                             => exit=1 被拦下
变异 test-store-cache     / src/main.js（改回 .then(f).catch(f)）                        => exit=1 被拦下
还原后复跑：ui-scale / keyword-highlights / web-content / store-cache 全部 exit=0
```

## 六、测试补充（4 个已有脚本，脚本总数不变仍是 129）

- `scripts/test-ui-scale.mjs`：拖动会话「挂得上也要摘得掉」——三个 `removeEventListener` 必须用与
  `addEventListener` 同一对函数引用，且 `_dispose` 要挂到卡片上、`settings.js` 的 `disposeContents` 必须认领 `.set-card`。
- `scripts/test-keyword-highlights.mjs`：正则缓存存在、命中、满则清空、`lastIndex` 归零，且
  `new RegExp(escapeRegExp(...))` 只允许出现在缓存构造函数里（别处出现就是绕过缓存）。
- `scripts/test-web-content.mjs`：`ATTR_RE_CACHE` 存在且 `webContent.js` 里只剩一处 `new RegExp(`。
- `scripts/test-store-cache.mjs`：`daysBetween` 8 个边界 + `addDays` 跨年/回二月 + `automation.js` 不许再自带
  `dateAdd/daysDiff` + `getSaveStatus` 不许回潮 + 启动回调只跑一次（判据先剥注释，免得命中解释这条坑的注释本身）。

## 七、明确没动的三项（披露）

1. **`shell.js` 的 `bindQuickDockDrag`（现约 1665 行）没删。** 审计报告把它列进「白捡级」，但它体完整、
   命名语义明确、含边界钳制与触屏判断，删掉等于**砍掉快捷面板的指针拖动能力**——那是功能回归，不是死代码清理，
   而报告只写「可能本就不可拖动」、没给证据。**待确认：快捷入口面板到底该不该能拖？** 确认不要拖，再删它并同时删掉
   `positionQuickDock` 里只为拖动保留的状态。
2. **`src/notifyStack.js` 的 `ResizeObserver` 不保存句柄。** `ResizeObserver` 对观测目标持**弱引用**，
   且该容器是应用级单例、`observed` WeakSet 又挡住了重复挂载 ⇒ 不构成真实泄漏。不为凑指标引入一个没有调用方的
   `dispose` 幽灵函数。
3. **`automation.js` 的 `snapshot()` 每条日志挂全量快照。** 这是 `undoLog` 的语义依赖（撤销要能回到当时状态），
   不是泄漏。想省字节要改的是「日志条数上限 / 快照去重」，属于数据格式变更，该单独一批做（会动迁移）。

另：`src/sound.js:240` 的 `alarmRinging` 导出在删掉 `taskReminder.ringActive()` 之后**已无调用方**，
本轮按「只删有证据的死代码、不扩大范围」没有动它 —— 记在这里，下一批一并清理。

## 八、验证命令

```bash
cd le-time-management
node ../tools/sync-version.js --check
node ../tools/gen-theme-dark.js --check
node ../tools/build-schedule-plugin.js --check
node ../tools/sync-android-native.js --check
npm test
```

> 升版本后 `sync-android-native.js --check` 会先红一次：`sync-version.js` 改了 `src-tauri/tauri.conf.json` 的 version，
> 而 `src-tauri/gen/android/app/src/main/assets/tauri.conf.json` 是它的镜像副本。跑一次不带 `--check` 的同步命令即可，别当异常。

---

**一句话**：删掉 6 个确认无调用方的导出、补上 3 处真实泄漏（拖动监听 3×N、启动回调跑两遍、定时器无句柄）、
统一日期工具、两处正则改成按关键词/属性名缓存（同一函数 A/B 实测省 31.1%）——
全部有「真跑出来的数字 + 变异验证」兜着，且用户可见行为零变化。
