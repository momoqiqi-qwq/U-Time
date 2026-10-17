# v0.241.1 · 个人信息：补上「数据报告目录」

> 归属说明：改动进 `le-time-management/public/plugins/cppu-notify/profile.js`
> （在「必须升版本」的目录里），新增一块界面 → minor +1：`0.240.0 → 0.241.1`。
> 校验：`sync-version.js --check` → ✓ 三端版本一致 v0.241.1。

## 起因

用户需求原文：

> 个人信息下面太空了，看看获取信息的网址还有什么可以加到下面去的

截图是「校园服务 → 个人信息」：身份卡 + 5 个档案字段，卡片下面一大片空白。

## 为什么不是「再多画几个字段」

档案字段不是写死的，是 **自适应** 的 —— `buildFields()` 遍历接口返回的 `column[]`，
接口给几项就画几项（`profile.js` 里那条兜底只在 `column` 少于 3 项时才扫 `personInfo` 的键）。
只有 5 项，说明 `personInfo` 真的只回了 5 项。**再想加字段，得换一个接口，不是改渲染。**

## 判断标准（先定边界，再动手）

| 决策 | 选了什么 | 为什么不选另一条 |
|---|---|---|
| 加什么 | 「数据报告目录」——`/tsa/shc/customStyle/getModuleList` 里学校配给在读学生的全部报表 | 同一份 pdata token、同一条取数通道、无需新增鉴权；且 `basicInfo` 本来只是这一组里的**一个**目录，这条清单正是「这个网址还有什么」的答案本身 |
| 为什么不加学业 / 考勤 / 奖惩数值 | 不加 | `growth.js`（学生成长）已经把这几个接口的图表做完；个人信息页再抄一遍就是两页说同一件事，且「档案」与「动态」混在一起反而更糊 |
| 为什么不加个人二维码 | 不加 | 真机返回里根本没有 `QRCodeUrl`（`docs/CHANGELOG-v0.229.1.md` 实测 `keys=[personPhoto,column,personInfo]`），要自己拼 `?token=&userId=` 才可能出图，见 `docs/CHANGELOG-v0.223.0.md` |
| 取数时机 | **第二屏**：档案先落地并 `paint()`，目录到了再补一版 | 首屏不该等第二个接口 —— 与 `growth.js` 分两批落画面同一条理由 |
| 目录接口失败 | 静默，整张卡不渲染 | 这一块不是本页主体；弹一条红色告警只会盖掉「字段能复制」这件真正有用的事 |
| key 怎么取 | `CATALOGID` / `catalogId` 直给优先，否则取 `id` 最后一个 `-` 后面那截 | 老接口只给 `"1-13-basicInfo"` 这种复合 id，那截正好是 `basicInfo` / `bookRent` 这类目录名（与 `growth.js` 的 `flattenModules` 同口径） |
| 点开走哪条路 | `bridge.open("/stu/dataReport/" + key)` | 这条路是 `main.js` 的 `openPdataLink`：先换票、再把 sso + pdata 两个域的 Cookie 注入应用内网页窗口。直接 `openUrl` 会落到统一身份认证登录页 |
| 刷新 | 档案与目录都用 `force` | 只强刷档案的话，用户按了刷新看到的还是旧目录 |

## 改了什么

- `public/plugins/cppu-notify/profile.js`
  - `state` 增 `reports` / `reportsAt`
  - 新增 `buildReports(data)`：取 `id === "1-DataReport" || name === "数据报告"` 那一组的 `children`，否则摊平；按 `key` 去重
  - `loadAllInner()` 末尾追加第二屏取数：`/tsa/shc/customStyle/getModuleList?t=<ts>`（`?t=` 只是防代理缓存，`pdataCacheKey()` 会剔掉它，所以与成长页**共用同一份缓存**，不会请求两遍）
  - 新增 `reportsHtml()` 与 `.pf-dirs / .pf-dir` 样式（网格 `auto-fill minmax(198px,1fr)`，窄屏自动单列；44px 触达高度；`:focus-visible` 描边；`prefers-reduced-motion` 下过渡归零）
  - `bind()` 增 `[data-pf-dir]` 分支
- `scripts/test-cppu-profile-reports.mjs`（新增）：盯第二屏取数、目录口径、站内直达、失败不牵连档案、刷新走 force

## 影响与边界

- 三端只是插件 JS 的变化，无数据迁移、无接口变更、无存储键变化。
- 目录条数取决于学校配置，接口不给就整张卡不出现（不是空壳）。
- 「个人信息」这个目录自己也在清单里 —— 刻意不去重：它是同一份清单的忠实呈现，剔掉反而让人以为漏了一项。

---

## 同版本内：dorm-duty 星图图注改「1. 2. 3.」六条速查

- `public/plugins/dorm-duty/manifest.json` → `1.13.1`
- `public/plugins/dorm-duty/main.js`：原来那一整段 `div.dd-note` 长文案（约 430 字、单行铺开）
  换成 `<ol class="dd-legend">` 六条 —— 床位与星号 / 值日路线 / 今天值日 / 改名与定位 /
  编辑床位 / 视角与缩放。编号与短标题沿主题语义色自上而下换色：
  `--deep → --sea → --grape → --mint → --sun → --coral`，全是 CSS 变量，切主题与深浅模式自动跟着走。
- 颜色朝 `--ink` 混（编号 45%、短标题 35%、正文 `--ink-3` 混 45%）。实测：LC 占比 72% 时
  mint / sun / coral 在白底只有 3.40 / 3.55 / 4.28:1，纯 `--ink-3` 正文 3.49:1；
  改后浅色最低 5.58:1、深色最低 7.19:1（探针取 `getComputedStyle` 实算，非估算）。
- `scripts/test-dorm-duty.mjs`：旧断言钉的是「触控板在图上直接捏合就能缩放」这句旧图注，
  改为钉新结构（`ol.dd-legend` 六条齐全、每条三段式）、六条色相落点与混色比例。

无数据迁移、无接口变更、无存储键变化；只有插件内联 CSS 与模板字符串。
