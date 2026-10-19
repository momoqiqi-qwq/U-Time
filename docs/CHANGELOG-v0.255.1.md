# v0.255.1 · 修「学生成长」冷启动必报「个人成长中心暂时不可用」

## 现象

打开警大插件 →「学生成长」（pdata.cppu.edu.cn）时，主内容区只剩一张红字卡：

```
个人成长中心暂时不可用
invalid args `sid` for command `http_fetch`: invalid type: null, expected a string
校园网 / 内网代理不通时也会这样，稍后再试。
```

「刷新」「重新登录」都无效，因为这条报错与网络、与登录态都无关。

## 根因

`le-time-management/public/plugins/cppu-notify/main.js`：pdata 的 token 是**存进密钥库**的，
所以冷启动进成长中心时 `ensurePdataAuth()` 第一行

```js
if (pdataAuth.token) return pdataAuth;   // 有票就直接返回
```

就短路返回了 —— 整条链路上没有任何一处调过 `newSession()`，`state.sid` 还是 `null`。
紧接着 `pdataApi()` → `getPage()` 把 `state.sid`（null）交给 `invoke("http_fetch")`，
Rust 侧 `sid: String` 的类型检查直接拒绝，抛出上面那句英文。
通知界面不会踩到：它的 `render()` 里先 `restoreCookies()` 拿到会话才取数。

## 改了什么

- `main.js` 新增 `ensureSid()`：会话为空就建一个，**并发只建一个**
  （成长页首屏同时发 8 个接口，不能让它们各开一个会话）。
- `getPage()` 改为 `await ensureSid()` 后再取数；真拿不到会话时给一句中文，
  而不是把 `sid=null` 丢给 Rust。
- `ensurePdataAuth()` 的「有票短路」分支补 `await ensureSid()` —— 一卡通、
  「个人信息」、`openPdataLink()`（把会话交给应用内网页窗口）也走这条短路，
  少了它那几处同样拿不到会话。
- `explainHttpError()` 加一条映射：这类参数层错误不再原样上屏，
  改为「本机取数会话没建起来（sid 为空），点「刷新」重试一次；仍然这样就重启应用。」
- `manifest.json`：版本 1.67.0 → 1.67.1，`author` 前缀补本次说明。

## 影响哪端

- 桌面端与 Android 端：「学生成长 / 个人信息 / 一卡通」冷启动恢复正常；登录链路、
  Cookie 作用域、接口口径、存储键都没动。
- 小程序端不受影响。

## 数据迁移

无。

## 验证

- `le-time-management/scripts/test-cppu-pdata-login.mjs` 新增回归：
  密钥库里已有 pdata 票 + `state.sid = null`，三个接口并发取数后
  `sid` 必须是真实会话、`session` 只被调一次，且 `getPage` 里必须自己兜会话。
- `node ../tools/sync-version.js --check` → v0.255.1 三端一致
- `node ../tools/gen-theme-dark.js --check`
- `node ../tools/build-schedule-plugin.js --check`
- `node ../tools/sync-android-native.js --check`
- `node ../tools/sync-plugins.js`（manifest 版本变了）
- `npm test`
