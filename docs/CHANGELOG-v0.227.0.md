# v0.227.0 · 一卡通图形统计从「塞在角落的小图」放大成能看清的图表

> 本条只动 `cppu-notify` 插件的图形统计模块与它的测试，不涉及数据迁移。
>
> | 门禁 | 结果 |
> |---|---|
> | `node ../tools/sync-version.js --check` | ✓ 三端版本一致：v0.227.0 |
> | `node ../tools/sync-plugins.js --check` | ✓ 17 个内置插件三端同源 |
> | `node ../tools/gen-theme-dark.js --check` | ✓ 派生调色板已同步（15 套深色变体） |
> | `node ../tools/build-schedule-plugin.js --check` | ✓ 生成物与源一致 |
> | `node ../tools/build-exam-calendar-plugin.js --check` | ✓ 生成物与源一致 |
> | `node ../tools/sync-android-native.js --check` | ✓ Android 原生与清单声明一致 |
> | `py ../tools/gen-plugin-icons.py --check` | ✓ 图标三端同源 |
> | `npm test` | ✓ `PASS: 139 个测试脚本全部通过` |

## 动的文件

| 文件 | 改了什么 |
|---|---|
| `le-time-management/public/plugins/cppu-notify/card-charts.js` | 折线图 viewBox 宽度改为容器实测宽度；环图独立尺寸；新增 `plotWidth` / `donutWidth` 导出；星期分布卡改整行；`styles()` 全面放大并把网格默认改单列；新增 resize 重画 |
| `le-time-management/scripts/test-cppu-card-charts.mjs` | 新增尺寸与布局断言（viewBox、环图尺寸、`cc-wide` 计数、单列/两列断点、轴字走 `--ui-text-scale`），以及 `plotWidth` / `donutWidth` 的纯函数断言 |
| `le-time-management/public/plugins/cppu-notify/manifest.json` | 1.55.3 → 1.55.4 |
| `le-time-management/src/pluginCatalog.js`、`miniprogram/core/pluginCatalog.js` | 由 `tools/sync-plugins.js` 从清单生成 |
| 版本号 | `package.json` / `package-lock.json`（两处）/ `Cargo.toml` / `tauri.conf.json` / `appMeta.js` / Android `versionName`+`versionCode` → v0.227.0 |

## 用户要求

> `一卡通图形化界面有点太小了`

（随附一张一卡通界面的截图）

## 一、以前为什么那么小：三个原因叠在一起

不是「整体字号调小了」这么简单，而是三处各自独立的收缩叠在同一块上：

| # | 改前 | 后果 |
|---|---|---|
| 1 | `.cc-grid{grid-template-columns:repeat(2,minmax(0,1fr))}` —— **不管窗口多窄都强行两列**，只有 `<720px` 才塌成单列 | 1080px 以下的窗口里，消费结构与地点排行都挤在**半栏**里（1280 下也只有 609px） |
| 2 | `trendChartHtml` 固定 `viewBox="0 0 640 210"`，靠 `.cc-svg{width:100%;height:auto}` 拉伸 | SVG 里的长度是**用户单位**，会随 viewBox 一起缩放：半栏里缩到约 0.9 倍，轴字从 11 掉到 ~10px；而它写死 `11px`、**不吃 `--ui-text-scale`** —— 用户把界面字号调大，图上的字一动不动 |
| 3 | `.cc-svg,.cc-donut-svg` 共用 `{display:block;width:100%;height:auto}`，而 `.cc-donut-svg{flex:1 1 168px;max-width:220px}` | 环图被 flex 压到 168px，220 的 viewBox 缩到 0.76 → 中心金额 15px 变 **11.4px**、标签 10px 变 **7.6px** |

第 3 条尤其致命：环图最该看清的就是中心那个金额，而它恰好被压得最小。

## 二、现在怎么改

一句话：**让图的尺寸跟着容器走，而不是让容器去迁就图。**

