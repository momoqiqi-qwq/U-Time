# v0.189.0 · 教务视图的「登录失败 / 拉取失败」横幅整条可点，点一下等同工具栏「刷新」

> `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.189.0`；
> 只动内置插件警大通知（`public/plugins/cppu-notify/main.js` + 它的 `manifest.json`）与
> `scripts/test-cppu.mjs`，桌面 / 手机端共用的 `src/styles.css`、小程序、Rust 侧、
> `tauri.conf.json` 均无改动；`node tools/sync-plugins.js` 已把插件号写进两端插件目录。

## 用户要求原文

> 「添加功能-点击这个横幅也可以刷新。」（附图：警大通知 › 教务 › 选课，横幅「登录失败，正在显示缓存（更新于 09/22 13:21）；可点击「重新登录」重试。」）

## 一、先确认「这个横幅」是哪一条

截图里的两条副标题（`可参加的选课任务 … 09/22 13:21`、`已选课程 … 09/22 13:21`）是
`jwAt(key)` 吐出的「更新于 MM/DD HH:mm」，而这段文案只在一处生成 —— `jwStateBlock(key, loadingText)`
的错误分支。它被 11 个取数块共用（xkTask / xkResult / qjCourse / qjRecord / creditPlan /
creditModule / grade / cxCredit / cxDetail），所以改这一处就覆盖全部教务子页。

改前它是一个**不可点**的 `<div class="pp-banner">`：同一屏里的工具栏「刷新」能救它，
但用户盯着横幅看的时候，横幅本身没有任何反应。文案里那句「可点击「重新登录」重试」
是让用户去别处点，反而把「这条能点」的直觉用错了地方。

## 二、改法：横幅升级成真正的按钮，但没有换掉任何一个类名

`.pp-banner` 的底色 / 描边 / 圆角 / 内边距 / 行高一个字没动，只叠一层 `pp-banner-act`：

```js
if (jwState.error[key]) return `<button type="button" class="pp-banner pp-banner-act" data-jw-banner-refresh><span class="pp-banner-txt">${esc(jwState.error[key])}</span><span class="pp-banner-act-hint">点击刷新</span></button>`;
```

- **为什么用 `<button>` 而不是给 div 挂 click**：Tab 能聚焦、Enter / Space 能触发、读屏会念成
  「按钮 + 失败原因」，是三件白拿的无障碍；`appearance:none` 把浏览器默认长相清掉，视觉上仍是原来那条横幅。
- **右侧多一句「点击刷新」+ `↻`（`:hover` 时转 90°）**：措辞沿用仓库里既有的可点横幅写法
  （`tide.notify(..., { onClickHint: "点击定位文件" })`），让「这条能点」自己说出来，不靠用户悬停试探。
- **点哪一条都刷整个视图的 keys**：`cppu-xk` 这类视图一次要看两个 key，只刷被点的那一条会留下
  另一条旧横幅，看着像「刷了没用」。所以走的是和工具栏「刷新」完全同一条 `jwEnsureKeys(cfg.keys, true)`。
- **加载态仍然是不可点的 `.pp-empty` 纯文字**：转圈期间不给出可点目标，避免连点堆请求。

宽度用 `width:100% + box-sizing:border-box`（`button` 改 `display:flex` 后 `width:auto` 在部分
WebView 里会 shrink-to-fit 收成一小块）；`min-height:44px` 是触摸目标下限；
`touch-action:manipulation` 去掉移动端双击缩放那 300ms 等待。

## 三、两种文字色的对比度必须过 AA

横幅是浅米黄硬编码（它不在 `src/styles.css` 的「内置插件深色兼容层」`!important` 名单里，
深浅两态都是这条米黄），所以「按下会不会更难看清」只能靠自己算：

| 底色 | `.pp-banner` 正文 `#8A6420` | 提示 `#8A5A00` | 原提示色 `#B26A00` |
|---|---|---|---|
| `#FFF7E8` 常态 | 5.03 | 5.57 | 3.98 ✗ |
| `#FFF1D0` 悬停 | 4.78 | 5.29 | 3.78 ✗ |
| `#FDEBC2` 按下 | 4.55 | 5.04 | — |

