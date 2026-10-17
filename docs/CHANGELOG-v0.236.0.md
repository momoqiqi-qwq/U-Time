# v0.236.0 · 警大门户：学生成长 / 个人信息的取数不再每次从零重打

> 归属说明：改动进 `le-time-management/public/plugins/cppu-notify/`（属「必须升版本」的目录），
> 随 v0.235.0 之后的 v0.236.0 记录（性能与交互调整 → minor +1）。
> 插件自身 `manifest.json` 版本 `1.57.0 → 1.58.0`（`node tools/sync-plugins.js` 已重跑。
> 同目录另一批改动（获奖名单并发读）也在同一个插件的 author 串里，两条说明并存）。
> 注：本机工作树随后被 `v0.237.0`（获奖名单并发 + 设置项）接手，`package.json` 现为 `0.237.0`，
> 本条改动随 v0.237.0 一并构建发布（本轮没有再单独出 `v0.236.0` 产物）。
> 校验：`sync-version.js --check` → ✓ 三端版本一致 v0.237.0；
> `gen-theme-dark.js --check` / `build-schedule-plugin.js --check` / `sync-android-native.js --check` → ✓；
> `npm test` → **145 个测试脚本全部通过**（新增 `scripts/test-cppu-speed.mjs`）。

## 起因

用户原话：

> 优化学生成长和个人信息的获取速度

## 先量清楚「慢」在哪

| 观察 | 事实 | 结论 |
|---|---|---|
| 每次进页面都转圈 | `mountGrowthView` 缓存了视图实例，但每次进入都再调一次 `render(host)` → 每次都重跑 `loadAllInner()` 的全部请求 | 缓存视图实例**没有**缓存数据 |
| 成长页一轮几个请求 | 8 个 pdata 接口（personInfo / learnSituation / getKpiList / cardConsume / onlineState / getMyAttendance / bonusPenaltyList / getModuleList） | 并发已经做到了（`Promise.all`），但**首屏等于等最慢的那一个** |
| 个人信息页 | 只 1 个接口（personInfo），但同样每次重打 | 档案字段在一节课里不会变，重打纯浪费 |
| 两个页面都要 personInfo | 侧栏来回切时各打一份 | 缺一层跨视图的去重 |
| 蒙版 | `waitMask` 无条件起（`state.loadedAt` 已存在也起） | 手里有数据时盖整屏蒙版是纯损失 |
| 是不是每个请求都重新握手 | Rust 侧 `HttpSession` 自带 `reqwest::Client`，`pool_idle_timeout 90s` / `pool_max_idle_per_host 8`，会话按 sid 复用 | **连接池与 TLS 会话本来就在复用**，不需要改 Rust；瓶颈不在握手 |

## 判断标准（先定边界，再动手）

| 决策 | 选了什么 | 为什么不选另一条 |
|---|---|---|
| 缓存放哪 | 主进程新增 `pdataCached()`，做成 `pdataApi` 的**包装层**，`growthBridge` 换到它上面 | 塞进 `pdataApi` 内部会让 `test-cppu-pdata-login` 的「同一个 path 第二次必须重新问服务端」变成假绿（那条用例就是靠第二次拿到失败结论验证续期链的）；而且 `pdataApi` 的 URL 口径被 `test-cppu.mjs:828` 钉着，不该动 |
| 缓存多久 | 成长 KPI / 消费 / 上网 / 考勤 / 奖惩 60 秒；`personInfo` 与 `getModuleList` 10 分钟（`PDATA_TTL_STATIC`） | 一律 60 秒会让「进档案页」这种几乎不变的数据也反复打；一律 10 分钟会让考勤/奖惩这类会变的数据变旧 |
| 哪些响应能进缓存 | **只有 `ok === true`** | 缓存失败响应 ⇒ 一次网络抖动被记住一整个 TTL，用户点几次刷新都是「读不到」，比不快更糟 |
| `?t=` 时间戳怎么办 | 归一化缓存键时剔掉 `t` / `_t` / `_`（调用方本来是用它防缓存的） | 不剔掉的话 `getModuleList?t=…` 每次都是新键，缓存形同不存在 |
| 票据换人 | `dropPdataAuth()` / `forgetPdataAuth()` 里 `dropPdataCache()` 整层作废 | 缓存里那份可能属于上一个身份 —— 换账号后看到别人的档案是事故，不是「快」 |
| 「刷新」按钮 | 走 `bridge.force(path)`，真的绕开主进程那份缓存 | 只绕视图那一层会让用户按了刷新还是旧数据（主进程缓存还在命中） |
| 首屏怎么放 | 成长页分两批落画面：身份卡 / 学业概览 / 成长指标先画（`HEAD_FIELDS`），其余五块到了再补一版（`TAIL_FIELDS`）；两组请求**同时发出**，只是分两批落 | 串行发两组会把 8 个请求的总时长拉长；一次性画又退回首屏等最慢接口 |
| 补数期间的空列表 | `state.partial` 为真时那几块显示「正在读取…」 | 不这么做，用户会先看到一句「暂无出勤记录」再被改掉 —— 比转圈更容易误解成后台没数据 |
| 重进窗口 | 视图侧 `FRESH_MS = 60s`：TTL 内重进连 bridge 都不问，直接画上次那份 | 每次都问 bridge 虽然会被主进程缓存接住，但多一层等待、且拿不到「零网络」这个确定性 |
| 有数据还打蒙版吗 | 不打（`state.loadedAt ? () => {} : waitMask(...)`）；过期则先画旧数据再后台静默刷新 | 蒙版是给「什么都没有」的首次进入用的；手里有 1 秒旧数据好过 1 秒白屏 |
| 校验怎么证 | 新增 `scripts/test-cppu-speed.mjs`：主进程用 vm 数 fetch 次数（命中去重 / force / 失败不缓存 / 键归一 / 票据作废），视图层真 `import growth.js` 配延迟 resolve 的 bridge 断言「三块落地时页面里没有『暂无』」 | 只做静态断言证明不了「首屏真的先画」；只做逻辑断言证明不了「缓存真的挂在 pdataApi 外面」 |

