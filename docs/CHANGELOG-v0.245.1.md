# v0.245.1

> 用户诉求：「把 momoni / lele 两个昵称添加到作者上面去。」
> 把 `momoni` / `lele` 两个账号 / 昵称并入作者署名，产品内与文档、打包元数据同源。

## 改了什么

### 1. 「关于」页作者行追加别名

`le-time-management/src/aboutData.js` 的 `AUTHOR` 新增 `aliases: ["momoni", "lele"]`。
`src/views/aboutCard.js` 在拉丁名后按数组顺序平铺渲染 `.about-author-alias`，
显示为 `By lyl [momoni] [lele] · 设计与开发`。

样式（`src/styles.css` `.about-author-alias`）做成轻描边胶囊：`1px var(--line)` + `var(--ink-3)`，
只消费既有主题令牌，不新增色值 —— 深色变体仍由 `gen-theme-dark.js` 照常派生。

### 2. 署名四处同源

| 落点 | 写法 |
|---|---|
| 产品内「关于」页 | `AUTHOR.aliases` → 三个胶囊 |
| 三个 README（根 / `le-time-management` / `miniprogram`） | `By lyl · momoni · lele` |
| `docs/*.html` 五个页面页脚 | 同上 |
| 打包元数据 | `package.json` `author`、`Cargo.toml` `authors`、`tauri.conf.json` `publisher` / `copyright`、`miniprogram/core/appMeta.js` `author`、`index.html` `<meta name="author">`，统一 `lyl (momoni / lele)` |
| `public/OPEN_SOURCE_NOTICES.md` | 作者行同样带别名 |

`src/shell.js` 快捷面板里的 `lyl` 与 `YL` 头像保持原样（沿用 v0.232.0 的决定）。

## 影响

- 三端版本号 0.245.1（patch：纯文案 / 署名，无行为变更，无数据迁移）。
- 无数据迁移，无接口变更。
