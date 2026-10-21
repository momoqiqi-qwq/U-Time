# v0.273.1 · 右下角不再反复弹「已保存」

> 类型：bug 修复（patch）　影响端：Windows / Android 桌面壳（同一份前端）　数据迁移：无

## 用户提的问题

「老是显示已保存问题，不显示了」

## 根因

`src/views/storageStatus.js` 上一版（v0.175.1）只解决了「常驻」：成功后亮 1.6 秒再退场。
但 `persistSoon()` 的调用方不只是用户操作 —— 插件后台轮询（`cppu-notify` / `school-notice`）、
`taskReminder` 的计时脏标、自动整理、更新检查都会写快照。每写一次，
`persistence.js` 就 `pending → saving → saved` 走一遍，浮标于是按「保存频率」反复亮起，
看起来像应用一直在提示「已保存」。

**问题不在退场时长，在「谁触发」被当成了「要不要露面」的判据。** 前端拿不到可靠的操作来源
（插件写入和用户点击走的是同一条 `persistSoon`），所以只能按**状态本身的持续时间**判断。

## 改了什么

`le-time-management/src/views/storageStatus.js`

| 状态 | 行为（改后） |
|---|---|
| `saved` | 永不露面。保存成功不需要回执 |
| `pending` / `saving` | 先按住 `STUCK_MS = 1500`；到点仍停在这两个状态才算「卡住了」，露出来显示「有更改待保存 / 正在保存…」 |
| `error` | 立刻露面并常驻，`重试保存` / `导出备份` 跟着它 |

- 卡顿计时只在**同一段** pending/saving 序列里记一次（连续回执不重置），长写入不会被无限推迟。
- `saved` 与 `error` 到达时清掉计时器，避免「落盘成功后又延迟冒出来」。
- 删除 `SAVED_LINGER_MS` 与 `lastPhase`（首帧回执特判已无意义：saved 本来就不露面）。
- 卸载时连计时器一起清（`return () => { clearStuck(); unsubscribe(); }`）。

`scripts/test-storage-status.mjs` 跟着重写契约：普通写入全程不露面、写入卡住到点才露面并写完后退场、
失败立刻露面且不退场、重试成功退场；并新增一条防回退断言 —— 源码里不许再出现
`SAVED_LINGER_MS`（有它就等于「已保存」会露脸）。

## 验证

- `node scripts/test-storage-status.mjs` 通过。
- 全套：`sync-version --check` / `gen-theme-dark.js --check` / `build-schedule-plugin.js --check` /
  `sync-android-native.js --check` / `npm test`。

## 边界

- 真 · 长时间写入（大规格同步、慢盘）仍会露出来 —— 那是用户该知道的信息。
- 错误态照旧常驻，不再自动消失，必须手动重试或导出。
