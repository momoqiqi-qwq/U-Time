# v0.92.1

## 警大校园服务栏教育邮箱自动登录

- 「警大门户通知」左侧校园服务栏里的「教育邮箱」不再只裸开 `mail.cppu.edu.cn`，点击后会复用本插件加密密钥库里保存的警大通知密码，并以 `2025000001@cppu.edu.cn` 向邮箱登录表单提交。
- 自动登录过程通过插件 HTTP 会话完成，成功后只把邮箱会话入口 URL 交给系统浏览器；不会把密码拼进 `openUrl`、data URL、本地文件、普通 storage 或同步备份。
- 若还没有在警大通知插件中开启并保存自动登录密码，或邮箱站点临时要求验证码，则退回普通打开并给出提示。

## 警大通知正文在深色模式下不可读

- 「警大门户通知」插件展开正文后，正文文字在深色模式下几乎看不见：插件侧把正文颜色写死成浅色的 `#4B565E`，而宿主的内置插件深色兼容层是 `!important` 白名单，`.pp-detail .c` 从来没进过名单，于是浅灰字直接压在深色 `--panel` 上。
- 在兼容层补上该选择器，正文取 `var(--ink)`（各套主题深色变体下的近白色）。用户诉求原话是「深色模式时正文弄成白色」。
- 刻意不用 `--ink-2`：夜间各主题的 `--ink-2` 偏灰，正文是卡片里唯一要读的内容，长段落会费眼。
- 浅色模式不受影响：新增规则整体挂在 `:root[data-theme-mode="dark"]` 下。

## 影响范围与限制

- 修改桌面端 `src/styles.css` 的插件深色兼容层，影响 Windows / Android / 浏览器预览三端的「警大门户通知」正文。
- 修改 `public/plugins/cppu-notify/main.js` 与插件清单，影响校园服务栏里的教育邮箱入口；插件版本升到 `1.12.0`。
- 同层里 `.pp-month`（`#0F4C5C`）、`.pp-banner`（浅黄底深字）等仍是浅色硬编码，本次未一并处理 —— 它们不在用户报的这条路径上。
- 无数据迁移。

## 验证

- `node ../tools/sync-version.js --check` → ✓ 三端版本一致：v0.92.1
- `node ../tools/gen-theme-dark.js --check`、`node ../tools/build-schedule-plugin.js --check`、`node ../tools/sync-android-native.js --check`
- `npm test` → PASS: 73 个测试脚本全部通过
- 真浏览器实测（探针页 `output/probe-cppu-body-color.html`，内联 `styles.css` + `theme-derived.css` + 从 `cppu-notify/main.js` 抽出的真实插件样式，跑 15 套主题 × 浅/深两态，量正文与卡片底的 WCAG 对比度）：
  - 深色改前 **1.85 ~ 2.12**（等于看不见，与用户截图一致）
  - 深色改后 **10.81 ~ 11.83**（过 WCAG AAA 的 7:1）
  - 浅色改前 = 改后 = **7.52**，无回归
  - 踩坑记录：`.pp-card` 带 `transition: background .28s`，切完 `data-theme-mode` 立刻读 `getComputedStyle` 拿到的是过渡起点（底色仍是改前的白），会把结论整个读反。探针必须再补一条 `transition:none !important` 才可信。
