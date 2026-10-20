# v0.266.0 · 获奖名单搜索支持拼音首字母与简写

## 改了什么

`public/plugins/cppu-notify/`（插件版本 1.73.0 → 1.74.0）、根 `tools/`、`docs/`、`AGENTS.md`

1. **搜索从「一层」变「三层」**（`award-list.js` 的 `fieldHits()` / `textHits()`）
   - 原文：`normQuery()`（小写 + 去掉全角/半角空白）后 `includes`。
   - 拼音首字母串包含：`wct` / `ct` ⊂ `王晨听`，`jxj` ⊂ `国家奖学金`。
   - 跳字简写（子序列）：`wt` ⊂ `wct`、`sjm` ⊂ `sxjm`（数学建模）。
   - **单字母只走包含**：长度 1 不做子序列，否则一个 `s` 会把整页人全捞出来。
2. **改为逐字段匹配**（`textHits` 的 `parts.some(...)`）
   - 旧写法 `normQuery(parts.join(" ")).includes(q)` 会让「张三 李四」拼成 `zsls`，
     搜 `sl` 假命中跨人名的组合；现在每个字段各自成串，误配只可能落在一个人名内部。
   - 每次获奖的 `project` / `title` / `level` 也摊平成独立字段。
   - 队名照旧不参与（与「队名不出现在本页任何位置」同一条边界）。
3. **首字母表随插件走，但只有一个事实源**
   - 事实源仍是 `src/pinyinInitial.js` 的 `PY_INITIAL_DATA`（6768 个 GB2312 常用字）。
   - `tools/gen-cppu-pinyin.js` 把它搬成 `public/plugins/cppu-notify/pinyin-initials.js`
     （24358 字节，含 `initialsOf()` / `initialHit()`），`--check` 守一致性。
   - 为什么必须搬：插件跑在 `public/plugins/` 的静态文件里，`src/` 不随构建发布，
     `import "../../../src/pinyinInitial.js"` 只会 404。
4. **文案同步**：输入框 `placeholder` 改成「姓名 / 简写 / 奖项」，`title` 与 `aria-label`
   写明支持首字母，空结果补一句「也认拼音首字母与跳字简写（「王晨听」可搜 wct / wt / ct）」。
5. **规范沉淀**：`AGENTS.md` 新增铁律十，展开版写在 `docs/search-conventions.md`
   （三层输入、逐字段、哪些字段不参与、表怎么搬、UI 三件套、断言模板、反例清单）。

## 顺手补齐：`cppu-room` 视图图标（v0.265.0 漏跑生成器）

`v0.265.0` 加了「自习室查询」视图（`main.js` 的 `view: "cppu-room"`）与 `tools/gen-plugin-icons.py`
里的候选 slug，但没跑生成器 —— 随包 PNG 与两份 `ATTRIBUTION.md` 都缺这一条，
`test-icon-masters.mjs` 因此红（它按 `VIEW_ICONS` 的键逐个查 PNG 存在性、81×81 与台账 sha 前 16 位）。

- 本机到 `img.icons8.com` 是 `SSL: UNEXPECTED_EOF_WHILE_READING`（直连与 127.0.0.1:7897 都不通），
  且 `door-open` / `door` / `open-door` 三个 slug 缓存里都没有。
- 于是候选末尾补 `books` 兜底：自习室＝看书的屋子，语义还站得住；**有网时仍优先 `door-open`**，
  缓存一旦落地就自动换回门。这不是"随便找个图标顶上"，是把离线不可用写进候选链。
- 产物：`le-time-management/public/icons/plugins/cppu-room.png` 与
  `miniprogram/images/plugins/cppu-room.png`（3424 B，81×81，`color/books`，两份字节一致），
  两份 `ATTRIBUTION.md` 同步。

## 影响哪端

- 桌面（Windows）与 Android 共用 `public/plugins/`，同源生效。
- 微信小程序端无 cppu-notify 原生适配（`sync-plugins.js` 的 13 个适配名单里没有它），不受影响。

## 数据迁移

无。搜索词本来就不落盘（只活在内存，见 `createAwardPanel` 的 `query`），
缓存键 `awardBoardCache` / `awardAffixScanned` 未变。

## 校验

```bash
node tools/gen-cppu-pinyin.js --check          # ✓ 插件首字母表与事实源一致
node tools/sync-version.js --check             # ✓ 三端版本一致：v0.266.0
node tools/sync-plugins.js --check             # ✓ 17 个内置插件同源
node ../tools/gen-theme-dark.js --check
node ../tools/build-schedule-plugin.js --check
node ../tools/sync-android-native.js --check
node scripts/test-cppu-award.mjs               # 含新增的 5 条搜索断言
node scripts/test-icon-masters.mjs             # cppu-room 随包 PNG 与台账 sha 对得上
python tools/gen-plugin-icons.py               # 无 --check；重生成确定性，跑完 git status 应只见新增
```

新增断言（`scripts/test-cppu-award.mjs` 搜索段）：`zs` → 张三、`s` → 张三（单字母走包含）、
`sxjm` → 张三/李四（项目名全首字母）、`sjm` → 张三/李四（跳字简写）、
`qqqzz` → 仍给空结果（**拼音最容易写成"永远有结果"，这条负例是重点**）。
