# v0.233.0 · 等待蒙版推广到全部刷新等待界面

> 归属说明：改动进 `le-time-management/src/`、`le-time-management/public/`（均属「必须升版本」的目录），
> 随 v0.232.0 之后的 v0.233.0 发布（新增可复用能力与界面 → minor +1）。
> 校验：`node ../tools/sync-version.js --check` → ✓ 三端版本一致 v0.233.0；
> `gen-theme-dark.js --check` / `build-schedule-plugin.js --check` / `sync-android-native.js --check` → ✓；
> `npm test` → **142 个测试脚本全部通过**（本次新增 `test-wait-mask.mjs`）。

## 起因

v0.232.0 只给**首屏启动**加了蒙版。用户接着要求：

> 给其他需要刷新等待时间的界面也添加这种蒙版。

## 判断标准（先定边界，再动手）

蒙版盖住整屏，所以只在**「纯网络等待 + 用户此刻无事可做」**时出现。三类一律不盖：

| 情形 | 例子 | 为什么不盖 |
|---|---|---|
| 中途需要用户输入 | cppu-notify 一卡通（要过验证码 / 走浏览器登录） | 蒙版会挡住输入框，用户没法操作 |
| 本身有有价值的进度文字 | cppu-notify 获奖名单同步（`正在读正文筛选 12/60`） | 盖住反而看不见进度 |
| 纯本地同步渲染 | 核心视图 quadrant / timeline / timeblock / inbox | 根本没有等待 |
| 自带开关动画且极快 | 插件启停开关 | 盖一层只会每次闪 |

## 改了什么

### 1. 共用等待蒙版（`src/waitMask.js`，新增）

与启动蒙版同源同貌（同一颗 `brandWordmark.js` 出的哥特字标 + 装饰线），但语义不同：

- **延迟出现** `SHOW_DELAY_MS = 180` —— 快操作不闪一下白。
- **最短停留** `MIN_VISIBLE_MS = 420` —— 一旦显示就至少停这么久，避免「闪一下又走」。
- **引用计数** —— 多个等待并发时蒙版只留一颗，文案取**最新**那条（最贴近用户当下在做的事），
  并挂一枚 `×N` 角标；`pending` 空了才撤。
- **兜底上限** `MAX_HOLD_MS = 120000` —— 插件异常 / 视图被拆走导致 release 永不落地时，
  自动撤下并 `console.warn`，不会永久锁死整屏。
- 半透明（`color-mix(in srgb, var(--bg) 86%, transparent)`）+ `z-index: 2500`，
  **压在应用弹窗（2400）之下、内容之上**；启动蒙版 `.refresh-mask` 仍是 2600 不透明。
- 文案长短自适应三档：默认 `brand`（品牌名，34px）/ `compact`（短说明，20px）/
  `wide`（长说明，`min(34px, (100vw - 48px) / var(--wait-mask-em))`，保证不横向溢出）。
  除数 `--wait-mask-em` 是**按标签估宽算出来的**（汉字 1em、拉丁/数字 0.55em，由 `waitMask.js`
  的 `estimateEm()` 写上来），不是写死的常数 —— 详见下面「两处收尾修正」。
- 减少动效（`prefers-reduced-motion` 或 `:root[data-ui-motion="reduced"]`）直接落位，不淡入不淡出。

### 2. 宿主 API（`src/pluginHost.js`）

`ui` 段新增两个方法，插件用 `tide.ui.waitMask(...)` 取用：

```js
const release = tide.ui.waitMask("正在刷新课表…");   // 返回幂等的 release
await tide.ui.waitMaskRun("正在刷新课表…", () => fetchAll());  // 抛错也会撤
```

- 每次调用都登记进 `pluginWaits: Map<pid, Set<release>>`，**每插件一个 Set**（O(1) 增长）；
  逐次注册进 `pluginDisposers` 会让那个列表无限变长。
- `releasePluginWaits(pid)` 在 `removeRegistrations()` 与 shell 切走插件视图时调用 ——
  视图都拆了蒙版还留在屏上是最难查的一类 bug。
- `waitMaskRun` 内部**不**用 `this.waitMask`：插件可能把函数摘下来单独调用，那时 `this` 就丢了。

### 3. 插件接线

每个插件都自带一份带守卫的 helper（插件没有模块系统，拿不到 `src/*.js`）：

```js
const waitMask = (text) =>
  (tide.ui && typeof tide.ui.waitMask === "function" ? tide.ui.waitMask(text) : () => {});
```

老宿主没有这个 API 时退化成空操作，而不是抛错 —— 插件 zip 可能被装到旧版本应用上。

| 插件 | 接在哪儿 |
|---|---|
| `cppu-notify` | `main.js` 门户通知刷新 / 载入；`calendar.js` 同步教务学期；`growth.js` 学生成长数据；`profile.js` 个人信息 |
| `chaoxing-notify` | `main.js` 刷新 / 完整同步 / 载入学习通 |
| `school-notice` | `main.js` 拉取站点、自动适配站点、读更多分页 |
| `shiguang-schedule` | `ui.js` 读学校索引、准备教务适配脚本 |
| `rss-reader` | `main.js` `refreshAll()` 抓取订阅源 |
| `gx-news` | `main.js` 抓取消息 |
| `cn-holiday` | `main.js` 读节假日数据、读某年数据、联网更新 |

