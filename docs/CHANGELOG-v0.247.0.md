# v0.247.0

> 用户诉求（原话）：「看看消息获取速度还可以提升吗」
> 范围是「消息进到眼睛里的那段时间」：RSS 信息流（rss-reader 1.7.1 → 1.8.0）与
> 警大门户通知（cppu-notify 1.62.0 → 1.63.0）。两处过去都有同一个毛病 ——
> **手里已经有数据，却还在整屏等着**。本次把它们改成「先给内容，后台再刷新」。

## 改了什么

### 1. RSS：单源超时 + 并发 4 + 抓到一条就上一条

`public/plugins/rss-reader/main.js`

| 变化 | 之前 | 现在 |
|---|---|---|
| 并发 | `CONCURRENCY = 3` | `CONCURRENCY = 4`（默认四个预置源一轮抓完） |
| 单源超时 | 无，靠宿主 reqwest 的 15s 总超时 | `FEED_TIMEOUT = 12s`，自己先掐断 |
| 列表上屏 | 全部源抓完才 `paintAll()` | 每抓完一个源就增量落地（节流 `PAINT_THROTTLE = 250ms`） |
| 整屏蒙版 | 全部抓完才撤 | 第一个源回来就撤 |

单源超时的意义在于**腾并发槽**：宿主的 `shared_http_client`（`src-tauri/src/lib.rs:976-987`）
总超时 15s，一个卡死的源会占着槽整整 15 秒，后面排队的源全在等它。12 秒掐断只是让这个
worker 立刻去抓下一个，下一轮照常重试，不记成永久失败。

增量落地时**列表已经下滚过（>300px）就只更新状态条、不重画列表** —— `paintList()` 是整段
`innerHTML` 重建，重画会把用户正在读的位置拽回顶部。

### 2. 警大通知：本地缓存先上屏（stale-while-revalidate）

`public/plugins/cppu-notify/main.js`

过去 `render()` 无论有没有缓存都挂整屏蒙版，等完「恢复票据 → 验票据 → 自动登录 → 首屏列表
请求」才见内容，**二次进入同样要空等一个完整往返**。现在：

1. `loadPrefs()` 一回来先 `restoreNoticeCache()` → 有缓存就直接 `buildMain(el)` 并立刻
   `releaseWait()`；
2. 票据校验、自动登录、列表刷新在后台继续跑；
3. 数据回来只 `paintAll()` 重画内容（新的 `paintAfterLoad(el)`），不再 `buildMain` 重建整页 ——
   重建会整段替换刚渲染好的列表、把阅读位置拽回顶部还闪一帧。

缓存按账号隔离（`restoreNoticeCache()` 里比 `username`），换账号不会串台；真失败仍走原来的
缓存兜底 `showNoticeCache()` 与状态条报错。与「学生成长」v1.58.0 是同一口径。

## 验证

```bash
cd le-time-management
node scripts/test-rss-reader.mjs            # 新增：单源超时真 reject / 超时 < 15s / 增量落地三项契约
node scripts/test-cppu-autologin-warm.mjs   # 新增：缓存先上屏 + paintAfterLoad 两条源码契约
node scripts/test-cppu-speed.mjs
npm test                                    # 150 个脚本全绿
```

`test-rss-reader.mjs` 的 vm 上下文补了 `setTimeout / clearTimeout`（`withTimeout` 要用）。

## 影响面

- 只动两个插件的 `main.js` 与 `manifest.json`，不动 Rust、不动宿主 API。
- 没有数据迁移：RSS 的 storage 键与通知的 `noticeCache` 结构都没变。
- ETag / If-None-Match 条件请求没做 —— 那要改 `http_get` 三层，省的是带宽不是 RTT。
