# v0.247.1

> 用户诉求（原话）：「优化代码」
> 经确认的范围：**桌面端核心（`src/` + `src-tauri`），以性能 / 稳定性为主**，只改代码与测试，不构建、不发布。
> 影响面：**仅桌面端**（Rust 后端 + 自动化前端模块）。Android、小程序、插件均未改动。
> **无数据迁移**：data.json 结构不变；旧的自动化日志在下次写日志时自动裁掉多余快照。

## 改了什么

### 1. 阻塞型命令移出主线程（`src-tauri/src/lib.rs`）

新增 `off_main(job)`（`spawn_blocking` 包装）。以下命令改为 `async`，文件 IO / 解压 / 压缩不再占用 IPC 主线程：

| 命令 | 之前 | 现在 |
|---|---|---|
| `load_data` / `save_data` / `recover_data` | 同步读写整份 data.json | `off_main`；成功后顺带刷新桌面设置缓存 |
| `list_plugins` / `read_plugin_file` / `delete_plugin` | 同步 | `off_main`，函数体移到 `*_blocking` |
| `import_plugin_zip` / `export_plugins_zip` | 同步解压/压缩 | `off_main` |
| `save_download` / `save_download_base64` / `capture_ui_shot` 落盘 | 同步 | `off_main` |
| `lan_stop` | 持锁等待服务线程退出 | 锁内只 `take()`，锁外再停服务 |

`save_data` 改 async 是安全的：前端 `persistence.js` 本来就串行 await 每次写入，不会并发落盘。

### 2. 插件 zip 导入改为「暂存 → 校验 → 原子替换」

过去直接解到目标目录，中途失败会留下半个插件。现在先解到
`<数据目录>/plugins-import-<pid>-<nanos>/`，校验 manifest 后：旧目录改名为 `<id>.old` → 新目录改名到位；
任一步失败就回滚，暂存目录由 `StagingGuard` 在 Drop 时清理。

### 3. 关窗不再重复解析 data.json

`read_desktop_setting()`（`close_to_tray` / `tray_enabled` 各调一次）过去每次都 `read_to_string` + 整份解析。
现在 `load_data` / `save_data` / `recover_data` 维护一份内存里的 `settings` 缓存，命中直接读，缺失时才回退到磁盘。

### 4. 其他稳定性修补

- `lan.rs`：`qr_svg` 生成失败返回占位 SVG，不再 `expect` 崩线程；`/api/state` 读取失败改用 `serde_json::json!` 组错误体，只带 `e.kind()`，不再手拼 JSON 字符串。
- `update.rs`：下载写入改 256 KB `BufWriter`，循环结束显式 `flush()`，写盘错误不再被 Drop 吞掉。
- `native_schedule.rs`：Windows 分支挪进 `spawn_blocking`，不再阻塞调用线程。
- `vault.rs`：插件保险箱加内存缓存 + 读改写锁（`with_plugin_vault`），`plugin_vault_set/get/del` 改 async；
  并发写不再互相覆盖，持久化失败时缓存回滚；保险箱清空时删除文件。
- `ai_chat`：复用 `OnceLock<reqwest::Client>`，不再每次请求新建连接池。

### 5. 自动化日志的撤销快照（`src/automation.js`、`src/aiAutomation.js`）

- 每条自动化日志的 `before` 是整份任务 / 时间块 / 收件箱副本，最多 120 条 —— data.json 因此膨胀到数 MB，
  每次自动保存都要整份重写。现在**只有最近 5 条（`LOG_UNDO_KEEP`）保留撤销快照**，更早的置 `null`（界面上不再显示「撤销」）。
  撤销一条很早的记录本来就会连带抹掉之后的所有手动修改，限制在最近几条也更安全。
- 「截止任务自动排程」每次数据变化都会跑，过去对每个候选任务都先整份深拷贝，排不进去也照拷。
  现在只留时间块数组的浅拷贝，**真排进去才深拷贝成快照**；无法排程时零拷贝。

## 刻意没改的

- LAN 服务的 `Access-Control-Allow-Origin: *`：前端与小程序都走 Rust `httpFetch` / `wx.request`，
  但为不影响旧版客户端，本次不动。
- zip 导入的体积上限、`ai_vault_*`（数据量很小）保持原样。

## 验证

- `cargo check --tests`、`cargo test` 通过。
- 新增 `scripts/test-automation-log-prune.mjs`：快照裁剪、排程快照为排程前的深拷贝、撤销恢复、排不进去不写日志。
- 四项 `--check` 与 `npm test` 全部通过。
