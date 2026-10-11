# v0.197.0 · 侧栏插件拖动不再「两个一模一样」：原件自己浮起跟手，照搬 Yue launcher 的子目录拖动

> `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.197.0`；
> `node ../tools/gen-theme-dark.js --check` → `✓ 派生调色板已同步（15 套深色变体）`；
> `node ../tools/build-schedule-plugin.js --check` → `✓ shiguang-schedule 生成物与源一致`；
> `node ../tools/sync-android-native.js --check` → `✓ Android 原生代码与版本化镜像一致`；
> `npm test` → `PASS: 128 个测试脚本全部通过`。
> 动的文件：`le-time-management/src/pluginListDrag.js`（整份重写，221 行）、
> `le-time-management/src/styles.css`（注释 + 让位/高亮规则 + 删掉 `.plugin-nav-ghost` 整段，54 行改动）、
> 四个测试脚本（`test-plugin-sidebar-drag.mjs` / `test-plugin-sidebar-follow.mjs` / `test-plugin-pins.mjs` / `test-plugin-groups-motion.mjs`）、
> `le-time-management/package.json` / `package-lock.json`（0.196.0 → **0.197.0**）、根 `docs/CHANGELOG-v0.197.0.md`。

## 用户要求原文

> 「去除跟手的副本，并且让它的侧边栏上下拖动参考 E:\E-Develop-Project\tauri-shortcut-launcher 的子目录上下拖动，定位好代码再修改」

## 一、问题形态：拖一个插件，屏幕上出现两个一模一样的条目

按住侧栏插件往上拖，被拖的那一项还老老实实待在列表原位（且被 v0.134.0 换成了**不透明实底 + 2px 主题色实线描边**），
同时另有一份一模一样的按钮贴着鼠标走。两个条目配色完全相同、文字图标完全相同，所以观感就是「复制了一份」。

关键证据（改前）：

| 位置 | 内容 |
|---|---|
| `le-time-management/src/pluginListDrag.js:116`（旧） | `st.card.classList.add("nav-dragging"); list.classList.add("plugin-drag-live")` —— 原件留在流里当落点槽 |
| `le-time-management/src/pluginListDrag.js:118-128`（旧） | `st.ghost = st.card.cloneNode(true)` → 加 `plugin-nav-ghost` 类 → `document.body.append(st.ghost)` → `moveGhost(st)` |
| `le-time-management/src/styles.css:3989-3998`（旧） | `.nav .plug-seg > button.nav-dragging { opacity: 1; … background: color-mix(in srgb, var(--deep) 18%, var(--panel)); outline: 2px solid var(--deep); outline-offset: -2px; }` |
| `le-time-management/src/styles.css:4155-4163`（旧） | `.plugin-nav-ghost { opacity: 1; … border: 2px solid var(--deep); }` |

两条规则的 `opacity / color / font-weight / background` **逐属性完全相同**，边框同色同宽（一个用 `outline`、一个用 `border`），
唯一区别只是 `box-shadow`（槽是 `inset 3px 0 0 var(--deep)`，副本是 `0 10px 26px rgba(15,23,42,.24)`）。
对照：左下操作条 `.rail-dock` 的占位槽是 `opacity: .3`（`le-time-management/src/styles/feature-layouts.css:175`），
所以只有侧栏插件有这个观感。

**这个「槽 + 副本」的写法本身是设计**（`docs/CHANGELOG-v0.78.0` 起：拖动项浮起、原位保留明确空槽、其他插件逐项平滑追赶），
直到 v0.134.0（`docs/CHANGELOG-v0.134.0.md:3`）为了夜间主题下的可读性把空槽改成不透明实底实线，两份才变得无法区分。

## 二、参考实现：`tauri-shortcut-launcher` 的子目录拖动

读 `E:\E-Develop-Project\tauri-shortcut-launcher\src\components\Sidebar\Sidebar.tsx`（257 行）+ 同目录 `Sidebar.css`，
它用的是 `@dnd-kit/core` + `@dnd-kit/sortable`：

```tsx
// Sidebar.tsx:30-35
const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
  useSortable({ id: directory.id, disabled: editing });
const style = {
  transform: dragSessionActive ? CSS.Transform.toString(transform) : undefined,
  transition: dragSessionActive ? transition : undefined,
};
```

```tsx
// Sidebar.tsx:230-238
<DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart onDragCancel onDragEnd>
  <SortableContext items={ids} strategy={sidebarColumns > 1 ? rectSortingStrategy : verticalListSortingStrategy}>
```

```tsx
// Sidebar.tsx:194-205 —— 拖动过程中不动数据/DOM，松手才落地
reorderDirectories(activeGroup.id, arrayMove(ids, oldIndex, newIndex));
```

模型可以归纳成三句：

