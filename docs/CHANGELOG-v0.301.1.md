# v0.301.1

## 修：插件加载失败只剩一句 `Unexpected token '<'`

设置 → 插件管理里某张插件卡如果显示「加载失败：Unexpected token '<'」，这句话不是插件写的，
是 V8 在 `new Function(代码)` 里吃进一段 HTML 时报的原始 SyntaxError。宿主之前把响应体
直接当脚本喂进去，没检查它到底是不是脚本，所以「资源缺失 / 命中兜底页 / WebView 缓存了页面」
三种完全不同的故障在这里长得一模一样。

- `src/pluginHost.js`：内置插件入口拉取新增 `looksLikeMarkup()` 校验；命中标记时换一次性
  参数 `&_r=<时间戳>` 重取一次（缓存兜底页可自愈），仍命中则抛中文
  「插件入口返回的是页面而不是脚本（可能是界面缓存或资源缺失），已尝试重新拉取」。
- `src/views/settings/plugins.js`：带 `rec.error` 的卡片多一个「重试」按钮
  （走 `setEnabled(id, true)` → `runPlugin`）。此前 `rec.error` 只有重启应用或关开一次插件
  才会被清，看到红字没有任何就地重来的入口。
- `public/plugins/cppu-notify/main.js`（`exchangePdataToken`）：统一身份认证换票时接口回登录页，
  裸 `JSON.parse` 会把同一句英文冒到连接状态和设置卡片上。改为解析失败即 `return false`
  （换不到票本来就是「这次没换到」，由上层降级）。

## 影响面

只影响插件装载与错误呈现，无数据迁移，无接口变更。Windows / Android / 小程序三端版本号同步。
