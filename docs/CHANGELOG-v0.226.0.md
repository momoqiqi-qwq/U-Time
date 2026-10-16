# v0.226.0 · 个人成长中心（pdata）的自动登录补全，并把「和警大通知互通登录状态」做实

> 本条只动 `cppu-notify` 插件、宿主站点白名单与一处宿主插件 API，不涉及数据迁移。
>
> | 门禁 | 结果 |
> |---|---|
> | `node ../tools/sync-version.js --check` | ✓ 三端版本一致：v0.226.0 |
> | `node ../tools/sync-plugins.js --check` | ✓ 17 个内置插件三端同源 |
> | `node ../tools/gen-theme-dark.js --check` | ✓ 派生调色板已同步 |
> | `node ../tools/build-schedule-plugin.js --check` | ✓ 生成物与源一致 |
> | `node ../tools/build-exam-calendar-plugin.js --check` | ✓ 生成物与源一致 |
> | `node ../tools/sync-android-native.js --check` | ✓ Android 原生与清单声明一致 |
> | `py ../tools/gen-plugin-icons.py --check` | ✓ 图标三端同源 |
> | `cargo check`（`src-tauri`） | ✓ 无新增告警（仅 `vault.rs` 一条既存未用变量） |
> | `npm test` | ✓ `PASS: 139 个测试脚本全部通过` |

## 动的文件

| 文件 | 改了什么 |
|---|---|
| `le-time-management/public/plugins/cppu-notify/main.js` | `ensurePdataAuth` 补全三条回落路径；新增 `exchangePdataToken` / `ensureLoginPrefs` / `forgetPdataAuth` / `dropPdataAuth`；`openPdataLink` 改成带会话打开 |
| `le-time-management/public/plugins/cppu-notify/manifest.json` | 1.55.2 → 1.55.3；描述补一句互通口径 |
| `le-time-management/src/pluginHost.js` | 新增 `tide.util.openPdataPage(url, sid)`（限 `cppu-notify`） |
| `le-time-management/src/api.js` | 新增 `openPdataPage(url, sid)`：只放行 `pdata.cppu.edu.cn` 的 `/stu/**` |
| `le-time-management/src-tauri/src/lib.rs` | 站点白名单加 `Pdata`；修 `webview_session_cookies` 写死学习通的 bug |
| `le-time-management/scripts/test-cppu-pdata-login.mjs` | 新增：自动登录链路、凭据来源、网页带会话打开、白名单与 Cookie 作用域 |
| `le-time-management/scripts/test-plugin-permissions.mjs` | `UTIL_PERMISSION` 登记 `openPdataPage` |
| 版本号 | `package.json` / `package-lock.json`（两处）/ `Cargo.toml` / `tauri.conf.json` / `appMeta.js` / Android `versionName`+`versionCode` → v0.226.0 |

## 用户要求

> `https://pdata.cppu.edu.cn/网页的自动登录功能做好，看看能不能跟警大通知互通登录状态，账号密码是相同的`

## 一、能不能互通：能，本来就是同一套登录

两个站点不是「各自有一套账号」，而是**同一套统一身份认证**（`sso.cppu.edu.cn`）的两个消费者：

| | 警大通知 / 教务 | 个人成长中心（pdata） |
|---|---|---|
| 统一身份认证 | `sso.cppu.edu.cn` | `sso.cppu.edu.cn`（同一个，`casPrefixUrl` 就是它） |
| 登录后拿到什么 | 会话 Cookie（`CASTGC`，勾了记住就是 5 天）+ `tp_up` 票据 | **不发 Cookie**，只发自己 SPA 用的 token |
| token 放哪 | 不适用 | 每个 `/tsa/**` 请求的 `Authentication` 头 |
| 账号密码 | vault `secret` | **同一份**（不需要再存一份） |

所以「互通」不需要任何同步协议：通知侧登过，`CASTGC` 就在密钥库里，pdata 拿它换一次票即可；反过来 pdata 换票只消费主 SSO 的票，不会动门户会话。

## 二、以前为什么不互通：链子只走了一节

`ensurePdataAuth` 原来只做 `newSession()` → 换票。三种情况下必失败：

1. **冷启动**（侧栏直接点「学生成长」或「一卡通」，没先打开通知界面）：`state.sid` 是全新空会话，`CASTGC` 不在里面 → 换不到票 → 只能提示「请先在警大通知里登录一次」。**这是最常见的路径**，因为侧栏就是给人直接点的。
2. **票据过期但 CASTGC 还在**：没有回落 `silentRenew`，白白让用户去通知界面点一次。
3. **主 SSO 也没了**：没有回落 `passwordAutoLogin`，而账号密码明明就存在密钥库里 —— 等于让用户重输一遍已知的凭据。

