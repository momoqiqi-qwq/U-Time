# v0.295.0

## GitHub 备份配置

- 设置 → 可选同步新增 GitHub 备份配置，可首次自动创建私有 `Backup-UTime` 仓库。
- 使用 GitHub Contents API 按设备名保存 JSON 快照，支持手动上传、历史恢复、远端删除和连接断开。
- PAT 只保存到原生加密密钥库，不进入 `data.json`、快照、日志或仓库 URL。
- 已加入自动备份间隔配置；未连接 GitHub 或没有 PAT 时不会发起网络请求。

## 影响范围

- 桌面端 Tauri：完整支持 GitHub 连接、备份、恢复和历史管理。
- 浏览器调试：UI 可渲染；实际 PAT 存储与原生 HTTP 请求需要 Tauri 环境。
- 数据迁移：无需迁移，旧用户的 GitHub 配置为空并保持现有 WebDAV / 局域网设置不变。
