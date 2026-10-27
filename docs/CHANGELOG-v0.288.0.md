# v0.288.0 · 插件缓存并发读取与排程候选搜索优化

## 改动

- `le-time-management/src/pluginCache.js`：同一插件、同一键的并发冷读共享一次后端读取与旧数据迁移，各调用仍使用自己的默认值。成功的空结果可命中内存，读取或迁移失败后允许重试。
- 等待写队列、读取磁盘及迁移结束后优先采用最新内存值，修复冷读期间发生 `set/remove` 时，旧 `storage` 缓存再次迁移并覆盖新文件或复活删除值的问题。保留按键串行写入、权限检查和写盘失败回退。
- `le-time-management/src/scheduleConflict.js`：每轮候选搜索只解析一次时间块，合并占用区间后用二分判断冲突。搜索由逐候选扫描全部时间块的 `O(C × B)` 改为预处理 `O(B log B)`、候选查询 `O(C log B)`；`B` 为时间块数量，`C` 为尝试的候选数量。
- 保留候选时段顺序、相邻边界不冲突、编辑时忽略自身，以及冲突列表中的原始对象与顺序；不修改源时间块。

## 影响范围与数据迁移

- 桌面和 Android 共用前端逻辑受益；小程序本次仅同步版本。
- 三端版本从 `0.287.0` 同步至 `0.288.0`，无数据结构变更，无需数据迁移。
- 工作区已有的插件卡片调整保持原样；本版不包含安装包构建或发布。

## 验证

- `node scripts/test-plugin-cache.mjs`：可控 Promise 验证 8 次同键冷读仅产生 1 次后端读取、各自默认值、并发写入/删除、迁移期间写入及错误重试。
- `node scripts/test-schedule-alternatives.mjs`：候选顺序、边界、输入保护、120 组穷举参照；1,500 个全天占用块用例，解析次数由 100,500 次降至 1,500 次。
- 额外执行 3,000 组旧版与新版候选结果对照，覆盖未对齐网格的时刻、不同步长、忽略自身、非法与无限区间，结果一致。
- 版本、深色主题、课程表生成物、Android 原生镜像四项 `--check` 均通过。
- 优化前工作区 `npm test`：162 个脚本全部通过；本次全量检查：157/163 通过。运行期间其他会话修改了插件市场、时间线与自动登录代码，失败集中于 `test-android-plugin-views.mjs`、`test-cppu-autologin-warm.mjs`、`test-cppu-jw-login-once.mjs`、`test-cppu-pdata-login.mjs`、`test-cppu.mjs`、`test-plugin-permissions.mjs`。保留并行改动，未构建；结果记录于 `test-results/code-optimization-v0.288.0.log`。
