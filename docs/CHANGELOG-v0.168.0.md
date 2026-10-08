# v0.168.0 · 自动获取 AI 模型列表

- Windows / Android 的「AI 与自动任务」支持从当前 Base URL 的 `/models` 获取模型 ID。新增 OpenRouter 预设，兼容 OpenAI、DeepSeek、百炼及提供该接口的中转服务。
- 打开设置、切换供应商、修改接口地址或 Key、保存配置后自动获取；输入防抖 650ms，设置停留时每 30 分钟检查一次，提供手动强制刷新。
- 模型 ID 可直接输入，也可展开列表按名称或 ID 搜索选择。支持方向键、Enter、Escape，展开和收起均有高度、透明度与箭头过渡，遵循减少动效偏好。
- 列表缓存 30 分钟，仅保存在原生进程内，按接口和 Key 摘要隔离；查询失败时显示同一配置的已有缓存及错误原因。清除凭据时清空缓存。
- 新模型仅加入候选列表，保留已选模型。新请求未返回前修改配置，旧响应不会覆盖新配置的候选列表。
- Key 留空只复用同一接口的已加密凭据；更换接口时需要填写 Key。模型查询在原生侧完成，禁用 HTTP 重定向，限制请求时间和响应大小。
- 现有 AI 调用仍采用 OpenAI 兼容的 Chat Completions 协议。供应商原生 Claude / Gemini 协议不在本次新增范围，模型功能及调用权限需通过连接测试确认。
- 小程序同步版本信息；浏览器开发预览显示原生查询不可用，不持久化明文 Key。本次无用户数据迁移。

## 验证（2026-10-08）

- `node ../tools/sync-version.js --check`、主题 / 课程表 / Android 原生一致性检查通过。
- `npm test`：116 个测试脚本全部通过。
- `cargo test --lib ai_models::tests --offline`：3 个测试通过，覆盖 URL 归一化、凭据边界、模型校验与排序、真实本地 HTTP 鉴权、缓存命中、强制刷新失败回退、不同 Key 缓存隔离及缓存到期刷新。
- `npx --no-install --package @playwright/cli playwright-cli -s=ai-models run-code --filename scripts/verify-ai-models-ui.js`：通过。使用模拟模型目录验证原有 ID 保留、搜索、手动输入、键盘选择与 Escape、展开 / 收起中间帧、快速反转、减少动效、旧响应抑制、失败缓存提示、供应商 Key 隔离及 390px 深色布局。
- `npm run build`：通过。Vite 提示主 JS chunk 超过 500 kB（构建成功）。Rust 测试有既有的 Windows 条件编译未用变量警告。
- 日志：`output/ai-models-{tests,rust-tests,ui-tests,build}.log`；界面截图：`output/playwright/ai-models-{desktop,dark-mobile}.png`，截图中的模型 ID 为测试数据。
- 未使用真实供应商 Key 做联网测试；未构建安装包或重装现有应用。