1. **transform 写在被拖的真实元素自己身上** —— 没有 `cloneNode`、没有 `<DragOverlay>`、没有 body 上的副本。
2. 其余项各自写一条 `translateY` 让出落点（单列就是 `verticalListSortingStrategy`）。
3. **拖动中不动 DOM/数据**，`onDragEnd` 才 `arrayMove` 落地。

配套细节也值得照抄：`PointerSensor` 的 `activationConstraint: { distance: 4 }`（等于我们原有的 4px 阈值）、
`KeyboardSensor` + `sortableKeyboardCoordinates`（等于我们原有的 Alt+↑/↓）、
以及 window `pointerup / pointercancel / lostpointercapture / blur / visibilitychange / Escape` 全部兜底重挂会话
（`Sidebar.tsx:139-186` 的 `hardResetDragSession()`）。
样式侧 `.side-tab { touch-action: none; user-select: none; transition: … transform 120ms ease }`（`Sidebar.css:58-61`）、
`.side-tab.dragging { opacity: 0.48; z-index: 6; box-shadow: 0 10px 28px … }`（`Sidebar.css:102-108`）。

## 三、修法

### 3.1 `le-time-management/src/pluginListDrag.js`：整份重写（221 行，导出签名不变）

导出仍是 `attachPluginListDrag(list, onCommit)`，调用点 `le-time-management/src/shell.js:1182-1190` 一行没动。

| 环节 | 改前 | 改后 |
|---|---|---|
| 跟手 | body 上的 `cloneNode(true)` 副本 | `st.card.style.transform = translate3d((x-startX)/scale, (y-startY-drift)/scale, 0)` |
| 原位 | 原件留流里当空槽 + `nav-dragging` 实心高亮 | 原件就是拖动项本身，加 `nav-dragging` 浮起 |
| 让位 | 原件离开原位、其他项逐项追赶（含 FLIP 计算） | `applyShift(st, slot)` 给跨过的 peers 写 `translate3d(0, ±step/scale px, 0)`，`step = 卡片高 + rowGap` |
| 落点 | 拖动中 `insertBefore` 实时重排 | `frame()` 只算 `slotOf()` 与位移；`finish()` 里才 `list.insertBefore(st.card, st.peers[slot] ?? null)` |
| 落位动画 | FLIP 手算 `dy` | 松手后 `st.card.animate([{transform: translate3d(landX, landY, 0)}, {transform: "none"}], {duration: 140, easing: "cubic-bezier(.22,.8,.22,1)"})` |
| 取消 | 需要把副本删掉 | 无需还原 DOM，只清 transform 与类 |

几个必须留意的实现点：

- **几何量一律是视口坐标**（指针、`getBoundingClientRect` 都是 zoom 之后的视觉像素），写进 transform 前除以 `st.scale`，
  与 `le-time-management/src/toolbarDrag.js` 同一口径；否则界面缩放不是 100% 时浮起项会偏离指针。
- **`st.drift`**：`(list.getBoundingClientRect().top - st.listTop) - ((list.scrollTop || 0) - st.listScroll)`。
  滚动后原件在流里的位置也跟着挪，不减掉这一项，指针不动而列表滚动时原件会从指针底下飘走。
- **几何缓存按节点而不是按 id**：多视图插件会有多个按钮共享同一个 `data-plugin-id`，按 id 缓存会互相覆盖，
  所以 `st.tops` / `st.heights` 都是 `Map<Element, number>`。
- **`unclip` / `reclip`**：`.nav .plug-group { overflow: hidden }`（`styles.css:4029-4036`，裁切声明在 4035）会裁掉被拖出卡片的原件。
  从 `list.parentElement` 往上逐层把 `overflow` 改 `visible` 并记录原值，遇到 class 含 `nav`（滚动容器 `.nav { overflow-y: auto }`，`styles.css:404`）
  或 `plug-list` 立即收手；会话结束还原。同族先例：`.nav.nav-flip .plug-group { overflow: visible }`（`styles.css:4090`）。
- **健壮性**：`frame()` 开头 `if (!list.isConnected || !list.contains(st.card)) { cancel(st); return; }`；
  会话结束统一 `detachDoc()` 摘掉 5 个 document/window 监听、清 `swallowClick` 捕获器、还原 `st.card.dataset.motion`。

### 3.2 `le-time-management/src/styles.css`

- 顶部注释（3938 起）整段换成「v0.197.0 侧栏插件实时拖动排序：原件自己浮起跟手」，写清新模型。
- `.plug-seg.plugin-drag-live > button[data-plugin-id]` 加 `transition: transform 140ms cubic-bezier(.22,.8,.22,1)`（让位动画）；
  `.plug-seg.plugin-drag-live > button.nav-dragging { transition: none }` 必须存在且更具体（(0,4,1) > (0,3,1)），
  否则拖动项会跟着过渡、跟手变迟滞 —— 同时压过 `styles.css:418` 的 `.nav button { transition: … transform .08s ease }`。
