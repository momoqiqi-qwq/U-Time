# v0.269.1 · 自习室查询真能取数了

> 2026-10-20 · 修复版（patch）
> 影响端：桌面端 / Android / 插件（cppu-notify 1.79.1）
> 数据迁移：无

---

## 一句话

「自习室」进去会说「自动登录失败」——登录其实是好的，是**这次查询的端点与 SQL 占位符实参传错了**，服务端只回一句「数据加载失败！」，插件又把它当成登录失效去重登。现在端点与实参都按教务的元信息派发，真机一次取回 630 行。

---

## 根因（真机抓包确认）

教务的每个功能在 `getStaticFuncByCode` 的返回里都带一条 `FUNCINFO_FUNCACTION`，那是**它自己的控制器路径**：

| 项 | 值 |
|---|---|
| 自习室 `FUNCINFO_FUNCCODE` | `ZXZYCX` |
| `FUNCINFO_FUNCACTION` | `/je/zxcx` |
| 取数端点 | `POST /je/zxcx/load`（不是通用的 `/je/load`） |
| `FUNCINFO_SQL` | `… (select ? rq from dual) …` — 带一个 `?` 占位符 |
| `FUNCINFO_QUERYPARAM` | `[{"name":"RQ","defaultValue":"SYSDATE"}]` |

旧代码两处都对不上：

1. 端点硬编码 `JW_LOAD = JWAPP + "/je/load"` → 打到通用控制器，拿不到 RQ 实参，直接回 `数据加载失败！`；
2. `queryParamsStr` 恒为 `"[]"` → 即使端点对了，服务端也会报
   `Expected positional parameter count: 1, actual parameters: []`。

再加一条误判：`jeLoad` 里 `!rows` 一律当成「会话过期」→ 删缓存、换票、重登一轮完整 SSO（含验证码 OCR），
最后横幅写「登录失败，正在显示缓存」。用户看到的「自动登录失败」就是这么来的。

## 改了什么

1. `jwFuncInfo` 的元信息扩到 `funcAction` 与 `queryParams`（`FUNCINFO_FUNCACTION` / `FUNCINFO_QUERYPARAM`），
   并纳入「是否缓存」的判定。
2. `jeLoad` 按元信息派发端点：`funcAction` 非空 → `JWAPP + funcAction + "/load"`，否则回落 `/je/load`；
   `queryType=sql` 时 `queryParamsStr` 用元信息里的声明，不再写死 `[]`。
3. 请求体补齐 `dbQueryObj="{}"`（教务自己前端每次都会带）。
4. 保留 v1.77.0 的归因修正：服务端回结构化 JSON 拒绝时抛「教务拒绝了这次查询：<原话>」，
   不再触发一轮完整 SSO 自动登录；只有真拿到 HTML / 302 / 401 才换票重登。
5. 保留 v1.77.0 的 `ensureJwLogin` 失败记忆修正（`resolve(false)` 也算失败，不重复登录）。

## 验证

- 真机（学号 2025000001，会话由用户在浏览器登录后用 bsk 接管抓包）：
  `POST https://jw.cppu.edu.cn/je/zxcx/load` + `queryParamsStr=FUNCINFO_QUERYPARAM` + `limit=-1` → **HTTP 200，630 行**，
  字段 `JC / YW_ID / ID / SFZY / YWMC / RQ`；`limit=30` 时 30 行、`queryParamsStr=[]` 时报占位符数量错误 —— 三条对照均复现。
- `node scripts/test-cppu.mjs` 新增用例：配了 `FUNCINFO_FUNCACTION` 的功能必须打自己的 `/load`、必须回传
  `FUNCINFO_QUERYPARAM` 的声明、`tableCode` 留空、且不再撞通用 `/je/load`。
- `npm test`（158 个脚本）、`sync-version --check`、`gen-theme-dark --check`、`build-schedule-plugin --check`、
  `sync-android-native --check` 全绿。

## 边界

- 只有自习室查询用到了「功能自有端点」这条路径；其余功能教务没配 `FUNCINFO_FUNCACTION` 时仍走 `/je/load`，行为不变。
- 校内站必须登录；插件不存明文密码，会话过期仍会走「重新登录」。
