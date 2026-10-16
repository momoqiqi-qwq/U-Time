# v0.229.1 · 修 pdata 取数：学生端 URL 上绝不能带 `_USER`

> 归属说明：改动进 `public/plugins/cppu-notify/`（属「必须升版本」的目录），
> 随 v0.229.0 之后的补丁版本 v0.229.1 发布。
> 校验：`node ../tools/sync-version.js --check` → ✓ 三端版本一致；`npm test` → 全部通过。
> 插件 `manifest.json` 1.55.4 → 1.55.5（`sync-version.js` 不管插件版本，手改 + 跑 `node tools/sync-plugins.js`）。

## 症状

「警大成绩」下面 v0.220.1 加的「绩点排名情况」与「六维图」两张卡永远显示占位文案
（「成长中心暂未算出你的排名」），于是被判成「新生还没有排行数据」。用户拿站点截图对照后
指出站点上明明有值（全校 6519 / 学院 622 / 专业 145 / 班级 30），要求查到底。

## 根因

`pdataApi()` 在 URL 上拼了 `_USER=<userId>`：

```js
// 改前（main.js，v0.220.1 之前一直如此）
const url = PDATA + path + (path.includes("?") ? "&" : "?") + "_USER=" + encodeURIComponent(auth.userId || "");
```

pdata 服务端是**按 `Authentication` 头里的身份认人**的；URL 上再挂一个 `_USER`，
它就拿这个值当筛选条件去查，命中空集。用同一个 token、同一批接口逐条对照（脚本
`.tmp-probe/pdata_probe_should_user.py`，2026-10）：

| 接口 | 带 `_USER=2025290058` | 不带 `_USER` |
|---|---|---|
| `/tsa/shc/learnInfo/gradePointRanking` | `code:2000 data:[]` | **`data:[专业145, 全校6519, 学院622, 班级30]`** |
| `/tsa/shc/learnInfo/learningGap` | `code:2000 data:[]` | **`data:[专业 86.4/457.3, 全校 86.4/572.2, 学院 86.4/457.3, 班级 86.4/213.8]`** |
| `/tsa/shc/personalInfo/getFormListByCatalogId?catalogId=studyInfo` | `code:2000 data:[]` | **`data:[…7 张卡…]`** |
| `/tsa/shc/homepage/personInfo` | `code:-1 未知异常` | **`code:2000 keys=[personPhoto,column,personInfo]`** |
| `/tsa/shc/homepage/getKpiList` | `code:-1 未知异常` | **`code:2000 list[4]`** |
| `/tsa/shc/customStyle/getModuleList` | `code:-1 未知异常` | **`code:2000 list[2]`** |
| `/tsa/shc/learnInfo/learnSituation` | `code:2000`（`TOTALUNIT:0`） | **`code:2000`（`TOTALUNIT:218.0, GOTTENUNIT:59.6`）** |
| `/tsa/shc/homepage/{onlineState,cardConsume,bonusPenaltyList}` | 正常 | 正常（这几条容忍 `_USER`） |
| `/tsa/shc/learnInfo/{scoreCardList,classScheduleGrid}`、`homepage/getMyAttendance` | `code:-1` | `code:-1`（这几条确实没有，与本 bug 无关） |

⇒ 也就是说 **v0.229.0 之前的「学生成长」（1.51.0）与「个人信息」（1.55.0）两块视图也一直
跑在这条 bug 上**，只是它们的空态看着像「后台没配」，没人对照过官网。

## 改了什么

- `main.js` 的 `pdataApi()`：`const url = PDATA + path;` —— 不再追加任何查询参数，
  调用方给的 path 原样使用。函数上方补了一段注释写清这条实测结论。
- `profile.js` 文件头「取数口径」里的 `GET /tsa/shc/homepage/personInfo?_USER=<userId>`
  改成不带 `_USER`，并注明原因（原来那句写的是「_USER 由 pdataApi 自动追加」）。
- `scripts/test-cppu.mjs` 加回归断言：`pdataApi` 函数体内不得出现 `_USER`，
  且必须匹配 `const url = PDATA + path;`；同时把两张卡的测试种子值换成上面的真实值
  （6519 / 622 / 145 / 30），断言 `>6519<` `>622<` `>145<` `>30<`。

## 验证

- `node --check public/plugins/cppu-notify/main.js` → SYNTAX OK
- `node scripts/test-cppu.mjs` → PASS
- `npm test` → 139 个测试脚本全部通过
- **端到端**：`.tmp-probe/plugin-pdataapi-integration.mjs` 把 `main.js` 跑进 Node VM，
  `tide.vault.get("pdataToken")` 喂真 token、`tide.http.fetch` 走真网络，直接调插件自己的
  `pdataApi()` / `jeLoadPdataStudy()`：

  ```
  OK   /tsa/shc/learnInfo/gradePointRanking      ok=true code=2000 list[4]
  OK   /tsa/shc/learnInfo/learningGap            ok=true code=2000 list[4]
  OK   /tsa/shc/learnInfo/learnSituation         ok=true code=2000 keys=TOTALUNIT,…
  OK   /tsa/shc/personalInfo/getFormListByCatalogId  ok=true code=2000 list[7]
  OK   /tsa/shc/homepage/personInfo              ok=true code=2000 keys=personPhoto,…
  OK   /tsa/shc/homepage/getKpiList              ok=true code=2000 list[4]

  pdataStudy = {"ok":true,"auth":false,
    "rank":{"QXPM":6519,"XYPM":622,"ZYPM":145,"BJPM":30},
    "myPoint":{"QXPM":86.4,…},"topPoint":{"QXPM":572.2,"XYPM":457.3,"ZYPM":457.3,"BJPM":213.8}}
  绩点排名卡：6519 ✓ 622 ✓ 145 ✓ 30 ✓
  六维图卡：svg ✓ 轴名 ✓ 本人 ✓ 学霸 ✓ NaN false
  ```

- 视觉核对（无头 Chrome，真 CSS + 真实值种子）：`output/preview/pdata-cards-light-vs-dark.png`
  （浅色 / 深色并排，760×660 各一）。OCR 读出「全校排名 6519 / 学院排名 622 / 专业排名 145 /
  班级排名 30」与图例「本人绩点 / 学霸绩点」；按色相统计确认深色模式下两个多边形都画出来了
  （warm≈3586 / cool≈18627 像素），雷达区域无 `NaN`、无横向溢出。

## 边界

- `scoreCardList`、`classScheduleGrid`、`homepage/getMyAttendance` 对当前学生角色仍然
  返回 `code:-1 未知异常` —— 这是服务端确实没有这几条（站点上点它们同样弹「未知异常」），
  不是本 bug 的残留。
- `learningGap` 的 `MYPOINT` 四档同为一个值（86.4），`TOPPOINT` 是 213.8～572.2 量级 ——
  两者不同量纲，雷达图按 `mine/top` 归一化后本人多边形会明显小于外环，与官网一致（照抄，不做美化）。
