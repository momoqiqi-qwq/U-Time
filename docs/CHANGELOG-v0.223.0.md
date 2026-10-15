# v0.223.0 · 警大通知新增「个人信息」视图：点字段即复制到剪贴板

> 归属说明：本条改动进入 `public/plugins/cppu-notify/`（属「必须升版本」的目录），
> 随 v0.222.0 之后的次版本 v0.223.0 发布。
> 校验：`node ../tools/sync-version.js --check` → ✓ 三端版本一致：v0.223.0；
> `node ../tools/gen-theme-dark.js --check` → ✓ 派生调色板已同步（15 套深色变体）；
> `node ../tools/build-schedule-plugin.js --check` → ✓ shiguang-schedule 生成物与源一致；
> `node ../tools/sync-android-native.js --check` → ✓ Android 原生代码与版本化镜像一致；
> `node ../tools/gen-plugin-icons.py --check` → ✓ 图标无 DIFF；
> `npm test` → PASS: 138 个测试脚本全部通过。
> 插件 `manifest.json` 1.54.0 → 1.55.0（`sync-version.js` 不管插件版本，手改 + 跑 `node tools/sync-plugins.js`）。

## 改了什么

`cppu-notify` 新增第 9 个分类视图 **「个人信息」**（`cppu-profile`），对齐网页
`https://pdata.cppu.edu.cn/stu/dataReport/basicInfo`（路由表里 `/dataReport/basicInfo`
→ 模块 id `1-13-basicInfo`，CSS module `basicInfo___12KcP`）。

**它不是网页的复刻，多的是网页做不到的那一件事：点任意一格就把该字段的值复制到剪贴板。**

| 区块 | 内容 |
|---|---|
| 身份卡 | 头像（`personInfo` 返回的 base64）+ 姓名 + 学号 + 可点复制的标签（民族 / 性别 / 电话 / 出生日期 / 班级…） |
| 工具条 | 复制全部 / 打开原页 / 刷新 / 重新登录（只在 `state.loginNeeded` 时露出）/ 已复制计数 |
| 字段网格 | `column[]` 每一项一格，点一格复制一格；空值格不可点；右上角「已复制」角标 |
| 复制记录 | 可折叠，最近 12 条，点记录可再复制一次；偏好存 `storage` 的 `profileViewPreferences`（只存 `{histOpen}`） |

动的文件：

- 新增 `public/plugins/cppu-notify/profile.js`（475 行）—— 纯 ES module，
  `export function createProfileView(tide, bridge)`，末尾 `return { render, refresh: () => loadAll() }`。
- `public/plugins/cppu-notify/main.js` —— 新增 `mountProfileView(el)`（惰性
  `import("/plugins/cppu-notify/profile.js")`，桥对象直接复用现成的 `growthBridge`）；
  文件末尾注册 `{ id: "cppu-profile", title: "个人信息", icon: "address-card", render: mountProfileView }`；
  `QUICK_LINKS` 在「学生成长」之后插入 `{ view: "cppu-profile", label: "个人信息", icon: "address-card" }`。
- `public/plugins/cppu-notify/manifest.json` —— 1.54.0 → 1.55.0；`author` / `description` 前部补本视图一段。
- `src/icons.js`（手写维护，非生成物）—— `VIEW_ICONS8` 加
  `"cppu-profile": ["contact-card", "id-card", "business-contact"]`，`VIEW_FA_ICONS` 加 `"cppu-profile": "address-card"`。
- `tools/gen-plugin-icons.py` —— `VIEW_ICONS` 加同名条目（候选顺序与 `icons.js` 对齐），
  重跑生成 `public/icons/plugins/cppu-profile.png`（2327 B，源 `color/contact-card`）。
- 测试：`scripts/test-cppu.mjs`（视图清单加 `cppu-profile`、校园服务栏入口加一项）、
  `scripts/test-plugin-view-icons.mjs`（分类视图清单 8 → 9，断言文案同步）。
- 生成物：`src/pluginCatalog.js`、`miniprogram/core/pluginCatalog.js`、
  `src-tauri/Cargo.toml` / `Cargo.lock` / `tauri.conf.json`、`miniprogram/core/appMeta.js`、
  Android `tauri.properties` / `assets/tauri.conf.json` 等三端版本号。

## 数据从哪来

接口就一条：`GET /tsa/shc/homepage/personInfo`（`_USER` 由 `pdataApi` 自动追加），
返回 `{ code:2000, data:{ personInfo, column, personPhoto, basicFormId, QRCodeUrl } }`。

**取值口径照网页抄**（证据来自 pdata 前端产物 `umi.js`，两处同款实现）：

