# v0.206.2 · 值日插件标签右键菜单：菜单真的落在光标上了

> 本次改动（实测输出）：
>
> - `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.206.2`
> - `node ../tools/gen-theme-dark.js --check` → `✓ 派生调色板已同步（15 套深色变体）`
> - `node ../tools/build-schedule-plugin.js --check` → `✓ shiguang-schedule 生成物与源一致`
> - `node ../tools/sync-android-native.js --check` → `✓ Android 原生代码与版本化镜像一致`
> - `npm test` → `PASS: 130 个测试脚本全部通过`
>
> 动的文件：`public/plugins/dorm-duty/main.js`（`clampTabMenu` 抽出 / 新增 `placeTabMenu` /
> `openTabMenu` 记原始锚点 / `paint()` 末尾收落点 / 菜单项与提示文案）、
> `public/plugins/dorm-duty/manifest.json`（1.12.0 → 1.12.1）、`scripts/test-dorm-duty.mjs`（新增落点用例与源码守卫）、
> `miniprogram/pages/plugin/dormDuty.js`（动作名与桌面端对齐）、
> 版本 `package.json`（0.206.1 → 0.206.2，三端已同步、`package-lock.json` 两处已手改）。
> 无数据迁移、无插件 API 变更、无存档字段变化。

## 用户要求

> 值日插件-右键图中按钮显示右键菜单，可以重命名，复制【直接在后面添加1个相同轮换】，删除

（截图是插件页顶部那条轮换标签——「公区值日 / 宿舍值日 / 轮换 3 / 轮换 4 / ⊕ 新建轮换」，没有任何「⋯」按钮。）

## 一、先确认能力在不在：在，而且语义早就对

翻代码先得到两条结论，避免重做一遍已经有的东西：

1. 标签右键菜单 **v0.93.0 就有**（`docs/CHANGELOG-v0.93.0.md` 记着五项、复制语义、小程序 ⋯ 入口、Android 长按）；
   `main.js` 里 `openTabMenu` / `tabMenuHtml` / `runTabMenuAction` / `bindTabMenu` 一套齐全，右键与 550ms 长按都接了。
2. 「复制」的落位语义 = `duplicateGroup` 把整组复制后 `state.groups.splice(indexOf(src) + 1, 0, copy)`
   —— **就是在原组后面插一套相同的轮换**，重生成组 id 与成员 id、重映射 `seats`、清 `overrides` 与 `lastNotified`、保留 `startDate`。
   与用户口径完全一致，不需要改语义。

所以这一版要解决的不是「做功能」，而是「为什么用户看不见这个菜单」。

## 二、问题：菜单被宿主的包含块整体搬走了

真应用外壳里量出来的证据（无头 Chrome，窗口 1280×900，桌面 UA）：

```
.view              rect=(237,62,1026,737)
                   computed transform = matrix(0.992, 0, 0, 0.992, 12, 6)
                   will-change = "opacity, transform"        ← 直接跳转补间用的
                   overflow = auto
祖先链 .dd-glist/.dd-groups/.dd-wrap/.plugview/main.main/.app/body 全部 transform:none

T1 右键第一个标签  click=(351,105)   inline left/top = 351px/105px（插件写得对）
                                    实际渲染 rect=(585,166)  ⇒ 偏移 (+234,+61)
T2 右键最后一个标签 click=(656,96)    inline 656px/96px       ⇒ 渲染 (877,149)，偏移 (+221,+53)
T3 长按 750ms（手机路径）与 T2 同点、同样偏移
T4 反事实：把 .view 的 will-change 设 auto、transform 设 none 后再开菜单
                                    ⇒ 偏移变成 (+221,+9)，≈ main.main 的原点 (220,8)
```

结论：`src/styles.css:3556` 的 `.view { will-change: opacity, transform }` 让 `.view` 的 padding box
成为 fixed 后代的**包含块**，于是写进 `left/top` 的视口坐标被整体平移一段；`.view` 还是 `overflow:auto` 的滚动容器，
靠右标签上的菜单会被一起裁掉。**表现就是「右键了，但没反应」** —— 菜单跑到侧栏右边或者画布之外去了。

