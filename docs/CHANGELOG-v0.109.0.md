# CHANGELOG · v0.109.0

## 性能优化（零行为变化）

### 深拷贝统一为 structuredClone
- 宿主交给插件的数据拷贝（任务列表 / 时间块 / 消息流 / 排程预览）、删除撤销快照、
  数据迁移、插件复制课表等 16 处，从 `JSON.parse(JSON.stringify(x))` 换成
  `structuredClone(x)`：不再把数据序列化成字符串再解析回来，任务/消息上百条时
  明显更快，中间字符串与解析垃圾也不再产生（GC 压力更小）。
- 等价性：这些路径的数据全部是 store 的纯 JSON 结构（无函数 / Date / Map），
  两种克隆结果完全一致；`structuredClone` 在全部目标运行时可用
  （WebView2 / Android WebView ≥98 / Node 17+）。

### 时间线数据组装去 O(任务×时间块)
- `collectTimelineData` 原来对每条任务全表 `filter` 它的排程；改为先按 `taskId`
  一遍 Map 分组，再 O(1) 取。任务上百、时间块过千时，每次渲染时间线少扫几十万次。

### 查过、评估后不动的
- 拖拽手势里的 `getComputedStyle`（quadrant / toolbarDrag / timeViews）：
  全部在拖拽会话启动时读一次并缓存，不在每帧路径 —— 已经是对的。
- `src/ui.js` 的 `setInterval(paint, 1000)`：是倒计时对话框的文字刷新，非页面重绘。
- 课表插件 `paint()` 全量 innerHTML：已有 WeakMap 快照缓存与动画分层设计，
  收益/风险比不划算，保持。

### 影响范围
- `src/` 12 个文件的表达式级替换 + `src/views/timeViews.js` 的分组重构 +
  课程表插件 `ui.js`（生成物 `main.js` 已重建）。
- 无 API 变化、无数据迁移、无界面变化。
