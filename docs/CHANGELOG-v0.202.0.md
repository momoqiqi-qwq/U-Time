# v0.202.0 · 学习通卡片右键（手机端长按）上色：9 个固定色 + 四档作用范围，「所有没做完的作业都是这个颜色」靠规则而不是逐条点

> `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.202.0`；
> `node ../tools/gen-theme-dark.js --check` → `✓ 派生调色板已同步（15 套深色变体）`；
> `node ../tools/build-schedule-plugin.js --check` → `✓ shiguang-schedule 生成物与源一致`；
> `node ../tools/sync-android-native.js --check` → `✓ Android 原生代码与版本化镜像一致`；
> `node ../tools/sync-plugins.js --check` → `✓ 插件生成物与清单同源（18 个内置插件）`；
> `npm test` → `PASS: 129 个测试脚本全部通过`。
> 动的文件：`le-time-management/public/plugins/chaoxing-notify/main.js`（+330 / −7 行，1570 行）、
> `public/plugins/chaoxing-notify/manifest.json`（2.18.0 → **2.19.0**）、
> `scripts/test-chaoxing.mjs`（版本断言去硬编码）、**新增** `scripts/test-chaoxing-card-color.mjs`（283 行）、
> `le-time-management/package.json` / `package-lock.json`（0.201.0 → **0.202.0**）、
> 同步器带出的 `src/pluginCatalog.js`、`miniprogram/core/pluginCatalog.js`、`src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json}`、
> `gen/android/app/src/main/assets/tauri.conf.json`、根 `docs/CHANGELOG-v0.202.0.md`。

## 用户要求原文

> 「右键卡片可以设置颜色，比如没做完的作业设置成这个颜色，所有没做完作业都是这个颜色」

附一张学习通收件箱截图。这句话是**两个要求**，第二个才是主体：

1. 右键卡片能设颜色（手机端得等价可用）；
2. **设一次就管住整组** —— 「所有没做完作业」永远是同一个颜色，而不是一条条去点。

---

## 一、两句话就是两层数据

只做「右键 → 单卡上色」是个 30 行的功能，但那样第二句话就废了：下次同步进来一条新的没做完作业，
它还是白的，用户得再点一次 —— 这正是用户想避免的事。

所以分成两层（和这个插件早就有的「已读覆盖」同族，都只落本机、不动学习通平台任何数据）：

| 层 | 存什么 | 谁赢 |
|---|---|---|
| `cardColors: Map<id, 颜色键>` | 单条通知一个色，最具体 | 永远优先 |
| `colorRules: [{scope, color}]` | 整组上色的**规则** | 单条没标记时生效 |

关键点：**规则是在渲染时求值的，不是「当前命中的卡片染完色再存下来」。**
`colorOf(n)` 每次画卡片现算一遍，所以新同步进来的通知只要有规则命中就自动带上色 ——
用户不用做任何额外动作。「所有没做完作业都是这个颜色」就是靠这一点成立的。

三个作用范围（`scopeHit` 判据）：

| scope | 值 | 命中 |
|---|---|---|
| 仅这一条 | `card` | 不走规则，直接写 `cardColors` |
| 所有没做完的作业 | `hw` | 作业 + 未截止未提交 / 已逾期未提交 |
| 全部某类通知 | `cat:作业` | 按 `classify()` 的分类 |
| 全部某门课 | `course:C语言程序设计A` | 正文里的「课程名称：X」 |

四级菜单项各自带**命中条数**（`<i>2</i>`），点之前就知道会改几条，不用猜。

## 二、「没做完」的判据和待办页同一套

新增 `secOf(n)`，复用待办页已有的 `deadline()` + `statusOf()`，六档：

| 档 | 判据 | 算不算「没做完」 |
|---|---|---|
| `open` | 未截止 + 未提交 | ✅ |
| `late` | 已逾期 + 未提交 | ✅ |
| `submitted` | 已提交 + 未截止 | ❌（探到已提交就是做完了，哪怕还没批改） |
| `submitted`（逾期） | 已提交 + 已逾期 | ❌ |
| `grading` | 已提交 + 截止时间没写（第五档那类） | ❌ |
| `""` | 非作业 | — |

