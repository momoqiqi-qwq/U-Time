# v0.251.0 · 网页收集默认收藏补两条警大站点

## 改了什么

- `le-time-management/public/plugins/web-collector/main.js` 的 `DEFAULT_ITEMS` 由 2 条扩到 **4 条**，
  后两条是本轮新增：
  - **中国人民警察大学官网** `https://www.cppu.edu.cn/index.htm`（备注「默认：学校官网」）。
    站点没有 `favicon.ico`（实测 404），图标只能取首页那颗站标 `images/sr-logo1.png`。
  - **学校门户** `https://portal.cppu.edu.cn/`（备注「默认：学校门户」）。根地址 301 到
    `sso.cppu.edu.cn` 统一身份认证，登录后落到 `/sopcb/`；图标用 portal 自己的 `favicon.ico`，
    不用 SSO 那颗（苏迪默认图，各校通用）。
- 老用户不需要手动加：`ensureDefaults()` 按 URL 去重补条，storage 里已有的四条不会重复补。
- `le-time-management/public/plugins/web-collector/manifest.json` 插件版本 `1.9.0` → **`1.10.0`**，
  并跑 `node tools/sync-plugins.js` 同步桌面 / 小程序两端的插件目录与图标副本。
- `le-time-management/scripts/test-web-collector.mjs`：默认条目计数断言 2 → 4（含 `ensureDefaults`
  的「已存在不重复补」「缺条要补上」两个用例各加一条 cppu 断言），manifest 版本断言抬到 `1.10.0`。
- `docs/多源数据融合说明.md` 的「网页收集」一行由「内置 2 条」改为「内置 4 条」并列出新增站点。

## 影响哪端

- 桌面端 / Android 端：首次进入「网页收集」视图时补出两条新收藏；已存在的条目、备注、图标不动。
- 小程序端：该插件是 `platforms.miniprogram = "native"`（原生收藏管理），走同一份默认条目语义。
- 不涉及业务表、不涉及同步协议。

## 数据迁移

无。只有 `ensureDefaults()` 的一次性补条，没有字段改写，也没有新的 storage 键。

## 版本

- 应用：`0.250.1` → **`0.251.0`**（`package.json` / `package-lock.json` 两处 / `Cargo.toml` / `Cargo.lock` /
  `tauri.conf.json` / `appMeta.js` / `tauri.properties` / `strings.xml` / `README.md` 已同步）
- 插件 `web-collector`：`1.9.0` → `1.10.0`

## 验证

```
node ../tools/sync-version.js --check         ✓ 三端版本一致：v0.251.0
node ../tools/gen-theme-dark.js --check       ✓ 15 套深色变体
node ../tools/build-schedule-plugin.js --check ✓
node ../tools/sync-android-native.js --check  ✓ Android 原生代码与版本化镜像一致
node tools/sync-plugins.js                     ✓ 17 个内置插件两端同源
npm test                                       ✓ 全部测试脚本通过
```
