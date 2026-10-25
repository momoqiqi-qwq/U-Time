# v0.285.0 · 作者署名改为 lyl

用户要求把署名里的真实姓名（中/拉丁两列）去掉，统一改成 `lyl`。
仓库是 PUBLIC，站外能看到的每一处署名都一起改了 —— 这是 v0.232.0 / v0.245.1 铺开署名以来
的第一次**反向收敛**，所以按当初铺开的位置原路改回去，不漏一处。

---

## 改动范围（19 个文件，全部只是署名文本）

| 层 | 位置 | 现在 |
|---|---|---|
| 产品内「关于」页 | `src/aboutData.js` 的 `AUTHOR.name` | `lyl`；`latin` 置空 |
| 同上渲染 | `src/views/aboutCard.js` | `latin` 为空就不再渲染那个 span（否则 `.about-author` 多一格间距） |
| 桌面壳快捷面板 | `src/shell.js` | 头像旁标题 `lyl` |
| 打包元数据 | `package.json` `author`、`src-tauri/Cargo.toml` `authors`、`tauri.conf.json` `publisher` / `copyright`、`miniprogram/core/appMeta.js` `author` | `lyl (momoni / lele / 另一个别名)` |
| HTML head | `le-time-management/index.html` `<meta name="author">` | 同上 |
| 三份 README（根 / 桌面 / 小程序） | 页首署名行 | `By lyl · momoni · lele · 另一个别名` |
| 开源说明 | `public/OPEN_SOURCE_NOTICES.md` | `作者：lyl（momoni · lele · 另一个别名）` + 版权行 |
| 五个文档页脚 | `docs/{index,features,plugins,tech-stack,upload}.html` | `By lyl（momoni · lele · 另一个别名）` |
| 历史版本说明 | `docs/CHANGELOG-v0.232.0.md`、`v0.245.1.md` | 记录里的姓名同步替换 |

**别名照旧**：`momoni` / `lele` / 另一个别名 三个账号昵称保留 —— 用户只要求改姓名。

## 守卫测试同步改口径

`scripts/test-author-attribution.mjs` 原来用 `CN + EN` 两个常量拼出署名写法
（`真实姓名 (拉丁名 / 别名 / …)`）。署名不再分中/拉丁两列后：

- 删掉 `EN` 常量，`FULL` 变成 `${CN} (${别名} / …)`；
- `Cargo.toml` 的断言从拼正则改成 `includes` 字面量（原名含括号，拼正则要额外转义）；
- `aboutData` 的断言只校验名字，`latin` 字段仍然要求存在（只是允许为空）。

以后谁再动署名，要么全改，要么这条测试红 —— 与 v0.232.0 的初衷一致。

## 影响面

- 三端版本：`0.284.0 → 0.285.0`（纯文案与渲染条件，无数据迁移、无接口变更）
- `sync-version --check` / `gen-theme-dark --check` / `build-schedule-plugin --check`
  / `sync-android-native --check` / `gen-pinyin-initial --check` / `gen-cppu-pinyin --check` 全部通过
- `npm test` 全绿

## 仍然待办

**git 历史里的旧姓名与旧学号还在**（`git log -p` 可查）。彻底清除需要重写历史
（`git filter-repo --replace-text`）：全部 commit hash 改变、必须强推、其他人要重新 clone。
这一步没有自动执行。
