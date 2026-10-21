# v0.272.7 · 启动预热真的跑起来了（APK 自动登录不再隔几天就掉）

## 改了什么（`le-time-management/public/plugins/cppu-notify/main.js`，插件 1.82.6 → 1.82.7）

- **`scheduleWarm()` 接上调用点**。v0.246.0 就写好了 `warmSession` / `scheduleWarm`，
  但**全项目没有任何地方调用它** —— 所谓「启动预热、退后 5 天登录态」的功能一次都没执行过，
  最初「放几天就要重新扫码」的问题从未被修掉。现在插件启动（`initPluginHost` 会执行全部插件）
  后 `WARM_DELAY_MS = 8000` 把 CASTGC 的使用时间推后一次。
- **放开误杀闸门**。原闸门是 `warmBusy || loginBusy || state.sid || state.viewOpen`，
  其中 `state.sid` 只要恢复过一次会话就**整个运行期不清**，等于「用过一次插件之后永久不预热」。
  现在只剩「前视图占着会话」（`state.viewOpen`）和「有登录流程在跑」两条，且内存里已有会话时
  **复用它续期**，不再另建一个会话把正在用的那个顶掉。
- **失败短退避**（新增 `WARM_RETRY_MS = 30 分钟` + 存储键 `autoWarmFailAt`）。
  原来失败什么都不记，只能等 12 小时的 `WARM_EVERY_MS`，白天断一次网就整天不再续期；
  成功才写 `autoWarmAt`，失败写 `autoWarmFailAt` 并让路给下一次前台恢复。
- **回到前台补一次**（`bindWarmOnForeground`）：APK 切到后台后 WebView 定时器会停，
  8 秒延迟常常根本没到点。现在监听 `visibilitychange`，可见时投递一次
  `document.__cppuWarmKick()`；去重靠 `state.warmAt` 的 12 小时频控，不会连发。
- **退出前清干净**：`clearSavedLogin` 同时把 `autoWarmFailAt` 归零，
  免得「退出登录 → 重新登录」之后还被上一次的退避时间挡着。

## 影响

- 仅 `cppu-notify` 插件 + 版本号；不动 Rust、不动 Android 原生、无数据迁移。
- 桌面端同样受益（预热在应用启动 8 秒后执行），但用户无感：不弹窗、不动侧栏、失败也不报错。

## 回归断言（`le-time-management/scripts/test-cppu.mjs`）

源码四条：`scheduleWarm()` 必须有调用点、必须绑 `visibilitychange`、必须有 `WARM_RETRY_MS` /
`autoWarmFailAt`、闸门里不许再出现 `state.sid`。

行为五条（把 `warmSession` 导出后真跑）：无 window 直接放弃；成功续期要写 `autoWarmAt` 并清掉
`autoWarmFailAt`，且内存无会话时才 `restore`；12 小时内频控命中**一个请求都不发**；已有内存会话
时不许 `restore` 覆盖它、失败只写退避不写成功时间；`state.viewOpen > 0` 时让路。
