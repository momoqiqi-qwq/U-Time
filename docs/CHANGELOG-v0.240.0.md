# v0.240.0 · 网页收集：删掉「打开」按钮，点卡片直接开网站

> 归属说明：改动进 `le-time-management/public/plugins/web-collector/main.js`
> 与同目录 `manifest.json`（均在「必须升版本」的目录里），卡片交互调整 → minor +1：
> `0.239.0 → 0.240.0`；插件清单 `1.8.0 → 1.9.0`（`tools/sync-plugins.js` 已同步两端 catalog）。
> 校验：`sync-version.js --check` → ✓ 三端版本一致 v0.240.0。

## 起因

用户需求原文：

> 竞赛信息删除打开按钮，直接点卡片就可以打开了

截图是网页收集（web-collector）卡片翻起后的详情层，里面那排动作是
「打开 / 保存修改 / 换图标 / 刷新名称·图标 / 删除」。要的是把「打开」收进卡片本身。

## 判断标准（先定边界，再动手）

| 决策 | 选了什么 | 为什么不选另一条 |
|---|---|---|
| 卡片点击做什么 | `.wc-front` 由 `data-more` 改成 `data-open`，点卡片任意处直接打开网站 | 只把按钮从模板里删掉、点击仍旧翻面：「点卡片就能打开」落不了地 |
| 翻面入口放哪 | 卡片右上角补一颗 26×26 的「⋯」（`[data-more]`），与详情层的「收起」共用同一标记 | 靠右键 / 长按翻面：手机端长按与系统菜单打架，桌面端右键又不显眼；把编辑、换图标、删除埋进隐式手势等于让它们消失 |
| 悬停自动翻还留不留 | **撤掉**整段 `@media (hover:hover) and (pointer:fine)` 的 `.wc-card:hover .wc-front{pointer-events:none}` | 不撤就永远点不到正面：鼠标一进入卡片正面就透明且不吃指针，点击落到正在立起的详情层上 |
| 键盘可达性 | `.wc-front` 本来就是 `<button>`，回车即触发 click；详情改走 Tab 到「⋯」；补 `:focus-visible` 描边 | 删了按钮又只留鼠标路径 = 键盘用户彻底没有入口 |
| 详情层里那颗「打开」 | 删掉 | 同一件事两个入口，正是这次要收掉的冗余 |
| 翻开时「⋯」与「收起」重叠 | `.wc-card.is-flipped .wc-more{opacity:0;pointer-events:none}` | 两颗按钮同处右上角，不藏那颗会互相压住 |

## 改了什么

- `public/plugins/web-collector/main.js`
  - 模板：`.wc-front` 从翻转按钮改为打开按钮（`data-open` + `aria-label="<站名>：打开"`）；
    新增 `.wc-more`（`data-more`，`aria-expanded` / `aria-controls` 照旧同步）；
    详情层 `.wc-actions` 删掉 `<button data-open>打开</button>`，其余四颗动作不动。
  - CSS：新增 `.wc-more` 及其 hover / `is-flipped` 两态、`.wc-front:hover .wc-title`、
    `.wc-front:focus-visible`；删除悬停自动翻两条规则；`prefers-reduced-motion` 里只留 `is-flipped` 一态。
  - 注释同步改掉「正面整块就是翻转按钮」「悬停即翻」这几处旧说法，免得下一个人照着改回去。
- `public/plugins/web-collector/manifest.json`：版本 1.9.0，描述改成「点卡片直接打开，右上角『⋯』翻起详情」。
- `tools/sync-plugins.js` 重跑：桌面 `src/pluginCatalog.js` 与小程序 `core/pluginCatalog.js` 的版本/描述随动。

## 验证

- 真浏览器探针（无头 Chrome + 只 stub `tide` 的临时页，跑完即删）17 条断言全过，关键几条：
  正面是 `data-open`、正面不再带 `data-more`、`[⋯]` 落在卡片右上角 26×26 可点、
  详情层动作只剩「保存修改/换图标/刷新名称·图标/删除」、点卡片命中 `wc-front` 并调起 `openUrl`、
  点「⋯」翻面且不误触打开、「收起」能翻回、CSS 里已无 `.wc-card:hover .wc-detail`。
- 截图：`output/preview/wc-card-open.png`（深色主题，三张卡右上角各一颗「⋯」，卡内无「打开」）。
- `npm test` → 147 个测试脚本全部通过；`sync-android-native.js --check` ✓。
  `scripts/test-web-collector.mjs` 里新加四条静态守卫：正面必须是 `data-open`、不许退回 `data-more`、
  详情层不许再有「打开」按钮、右上角 `data-more` 就是 `.wc-more`、不许恢复悬停翻面导致点不到。
