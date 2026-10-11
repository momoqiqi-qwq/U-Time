# v0.192.0 · 竞赛消息雷达的分类拆成三条轴：性质 / 级别 / 学科，站点叫法经封闭词表归一

> `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.192.0`；
> `node tools/sync-plugins.js --check` → `✓ 插件生成物与清单同源（--check 未写盘）：18 个内置插件`。
> 动的文件：桌面插件 `public/plugins/gx-news/main.js` + `manifest.json`（插件版本 0.6.0 → **0.7.0**）、
> `src/styles.css`（夜间兼容层里被 `.gx-tag.n` 点名的那几条）、`scripts/test-gx-news.mjs`、
> 小程序同源镜像 `miniprogram/pages/plugin/index.{js,wxml,wxss}`、`README.md`、根 `docs/` 三份说明。
> `sync-plugins.js` 顺带把两端 `pluginCatalog.js` 的目录版本号刷成 0.7.0。

## 用户要求原文

> 「请帮我整理一下竞赛通知分类，目前内容太乱了。」（附界面截图）

## 一、原来「乱」在哪

旧版的「类型」是一根**什么都往里塞**的字段，三种语义混着用：

| 来源 | 塞进 `type` 的东西 | 原样当 chip 的样子 |
|---|---|---|
| 摩课云 | `newsType` 点分复合标签（`202.204.208`） | 收敛成「平台通知 / 赛事动态 / 其他」 |
| 赛氪 | `level_name`（赛事**级别**） | `lv:全国性` → chip「全国性」 |
| 我要参赛网 | Discuz 的「分类」（站点自己的**学科**伞词） | `cat:公益大赛` → chip「公益大赛」 |

于是同一排 chip 里，「平台通知」是**消息性质**、「全国性」是**赛事级别**、「公益大赛」是**学科方向**，
三者不在一个维度上，混在一起既读不出规律也没法叠加；换源时还得整排作废（`n202` 在赛氪那边根本不成立）。
「其他」这个桶更糟：它保证那一排**永远至少有一项**，于是连「只有一个取值就该收掉」的机会也被吃掉。

## 二、拆成三条正交轴，每轴一张**有序封闭表**

```js
KIND_TABLE  // 性质：signup 报名 / result 榜单 / notice 公告 / train 培训 / race 赛事
LEVEL_TABLE // 级别：intl 国际 / nation 全国 / prov 省级 / city 市级 / school 校级
FIELD_TABLE // 学科：math 数学建模 / code 程序设计 / eng 电子机械 / sci 数理化生
            //       biz 经济管理 / lang 文学外语 / art 设计艺术 / sport 体育公益
```

四条设计决定：

1. **表顺序 = chip 顺序 = 命中优先级**。`pick(table, text)` 取表内**首个**命中项，所以顺序就是语义优先级，
   不依赖抓取结果的先后（旧版 chip 顺序会跟着数据漂）。
2. **站点原生标签只当第一手证据**，经表归一后才落轴：赛氪的 `level_name` 走 `LEVEL_NATIVE`
   （全国性→nation、省级→prov…），摩课云的 `202/203` 走 `hasType` 收敛成 notice/race，
   我要参赛网的「分类」走 `FIELD_TABLE`。换源不再需要重学一套分类 —— 三家用的是同一套词表。
3. **认不出就留空，不设「其他」桶**。空标签不渲染、不成 chip，轴上一个取值都没有时**整行收掉**。
4. **学科优先信标题**：站点分类常是「公益大赛」这种伞词，标题里的「文学 / 数模 / IP形象」才具体，
   所以 `field` 先 `pick` 标题+摘要，再退到站点分类词。

关键词表上踩过的三个坑（都留了注释）：

- `code` 用 `人工智能` 而**不是裸「智能」** —— 否则「智能汽车竞赛」会被判成程序设计；
- `eng` 用 `电子(?!商)` —— 否则「电子商务挑战赛」会被判成电子机械（它其实归 `biz`）；
- `signup` 收 `截止`、`LEVEL_TABLE.prov` 收 `分赛区|赛区` —— 这两条是真实标题里最常见的写法。

## 三、筛选与持久化

- `filter` 由 `{ type, … }` 变成 `{ kind, level, field, … }`，三轴各自独立，`"all"` = 该轴不设限，三轴之间取「与」。
- `sanitizeFilter(raw)` 迁移所有旧值形态：`202`/`n202` → 性质 notice、`203`/`n203` → 性质 race、
  `lv:全国性` → 级别 nation、`cat:X` → 学科（走 `FIELD_TABLE` 归一），迁完 `delete f.type`；
  每轴校验必须落在固定 id 集合内，否则回 `"all"`。
