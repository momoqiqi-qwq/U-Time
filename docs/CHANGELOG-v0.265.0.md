# v0.265.0 · 教务子菜单补上「自习室查询」

## 改了什么

`public/plugins/cppu-notify/`（插件版本 1.72.0 → 1.73.0）

1. **接入教务「学生服务 › 公共服务 › 自习室查询」**（`main.js`）
   - functree 节点 `nodeInfo=ZXZYCX` 是实测值（`dev/jw-assets_je_rbac_perm_getMenuTree-post.json`
     里的真实菜单树），不是猜的；`JW_FUNC.room` 只钉 `funcCode`，
     `funcId` 与表名**刻意留空**由运行时 `getStaticFuncByCode` 取 ——
     站点换表名（`T_ZXZYCX` 之外）或多出子表都不用改代码。
   - `/je/load` 必须带 func 元信息，否则一律 `UNKOWN_ERROR`；沿用既有的
     `jwFuncInfo()` 解析与 `JW_RETRY_MS` 退避。
   - 列定义走「服务端配列」：`jwRoomCols()` 按正则认教室 / 时段 / 状态三类列
     （`jxlsmc|ddmc|fjmc|ddd` 等），`jwRoomGroups()` 认分组键，
     前端 bundle 里没有任何硬编码字段名。
2. **三种阅读视角**（`jwState.roomGroup = room | date | flat`）
   - 按教室分组、按日期分组、平铺；切换后把已有过滤词**重新套回一遍**
     （`jwRoomApplyFilter`），否则切一次分组过滤就「失效」。
   - 关键词过滤只切 `[hidden]`、不调 `jwPaint()` —— 重绘会换掉输入框，
     等于每打一个字丢一次焦点。
3. **状态着色复用成绩页那套四档色相**（`jwRoomTone()`）
   - 空闲 / 可用 → `ok`，占用 / 已借 → `bad`，待审 / 处理中 → `warn`，其余中性；
     不另起一套自编色，两页说同一种颜色语言。
4. **写操作不接管**（与交请假、选课同一条口径）
   - 申请借用不在插件里提交，卡片头部给「去教务」免密打开教务自行办理。
     提交接口要真提交一次才录得到字段，照着猜写只会把「申请成功」变成一句假话。
5. **侧栏与图标**
   - 教务父项 `children` 末尾加 `{ view: "cppu-room", label: "自习室", icon: "door-open" }`；
     侧栏入口用轮廓 `door-open`（FA solid sprite），插件彩色图标是 Icons8 Color 的 `classroom`
     （`tools/gen-plugin-icons.py` 的 `VIEW_ICONS` 里 `cppu-room` → classroom；镜像回落见 v0.267.0）。
     不放 `tools/icon-masters/cppu-room.png` 母版：有母版就会被 `master_bytes` 优先读取，
     侧栏静默退回扁平风格，`scripts/test-icon-masters.mjs` 也守着这条。
   - 视图 id `cppu-room`、`keys: ["room"]`；`roomGroup` / `roomFilter` 只活在
     `jwState` 里（不在偏好键内），进视图回到「按教室」+ 空过滤。

## 测试

- `scripts/test-cppu.mjs`：原先「自习室不得出现在侧栏」的反向断言**收窄成只禁评分信息**
  （用户改口要做了），并新增正向断言——教务 `children` 里必须依次出现
  `cppu-xk → cppu-qj → cppu-credit → cppu-cx → cppu-room`；
  `views` 清单与侧栏入口清单补上 `cppu-room`。
- `scripts/test-plugin-view-icons.mjs`：视图 id 数组补上 `cppu-room`。

## 影响哪端

Windows / Android / 微信小程序三端同源插件（小程序侧仍按原生适配清单走，
`cppu-notify` 不在 13 个原生适配插件内，行为不变）。

## 数据迁移

无。新增状态全部落在已有的 `jwState` / `jwCache` 与插件偏好键下，旧数据照常读取。
