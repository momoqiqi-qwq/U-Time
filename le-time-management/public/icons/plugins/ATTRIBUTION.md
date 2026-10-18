# public/icons/plugins 素材台账（内置插件图标 + 插件内视图图标）

共 27 个图标：

- 26 个来自**本项目自有扁平母版**（`风格` 列为 `master`，`tools/icon-masters/`）：AI 按同一张风格参考图生成、抠成透明底后入库，是本产品自有素材，**无需第三方署名**；品牌类插件（微信推送、GitHub 文档）是按用途重新设计的图形，不含任何品牌标志。
- 1 个仍来自 **Icons8 / iGoutu**（`风格` 列为 `color` / `3d-fluency`）：暂无母版的插件，按 Icons8 License 署名。
- 0 个为印章式文字图标（`风格` 列为 `text`，由本脚本代码绘制，无需署名）。

其中 9 个是**插件内视图图标**（说明里带「插件内视图」）：同一个插件的不同分类在侧栏各用各的图标（v0.216.0），key = 视图 id，与插件图标同目录、同风格 —— `src/icons.js` 的 `VIEW_ICONS8` / `VIEW_FA_ICONS` 是它们的消费口径。

图标集入口：<https://igoutu.cn/icons/set/标志--style-color> ｜ CDN 直链格式：`https://img.icons8.com/<style>/96/<slug>.png`

生成方式：`tools/gen-plugin-icons.py`（Pillow，输出 81×81 透明 PNG，图形最长边 58px）。**不要手工替换这些 PNG** —— 改 `tools/icon-masters/` 的母版后重新生成。

| 插件 ID | 风格 | 来源（母版路径 / Icons8 slug） | 说明 | sha256 |
|---|---|---|---|---|
| `plugin-guide` | master | `icon-masters/plugin-guide.png` | 插件使用说明 / 帮助 | `de321dcfbf2bf9c4…` |
| `pomodoro` | master | `icon-masters/pomodoro.png` | 番茄专注 / 番茄 | `30b415fc5773c100…` |
| `cppu-notify` | master | `icon-masters/cppu-notify.png` | 警大门户通知 / 大学建筑 | `d7c3a045a647625b…` |
| `gx-news` | master | `icon-masters/gx-news.png` | 竞赛消息雷达 / 奖杯 | `ef9433615dd97893…` |
| `mojinghub` | color | `medal` | 模竞竞赛平台 / 奖牌 | `da2c74375b0c0222…` |
| `rss-reader` | master | `icon-masters/rss-reader.png` | RSS 信息流 / RSS 信号波 | `f726d961752b2047…` |
| `exam-calendar` | master | `icon-masters/exam-calendar.png` | 考试日历 / 考核清单 | `d730aad527a74012…` |
| `shiguang-schedule` | master | `icon-masters/shiguang-schedule.png` | 课程表 / 日历+时钟 | `6d447e55bf3e3fad…` |
| `web-collector` | master | `icon-masters/web-collector.png` | 网页收集 / 书签 | `1b3cb656550ce86d…` |
| `wechat-push` | master | `icon-masters/wechat-push.png` | 微信提醒推送 / 微信标志 | `e1b24dcaf19f6cfd…` |
| `chaoxing-notify` | master | `icon-masters/chaoxing-notify.png` | 学习通 / 一摞书 | `6bb934f720bf7f99…` |
| `school-notice` | master | `icon-masters/school-notice.png` | 学校通知网站 / 校舍 | `3ec09d0543fe5d1a…` |
| `cn-holiday` | master | `icon-masters/cn-holiday.png` | 中国节假日 / 中式灯笼 | `ca2e643b99502dd4…` |
| `weekly-report` | master | `icon-masters/weekly-report.png` | 周度报告 / 数据看板 | `75d49b5a4192836b…` |
| `dorm-duty` | master | `icon-masters/dorm-duty.png` | 轮换值日 / 扫帚 | `e7fa9748b6eb95ad…` |
| `inbox-drop` | master | `icon-masters/inbox-drop.png` | 拖入消息收纳 / 箭头入托盘 | `1de5a8efcacb18eb…` |
| `ai-chat` | master | `icon-masters/ai-chat.png` | AI 对话 / 智能大脑 | `cb2d251849100dc8…` |
| `github-readme` | master | `icon-masters/github-readme.png` | GitHub 文档 / GitHub 猫标志 | `5c79f992ecbe8893…` |
| `cppu-card` | master | `icon-masters/cppu-card.png` | 警大门户通知 · 警大一卡通（插件内视图） | `ba8c69bb1fb105f3…` |
| `cppu-award` | master | `icon-masters/cppu-award.png` | 警大门户通知 · 警大获奖名单（插件内视图） | `9cac3e35c192554c…` |
| `cppu-xk` | master | `icon-masters/cppu-xk.png` | 警大门户通知 · 学生选课（插件内视图） | `0b90652b152dd3e7…` |
| `cppu-qj` | master | `icon-masters/cppu-qj.png` | 警大门户通知 · 学生请假（插件内视图） | `bd8f1f5dd008d3ad…` |
| `cppu-credit` | master | `icon-masters/cppu-credit.png` | 警大门户通知 · 警大成绩（插件内视图） | `721b7a516784e227…` |
| `cppu-cx` | master | `icon-masters/cppu-cx.png` | 警大门户通知 · 创新学分（插件内视图） | `8da458f6a27f3c02…` |
| `cppu-calendar` | master | `icon-masters/cppu-calendar.png` | 警大门户通知 · 警大校历（插件内视图） | `39c624d1de6d72e1…` |
| `cppu-growth` | master | `icon-masters/cppu-growth.png` | 警大门户通知 · 学生成长（插件内视图） | `19bf0a24bc3a5af9…` |
| `cppu-profile` | master | `icon-masters/cppu-profile.png` | 警大门户通知 · 个人信息（插件内视图） | `6d964a35bfb59d73…` |

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
