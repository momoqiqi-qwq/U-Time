# v0.187.0 · AI 对话「对话框」：行下空位收掉、发光与入场照 Nephele、快捷提问加滑动选中光

> `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.187.0`；
> 内置插件 `ai-chat` `0.6.0 → 0.7.0`，`plugin-guide` `1.4.3 → 1.4.4`（补 `tide.ui.selectionGlow` 文档）。

## 用户要求原文

> 「对话框下面太多空位了」
> 「动画和对话框发光和nephele一样的效果」
> 「为什么这个没有nephele选择的的动画吗，如果不懂就去看nephele代码里查看」

三条都落在 **AI 对话插件**（`public/plugins/ai-chat/main.js`）的输入区与它下面那条快捷提问行。

## 一、行下空位：82px → 16px

改前实测（真渲染，视口 1118×805，`--dump-dom` 读几何）：

```
aichat{t:20,b:797,h:777} bar{t:544,b:668} shortcuts{t:678,b:715,h:37} feed{t:725,b:739} → belowChips=82
```

那 82px = 卡片底部内边距 **58** + 「已收集 N 条」那行 **14** + 行间距 **10**。58px 是照
`NepheleDialog.qml` 的「body 上下各留 24px、再宽一点防止按钮阴影被裁」抄来的，但**本视图不是浮层**，
底下没有任何要露出来的手影 —— 光占着位置。

改动：

| 项 | 改前 | 改后 |
|---|---|---|
| `.aichat` 底部内边距 | `58px` | `18px` |
| `「已收集 N 条」那行(.aichat-feed)` | 在快捷提问行**下面** | 挪到输入框**上面**（它讲的是"这一轮带上什么数据"，跟输入区是一组） |
| 实测 `belowChips` | **82px** | **16px** |

## 二、发光与入场：照 `NepheleDialog.qml`

| Nephele（QML） | 本仓库（CSS） |
|---|---|
| `enter`: opacity 0→1 `300ms OutCubic` | `aichat-dialog-fade 300ms cubic-bezier(.16,1,.3,1)` |
| `enter`: scale `0.9→1` `400ms OutBack` | `aichat-dialog-in 400ms cubic-bezier(.34,1.4,.64,1)` |
| `enter`: y `+20→0` `300ms OutCubic` | 同上一条的关键帧里一起走（`translate3d(0,20px,0) scale(.9)` → `none`） |
| 背景 `MultiEffect` 软阴影 `rgba(0,0,0,.15)` / `blur .75` / `offset-y 8` | `.aichat` 卡片 `box-shadow: 0 8px 22px #00000026` + 一圈紫光 `0 0 34px #cfa8dd21` |
| 输入区高度不足会裁阴影 ⇒ 底部内边距留宽 | 本视图不是浮层，改成 18px（见第一节） |
| 选中块发光 `pulse` `0.62↔0.38`、`1500ms InOutSine`（`SettingChipGroup`） | `.aichat-bar:focus-within` 呼吸光 `aichat-bar-glow 3s ease-in-out infinite alternate`（模糊 18→32px，只在打字时呼吸） |

## 三、快捷提问行补上「Nephele 选择的动画」

参考实现是 Nephele 的 `SettingChipGroup.qml`（玻璃分段控件）：

- 容器：`radius 12`、`bg Qt.rgba(fairyPurple, 0.06)`、1px 白边 + `InnerShadow rgba(0,0,0,.25)`
  → 本仓库 `.aichat-shortcuts` 加 `position:relative; isolation:isolate` + `inset 0 1px 4px` 内阴影；
- 滑行块 `glider`：`Behavior on x { 500ms, Easing.OutBack, overshoot 1.3 }`
  → 直接用宿主 `src/selectionGlow.js`（`500ms` / `cubic-bezier(.34,1.56,.64,1)`，尺寸 `400ms`）；
- `glider` 底下另有一块 `1.1×` 的模糊矩形（注释写明「必须独立于 glider 自己的 layer，否则宽 glider
  会被硬裁」）→ CSS 里用低 α 大模糊的 `box-shadow: 0 0 14px #cfaae459` 等价；
- 颜色过渡 `Behavior on color { 300ms }` → 按钮 `transition: color .3s`。