`pendingWork(n) = open || late`。**为什么不把「已提交未批改」算进去**：那类作业用户已经在等成绩了，
把它标成「没做完的作业」的红，等于把「还没做」和「做了没出分」混成一色 —— 正是颜色标记最该避免的歧义。

## 三、越具体越优先：课程 > 没做完的作业 > 分类

`ruleColorFor(n)` 固定按这个顺序找第一条命中的规则。理由单一：**scope 越具体，用户表达的意思越强**。

如果反过来（分类优先），用户在「全部《形势与政策》→ 紫」之后还会看到这门课的作业是红的，
并且无从解释为什么 —— 因为「全部作业」这种大范围规则把它吞了。反过来做，大范围规则仍是绝大多数卡片的
默认色，只有被单独点过名的更具体那一组会跳出，符合直觉。

同范围换色只留一条规则（`colorRules` 里按 scope 去重），不是叠上去。

## 四、色板：9 个固定色，故意不跟主题走

`red #e0523f / orange #e07b2a / amber #d4a017 / green #2fa36b / teal #2b9aa6 / blue #3b7dd8 /
violet #8a5bd6 / pink #d0568f / gray #8b8f98`。

**为什么用固定 hex 而不是主题变量**：这些色是「我用它区分什么」的**语义**，不是装饰。
主题一换（应用里有 15 套主题 × 明暗两态）就改色，用户昨天认的红今天变成青，标记就失去意义了。
底色与描边用 `color-mix` 就地稀释（底 13% + panel、上右下边 36% + line），所以深浅两套主题下都不糊成一块。

**颜色不能只靠颜色传达**：每张被标记的卡片在 `meta` 行前多一个色点，带 `aria-label="颜色标记：红"`
和同样的 `title` —— 色弱用户、以及「红橙分不清的屏」都能读到具体颜色名。

**左边框只单写 `border-left-color`，绝不写 `border` 简写。** 这不是新规矩：`.cx2-card` 的左边框同时承载
分类类型色（`.cat-sun` 等）与「未读 / 逾期」描边，`main.js` 里早有一条注释写着用简写会把它们吞掉。
颜色标记作为第三层，只改左边框的 `color`，其余三边各自单写。

## 五、手机端：`contextmenu` 不一定来，浮层的安全区得自己让

- **长按兜底**：Android WebView 上 `contextmenu` 事件不保证派发，所以自己数时间 ——
  `LONG_PRESS_MS = 520`、位移超过 `LONG_PRESS_SLOP = 10px` 就取消（列表里滑动时不误弹）、
  触发时 `navigator.vibrate(12)` 给一次触觉反馈。只在 `(pointer:coarse)` 且 `pointerType !== 'mouse'` 时启用，
  桌面左键按住不会弹菜单。
- **浮层四边让开**：`position:fixed` 的包含块是 `.view` 的 **padding box**（`.view` 上有 `will-change: transform`），
  padding 划不出它的新边界 —— 所以菜单必须自己读宿主注入的 `--sat/--sab/--sal/--sar` 并把坐标夹回视口内：
  `x = max(8+sal, min(x, w - sar - 244))`、`y = max(8+sat, min(y, h - sab - 348))`，
  `max-height` 也写成 `calc(100vh - 16px - var(--sat, 0px) - var(--sab, 0px))`。
  **不写 `env()`**：桌面端 `--sat` 未定义 → 0px 正好；手机上裸 `env()` 恒为 0（Android WebView 不认），
  写了等于没写。`scripts/test-plugin-safe-area.mjs` 的四条规则就是这么拦的（本版改前正红在这里）。
- **收起路径**：点外面 / 滚动 / 改窗口尺寸（capture 阶段监听）→ 收起；`Escape` 收起并 `stopPropagation()`
  （不该顺手关掉宿主别的东西）；菜单内部滚动不收起。

## 六、坏数据不许把整页带走

`saveCardColors / saveColorRules / saveColorScope` 三个键（单卡数组照旧截 `MAX_KEEP = 1000`）。
`loadPrefs()` 逐项校验：非数组行丢掉、颜色键必须在 `CARD_COLORS` 里（`COLOR_NONE` 是唯一例外）、
规则必须是非空字符串 scope + 合法颜色。老版本升上来的用户这三个键根本不存在 → 一律走空态。

