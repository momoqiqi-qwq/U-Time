# v0.267.0 · 自习室搜索支持拼音首字母与简写，图标换成 Icons8 Color

## 改了什么

`public/plugins/cppu-notify/`（插件版本 1.74.0 → 1.75.0）

1. **自习室搜索从「一层」变「三层」**（`main.js` 的 `roomFieldHits()`）
   - 原文：`jwRoomText()` 归一（小写 + 去全角/半角空白）后 `includes`。
   - 拼音首字母串包含：`wct` / `ct` ⊂ 王晨听，`jsj` ⊂ 计算机。
   - 跳字简写（子序列）：`wt` ⊂ `wct`、`sjm` ⊂ `sxjm`（数学建模）。
   - **单字母只走包含**（长度 < 2 不做子序列），否则一个 `s` 会把整页教室全捞出来。
   - 拼音表按需异步加载（`loadRoomPinyin()`，只加载一次），失败就静默退回「只有原文匹配」，
     不让拼音依赖把搜索框变成错误页。
2. **逐字段匹配**：教室名 / 校区 / 楼栋 / 日期 / 节次 / 容量 / 状态各自独立判定，
   而不是把整行拼成一个大字符串再 `includes` —— 后者会让「3 号楼 5 月」这种跨字段拼出来的
   假命中出现在结果里。
3. **空结果写人话**：说明能搜哪些字段，并给一条拼音示例（如 `jsj` 找计算机教室），
   而不是只显示「没有匹配项」。
4. **图标换成 Icons8 Color**（`tools/gen-plugin-icons.py` 的 `VIEW_ICONS`）
   - `cppu-room` 的生效 slug 是 `classroom`，随包 PNG 81×81，三端同源。
   - **不放 `tools/icon-masters/cppu-room.png` 母版**：有母版就会被 `master_bytes` 优先读取，
     侧栏静默退回扁平风格，`scripts/test-icon-masters.mjs` 守着这条。
   - 本机 `img.icons8.com` / `maxst.icons8.com` 的 TLS 握手被重置（直连与 `127.0.0.1:7897` 代理
     都一样），生成器因此加了镜像回落 `CDN_HOSTS = ("img.icons8.com", "img.icons8.ru")` ——
     两者是同一套 slug/style，`img.icons8.ru` 可直连。对外文档与 `src/icons.js` 的 CDN 回落
     仍写主站域名（用户端能连的是主站）。
   - `src/icons.js` 的 `VIEW_ICONS8["cppu-room"]` 同步为 `["classroom", "door", "open-door"]`；
     轮廓图标仍是 FontAwesome `door-open`。

## 测试

- `scripts/test-cppu.mjs`：新增自习室搜索的四条断言（原文 / 拼音首字母 / 跳字简写 / 单字母不子序列），
  以及空结果文案必须提到可搜字段。
- `scripts/test-icon-masters.mjs`：`cppu-room` 随包 PNG 与台账 sha256 一致、无母版行。
- `scripts/test-plugin-view-icons.mjs`：`cppu-room` 进入 12 个分类图标的两两不同与不撞名清单。
- 全量：`156 个测试脚本全部通过`；`sync-version.js --check` / `gen-theme-dark.js --check` /
  `build-schedule-plugin.js --check` / `sync-android-native.js --check` 四项全绿。

## 影响面

桌面端、Android、小程序三端的图标与插件文案同步；无数据迁移，无偏好键变化
（`roomGroup` / `roomFilter` 只活在 `jwState` 里）。
