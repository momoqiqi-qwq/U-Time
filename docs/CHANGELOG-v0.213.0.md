# v0.213.0 · 获奖名单会去读附件，每条记录都能点回原通知

> `node ../tools/sync-version.js --check` → ✓ 三端版本一致：v0.213.0
> `node ../tools/gen-theme-dark.js --check` → ✓ 派生调色板已同步（15 套深色变体）
> `node ../tools/build-schedule-plugin.js --check` → ✓ shiguang-schedule 生成物与源一致
> `node ../tools/sync-android-native.js --check` → ✓ Android 原生代码与版本化镜像一致
> `npm test` → PASS: 134 个测试脚本全部通过

动的文件：

- `public/plugins/cppu-notify/award-attach.js` —— 新增：附件判定 + 字节解析（纯函数，零依赖）
- `public/plugins/cppu-notify/award-list.js` —— 排名档里的每条获奖记录变成回原通知的入口；条目挂「附件名单」标、来源行写清是哪份附件；**团体获奖改按获奖人姓名署名（不再用队名）**
- `public/plugins/cppu-notify/main.js` —— 获奖同步新增「附件名单」阶段（判定 → 下载 → 并入解析文本 → 记账）
- `public/plugins/cppu-notify/manifest.json` —— 1.44.0 → 1.45.0 → **1.46.0**（描述与版本注记同步）
- `scripts/test-cppu-award-attach.mjs` —— 新增：附件解析层全链路断言（该不该读 / 扫过即跳 / docx / xlsx / PDF / .doc / 零副作用）
- `scripts/test-cppu-award.mjs` —— 迷你 DOM 补齐内层 HTML；补附件链路与「排名档点回通知」的断言
- `src/pluginCatalog.js`、`miniprogram/core/pluginCatalog.js` —— `tools/sync-plugins.js` 生成物
- `package.json` / `package-lock.json` —— 0.212.0 → 0.213.0（lock 两处手改）

无数据迁移。新增一个存储键 `awardAffixScanned`（只存「哪条通知的哪份附件已经读过」的时间戳）。

## 用户要求

> 点击个人项目里面的通知也可以转到对应通知里面去
>
> 可不可以让它读有获奖名单的附件，由附件名称或者通告里面是否说明名单在附件才去看对应附件，
> 扫过的附件内容不能再扫，附件的获奖名单出来后就不用附件缓存了，就直接把信息提取出来就行
>
> 团体获奖不使用队名，使用【人名 人名 人名】

## 零、团体获奖不署队名，按人名署名

口径一句话：**获奖的是人，不是队。** 队名本身不丢（它还在通知正文里、还在悬停气泡里），
只是不再占据「署名」这个位置。

| 位置 | 改前 | 改后 |
|---|---|---|
| 奖项项目的团体条目 | 一颗队名 pill + `成员：A、B` | 「获奖人员 / 团体成员 N」一组人 pill，团体成员那颗带 `团体` 尾标与 `title` |
| 获奖排名 · 团体档 | 行名 = 队名 | 行名 = `赵六、钱七`（`joinPeople(row.members)`），队名进 `title="获奖成员（团体获奖按人署名）：原队名 X"` |
| 展开里的成员块 | 「已知成员」 | 「获奖成员（团体获奖按人署名）」 |
| 人名榜 | 团体来源挂 `<span class="aw-tag team">队名</span>` | 只标 `<span class="aw-tag team">团体</span>` |
| 统计行 | 奖项 N 人次 · 个人 N 位 · 团体 N 个 | … · **署名到人 N 位（团体获奖按成员署名）** |

- 新函数 `awardNamesOf(g)` / `teamMemberNames(groups)` / `joinPeople(names)` / `awardBearer(g)`，
  `awardBearer` 就是「一条记录挂到谁名下」的单一出口（团体有成员 → 成员，否则退回 `g.name`）。
- `stats.awarded`：个人获奖者 ∪ 全部团体成员的去重人数 —— 它跟 `stats.teams` 是两个口径，
  前者能点到人头，后者是「有几支队」，两个都留着。
- **兜底**：通知只写队名、没列成员时，这一条**仍用队名**，并在行内/清单里注明
  「通知未列成员，署名仍用队名」。不兜底的话这些队会变成一个空名次或整条消失 —— 漏人比署旧名更糟。

## 一、排名档里的记录本身就能点回去

过去只有「奖项项目」档的详情里有「来源通知」按钮，个人榜 / 团体榜 / 人名榜展开后列出的
那条记录是死文本 —— 看到「张三 · 一等奖」想核对原文，还得自己回「奖项项目」档找。

现在 `rowsHtml()` 把每条记录交给 `hitHtml(h, kind)` 渲染：带 `rid` 的写成
`<button class="aw-hit" data-aw-source="rid">`，落在面板既有的点击委托里
（`listNode.onclick` 先判 `[data-aw-toggle]`、再判 `[data-aw-source]`，
命中就调 `render()` 传进来的 `onOpenSource(rid)` → `awOpenNotice(rid)`：
在通知列表里就展开并滚动过去，不在列表里就弹一句「这条通知不在当前列表」）。
没 `rid` 的仍旧退回纯文本行，不造一个点了没反应的假按钮。

## 二、名单在附件里时才去读

判据放在 `award-attach.js` 的 `looksLikeAwardAttachment(name, noticeText)`，两路取或：

