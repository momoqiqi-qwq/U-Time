# v0.256.0 · 警大门户通知新增「邮箱」视图（自动登录读收件箱）

## 改了什么

- `le-time-management/public/plugins/cppu-notify/mail.js`（新文件，`createMailView(tide, bridge)`）
  - 「邮箱」视图主体：工具条（账号 + 登录态徽标 + 同步时间 + 全部/只看未读单选 + 刷新 + 打开邮箱）、
    概览两张卡（未读 / 收件箱总数）、收件箱最近 20 封的信头列表（未读点、发件人、主题、时间、字节数）。
  - 点任意一封 → 应用内邮箱窗口打开（原生端注入 Cookie，sid 不进 URL）；正文不在插件里展开。
  - 四态降级：骨架 / 需登录（两条出口：重新登录、在邮箱窗口里登录）/ 错误（有旧数据时先显示旧数据 +
    一行 stale 提示）/ 空态（区分「没有未读」「收件箱是空的」「会话通了但没解析出邮件」）。
  - 上次的结果落 `storage`（`mailViewPreferences`），再次进入先上屏再后台刷新。
  - 样式前缀 `ml-`，暗色小字统一 `color-mix(ink 78%, ink-2)`；筛选组走宿主 `selectionGlow`；
    无脱离文档流的浮层，安全区由宿主 `.view` 负责。
- `le-time-management/public/plugins/cppu-notify/main.js`
  - 取数桥：`mailPick` / `mailXmlTree` / `mailIsSessionDead` / `mailFolderStat` / `mailItems` /
    `mailApiSid` / `mailCoremail` / `mailLoad` / `mailBridge` + `mountMailView`。
  - `tide.ui.registerView({ id: "cppu-mail", title: "邮箱", icon: "envelope", render: mountMailView })`。
  - 复用既有自动登录：`ensureMailSession()` 用密钥库里的账号密码走 coremail 登录（含验证码、
    落地页 sid 提取、失败文案识别），本视图不碰 vault / Cookie / 验证码。
- `le-time-management/src/icons.js`：`VIEW_ICONS8` 加 `cppu-mail: ["email","mail","envelope"]`、
  `VIEW_FA_ICONS` 加 `cppu-mail: "envelope"`（此前没有任何视图用信封图标，不撞）。
- `tools/gen-plugin-icons.py`：`VIEW_ICONS` 加 `cppu-mail`，实测命中 Icons8 `color/email`
  （`mail` 这个 slug 在 Icons8 不存在），生成 `public/icons/plugins/cppu-mail.png` 与
  `miniprogram/images/plugins/cppu-mail.png`，并写进 ATTRIBUTION。
- `le-time-management/public/plugins/cppu-notify/manifest.json`：1.66.1 → 1.67.0，`author` 前缀补说明。

## 取数口径（为什么不用 Sirius 自己的 API）

- 老 XT 端点可用且只要会话：
  `GET /coremail/s/json?func=mbox:listMessages&mbox=Inbox&start=0&limit=20`、
  `func=mbox:getAllFolders`。
- Sirius 那套 `/corp-mail/mail/api/*`（`mail/list`、`mbox:listMessages`）未登录一律 401，
  bundle 里路径也没逆全，所以不用。
- 三个实测坑：
  1. 端点 `Content-Type` 谎报 `text/xml`，必须看 body 首字符决定按 JSON 还是 XML 解析。
  2. sid 认不认因部署而异：先不带 sid 试，回 `FA_INVALID_SESSION` 再带 sid 重试一次，
     两条都失败才判会话失效。
  3. 成功响应字段名没有契约（`var.i` / `var.message` / 顶层 `list` 都见过），
     条目与字段全部宽容取值；解析出 0 条不算错误，单独呈现并保底「在邮箱窗口查看」。

## 影响哪端

- 桌面端与 Android 端：侧栏多一个「邮箱」分类视图（cppu-notify 第 11 个分类）；其余功能不变。
- 小程序端不受影响。
- 权限、存储键（新增 `mailViewPreferences`）、账号密码链路均未改。

## 数据迁移

无。

## 验证

- 无头 Chrome 真实渲染（stub `tide` + fixture 覆盖未读/已读/长主题/无主题/无发件人/空列表，
  以及需登录态与解析失败态）：1000px 浅色、1000px 暗色、430px 窄屏各一版，无横向溢出、无裁切。
- `node ../tools/sync-version.js --check` → v0.256.0 三端一致
- `node ../tools/gen-theme-dark.js --check`
- `node ../tools/build-schedule-plugin.js --check`
- `node ../tools/sync-android-native.js --check`
- `node tools/sync-plugins.js`（manifest 版本与图标变了）
- `py -3.13 tools/gen-plugin-icons.py`
- `npm test`
