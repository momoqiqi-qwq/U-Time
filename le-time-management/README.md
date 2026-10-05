# U-Time

> v0.11.4：插件启停改为滑块；主 UI 采用 Icons8 / iGoutu iOS Filled 图标；警大通知正文展开/收起加入平滑动画。

把概念稿 **03「权衡」四象限决策台** 与 **04「潮汐」时间块规划轴** 合成的本地优先时间管理平台。

- **四象限**：重要/紧急四象限管理任务，点卡片开详情抽屉，可一键「排入今天时间块」
- **时间块**：左侧任务池拖进一天的时间轴（鼠标/触摸通用，安卓可拖），「现在」红线、7 天节奏、明日预告
- **捕获**：把聊天文字、网页文本、链接、图片**拖进窗口**（或截图后 Ctrl+V），自动解析中文时间（"明天下午3点到4点"、"9月10日 14:00"、"下周一晚上8点半"）并在对应时间创建时间块
- **插件系统**：内置「课程表」「网页收集」「学校通知网站」「番茄专注」「学习通」「中国节假日」等 12 个插件；支持把插件放进数据目录 `plugins/` 动态加载
- **本地优先**：数据就是一个 JSON 文件，存在本机应用数据目录，无账号、无联网
- **Tauri 2**：一套代码打包 Windows / Linux / Android

## v0.4.0 新增

- **网页收集**：自动识别站点标题、favicon 与 Font Awesome 图标名，支持本地收藏、搜索和备注。
- **学校通知网站**：通用高校公告列表解析；会话化登录支持用户名、密码、隐藏字段和手动验证码。对动态 JS 加密/扫码/短信认证站点会提示需要专用适配器。
- **9 套主题**：新增深海蓝、樱花粉、松林绿、暮光紫、极简灰，并让课程表跟随全局主题变量。
- **性能**：插件代码并行预加载；HTTP 提供内存 TTL 缓存；中国节假日离线优先；课程表减少重复日期/节次/冲突扫描。
- **全局搜索 / 命令面板**：Ctrl/Cmd+K 搜任务、时间块、插件和常用命令；桌面安装版另有可配置系统级快捷键。
- **可选同步**：WebDAV JSON 快照采用显式上传/下载，本地优先不变；密码不持久化。

## 目录结构

```
Le-time-management/
├─ index.html / vite.config.js / package.json   # 前端（Vite + 原生 JS）
├─ src/
│  ├─ main.js            # 启动入口
│  ├─ shell.js           # 侧栏 + 顶栏 + 视图路由
│  ├─ store.js           # 状态与持久化（防抖写盘）
│  ├─ api.js             # Tauri 命令封装（浏览器模式降级 localStorage）
│  ├─ ui.js              # toast / 弹出菜单 / 指针拖拽
│  ├─ pluginHost.js      # 插件宿主
│  └─ views/
│     ├─ quadrant.js     # 四象限视图
│     ├─ drawer.js       # 任务详情抽屉
│     ├─ timeblock.js    # 时间块视图
│     └─ settings.js     # 设置（数据 / 插件管理 / 关于）
├─ public/plugins/       # 13 个内置插件（课程表、网页收集、学校通知网站、番茄专注、学习通、轮换值日、中国节假日等）
├─ miniprogram/          # 微信小程序（连接 Win 控制端局域网服务）
└─ src-tauri/            # Rust 侧：数据读写(原子写)、插件目录扫描、应用信息
```

## 开发与构建

前置：Node ≥ 18、Rust ≥ 1.77（Windows 需 VS C++ 构建工具与 WebView2，Linux 需 webkit2gtk-4.1）。

```bash
npm install

# 桌面开发模式（热重载）
npm run tauri dev

# 桌面打包
npm run tauri build          # Windows 出 nsis/msi；Linux 出 deb/appimage
```

### Linux 依赖

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

