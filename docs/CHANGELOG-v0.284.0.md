# v0.284.0 · 公开仓库隐私清理

仓库是 PUBLIC，逐个 token 扫了一遍当前树与全部历史（1522 个跟踪文本文件 + 8530 个历史 blob），
把自查发现的三类个人身份信息从源码里清出去。**功能与数据口径零变更**，纯隐私修正。

---

## 1. 教育邮箱不再写死学号（`public/plugins/cppu-notify/main.js`）

原来邮箱自动登录用的是一行硬编码：

```js
const MAIL_ACCOUNT = "2025290058@cppu.edu.cn";
```

这既把学号写进了公开仓库，也是**功能缺陷** —— 换一个用户登录，邮箱仍然拿着写死的学号去
`POST /cppu/api/login`，必然登不上别人的邮箱。

现在改成按本机记住的登录学号推导：

```js
const mailAccount = () => {
  const name = String(state.username || "").split("@")[0].trim();
  return name ? `${name}@${MAIL_DOMAIN}` : "";
};
```

- `state.username` 本来就从 `tide.storage.get("username")` 来（`main.js` 里 loadPrefs / 成长中心那条兜底都会读），
  与通知、教务、pdata 用的是同一份账号，换账号自动跟着换。
- 取不到学号时不发请求，直接抛「没读到登录学号，请先在「警大通知」里登录一次再打开邮箱」——
  不再拿一个陌生人的学号去撞登录接口。
- `readMail` 返回体里的 `account` 字段同步改成同一份推导值。

`scripts/test-cppu.mjs` 的断言从「源码必须含那串邮箱」改成两条更严的检查：
`mailAccount()` 必须由 `state.username` 推导；源码里不许再出现 `数字@cppu.edu.cn`。

## 2. 注释与文档里的真实姓名 / 院系

`profile.js` 解释「为什么姓名要自己打标」的注释、`CHANGELOG-v0.279.0` / `v0.280.0` 的验收记录、
两个隐私测试的夹具，原本直接用了真实姓名与「民族 · 学院 · 专业」组合，统一换成通用示例
（张三 / 示例学院 · 示例专业）。

**作者署名不动**：README、`aboutData.js`、`package.json` `author`、`Cargo.toml` `authors`、
`tauri.conf.json` `publisher` / `copyright`、三端页脚里的真实姓名与拉丁名是主动公开的署名，
保留原样。

## 3. 本机用户名与绝对路径

| 位置 | 原来 | 现在 |
|---|---|---|
| `dev/*.mjs` 的抓包夹具 | `C:/Users/<用户名>/AppData/Local/Temp/jwprobe/…` | `path.join(tmpdir(), "jwprobe", …)` |
| `tools/gen-pinyin-initial.js`、`gen-chaoxing-pinyin.js` 的模块候选路径 | `C:/Users/<用户名>/.workbuddy/…` | `process.env.USERPROFILE` 拼接（`%LOCALAPPDATA%` 是错的：这些目录在用户主目录下，不在 `AppData\Local`） |
| 同上两个脚本与 `tools/gen-plugin-icons.py`、`docs/plugin-icons.md` 的用法注释 | 写死用户名路径 | `$USERPROFILE` / `%USERPROFILE%` 占位 |
| `scripts/build-android-apk.sh` | `JAVA_HOME=C:/Users/<用户名>/AppData/Local/…`（这处在 `AppData\Local` 下，确为 `%LOCALAPPDATA%`） | `${JAVA_HOME:-${LOCALAPPDATA:-$HOME/AppData/Local}/Programs/Eclipse Adoptium/…}`，环境变量优先 |
| `docs/design/card-badges/serve-probe.mjs`、`extract-fragments.mjs` | 写死仓库绝对路径 | `path.resolve(HERE, "../../../le-time-management")` |
| `动画演示/generate-u-time-intro.mjs` | 写死 `C:/Users/<用户名>/.codex/skills/video-shot-demos` | `process.env.VIDEO_SHOT_DEMOS_SKILL \|\| path.join(os.homedir(), ".codex/skills/video-shot-demos")` |
| `动画演示/插件中心三端联动/capture-wechat-devtools.cjs` | 写死开发者工具绝对路径 | `process.env.WX_DEVTOOLS_CLI \|\| "C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat"` |
| `docs/CHANGELOG-v0.185/0.188/0.197` | `E:\E-Develop-Project\…` | `%REPO%` 占位 |

## 4. `.workbuddy` 内存目录不再入库

`miniprogram/.workbuddy/memory/*.md` 是 AI 工作目录快照（含本机路径、开发者工具安装位置、微信昵称），
`.gitignore` 原先只写了 `/.workbuddy/` 与 `/le-time-management/.workbuddy/`，漏了小程序这条。
已 `git rm -r --cached miniprogram/.workbuddy` 并补上 `/miniprogram/.workbuddy/`；本地文件保留。

---

## 仍然需要人工决定的事

**git 历史里的旧值还在。** 学号在 292 个历史 blob 里出现过，`git rm` 与改文件只影响当前树，
clone 仓库的人 `git log -p` 仍然翻得到。彻底清掉要重写历史（`git filter-repo --replace-text`），
那会改变全部 commit hash、需要强推、所有协作者要重新 clone —— 这一步没有自动执行。

## 影响面

- 三端版本：`0.283.2 → 0.284.0`；cppu-notify 插件：`1.87.2 → 1.88.0`
- `node ../tools/sync-version.js --check` / `gen-theme-dark --check` / `build-schedule-plugin --check`
  / `sync-android-native --check` 全部通过
- `npm test` 全绿
