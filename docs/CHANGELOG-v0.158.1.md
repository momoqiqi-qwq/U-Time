# v0.158.1

- 修复「警大门户通知 → 警大学分 → 导出成绩单」在 Windows 桌面端点「生成并分享成绩单图片」后弹出空白系统共享面板（界面显示「重试 / 我们无法为你显示所有共享方法」）、且图片永远不会保存的问题。
- 根因：分享分支的判据是 `navigator.share && (!navigator.canShare || navigator.canShare({files}))`，`||` 前半段等于「缺少能力校验接口就放行」。桌面端 WebView 里 `navigator.share` 存在但未实现文件分享，`navigator.canShare` 也不存在，于是进了分享分支并弹出无法退出的空面板，后面的宿主机落盘兜底（`tide.assets.saveBase64`）被整个截胡。
- 修法：只信 `canShare` 的正向结论 —— `navigator.canShare` 与 `navigator.share` 同时为函数、且 `canShare({files})` 返回 true 才走原生分享，否则一律回落到宿主机下载桥保存 PNG。
- 影响 Windows、Android 与小程序的 `cppu-notify` 插件（插件版本 1.34.2 → 1.34.3）；无数据迁移。
- 该插件无独立产物包，改动随主程序版本发布。