```js
// 值：带 _CN 后缀的中文值优先，没有才退回裸字段
const v = personInfo[dataField + "_CN"] || personInfo[dataField];
// 标签：column[].dataFieldName
// 性别另有 XB 兜底（网页：personInfo.SEX ? SEX : XB）
// 姓名 / 学号 / 性别三项与网页一样只进身份卡、不进字段网格（网页是 column.splice(0,3)）
```

`profile.js` 里 `HERO_FIELDS = new Set(["USERNAME","XM","USERID","ZGH","XH","SEX","XB"])`
就是这个 `splice(0,3)` 的等价物；`buildFields()` 在 `column` 少于 3 项时兜底扫 `personInfo` 的键，
遇到 `X_CN` 优先并把裸 `X` 跳过（裸键常是字典码）。

## 复制怎么做的

- `copyText(value)`：先 `navigator.clipboard.writeText`，失败退回离屏 `<textarea>` +
  `document.execCommand("copy")`（用完即 remove）。
- **复制反馈一律就地改类名，不重画**（`flash()` 加 `.pf-copied` + 1100ms 后移除，
  同时更新 `[data-pf-count]` 与 `[data-pf-histbox]` 的 innerHTML）——
  重画会丢滚动位置与焦点。
- **值不进 DOM 属性**：所有可复制项只带数组下标（`data-pf-tag` / `data-pf-cell` / `data-pf-hist`），
  值统一从 `state.heroTags` / `state.rows` / `state.history` 取 —— 后台字段值里出现过引号与换行。
- `bind(root)` 用**单个 `root.onclick` 委托**（`e.target.closest(sel)`），不逐个挂 onclick。
- 筛选框 `[data-pf-q]` 的 `oninput` 也**就地** `cell.hidden = !matches(...)`，不重画，
  否则会打断输入法组合；CSS 里补了 `.pf-cell[hidden]{display:none}`（否则 `.pf-cell{display:block}`
  与 `[hidden]` 同特异度、后者会输）。

## 三条铁律怎么落的

- **安全区**：本模块只画 `[data-pg-host]` 里的内容，四条边由宿主 `.view` 负责，**不垫第二遍**；
  全模块**零 `position:fixed`、零裸 `env()`**（复制反馈走行内类名，不做浮层 toast），
  所以 `scripts/test-plugin-safe-area.mjs` 的四条断言天然满足。
  ⚠️ 注意该测试是按**文本**扫 `position:fixed` 的 —— 连注释里写这个词都会红，注释只能写「fixed 定位」。
- **铁律七（下拉双向动画）**：`.pf-fold` 的展开 / 收起用
  `grid-template-rows: 0fr ↔ 1fr` + `opacity` 连续过渡（`.34s cubic-bezier(.2,.8,.2,1)`），
  `visibility` 一起过渡 —— 只靠 `0fr + overflow:hidden` 会「裁而不封」，
  收起后里面的按钮仍可被 Tab 命中。`aria-expanded` / `aria-controls` 同步，
  Escape 收起并把焦点还给按钮，`prefers-reduced-motion: reduce` 时过渡压到 `.01ms`。
- **铁律六（滑动选中光）**：本视图没有单选切换组，不涉及。

## 边界（重要）

- **网页那张二维码不做**：`QRCodeUrl` 要自己拼 `?token=<jwToken>&userId=…` 才能用，
  而 token 只活在 `main.js` 里（「SSO 会话与 token 不出本文件」是本插件的硬边界），
  插件侧拿不到，所以不画一个点了没用的二维码。
- **字段名是自适应的**：`column[].dataFieldName` 是否真有中文标签**未在真机核对过**
  （本机会话目录里没有可用 token，抓不到一次真实响应）。因此 `pick()` 做大小写不敏感取键、
  `buildFields()` 带兜底分支；真实登录后若发现标签为空，改 `buildFields()` 一处即可。
- 接口通了但一个字段都没有时，`state.stale` 会明说「接口通了，但没有返回任何档案字段」，
  而不是画一片空白。
- 鉴权复用「学生成长」那条 pdata 链路（同一套换票与 401/1001/4001 失效重试），
  没有新写登录；失效时按钮文案变「正在重新登录…」，失败只 `tide.notify` 报原因、**不动现有画面**。

## 验证

- `node --check public/plugins/cppu-notify/profile.js` → SYNTAX OK；`main.js` 同。
- `node scripts/test-plugin-safe-area.mjs` → PASS（28 个插件 JS 无裸 env()、无重复垫、fixed 浮层四边让开）。
- `node scripts/test-plugin-view-icons.mjs` → PASS（9 个分类视图的声明图标与 `icons.js` 两张表一致，
  彩色 PNG key 与视图 id 一一对应，两套图标各自两两不同）。
- `node scripts/test-cppu.mjs` → PASS（新增断言：视图清单含 `cppu-profile`、
  标题为「个人信息」、校园服务栏有 `view: "cppu-profile"` 入口）。
- `npm test` → PASS: 138 个测试脚本全部通过。
