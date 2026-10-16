# v0.228.0 · 翻起式卡片的正面收成「封面」：只剩图标和名字

> 本条只动三个插件卡片正面层的排版、它们的清单描述，以及网页收集那条版本断言，不涉及数据迁移。
>
> | 门禁 | 结果 |
> |---|---|
> | `node ../tools/sync-version.js --check` | ✓ 三端版本一致：v0.228.0 |
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
| `le-time-management/public/plugins/web-collector/main.js` | 正面收成「favicon + 网站名」的封面；卡片主体变成翻转按钮；站点域名 / 备注 / 编辑框 / 动作条全进详情层 |
| `le-time-management/public/plugins/github-readme/main.js` | 正面收成「图标 + 仓库名」的封面；别名 / 备注 / 提交标题 / 分支·作者·时间·体积全进详情层；`.gh-front` 的 `min-height` 从 196 提到 236 |
| `le-time-management/public/plugins/plugin-guide/main.js` | 正面收成「插件图标 + 插件名」的封面；平台徽章 / 用途简介 / 步骤数按钮全进详情层 |
| 三个 `manifest.json` | `web-collector` 1.7.0 → 1.8.0、`github-readme` 1.4.0 → 1.5.0、`plugin-guide` 1.5.0 → 1.6.0，描述同步改写 |
| `le-time-management/scripts/test-web-collector.mjs` | 版本断言 1.7.0 → 1.8.0 |
| `le-time-management/src/pluginCatalog.js`、`miniprogram/core/pluginCatalog.js` | 由 `tools/sync-plugins.js` 从清单生成 |
| 版本号 | `package.json` / `package-lock.json`（两处）/ `Cargo.toml` / `tauri.conf.json` / `appMeta.js` / Android `versionName`+`versionCode` → v0.228.0 |

## 用户要求

> `将翻页前的卡片显示为图标+名字即可，参考图2`

（随附两张截图：本应用的插件说明页；参考图是 LabOrbit `/resources` 的卡片墙）

## 一、正面和详情层是两种信息，不该混着放

v0.219.0 把三张卡改成从底边翻起的抽屉之后，正面仍然背着「看一眼就知道全部」的包袱：

| 插件 | 改前正面 | 改后正面 |
|---|---|---|
| 网页收集 | favicon + 网站名 + 域名 + 备注（2 行截断）+ 「打开 / 更多」 | favicon + 网站名 |
| GitHub 文档 | 图标 + 仓库名 + 别名 + 备注 + 最近提交标题 + 分支·作者·时间·体积 + 「阅读 README →」+ 「更多」 | 图标 + 仓库名 |
| 插件说明 | 插件图标 + 插件名 + 平台徽章 + 用途简介（3 行截断）+ 「查看 N 步操作 ▾」 | 插件图标 + 插件名 |

结果是两层说同一件事：正面把详情层的内容提前剧透一遍，翻起来只是把字放大。而参考图那面墙的卡只有封面图 + 标题 —— 卡片在列表里是**索引**，不是**详情**。所以这次把正面的定位收敛成「这是什么」，其余全部交给翻起来的那一层。

## 二、三张卡各自怎么收

三处都改成同一个骨架：正面是 `display:flex;flex-direction:column;align-items:center;justify-content:center`，图标在上、名字在下、居中，**正面整体就是一个 `<button>`**（`data-wc-more` / `data-gh-more` / `data-pg-more`），触屏与键盘点卡片任意处都能翻。

- **网页收集**：`favicon` 的尺寸从 46 提到 52，标题允许折 3 行；域名、备注、`[data-title]` / `[data-note]` 编辑框、「打开 / 保存修改 / 换图标 / 刷新名称图标 / 删除」全部只存在于详情层。
- **GitHub 文档**：`.gh-front-ico` 是仓库图标（没有则只剩名字）；`.gh-front-name` 允许折 3 行，未读小圆点跟着名字走。别名、备注、提交标题、`分支 · 作者 · 时间 · README 体积`、错误提示和「阅读 README / 编辑 / 移除」都在详情层。
- **插件说明**：图标 30px，`.pg-front-name` 是插件名。平台徽章、用途简介、步骤数按钮都在详情层，`<ol>` 步骤仍然是详情层里唯一可滚动的部分。

正反两层的头部刻意写成同一份 `head`（图标 + 名字），翻过去不会觉得换了一张卡。

## 三、正面一旦变矮，详情层会被一起压扁（踩坑）

详情层是 `position:absolute;inset:0`，**高度跟着卡片走，撑不出自己的高度**。卡片高度完全由正面决定，所以正面的 `min-height` 不是装饰，是详情层的尺寸来源 —— 正面只放图标和名字之后，很容易顺手把 `min-height` 一起删掉或调小，那样翻起来的内容会被 `overflow:hidden` 直接切掉。

这不是推演，是实测踩到的：GitHub 文档正面原来 `min-height:calc(196px * var(--ui-text-scale))`，正面瘦身后详情层里有别名+备注的那张卡溢出 **32px**、带错误提示的那张溢出 **21px**，动作条被裁在卡片外面。修法是把 `.gh-front` 的 `min-height` 提到 `calc(236px * var(--ui-text-scale))`，同时保留 `.gh-detail{overflow:auto}` 作为兜底（备注写得特别长的用户仍然能在层内滚动，而不是看不见按钮）。

另外两个插件的正面本来就是 206px / 158px，详情层装得下，所以只改了排版没动高度。

## 四、几何验证（无头 Chrome，真 CSS 真渲染）

明暗两套主题 × 收起/翻开两态，三个插件共 12 个组合：

| 插件 | 卡片尺寸 | 翻起后详情层盖满卡片 | 正面翻开后 scale | 横向溢出 | 内容裁切 | 卡片高度变化 |
|---|---|---|---|---|---|---|
| 网页收集（2 张） | 274 × 208 | ✓ | 0.860 | 0 | 0 | 0 |
| GitHub 文档（3 张） | 960 × 238 | ✓ | 0.860 | 0 | 0 | 0 |
| 插件说明（13 张） | 343 × 160 | ✓ | 0.860 | 0 | 0 | 0 |

`elementFromPoint` 在卡片矩形内 3×3 采样：收起时 9 点全部命中正面层，翻开时 9 点全部命中详情层 —— 说明翻起后没有「点得到的背面」漏在外面。三个插件的 `perspective` 实测都是 `1000px`（写在卡片本体上）。

## 五、边界

- 图标位置和尺寸在三个插件里各自独立（52 / 34 / 30px），没有抽公共 CSS —— 插件是三个独立文件、各自 `ensureStyle()` 注入 `<style>`，抽公共样式反而要新建一个共享文件并让三端生成器都认它。
- 正面变矮之后，「打开链接」「阅读 README」这类主操作都要先翻起来才能点。桌面靠悬停即翻（`@media (hover:hover) and (pointer:fine)`）抵消，触屏是「点卡片 → 点按钮」两步。这是「正面只做索引」的必然代价，不是遗漏。
- `prefers-reduced-motion` 下三个插件都走 `transition:none!important`，翻起退化成瞬时切换，两层内容与 `aria-expanded` 照旧。

## 版本归属

v0.219.0 是「三张卡片改成从底边翻起的抽屉」，本次 v0.228.0 是「把抽屉的正面收成封面」，两次都在同一组插件上；`package.json` 从 0.227.0 到 0.228.0。