### Android

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
# 安装 Android Studio（含 SDK + NDK），并设置 ANDROID_HOME / NDK_HOME
npm run tauri android init   # 生成 gen/android 工程（图标已由 tauri icon 生成到对应 mipmap）
npm run tauri android dev    # 真机/模拟器调试
npm run tauri android build -- --apk --target aarch64  # 产出 APK
```

本机构建环境备忘（2026-09 搭建，产物 APK 约 9.5MB）：

- SDK/NDK：`D:\Environment\android-sdk`（platform 34/35/36、build-tools 34/35、NDK r27、cmdline-tools）；JDK 21（Adoptium）
- 环境变量：`JAVA_HOME` / `ANDROID_HOME` / `NDK_HOME` 指向上述路径
- gen/android 是 gitignore 的生成目录，重新 init 后需要补几处：
  - **原生 Kotlin + 清单声明**：跑 `node ../tools/sync-android-native.js` 一次即可（事实源是版本化的 `android/README.md` 里说明的镜像目录；它同时会幂等补上 `REQUEST_INSTALL_PACKAGES`、去掉 MainActivity 的 label、补 `file_paths.xml` 的 cache-path）。`scripts/build-android-apk.sh` 也会自动跑，正常不用手工记。
  - `gradle.properties` 加 `android.overridePathCheck=true`（项目路径含中文）
  - release 签名：`gen/android/keystore.properties`（storeFile 指向 `tidebalance/keystore/tidebalance-release.keystore`，alias `tidebalance`，密码见本地 keystore.properties）+ `app/build.gradle.kts` 里读取该文件的 `signingConfigs`（已就位，init 覆盖后需按本文件重加）
  - Gradle 发行版走腾讯镜像：`gradle/wrapper/gradle-wrapper.properties` 的 `distributionUrl`
- 国内网络下 `rustup target add` 若龟速：直连 USTC 镜像（`RUSTUP_DIST_SERVER=https://mirrors.ustc.edu.cn/rust-static`），或用 curl 把 `rust-std-*.tar.xz` 按 manifest 的 xz_hash 放进 `~/.rustup/downloads/<hash>` 再跑 rustup

界面已做移动端适配：窄屏下侧栏变为底部导航，四象限/时间块单列排布，拖拽用指针事件实现（触摸可用）。

## 捕获：从微信 / 网页把事件拖进来

三种入口（拖放已在窗口配置中启用原生 HTML5 拖放 `dragDropEnabled: false`）：

1. **拖文本/链接**：在浏览器、支持拖拽的应用里选中文字或地址栏图标，直接拖到U-Time窗口任意位置
2. **拖图片/文件**：把聊天里的图片、Explorer 里的截图文件拖进来（微信聊天窗口的图片可直接拖出）
3. **粘贴兜底**：微信不支持拖文字，就在聊天里选中 → 复制（截图用 Alt+A 会自动进剪贴板）→ 切到U-Time按 `Ctrl+V`

行为规则：

- 文本命中日期+时间 → **自动创建任务 + 对应时间的时间块**（识别区间可给时长，如"2点到4点"→2小时），toast 可「查看/调整」
- 只命中日期 → 时间块先放当天 09:00，toast 一键调整
- 没有日期 → 存入任务池（默认象限按期限远近猜 I / II，分类按关键词猜：会议→工作、考试→学习、健身→运动、聚餐→生活）
- 图片/截图 → 弹出确认卡：预览 + 标题 + 日期/时间/时长/分类，确认后图片作为附件存在任务上（四象限卡片显示 📷，抽屉里看大图）

解析器在 `src/timeParser.js`，纯规则实现（相对日、星期、X月X日、X号、月底、时段词、X点半、HH:MM、区间连接词），不联网、零依赖。图片内的文字识别（OCR）暂未内置——如需"截图里自动认时间"，后续可接 tesseract（离线）或系统 OCR。

## 局域网联动（手机 / 小程序 / 微信推送）

Win 作为控制端，内置局域网服务（设置 → 局域网联动 → 启动）：

