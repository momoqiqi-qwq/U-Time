# v0.298.0

## 新增「校园地图」视图（cppu-notify v1.91.0）

- 把 cppu-helper 的校园点位搬进 U-Time：Rooms.java 里的 7 栋楼 + 13 个地标（7 号楼与 7 号宿舍楼经纬度完全相同，合并成一个节点，共 19 个点位）。
- 画法是**离线 SVG 示意图**，不是在线瓦片：按真实经纬度等比投影（1 user unit ≈ 0.4965 m，横纵同一比例），校区外接框 lon 116.65732–116.66310 / lat 39.52922–39.53579 → viewBox `0 0 1192 1660`。Tauri WebView 与 Android WebView 上都不依赖网络，也不引进 slippy 地图那套瓦片坐标与缩放。
- 楼名直接画在图里，字号按楼的宽度反算：主楼 28 号（旧实现是 osmdroid marker title 写死的 12sp，改不动），窄楼（1号 / 2号办公楼）折成「1号 / 办公楼」两行保住大字，校门 24 号。标签块按行数垂直居中，不再掉到色块下沿外面。
- 点楼出详情卡：位置说明 + 教室号 + WGS-84 原始坐标；「在高德打开」先把 WGS-84 换算成 GCJ-02（实测校区一带偏移 经 +0.00136° ≈ 117 m、纬 +0.00453° ≈ 502 m，不换算会落到校门外的街上），再拼 `uri.amap.com/marker` 深链。
- 「看某栋的自习室」先写 `jwState.roomBld` 再 navigate 到 cppu-room，楼名口径与 `jwRoomBuilding` 一致（A 栋 / B 栋 / C 栋 / D 栋 / E 栋 / 主楼 / 7S 楼），不另造叫法；宿舍与食堂没有对应关系，不给这个按钮。
- 类别单选（全部 / 教学 / 宿舍 / 食堂 / 办公 / 服务 / 校门）走宿主 `tide.ui.selectionGlow`，光块随选择滑动（铁律六）。
- 搜索认三种输入：原文、拼音首字母（`xwc` = 信息网络处）、跳字简写（子序列），逐字段比而不是 `join(" ")` 后整串比（铁律十）；空结果写人话并说明支持哪些输入。
- 详情卡用 `grid-template-rows: 0fr → 1fr` 做双向展开收起（铁律七），`prefers-reduced-motion` 下不做过渡。

## 影响范围与数据

- Windows / Android 插件界面同一份代码；小程序侧 `platforms.miniprogram = unavailable`，不涉及。
- 纯新增视图，不取数、不写缓存、不改任何既有视图的筛选状态（唯一副作用是按楼跳自习室时设置 `jwState.roomBld`，与手点楼胶囊等价）。
- 无数据迁移。

## 验证

- 新增 `le-time-management/scripts/test-cppu-campus-map.mjs`：19 个点位唯一 / 字号按宽度反算且不溢出 / 搜索逐字段 / WGS→GCJ 偏移量与 `coordinate=gaode` / 展开收起双向 / `cppu-map` 只注册一次且图标未被别的视图占用。
- 浅色 / 深色两张截图逐处核对：无文字溢出、无文字互压、无色块重叠，比例尺与指北针不压楼。
- 按仓库要求执行版本三端同步、主题、课表生成物、Android 原生一致性四项校验与全量测试。