11px 加粗的提示字仍然算正文（不是「大字号」），门槛是 4.5:1，所以提示色从
`#B26A00`（3.98）换成 `#8A5A00`，按下的底色从 `#FBE3AE` 收到 `#FDEBC2`
（否则正文色在按下时掉到 4.26）。这两个值由 `scripts/test-cppu.mjs` 用仓库的
`tools/lib/theme-tokens.js` 现算现卡，换色就红。

## 四、验证

真渲染（无头 Chrome + 真 `src/styles.css` + 最小 tide 替身复现截图那一刻：有 `jwCache`、
登录已失效、取数一律 `connection refused`）：

```
1100px 容器：BUTTON[data-jw-banner-refresh] 880×47.6  x=162 right=1042  min-height 44px
             cursor pointer  display flex  text-align left  bg rgb(255,247,232)  color rgb(138,100,32)
             提示 60×19.8  color rgb(138,90,0)  ::before "↻" 13px  transition transform .18s
             root 无横向溢出（scrollW 1100 = clientW 1100，fitsContentBox true）
390px 容器：BUTTON 334×90.8（正文折两行）x=28 right=362，内容盒右界 376 → 仍不溢出
改前 / 改后像素差：differing 2947 / 1080000 = 0.27%，最差区块全部落在横幅那一条带内
```

真点击（同一份页面里 `btn.click()`，浅色）：

```
httpBefore 1 → httpAfter 4（newRequests 3）
横幅文案：登录失败，正在显示缓存（更新于 09/22 13:21）… → 警大统一身份认证未建立：请在下方完成登录后重试
```

「点一下真的又跑了一轮取数」在真浏览器里成立（不是只重画了一遍）：旧横幅被清掉、重新登录失败后
又挂出新横幅 —— 用户想连点重试的那条路是通的。

回归测试（`node scripts/test-cppu.mjs`）：

- 形态：错误态必须是 `<button … class="pp-banner pp-banner-act" data-jw-banner-refresh>`、
  正文在 `.pp-banner-txt` 里、右提示是 `.pp-banner-act-hint`「点击刷新」；加载态 / 无错无载时不变
  （分别仍是 `.pp-empty` 与空串）；`<img src=x onerror>` 必须被转义。
- 行为：用假 DOM 把真 `mountJwView` 跑起来 —— 改前那种「登录失败 + 有缓存」的状态下点横幅，
  `calls` 必须增长、两个 key 的 loading 都要收干净、还是登不上就得留着横幅可继续点；
  换成能连通的响应后再点，两条 error 都要清空、数据要真的换新、`at` 要盖新时间戳、横幅要自己消失。
- 守卫：`.pp-banner-act:focus-visible{outline:3px solid #2EC4B6`、
  reduced-motion 名单里含 `.pp-banner-act,.pp-banner-act-hint::before{transition-duration:.01ms!important}`、
  点击分支那一整行必须含 `await jwEnsureKeys(cfg.keys, true); return;`、两个文字色的对比度断言。
- 变异测试：把点击分支改成 `if (false && …)` → 守卫红；改成空 `return;` → 「点横幅必须真的再发一轮请求」红；
  把提示色改回 `#B26A00` → 对比度断言红（3.98 < 4.5）。三次变异都被断言抓到，改完复原后全绿。

## 五、影响面

- 警大通知插件的全部教务子页（选课 / 请假 / 学分 / 成绩 / 创新学分）共用这一条横幅形态，一起生效；
  只读视图（老师端 / 学籍卡）不涉及。
- 桌面 / Android / 小程序三端的视图注册与数据链路没动，插件号 1.37.0 → 1.38.0 由
  `tools/sync-plugins.js` 同步到两端的 `pluginCatalog.js`。
- 深色模式：横幅自己带浅米黄底，与改前完全一致（真渲染里深浅两态的横幅几何 / 配色逐项相同），
  夜里那条底色仍是全插件里最「跳」的一个 —— 这是历史遗留，不在本次范围内。
- 数据迁移：无（未动 `jwCache` 结构与任何存储键）。
