# v0.206.1 · 快捷入口面板可以拖了，并记住你放的位置

> 本次改动（实测输出）：
>
> - `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.206.1`
> - `node ../tools/gen-theme-dark.js --check` → `✓ 派生调色板已同步（15 套深色变体）`
> - `node ../tools/build-schedule-plugin.js --check` → `✓ shiguang-schedule 生成物与源一致`
> - `node ../tools/sync-android-native.js --check` → `✓ Android 原生代码与版本化镜像一致`
> - `npm test` → `PASS: 130 个测试脚本全部通过`
>
> 动的文件：`src/shell.js`（拖动接线 + 落位存档 + 双击恢复）、`src/styles.css`（把手光标 /
> `touch-action` / 禁选中）、新增 `scripts/test-quick-dock-drag.mjs`（130 个脚本之一）、
> 版本 `package.json`（0.206.0 → 0.206.1，三端已同步、`package-lock.json` 两处已手改）。
> 无数据迁移、无插件 API 变更；老存档行为与改动前一致（见第五节）。

## 用户要求

上一版（v0.206.0）交付时留了一个待定项：审计报告把 `shell.js` 的 `bindQuickDockDrag` 列为「白捡级死代码」，
但删掉它等于砍掉快捷入口面板的指针拖动能力，属功能回归，所以没删，改为问一句
「快捷入口面板到底该不该能拖？」。**用户的答复是「能」。**

于是本版把这条能力真正做通（并顺手把「拖了也没用」的根因一起修掉）。

## 一、问题：不是「没做拖动」，而是两件事叠在一起

1. **函数从来没被调用过。** `bindQuickDockDrag(node, handle)` 在 `src/shell.js` 里一直在，
   但全仓 grep 只有它自己的声明 —— `mountQuickDock()` 里没有接线。所以点住头部拖动什么也不会发生。
2. **就算接上也没用。** `toggleQuickDock()` 展开面板时无条件调 `positionQuickDockNear(quickDockToggle)`，
   窗口 `resize` 时也一样。两条路径都会把面板拉回「贴着触发按钮」的位置，
   于是用户拖到的位置在**下一次展开就被覆盖**，存档里那个 `left/top` 等于摆设。

这两条合起来的表现是「怎么拖都弹回原位」—— 看起来像功能没实现，实际上是接线断在中间。

## 二、改法

1. **把手 = 头部条。** `mountQuickDock()` 把头部抽成 `const head`（头像 + 标题，里面没有可点元素），
   面板进 DOM 后 `bindQuickDockDrag(dock, head)`。头部条同时给出 `title="拖动可移动面板 · 双击恢复跟随按钮"`。
2. **落位存档 + 分流。** 新增存档字段 `settings.quickDock.moved`（老存档在渲染时 `??= false` 补上），
   新增 `placeQuickDock()` 统一分流：
   - `moved === true`（用户拖过）→ `positionQuickDock(dock)`，沿用存档坐标（仍走四边钳制）；
   - 否则 → `positionQuickDockNear(quickDockToggle)`，贴着触发按钮（顶栏部件本身可拖动换位，所以要跟着它走）。

   展开面板、窗口 `resize` 都改走 `placeQuickDock()`。现在 `positionQuickDockNear(quickDockToggle)`
   全文件只剩 1 处调用（就在 `placeQuickDock` 里），测试拿这个计数钉住「别处不许再无条件贴按钮」。
3. **双击把手 = 恢复跟随。** 手势没有位移时按「点一下」处理：350ms 内的第二次 → `moved = false` +
   贴回触发按钮 + 写盘 + toast 一句反馈。**真拖动过的那次会清掉 tap 配对**，免得「拖一下再点一下」被当成双击。
4. **手感与移动端细节。**
   - 头部条加 `cursor: grab` / 拖动中 `grabbing`、`user-select: none`、
     **`touch-action: none`**（少了它，手机上按着头部拖动会被浏览器当成滚动页面 —— pointermove 照样来，
     但面板不动，肉眼很像「功能没做」）；
   - 位移 < 4px 的抖动不算拖动（避免「点一下把手」就落下 `moved` 存档，把跟随关系破坏掉）；
   - **`pointercancel`（系统抢走指针 / 来电）回滚到起拖位置，且不写存档**；
   - 鼠标只认主键（`pointerType === "mouse" && button !== 0` 直接返回），触屏与手写笔照常可拖；
   - 松手时三个 window 监听（`pointermove` / `pointerup` / `pointercancel`）全部摘掉，不留监听。

## 三、落位语义（现在的行为）