| 路 | 函数 | 判据 |
|---|---|---|
| 看附件名 | `affixNameSignal(name)` | 命中 `获奖 / 获评 / 荣获 / 表彰 / 嘉奖 / 奖项 / 荣誉 / 名单 / 名次` 一类；被 `报名 / 申报 / 申请 / 承诺 / 授权 / 委托 / 合同 / 协议 / 方案 / 日程 / 议程 / 考场 / 座位 / 课表 / 模板 / 样表 / 登记表 / 签到 / 问卷 / 统计表 / 预算` 一类否决，但 `获奖名单 / 表彰名单 / 获奖人员 / 获奖学生 / 获奖单位 / 获奖集体 / 受表彰` 这类强判据能翻案；`.zip` 与图片音视频直接出局 |
| 看正文说没说 | `saysListInAffix(text)` | 按 `。；;！？` 断句，**同一句**里既出现「附件」又出现 `名单 / 名册 / 获奖 / 表彰 / 受奖 / 奖项` 才算（「附件里的报名表请下载」这种不算） |

两道都不命中就不下载；命中且没读过才进入本轮清单。单轮最多 12 份（`AWARD_AFFIX_MAX`），
读完的进度走状态行（`awState.progress`），不阻塞正文解析。

## 三、读过的附件不再读，抽完不留缓存

- **记账**：`markAffixScanned(rid, name)` 把 `awardAffixScanned` 的键 `"<rid>::<文件名>"`
  写成时间戳，同一份附件下一轮直接用缓存里的标记跳过；记账上限 400 条（`AWARD_AFFIX_MARK_MAX`），
  超了按时间淘汰最旧的。判定失败（下载失败 / 抽不出东西）**不记账**，下一轮还能再试。
- **不留内容**：附件文本只在 `awAffixPass()` 的局部 `Map` 里活一轮 —— 并进该通知的解析文本
  （`text = [det.content, affix.text]`）就交给 `parseAwardNotice()`，之后不再被引用。
  落盘只多一个 `rec.affix = [附件名…]`（截 4 个），**附件字节与附件正文都不进 `awardBoardCache`、
  也不进 `noticeCache`**；单份附件文本上限 6 万字符（`AWARD_AFFIX_CHARS`）。
- 条目上标「附件名单」，项目档的来源行写成「（获奖名单来自附件：XX.docx）」，
  这样一眼能看出这条记录是从哪份附件里读出来的。

## 四、附件解析层（`award-attach.js`，不碰宿主）

`attachmentToNoticeText({ name, bytes, mime, spreadsheetText })` → `{ text, kind, reason }`，
按字节魔数分流（扩展名只作兜底）：

| kind | 走法 |
|---|---|
| `zip` | 自研中央目录解析（`unzip()` + `DecompressionStream("deflate-raw")` + `Blob/Response`）：`word/document.xml` → `docxToNoticeText()`；`xl/worksheets/sheet*.xml` → **优先**把字节包成 `File` 交给宿主 `tide.assets.spreadsheetText()`（XLSX 库，行为与导入一致），拿不到再自读 `sharedStrings` 松判；`ppt/slides` 同样按段落抽 |
| `pdf` | 解 zlib 流 → `Tj/TJ` 字符串还原 → 仅在文本里含 `获奖 / 名单 / 姓名 / 一等奖` 且中文字符 ≥ 8 时返回，否则给空串 |
| `doc-ole` / `xls-ole` | `D0CF11E0` 头：xls 交给宿主 XLSX；`.doc` 按 UTF-16LE 粗扫中文段，同样设关键词门槛 |
| `text` / `html` | 按 UTF-8 解，坏字节多则退 GBK；HTML 先去标签与实体 |

文本一律先转成「名册口径」的行（`rowsToNoticeText()`）：识别表头列语义
（`姓名 / 人员 / 学生 / 选手 / 成员` → 人名，`队名 / 代表队 / 团队 / 获奖单位` → 队名，
`指导教师 / 领队` → 指导教师，`序号 / 学号 / 学院 / 班级 / 日期 / 备注` → 跳过，
`奖项 / 等级 / 名次` → 级别），再发成 `获奖人员：A、B` / `获奖单位：X（A、B）` / 级别裸行，
正好是 `parseAwardNotice()` 认的形状。表头认不出来就走松判兜底（纯数字、带数字字母的格子跳过）。
拼得不可信的输入宁可返回空串 —— 半截垃圾混进解析会造出假获奖记录，比漏读更糟。

## 为什么自己解包

宿主只暴露 `assets.text / json / spreadsheetText`，没有通用文档解析 API，
而 Excel 那条路已经能用宿主现成的 XLSX 库，没必要重复实现。
docx / pdf / .doc 就必须自己来：docx 的关键是「zip + inflate + 一张表一行」，
用平台自带的 `DecompressionStream` 足够，**不引第三方依赖、不加打包体积**，
也能在 Node 里直接单测（测试用 `zlib.deflateRawSync` 现造 zip 夹具）。

## 守卫

- `scripts/test-cppu-award-attach.mjs`：自造 docx / xlsx 夹具走完整链路
  （附件判定 → 解析 → `parseAwardNotice` → `buildAwardBoard`），另外钉住
  「附件名像报名表的**不读**」「正文没说名单在附件的不读」「乱码 PDF 返回空串」三条安全阀。
- `scripts/test-cppu-award.mjs`：静态接线断言（`award-attach.js` 的懒加载、`AWARD_AFFIX_KEY`
  落盘、附件正文不进缓存、`data-aw-source` 与 `.aw-hit` 样式），
  外加「排名档点记录 → `onOpenSource(rid)` 收到 rid」的行为断言；
  团体署名那一段（5b2）：`awardNamesOf` / `awardBearer` 单测、`stats.awarded === 6`、
  `teamMemberNames` 摊平去重、团体档行名渲染成 `赵六、钱七`、**展开态 `doesNotMatch /星火代表队/`**、
  无成员队出现「通知未列成员，署名仍用队名」、人名榜的团体来源是 `aw-tag team">团体<`。
