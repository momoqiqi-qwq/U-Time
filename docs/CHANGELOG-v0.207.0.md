# v0.207.0 · 竞赛雷达筛选面板：月份按钮排换成了「起止日期」，面板也加宽了

> 本次改动（实测输出）：
>
> - `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.207.0`
> - `node ../tools/gen-theme-dark.js --check` → `✓ 派生调色板已同步（15 套深色变体）`
> - `node ../tools/build-schedule-plugin.js --check` → `✓ shiguang-schedule 生成物与源一致`
> - `node ../tools/sync-android-native.js --check` → `✓ Android 原生代码与版本化镜像一致`（升版本后先红一次，见第八节）
> - `npm test` → `PASS: 130 个测试脚本全部通过`
>
> 动的文件：`public/plugins/gx-news/main.js`（`from`/`to` 范围状态、迁移、筛选比较、自愈、`.gx-range` 日期框行）、
> `public/plugins/gx-news/manifest.json`（0.8.0 → 0.9.0，描述改写）、
> `src/styles.css`（`.plugin-filter-menu-panel` 加宽加高）、
> `scripts/test-gx-news.mjs`（月份用例改写为范围用例 + 新增 5 条）、
> 版本 `package.json`（0.206.2 → 0.207.0，三端已同步、`package-lock.json` 两处已手改）。
> 有数据迁移（旧 `filter.month` → `from`/`to`，首次进视图自动落盘）；无插件 API 变更、无宿主存档字段变化。

## 用户要求

> 弄长一些的筛选，时间可以自定义范围而不是这样选时间作为按钮

（截图是竞赛消息雷达的筛选面板：顶部「筛选 · 已设置」胶囊，下面每行一个维度 —— 源 / 性质 / 级别 / 学科 / 月份，
右侧横向胶囊；「月份」那排是 `全部 2026年11月 2026年10月 … 2026年2月` 这种绝对月份按钮，窄窗口下折成三行。）

## 一、问题有两半：时间维度选错了控件，面板也被自己挤窄了

1. **时间维度的控件形态错了。** 月份按钮只能表达「整月」，想找「9 月 5 日到 10 月 8 日」这种区间就没法选；
   而且按钮是**绝对**的 —— 到一个新月份，列表就长一格，永远在变。
2. **面板宽度是被「月份按钮要一行放下」和旧的 `max-width: 520px` 一起挤出来的。**
   实测旧面板只有 **520px 宽、约 390px 高**，其中「月份」11 个按钮就吃掉 3 行 —— 面板越宽，横向胶囊越舒展，
   而按钮排反而更占地方。

所以这一版两件事一起做：**时间维度换成任意起止日期**（一个日期框行顶掉三行按钮），
**面板同时加宽**（铺满容器，上限 760px）。

## 二、状态设计：`month` 换成了 `from` / `to`

| 旧 | 新 |
|---|---|
| `filter.month: "all" \| "unknown" \| "2026-09"` | `filter.from: "2026-09-01" \| ""`、`filter.to: "2026-09-30" \| ""` |

- 两端都是 `YYYY-MM-DD`，**空串 = 不限**（不是 `null`、不是 `all` 字符串，少一种取值就少一种分支）。
- 一端空、另一端有值也能用：`from` 空 = 「直到 `to` 那天」，`to` 空 = 「从 `from` 那天起」。
- **边界只比补零日期字符串，不造 `Date`**：`"2026-09-05" <= d && d <= "2026-09-30"`。
  造 `new Date()` 会把日期转成本地时区的时间戳，跨时区/跨夏令时就可能把两端各错一天；纯字符串比较两边都含当天，且没有时区概念。
- 「发布时间未知」的条目**只在两端都不限时留下** —— 用户既然圈了时间段，就不该混进没有时间的条目。

**迁移（有数据、要写盘）**：旧键 `month: "2026-09"` 在 `sanitizeFilter` 里就地展开成
`from: "2026-09-01"`、`to: "2026-09-30"` 并 `delete f.month`；
`month: "all"` → 两端空；`month: "unknown"` → 两端空（旧语义是「只看时间未知」，新版没有这个开关，按「不限」处理最保守）。
填反（`from > to`）自动交换；格式不合法的值作废成空串。

**迁移只做一次**：`loadPrefs()` 里判断「读出来的原始对象还带着 `month` 或 `type` 老键」才顺手 `savePrefs()` 一次。
不落盘的话，`data.json` 里那个 `month` 会一直躺着，用户点过「✕ 不限」下次进视图又被迁回同一段范围 —— 这是本轮测试真抓到的一条 bug。

## 三、界面：一行日期框顶掉三行按钮

`.gx-range` 一行：`从 [2026/09/01] ~ 至 [2026/09/30]  [✕ 不限]  <命中提示>`

- 两个 `<input type="date">`（浏览器原生日历，键盘也能填），中间 `~`，右边「✕ 不限」在两端都空时**自动禁用**。
- 填完即生效：`change` 事件 → `commitRange()`（写 `state.filter`、落盘、重画列表）。
- `paintDateRange()` 只负责把 `state.filter` 回写到两个框（重画后不丢光标位置，也不覆盖用户正在输的半截日期）。
- 右侧 `[data-range-cap]` 提示照实说人话：`发布日在 2026-09-01 ~ 2026-09-30 里，命中 2 条`。
- 顶部「筛选」胶囊上的已设置摘要也一起改了：`activeFilters()` 输出 `时间「2026-09-01 ~ 2026-09-30」`，不再是 `月份「2026年9月」`。

