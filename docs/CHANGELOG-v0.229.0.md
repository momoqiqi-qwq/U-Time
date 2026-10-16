# v0.229.0 · 值日星图上能直接指定「今天谁值日」：指定谁，就从谁接着往下轮

> 本条只给轮换值日插件加一个入口（桌面星图 + 小程序同页），并补上三端同源的行为测试，不涉及数据迁移。
>
> | 门禁 | 结果 |
> |---|---|
> | `node ../tools/sync-version.js --check` | ✓ 三端版本一致：v0.229.0 |
> | `node ../tools/sync-plugins.js --check` | ✓ 17 个内置插件三端同源 |
> | `node ../tools/gen-theme-dark.js --check` | ✓ 派生调色板已同步（15 套深色变体） |
> | `node ../tools/build-schedule-plugin.js --check` | ✓ 生成物与源一致 |
> | `node ../tools/sync-android-native.js --check` | ✓ Android 原生与清单声明一致 |
> | `npm test` | ✓ `PASS: 139 个测试脚本全部通过` |

## 动的文件

| 文件 | 改了什么 |
|---|---|
| `le-time-management/public/plugins/dorm-duty/main.js` | 新增纯函数 `redesignate(g, memberId, date)`；星图那一行加「今天值日」下拉 `[data-room-duty]` 及其 `change` 处理；`.dd-room-duty` 样式；星图图例补一句分工说明 |
| `miniprogram/core/plugins/dormDuty.js` | 同语义的 `ddRedesignate(g, memberId, date)`（不可变：返回新组，无变化原样返回），并加进 `module.exports` |
| `miniprogram/pages/plugin/dormDuty.js` | `loadDormDuty()` 产出 `dd.dutyNames / dd.dutyIndex / dd.dutyName`；新增 `onDdDutyPick()` |
| `miniprogram/pages/plugin/index.wxml` | 成员卡片顶部加「今天值日」`<picker mode="selector">` 与一句与床位无关的说明 |
| `le-time-management/scripts/test-dorm-duty.mjs` | 新增 7.3b（桌面端行为）与 7.3c（跨端逐日一致）两个用例块；星图渲染断言改为「下拉唯一 + 列出全部成员」，并补两条针对性断言 |
| `le-time-management/public/plugins/dorm-duty/manifest.json` | 插件版本 1.12.1 → 1.13.0，描述补上新的指定入口 |
| `le-time-management/src/pluginCatalog.js`、`miniprogram/core/pluginCatalog.js` | 由 `tools/sync-plugins.js` 从清单生成（目录版本号刷成 1.13.0） |
| 版本号 | `package.json` / `package-lock.json`（两处）/ `Cargo.toml` / `tauri.conf.json` / `appMeta.js` / Android `versionName`+`versionCode` → v0.229.0 |

## 用户要求

> `可以重新指定今天值日的是谁，然后接着按顺序下去。`

（随附一张截图：宿舍床位 · 值日星图的「编辑床位」模式，2 号床上铺被选中）

## 一、这次要的不是「记一次换人」，是「把名单转一下」

插件里本来就有**临时换人**（`overrides[本轮] = 某成员`），它解决的是「今天就让他替一下，明天照旧」。用户这句「接着按顺序下去」说的是另一件事：**从今天起，顺序从他这儿接下去**。两者用数据表达完全不同 —— 前者只改这一轮，后者要动名单本身。

所以实现是**转名单**：名单顺序就是轮换顺序，把被指定的人挪到「今天这一轮该在的位置」上，今天自然就轮到他，之后的轮次继续按名单顺序往下走。

```
pos   = (cycleIndexAt(g, cycle) * perRoundOf(g)) % len   // 本轮起点在名单里的下标
shift = (k - pos + len) % len                            // k = 被指定的人在名单里的下标
g.members = g.members.slice(shift).concat(g.members.slice(0, shift))
```

名字只跟人走、不跟位次走 —— 转完之后被指定的人**正好**落在 `pos` 上，所以「今天轮到 TA」这件事不需要任何额外记录，`assigneesFor()` 照旧算得出来。也正因为如此，本次不新增任何字段，旧数据一个字节都不用动。

## 二、顺带作废本轮的临时换人

