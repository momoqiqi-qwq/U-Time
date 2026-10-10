# v0.182.0 · Nephele 风格：右侧主区改成与左侧侧边栏同一条底色

## 用户要求原文

> 「把右边界面调得鲜艳一点，像左边那样【弄成和左边侧边栏一样的背景颜色。】」

（截图环境：主题「敦煌 dunhuang」+ 深色 + Nephele 风格，视图「任务表 · 程度分类」）

## 一、改了什么

只动 `src/styles/nephele-settings.css` 的桌面块（`@media (min-width: 901px)`）：

| 位置 | 改前 | 改后 |
|---|---|---|
| `:root[data-nephele-settings="on"] .main` | `background: color-mix(in srgb, var(--bg) 58%, transparent)` | `background: color-mix(in srgb, var(--nephele-rail) 90%, transparent)` |
| `…[data-nav-glass="solid"] .main` | `background: color-mix(in srgb, var(--bg) 76%, var(--panel))` | `background: color-mix(in srgb, var(--nephele-rail) 96%, var(--paper))` |

改后 `.main` 与 `.rail` 用的是**同一条声明**（同令牌、同混合比例、同透明度），两块大板只靠
`--nephele-edge` 的 1px 描边和圆角分工。毛玻璃档的 `backdrop-filter: blur(26px) saturate(1.08)`
保持不变。

## 二、根因

Nephele 风格早就给侧栏起了专属令牌 `--nephele-rail`（浅色 `#e4d7f4` / 深色 `#342350`），
却只把主区留在通用 `--bg` 上混合透明。同一个窗口里两块大板不同色系：左边是饱和薰衣草紫，
右边是发灰的暗板，越靠近卡片越显脏 —— 用户看到的「右边不鲜艳、不像左边」就是这么来的。
（与 v0.175.0 给侧栏另起 `--nephele-rail` 是同一类问题的另一半，这次把主区补齐。）

## 三、影响哪端

- 桌面端（≥901px）的 Nephele 风格外观；窄屏（≤900px）外壳是「主区铺满 + 悬浮玻璃底栏」，
  主区本来就没有自己的底色（body 的 `--bg` 直接透出），不受影响。
- 插件中心那条特例（`.main:has(> .view > .market)` 背景透明）保持原样。
- **无数据迁移**：只改颜色声明，不动任何令牌事实源（`src/styles.css` / `tools/lib/theme-tokens.js`），
  因此不需要重跑 `gen-theme-dark.js`；关掉 Nephele 开关时一条规则都不命中，界面逐像素回到原样。

## 四、验证

无头 Chrome 真渲染（真应用外壳 + 真 `src/styles.css`，1590×995，`--force-device-scale-factor=1.5`，
主题 `dunhuang` + `data-theme-mode="dark"` + `data-nephele-settings="on"` + `data-nephele-background="on"`，
四象限视图，7 待办 / 28 已完成）逐点取样：

| 取样点 | 改前 | 改后 |
|---|---|---|
| 侧栏 (200, 300) | `(56, 40, 84)` | `(56, 40, 83)` |
| 主区右边缘 (1570, 300) | `(53, 45, 66)` 灰 | `(55, 39, 81)` 紫 |
| 主区右边缘 (1570, 700) | `(56, 47, 70)` 灰 | `(56, 39, 82)` 紫 |
| 四象限卡片 (330/800/1200, 300) | `(49,33,31)` / `(49,43,30)` | 逐点一致，未变 |

对照图：`le-time-management/output/preview/rail-tone-before-after.png`
（同目录另存 `rail-tone-before.png` / `rail-tone-after.png` 单图）。

## 五、与同工作区另一条改动的关系 / 升版本

本改动记录为 **0.182.0**。同一工作区随后还有一条改动「字标改名 U Time WorkSpace + 字标下方
哥特装饰线」，它取 **0.183.0**（见 `docs/CHANGELOG-v0.183.0.md`，其开头也写明了这个让号关系），
所以 `package.json` 的最终值是 **0.183.0**，本文件描述的两条 CSS 声明随该版本一起发布。

`node ../tools/sync-version.js --check` → ✓ 三端版本一致：v0.183.0；
`gen-theme-dark --check` ✓ / `build-schedule-plugin --check` ✓ / `sync-android-native --check` ✓；
`npm test` 全量跑一遍 123 个脚本，唯一一次失败是 `test-miniprogram-parity.mjs` 的
「小程序版本与桌面 package.json 不一致」——那是上面那条字标改动已把小程序侧升到 0.183.0、
而桌面侧还停在旧号造成的，与本次配色改动无关；版本对齐后该脚本通过。
