# v0.253.0 · 警大门户通知插件新增「上网记录」视图

## 改了什么

- `le-time-management/public/plugins/cppu-notify/netlog.js`（新增，约 470 行）：视图主体
  `createNetLogView(tide, bridge)`。四张区间统计卡（在线时长 / 总流量 / 计费金额 / 上网次数）、
  按天聚合的流量细条（取最近 14 天，宽度按当日流量占比）、按天分组的明细表（点行展开
  国际与国内上下行、登录 IP、MAC、NAS、金额、位置、备注）。
  - 区间四选一：近 7 天 / 近 30 天 / 近 60 天 / 自定义。单选高亮走
    `tide.ui.selectionGlow()` 滑动光，只切 `aria-pressed` 不重建 DOM（铁律六）。
  - 自定义区间用 `grid-template-rows: 0fr ↔ 1fr` 连续插值展开与收起，收起后内部控件
    `visibility:hidden` + 不可聚焦，维护 `aria-expanded` / `aria-controls`（铁律七）。
  - 明细本地分页：一次渲染 40 条，`[data-nlog-more]` 每次追加 40，避免上千行一次进 DOM。
  - `flow` 字段恒为 0，**不参与计算**；单行流量取国际上下行 + 国内上下行之和。
  - 偏好（区间选择、自定义起止）落 `netLogViewPreferences`，换账号按用户名隔离。
- `le-time-management/public/plugins/cppu-notify/main.js`：
  - 新增 drcom 桥（`DRCOM` / `drcomLogin` / `drcomSpans` / `drcomFetchSpan` /
    `drcomAggregate` / `drcomLogs` / `netBridge`）与 `mountNetLogView`。
    **drcom 是独立会话**：不与已接入的门户、教务、pdata 三站共用票据，只是账号密码复用
    `ensureLoginPrefs` / `readSavedPassword`，不新增任何存储。
  - 登录：表单必须同时提交 `code` 与 `random` 两个验证码字段（漏一个必 302 回登录页，
    且服务端不给错误文案）；成功判定不看 302 的 `Location`，而是拿一次账单接口看回来的
    是 JSON 还是 HTML。会话先从密钥库的 Cookie 快照续期，续不上才走密码 + 验证码，
    每次失败重取新图（验证码与会话绑定，复用旧图等于白烧一次机会），识别样板回存给内置 OCR。
  - 取数：`pageSize` / `pageNumber` 驼峰分页（`limit` / `offset` 会被服务端忽略、静默回 10 行），
    `sortName=loginTime&sortOrder=DESC`，`startTime` / `endTime` 为 `YYYY-MM-DD`。
    接口自身上限 60 天且**超限不报错、只静默裁剪**，所以超过 60 天由前端切段拉取，
    再按「上线时间 + 登录 IP + NAS 端口」去重、按上线时间倒序合并。
  - `QUICK_LINKS` 在「一卡通」之后加入口「上网记录」（`view: "cppu-net"`，图标 `network-wired`）。
  - 注册 `tide.ui.registerView({ id: "cppu-net", title: "上网记录", icon: "network-wired" })`。
- `le-time-management/src/icons.js`：`VIEW_ICONS8` 加 `cppu-net: ["network", "data-transfer",
  "network-wireless"]`，`VIEW_FA_ICONS` 加 `cppu-net: "network-wired"`。取「联网」语义而不是
  图表语义 —— `line-chart` 已经是警大成绩，同侧栏再放一张图表图标会读成同一类东西。
- `tools/gen-plugin-icons.py`：`VIEW_ICONS` 加 `cppu-net`，据此生成
  `public/icons/plugins/cppu-net.png` 与 `miniprogram/images/plugins/cppu-net.png`（同源同字节）。
- `le-time-management/scripts/test-plugin-view-icons.mjs`：视图期望列表加 `cppu-net`，计数 9 → 10。

## 影响哪端

- 桌面端与 Android 端：警大门户通知插件侧栏多一个「上网记录」入口，图标随包，两处 PNG 同一份素材。
- 插件对外权限不变：只多走 `http`（`tide.http.session/fetch/exportCookies/restoreCookies`），
  不申请新能力；Cookie 快照与密码仍只在密钥库（Rust AES-256-GCM），不进 storage、不进日志。
- 小程序端只多一张图标素材，视图本身不随小程序发布。

## 数据迁移

无。新增的是独立视图与其本地偏好键 `netLogViewPreferences`，旧数据不受影响；
首次进入需要一次 drcom 登录（验证码），之后靠会话快照续期。

## 校验

- `node ../tools/sync-version.js --check` → v0.253.0 三端一致
- `node ../tools/gen-theme-dark.js --check`
- `node ../tools/build-schedule-plugin.js --check`
- `node ../tools/sync-android-native.js --check`
- `npm test`
