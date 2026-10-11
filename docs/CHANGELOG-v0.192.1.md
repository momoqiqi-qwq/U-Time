# v0.192.1 · 警大教务视图一轮刷新只判定一次登录：选课视图两个分区不再各刷一遍

> `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.192.1`；
> `node tools/sync-plugins.js --check` → `✓ 插件生成物与清单同源（--check 未写盘）：18 个内置插件`。
> 动的文件：桌面插件 `public/plugins/cppu-notify/main.js` + `manifest.json`（插件版本 1.39.0 → **1.40.0**）、
> 新增回归测试 `scripts/test-cppu-jw-login-once.mjs`、根 `docs/CHANGELOG-v0.192.1.md`。
> `sync-plugins.js` 顺带把两端 `pluginCatalog.js` 的目录版本号刷成 1.40.0。

## 用户要求原文

> 「检测到如图，登录失败后自动刷新两次。」（附界面截图：选课视图里「可参加的选课任务」与「已选课程」
> 两个分区各挂一条同样的「登录失败，正在显示缓存（更新于 09/22 13:21）」横幅）

## 一、现象读法

截图里两条横幅**文字、缓存时间戳完全一致**，说明不是「刷了两次页面」，而是**同一轮刷新里登录被判定/执行了两遍**，
两个分区各自撞了一次墙、各自留了一条横幅。所以「自动刷新两次」要修的不是刷新频率，是**登录轮次**。

## 二、根因：串行 for 循环吃不到并发合流

`jwEnsureKeys(keys, force)` 对视图的 `keys` 是**串行** `for` 循环，而每个 key 的 `jeLoad()` 第一句都是
`if (!await ensureJwLogin()) throw ...`；`ensureJwLogin()` 里的 `jwBootPromise` **只合流「并发」**
（settle 后立刻清空，注释写得很清楚：「点『刷新』时该再试一次，别拿着上次的 false 一直不回本」）。
于是串行的后一个 key 拿不到合流，**登录态失效时会连着跑 N 轮完整登录**：

| 视图 | keys | 一轮刷新的登录轮次（修前） |
|---|---|---|
| 警大选课 `cppu-xk` | `xkTask` + `xkResult` | 2（截图里就是这两条） |
| 我的请假 `cppu-qj` | `qjRecord` + `qjCourse` | 2 |
| 警大成绩 `cppu-credit` | `grade` | 1（所以只有多分区视图会「刷两次」） |

每轮登录内部还按设置里的「失败后自动重试次数」（默认 2）重试，即**每轮最多 3 次带验证码识别的 POST** ——
一次进视图白刷两轮，等于 6 次。排除项：教务视图**没有任何定时器**（`setInterval` 只在通知视图的
「自动刷新」里），全仓库也没有教务路径上的 `location.reload()`，监听器也不会重复挂（宿主每次 commit 都
`view.replaceChildren()` 换新节点）。

## 三、改法：登录轮次收进一轮刷新

三处改动，都在 `public/plugins/cppu-notify/main.js`：

1. **新增轮次状态**：`let jwRound = 0`（每轮刷新自增）+ `let jwRoundLoginFailed = -1`（本轮登录已判定失败）。
2. **`ensureJwLogin()` 只记忆「失败」**：`if (jwRoundLoginFailed === jwRound) return Promise.resolve(false);`
   放在 `jwLive()` 短路之后、`jwBootPromise` 合流之前；启动登录时捕获 `const round = jwRound`，
   把 `p.then(clear, clear)` 改成 `p.then(() => settle(true), () => settle(false))`，`settle(ok)` 里
   `if (!ok) jwRoundLoginFailed = round;` 再执行原来的 clear。
   **刻意不记忆「成功」**：记住成功会把 `jeLoad()` 里 `ensureJwSession(true) || ensureJwLogin(true)` 那条
   兜底恢复路径短路掉，登录态中途失效时错误会退化成「教务数据解析失败（HTTP 302）」而不是让人去重新登录。
3. **`jwEnsureKeys()` 开头做统一登录闸门**：`jwRound++` 作废上一轮结论，然后
   `if (!await ensureJwLogin(force)) { 给每个 key 写同一条原因；jwPaint(); return; }`。
   闸门放在 `loadJwTerm(force)` **之前**，这样 `loadJwTerm()` 内部那次 `ensureJwLogin()` 会被 `jwLive()`
   直接短路，不会再多跑一轮；判定失败就当场收工 —— 这一轮所有 key 都是同一个原因，没必要逐个再撞一次。
   失败文案取 `loginHint?.msg`（例如「验证码未识别，请手动填写；请核对账号和验证码后重试」），
   没有 hint 时退回原来的「警大统一身份认证未建立：请在下方完成登录后重试」。

保留不动：`!force && jwBootPromise` 的并发合流语义、`loginRetries` 设置默认值（用户可见设置，属预期行为）。
「点『刷新』该再试一次」也保住了 —— `jwEnsureKeys(keys, true)` 会 `jwRound++`，新一轮重新判定。

## 四、验证

新增 `le-time-management/scripts/test-cppu-jw-login-once.mjs`（真跑源码，不是正则匹配）：用 `vm` 把插件跑起来，
把 `tide.http` 桩成「登录页/验证码放行、其余一律 302 且不带 Location」，`Image.decode()` 必抛（复现登录失败），
学期先塞进 `jwState.term`（复现「正在显示缓存」的真实场景），然后观测两个指标：

- **登录轮次** = 密钥库读取次数（`ensureJwLogin()` 的异步体第一句就是 `loadPrefs()`，而 `loadPrefs()` 只在
  `autoLogin` 打开时读一次密钥库，全程只在这一处发生）；
- **验证码张数** = 一轮登录 = 首次尝试 + 耗尽后重建人工表单，各取一张。

```
PASS: CPPU jw views judge the login once per refresh instead of once per key
```

断言：一轮 `jwEnsureKeys(["xkTask","xkResult"])` → 登录轮次 **1**、验证码 **2**、两个 key 的错误文案**相等**、
登录没建立时两个 key 的 `data` 都是 `null`；再点一次「刷新」→ 登录轮次 **2**（新的一轮该重新判定）。

并带**变异测试**证明断言真的在测这件事：把统一登录闸门与失败记忆拿掉（`if (false)` + 删掉 memo + 删掉
`jwRound++`）后必须变红 —— 未修复时登录轮次 **2**、验证码 **4**，正是用户看到的「自动刷新两次」。

**全量**：`npm test` → 127 个脚本全部通过（含本条 CHANGELOG 一起，`test-release-history.mjs` 校验
「新版本记录必须位于首条」）。

## 五、影响面

- 只有多分区教务视图（选课、请假）受影响；成绩、创新学分、校历等单 key 视图行为不变。
- 登录成功时行为完全不变：`jwLive()` 短路在 memo 之前，成功路径不经过新逻辑。
- 登录失败时**网络开销减半**（N 轮 → 1 轮），学校侧登录频次不再被自己推高；两个分区仍各留一条横幅，
  与修前视觉一致，只是不再白刷。
- 手动「重新登录」、工具栏「刷新」、横幅整条可点这三条入口语义不变。
