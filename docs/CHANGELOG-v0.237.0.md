# v0.237.0 · 警大获奖名单：一轮同步的取数改成并发，并发数在设置里给

> 归属说明：改动进 `le-time-management/public/plugins/cppu-notify/` 与
> `le-time-management/src/views/settings/`（都属「必须升版本」的目录），
> 随 v0.236.0 之后的 v0.237.0 发布（新增功能与设置项 → minor +1）。
> 插件自身 `manifest.json` 版本 `1.56.1 → 1.57.0`（后被同目录另一批改动的 `1.58.0` 合并覆盖，
> 两条说明都在 author 串里）；`node tools/sync-plugins.js` 已重跑，桌面与小程序 pluginCatalog 均为 `1.58.0`。
> 校验：`sync-version.js --check` → ✓ 三端版本一致 v0.237.0；
> `gen-theme-dark.js --check` / `build-schedule-plugin.js --check` / `sync-android-native.js --check` → ✓；
> `npm test` → **145 个测试脚本全部通过**（新增 `scripts/test-cppu-award-pool.mjs`）。

## 起因

用户原话：

> 警大获奖名单可以并发获取通知吗，可以在设置中设置并发的数量

## 判断标准（先定边界，再动手）

| 决策 | 选了什么 | 为什么不选另一条 |
|---|---|---|
| 并发放在哪一层 | 新建插件内模块 `award-pool.js`，只放纯函数（口径 + 池子） | `main.js` 是插件入口，导出的 `render()` 之外不能写顶层 `import`（宿主用 `new Function("tide", …)` 注入），所以只能运行时 `import()`；把池子独立出去才可能单测 |
| 池子怎么实现 | 有界 worker 池：`lanes = min(并发数, 任务数)` 个 worker 抢同一个游标 `cursor++` | 不用 `Promise.all(items.map(…))` 全量并发 —— 候选正文最多 60 条、附件最多 12 份，一次全打出去门户会限流/超时；这条口径与插件 `rss-reader/main.js` 现成的并发池一致 |
| 并发数上限 | 默认 3，可选 `1 / 2 / 3 / 4 / 5 / 6 / 8`（`clampConcurrency` 兜底：非数字或 <1 回 3，超过 8 压回 8） | 不做「无上限」也不做「按 CPU 核数自动」：这是对端服务端的礼貌问题，不是本机算力问题 |
| 设置项控件 | 原生 `<select>`，放在既有「设置 → 警大获奖名单」卡里（人名榜开关下面） | 与隔壁「警大登录设置」的「失败后自动重试次数」完全同构（同一套 `setting-row` + `set-hint`）。铁律七要求双向动画的是**自建展开容器**（网盘选择 / 手风琴），原生 select 由系统绘制，不适用；数字档位在本仓库的既定先例就是 select |
| 结果怎么落位 | `out[index]` 按**输入下标**存放，不按完成顺序 `push` | 完成顺序随机，按完成顺序收会让「哪条失败、哪条有名单」错位；进度与失败归类都必须与输入一一对应 |
| 单条失败怎么办 | 记成失败继续跑，不再中断整轮；会话型错误（`awSessionError`）仍把 `sessionLost` 置真 | 并发前是「一条抛错就跳出 for」，一轮几十条时一次超时白跑一整轮 |
| 视图切走后 | `stop()` 回调返回 `!el.isConnected`，池子不再派新任务（在飞的那几条照常收尾） | 切走还继续把剩下的几十条打完，等于用户看不见地白打一堆请求 |
| 「扫过哪几份附件」的台账 | `loadAffixScanned()` 读取合流（`affixScannedLoading` 存同一个 Promise），先 `await` 到 `box` 再整体赋值 | 并发进 `markAffixScanned` 时各建一个空对象，后写完的那个会把先前的标记整份盖掉 |
| 老宿主 / 模块读不到 | `ensurePoolMod()` 里 `catch` 成 `poolMod = null`，`awConcurrency()` 返回 1，`awRun()` 退回串行 `for` | 这功能是加速，不是功能前置条件；读不到模块不许把整轮同步抛掉 |

## 改了什么

**新增 `le-time-management/public/plugins/cppu-notify/award-pool.js`**