| 改法 | 细节 |
|---|---|
| 默认单列 | `.cc-grid{grid-template-columns:1fr}`；只有 `@media(min-width:1080px)` 才 `repeat(2,minmax(0,1fr))`。窄窗口里每张图吃满面板宽度 |
| 折线图 viewBox = 容器实测宽度 | `plotWidth(root)` 量 `.cc-panel` 的 `clientWidth` 减 66px（panel 内边距 16×2 + 卡片内边距 15×2 + 四道 1px 边框），夹在 300–1400。**1 用户单位 = 1 CSS 像素 ⇒ 缩放比恒为 1**，SVG 里的字就是字 |
| 轴字跟随界面字号 | `.cc-axis{font-size:calc(12.5px * var(--ui-text-scale))}`（11px 写死 → 12.5px 可缩放） |
| 环图独立尺寸 | `donutWidth(plot)` 取 `plot * 0.42` 夹在 176–248，`viewBox` 与内联 `width/height` 同步；`.cc-donut-svg{flex:0 0 auto}` 不再被 flex 压缩；中心金额 15 → 19px |
| 整体上调 | 卡片标题 12 → 13.5px、正文 10.5 → 11.5px、排行条 14 → 18px 高、星期柱 84 → 112px 高、面板标题 13 → 15px、单选按钮 34 → 38px 高 |
| 星期分布卡改整行 | 它以前在两列布局里独自占半行，另一半空着；现在加 `cc-wide` 与折线图一样吃满宽度 |
| 窗口变化自动重画 | `resize` 里比较 `plotWidth`，差值 ≥24px 才重画（避免抖动），`dispose()` 里摘掉监听 |

## 三、验证：量真实几何，不靠截图

**这一条要说清楚，因为它决定了验证方式。** 本会话的视觉链路读不了图（视觉模型不接受图像输入，`vision_describe` 直接返回「当前模型不支持图像输入」），所以不能「截图看一眼」。改用无头 Chrome 的 `--dump-dom` 加一个探针页，量真实渲染后的几何：

- 探针页加载真的 `card-charts.js`（`await import('/public/plugins/cppu-notify/card-charts.js')`）、真的 `src/styles.css` + `theme-derived.css`，喂 17 条 fixture 流水，然后把 `getBoundingClientRect` / `getComputedStyle` 的结果写进 DOM，由 `--dump-dom` 读回。
- **顺带发现一个既有工具的边界**：`tools/plugin-preview.mjs` 的产物 HTML 里 `cc-panel` / `cc-line` / `card-chart-style` 命中数**全是 0** —— 因为 `card-charts.js` 是动态 `import("/plugins/…")`，harness 的 VM 解析不了这个路径。所以**预览页截图这条路验证不了图形统计**，以后改这块别在预览页上找它。

| 窗口宽 | 布局 | 折线图 SVG | 它的 viewBox | 缩放比 | 轴字 | 环图 | 星期柱高 |
|---|---|---|---|---|---|---|---|
| 1280 | 两列 609 + 609 | 1198×236 | `0 0 1198 236` | **1.00** | 12.5px | 248×248 | 112px |
| 1000 | 单列 950 | 918×236 | `0 0 918 236` | **1.00** | 12.5px | 248×248 | 112px |
| 900 | 单列 850 | 818×236 | `0 0 818 236` | **1.00** | 12.5px | 248×248 | 112px |
| 500 | 单列 472 | 444×241 | `0 0 434 236` | 1.02 | 12.5px | 182×182 | 88px |

`plotWidth` 的算式在 1280 下实测校验：面板 1264 → 折线图 viewBox 1198 = 1264 − 66，与预算完全一致。

## 四、边界

- 只放大、不改变口径：图仍然只用本机已同步的一卡通流水（接口单次最多回 5000 笔），平台口径那一块照旧要点一下才读。
- 并排只在 ≥1080px 出现，且两列时每张仍有约 600px；再窄就单列，不做「三列」「横向滚动」这类新交互。
- `--ui-text-scale` 现在会同时放大 SVG 轴字。这是有意的：以前它不跟随，属于漏接。
- resize 重画有 24px 死区，避免拖动窗口时反复重排。

## 五、版本归属

`v0.226.0` 是个人成长中心（pdata）自动登录补全，本条在其之后，取 `v0.227.0`。插件清单 `1.55.3` 归上一条、`1.55.4` 归本条。

## 六、测试

`le-time-management/scripts/test-cppu-card-charts.mjs` 新增的断言：

- 尺寸与布局：回退宽度下 `viewBox="0 0 620 236"`、环图 `viewBox="0 0 248 248" style="width:248px;height:248px"`、`class="cc-card cc-wide"` 恰好 2 个（折线图 + 星期分布）。
- CSS 契约：`.cc-grid` 默认 `1fr`、`@media(min-width:1080px)` 才两列、`.cc-axis` 用 `calc(12.5px * var(--ui-text-scale))`、`.cc-week-track` 高 112px、且 `.cc-donut-svg` **不再**含 `flex:1 1 168px`。
- 纯函数：`plotWidth({clientWidth:766})===700`、`plotWidth({querySelector:()=>({clientWidth:486})})===420`、`plotWidth({clientWidth:200})===620`（低于 280 走回退）、`plotWidth(undefined)===620`；`donutWidth(700)===248`、`donutWidth(400)===176`、`donutWidth(1000)===248`。