`COLOR_NONE = "none"` 是「清除颜色标记」的哨兵值，不是可选色。**没有它「只去掉这一条」就做不到**：
单卡若只是被删掉键，规则会立刻把它染回来（用户看到的现象是「点了清除还在」）。有了哨兵，
「显式清除」才能压过规则，而它自己也不显示任何颜色。

## 七、测试

**新增 `scripts/test-chaoxing-card-color.mjs`（283 行，12 组断言）**，走 `vm` 掰开 IIFE 直接驱动真源码：

| 组 | 拦什么 |
|---|---|
| ① 课程名解析 | 「课程名称：X」全角/半角冒号都要认 |
| ② 档位 | `open / late` 才算没做完；已提交探到的不许进；非作业不参与 |
| ③ 真实事件链路 | 右键 → 点作用范围 → 点颜色，全程走 `wire()` 里真正的委托处理器，不是直接调函数 |
| ④ **需求后半句** | 规则落盘后，**本次同步才出现的**没做完作业必须自动同色；非作业不受影响 |
| ⑤ 单卡压规则 | 单卡色 > 规则色；显式 `none` 要压过规则（不是回到规则色） |
| ⑥ 换色 / 取消 | 同范围换色只留一条规则；取消规则时组内单卡标记一起清 |
| ⑦ 一键清空 | `cardColors` 与 `colorRules` 一起归零 |
| ⑧ 落盘读回 | 非法颜色键、非数组行、非法规则全部丢掉，好数据留下 |
| ⑨ 优先级 | 课程 > 没做完的作业 > 分类 |
| ⑩ 安全区 | `--sat/--sab/--sal/--sar` 四条边都要夹到（x 上下界、y 上下界分别断言） |
| ⑪ 长按 / Escape / 鼠标 | 触屏长按弹菜单；鼠标按住不弹；点空白不弹；Escape 关且不冒泡 |
| ⑫ 样式与清单 | 左边框不许出现 `border` 简写；浮层 `max-height` 必须让开两栏；粗指针下色块 ≥42px；描述与版本已更新 |

同时把 `scripts/test-chaoxing.mjs` 里硬编码的 `assert.equal(manifest.version, '2.18.0')` 改成 semver 断言
（该文件第 201 行的注释本来就写着「别再硬编码两处」，现在两处一致了）。

**顺手修掉的一条跨 realm 噪音**：`vm` 里造的数组原型和测试进程不是同一个，`assert.deepStrictEqual`
会报 `Values have same structure but are not reference-equal`（上一版的变更日志里记过这条）。
比较前统一过一遍 JSON，把噪音和真断言分开。

## 八、验证

```
node scripts/run-tests.mjs                     → PASS: 129 个测试脚本全部通过
node ../tools/sync-version.js --check          ✓ 三端版本一致：v0.202.0
node ../tools/gen-theme-dark.js --check        ✓ 派生调色板已同步（15 套深色变体）
node ../tools/build-schedule-plugin.js --check ✓ shiguang-schedule 生成物与源一致
node ../tools/sync-android-native.js --check   ✓ Android 原生代码与版本化镜像一致
node ../tools/sync-plugins.js --check          ✓ 插件生成物与清单同源（18 个内置插件）
```

界面用 `letime-plugin-ui-check` 技能的 harness 出真 CSS 页面（`night` 主题 + 深色）逐项核过，落在
`.workbuddy/preview/cxcol-night-dark.png`（gitignored）：两张没做完的作业卡左竖条与底纹都是红、
已提交的那张保持类型色不吃规则、课程规则那张是紫、签到卡是青，菜单四边都在画面内。
（桌面左键按住不弹菜单、`Escape` 收起、滑动手势不误弹这三条截图看不出来，由第 ⑪ 组断言钉住。）

---

**一句话**：右键/长按 → 选颜色 → 选作用范围；作用范围选「整组」时存下的是**规则**而不是一堆涂好色的卡片，
所以「没做完的作业」这个颜色从此自动跟着新通知走，不用再点第二次。
