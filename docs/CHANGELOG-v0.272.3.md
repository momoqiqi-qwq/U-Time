# v0.272.3 · 我的学分补上入口

## 改了什么

`le-time-management/public/plugins/cppu-notify/main.js`（插件版本 1.82.2 → 1.82.3）

新增「我的学分」视图（`cppu-credit-ledger`，标题「警大学分」）：

- **这是一次接线，不是重写。** `jwAcademicCreditHtml()` 本来就在插件里写着 —— 已获得 / 培养计划
  总学分、必修 · 选修 · 实践三张可点分类卡、按课程模块分组的明细、隐藏已修完 ——
  也有测试守着（`scripts/test-cppu.mjs` 里那段 `data-credit-toggle` 断言）。
  但**没有任何视图调用它**，于是这段渲染体在侧栏里根本进不去。
- 现在它挂成一个独立分类：教务 › 我的学业 › 成绩 › 我的学分（`JW_MENU.credit`），
  取数复用已有的 `creditPlan` / `creditModule` / `grade` 三个键，点分类卡与隐藏已修完走的是
  全 shell 通用的 `[data-credit-toggle]` / `[data-credit-hide-done]` 代理，零新增事件。
- 学分是全校口径、不按学期切，所以这一页没有学期胶囊。
- 图标：轮廓用 FA `scroll`（卷轴 = 账本），彩色 PNG 用 Icons8 `scroll`。**不用 `graduation-cap`** ——
  那是学习通那个插件的图标，同一条侧栏里撞图标会被 `test-plugin-view-icons` 拦下。

同步改到的清单：

| 位置 | 改动 |
|---|---|
| `public/plugins/cppu-notify/main.js` | `JW_VIEWS` 加条目、`JW_MENU.credit`、`jwKeyLabel.credit`、`QUICK_LINKS` 教务子项 |
| `src/icons.js` | `VIEW_ICONS8["cppu-credit-ledger"] = ["scroll","certificate"]`、`VIEW_FA_ICONS = "scroll"` |
| `tools/gen-plugin-icons.py` | `VIEW_ICONS` 加一行，生成两端 PNG |
| `scripts/test-plugin-view-icons.mjs` | 视图清单 13 → 14 |
| `scripts/test-cppu.mjs` | 视图 id 清单 14 → 15、侧栏入口清单加 `cppu-credit-ledger` |

## 回归断言

- 视图注册清单（两个测试各一处）与 `src/icons.js` 两张表一一对应，图标不许重名。
- 随包 PNG 字节两两不同、桌面与小程序同源、FA sprite 里真有 `scroll`。
- 学分页原有用例继续绿：分类卡 `aria-expanded`、模块行文案、隐藏已修完。

## 未做

教务字典只给码不给名字（`funcData.dicInfo` 里是 `KCSXDM_1` 这类码），猜过的字典端点全是 404，
所以类别 / 属性 / 模块一律走插件里已有的 `JW_DD`，未命中的码原样显示。
学分认定、免修仍在教务站内办，本视图只读。
