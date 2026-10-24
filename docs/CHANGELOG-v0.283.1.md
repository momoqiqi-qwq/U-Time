# v0.283.1 · 我的体测：去掉成绩行下的进度条底轨

## 改了什么

只动 `cppu-notify` 插件（插件版本 1.87.0 → 1.87.1）。三端同源，无数据迁移、
无接口变更、无新权限。

**去掉 `.fit-bar-track` / `.fit-bar-fill`。** 那是画在每项成绩行底部的一条
3px 细轨道，用「本次得分 / 满分」的比例填色。低分项目（如引体向上 3 个）
填充几乎为零，屏幕上只剩一根横贯整行的浅色细线 —— 看起来像一条多余的分隔线，
恰好把「成绩行」和下面「最好成绩 / 每次记录」割开。已整条删除，成绩行与展开
内容直接相连。

- `fitness.js`：模板里移除 `<span class="fit-bar-track">…`，连带删掉只为它
  服务的 `const pct` 与两条 CSS 规则。
- 项与项之间那条 1px 分隔线（`.fit-item + .fit-item`）保持不变。
- 顺手修回一处 CSS：`.fit-note` 基础规则的 `margin/font-size/color/line-height`
  在上一版被覆盖掉了，现在补回，底部提示文案恢复到原来的字号与颜色。

## 影响范围

纯视觉，插件内部。桌面 / Android / 微信小程序三端一致。

## 验证

`npm test` 全通过；`sync-version.js --check`、`sync-plugins.js --check` 均 ✓。