> 插件指南 `plugin-development.md` §4.2 早就写明这条：fixed 元素的包含块是宿主内容区的 padding box，
> 「让开的边 = 你钉住的边」。所以修法选「保持结构、把落点收准」，不把菜单 DOM 重挂到 `document.body`。

## 三、改法

1. **抽出 `clampTabMenu(x, y, w, h)`**：把原来写在 `openTabMenu` 里的安全区夹取（四条边 `--sat/--sab/--sal/--sar`）
   独立成函数，`openTabMenu` 与新的落点修正共用同一套边界，不会两边算法不一致。
2. **`openTabMenu` 记住未夹取的原始锚点**：`tabMenu = { id, x: at.x, y: at.y, ax: x, ay: y, step: "" }`
   —— `x/y` 是首帧用的估算落点（不同屏不出界），`ax/ay` 是光标真实位置，留给第二步收精确落点。
3. **新增 `placeTabMenu()`**：菜单进 DOM 后按**实测**尺寸重夹一次（`MENU_H` 只是估算，项数不同高度差很多），
   再按**实测残差**迭代最多 3 次把包含块那层平移抵掉：
   `dx = at.x - el.getBoundingClientRect().left` → `x += dx` → 再量；残差 < 0.5px 就停。
   判断依据是「菜单实际落在哪」，不再假设 `left/top` 就等于视口坐标 —— 宿主给哪个祖先加过
   `transform` / `zoom` / `filter` 都会被这一步一起收掉。**测不出布局（Node 沙箱、隐藏容器）就原样返回**，保持第一步的坐标。
4. **`paint()` 末尾接上 `placeTabMenu()`**：`root.innerHTML` 重建后菜单才在 DOM 里，所以必须在 `bind()` 之后调。
5. **文案照实说**：菜单项 `再添加一个` → **`复制到后面`**，复制成功提示改「已把「X」复制到它后面，成员和规则都带过来了」，
   标签 `title` 改「切到「X」（右键或长按可重命名 / 复制到后面 / 删除）」。
   菜单结构、五个动作、`data-tab-act` 分工、`.dd-tabmenu` 样式一律没动。
6. **小程序同源**：`miniprogram/pages/plugin/dormDuty.js` 的 `onDdGroupMenu` 动作名同步为 `复制到后面`（与桌面端同一流程）。

## 四、落位语义（现在的行为）

| 场景 | 结果 |
|---|---|
| 右键任意标签 | 菜单左上角 = 光标点（实测 offset 0,0），并保证整体在可视区内 |
| 长按 750ms（手机） | 同上；`longPressed` 仍吞掉随后那一次 click |
| 标签靠右 / 靠下 | 按实测尺寸重新夹取，不会出屏、不会被 `.view` 的 overflow 裁掉 |
| 菜单项数变化（二级「导入成员」、只剩一组时禁用删除） | 高度变大 → 收落点时用**实测**高度重夹，仍不出界 |
| 无布局环境（单测沙箱） | 保持第一步的估算坐标，不抛错 |
| 宿主祖先带缩放（`--ui-scale` 的 CSS zoom、`.view` 的 0.992 补间） | 残差迭代把它抵掉，落点仍等于光标 |

## 五、证据

**真应用外壳探针**（`.tmp-serve` 静态服务器 + 播好 4 组 localStorage 的 index 副本，真插件源码零 stub）。
修复后同一探针：

```
T1 第一个标签 click=(336,96) → 渲染 (336,96)  offset=0,0  insideView=true
T2 最后标签   click=(656,96) → 渲染 (656,96)  offset=0,0
T3 长按 750ms             → 渲染与光标重合，offset=0,0
菜单项 = 切到这一组 | 重命名 | 复制到后面 | 导入成员 | 删除这一组
光标落在菜单项上时的命中元素 = 菜单项本身（hit-menu）；ERRS []
```

**动作流程**（真 DOM 事件，`prompt` 打桩返回「副本A」，`confirm` 返回 true）：

