# U-Time · 开源项目与第三方来源说明

> 本文件用于产品内“关于”页面的可读说明，不替代各依赖自身的 LICENSE / NOTICE，也不是完整的传递依赖 SBOM。发布二进制时，应继续保留项目中随附的许可证与归属文件。

## 核心框架与直接依赖

| 项目 | 用途 | 许可/说明 | 上游 |
| --- | --- | --- | --- |
| Tauri 2 | Windows / Android 应用壳、原生命令和打包 | MIT / Apache-2.0 | https://github.com/tauri-apps/tauri |
| Tauri Global Shortcut | 桌面端系统级全局快捷键插件 | MIT / Apache-2.0 | https://github.com/tauri-apps/plugins-workspace |
| Vite 6 | 前端开发与生产构建 | MIT | https://github.com/vitejs/vite |
| reqwest | Rust HTTP 客户端 | MIT / Apache-2.0 | https://github.com/seanmonstar/reqwest |
| serde / serde_json | Rust 数据序列化与 JSON | MIT / Apache-2.0 | https://github.com/serde-rs/serde |
| RustCrypto DES / block-modes 相关 crate | 警大门户兼容加密流程 | 以各 crate 上游许可证为准 | https://github.com/RustCrypto |
| tiny_http | 局域网联动 HTTP 服务 | 以其上游许可证为准 | https://github.com/tiny-http/tiny-http |
| qrcode | 局域网配对二维码 | 以其上游许可证为准 | https://github.com/kennytm/qrcode-rust |
| jsQR | 手机端「扫一扫」配对二维码的解码器（仅在打开扫码时按需加载） | Apache-2.0 | https://github.com/cozmo/jsQR |
| zip | 用户插件 ZIP 导入/导出 | 以其上游许可证为准 | https://github.com/zip-rs/zip2 |

## 图标

本项目的图标来自 **Icons8 / iGoutu**（igoutu.cn 是 Icons8 的中文镜像，slug 与风格完全一致），分两条线路：

| 用途 | 风格 | 加载方式 |
|---|---|---|
| 主导航（四象限 / 时间块 / 收件箱 / 插件 / 设置 / 快速捕获） | Color 彩色（来源图标集「标志 · 色版」） | 随包 PNG，`public/icons/nav/<key>.png`，由 `tools/gen-plugin-icons.py` 生成；加载失败回落同风格 CDN 直链 |
| 12 个内置插件 | Color 彩色（来源图标集「标志 · 色版」，`wechat-push` 用 3D 风格微信标志） | 随包 PNG，`public/icons/plugins/<插件ID>.png`，由 `tools/gen-plugin-icons.py` 生成 |

内置插件与主导航图标的来源台账（风格 / slug / sha256 / 消费方）分别见
`public/icons/plugins/ATTRIBUTION.md` 与 `public/icons/nav/ATTRIBUTION.md`。

Icons8 的免费使用条款要求在产品中提供署名链接，因此“关于”页保留 **图标集入口 `https://igoutu.cn/icons/set/标志--style-color`** 与 Icons8 的来源入口；正式发布前请按你的 Icons8 账户/授权方案再次核对是否需要保留署名。

微信小程序的 tabBar 图标与「网页收集」插件的图标兜底仍使用 **Font Awesome Free 6.7.2** 既有资源，项目随包继续保留：

- `public/icons/fontawesome/ATTRIBUTION.md`
- `public/icons/fontawesome/LICENSE.txt`

Font Awesome 图标按 CC BY 4.0 许可使用，完整说明以上述随包文件和 Font Awesome 官方许可证为准。

## 字体

左上角品牌字标（`U-Time` 那一行）使用 **UnifrakturCook**（Bold 700，latin 子集）随包分发：

- `public/fonts/UnifrakturCook-Bold.woff2`（17 KB）
- `public/fonts/OFL.txt`（上游原始许可文本）

版权归 **j. 'mach' wust（2010）与 Peter Wiegel（2009）** 所有，保留字体名 UnifrakturCook，
按 **SIL Open Font License 1.1** 授权：允许随本软件一起分发，不得单独出售字体本身，修改后须改名。
本项目对该字体未做任何修改。它只用于品牌字标（`src/styles.css` 的 `@font-face` 与 `.brand b`），
其余界面文字仍走系统字体栈。

## 内置插件中的上游来源

### 课程表 / ShiguangSchedule

课程表插件的数据模型移植自 `XingHeYuZhuan/shiguangschedule`，本项目保留 Apache-2.0 许可证和修改说明：

- `public/plugins/shiguang-schedule/LICENSE`
- `public/plugins/shiguang-schedule/NOTICE.md`

本项目没有直接嵌入原项目的 Compose UI、学校适配脚本或其完整第三方依赖。

### 中国节假日

`cn-holiday` 的节假日离线数据来源于 `NateScarlet/holiday-cn`。数据版本与来源说明写在插件 manifest / 数据更新流程中；许可条件以该上游仓库当前声明为准。

### 学习通与警大门户适配

`chaoxing-notify` 与 `cppu-notify` 的 manifest 中记录了对应上游适配来源。二次分发或继续复用上游实现时，请同时核对其仓库当前许可证、NOTICE 和接口使用条款。

## 发布建议

1. 正式发布前，使用依赖审计工具生成一份 Rust / npm 的完整许可证清单或 SBOM。
2. 不要删除随包的 `LICENSE`、`NOTICE`、`ATTRIBUTION` 文件。
3. 新增插件若移植第三方源码，应在插件目录单独放置 LICENSE / NOTICE，并在 manifest 的 `author` 或扩展字段记录来源。
4. 开源项目名称、商标和服务名称归各自权利人所有。
