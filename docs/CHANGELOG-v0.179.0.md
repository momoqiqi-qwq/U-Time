# v0.179.0 · 值日星图支持触控板捏合缩放（滚轮缩放改成「按位移等比」）

## 改了什么

**用户需求原文**：「让它的放大缩小功能支持触控板上的捏合手势。」
（配图是「轮换值日」插件里的 **宿舍床位 · 值日星图**。）

改动只落在 `public/plugins/dorm-duty/main.js` 的星图缩放上，插件版本 `1.10.0 → 1.11.0`。

### 之前为什么「捏合不可用」

触控板捏合在 Chromium 里走的是**带 `ctrlKey` 的 wheel**（与鼠标 `Ctrl+滚轮` 同一条路），
事件又密又碎：一次捏合几十上百个事件、每个 `deltaY` 只有个位数像素。
而旧实现是：

```js
state.roomView.dist = Math.max(0.55, Math.min(1.9, v.dist * (1 + Math.sign(e.deltaY) * 0.09)));
```

`Math.sign` 只取方向、丢掉位移大小 ⇒ **按「事件个数」跳档，每个事件固定 9%**。
一次捏合的第一帧就把 `dist` 顶到上下限，手感是「一捏就飞到底」，用户看到的就是「捏合没反应 / 界面坏了」。
另外两处同族问题：

- **每个事件都 `save()`**：`save()` 里是 3 次 `tide.storage.set`，一次捏合 = 几百次写盘，落盘链被堵住后画面跟着卡。
- **不认 `deltaMode`**：Firefox / 部分鼠标驱动报的是「行」（`deltaY = 3`），当成 3px 处理就是「缩放几乎不动」。

### 现在的做法：指数映射，按位移等比

```js
const ROOM_ZOOM_MIN = 0.55, ROOM_ZOOM_MAX = 1.9;   // 与 roomView() 的夹取同源
const ROOM_ZOOM_PINCH_GAIN = 0.0024;   // 触控板捏合（ctrl+wheel）
const ROOM_ZOOM_WHEEL_GAIN = 0.0018;   // 鼠标滚轮 / 触控板两指滚动
const ROOM_ZOOM_MAX_PX = 50;           // 单次事件的位移上限
```

- 新纯函数 `roomZoomDist(dist, wheelEvent, pagePx)`：`dist × Math.exp(px × gain)`。
  指数映射天然等比且**可逆** —— 手势滑多少距离就缩放多少倍，快慢不影响总量，中途反向能原路退回。
- `roomWheelPx()` 先把 `deltaMode` 折算成像素（行 = 16px、页 = 视口高度、拿不到就兜底 400px）。
- **单帧位移夹到 ±50px**：一次超大 `delta` 不许一帧跳过整段行程（单帧最多约 13%）。
- 手感对齐旧版：鼠标滚轮一格（Chrome 报 100px）实测 **1.0942 ≈ 9%**，与原来的 9% 基本一致。
- **绑定从 `[data-room]` 挪到整张卡片**（`host.closest(".dd-room-card") || host`）：卡片四周的空档也能捏合；
  `preventDefault()` 顺带压掉 WebView2 自己的整页缩放 —— 不压的话在星图上捏一下，整个界面跟着变大。
- **落盘改成停手 400ms 一次**（`roomZoomSettleSoon()`，照 `roomTurnSettleSoon()` 的写法）：
  一次捏合上百个 wheel 只写一次盘。
- 文案同步：卡片提示改成「左右拖动转视角 · 滚轮 / 捏合缩放 · 点名字改名」，图注补一句
  「触控板在图上直接捏合就能缩放」；`plugin-guide` 插件里那句说明也一并改了
  （该插件版本 `1.4.1 → 1.4.2`，只是文案，已重跑 `tools/sync-plugins.js` 同步两端 catalog）。
  **用户不会去试一个没写出来的手势。**

## 影响哪端

- **桌面端 + Android**（星图两端都画）。小程序端不画这张图（`miniprogram/core/plugins/dormDuty.js`
  只做 `roomSize` 归一化），不受影响。
- **没有数据迁移**：`state.roomView.dist` 字段与取值区间（0.55 ~ 1.9）都没变，老数据照读。
  只把 `roomView()` 里写死的 `0.55 / 1.9` 换成同名常量，避免两处上下限各走各的。

## 新增守卫

`scripts/test-dorm-duty.mjs` 两段（`npm test` 自动收）：

- **9.8 源码断言**：`wheel` 监听必须 `{passive:false}`；必须按 `e.ctrlKey` 分流两套增益；
  `Math.sign(e.deltaY)` **不许回来**（它就是「按事件个数跳档」）；绑定要在整张卡片上；
  落盘要走 `roomZoomSettleSoon()`；`roomView()` 的夹取要与常量同源；两处文案必须提到捏合。
- **9.9 数学断言**（纯函数，直接喂事件对象）：
  - 方向：`deltaY<0`（向上滚 / 双指外张）= 放大；`deltaY=0` 不动；
  - **40×4px 与 4×40px 结果必须完全一致** —— 捏合总量只由位移决定、与事件个数无关；
  - 单次 160px 的大 delta 不许跑得比同样的 160px 分帧滑更远（单帧上限生效）；
  - 等量反向捏合回到原值（可逆）；反复捏合只停在 `ROOM_ZOOM_MIN / ROOM_ZOOM_MAX`；
  - `dist` 缺省 / `NaN` / `deltaY` 是 `NaN` 都不产生 `NaN`；
  - `deltaMode` 1 / 2 与像素口径等价（含拿不到视口高度的兜底）。

**做过变异测试**：把 `roomZoomDist` 改回 `cur * (1 + Math.sign(px) * 0.09)`，
9.9 立刻红在「捏合总量只跟手势位移有关」这条上（`40×4px → 0.5500` vs `4×40px → 0.6857`），
改回即绿 —— 断言不是摆设。

**真浏览器对照**（无头 Chrome，只 stub `tide`、真 DOM 跑真插件源码，
派发合成 `WheelEvent`，量第一颗星与最后一颗星在取景框里的横向距离）：

| 同一段手势 | 改前（HEAD） | 改后 |
|---|---|---|
| 30 次 × `ctrl+wheel(-8)`（= 240px 捏合） | 星距 61.4 —— **已经顶到下限 0.55** | 星距 60.2（等价 `dist 0.596`，还有余量） |
| 再反向 30 次 × `(+8)` | 星距 **19.7**（冲到上限 1.9，**回不到起点**） | 星距 **35.9**（精确回到起点） |
| 在提示行（卡片空白处）捏合 | `preventDefault` **没被调用**、画面不动（WebView2 会拿去做整页缩放） | `preventDefault` 已调用、画面跟着缩放 |
| `deltaY = 0` | 不动 | 不动 |

第一行就是用户看到的「一捏就飞到底」，第二行是「捏过头就回不来」——两条都在改后消失。
