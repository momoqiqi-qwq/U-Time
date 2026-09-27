# 代码优化审计 · v0.109.0

> 2026-09-27 会话产物。方法：对 `le-time-management/`（src + 内置插件）做静态扫描
> （深拷贝、定时器生命周期、热路径 DOM 查询、强制同步布局），再逐处人工核上下文，
> 只实施「等价可证、测试可拦」的两项；其余记录在案，留待有真实瓶颈时再做。

## 已实施

### 1. 深拷贝 `JSON.parse(JSON.stringify(x))` → `structuredClone(x)`（16 处）

| 位置 | 路径 |
|---|---|
| 插件 API 热路径 | `src/pluginHost.js`（`listNotices` / `tasks.list` / `blocks.list` / `blocks.createSmart` 预览） |
| 删除撤销快照 | `src/store.js`（`deleteTaskUndoable` / `deleteDoneTasksUndoable`） |
| 插件任务动作入参 | `src/views/drawer.js` |
| 迁移 / 同步 | `src/migrations.js`、`src/syncLayer.js` |
| AI 自动化 / 摄取 | `src/aiAutomation.js`、`src/aiIngest.js`、`src/automation.js` |
| 数据中心 / 设置默认值 | `src/dataCenter.js`、`src/views/settings.js`、`src/views/settings/highlights.js` |
| 课表插件复制课表 | `public/plugins/shiguang-schedule/ui.js`（`main.js` 生成物已重建） |

等价性论证：这些路径的克隆对象全部来自 store 的纯 JSON 持久化数据
（无函数、无 `Date`/`Map`/`Set` 实例、无 `undefined` 值键），两种克隆输出一致；
差异只出现在 JSON 无法表达的数据类型上，而这里不存在。
运行时门槛：WebView2（ evergreen ）、Android WebView ≥98（2026 覆盖率 >99%）、Node ≥17，全部可用。

### 2. 时间线数据组装去 O(任务×时间块)

`src/views/timeViews.js` 的 `collectTimelineData`：原来在每条任务的循环里对全部
时间块 `filter(b => b.taskId === t.id)`。改为进入循环前按 `taskId` 一遍 Map 分组，
循环内 O(1) 取。行为等价（`slice().sort()` 保持「不就地改分组数组」）。

## 评估过、明确不动

| 线索 | 结论 |
|---|---|
| `getComputedStyle`（`src/views/quadrant.js`、`src/toolbarDrag.js`、`src/views/timeViews.js`） | 全部在拖拽会话启动时读一次并缓存到会话对象（`st.gap` / `st.scale`），不在 pointermove 每帧路径 —— 已是正确写法 |
| `src/ui.js` 的 `setInterval(paint, 1000)` | 是「倒计时对话框」的秒级文字刷新，只写一个 `textContent`，非页面重绘 |
| `src/taskReminder.js` 的长鸣轮询 interval | 有 `stopRing` 清理 + `maxTimer` 兜底，生命周期闭合 |
| `src/automation.js` 的分钟/小时 interval | 应用级单例心跳，有意为之 |
| 课表插件 `paint()` 全量 innerHTML | 已有 `scheduleCache`（WeakMap）快照缓存、切周动画独立层；重构成增量渲染收益不确定、回归风险大 |

## 验证

- `node --check` 三个改动核心文件 ✓
- `tools/build-schedule-plugin.js` 重建生成物 ✓、`sync-version.js --check` /
  `gen-theme-dark.js --check` / `build-schedule-plugin.js --check` /
  `sync-android-native.js --check` 全过 ✓
- `npm test`：81 个测试脚本全部通过（含 pluginHost 行为面、store 撤销、时间线渲染、
  课表插件生成物一致性守卫）✓