**面板尺寸（宿主 `src/styles.css:2109`）**：

```css
.plugin-filter-menu-panel{
  display:flex; flex-direction:column; gap:14px;
  width:100%; box-sizing:border-box;
  min-width:min(300px, calc(var(--ui-vw, 100vw) - 40px));
  max-width:min(760px, calc(var(--ui-vw, 100vw) - 40px));
  padding:16px 18px; …
}
```

`--ui-vw` 是宿主界面宽度（手机窄屏与界面缩放都跟着它），取 `min(760px, 宽度-40px)` 保证两侧永远留 20px；
`width:100%` + `box-sizing:border-box` 让它在宽窗口里铺满到上限，不再像旧版那样浮在中间一小块。

## 四、自愈逻辑也一起换成范围版

原来「第一页一条都没命中已选月份就悄悄清掉筛选」的兜底，现在按范围判断：
**第 1 页一条都不落进 `from`/`to` 就静默清空两端并落盘**（数据源换过、日期填错、旧月份失效都会走到这里）。
换源、删源回落、一键清除三处也都改成清 `from`/`to`。

> 注意这条与测试的耦合：范围是 `2026-01-01~2026-01-31`、数据却是 9 月时，自愈会先把范围清掉，
> 于是走不到「空态里仍列出生效范围」那条断言。该用例改成命中但被「只看未读」滤光的范围。

## 五、证据

**真插件 + 真宿主 CSS + 无头 Chrome**（工作区里的 `main.js` 与 `styles.css`，`window.tide` 只打桩 http/storage：

```
改前：面板 520px 宽（x 200→720）· 高约 390px ·「月份」11 个按钮占 3 行
改后：面板 705px 宽（x 200→905，上限 760px）· 高约 272px ·「时间」行只有 1 行
      从 [2026/09/01] ~ 至 [2026/09/30] [✕ 不限]  发布日在 2026-09-01 ~ 2026-09-30 里，命中 2 条
      状态行「拉取 20 条 · 显示 2 条」              ← 范围筛选真在生效，不是只画了个框
窄屏（500px 窗口）：scrollWidth == viewport（无横向溢出），日期行不折行
```

改前图用的是 `git show HEAD:` 取的旧插件源码 + 旧 `styles.css` 里的旧面板规则（同一张页面骨架），
所以「520 → 705」这个宽度差是尺寸规则真变了，不是把新 CSS 混进了旧图。

**单测** `scripts/test-gx-news.mjs`：月份那 4 条改成范围用例，另加 5 条 ——
两端都填命中 / 只填 `from` / 只填 `to` / 填反自动交换 / 旧 `month` 迁移并落盘；
③ 切源用例的 `filter` 也换成了 `from`/`to`。测试里新增的助手 `rangeNode/rangeChars/rangeHint/rangeClearDisabled/fillRange/clearRange`
都是真读真写 DOM 元素，不 mock 视图。

## 六、兼容与影响面

- 插件版本 0.8.0 → 0.9.0（用户可见的筛选行为变了）；宿主 0.206.2 → 0.207.0。
- **只改桌面插件**：小程序侧 `miniprogram/pages/plugin/index.js` 的竞赛雷达仍走原来的月份逻辑，本轮没动
  —— 用户给的是桌面形态截图，两边布局不一样，一起改风险更大。
- 存档只有 `gx-news` 自己的 `filter` 键被迁移，不碰宿主数据；迁移是幂等的，`month` 落盘一次后不会再出现。
- 面板宽度规则在宿主，所以**所有**用 `.plugin-filter-menu-panel` 的插件一起变宽（gx-news 是当前唯一使用者）。

## 七、本版没动、但记下来的一笔

`.gx-range` 里两个日期框在**更窄**的屏（约 320px）上会折成两行 —— 500px 时仍是一行，没有横向溢出。
真要收窄到一行，得把两个框的 `flex` 基准改小或者换成「点一下弹日历」的弹层，本版没做。

## 八、验证命令

```bash
cd le-time-management
node ../tools/sync-version.js --check
node ../tools/gen-theme-dark.js --check
node ../tools/build-schedule-plugin.js --check
node ../tools/sync-android-native.js --check
npm test
```

> 升版本后 `sync-android-native.js --check` 会先红一次：`sync-version.js` 改了 `src-tauri/tauri.conf.json` 的 version，
> 而 `src-tauri/gen/android/app/src/main/assets/tauri.conf.json` 是它的镜像副本。跑一次不带 `--check` 的同步命令即可，别当异常。

---

**一句话**：筛选面板里那排「只能选整月、还越选越长」的月份按钮，换成了自己填起止日期的两个日期框
（比的是补零字符串，两端都含当天，留空即不限），顺手把面板从 520px 放宽到 705px ——
同一个面板，月份三行按钮没了，时间一行就填完，面板还比原来矮了 118px。
