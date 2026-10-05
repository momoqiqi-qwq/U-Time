# U-Time

> 🤖 **AI / 协作者必读：[`AGENTS.md`](./AGENTS.md)** —— 项目铁律，含「每次更新必须升版本号」的完整操作步骤、不可回退的标识符清单、构建与合并禁忌。动手前先读。（中文别名 `AI必读.md` 指向同一份）

### ✨ 项目简介

**U-Time**是一款本地优先的时间管理桌面/移动应用，把 **03「权衡」四象限决策台** 与 **04「潮汐」时间块规划轴** 两个设计方向融合成一个产品：先用四象限决定"该做什么"，再把任务拖进一天的时间格子里。基于 **Tauri 2 + 原生 JS** 构建，一套代码可打包 Windows / Linux / Android；数据只存在本机单个 JSON 文件里，无账号、无联网。它还能"听懂"中文时间——把微信聊天、网页文字直接拖进来，自动提取日期并在对应时间创建事件。

### 🎨 主要特点

- 🀫 **四象限决策**：重要/紧急四象限管理任务，象限面积按权重变形，详情抽屉一键改象限/耗时/截止
- 🌊 **时间块规划**：任务池拖进 24 小时时间轴（鼠标/触摸通用），15 分钟吸附、"现在"红线、7 天节奏、明日预告
- 📥 **中文时间捕获**：拖入/粘贴聊天文字、网页链接、截图 → 自动解析"明天下午3点到4点"这类表达 → 在对应时间创建事件
- 🧩 **插件系统**：内置「番茄专注」「周度报告」「竞赛消息雷达」「学习通通知」「警大门户通知」，第三方插件放进 `plugins/` 目录即可被发现，提供视图注册 / 任务动作 / 存储 / 事件 / HTTP 会话 / DES+RSA 加密 / 中文时间解析 API
- 🔒 **本地优先**：单 JSON 存储、原子写入、备份导出/导入，不上传任何数据
- 📱 **多平台**：Windows 安装器已验证，Linux（deb/AppImage）与 Android（APK）一套代码构建；另有**微信小程序版**（`miniprogram/`，原生 WXML 开发，与桌面端同一数据格式、同一时间解析引擎）

### 📦 包含模块

1. **四象限视图**（`src/views/quadrant.js`）—— 象限网格、任务卡片、详情抽屉
2. **时间块视图**（`src/views/timeblock.js`）—— 任务池、时间轴画布、拖拽调度、统计侧栏
3. **捕获引擎**（`src/capture.js` + `src/timeParser.js`）—— 全局拖放/粘贴入口、零依赖中文时间解析器
4. **插件宿主**（`src/pluginHost.js`）—— 沙箱加载、受控 API、内置插件（`public/plugins/`）
5. **Rust 后端**（`src-tauri/`）—— 数据原子读写、插件目录扫描、应用信息
6. **设置中心**（`src/views/settings.js`）—— 数据管理、插件启停、重新扫描

> 🌟 想先看它能做什么？→ [`docs/features.html`](./docs/features.html)（功能介绍页：单文件、离线可开，功能点逐条对齐源码）
> 🧱 想看每一层的具体技术选型（依赖、模块映射、版本快照）？→ [`docs/tech-stack.html`](./docs/tech-stack.html)
> 📐 想看懂设计取向与各模块方案？→ [`docs/设计原则与整体架构说明.md`](./docs/设计原则与整体架构说明.md)（含任务表 / 时间线 / 收件箱 / 插件系统 / 智能预警五章）
> 🔍 想按层读代码、看功能如何穿过这些层？→ [`docs/架构层次图.md`](./docs/架构层次图.md)（配 `docs/architecture/*.svg` 十张生成图）
> 🧩 想看解决了哪些技术难题、怎么解的？→ [`docs/工程实现与技术难题求解.md`](./docs/工程实现与技术难题求解.md)（40 条难题，每条配真实代码与回归断言定位）

### 🛠️ 如何使用

1. **直接运行**：下载 Release 中的 `U-Time_x64-setup.exe` 安装，或用仓库内构建产物 `letime.exe`
2. **从源码构建**：

   ```bash
   cd le-time-management
   npm install
   npm run tauri dev      # 开发模式
   npm run tauri build    # 打包 Windows NSIS/MSI、Linux deb/AppImage
   npm run tauri android build   # Android APK（需 SDK/NDK，步骤见 README）
   ```

