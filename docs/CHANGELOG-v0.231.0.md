# v0.231.0 · 免责声明改为手动勾选，关于页加可折叠的说明栏

> 归属说明：改动进 `le-time-management/src/`（属「必须升版本」的目录），
> 随 v0.230.0 之后的 v0.231.0 发布（新增交互与界面调整 → minor +1）。
> 校验：`node ../tools/sync-version.js --check` → ✓ 三端版本一致 v0.231.0；
> `gen-theme-dark.js --check` / `build-schedule-plugin.js --check` / `sync-android-native.js --check` → ✓；
> `npm test` → 139 个测试脚本全部通过。

## 起因

用户三条要求：

1. **免责声明需手动勾选** —— 原来的弹窗只有「我已阅读 / 稍后阅读」两个键，点一下就过。
2. **确保首次使用时弹出** —— 不能被任何短路拦掉。
3. **关于页面加一个免责声明的收缩栏**，且**声明内容要改，尤其是账号和隐私相关的声明**。

## 改了什么

### 1. 启动弹窗变成「必须手动勾选」的确认门（`src/ui.js`）

`appDialog` 新增 `options` 参数，支持 `{ id, label, required, checked }` 勾选项：

- `required` 项没勾上时，确认键保持 **`disabled`** —— 点不动，比「点完再弹一句请先勾选」更难被误跳过；
  同时 `submit()` 里再判一次（回车 / 程序化点击也拦得住）。
- 有勾选项时 `resolve` 返回 `{ confirmed, checks }`，没有时保持原来的布尔语义 ——
  全仓库其余 20 多处 `appConfirm` 调用零改动。
- 焦点顺序：**必勾项优先拿焦点**（这是「必须本人手动确认」的门，可操作的那个控件才是落点），
  说明正文带 `tabindex`，Shift+Tab 就能回去读；确认键被禁用时**永不**拿焦点。
- 样式：`.app-dialog-check` 44px 触达高度、`:has(input:focus-visible)` 外框、勾上后底色加深；
  `:disabled` 的确认键降不透明度并去掉 hover 反馈。

`src/disclaimer.js` 导出 `DISCLAIMER_ACK`（`{ id: "ack", required: true }`）并传给对话框。

### 2. 首次使用必定弹一次（`src/disclaimer.js` / `src/main.js`）

- `DISCLAIMER_VERSION` **2 → 3**：本机阅读记录按版本号比对，所以**所有已装设备升上来都会重新弹一次**。
- `force` 选项：关于页的「重新阅读确认」用它**绕过全部「已读过」短路**照常弹窗，取消也不抹掉已有记录。
  ⚠️ 这里踩过一个真 bug：一开始把「本会话已读」短路写在 `force` 判断之前，结果用户确认过一次之后，
  关于页那个按钮点了没反应 —— **假按钮**。现在 `if (startupDialog) …` 之后就是 `if (!force) { …全部短路… }`。
- `src/main.js` 的 `await showStartupDisclaimer()` 改成**不 await**：弹窗本身是全屏遮罩模态，已经挡住交互；
  `await` 会把通知、采集、提醒、快捷键的初始化一直吊在用户点掉弹窗之后 —— 用户把窗晾着，提醒就一直没注册。
- 记录仍只写本机 `localStorage`（`letime-disclaimer-read`），不随账户或数据同步：换设备、清数据、说明升版都会重弹。

### 3. 关于页：可展开 / 收起的说明栏（新增 `src/disclosure.js`，铁律七）

新增通用折叠组件 `createDisclosure({ title, content, description, aside, open })`：

- 高度走 `grid-template-rows: 0fr → 1fr` + 内层 `overflow: hidden`：**能连续插值到真实内容高度**，
  不需要先量高度，收起时保留中间帧；展开与收起都有动画，箭头 `rotate(45deg → 225deg)` 连续转。
- 快速连点由 CSS 过渡自身接续（目标状态就地改写），不排队、不叠加、不残留临时样式。
- 收起态给面板挂 **`inert`**：内部按钮既点不到也拿不到键盘焦点；`aria-expanded` / `aria-controls` /
  动态 `aria-label`（展开/收起「使用说明与免责声明」）齐全；`Escape` 收起并把焦点送回触发按钮。
  ⚠️ **`inert` 必须延迟 340ms 再挂**：Chrome 对 `inert` 子树直接跳过渲染/布局，
  与类切换同一帧生效时 `1fr → 0fr` 的中间帧会全塌成 `0px` —— 实测**收起方向一帧过渡都没有**
  （`getAnimations()` 为空、每帧都读到 0px），展开方向却正常。过渡期间的不可点 / 不可聚焦
  交给 `visibility: hidden`（延迟 320ms 生效），与设置页既有的 `.sync-disclosure` 同一套语义。
- 折叠状态按稳定 key（显式 `id` → `title`）记在模块级 `Map` 里：设置页会按 `settings.*` 变化
  **整段重挂分区**，状态只存 DOM class 会被打回初始值，用户刚收起的说明会自己弹回来。