- `shiguang-schedule/main.js` 是生成物：**只改了 `ui.js`**，再跑 `node tools/build-schedule-plugin.js`
  重新生成；测试同时断言 `ui.js`（事实源）与 `main.js`（生成物）都带调用点。
- 17 个内置插件的 `manifest.json` 全部已声明 `"ui"` 权限，无需改清单。

### 4. 其他接入点（`src/shell.js`）

- **导入插件 zip** 整段包进 `withWaitMask("正在导入插件…", …)`：解压 + 重新扫描插件目录
  几百毫秒到数秒，期间界面原本完全没反馈。
- 切走 `plug:` 视图时 `releasePluginWaits(pluginId)`。

### 5. 插件版本号

插件行为改了，按仓库惯例升 manifest 的 `version`（`node ../tools/sync-plugins.js` 同步三端 `pluginCatalog.js`）：

| 插件 | 版本 |
|---|---|
| cppu-notify | 1.56.0 → 1.56.1 |
| chaoxing-notify | 2.19.0 → 2.19.1 |
| school-notice | 1.8.0 → 1.8.1 |
| shiguang-schedule | 3.16.0 → 3.16.1 |
| rss-reader | 1.7.0 → 1.7.1 |
| gx-news | 0.9.0 → 0.9.1 |
| cn-holiday | 0.3.0 → 0.3.1 |

三条把版本号**故意钉死**的守卫同步更新：`test-chaoxing-card-color.mjs`、`test-rss-reader.mjs`、
`test-cn-holiday.mjs`（另 `test-cn-holiday.mjs` 还断言 `pluginCatalog` 里的版本号）。

`rss-reader/main.js` 的 SHA256 被 `miniprogram/core/rssModel.js` 的表头记着，故同步跑了
`node tools/sync-miniprogram-models.js`（改动落在抽取区间之外，小程序模型内容不变、只有表头哈希变）。

## 测试（`scripts/test-wait-mask.mjs`，新增）

用最小 DOM 替身**真跑** `src/waitMask.js`（不引 jsdom），守四类事故：

1. 快操作不闪（延迟期内结束 → 一次都不出现，且延迟定时器必须被清掉）。
2. 已显示的不许瞬闪（最短停留）。
3. 并发与生命周期（最新标签 / `×N` / 幂等 release / 抛错也撤 / 兜底上限 / reset 不留脏标签与孤儿定时器）。
4. **接线不许掉**：7 个插件必须有 `tide.ui.waitMask` 调用点，`pluginHost` 必须真的转发到 `showWaitMask`，
   `waitMaskRun` 必须在 `finally` 里 release，CSS 的 `200ms` 必须与 `waitMask.js` 的 `FADE_MS` 相等。

## 两处收尾修正（都靠无头浏览器实拍量出来）

### 1. 窄屏下蒙版一个字都没有（**v0.232.0 的启动蒙版同样中招**）

`styles.css` 在 `@media (max-width: 900px)`（窄屏底栏模式）里有一条

```css
.brand { display: none; }   /* 底栏模式没地方放字标 */
```

蒙版里的字标也是 `.brand`，于是**任何 ≤900px 的视口（全部手机、窄窗口）上，
蒙版只剩一块纯色，一个字都不显示**。桌面窗口默认 >900px，所以此前没暴露。

修法是给两颗蒙版各加一层选择器把 `display` 还原回来（`.refresh-mask .brand` 的特异性
高于 `.brand`，与源序无关）：

```css
.refresh-mask .brand { display: flex; padding: 0; }
.wait-mask    .brand { display: flex; padding: 0; }
```

`test-wait-mask.mjs` 加了两条守卫：先断言那条 `@media (max-width: 900px) { .brand { display: none } }`
仍然存在（前提变了守卫要跟着改），再逐个断言两颗蒙版的 `.brand` 都显式写了 `display: flex`。

### 2. 宽档除数写死 `9.6` 会在窄屏上顶出屏幕

`(100vw - 48px) / 9.6` 假设标签大约 10 个字宽。实际标签最长 12 个汉字
（`正在读取站点并自动适配…`），每个汉字占 1em ⇒ 除数应该是 12 而不是 9.6。

320px 视口实拍对照（可用宽度 `100vw - 40px = 280px`）：

| 除数 | 实测文字宽度 | 结果 |
|---|---|---|
| `var(--wait-mask-em)` = 12（修好后） | **281px** | 收在视口内，左右各留 19/20px |
| 写死 `9.6`（修之前） | **314px** | 顶到视口两边（x 3 ~ 316），字被切 |

改法：`waitMask.js` 在 `wide` 档把估宽写进 `--wait-mask-em`（`estimateEm()`：汉字 1em、
其余 0.55em；离开 `wide` 档时 `removeProperty`，免得短标签借到上一个长标签的除数）。
1200px 桌面实拍：三档都落在 34px 上限上，409px 宽，同样不溢出。

> 方法说明：本会话视觉模型不可用，改用 `vision_html_screenshot` 出真图 +
> Pillow 逐像素探针（非背景像素的包围盒）量文字实际宽度，而不是靠肉眼或模型描述。

## 影响面

- 桌面与 Android：各插件重活期间多一层蒙版；无数据与接口改动。
- 小程序：不跑插件，无影响。
- 数据：无迁移，`letime-data` 结构未动。
- **窄屏（≤900px）是本版的主要受益面**：v0.232.0 的启动蒙版在手机上原本是空白的，
  本版一并修好。
