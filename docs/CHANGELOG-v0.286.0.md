# v0.286.0 · 署名去掉第三个别名

接 v0.285.0（姓名改为 `lyl`）：那一个是全名拼音，与姓名同源，用户要求一并去掉。
现在署名只剩两个账号昵称 —— `momoni` / `lele`。

---

## 改动

| 位置 | 现在 |
|---|---|
| `src/aboutData.js` `AUTHOR.aliases` | `["momoni", "lele"]` |
| 三份 README 页首 | `By lyl · momoni · lele` |
| 五个文档页脚 | `By lyl（momoni · lele）` |
| 开源说明 | `作者：lyl（momoni · lele）` |
| 打包元数据（`package.json` / `Cargo.toml` / `tauri.conf.json` / `appMeta.js` / `index.html`） | `lyl (momoni / lele)` |
| `docs/CHANGELOG-v0.245.1.md` | 当初「三个别名」的叙述同步收敛为两个 |

守卫测试 `scripts/test-author-attribution.mjs` 的 `ALIASES` 常量随之变成两项；
它按数组长度拼 `FULL`，所以元数据少一项就会红。

## 影响面

- 三端版本：`0.285.0 → 0.286.0`（纯署名文本，无逻辑改动）
- 六道生成器 `--check` 全部通过；`npm test` 全绿

## 仍然待办

**git 历史里的旧姓名、旧别名与旧学号还在**（`git log -p` 可查）。
彻底清除需 `git filter-repo --replace-text` 重写历史：全部 commit hash 改变、必须强推、
其他人要重新 clone。这一步没有自动执行。
