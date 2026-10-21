# v0.273.0 · 自习室：一间一行 + 按日期看空闲

> 类型：新功能（minor）　影响端：Windows / Android 同源插件（cppu-notify 1.83.0）　数据迁移：无

## 用户提的两个问题

1. 「同一栋楼的 101 占那么多位置，直接弄成一行不行吗」
2. 「可以按日期看看那一天有没有空闲」

## 根因

**① 一间教室被拆成五行。** 自习室接口（`POST https://jw.cppu.edu.cn/je/zxcx/load`）返回的每行是
「一间教室 × 一个节次」，字段只有 `JC / YW_ID / ID / SFZY / YWMC / RQ`。渲染时按 `YW_ID` 去重成
「教室」，在实测那份数据里 `YWMC` 与 `YW_ID` 是一对一（126 间 ↔ 126 个 ID），所以看着正常；
但换个数据形态（例如按节次各发一个 `YW_ID`）就会把同一间教室拆成 5 行「101」，右侧五格里
每行只有一格有颜色、其余 `.off` 变灰 —— 这正是截图里那个样子。**教室名才是人认的那把钥匙**，
分组键改成 `YWMC`（缺失才退化到 `YW_ID`）。

**② 只能看今天。** 那条 SQL 里只有一个占位符：

```sql
select ? rq from dual     -- 实参声明在 FUNCINFO_QUERYPARAM
```

`FUNCINFO_QUERYPARAM = [{"name":"RQ","fieldType":"VARCHAR","paramType":"0","defaultValue":"SYSDATE"}]`。
旧代码把这份声明原样回传（`defaultValue` 恒为 `SYSDATE`），等于每次都问「今天」。
要查别的日子只能改 `defaultValue`——**只改这一个字段**：`fieldType` / `paramType` 少一个，
服务端就回 `JSONObject["fieldType"] not found`，整条 SQL 被拒。

## 改了什么

`le-time-management/public/plugins/cppu-notify/main.js`

| 位置 | 改动 |
|---|---|
| `jwQueryParamsForDate(decl, date)` | 新增。按声明解析出数组，只把 `RQ` 的 `defaultValue` 换成目标日；解析不出来就退回原串，绝不拼一个像样的 |
| `jeLoad(key, groups, opts)` | 新增第三参 `{ date }`；`queryParamsStr` 从写死 `meta.queryParams` 改成按日期算 |
| `jwEnsureKeys` | 自习室这一路带上 `{ date: jwState.roomDate }`；其它功能没有日期维度，原样不传 |
| `jwRoomModel(rows)` | 分组键 `YW_ID` → `YWMC`（同名重复行以「占用」为准，宁可少报空闲）；额外返回 `free` / `seats` |
| `jwDayISO(offset)` / `jwRoomDateLabel(iso)` | 新增。日期用本地时区算（`toISOString()` 是 UTC，晚上会差一天） |
| `jwRoomCardHtml` | 楼头统计改成真实座位数，整天一位没占的楼加「全天空闲」绿标 |
| `jwRoomHtml()` | 工具栏加「日期」行：`今天 / 明天 / 后天`（选过自定义日期就多一颗），行尾是叠在胶囊上的原生 `input[type=date]`；计数行改成「某天 · 几栋几间 · 空闲位 x / y」 |
| `jwSyncRoomGlow(root)` | 日期、节次两组胶囊各挂一次 `tide.ui.selectionGlow`（铁律六）；重绘后 `dispose` 旧的再挂 |
| `mountJwView` | `jwSetRoomDate(day)`：换天清 `jwState.data.room` + `at.room`、重绘、重拉（不 `force`，`force` 会重跑登录判定）、重套过滤、落缓存 |
| CSS | `.pp-datesel` / `.jw-date-in`（透明日期框铺满日历按钮）、`.jw-room-bld-hd .jw-tag` |

「今天」用 `""` 表示，让服务端 `SYSDATE` 决定 —— 少一次参数特判，也避免客户端时区与教务服务器不同天。

## 验证

- 真机取数（2026-10-21，cookie 来自 cppu-notify 技能会话）：
  - 今天（不传 RQ）→ 630 行，空闲 332 / 630
  - `RQ = 2026-10-25` → 630 行，空闲 614 / 630
- 真 CSS 渲染（无头 Chrome，Android UA，安全区 24/48，390 / 360 / 320 三档）：
  `overflowCount = 0`、8 张楼卡片、`dupNames = []`（每卡内教室名不重复）、
  日期胶囊 `sh/ch = 44/44` 不折行、`320` 档胶囊行 `scrollWidth/clientWidth = 206/206` 不横滚、
  计数行 `2026-10-21 · 8 栋 39 间 · 空闲位 64 / 195`。
- `node scripts/test-cppu.mjs` 通过，新增断言：日期只换 `defaultValue`（`fieldType`/`paramType` 必须留着）、
  分组键是教室名、日期胶囊与计数行存在、`全天空闲` 标存在。
- 全套：`sync-version --check` / `gen-theme-dark --check` / `build-schedule-plugin --check` /
  `sync-android-native --check` / `npm test`。

## 边界

- 楼名的划分是**从教室号推的**（`jwRoomBuilding`）：接口没有「楼」字段，主楼取三位纯数字，
  `10S/7S/9S` 取数字楼，`A101` 取字母栋，讲堂/阶梯教室/实训室/穗区各自成组，认不出的落「其它」。
  学校的命名若变体（例如 `T-101`），会落进「其它」而不是猜错位置。
- 换天只看「那一天有没有空闲」，不预约、不占座 —— 预约仍在教务自己的页面里做。
- 若教务把 `RQ` 改成别的占位符名，`jwQueryParamsForDate` 换不到就原样回传，页面退回「看今天」，
  不会静默查错日子。
