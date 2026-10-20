# v0.259.0 · 获奖名册：同一奖项被发两条通知时不再重复计数

## 改了什么

- `le-time-management/public/plugins/cppu-notify/award-list.js`
  - **重复获奖记录合并（本版主修）**：门户会把同一批评奖结果发成**两条通知** ——
    一条正文写名单，另一条是附件「成绩报告单」。两条 `RESOURCE_ID` 不同，但项目名、
    级别、名单是同一批人，于是名次榜、人名榜展开里同一条记录出现两次
    （实测：王晨昕《出入境证件信息录入》二等奖 2 次、熊飞扬《公安法制审核》二等奖 2 次）。
    现在 `buildAwardBoard()` 建完 items 后做一遍合并：**项目相同 + 级别相同 + 署名对象有交集**
    （个人取 `people`、团体取 `teams` 的交集）⇒ 判定为同一次评奖，合并成一条。
    - 合并后 `groups` 取并集、`date` 取较新、`affix` 与 `mentors` 并集；
    - `mergedRids` 记住全部来源 rid，`stats.merged` 报出被合并的副本数；
    - 主记录取「名单更全 → 带附件 → 更新」的那条，点「回原通知」仍能核到人。
  - **级别不再取整条通知的汇总级别**：一条通知里同时有一二三等奖时（如《特勤综合体能》），
    原来所有人 `hits.level` 都取 `item.level`，导致三等奖的人显示成「一等奖」。
    改为 `g.level || item.level`，每条记录带自己的级别。
  - **新通知内同名同级别先折叠**：`foldGroups()` 按 `kind|name|level` 折叠并并集 `members`，
    正文与附件粗扫各扫到一个人时只算一项。
- `le-time-management/public/plugins/cppu-notify/main.js`
  - 名册状态行在「命中获奖通知 N 条」后追加「（同一奖项重复发布 M 条已合并）」，
    用户对比上一版通知条数变化时能看懂为什么少了。
- `le-time-management/scripts/test-cppu-award.mjs`
  - 新增「4c」小节 5 组断言：重复通知合并（主 rid 取新、`mergedRids`、`stats.merged`）、
    级别不同不合并、名单无交集不合并、多级别通知取各自级别、同名同级别折叠。

## 影响哪端

桌面端与 Android 的 cppu-notify 插件共用同一份 `award-list.js` / `main.js`，两端一致。
名册缓存的 records 仍是原始两条通知（合并发生在渲染前的 `buildAwardBoard()`），
**旧缓存无需清除**，重开视图即按新口径统计。

## 有没有数据迁移

没有。本地缓存格式（`AWARD_CACHE_VER = 2`）未变。