- 口径常量：`AWARD_CONCURRENCY_KEY = "awardConcurrency"`、`AWARD_CONCURRENCY_DEFAULT = 3`、
  `AWARD_CONCURRENCY_MAX = 8`、`AWARD_CONCURRENCY_CHOICES = [1,2,3,4,5,6,8]`。
- `clampConcurrency(value, max = 8)`：非数字 / 小于 1 回默认 3，向下取整，超上限压回。
- `runPool(items, limit, worker, opts)`：有界池，`lanes` 个 worker 抢同一游标；
  `stop()` 为真时不再派新任务；任务抛错收成 `{ ok:false, error }`，返回值按输入下标落位，
  没轮到的格子是 `undefined`。

**`main.js`**

- 新增 `ensurePoolMod()` / `awConcurrency()` / `awRun(items, limit, worker, stop)` 三件套：
  动态 `import("/plugins/cppu-notify/award-pool.js")` → 从插件 storage 读 `awardConcurrency`
  → 过 `clampConcurrency` → 交给 `runPool`。
- 候选通知正文循环与附件名单循环这两段串行 `for` 都换成 `awRun`；进度文案改成按「**已读完**」计数
  （`done/batch.length`，并发时不会出现「1/60 → 60/60」那种跳），并发数 >1 时状态行右侧补「· 并发 N」。
- `loadAffixScanned()` 读取合流；视图卸载后池子停止派新任务。
- 常量区补一条并发说明注释。

**`src/views/settings/cppuAward.js` / `src/views/settings.js`**

- 新增 `AWARD_CONCURRENCY_KEY / DEFAULT / MAX`、`normalizeAwardConcurrency()` 与
  `CONCURRENCY_CHOICES`；卡片里加「读取并发数」一行（`1（逐个读取）` / `N 条同时读`），
  改动即写 `pluginState("cppu-notify").storage` + `persistSoon()`，提示「已保存，下次刷新获奖名单生效」。
- 设置分类的 hint 改「人名榜开关 / 读取并发」，keywords 追加「并发 同时读取 加速」。

**新增 `le-time-management/scripts/test-cppu-award-pool.mjs`**（`run-tests.mjs` 自动纳入，无需注册）

## 测试

7 组断言：

1. 并发数口径（默认 3 / 上限 8 / 非数字兜底）；
2. 设置页源码与插件常量**逐项一致**（正则抠出 `CONCURRENCY_CHOICES` 数组比对，两边不许各改各的）；
3. `runPool` 真跑：在飞峰值、按输入下标落位、`limit=1` 严格串行、任务少于并发、`limit=0`、`limit=99`、空列表；
4. 单条失败不打断整轮且下标不错位；
5. `stop` 只派 4 条、没轮到的格子是 `undefined`；
6. **并发确实把等待叠起来**：12 个任务各 `sleep(20)`，`limit=6` 的耗时 < 串行的 50%（不然这功能白做）；
7. `main.js` 接线静态断言（动态 import、`catch` 退化、读同一个键并过口径、`awRun` 转调 `runPool`、
   源码里不再有那条串行 `for`、两处 `}, () => !el.isConnected);`、「扫过」台账读取合流）。

> 写第 7 组踩到的仓库级陷阱：`assert.match(source, re)` 在近 300 KB 的 `main.js` 上失败时，
> 会把**整份源码**塞进错误对象打印（实测一次 dump 出 27 万+ 字符，直接把上下文打爆）。
> 该文件里统一改用只抛一句话的探针 `has(re, label)` / `hasNot(re, label)`。
> 后续在本仓库对超大源文件写断言都照这个来，不要用 `assert.match` 直接打大字符串。

## 影响面

- 只影响「获奖名单」一轮同步的**取数节奏**，不动解析口径、不动 `awardBoardCache` 的格式与版本。
- 并发数存在插件 storage 的 `awardConcurrency` 上，与「人名榜」开关同一份；不设时按默认 3 走，老数据零迁移。
- 选 1 即回到过去「逐个读取」的行为，界面与进度文案与改动前一致（不显示「· 并发 N」）。
- 门户偶发超时或限流时把并发数调小更稳；单条超时只会让它自己记一次失败，不再拖掉整轮。
