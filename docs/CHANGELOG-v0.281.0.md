# v0.281.0 · 学生成长并进个人信息

## 改了什么

只动 `cppu-notify` 插件（`public/plugins/cppu-notify/`，插件版本 1.84.0 → 1.85.0）
与它的图标口径（`src/icons.js`、`tools/gen-plugin-icons.py`、随包 PNG）。三端同源，
无数据迁移、无接口变更。

**① 两个视图合成一个。** 「学生成长」与「个人信息」打的是同一套 8 个 pdata 接口
（personInfo / learnSituation / getKpiList / cardConsume / onlineState / getMyAttendance /
bonusPenaltyList / getModuleList），原来各画一遍身份卡、各占一个侧栏入口。现在只剩
`cppu-profile` 一个视图，页面顺序：

| # | 区块 | 数据来源 |
|---|---|---|
| ① | 身份卡（头像 / 姓名 / 学号 / 标签，点标签即复制） | personInfo |
| ② | 学业概览（已修 / 应修 / GPA / 本学期） | learnSituation |
| ③ | 成长指标（彩卡，点开看明细并翻页） | getKpiList + getKpiDetailInfo |
| ④ | 校园生活（我的消费 / 我的上网，滑动选中光） | cardConsume + onlineState |
| ⑤ | 我的考勤 / 奖惩记录 | getMyAttendance + bonusPenaltyList |
| ⑥ | 档案字段（搜索 + 点一格复制 + 复制记录） | personInfo.column |
| ⑦ | 数据报告目录（点开带会话直达） | getModuleList |

**② 首屏仍是「三块先落、五块后补」。** 第一批 personInfo / learnSituation / getKpiList
回来就画；第二批的五块没回来之前，那些位置写「正在读取…」，不写「暂无」——
只有等真的取完才允许说「暂无出勤记录 / 当月无消费记录 / 暂无奖惩记录」。

**③ 30 天本地快照沿用，key 换新。** `growthSnapshot` → `profileSnapshot`；
旧 key 读到就删（合并前它只可能是半页数据）。坏快照（无身份卡 / 形状不对 / 时间为 0）
一律当没有缓存；首屏齐但不足半数的那次不落盘；没有 `tide.cache` 的老宿主静默降级。

**④ 文件与图标口径。** `growth.js` 删除；侧栏分类 14 → 13；`cppu-growth` 从
`VIEW_ICONS8` / `VIEW_FA_ICONS` / `gen-plugin-icons.py` 的 `VIEW_ICONS` 里摘掉，
两端 `cppu-growth.png` 与其在 `ATTRIBUTION.md` 的素材行一并删除。
「个人信息」的图标（`address-card` / `contact-card`）不变，用户不用重新找入口。

## 影响的测试

| 文件 | 变化 |
|---|---|
| `scripts/test-cppu-profile-cache.mjs` | 由 `test-cppu-growth-cache.mjs` 改名重写，验新 key、旧 key 清理、八路取数 |
| `scripts/test-cppu-speed.mjs` | ② 段从 growth.js 改为 profile.js（8 请求、两批落画面、刷新走 force） |
| `scripts/test-cppu-profile-reports.mjs` | 目录改随第二批取数（不再是「第三枪」），刷新断言 8 路全 force |
| `scripts/test-cppu.mjs` / `test-plugin-view-icons.mjs` | 视图清单去掉 `cppu-growth`（13 个分类） |
| `scripts/test-privacy-mask.mjs` | 成长页姓名打标改为在 `profile.js` 内校验（合并后同一页，打标数 ≥ 3） |
| `scripts/test-wait-mask.mjs` | 插件子文件清单去掉 `growth.js` |

## 边界

- 侧栏不再有「学生成长」入口 —— 老用户到「个人信息」里找，内容只多不少。
- 指标明细弹层、消费 / 上网切换、档案复制与数据报告直达的口径一条不改。
- 没有任何数据迁移：快照只是缓存，删掉也只是多等一次网络。
