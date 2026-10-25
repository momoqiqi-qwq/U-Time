# v0.220.1 · 警大成绩新增「绩点排名情况」与「六维图」（学生个人成长中心 pdata.cppu.edu.cn）

> 归属说明：本条改动进入 `public/plugins/cppu-notify/`（属「必须升版本」的目录），
> 随 v0.220.0 之后的补丁版本 v0.220.1 发布。
> 校验：`node ../tools/sync-version.js --check` → ✓ 三端版本一致；`npm test` → PASS: 137 个测试脚本全部通过。
> 插件 `manifest.json` 1.51.0 → 1.52.0（`sync-version.js` 不管插件版本，手改 + 跑 `node tools/sync-plugins.js`）。

## 改了什么

「警大成绩」视图（`cppu-credit`）在成绩总览下面追加两张卡：

1. **🏅 绩点排名情况** —— 全校 / 学院 / 专业 / 班级四档排名，2×2 网格，数字大字（全校=--deep、学院=#2A7EFF、专业=#B06A00、班级=--campus-green，深色模式各有亮色覆盖）。
2. **🕸 六维图** —— 内联 SVG 圆形雷达图（4 环 + 4 条辐条），两条序列：本人绩点（橙 #FB951E）与学霸绩点（蓝 #2A7EFF）。轴为全校 / 学院 / 专业 / 班级四档，**外环刻度 = 各档学霸绩点**，本人值按 `mine/top` 归一化。插件里不引 echarts。

## 数据从哪来

个人成长中心（pdata.cppu.edu.cn，umi SPA）与教务是两条独立链路，插件里已有 `pdataApi(path)`（自带 CAS 换票 `ensurePdataAuth()` + 401/1001/4001 自动重试一次），直接复用，没有新写登录。

| 卡片 | 接口 | 解析 |
|---|---|---|
| 绩点排名情况 | `GET /tsa/shc/learnInfo/gradePointRanking` | `RANKTYPE` ∈ 全校/学院/专业/班级 → `RANKING` → `QXPM/XYPM/ZYPM/BJPM` |
| 六维图 | `GET /tsa/shc/learnInfo/learningGap` | 同四档 → `MYPOINT` → `myPoint.*`；`TOPPOINT` → `topPoint.*` |

证据来自 pdata 前端产物 `/umi.js`（10.6 MB，umi 3.5.21）模块 `hQL+`（学生 studyInfo 页面）与 `1Df2`（store）：页面按 formId 分发 `MyGradePointRanking` / `TheGapBetweenMeAndTheMaster`，后者的 echarts option 是 `radar{shape:"circle",splitNumber:4,radius:"65%"}` + 两条 radar series（`学霸绩点` / `本人绩点`），indicator 的 `max` 取 `topPoint`。**「六维图」在成长中心里就是这 4 轴雷达图，不是 6 条轴。**

## 取数怎么接

- `jwState.data` 新增 `pdataStudy`（缓存白名单 `jwSaveCache` / `jwRestoreCache` 各补一处，落 `letime-data`）。
- `jwEnsureKeys()` 里分流：`key === "pdataStudy"` 走 `jeLoadPdataStudy()`（`Promise.all` 打两个接口），其余走原来的 `jeLoad`。
- **刻意不给 `pdataStudy` 写 `jwState.error`** —— pdata 挂了只让这两张卡自己说话，不挂教务的「拉取失败」横幅。
- 视图注册 `keys: ["grade"]` → `keys: ["grade", "pdataStudy"]`。

## 四种状态（都必须能看）

| 状态 | 卡片显示 |
|---|---|
| 正在拉取 | 「正在读取绩点排名…」/「正在读取绩点对比…」 |
| 没拉过（`null`） | 「还没有拉取过…点上方「刷新」」 |
| 登录态不在（`auth`） | 「先到「警大通知」登录一次，再回本页点「刷新」」 |
| 接口失败 | 接口原话 |
| 拉到了但四档全 0 | 「成长中心暂未算出你的排名（排行按学期批量生成，新生入学首学期通常为空）」 |

## 边界（重要）

> ⚠️ **本节结论已在 v0.229.1 被推翻，保留原文只为留痕。** 当时实测 `gradePointRanking` /
> `learningGap` / `getFormListByCatalogId` 全部 `data:[]`，误判为「新生还没有排行数据」；
> 真因是 `pdataApi` 在 URL 上多拼了一个 `_USER=<学号>`，服务端拿它当筛选条件、命中空集。
> 去掉 `_USER` 后同一个 token 立刻拿到真数据（全校 6519 / 学院 622 / 专业 145 / 班级 30）。
> 详见 `docs/CHANGELOG-v0.229.1.md`。

**（以下为 v0.220.1 当时的记录，勿再引用）** 2025 级新生在成长中心侧「没有排行数据」：实测（学号 `2025000001`）`gradePointRanking`、`learningGap`、`getFormListByCatalogId(catalogId=studyInfo)` 全部 `{"code":2000,"message":"请求成功","data":[]}`，`learnSituation` 返回 `{TOTALUNIT:0,GOTTENUNIT:0,THISTERMGOTTENUNIT:0,GRADEPOINT:0.0}`。

## 验证

- `node --check public/plugins/cppu-notify/main.js` → SYNTAX OK
- `node scripts/test-cppu.mjs` → 通过（新增断言：两张卡在 `jwGradesHtml()` 里、四档标签与数值、SVG 无 `NaN`、全 0 与 `auth` 两种占位、`pdataStudy=null` 提示、`keys: ["grade", "pdataStudy"]` 注册形状）
- `npm test` → PASS: 137 个测试脚本全部通过
- 视觉核对（无头 Chrome，真 CSS + 种子数据）：`output/preview/cards-light-vs-dark.png` 与 `output/preview/__cx2-credit-classic-{light,dark}-full.png`。浅色 / 深色两套下 OCR 都能读出「全校排名 622 / 学院排名 145 / 专业排名 30 / 班级排名 3」「本人绩点 / 学霸绩点」与四条轴名（全校 / 学院 / 专业 / 班级），无 `NaN`、无横向溢出。