## 改了什么

### 主进程（`public/plugins/cppu-notify/main.js`）

| 位置 | 改动 |
|---|---|
| `PDATA_VAULT_KEY` 之后 | 新增 `PDATA_TTL`（60s）、`PDATA_TTL_STATIC`（10min）、`PDATA_STATIC_RE = /getModuleList\|personInfo/`、`pdataCache` / `pdataPending` 两个 Map、`pdataCacheKey()`（剔 `t` / `_t` / `_` 并清掉残留的 `?&` 与尾部分隔符）、`pdataCacheTtl()`、`dropPdataCache()` |
| `pdataApi` 之后 | 新增 `pdataCached(path, force)`：命中即返回、同一 key 在飞就复用同一个 Promise（并发去重）、只把 `ok` 的响应写进缓存 |
| `dropPdataAuth()` / `forgetPdataAuth()` | 各加一行 `dropPdataCache()` |
| `growthBridge` | `api` 改走 `pdataCached`，新增 `force` 通道；注释里写明「刷新要连主进程缓存一起绕」 |

### 视图层（`growth.js` / `profile.js`）

| 位置 | 改动 |
|---|---|
| `call()` | 收 `force` 参数，有 `bridge.force` 就走它（老宿主没有时退回普通取数） |
| `loadAll(force)` | ① `force` 绕缓存；② `FRESH_MS` 内重进直接 `paint()` 返回；③ `state.loadedAt` 已存在就不再起蒙版 |
| `loadAllInner(force)` | `HEAD_FIELDS` / `TAIL_FIELDS` 两组，`applyResults(fields, rs)` 共用同一段落盘映射；首屏三块落地即 `state.loadedAt = Date.now()` + `paint()`，其余五块落地后再算 `state.stale` / `state.kpiPage` 并补画 |
| `state.partial` | 补数期间为真：`flowHtml` 的空态、`recordHtml` 的两个 block 显示「正在读取…」，不给「暂无」 |
| `bind()` | `[data-pg-refresh]` / `[data-pf-refresh]` 改 `loadAll(true)`；重新登录成功后也改 `loadAll(true)`（换票后那份数据属于新身份） |

## 测试

新增 `le-time-management/scripts/test-cppu-speed.mjs`（两节）：

- **主进程（vm 数 fetch）**：键归一（`?t=` / `_t=` / `_=` 三种写法归到同一个键）、TTL 分级、命中去重（直接取数与走 bridge 共用一份）、`force` 真的重取、`?t=` 变化不产生新请求、**并发去重**（同一 key 两个调用只发一次请求，两个调用方拿到同一结果）、**失败不缓存**（失败码 5001 连问两次 = 两次请求）、**票据换人作废**（`dropPdataAuth` 后再问必须重新请求、`forgetPdataAuth` 后缓存为空）；另有一条静态断言钉住「缓存不许写进 `pdataApi` 函数体」并保留 `const url = PDATA + path;` 与「不带 `_USER`」。
- **视图层（真 `import growth.js` + 延迟 resolve 的 bridge）**：8 个请求仍然并发发出；只 resolve 首屏三块时页面里已经有身份卡与「更新于 …」、有四块位置写着「正在读取…」、**且没有任何「暂无…」**；五块到齐后数据补进画面、空列表才说「暂无出勤记录」、也不再出现「正在读取…」；再次 `render()` 时 **bridge 调用次数不变**（TTL 内零网络）且能立刻画出上次那份；静态钉住两个视图的 `loadAll(force)`、`FRESH_MS`、蒙版条件、刷新与重登走 `force`。

保留的既有硬约束（未动）：`pdataApi` 的函数体与 `const url = PDATA + path;`、`test-cppu-pdata-login.mjs` 的 exported 注入串与三条断言、`test-cppu.mjs` 的 900 字符切片断言、`test-wait-mask.mjs` 的「`growth.js` / `profile.js` 必须出现 `waitMask(`」、`test-cppu-card-charts.mjs` 的 `module.createCardCharts(tide, growthBridge)`。

## 影响面

- 只影响「学生成长」与「个人信息」两个视图的取数路径；门户通知、一卡通、获奖名单、教务各视图的取数走原路（`pdataApi` 未改）。
- 缓存只在内存里，应用重启即失效；不落盘、不写日志、不进 DOM。
- 用户按「刷新」、点「重新登录」、清凭据、换账号时都会绕开或作废缓存，不会出现「按了刷新还是旧数据」。
- 未登录 / 失败路径与过去完全一致（缓存不介入失败），提示文案没变。
- 无数据迁移：不涉及 `tide.storage` / vault 的字段变更。