补全后的链路（每一步都在本插件的 native 会话里走，不受 CORS 限制）：

```
① restoreCookies()      把通知存下的会话票据灌回本会话   ← 新增，冷启动的关键
② newSession()          没有票据才新开一个空会话
③ exchangePdataToken()  主 SSO 换一次性票 → validateLogin 消费票 → token 落密钥库
④ silentRenew()         ③ 失败 ⇒ 静默续期一次，再走 ③
⑤ passwordAutoLogin()   ④ 也失败 ⇒ 用通知那份账号密码 + 验证码识别登一次，再走 ③
⑥ 都失败才提示「请先在「警大通知」里登录一次（两边共用同一份账号密码），再回到本页刷新」
```

## 三、打开网页也免登：会话交给应用内窗口

以前 `openPdataLink` 只是 `tide.util.openUrl(url)`。应用内 WebView 有**自己的 Cookie 罐**，不共享插件的 native 会话，所以裸开必然落到统一身份认证登录页。

现在走新增的宿主 API `tide.util.openPdataPage(url, sid)`：Rust 原生端把这个插件会话的 Cookie 注入窗口后再导航，窗口里的 SPA 自己跑一次 `validateLogin` 就完成免登。

**为什么不让插件把换好的票拼进 URL**：pdata 的 SPA 在初始化时会自己消费 URL 里的 `ticket` 并清掉它 —— 插件抢先消费掉，窗口里反而没票可用，只能显示未登录。所以插件只负责「把会话带到窗口」，票留给页面自己换。

## 四、顺带修掉宿主一个真 bug

`webview_session_cookies` 里判断 Cookie 来源域的那一行写死了学习通：

```rust
if !is_chaoxing_host(host) { continue; }     // 改前
if !site.allows_host(host) { continue; }     // 改后
```

后果是**非学习通站点一个 Cookie 都收不到**，调用方只会看到「插件会话中没有可传给浏览器的有效 Cookie」而看不出原因 —— v0.221.0 的「警大邮箱内置网页窗口」实际上就卡在这里（它的测试没覆盖到这条路径，所以一路是绿的）。现在改成问当前站点自己的白名单。

同时补一条：`CASTGC` 这类 Cookie 常以 `Domain=.cppu.edu.cn` 下发，根域不放行就会被 `domain_matches` 判掉、票换不出来，所以 `Pdata` 白名单含 `pdata` / `sso` 两个域与根域。

## 五、边界

- **只放行 pdata 官方页面**：`api.openPdataPage` 要求 `origin === https://pdata.cppu.edu.cn` 且 `pathname` 以 `/stu/` 开头，其余一律拒绝；插件侧 `openPdataLink` 也把绝对外链折回首页 —— 会话不能被带去别处。
- **只对 `cppu-notify` 开放**：`pluginHost` 里 `pid !== "cppu-notify"` 直接抛错，且带 `sid` 时额外要求 `http` 权限。
- **凭据仍只有一份**：pdata 没有新增任何存储 —— 账号密码还是通知那份（`storage: username` + `vault: secret`），pdata 只多存一个换来的 token（`vault: pdataToken`）。
- **门户换人或清凭据即作废**：`finishPortalTicket` 与 `clearSavedLogin` 都会让手上的 pdata token 失效，下个人不会接着用上个人的数据。
- **验证码识别不出来就退回人工登录**，不会反复重试把账号锁掉（重试次数仍受「登录重试次数」设置约束）。
- 没勾「5 天内自动登录」且密钥库里没有密码时，整条链会失败并给出明确指引 —— 这是预期行为，不是 bug。

## 版本归属

并行会话在本条工作期间已占用 v0.223.0 / v0.224.0 / v0.225.0（插件 1.55.0–1.55.2），本条让号到 **v0.226.0**，插件 1.55.2 → **1.55.3**。

## 测试

`le-time-management/scripts/test-cppu-pdata-login.mjs` 盯住四件容易悄悄退回去的事：

1. 冷启动时**恢复票据必须发生在要票之前**（断言请求日志顺序），且换票只看 `Location`、绝不消费一次性票；
2. 票据全失效但通知里存过账号密码时，必须真的走到「密码 + 验证码识别」那一步（断言请求过 `captcha.jpg`），并且账号取自 `storage: username`、密码取自 `vault: secret`；
3. 网页窗口必须带会话打开，且外链折回首页；
4. 清除凭据必须连 `vault: pdataToken` 一起清。

外加源码级接线断言：`main.js` 的三条回落路径与 `forgetPdataAuth` 钩子、`pluginHost` 的插件限定与权限、`api.js` 的 origin/path 校验、`lib.rs` 的站点白名单与 `!site.allows_host(host)` 回归。
