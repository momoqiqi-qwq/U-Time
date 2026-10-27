# v0.287.0 · 插件中心：卡片边缘出「可调大小」双箭头 + 多入口卡片高度自适应

用户反馈：插件中心的卡片能拖动改大小（v0.181.0 起），但拖动之前**没有任何提示**，
指针停在卡片边缘也还是普通箭头，根本看不出这块能拉大拉小；
要的是鼠标落到卡片边缘时直接变成调节大小的双箭头（就是那个 ↕ ↖↘ 的箭头）。

接同一版的多入口卡片高度修复（见下节「多入口卡片高度按内容自适应」）—— 光标这条只动光标，几何与落位逻辑一个字没改。

---

## 改动

| 位置 | 现在 |
|---|---|
| `src/marketCardResize.js` | 新增纯函数 `edgeResizeCursor(rect, x, y, ring)`：按指针落在哪条边/哪个角给出 `ew-resize` / `ns-resize` / `nwse-resize` / `nesw-resize`，中间区域返回空串 |
| 同上（`attachMarketCardResize`） | 网格上挂 `pointermove`（被动）与 `pointerleave`：边缘那一圈给卡片加 `.market-edge-resize` 并把方向写进 `--market-card-edge-cursor`；回到中间、离开网格、开始拖动、卸载时全部收干净 |
| `src/styles.css` | `.mcard.market-edge-resize { cursor: var(--market-card-edge-cursor, nwse-resize) }` |

## 边界（刻意保留的行为）

- **中间区域不换光标**：卡片本体是「点一下打开插件」的入口，整张卡都变成调节柄会误导点击。
- **触屏不介入**：没有 hover 语义，且触屏拖动本身不改尺寸（`pointerType !== "mouse"` 直接放行）。
- **卡片上的开关 / 「⋯」**：它们是按钮，光标仍是手型，不会被边缘规则抢走。
- 边缘宽度 `EDGE_RING = 10`（屏幕视觉 px），与界面缩放无关地保持同样手感。
- 拖动中仍由整页 `--market-resize-cursor`（带 `!important`）接管，悬停态先收掉，两者不打架。

## 多入口卡片高度按内容自适应

同一版里另一件事（用户原话「自动适配框大小」，截图是插件中心那张 13 个入口的「警大门户通知」卡片）：

| 位置 | 现在 |
|---|---|
| `src/styles.css` | 新增 `@media (min-width: 901px) { .market-grid .mcard.has-views { height: auto; min-height: var(--market-card-h, auto) } }` |
| `scripts/test-market-card-fit.mjs` | 新测试：桌面端自适应规则在位、普通卡片仍听拖动值、窄屏兜底没被删、`has-views` 按入口数实时同步 |

问题：卡片高度是用户拖动出来的**一个像素值**（`--market-card-h`，全体共用），而入口胶囊的行数
取决于插件自己注册了几个视图（`cppu-notify` 注册 13 个）。高度写死 + `overflow:hidden` 必然裁内容。

现在：入口 > 1 的卡片 `height` 交回内容、拖动值降为**下限**（`min-height`）；
普通卡片的 `height: var(--market-card-h)` 与 `overflow:hidden` 一个字不动 ——
v0.214.3 修的「往下拖时卡片跟手缩小」的手感、以及内容外溢防护都还在。

## 影响面

- 三端版本：`0.286.0 → 0.287.0`（`0.286.1` 从未单独发版，两件改动一起随本版出）
- 光标那条只有桌面鼠标路径有变化；Android / 触屏、插件页内部一律无影响
- 卡片高度这条只在桌面 ≥901px 生效，窄屏紧凑列表仍由 `.market-manage-card{height:auto}` 接管
- `scripts/test-market-card-resize.mjs` 补 11 条边缘方向断言 + 4 条悬停/收起/触屏断言
- `scripts/test-ui-scale.mjs` 的 901px 断点数 `5 → 6`（新增的高度自适应那一处）
- 六道生成器 `--check` 与 `npm test` 全绿
