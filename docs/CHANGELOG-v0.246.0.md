# v0.246.0

> 用户诉求（原话）：「自动登录优化」
> 目标是把警大门户那套「打开就该是已登录」的体验做实：不再因为隔几天没点开
> 就掉回验证码，也不再让一次登录里的无用等待挡住首屏。插件版本 1.61.0 → 1.62.0。

## 改了什么

### 1. 启动预热：把 5 天窗口往后推

门户的 `rememberMe` CASTGC 只保 5 天，而且**用一次才顺延**。过去只有打开本插件视图才碰
登录态 ⇒ 隔三天再回来，往往正好踩在过期上，必弹验证码。

现在应用启动 8 秒后在后台静默走一次 `restoreCookies → silentRenew → saveCookies`
（`main.js` 的 `warmSession()`），**12 小时频控**（storage `autoWarmAt`）。代价是每半天
2~4 个请求，换来「打开插件就是已登录」。

三道闸门，缺一不跑：

| 闸门 | 为什么 |
|---|---|
| `state.sid` 为空且 `state.viewOpen === 0` | 前台正占着会话时预热会抢 `state.sid`，两条链路各自换票必然互相踩 |
| `autoLogin !== false` 且记住了账号 | 后台登录只能用「记住密码并自动登录」这一项授权，关掉就不许偷偷登 |
| `typeof window !== "undefined"` | 测试沙箱（vm）只有 `document` 没有 `window`，不排程也就不发真请求 |

`autoLogin()` 开头会 `await` 正在进行的预热 —— 它做的正是第 ① 步，并行没有意义。
失败也照记 `autoWarmAt`：网络抖动不该让下一次启动立刻再问一遍。

### 2. 验证码「先看清再提交」

SSO 的验证码与会话绑定，一张图只能提交一次。过去 OCR 结果不管多模糊都直接 POST，
等于白烧一次尝试（自动重试上限才 2 次）。现在 `readCaptchaCode()`：置信度
（各字符相似度的最小值）低于 `CAPTCHA_MIN_CONFIDENCE = 0.34` 就**原地换一张图重认**，
最多再换 `CAPTCHA_RESHOTS = 2` 张，并且**始终提交最后那张图自己的识别结果** ——
回头用旧图必然对不上，等于手动把重试次数烧掉。

两条保留的旧行为：字符一个都认不出时不换图（换了还是空，白刷验证码）；识别结果不带
`confidence`（老宿主 / 测试桩）时按「可用」处理，不擅自换图。

### 3. 首屏少一个串行往返，票据落盘不挡渲染

偏好走 `storage`、票据走密钥库，是两条互不依赖的通道：`render()` 里并发取，
`autoLogin(el, restored)` 直接吃读好的那份。此外续期成功后的 `saveCookies()` 改成不
`await` —— 一次密钥库写不再挡在列表页前面。

### 4. 登录页补一行「上次自动登录」

`loadPrefs()` 读 storage `autoLoginAt` 到 `state.loginAt`，登录卡 `.saved` 行显示
`上次自动登录：YYYY-MM-DD HH:mm`。票据真过期时，这句话是唯一能说明「不是白记了账号」的证据。
`clearSavedLogin()` 一并清掉 `autoWarmAt` / `autoLoginAt`，免得换人后看到上一个人的登录时间。

## 测试

新增 `le-time-management/scripts/test-cppu-autologin-warm.mjs`，从 `main.js` 按标记切出
**产品里那份真代码**在 vm 里跑（不是抄一遍）：

- `readCaptchaCode`：低置信度换图并提交最后一张 / 到上限仍模糊也不回退旧图 / 无置信度字段
  不换图 / 认不出字符不换图；
- `warmSession`：无 window 不排程、视图占着会话时退让、12 小时频控、关掉自动登录或没记账号
  时不跑、成功写入 `autoLoginAt` 与 `autoWarmAt`、失败只记频控时间；
- `autoLogin`：吃并发读好的票据（不重复读密钥库）、预热未收尾先等它、预热抛错不影响前台、
  落盘永不 settle 也能返回（证明首屏没被 await 住）。

老断言只改了一处：`test-cppu.mjs` 里「先验票据再 buildMain」从整行字面量改成
`/if \(await loadPage\(1\)\) \{[^}]*buildMain\(el\); return true; \}/` —— 这支里多了
`markLoginAt()` 记账，顺序语义不变。

## 影响

- 三端版本号 0.246.0（minor：新增后台预热行为，无破坏性变更）。
- 新增 storage 键 `autoWarmAt`、`autoLoginAt`（都是纯本机偏好，不进备份、不上传）。无数据迁移。
- 旧版本读不到这两个键时行为与升级前一致（默认 0 = 立即允许预热）。
