# v0.248.0 — 数据瘦身（插件缓存独立落盘 / 图标缩小 / 撤销快照体积上限）+ 插件界面统一

**影响端**：Windows / Android（桌面与安卓共用 `src/`、`public/plugins/`、`src-tauri`）。微信小程序未改动。

## 背景

实测用户 data.json 9.83 MB，真实任务数据不到 50 KB。大头是：自动化撤销快照 4.1 MB、自定义图标 1.34 MB（单张）、
超星收件箱缓存 896 KB、警大通知 / 一卡通 / 获奖缓存约 0.7 MB、学校通知缓存。主状态每次保存都要整份
structuredClone → IPC → Rust 解析 → 重写磁盘，任何一次小改动都在搬这几 MB。

## 数据层

- **新增 `tide.cache`**（`src/pluginCache.js` + `src-tauri/src/plugin_cache.rs`）：可重抓的大块插件数据落到
  `<数据目录>/plugin-cache/<插件ID>/<键>.json`，不进 data.json。
  - 文件名编码只保留 `[a-z0-9_-]`，其余字节写成 `~XX`（大小写也编码，避免 Windows 大小写不敏感撞名；`..`、`/`、`:` 进不了路径）。
  - 先写临时文件再 rename；坏文件当未命中；值为 null 即删除；卸载插件时整目录删除。
  - 同一键的写入在前端串行；内存留最新值。读写失败或非 Tauri 环境自动退回 `tide.storage`，数据不丢。
  - 权限与 `tide.storage` 相同（`storage`）。
- **迁移（自动、无感）**：插件第一次 `tide.cache.get(键)` 时，若缓存文件不存在而 storage 里有同名旧值，
  先写入缓存文件，成功后从 storage 删除并安排保存。已迁移的键：
  - cppu-notify：`noticeCache`、`cardRechargeCache`（CARD_CACHE_KEY）、`awardBoardCache`
  - school-notice：`notices:<站点>`
  - chaoxing-notify：`inboxCache`
  - 保留在 storage：cppu `jwCache`（混有偏好设置）、RSS 条目（含收藏 / 已读）、OCR 样本、网页收藏。
- **超星收件箱**：缓存上限 2000 → 500 条；每条 `raw` 只留 `rtf_content` / `content`（只有这两个字段被读取），旧缓存载入时顺手瘦身。
- **自定义图标**（`src/iconShrink.js`）：上传时按最长边缩到 144 px（PNG）；小于 48 KB 的原样保留，缩完更大或解码失败也保留原图。
  已落库的超大图标在启动 4 秒后补缩一次。
- **自动化撤销快照**（`src/automationLogs.js`，automation.js 与 aiAutomation.js 共用）：
  在「最近 5 条」之外再加单条体积上限 256 KB（带 base64 附件的快照实测单条 853 KB），超限的那条日志不可撤销。
  旧数据在首次访问日志时按条数 + 体积裁一遍。

## 插件界面

- 去掉字距小标题（「警 大 门 户 通 知 · 内 置 插 件」等）：cppu、gx-news、pomodoro、rss、weekly-report。
- 新增 `src/styles/plugin-polish.css`：`--plugin-content-max: 1040px` 统一插件正文宽度（RSS、周报已接入）；
  关闭「显示介绍」时插件中心卡片收成一行（图标 + 名称 / 开关 + ⋯）。
- 侧栏插件行不再显示「内置」标签，只给导入插件标「导入」。
- 开关「开」态统一为主题深色（cppu / gx-news / rss），与宿主设置页一致。
- 「展开正文」收成圆形箭头（cppu、学校通知在卡片右上角；RSS 原位，因右侧是动作列），文字保留给读屏。
- cppu：月份分组标题跟随主题色；桌面端收起校园服务后的把手改为左缘竖排标签。
- 周度报告 0.2.0 重写：按分类堆叠柱（悬停看明细）、与上一个 7 天的对比、带百分比的图例、空状态、主题变量配色。
- wechat-push：修复每次渲染都向 document 多挂一个点击监听、永不移除的泄漏。

## 插件版本

chaoxing-notify 2.20.0 · cppu-notify 1.64.0 · school-notice 1.9.0 · rss-reader 1.9.0 · gx-news 0.9.2 ·
pomodoro 0.8.1 · weekly-report 0.2.0 · wechat-push 1.12.1

## 测试

- 新增 `scripts/test-plugin-cache.mjs`：缓存迁移 / 串行写 / 读写竞态 / 失败回退 / 权限；图标缩放；快照体积上限；接线守卫。
- `plugin_cache.rs` 单元测试：文件名编码与路径穿越、读写删往返、坏文件当未命中。
