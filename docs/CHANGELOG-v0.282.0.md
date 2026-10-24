# v0.282.0 · 我的体测

## 改了什么

只动 `cppu-notify` 插件（插件版本 1.85.0 → 1.86.0）与它的图标口径
（`src/icons.js`、`tools/gen-plugin-icons.py`、随包 PNG x3）。三端同源，
无数据迁移、无接口变更。

**① 新增「我的体测」视图。** 接 `sport-wechat.cppu.edu.cn` 的体测成绩单，侧栏排在
「我的学分」之后。七个项目（体重身高 / 肺活量 / 50 米 / 1000 米 / 坐位体前屈 /
立定跳远 / 引体向上）按得分排序，每项点开一次看完整历史 —— 重测取最新一次、
旧记录标「旧」、判罚备注逐条列。顶部三格是项目数 / 记录数 / 学年；等级沿用
警大成绩那套四档色（优秀 / 良好 / 及格 / 不及格）。

**② 取数链路是这一页唯一特殊的地方。** 体测系统不认门户 session，只认企业微信
OAuth 发的 `Authorization` token：

- appid 绑死 `wxwork`，普通浏览器连 `authorize.php` 都过不去（微信 UA 才 302 到
  `open.weixin.qq.com`，普通 UA 只回一张提示页）。
- 假 token 实测回 `status: -998`「登录已过期，请重新登录」，所以这不是"随便带点东西
  就能过"的接口，token 是真校验的。
- 因此**插件不做登录**：token 由 `tools/sync-fitness.js` 从企业微信内置浏览器的
  sessionStorage 里取（leveldb 里是 UTF-16LE 存的 `map-N` 键），顺手拉一次成绩
  写进 `public/plugins/cppu-notify/fitness-seed.json`。

**③ 快照语义。** 进页面先读缓存、一个请求都不发；只有点「刷新」才重新拉。
token 过期时状态行照原话说「企业微信的登录态已经过期」，不拿空卡片糊成「暂无数据」——
用户在手机上看到的那句话和这里必须一致。

**④ 图标。** 视图彩色图 `heart-with-pulse`（Icons8 Color，随包 PNG 三端同源），
轮廓图 `heart-pulse`（FA solid，本侧栏与主导航都不撞）。不带 `tools/icon-masters`
母版 —— 有母版会走扁平风格，`scripts/test-icon-masters.mjs` 也守着这条。

## 影响的测试

| 文件 | 变化 |
|---|---|
| `scripts/test-cppu.mjs` | 视图清单加入 `cppu-fitness`（14 个分类） |
| `scripts/test-plugin-view-icons.mjs` | 分类数 13 → 14，`cppu-fitness` 的 FA 与 Icons8 两侧同步 |
| `scripts/test-release-history.mjs` | 首条版本记录为 0.282.0 |

## 边界

- 体测数据是**快照**：没人点刷新就一直是上次同步的那份，不会自己变。
- token 由企业微信下发，换手机 / 退出企业微信后需要重新跑一次 `sync-fitness.js`。
- 没有任何数据迁移：`fitness-seed.json` 只是种子，删掉也只是少一次预置数据。
