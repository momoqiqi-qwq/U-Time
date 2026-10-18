# v0.250.0 — 内置图标统一为扁平双色风格（自有母版）

影响端：桌面端（Windows）、Android、微信小程序（插件图标三端同源）。无数据迁移；用户自定义过的插件图标不受影响（覆盖层优先）。

## 变更
- **32 张内置图标统一换成同一套扁平风格**：柔和两档明暗 + 奶油色内高光 + 圆润几何、无描边（即 v0.249.0 讨论时选定的番茄样式）。
  - 17 个内置插件、9 个警大门户分类视图（一卡通 / 获奖 / 选课 / 请假 / 成绩 / 创新学分 / 校历 / 成长 / 个人信息）、6 个主导航（四象限 / 时间线 / 时间块 / 收件箱 / 插件中心 / 设置；快速捕获与收件箱同形）。
  - 品牌类插件不再用品牌标志：微信推送 = 绿色气泡 + 小铃铛，GitHub 文档 = 带 `</>` 的文档页。
  - `mojinghub`（未内置的历史插件）暂无母版，继续用 Icons8 的奖牌。
- **新的事实源 `tools/icon-masters/`**：每张图标一份 256px 透明底母版（`<插件ID|视图ID>.png`、`nav/<key>.png`），由 AI 按同一张风格参考图生成后抠图入库。
- **`tools/gen-plugin-icons.py`**：有母版就用母版（台账里风格记为 `master`），没有才回落 Icons8；输出尺寸与规则不变（81×81、图形最长边 58px、桌面与小程序字节一致）。仍然**不要手工替换输出 PNG**，改母版再重跑脚本。
- **署名口径**：两份 ATTRIBUTION.md 由脚本重写 —— 母版是本项目自有素材，无需第三方署名；Icons8 署名保留给剩余的 Icons8 图标与 `src/icons.js` 加载失败时回落的 CDN 直链。`aboutData.js` 与 `OPEN_SOURCE_NOTICES.md` 同步改了说明文字。
- `src/icons.js` 的 `data-icon-source` 从 `bundled … PNG (Icons8 Color)` 改为 `bundled … PNG (flat masters)`（CDN 回落仍标 `Icons8 Color`）。

## 验证
- `py -3 tools/gen-plugin-icons.py --offline --check`：34 项全部 OK。
- 新测试 `scripts/test-icon-masters.mjs`：内置插件 / 分类视图 / 导航都有母版、台账风格列为 `master`、分类图标互不重复。
