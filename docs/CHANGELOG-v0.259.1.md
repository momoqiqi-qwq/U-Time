# v0.259.1 · 警大邮箱：按真实站点链路重写自动登录

## 现象

「警大邮箱」视图只能显示「需要先登录一次警大邮箱」红卡，勾了记住密码也永远拿不到邮件；
真站点上旧链路两处都是死的。

## 根因（2026-10 实测）

- 旧实现往 `https://mail.cppu.edu.cn/coremail/index.jsp?cus=1` POST 明文 uid/password —— 该地址现在 **404**。
  这个域名早已换成网易企业邮前端，登录实际走学校中间件：
  `POST https://mailuser.cppu.edu.cn/cppu/api/login`，密码需用 `/sync/mail/pubkey` 的公钥做
  **RSA PKCS#1 v1.5（type 2）** 加密后 base64（type 1 / 明文都被判 `input.password.serverError`）。
- 登录成功后还要跟三跳才拿到 `sid`：`entryhz.qiye.163.com/entry/door`（**200 HTML**，内含
  `window.location.replace("…/redirect?l=…")`，不是 302）→ `mail.cppu.edu.cn/redirect?l=…`（302）
  → `js6/main.jsp?sid=…`。
- mbox 接口 `https://mail.cppu.edu.cn/coremail/s/json` 恒回 `FA_INVALID_SESSION`；
  能用的只有 `https://mail.cppu.edu.cn/js6/s?func=…&sid=<sid>`，且 **sid 必须写在 URL 上**，
  Cookie 再全也不行。

## 改了什么

`le-time-management/public/plugins/cppu-notify/main.js`

- 新增常量 `MAIL_MIDDLE` / `MAIL_LOGIN_API` / `MAIL_PUBKEY_API` / `MAIL_DOMAIN` / `MAIL_API`，删掉 `MAIL_JSON_API`。
- 新增 `mailRsaEscape()`（纯 BigInt 模幂，type 2 填充，128 字节密文 base64）、`mailPublicKey()`
  （接口回的是 `pubSetting={…}` 这类 jsonp 赋值，先截第一个 `{…}` 再 parse）、
  `mailMiddlewareLogin()`、`mailLandingSid()`（≤4 跳跟到带 sid 的落地页）、`mailSidFrom()`。
- `ensureMailSession(force)` 重写：20 分钟缓存 → 密钥库密码 → 中间件登录 → 换 sid；
  失败原因写进 `mailLoginError` 供界面显示。
- `mailCoremail()` 改打 `/js6/s` 且总是带 `sid`；`mailXmlTree()` 重写为 **`name` 属性感知**
  （Coremail XML 的字段名在 `name` 上，旧实现按标签名建键，`messageCount/unreadMessageCount/read`
  全被吞掉才导致「0 封未读」）。
- `mailItems()` 的发件人改为在 `cleanText` **之前**匹配 `"名字" <地址>`：`cleanText` 会把
  `<地址>` 当 HTML 标签剥掉，之后只剩一对引号。
- `mailLoad()` 改为「最多两轮，第二轮强制重登」，会话失效给的是「重登过一次仍被拒」的具体原因。
- 删掉 `mailSessionUrlFromResponse` / `mailLoginFailureText` / `verifyMailSession` /
  `defaultMailForm` / `mailApiSid` 五个旧函数。

`le-time-management/scripts/test-cppu.mjs`

- vm 上下文补 `crypto / btoa / TextEncoder / URLSearchParams / DOMParser`（自制 `MiniDOMParser`）。
- 新增真 RSA 链路用例：1024 位密钥（与站点一致，2048 位会截错模数）→ mock 公钥/登录/door/redirect
  → 两条 `/js6/s` XML，断言 `ok / 未读 73 / 总计 142 / 2 封 / from / read`，并用
  `privateDecrypt(PKCS1)` 解回密码，证明 type 2 填充没写错。
- 新增源码级禁止项：旧的 404 登录地址、`coremail/s/json`、`em[1] = 2` 必须存在。

## 影响端

- 桌面 / Android 内置插件 `警大邮箱`（cppu-notify 1.70.1）。数据格式不变，无迁移。

## 验证

- 真站点 Node 端到端：`mailLoad → { ok:true, unread:73, total:142, mails:20 }`，首封
  「欢迎您使用中国人民警察大学邮箱！」解析正确。
- `node ../tools/sync-version.js --check`、`gen-theme-dark.js --check`、
  `build-schedule-plugin.js --check`、`sync-android-native.js --check`、`npm test` 全绿。
