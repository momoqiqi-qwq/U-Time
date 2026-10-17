# v0.242.0 · 警大校历：三张卡与标题各配一枚六边形图标

> 归属说明：改动进 `le-time-management/public/plugins/cppu-notify/`（在「必须升版本」的目录里），
> 新增界面元素 → minor +1：`0.241.1 → 0.242.0`；插件清单 `1.59.1 → 1.60.0`。
> 校验：`sync-version.js --check` → ✓ 三端版本一致 v0.242.0。

## 起因

用户需求原文：

> 给这个页面也生成一些好看的图标，日历图标一定有

截图是「校园服务 → 教务 → 警大校历」：标题栏 + 三张汇总卡（当前学期·起止 / 当前教学周 / 本周课程）+ 月历 + 右侧事项面板，**整页一个图标都没有**。

## 为什么是内联 SVG，不是 PNG 也不是图标字体

| 决策 | 选了什么 | 为什么不选另一条 |
|---|---|---|
| 载体 | 纯内联 `<svg>`（`cal-icons.js` 生成字符串） | 插件要跟着 16 套主题 × 浅/深两态走：位图只能为一套配色出一张；图标字体带不动渐变、rim 与投影，且要多一个网络字体 |
| 颜色 | 每枚图标一个 `--light` / `--dark` 双色对，`linear-gradient` 对角填充 | 直接取 `currentColor` 会让六边形底板和白色图形同色；写死单一色在深色主题下会发灰 |
| 渐变 id | `cci${seq++}` 每次自增 | 同一视图里会渲染 4 枚以上图标，`<linearGradient id="g">` 撞名时后一个定义覆盖前一个，先渲染的那几枚会取到别人的高光角度（浏览器按文档序取第一个同名 id） |
| 线宽 | `strokeWidth(size)`：≤30px 用 7.6、≤44 用 6.3、其余 5.4 | 一套固定线宽在 28px 档下笔画只剩 1px 上下，图形会糊成一团；尺寸越小越要加粗是实测结论 |

## 图形语言

照抄「警大成绩 → 绩点排名情况」卡里那套 2.5D 六边形徽章：平顶六边形（`viewBox 0 0 96 96`，外接半径 42，宽 84 高 72.73）+ 对角渐变底板 + 深色 rim 描边 + 顶部白色高光弧 + `feGaussianBlur stdDeviation="3.4"` 的偏移投影 + 居中的白色线性图形。

六枚图标各自的语义色与图形：

| key | 语义色（浅/深） | 图形 | 用在哪 |
|---|---|---|---|
| `cal` | `#B79BFF` / `#6B45D4` | 日历框 + 顶部横杆 + 两个挂环 + 两个圆角实心短条 | 标题栏「警大校历」 |
| `term` | `#7EB6FC` / `#3070D2` | 双向箭头 ⇄（横线 + 两端箭头） | 当前学期 · 起止 |
| `week` | `#FDCA4A` / `#D88A0A` | 圆角方框 + 一条横线 + 实心圆点 | 当前教学周 |
| `course` | `#70E49C` / `#169E58` | 秒表（圆 + 指针 + 顶部双钮 + 横杠） | 本周课程 |
| `event` | `#5EE0D8` / `#159E96` | 两行对勾 + 两行横线 | 备用（事项面板） |
| `sync` | `#FB8E8E` / `#CA3A3A` | 两段弧形箭头 | 备用（同步按钮） |

`term` 改过三版才落定：① 实心圆 → 空心圆 + 短线，54px 下被读成「钥匙 / 链接环」；② 沙漏（两横 + 交叉斜线），被读成 I 形光标；③ 双向箭头 ⇄ —— 笔画少、方向明确，一眼就是「起止区间」。箭头臂长 10.5（不是 7），28px 档才留得住头部。`week` 用「框内点」而不是数字 `8`——数字在深色底上做抗锯齿后边缘会脏。

## 改了什么

- 新增 `public/plugins/cppu-notify/cal-icons.js`
  - `const HEX`、`SET`（六项 `{light, dark, glyph}`）、`export const CAL_ICON_KEYS`
  - `export function calIcon(key, size = 48)`：未知 key 返回空串；`class="cc-ico-svg"`；默认 `size=48`
- `public/plugins/cppu-notify/calendar.js`
  - `import { calIcon } from './cal-icons.js';`（插件内 ESM 相对 import 已有先例：`card-charts.js:18`）
  - `termCardHtml()` / `statsHtml()` / `paint()` 的 header 与 `.cc-now` 各插入一枚图标
  - `statsHtml()` 的日期串拆成两个 `.cc-nw`（`white-space:nowrap`），否则浏览器在连字符处断成「2026-10-」/「18」
  - CSS：`.cc-head-main`（flex + gap 13px + `min-width:0`）、`.cc-head-main>div{min-width:0}`、`.cc-summary>div`（flex + `align-items:flex-start`）、`.cc-body{min-width:0;flex:1 1 auto}`、`.cc-summary .cc-date b{white-space:nowrap}`
  - `.cc-summary` 列宽 `1.5fr 1fr 1fr` → `1.4fr .85fr 1.2fr`（第三张卡内容最长）
  - 窄屏 `@media(max-width:700px)`：标题栏改竖排（`flex-direction:column`）、汇总卡单列、图标缩到 40px
- `public/plugins/cppu-notify/manifest.json`：`version` → `1.60.0`，`author` 补 1.60.0 说明
- `src/pluginCatalog.js` / 小程序 `core/pluginCatalog.js`：由 `node tools/sync-plugins.js` 重生成

## 验证

- 真样式页（`fetch` 出 `calendar.js` 里 `style()` 的那段 CSS 注入 `<head>`，不手抄）在 1280px 与 390px 两种视口下截图：
  - 三卡图标与首行文字顶对齐，第三卡的日期范围完整落在首行、未断行
  - 390px：`limit=280 over=0` —— 无任何元素越过容器右边界；标题栏竖排、三卡单列
- `chrome --dump-dom` 在本机输出 0 字节，窄屏改用 `<iframe width=390>` 承载真视口，避免把「截图像素 < 视口宽度」误判成横向溢出。