- 触达高度 `min-height: 44px`（手机端实测 44px；标题行留白相应收到 `14px / 6px`）。
- 减少动效（`data-ui-motion="reduced"` 与系统 `prefers-reduced-motion`）下过渡置 `none`，立即切换。

`src/views/aboutCard.js` 用它替换原来的静态 `sectionTitle + createDisclaimerContent()`，
右侧带**阅读状态徽标**（「本机已确认 / 尚未确认」）与「重新阅读确认」按钮，`520px` 以下换行不挤标题。

### 4. 声明内容改写（`DISCLAIMER_SECTIONS`，7 条 → 8 条）

账号与隐私相关的三条拆开写，把「数据去向」和「凭据保管」讲成两件事：

| 原 | 现 |
|---|---|
| 本地数据与备份 | **本地数据与系统权限**（明确默认只存本机、不上传开发者服务器、权限可撤回、物理接触设备的风险） |
| 联网、隐私与第三方费用 | **联网、隐私与第三方服务**（核心功能不需要账号、不自动注册；逐项列出会发出去的内容与令牌） |
| 账号、插件与合法使用 | **账号、凭据与账号安全** + **插件与第三方服务边界**（软件不索要、不代管第三方密码；建议应用专用密码 / 可撤销令牌；多设备与 WebDAV 凭据自管） |
| 责任边界与问题反馈 | **合法使用与责任边界**（补「不用于绕过访问控制、验证流程或付费限制」） |

「勾选并确认仅记录本机已查看此版本，不代表授权所有联网功能、同意任何第三方条款或放弃法定权利」——
这句话同时出现在弹窗与关于页（同一份 `DISCLAIMER_SECTIONS`，避免两处条款漂移）。

## 验证

- `node scripts/test-disclaimer-ux.mjs` → PASS。覆盖：8 条声明、纯文本出口条数、
  `required` 勾选项、并发调用共用同一弹窗、取消不写记录、勾选确认才写版本、
  本会话已读不重弹、**force 复核必须真的弹窗**（计数 +1）且取消不回退记录、换设备（无记录）仍弹、
  旧版本说明视为未确认、关于页折叠栏的展开/收起 CSS 与减少动效、以及**真跑 DOM 替身**验证
  「未勾选时确认键 disabled、点它不关窗、勾上后解禁、返回 `{ confirmed, checks }`」。
- `npm test` → 139 个测试脚本全部通过（含被本次改动影响后同步更新的
  `test-notification-onboarding.mjs`（版本号改为从模块读，不再硬编码）与
  `test-ui-scale.mjs`（520px 断点 3 → 4 处））。
- `sync-version.js --check` ✓ v0.231.0 三端一致；`gen-theme-dark.js --check` ✓ 15 套深色变体同步；
  `build-schedule-plugin.js --check` ✓；`sync-android-native.js --check` ✓（升版本后
  `gen/android/app/src/main/assets/tauri.conf.json` 用 `sync-android-native.js` 重同步过）。
- **无头 Chrome 真渲染实测**（390×844 与 1280×900，真 CSS、真应用外壳）：
  折叠栏收起中间帧 10 帧（`2019 → 1906 → 1465 → 724 → 436 → 144 → 43 → 11 → 2 → 1 → 0`）、
  展开 13 帧（`0 → 45 → 139 → 579 → 1085 → 1470 → 1733 → 1827 → 1989 → 2011 → 2019`），
  两向单调、无内联样式残留；快速连点 4 次落回展开态且不跳回起点；`Escape` 收起 + 焦点回触发按钮 +
  设置弹窗不被连带关掉；收起态往面板里塞按钮**聚焦不上**（`inert` 真生效），展开后可聚焦；
  `aria-controls === panel.id`；两个视口 `documentOverflow = 0`、无越界元素。
  首次弹窗：标题「使用说明与免责声明」、勾选项未勾时确认键 `disabled`（`opacity: .5`）、
  焦点落在勾选项、点确认不关窗且不写记录、勾上才解禁、取消返回 `false` 不写记录、
  确认返回 `true` 且写入 `"3"`、第三次调用不再弹、`force` 照常弹且确认键仍禁用；
  正文滚动区 `1834px / 630px` 可滚动、`tabindex="0"` + `role="region"`、对话框完整落在 844px 视口内。

## 边界

- 弹窗**只在原生端弹**（`api.isTauri`）：浏览器预览会挡住录屏，这条是原有行为，没动。
- 阅读记录是**本机**记录，不是账号级授权：不同步、不随账号迁移，清除应用数据即失效。
- `force` 只影响「要不要弹」，**不影响写入**：复核时取消，原来那条「已确认」记录保持原样。
- 折叠栏默认**展开**（与 `sync-disclosure` 的默认一致），首次进入关于页不用再点一下才看得到正文；
  用户收起过之后，重开设置页保持收起（按 `title` 记住，不写盘、重启即回默认）。
- 小程序端没有免责声明副本，本次未改 `miniprogram/`。
