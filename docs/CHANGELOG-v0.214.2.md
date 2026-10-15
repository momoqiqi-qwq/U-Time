# v0.214.2 · 警大获奖名单真的会自动登录了：恢复的票据先验证、再静默续期、再退密钥库密码

> `node ../tools/sync-version.js --check` → ✓ 三端版本一致：v0.214.2
> `node ../tools/gen-theme-dark.js --check` → ✓ 派生调色板已同步（15 套深色变体）
> `node ../tools/build-schedule-plugin.js --check` → ✓ shiguang-schedule 生成物与源一致
> `node ../tools/sync-android-native.js --check` → ✓ Android 原生代码与版本化镜像一致
> `npm test` → PASS: 135 个测试脚本全部通过

动的文件：

- `public/plugins/cppu-notify/main.js` —— `awState` 增 `sessionOk`；新增 `awSessionError()` / `awProbeSession()`；
  `awEnsureSession()` 重写（带 `force`）；`awSync()` 的列表抓取改成「会话失效 → 续期/重登 → 重跑一次」，
  详情循环记 `sessionLost`，外层 `catch` 里清 `sessionOk`；`awStart()` 区分「登录态没了」与「网断了」；
  `mountAwardView()` 的「重新登录」按钮一并作废 `sessionOk`
- `public/plugins/cppu-notify/manifest.json` —— 1.48.0 → 1.49.0（author 串首条换成 1.49.0 的说明）
- `src/pluginCatalog.js` / `miniprogram/core/pluginCatalog.js` —— `node tools/sync-plugins.js` 生成物
- `scripts/test-cppu-award.mjs` —— 新增 6b 段：锁「票据必须先真验证」，并禁止旧短路写法回来
- `src-tauri/gen/android/app/src/main/assets/tauri.conf.json` —— `node ../tools/sync-android-native.js` 生成物（版本字段）
- `package.json` / `package-lock.json` —— 0.214.1 → 0.214.2（lock 两处手改）

无新增存储键、无数据迁移。凭据与缓存键（`secret` / `cookies` / `awardBoardCache` / `noticeCache`）一字未动。

## 用户要求

> 警大获奖名单的自动登录做好来

## 一、根因：自动登录这条链在获奖视图里从来没跑过

通知视图的 `autoLogin(el)`（main.js:1093）恢复票据后会用 `loadPage(1)` **真打一次接口验证**，
失败才落 `silentRenew()` → `passwordAutoLogin()`。获奖视图抄了后半段，却在第一句设了道短路：

```js
// 旧写法（v0.214.1 及以前）
async function awEnsureSession() {
  if (state.token) return true;   // ← 把整条链废掉的就是这一行
  ...
}
```

`state.token`（门户 `tp_up`）寿命只有几十分钟，而它跟着 Cookie 一起进密钥库
（`restoreCookies()` main.js:702 直接 `state.token = tokenFromText(...dump...)`，**不校验**）。
于是冷启动时：

1. `awStart()` → `awEnsureSession()` 见到那个早已过期的票据 → 立刻 `return true`；
2. `awSync()` → `awFetchList()` → 门户 302 → 只挂一条横幅「列表接口 HTTP 302，登录可能已过期」；
3. 用户只能手点「重新登录」、再手填一次验证码 —— 明明密钥库里躺着账号与密码。

`silentRenew()` / `passwordAutoLogin()` 因此成了死代码，一次都没被调用过。这是本次唯一的功能性根因。

## 二、修法：把通知视图那条链整套搬过来，并补长同步的那一半

**① 恢复的票据必须先被真验证**（`awProbeSession()` = 真打一次列表接口）：

```js
async function awProbeSession() {
  try { await awFetchList(1); return true; }
  catch (e) { if (awSessionError(e)) return false; throw e; }
}
```

链序与通知视图完全一致：`restoreCookies()` → **验证** → `silentRenew()` → **验证** → `passwordAutoLogin()`；
每次「续期后」也重新验证一次（续期成功但票据仍不认账的情况实测存在）。`awFetchList(1)`
顺手把第 1 页装进 `state.notices`（按 `RESOURCE_ID` 去重），这次请求不算白打。

**② 只有「会话不认了」才值得重走登录链。** `awSessionError(e)` 用消息正则判定
（`HTTP 30x/401/403`、`会话已过期`、`登录可能已过期`、`重新登录`、`未建立`）；断网、DNS 失败
这类传输抖动换票据也没用，原样抛给上层——分工与既有的 `explainHttpError()` 一致。

**③ `sessionOk` 是「已核验」的缓存，不是「有票据」的缓存。** 一次核验过了，同一次视图生命周期里
后续刷新直接短路，不再多打探针请求；**任何一次会话型失败都必须把它清掉**，否则下一轮刷新
只会在同一堵墙上再撞一次：

| 位置 | 清 `sessionOk` 的条件 |
|---|---|
| `awEnsureSession(force)` | 调用方明确要求重登（长同步中途失效、或用户点「重新登录」） |
| 详情循环 | 某条正文失败且 `awSessionError(e)` → `sessionLost` |
| `awSync` 外层 `catch` | 抛出的错误是会话型 |
| 「重新登录」按钮 | 无条件（用户意图优先） |

**④ 长同步中途失效要自己救回来**（这是「自动登录」的另一半）：门户通知一年几百条，
`awFetchList` 翻 4 页 + 逐条读正文要跑数十秒到几分钟，`tp_up` 完全可能恰好在这一刻死掉。
现在列表抓取失败先 `awEnsureSession(true)`（清票据 → 续期/密码兜底 → 重验证），成了就重跑当轮：

```js
try {
  await awFetchList(awState.pages, untilYear);
} catch (e) {
  if (!awSessionError(e) || !await awEnsureSession(true)) throw e;
  await awFetchList(awState.pages, untilYear);
}
```

**⑤ 断网不再把人甩到人工登录表单。** 以前 `awStart()` 里 `ok === false` 一律 `paintLogin()`，
网断时用户会看到登录表单 + 一张空验证码（那时连验证码图片都拉不到）。现在 `awEnsureSession()`
的传输层异常在 `awStart()` 被单独接住：显示已恢复的缓存 + `explainHttpError()` 的真实原因，
点状态行即可重试，**不需要重新输验证码**。只有「票据/密码两条路都试过、确实需要人输验证码」才落表单。

## 守卫

`scripts/test-cppu-award.mjs` 新增 6b 段（静态接线，与本文件既有风格一致）：

- 断言新链路的每一步都在（`awSessionError` 正则原文、探针、`force` 分支、续期后**再**验证、
  密码兜底、`sessionOk: false` 初值、三处清除点、`explainHttpError` 兜底）；
- `assert.doesNotMatch(source, /if \(state\.token\) return true;/)` —— 直接把本次根因那一行钉死，
  它一旦回来测试立刻红。
- 变异验证（实测）：把 `if (force) { awState.sessionOk = false; state.token = ""; }` 换回
  `if (state.token) return true;` → 测试红（`The input was expected to not match …`）；还原后绿。

## 已知边界（有意接受）

- 探针会多打一次第 1 页请求（票据有效时约 1 次，无效时最多 3 次：探针 → 续期后探针 → 密码登录）。
  换来的是「不用手输验证码」，这个代价划算；`sessionOk` 已经把稳态刷新时的重复探针压掉。
- 续期/密码兜底都失败时仍然落人工登录表单：验证码识别不是 100%，这条路必须留着。
- 断网时只显示缓存 + 横幅，不自动重试：没有网络时的指数退避重试是另一个话题，
  现在点一下状态行即可，与插件里其他视图的处理保持一致。