- **手机浏览器**：手机连同一 Wi-Fi，扫二维码或打开链接（`http://电脑IP:27123/m?token=配对令牌`）→ 移动端页面：今日时间块、任务勾选、快速添加，改动实时回写U-Time
- **微信小程序**：源码在 `miniprogram/`，用微信开发者工具导入，本地设置勾选「不校验合法域名」，在 `config.js` 填联动地址与令牌。正式发布需要注册小程序并配置 HTTPS 域名（个人局域网用法用开发/预览模式即可）
- **微信提醒推送**：内置插件「微信推送」（Server酱通道）——时间块开始前 N 分钟推送到微信，SendKey 在 sct.ftqq.com 扫码获取

所有请求都需要配对令牌（自动生成，随二维码分发）；服务只监听局域网。

## 插件开发指南

每个插件是一个文件夹：

```
plugins/
└─ my-plugin/
   ├─ manifest.json
   └─ main.js
```

`manifest.json`：

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "0.1.0",
  "author": "you",
  "icon": "✨",
  "description": "它做什么",
  "permissions": ["ui", "tasks", "blocks", "storage", "notify", "events", "http", "openUrl", "timeParse"],
  "entry": "main.js"
}
```

把文件夹放进 **设置 → 数据** 里显示的目录下的 `plugins/` 子目录（Android 上暂不支持外部目录扫描，可用内置插件方式），回到设置点「重新扫描」即可。

> v0.10.0 起，manifest 的 `permissions` 不再只是说明：宿主会在 `tide` API 调用时检查运行时权限开关。用户可在设置中逐项关闭任务、时间块、网络、外链等已声明权限。该机制是 API 能力控制，不等同于独立进程级安全沙箱。

`main.js` 在严格模式的函数沙箱中执行，唯一入口是注入的 `tide` 对象：

```js
// 视图：往侧边栏加一页
tide.ui.registerView({
  id: "my-view", title: "我的页", icon: "✨",
  render(el) { el.textContent = "你好"; },
});

// 任务动作：出现在任务详情抽屉
tide.ui.registerTaskAction({
  id: "drink", label: "标记为小目标", icon: "☕",
  run(task) { tide.tasks.update(task.id, { tags: [...(task.tags||[]), "小目标"] }); },
});

// 数据（均为异步/同步安全拷贝）
tide.tasks.list(); tide.tasks.create({ title: "新任务", quad: 2 });
tide.blocks.list("2026-09-05"); tide.blocks.create({ start: "10:00", durMin: 45, title: "读书" });
// v0.10.0：冲突预览 / 自动挪到附近空闲时段
tide.blocks.preview({ date: "2026-09-05", start: "10:00", durMin: 45, title: "读书" });
tide.blocks.createSmart({ date: "2026-09-05", start: "10:00", durMin: 45, title: "读书" });

// 插件私有存储（随主数据一起持久化）
await tide.storage.set("count", 1); await tide.storage.get("count", 0);

// 插件随包资源（内置插件读取 public/plugins/<id>/，用户插件读取自身目录）
const cfg = await tide.assets.json("data/config.json");
const text = await tide.assets.text("README.txt");

// 通知与事件
tide.notify("完成了一件事");
tide.events.on("pomodoro:finished", (e) => {});
tide.events.emit("my-plugin:something", {});

// 网络：Rust 端抓取，绕开 WebView CORS（仅 http/https）
const res = await tide.http.get("https://api.example.com/list?page=1");
// res = { status, body, finalUrl, contentType }

// 会话化请求：Cookie Jar 保持登录态（适合需要登录的接口，如学习通）
const sid = await tide.http.session();
await tide.http.fetch(sid, "POST", "https://example.com/login", {
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: "uname=a&password=b",
});
const r2 = await tide.http.fetch(sid, "GET", "https://example.com/feed");
// r2 = { status, body, finalUrl, contentType, cookies }
// 图片等二进制：tide.http.fetch(sid, "GET", url, { binary: true }) → body 为 base64

// 打开系统浏览器
tide.util.openUrl("https://example.com");

// 复用主程序的中文时间解析（捕获引擎同款）
const p = tide.util.parseWhen("明天下午3点到4点 讨论开题"); // { date, startMin, endMin, title }
tide.util.guessCategory(text); // 按关键词猜分类 work/study/sport/life/rest
tide.util.guessQuad(dateStr);  // 按期限猜象限
tide.util.navigate("timeblock"); // 跳转到指定视图