- **换源不再作废分类**（`setSource` / `removeCustom` 只清月份）：归一之后是跨源同一套词表，保留才有意义。
  为保证「保留」不会变成「一个都没高亮却还在过滤」，`axisChips(axis)` 会把**正在生效但这一批命不中**的那个值
  留在台面上（`AXES[axis].filter(r => seen.has(r.id) || state.filter[axis] === r.id)`），
  空态里也逐轴列名（`性质「公告」/ 级别「全国」/ 学科「数学建模」`）并给一键清除。
- 行隐藏规则从「只有一种类型时藏」改成 `opts.length < 2 && filter[axis] === "all"` —— 三轴共用同一条规则。

## 四、卡片上的三枚标签

`axisTags(m)` 按 性质 → 级别 → 学科 顺序渲染，缺的轴不占位：

| 轴 | class | 浅色底/字 |
|---|---|---|
| 学科（默认） | `.gx-tag` | `#E1EEF3` / `#0F4C5C` |
| 性质 | `.gx-tag.k` + `.k-<id>` | 报名 `#E4F5EC/#1F7A4C`、榜单 `#FDF0E2/#9A5B12`、培训 `#EAF1FB/#2B5FA8`、公告/赛事 `#EFE7FB/#6C3FB8` |
| 级别 | `.gx-tag.lv` | `#F1EFE9` / `#5C6670` |

站点自己标的那行原生分类词（如「公益大赛」）挪到卡片 `meta` 的 `title` 上 —— 不占视觉，但信息不丢。
旧的 `.gx-tag.n` 随之删除，`src/styles.css` 夜间兼容层里点名它的两条规则一并改成新的三组
（`.gx-tag.lv` / `.gx-tag.k` / `.k-signup|k-result|k-train`），三枚标签在深色下各自保住色相而不是被压成同一种颜色；
其中给 `k-*` 上文字色那条**必须用 `:is` 而不是 `:where`** —— `:where` 不贡献优先级，会被 `.gx-tag.k` 的同名 `!important` 压掉。

## 五、小程序端同源镜像

`miniprogram/pages/plugin/index.js` 里 gx-news 是**独立原生实现**（不走插件运行时），所以三轴词表在那份代码里也放了一份
（`GX_KIND_TABLE / GX_LEVEL_TABLE / GX_FIELD_TABLE / GX_AXES / GX_AXIS_NAME / GX_AXIS_KEYS` +
`gxPick / gxAxisLabel / gxClassify / gxTags / gxAxisChips`），注释里写明「词表要改就两处一起改」。
WXML 里类型那一行换成 `wx:for="{{gx.axes}}"`，月份与「只看未读」合到同一行；WXSS 里 tag 的 class 后缀只用 ASCII id
（小程序 WXSS 选择器不能含非 ASCII）。`loadGx` 同样迁移旧 `f.type`。

## 六、验证

**回归测试**（`cd le-time-management && node scripts/test-gx-news.mjs`）：

```
PASS: gx-news 残留筛选自愈 + 多源（三内置源解析 / 三条分类轴归一与跨源保留 / id 按源隔离 / 自定义源三路识别 / 添加浮层与广播快照）
```

改法与新增（都是**真跑源码**，不是正则匹配）：桩里的 `typeBarHidden()` 换成 `axisLabels(axis)` / `axisHidden(axis)`；
②新增断言「赛氪 level_name 归一成级别那排、两条都是报名所以性质行收掉」；
我要参赛网断言从「分类排要列全」改成「学科轴按标题归一 + 站点分类挂 title」；
③拆出 **③b 分类轴跨源保留**（摩课云两条都是公告 → 切到赛氪 0 条 → 空态列「性质『公告』」+ 命不中的值仍在台面上 + 一键清除）；
新增 `lv:全国性` / `cat:公益大赛` 两条旧值迁移块；自定义 RSS 源从「那一排要收掉」改成「性质/级别收掉、学科长出两枚」。

**全量**：`npm test` → 126 个脚本，含本条 CHANGELOG 一起通过（`test-release-history.mjs` 会校验「新版本记录必须位于首条」）。

## 七、影响面

- **桌面端**：只动竞赛消息雷达一个插件 + 那条夜间兼容规则。三源适配器现在只写 `m.native`，条目字段由 `classify` 统一补。
- **小程序端**：`pages/plugin` 的 gx 视图改了筛选行与卡片标签；其它插件视图未动。
- **数据迁移**：老 `filter.type` 四种形态全部有迁移路径，用户升级后不会「筛选突然失效又看不出来」；
  已读 id、快照、自定义源、关键词、月份、只看未读的语义一律不变。
- **视觉后端本轮不可用**（`VISION_BACKEND_UNAVAILABLE` / 结构化预识别被关），截图只经本地 tesseract OCR 读过，
  文字严重乱码 —— 因此本次没有「看一眼」的实景对照图，界面正确性靠上述回归测试与真 CSS 结构断言保证。