```
before     公区值日我 | 宿舍值日冯 | 轮换 3未排班 | 轮换 4未排班
右键「宿舍值日」→「复制到后面」
after-copy 公区值日我 | 宿舍值日冯 | 副本A冯 | 轮换 3 | 轮换 4      ← 副本紧跟原组、成员带过来、菜单自动收起
持久化      公区值日[我+魏浩然] , 宿舍值日[冯] , 副本A[冯] , 轮换 3[] , 轮换 4[]
标签横坐标  288 / 391 / 494 / 580 / 690                            ← 证明插在中间，不是追加到末尾
右键「重命名」→ 副本A（成员不变）；右键「删除这一组」→ 轮换 4 消失、剩 3 套、写盘正确
三次落点 offset 均 = 0,0
```

**单测**：`scripts/test-dorm-duty.mjs` 新增「8.6b 菜单落点」4 条断言（走真实 `paint()` 路径：
渲染矩形必须等于夹取后的目标、包含块平移必须被抵掉、幂等、无布局时不写坐标），
`8.7 源码不变量` 新增 7 条（`clampTabMenu` / `placeTabMenu` / `paint` 里的调用 / `getBoundingClientRect` /
`ax ?? x` / 原始锚点那行对象字面量 / 菜单项文案）。

**变异验证**（改坏产品源码 → 测试必须红 → 还原后绿）：

```
M1 去掉残差回修（x += dx; y += dy;）        => exit=1 被拦下
M2 paint() 不再调用 placeTabMenu()          => exit=1 被拦下
M3 clampTabMenu 右侧不减 --sar              => exit=1 被拦下
还原后复跑：PASS（exit=0）
```

**顺带记一条工具坑（不是产品缺陷，但会误导判断）**：无头 Chrome（新老两代渲染管线都试过）
加 `--virtual-time-budget` 时，这个 `position:fixed` 菜单节点在**视口内几何与命中测试全部成立**
（`getBoundingClientRect` 等于光标点、`elementsFromPoint` 首位是菜单自身、`checkVisibility({checkOpacity:true})` 为 true），
却**一个像素都不落栅格**：开菜单与不开菜单两张图在菜单矩形 180×240 内差异像素 = 0，
把菜单背景强制改成红色仍然是 0，而同一时刻往同一个容器 append 的普通 `div` 却能正常出图。
同族假象还有一条：宿主「视图进场」动画在虚拟时间下不推进，会把 `.dd-wrap` 冻在 `opacity: 0.2`（收尾动画后立即恢复 1）。
⇒ 本版**不用截图当证据**，落点结论以几何、命中测试与动作流程三条为准。

## 六、兼容与影响面

- 只改定位计算与文案：菜单的五项动作、`data-tab-act` 委托、`closeTabMenu` 行为、`.dd-tabmenu` 样式全部未动。
- 存档结构没变（`groups/activeId/...` 一个字段都没加），无迁移；小程序端只改了动作名，落在同一个 `ddGroupDuplicate` 流程上。
- `MENU_W` / `MENU_H` 仍是首帧估算值（防止第一帧就出屏），精确落点由实测尺寸接管；估算值改大改小都不会再影响最终位置。
- 插件卸载/停用路径不受影响：`placeTabMenu()` 在容器没有菜单节点时直接返回。

## 七、本版没动、但记下来的一笔

`school-notice/main.js:615-621`、`chaoxing-notify/main.js:1009-1028`、`github-readme/main.js:814`
用的是同一套「把视口坐标写进 fixed 浮层」的写法，在 `.view` 这个包含块下大概率同病（同样会偏移、同样被裁）。
本版只按用户口径收口值日插件；那三个插件要动的话，建议直接复用 `clampTabMenu` + 实测残差这两步，
或者把这段逻辑收进插件公共样例（`plugin-guide` §4.2 配方 B 目前只讲了「把安全区算进去」，没讲包含块平移）。

## 八、验证命令

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

**一句话**：右键菜单其实早就在，但它被宿主 `.view` 的 `will-change: transform` 整体搬走、又被 `overflow` 裁掉，
看起来就像「右键没反应」—— 这一版把落点改成「按实测尺寸重夹 + 按实测残差抵掉包含块平移」，
并在菜单上把「复制」如实写成 **复制到后面**，右键 / 长按 / 重命名 / 复制 / 删除五条路都验到了 0 偏移。