// DES-ECB/PKCS5 加密（RustCrypto 实现，超星等平台登录加密用）
const hexPwd = await tide.util.desEncryptHex("password", "u2oh6Vu^");

// 工具
tide.util.today(); tide.util.addDays("2026-09-05", 1);
tide.util.mmOf("09:30"); tide.util.hhmmOf(570); tide.util.durLabel(90);
```

- 内置插件 `public/plugins/cn-holiday/`（中国节假日）：由 cn-holiday Skill 移植，内置 2024–2026 数据快照，支持下个假期倒计时、下次休息日、指定日期放假/调休判断、全年安排；缺失年份通过 `tide.http` 联网读取并缓存。
- 内置插件 `public/plugins/gx-news/`（竞赛消息雷达）：`tide.http.get` 抓取摩课云竞赛平台公告、关键词/类型/月份/已读过滤、`openUrl` 打开详情、`parseWhen` 一键转提醒。
- 内置插件 `public/plugins/chaoxing-notify/`（学习通通知）：需要登录态的场景——`http.session/fetch` 保持 Cookie、`desEncryptHex` 在本机完成超星 DES 登录加密（改造自 chaoxing-notify-skill）。注意：学习通「消息中心」接口有平台 IP 白名单，被拒时插件会明确提示；课程列表与通知分享码查询不受影响。
- 内置插件 `public/plugins/cppu-notify/`（警大门户通知）：改造自 cppu-notify-skill，完整复刻三段式 SSO 链路（主 SSO 验证码手输 → sso-jw bridge → 门户 tp_up）+ Sudy CAS RSA 加密（BigInt 移植，与原实现逐字节一致）。相比原 skill 移除了 74MB 的 tesseract OCR 运行时——验证码改为界面内手输，CASTGC 有效时可在当前应用运行会话内尝试静默续期免验证码。HTTP Cookie 会话目前只保存在内存，因此退出并重启应用后不能承诺自动登录；密码仍不落盘，验证码仍需手输。
- 内置插件 `public/plugins/wechat-push/`（微信推送）：时间块开始前 N 分钟经 Server酱 推送到微信，带测试按钮与推送日志。
- 内置插件 `public/plugins/dorm-duty/`（轮换值日）：把「按成员顺序轮换」的公共事务集中管理 —— **一个插件里可以放多套互相独立的轮换**（宿舍值日 / 公区卫生 / 打水…），各有自己的成员、周期、起始日与提醒时刻，互不影响。每套用「起始日 + 周期」切段、一段一人，所以「每周轮换」时整周都是同一个人、提醒也只在每轮第一天触发一次（不会天天催）；支持每天 / 每 3 天 / 每周 / 每两周与自定义 N 天，成员可增删改名与调序、误删可恢复，某一轮可临时换人（只影响那一轮）。提醒时刻与提示音走应用设置里的同一套音效目录。**三端都已适配**：小程序端是原生页面（逻辑在 `miniprogram/core/pluginRuntime.js`），存储键与桌面端逐字一致，备份可跨端恢复；小程序不能常驻后台，到点提醒只在打开插件页时补一次。

## 设计来源

- 03 [权衡 · 四象限决策台](../ui-概念稿/03-权衡-四象限决策.html)
- 04 [潮汐 · 时间块规划轴](../ui-概念稿/04-潮汐-时间块规划.html)


## 插件管理增强

- 已内置 `exam-calendar`（考试日历）插件。
- 设置 → 插件支持 ZIP 导入、所选插件 ZIP 导出、保存插件配置、全选、**批量开启 / 关闭所选**和多选删除。
- **勾选框覆盖全部插件**（内置 + 用户）：内置插件也能勾选用于批量启停；「不能删」只限制删除与导出 ——
  批量删除与导出始终只作用于用户插件目录，选中内置插件时按钮会说明会被跳过。
- 设置 → 插件标题旁提供 GitHub 图标「插件开发文档」，点击打开 https://github.com/momoqiqi-qwq/U-Time 。