3. **捕获事件**：复制一条带时间的消息（如"周五下午4点半 项目周会"），到U-Time按 `Ctrl+V`，事件自动落在对应时间
4. **写一个插件**：建一个含 `manifest.json` + `main.js` 的文件夹放进数据目录 `plugins/`，回到设置点「重新扫描」

### ❓ 效果演示

> 以下均为当前版本真实运行的界面截图（浅色主题），非设计稿。

**桌面端 · Windows（1440×900）**

<p align="center">
  <img src="docs/screenshots/desktop-quadrant.jpg" width="48%" alt="任务表 · 四象限决策台">
  <img src="docs/screenshots/desktop-timeline.jpg" width="48%" alt="时间线 · 按日期串联的安排">
</p>

<p align="center">
  <img src="docs/screenshots/desktop-market.jpg" width="70%" alt="插件市场 · 内置插件一键启停">
</p>

**移动端 · Android（390×844）**

<p align="center">
  <img src="docs/screenshots/phone-quadrant.jpg" width="24%" alt="手机端 · 任务表">
  <img src="docs/screenshots/phone-schedule.jpg" width="24%" alt="手机端 · 课程表插件">
  <img src="docs/screenshots/phone-exam.jpg" width="24%" alt="手机端 · 考试日历插件">
</p>

粘贴「明天下午3点到4点 与导师讨论开题修改」后，任务自动进入象限 I，并在明天 15:00–16:00 生成对应的时间块。

### 📲 微信小程序版

[`miniprogram/`](./miniprogram) 是与桌面端同源的**原生微信小程序**实现（不依赖 Tauri，无需 npm 构建）：

1. **打开**：微信开发者工具 → 导入项目 → 选择 `miniprogram/` 目录即可（`project.config.json` 默认用测试号 `touristappid`，可换成自己的 appid）
2. **功能对照**：

| 桌面端 | 小程序版 |
|---|---|
| 四象限 + 详情抽屉 | 2×2 象限块 + 任务列表 + 独立详情页；任务卡**左滑**完成/删除、**跨象限搜索**、隐藏已完成 |
| 任务池拖拽进时间轴 | 点任务卡自动排到第一个空闲位；长按任务卡进入放置模式后点时间轴任意位置放置；时间块 movable 手势拖动（15 分钟吸附） |
| 拖/粘贴文本捕获 | 「捕获」页：读取剪贴板 / 手动输入 → 实时解析预览（日期/时间/时长/分类可点改）→ 一键创建任务+时间块 |
| 设置：备份/插件 | 设置：数据统计 + 存储占用警告 + 备份导出/导入（JSON 格式与桌面端互通，可互相恢复） |

小程序版另有桌面端没有的能力：**暗色模式**（跟随系统）、**近 7 天日期条**快切、长按放置震动反馈、任务图片附件点开大图、保存失败兜底提示、页面分享（朋友+朋友圈）。

3. **桌面端专属**（小程序不提供）：插件系统、窗口拖拽/截图捕获、图片附件捕获
4. **兼容性**：`timeParser` 移植时移除了正则 lookbehind（iOS 16.4 以下的 JavaScriptCore 不支持，会导致模块解析崩溃），行为与桌面端一致
5. **工具链**（零依赖，Node 直接跑）：`node tools/test-miniprogram-core.js` 跑核心逻辑测试（39 个用例）；`node tools/check-miniprogram.js` 做静态校验；`node tools/gen-miniprogram-tab-icons.js` 重新生成 tabBar 图标

详见 [`miniprogram/README.md`](./miniprogram/README.md)。

### 🙏 贡献

欢迎 Issue 与 PR：时间解析规则扩充（`src/timeParser.js`）、新内置插件、Linux/Android 适配反馈都特别有价值。插件开发 API 文档见 [`le-time-management/README.md`](./le-time-management/README.md)，界面与插件**图标规范**（Icons8/iGoutu 图标集、81×81 随包 PNG 生成、授权署名、自检清单）见 [`le-time-management/docs/plugin-icons.md`](./le-time-management/docs/plugin-icons.md)。

> 本 README 按照 [App-Showcase-Template](https://github.com/yxs2003/App-Showcase-Template) 的展示流程编写。