- `.nav .plug-seg > button.nav-dragging` 保留实心高亮（v0.134.0 的可读性改进不回退），补
  `position: relative; z-index: 5; box-shadow: 0 10px 26px rgba(15,23,42,.24); will-change: transform; cursor: grabbing`。
- 新增 `.nav .plug-seg > button.nav-dragging > .nav-actions { opacity: 0; pointer-events: none; transition: none; }`
  —— 悬停操作条长在按钮内部，浮起时会跟着走并抢宽度（基线 `.nav .nav-actions` 在 `styles.css:479-483`，
  显示规则 `.nav button:hover > .nav-actions, .nav button:focus-within > .nav-actions` 在 `styles.css:484-485`，特异性 (0,3,1)，新规则 (0,4,1) 压得住）。
- **删掉整段 `.plugin-nav-ghost`**（含 `.ic / .app-icon / .lb / .pv-count / .nav-kbd / .nav-actions` 六条子规则），
  原位留一行注释说明它为什么没了。

### 3.3 测试

| 脚本 | 改了什么 |
|---|---|
| `le-time-management/scripts/test-plugin-sidebar-follow.mjs` | 整份重写：假 DOM 去掉 ghost 分支，`animate()` 改成计 `animates`；断言改成「原件带 nav-dragging / `body.children.length === 0` / 原件 transform 跟手 / 拖动中 DOM 顺序不变 / 让位位移 / 松手才落地 / 落位动画 / 减少动效跳过 / 缩放换算 / 滚动漂移 / 监听清理」 |
| `le-time-management/scripts/test-plugin-sidebar-drag.mjs` | 源码级断言换成新实现：`doesNotMatch(/cloneNode|body\.append\(/)`、`doesNotMatch(/plugin-nav-ghost/)`、`st.step / st.scale`、`st.drift`、`insertBefore` 只在 `finish` 里、unclip/reclip 等；shell 接线四条与阈值/长按/Alt+箭头四条原样保留 |
| `le-time-management/scripts/test-plugin-pins.mjs:141` | 原来断言 `.plugin-nav-ghost .nav-actions { display: none }` → 改成 `.nav .plug-seg > button.nav-dragging > .nav-actions { opacity: 0` |
| `le-time-management/scripts/test-plugin-groups-motion.mjs:193-196` | ghost 相关三条 → 换成原件跟手、按节点缓存高度、`landY` 缩放换算三条 |

> 注：`styles.css` 里说明「删掉了 `.plugin-nav-ghost`」的那行注释仍含该类名字面量，
> 所以断言必须写成 `/\.plugin-nav-ghost\s*\{/` 而不是裸 `/\.plugin-nav-ghost/`。

## 四、跑一遍的结果

```
✓ 已同步三端版本：v0.197.0
✓ 三端版本一致：v0.197.0
✓ 派生调色板已同步（15 套深色变体）
✓ shiguang-schedule 生成物与源一致
✓ Android 原生代码与版本化镜像一致（… / assets 配置与启动器图标）
PASS: 128 个测试脚本全部通过
```

`sync-android-native.js --check` 第一次报 `[不一致] app/src/main/assets/tauri.conf.json`（gen 里嵌的是 0.196.0），
跑一次同步器把它刷新成 0.197.0 后全绿 —— 这是 v0.196.0 新增的第 ④ 类同步在正常工作。

调试时踩到的两条断言口径，记下来免得下次再撞：

- 激活**当次**的 transform 是 `translate3d(4px, 0px, 0)`（阈值 4px 触发），不是 `0`。
- 没被跨过的项 `style.transform` 是 `undefined`，不是 `''` —— 只有真正被写过位移的项才有该属性。

## 五、影响面

- **桌面端**：侧栏插件上下拖动改为「原件自己跟手」，屏幕上永远只有一个条目；让位与落位各有 140ms 动画；
  减少动效开启时让位与落位都瞬时完成；界面缩放、列表滚动、拖动中滚动、Esc/失焦取消都已覆盖。
- **手机端 / 小程序**：侧栏插件拖拽只在 `desktopWindow && views.length > 1` 时挂载（`shell.js:1182-1190`），
  窄屏不受影响；`miniprogram/` 只跟着版本号走。
- **数据**：`onCommit` 的落库路径（`saveSegmentOrder` / `savePinnedOrder`）与写入内容都没变，无迁移、无接口变更。
- **遗留的同类写法**（本次没动，仍是「原位槽 + body 副本」）：`le-time-management/src/toolbarDrag.js` 的顶栏/左下操作条、
  `le-time-management/src/views/quadrant.js:355` 的四象限卡片、`le-time-management/src/ui.js:213` 的 `pointerDrag`（时间块用）。
  它们的占位槽本来就是低透明度，没有「两个」的观感；哪天要统一，照本次这套改。
