# v0.180.0 · 插件卡片：删掉那枚没用的「打开」按钮

## 用户要求原文

> 「把插件的打开按钮删除，因为没用。」

## 为什么它确实没用

插件中心（`src/shell.js` 的 `renderMarket`）里，每张卡片底部原来是三件套：

```
[打开]  [已开启 ⬤]  [⋯]
```

而**卡片自己早就是打开入口**，同一个视图一直有两套入口：

- 点卡片任意空白处 → `switchTo("plug:<第一个视图>")`（`shell.js` 的卡片 `onclick`）；
- 键盘焦点落在卡片上按回车 / 空格 → `isSelfActivationKey` 判定后同样 `switchTo`；
- 卡片上挂着 `role="button"` + `tabindex="0"`，读屏软件念出来的就是「按钮」。

那枚「打开」按钮做的事与第一条**完全一样**，只多一次鼠标位移。窄屏（`max-width: 900px`）
更是早就用 `.market-manage-card .market-card-actions > .btn { display: none; }` 把它藏掉了 ——
手机用户从来没见过它。删掉不损失任何能力，也不再让「打开」与「无视图」两种文案挤在启停滑块旁边。

## 改了什么

- `src/shell.js`：删掉 `open` 按钮的创建（含「打开 / 无视图」文案）、从 `.market-card-actions`
  里摘掉它、并清掉 `refreshCard()` 里对它那两行状态同步。卡片操作区现在只剩启停滑块与「⋯」。
- `src/styles.css`：窄屏那条「藏掉 `.btn`」的死规则换成注释，写明按钮已删（后来人别再加回来）。
- `scripts/test-market-toggle.mjs`：原来断言的是「打开按钮 disabled / 点它能进新注册的视图」，
  现在改测**卡片自身**的两条路径 —— 停用态点卡片只提示、不跳转；启用态点卡片进入最新注册的视图；
  另加两条静态断言，防止那枚按钮被顺手加回来。

## 验证

- `node scripts/test-market-toggle.mjs` 通过（含新增的卡片路径断言与「无视图」静态断言）。
- `npm test` 全绿；`node ../tools/sync-version.js --check` 输出三端版本一致 v0.180.0。

## 影响哪端

- 桌面端与 Android 插件中心同时生效（同一份 `renderMarket`）。
  **窄屏本来就不显示这枚按钮，所以手机端视觉零变化。**
- 无数据迁移：只动界面，不碰任何存储字段、不碰插件清单与插件目录。