| 操作 | 结果 |
|---|---|
| 拖头部条 | 面板跟手；四边钳制：左右按视口留 12px（≤760px）或 20px，顶部让开顶栏，底部叠加 `--sab`（三键导航栏） |
| 松手 | 位置写进 `settings.quickDock`，`moved = true`；下次点「快捷入口」就地展开，不再跳回按钮下 |
| 窗口改大/改小 | 沿用存档坐标，只做钳制（不会跳回按钮下，也不会跑到屏幕外） |
| 双击头部条 | 交还自动跟随：位置回到触发按钮下方，并给一句 toast |
| 拖动中途被打断 | 回滚到起拖位置，存档不变 |
| 点一下头部条（无位移） | 什么都不做 |
| 老存档（没有 `moved` 字段） | 当作「没拖过」→ 跟随触发按钮，与 v0.206.0 及更早行为一致 |

## 四、证据

新增 `le-time-management/scripts/test-quick-dock-drag.mjs`，**把 `shell.js` 里
`positionQuickDock` → `bindQuickDockDrag` 那一段真实源码切出来**，配假 window / 假节点用 `new Function` 直接跑
（本仓库既有写法，见 `test-ui-scale.mjs`）—— 不另写一份「等价实现」来互相印证，那只会测到测试自己。

真跑覆盖的 8 组行为：

```
① 跟手位移（左 = 起拖左 + 指针位移）+ 右下角钳制（宽屏 margin 20）
② 左上角钳制 + 窄屏参数（margin 12 / safeTop 72）+ 底部叠加 --sab 48
③ 几像素抖动不落档（不写盘、不置 moved）
④ 双击把手恢复跟随（moved 归 false、贴回按钮、写盘、给反馈）
⑤ 打断回滚到起拖位置且不写存档
⑥ 非主键不启动拖动；触屏可启动
⑦ placeQuickDock 两条分支（拖过沿用落位 / 没拖过贴按钮）
⑧ 老存档无 moved 字段 ⇒ 落回自动跟随
```

另有接线与样式守卫（源码正则，本仓库 UI 测试的通用写法）：`bindQuickDockDrag(dock, head)` 必须被调用、
把手必须是 `.quick-dock-head`、`positionQuickDockNear(quickDockToggle)` 只许出现 1 次、
展开与 `resize` 都必须走 `placeQuickDock()`、存档字段与新老兼有、CSS 里 `cursor: grab` + `touch-action: none` + `user-select: none` 都在。

**变异验证**（改坏产品源码 → 测试必须红 → 还原后必须绿，无 `.bak-mutation` 残留）：

```
M1 去掉 bindQuickDockDrag(dock, head) 调用        => exit=1 被拦下
M2 展开改回无条件 positionQuickDockNear(触发按钮)  => exit=1 被拦下
M3 styles.css 去掉 touch-action: none             => exit=1 被拦下
M4 positionQuickDock 去掉左边界钳制                => exit=1 被拦下
M5 去掉 pointercancel 回滚                        => exit=1 被拦下
M6 抖动阈值归零（点一下就落档）                     => exit=1 被拦下
还原后复跑：PASS（exit=0）
```

顺带记录一处**测试自身的坑**：`pointerup` 与 `pointercancel` 共用同一个处理函数，处理函数靠 `ev.type`
区分两者 —— 真实 DOM 事件自带 `type`，而手写的假事件没有，第一次跑就红在「打断必须回滚」上。
假事件必须补 `type`，这不是产品缺陷。

## 五、兼容与影响面

- 存档只**新增**一个布尔字段，老存档读到 `undefined` 时按「跟随触发按钮」处理 ⇒ 升级后行为与旧版一致，
  直到用户自己拖一次。没有迁移脚本、没有数据结构变更。
- 只碰了快捷入口面板自身：拖动把手是头部条，面板里的按钮（快速新建 / 命令搜索 / 各视图直达 / 窗口置顶等）
  照旧点得中（头部里没有任何可点元素，不会和点击冲突）。
- 面板仍由 `positionQuickDock` / `positionQuickDockNear` 定位，四边钳制规则不变（含 `--sab`）。
- 插件不受影响（面板是外壳的 UI，走不到插件容器）。

## 六、本版没动、但记下来的两笔

1. **`styles.css` 里有两套 `.quick-dock` 块**（约 2956 行与 4389 行），后一块在层叠上胜出。
   前一块里的 `.quick-dock-grip` / `.quick-dock-fold` / `.quick-dock-grip-dots` 是旧头部设计的遗留样式，
   现在没有任何 JS 产出这些类名 —— 是死 CSS，但清它属于「两个块合并整理」，改动面涉及浮层外观，
   需要单独一轮 + 截图对照，不在本版范围。
2. **`src/sound.js:240` 的 `alarmRinging`** 在 v0.206.0 删掉 `taskReminder.ringActive()` 后已无调用方，
   同样留待下一批一并清理。

## 七、验证命令

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

**一句话**：把一条「函数一直在、却从没接线，而且接线了也会被展开逻辑当场覆盖」的能力真正做通 ——
面板可拖、位置记住、双击交还跟随、打断回滚、触屏能拖，并给新老存档都留了正确的默认值。