如果这一轮本来记着一条换人，而正常排班又已经轮到被指定的人，留着那条记录会出现自相矛盾：**星图上亮的是换上来的人，名单里排的却是 TA**。所以 `redesignate()` 在真正改动名单时会把 `g.overrides[cycle]` 一并删掉（`delete g.overrides[cycle]`）。

同理，如果今天本来就已经轮到 TA、本轮也没有换人，函数直接返回 `false`，调用方据此**跳过落盘与「已修改」提示**，只回一句「TA 今天本来就在值日，名单没有变」。没成员、id 不在名单里、轮换没开始或正在暂停，也都返回 `false`；前两种静默不动，最后一种由调用方提示「先把起始日期设成今天」。

## 三、床位不动（踩坑）

`g.seats` 空着的时候，星图有一条兜底规则：**第 i 位成员睡第 i 号床**。这条规则很省事，但它意味着「转名单」会被星图解释成「全体换床」—— 用户想换的是值日的人，结果整张宿舍跟着挪了一遍。

所以 `redesignate()` 在转动名单**之前**先把座位实体化：床位档有值且 `seats` 还全空时，用 `seatsOf(g, size)` 把当前排布铺成显式 id 列表，之后再转名单。转完之后床位号还是原来的床位号，只有「今天谁值日」变了。

小程序没有床位星图，`ddRedesignate()` 因此不做这一步（测试里有一条断言钉住它不会凭空写 `seats`、也不会动 `roomSize`）。

## 四、入口只放一个

桌面端放在星图上方那一行（视角 / 显示床铺 / 旋转 / 编辑床位）里 —— 那是全插件**唯一一个改数据**的控件行，其余都是看和转视角的，放这儿不会被当成视角开关。文案是「今天值日 + 成员下拉」，`aria-label` 写明「重新指定今天值日的人，之后的轮次按名单顺序接着往下」。

小程序放在「成员与轮换顺序」卡片顶部，用原生 `<picker mode="selector">`，并跟一句：「选谁，今天就是谁值日，之后按名单顺序接着往下轮（与床位无关）。想只改这一轮、下轮回到原排班，用上面的『临时换人』。」—— 两个入口的分工在界面上说清楚，免得用户拿换人当指定用。

## 五、测试怎么钉住

`test-dorm-duty.mjs` 新增两块：

- **7.3b（桌面端）**：`perRound` 1/2 × 指定 `mA/mB/mC` × 跨 5 个日期。断言被指定的人当天当班、之后按名单顺序接着往下、成员集合不变、后续轮次不受这一次指定打乱、房间档与座位不动；空名单 / 未知 id 返回 `false`。
- **7.3c（跨端）**：同一份种子分别喂给桌面 `redesignate()` 与小程序 `ddRedesignate()`，逐日比对当班人。**比集合不比次序**：每轮多人且轮次跨过名单末尾时，桌面按「本轮第几位」排（`pos, pos+1…` 绕回队首），小程序按名单顺序排 —— 集合一致、次序不同，那是两端列表画法差异，不是排班差异（这一点写在用例注释里）。

星图渲染那条断言原先靠 `!html.includes('>小满<')` 判断「编辑模式下名字变成输入框」，加了成员下拉之后这个判据不再成立（下拉里本来就有全部成员名），改成只查星星上的名字按钮，并补上「下拉唯一」「下拉列出全部成员」。

## 六、边界

- **多人一轮**（`perRound > 1`）时，被指定的人会被挪到**本轮第一位**，本轮其余位置由他后面的人补齐。「今天轮到 TA」在多人轮里只能表达成「TA 排在本轮最前」。
- 轮换**暂停或没开始**时不给指定（没有 `cycleStartOf` 就没有「今天这一轮」），提示先设起始日期。
- 指定是**长期**动作，没有撤销按钮 —— 撤销就是再指定回原来那位（会按当时的位置重排）。真只想要「今天替一下」，用临时换人。
- 小程序端 `ddRedesignate()` 是不可变风格（返回新组），桌面端 `redesignate()` 就地改并返回「有没有变」；这是两端既有的写法差异，语义一致。

## 版本归属

v0.173.0 加的星图、v0.191.0 加的编辑床位，这次是同一张星图上的第三个入口；`package.json` 从 0.228.0 到 0.229.0。
