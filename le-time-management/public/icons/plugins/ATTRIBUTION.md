# public/icons/plugins 素材台账（内置插件图标 + 插件内视图图标）

共 28 个图标：

- 0 个来自**本项目自有扁平母版**（`风格` 列为 `master`，`tools/icon-masters/`）：AI 按同一张风格参考图生成、抠成透明底后入库，是本产品自有素材，**无需第三方署名**；品牌类插件（微信推送、GitHub 文档）是按用途重新设计的图形，不含任何品牌标志。
- 28 个仍来自 **Icons8 / iGoutu**（`风格` 列为 `color` / `3d-fluency`）：暂无母版的插件，按 Icons8 License 署名。
- 0 个为印章式文字图标（`风格` 列为 `text`，由本脚本代码绘制，无需署名）。

其中 10 个是**插件内视图图标**（说明里带「插件内视图」）：同一个插件的不同分类在侧栏各用各的图标（v0.216.0），key = 视图 id，与插件图标同目录、同风格 —— `src/icons.js` 的 `VIEW_ICONS8` / `VIEW_FA_ICONS` 是它们的消费口径。

图标集入口：<https://igoutu.cn/icons/set/标志--style-color> ｜ CDN 直链格式：`https://img.icons8.com/<style>/96/<slug>.png`

生成方式：`tools/gen-plugin-icons.py`（Pillow，输出 81×81 透明 PNG，图形最长边 58px）。**不要手工替换这些 PNG** —— 改 `tools/icon-masters/` 的母版后重新生成。

| 插件 ID | 风格 | 来源（母版路径 / Icons8 slug） | 说明 | sha256 |
|---|---|---|---|---|
| `plugin-guide` | color | `help` | 插件使用说明 / 帮助 | `b45b6fcda0f60ca0…` |
| `pomodoro` | color | `tomato` | 番茄专注 / 番茄 | `c803c064b51d6b32…` |
| `cppu-notify` | color | `university` | 警大门户通知 / 大学建筑 | `9748e58bb1ab3556…` |
| `gx-news` | color | `trophy` | 竞赛消息雷达 / 奖杯 | `c95ce1bdbb0caa2a…` |
| `mojinghub` | color | `medal` | 模竞竞赛平台 / 奖牌 | `da2c74375b0c0222…` |
| `rss-reader` | color | `rss` | RSS 信息流 / RSS 信号波 | `d0cb8af12b2efed0…` |
| `exam-calendar` | color | `test-passed` | 考试日历 / 考核清单 | `5c6a420b295a8a06…` |
| `shiguang-schedule` | color | `timetable` | 课程表 / 日历+时钟 | `6c3547736cc6ff77…` |
| `web-collector` | color | `bookmark-ribbon` | 网页收集 / 书签 | `e5f48953ff3a87e3…` |
| `wechat-push` | 3d-fluency | `wechat` | 微信提醒推送 / 微信标志 | `c7f899200f70060f…` |
| `chaoxing-notify` | color | `books` | 学习通 / 一摞书 | `ff41e74a03cb03ea…` |
| `school-notice` | color | `school` | 学校通知网站 / 校舍 | `24fffc6a25afd359…` |
| `cn-holiday` | color | `lantern` | 中国节假日 / 中式灯笼 | `cddd17742bd90416…` |
| `weekly-report` | color | `statistics` | 周度报告 / 数据看板 | `d351ec1dbd72a67f…` |
| `dorm-duty` | color | `broom` | 轮换值日 / 扫帚 | `77c8854e41ff2dbe…` |
| `inbox-drop` | color | `downloading-updates` | 拖入消息收纳 / 箭头入托盘 | `b0a69a328dcf6b3e…` |
| `ai-chat` | color | `artificial-intelligence` | AI 对话 / 智能大脑 | `548f46d8d4c146e1…` |
| `github-readme` | 3d-fluency | `github` | GitHub 文档 / GitHub 猫标志 | `0d0027483c6df026…` |
| `cppu-card` | color | `bank-cards` | 警大门户通知 · 警大一卡通（插件内视图） | `31e3126b67984d72…` |
| `cppu-award` | color | `prize` | 警大门户通知 · 警大获奖名单（插件内视图） | `4f2405f79b613d34…` |
| `cppu-xk` | color | `todo-list` | 警大门户通知 · 学生选课（插件内视图） | `4a0680aaea98e3f9…` |
| `cppu-qj` | color | `calendar-delete` | 警大门户通知 · 学生请假（插件内视图） | `b8dd84c7d2f04f22…` |
| `cppu-credit` | color | `line-chart` | 警大门户通知 · 警大成绩（插件内视图） | `36a5207d12a69bd9…` |
| `cppu-cx` | color | `medal` | 警大门户通知 · 创新学分（插件内视图） | `da2c74375b0c0222…` |
| `cppu-calendar` | color | `calendar` | 警大门户通知 · 警大校历（插件内视图） | `3f9a3a3fb500fa6d…` |
| `cppu-growth` | color | `sprout` | 警大门户通知 · 学生成长（插件内视图） | `c255940f7520e582…` |
| `cppu-profile` | color | `contact-card` | 警大门户通知 · 个人信息（插件内视图） | `e2269e1ff917229d…` |
| `cppu-net` | color | `network` | 警大门户通知 · 上网记录（插件内视图） | `891ee1545dc76124…` |

## 许可

`master` 行：本项目自有素材，随本项目许可使用，无第三方署名要求。

其余 Icons8 行（以及 `src/icons.js` 随包 PNG 加载失败时回落的 CDN 直链）：Icons8 License（免费使用需在产品内署名）。署名入口见设置 → 关于（`src/aboutData.js`）与 `public/OPEN_SOURCE_NOTICES.md`。
素材仅作为本产品界面的组成部分使用，**不得作为独立图标库转售或再分发**。

## 消费方

| 端 | 路径 | 读取方式 |
|---|---|---|
| 桌面 / Android | `le-time-management/public/icons/plugins/*.png` | `src/icons.js` 的 `appIcon()` 按插件 ID 直读 |
| 微信小程序 | `miniprogram/images/plugins/*.png` | `pages/plugins/index.js`、`pages/plugin/index.js` 拼 `/images/plugins/${id}.png` |

两份文件字节一致，由本脚本一次写入。