**为什么以前没有**：`main.js` 旧注释（`38-46` 行，讲「思考强度」为什么做成一颗循环按钮）写得很清楚 ——
「分段控件属于铁律六，选中高亮要滑动到新目标，而那个滑动光块是宿主 `src/selectionGlow.js` 的
`attachSelectionGlow()`，**插件侧拿不到（插件只有 `tide.*`）**」。所以这一版把口子开出来：

```js
tide.ui.selectionGlow(container, { selector }) // → { sync, dispose }，权限 ui
```

宿主侧只是 `attachSelectionGlow` 的直传（`src/pluginHost.js`，与番茄插件的 `.pomodoro-modes` 同一套），
`pluginDisposers` 负责收尾；对外写法进了 `plugin-guide` 的开发文档 §4.5。

行内的实现纪律（`paintChips` / `paintChipSelection`）：

- **行内容不变时只切 `.on`**，让光块自己滑过去；`innerHTML` 只在整组提问真的换了（「带本机数据」开关）
  时才重建，重建后重挂光块 —— 否则光块和它的 `ResizeObserver` 会变成孤儿、`500ms` 位移动画被截断；
- 点击第 2 项再点第 4 项，实测光块当前帧仍在第 2 项的位置（`dx=-344.8`）、并挂上 `[500,400]`
  两个动画，`finish()` 后精确落在第 4 项（`dx=dy=0`）；
- 切走再回来（`render()` 重新建 DOM）会先 `dispose()` 旧光块；
- 减少动效（应用开关 `data-ui-motion="reduced"` 与系统 `prefers-reduced-motion`）下：入场与呼吸光
  在插件样式里停掉，光块由宿主直接落到终态。

## 四、验证

- 真渲染几何：`belowChips 82 → 16`（视口 1134×900）；控件无一溢出。
- 点击行为：首点 `dx=dy≈0`（直接出现）；第二次点 `[500,400]` 动画 + 视觉位置仍在上一个选项；
  `finish()` 后 `dx=dy=0`、无残留动画。
- 对照图：`output/preview/ai-chat-dialog-nephele.png`（改前 / 改后 / 改后+选中光块 三带叠放）。
- 回归守卫：`scripts/test-ai-chat.mjs` 新增「宿主口子 + 插件接线 + 原地只切 `.on` + 减动效白名单」断言。

## 五、左上角品牌字标居中（同一批的第二条要求）

> 「弄居中去」＝把左侧栏顶部那枚字标「U Time WorkSpace」**左右居中**。

改前 `.brand` 是 `align-items: flex-start` —— 桌面侧栏 224px、字标 159px，实测**左空 19px / 右空 46px**，
看着就是「顶在最左边、右边空一大片」。改成 `align-items: center` 后 **32.5 / 32.5**；下方那条哥特装饰线
（`width: min(100%, 160px)`，与字标几乎等宽）跟着一起居中，两者左右差 ≤0.5px。

| 侧栏宽 | 改前 左/右空 | 改后 左/右空 |
|---|---|---|
| 176px（过渡带） | 19 / **-2**（溢出 2px） | 8.5 / 8.5 |
| 204px（紧凑密度） | 19 / 26 | 22.5 / 22.5 |
| 212px（默认） | 19 / 34 | 26.5 / 26.5 |
| 224px（舒适密度 / ≥1200px） | 19 / 46 | 32.5 / 32.5 |

各媒体查询里的 `.brand` 只改 `padding`，且左右 padding 恒等 ⇒ `align-items: center` 就是「相对侧栏居中」，
窄侧栏那两条（176px / 18px 字号）也不会因此溢出。回归断言加在 `scripts/test-brand-wordmark.mjs`。

对照图：`output/preview/brand-center-compare.png`。

## 六、影响面

- 桌面 / Android：AI 对话插件的输入区与快捷提问行；其它视图不受影响。
- 小程序：`ai-chat` 声明 `miniprogram: unavailable`，不涉及。
- 数据迁移：无（未动存储键与 `manifest.permissions`）。
- 宿主新增 `tide.ui.selectionGlow`（`ui` 权限内），对既有插件无行为变化。
