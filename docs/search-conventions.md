# 搜索规范：原文 / 拼音首字母 / 简写

> 本页是 `AGENTS.md` 铁律十的展开版。用户原话：**「搜索功能必备简写和首字母搜索」** ——
> 这是本仓库所有搜索框的底线，不是某个页面的偏好。
> 首个落地实现：`le-time-management/public/plugins/cppu-notify/award-list.js`（获奖人员一览）。

## 一、三层输入（缺一不可）

| 输入 | 例 | 匹配方式 |
|---|---|---|
| 原文 | 王晨听 / 晨听 | 归一（小写 + 去全角半角空白）后 `includes` |
| 拼音首字母 | `wct` / `ct` | 首字母串包含 |
| 跳字简写 | `wt` / `sjm` ⊂ `sxjm` | 首字母串的**子序列** |

顺序与门槛写死：

```js
function fieldHits(field, q) {
  if (!q || !field) return false;
  if (normQuery(field).includes(q)) return true;   // ① 原文
  return initialHit(field, q);                     // ② 首字母包含 ③ 子序列（长度≥2）
}
```

- **单字母只认包含**（`s` 命中所有 s 开头的人，不做子序列），否则一个字母捞走整页。
- 不要把「全拼」（`wangchenting`）写进文档：表里没有全拼，承诺做不到的事比不做更糟。

## 二、逐字段匹配，禁止拼串

```js
// 对：每个字段各自成串，误配只可能落在一个名字内部
function textHits(parts = [], q = "") {
  if (!q) return true;
  return parts.filter(Boolean).some((p) => fieldHits(p, q));
}

// 错：join 之后整串匹配 —— "张三 李四" → zsls，搜 sl 会假命中跨人名的组合
normQuery(parts.filter(Boolean).join(" ")).includes(q);
```

数组字段（`members` / `people` / `mentors` / 每次获奖的 `project`+`title`+`level`）一律摊平成多字段。

## 三、哪些字段参与、哪些不参与

- 参与：姓名、团体成员姓名、奖项项目名、级别、层级、来源通知标题、指导教师。
- **不参与**：页面上刻意不显示的字段。获奖名单页统一「不出现队名」，那队名就不进搜索 ——
  否则用户按队名搜到一条、却在页面上找不到这个名字，比搜不到更糟。

## 四、拼音表怎么来

| 位置 | 角色 |
|---|---|
| `le-time-management/src/pinyinInitial.js` 的 `PY_INITIAL_DATA` | **唯一事实源**（6768 个 GB2312 常用字，`tools/gen-pinyin-initial.js` 从 pinyin-pro 生成） |
| `tools/gen-cppu-pinyin.js` | 搬表给插件，并生成 `initialsOf()` / `initialHit()` |
| `le-time-management/public/plugins/cppu-notify/pinyin-initials.js` | 生成物，勿手改 |

插件跑在 `public/plugins/` 的静态文件里，**不能 import `src/` 的模块**（`src/` 不随构建发布），
所以表必须随插件走一份。新增需要拼音的插件时照这个模式再加生成器（或把生成器参数化），
**不要**在每个插件里手抄一张表，也**不要**在插件里 `import "../../../src/pinyinInitial.js"`。

```bash
node tools/gen-cppu-pinyin.js          # 写
node tools/gen-cppu-pinyin.js --check  # 校验（不一致退出 1）
```

## 五、UI 三件套

1. **两态入口**：工具行常驻放大镜图标，点开铺成输入框（`max-width` 过渡，铁律七要求双向动画）；
   收起时不丢关键词 —— 只是框变窄，过滤仍生效。
2. **清除按钮**：有词才露出，用 `hidden` 切换而不是渲染/销毁。
3. **空结果给人话**：
   `没有匹配「关键词」的获奖人。<br>搜的是 …，也认拼音首字母与跳字简写（「王晨听」可搜 wct / wt / ct）。<br>清掉搜索框可以看到全部 N 条。`
   —— 不写「暂无数据」，那和「真的没人获奖」分不开。

键盘：`Esc` 第一次清词、第二次收起；输入框 `aria-label` 写明支持首字母；
`type=search` 的原生清除叉要 `.aw-search input::-webkit-search-cancel-button{display:none}` 藏掉，
否则和自建清除按钮重复。

## 六、验收断言（少一条都算没做完）

```js
input.value = "zs";    input.oninput(); assert.match(html, /张三/, "首字母整串（zs → 张三）");
input.value = "s";     input.oninput(); assert.match(html, /张三/, "单字母走包含");
input.value = "sxjm";  input.oninput(); assert.match(html, /张三|李四/, "项目名全首字母（sxjm → 数学建模）");
input.value = "sjm";   input.oninput(); assert.match(html, /张三|李四/, "跳字简写（sjm ⊂ sxjm）");
input.value = "qqqzz"; input.oninput(); assert.match(html, /没有匹配/, "对不上时仍给空结果");
```

最后一条是重点：**拼音匹配最容易写成「永远有结果」**，那比搜不到更糟。
落地断言在 `le-time-management/scripts/test-cppu-award.mjs`（搜索段）。

## 七、反例清单

- 只把 `q.toLowerCase()` 拿去比中文 —— 等于没做拼音。
- 只做首字母包含、不做子序列 —— `wt` 搜不到王晨听。
- 只做子序列、不做包含 —— `s` 命中所有人。
- 把首字母表抄进每个插件，或在插件里 import `src/`。
- 搜得到但页面上看不到被搜的那个字段（队名、隐藏列）。
- 空结果只写「暂无数据」。
