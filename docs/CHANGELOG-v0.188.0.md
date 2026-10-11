# v0.188.0 · AI 配置的框体照 Nephele；设置页的「裸值」口径收窄回数字输入

> `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.188.0`；
> 只动桌面 / 手机端共用的前端（`src/styles.css`、`src/views/settings/ai.js` 与两个测试脚本），
> 内置插件、小程序、Rust 侧、`tauri.conf.json` 均无改动。

## 用户要求原文

> 「这种框好雷霆，太小太窄，学习nephele的的框」（附图：设置 › AI 与自动任务 的 Base URL 输入框）
> 「只有输入数字才是「裸值 + 聚焦才显框」，其他都是」

## 一、先确认「这个框」是哪一个

截图只有 313×29 的一小块，靠像素与几何反查定位（当时视觉后端整轮不可用，本地也没装 tesseract）：

| 线索 | 实测 | 结论 |
|---|---|---|
| 框内文字 | WinRT OCR → `http://127.0.0.1:8788/v1` | 是「URL 输入框」，不是模型 / 密钥框 |
| 8788 端口 | `127.0.0.1:8788` 由 `E:\E-Apps\AI Manger\wb-proxy\python\python.exe` 监听 | 用户的本地 OpenAI 兼容 AI 代理 ⇒ **Base URL** |
| 字高与字宽 | 文字行高 ~13px、整串宽 ~182px；`Microsoft YaHei UI 16px` = 180px/13px（唯一同时命中，13px 只有 154px/10px） | 该框实际字号 ≈16.25px ⇒ 「文字大小」被调到 125% |
| 框本身 | 约 308×28，圆角小、有 1px 描边 | 真渲染几何：1280 窗口下 Base URL 是 **373×26**；1085 窗口下只剩 **180×26**（撞栅格 `minmax(180px, .75fr)` 的下限） |
| 对照排除项 | 设置 › 可选同步 › 网盘根地址 `input:url` 是 858×26 | 太宽，排除 |

真渲染（无头 Chrome，iframe 逼真视口，`?w=&h=&ts=125`）改前实测：

```
1280×900（nephele 风格 + 暮光紫深色 + 文字大小 125%）
card   x=112 y=289 w=1056 h=434
grid   columns = 621.25px 372.75px
供应商  621×38   Base URL 373×26   ← 长 URL 在窄列
模型    579×26   API Key 1006×26
Base URL / 模型 / API Key 的 input：radius 8px、padding 0px、背景与描边全透明、min-height auto
```

两个毛病都在这张表里：**① 太窄** —— 最短的「供应商」下拉占了 621px 的宽列，最长的 URL 被排在
0.75fr（最小 180px）的窄列；**② 太小** —— 这些 input 走「设置页裸值」形态且只有 26px 高，
125% 字号时 16.25px 的字几乎顶满行框。

## 二、AI 卡片照 Nephele 的框改（参考实现）

参考 `NepheleWorkshop/gui/qml/components/NepheleTextField.qml`（与 `Theme.qml:678 radiusInput: 12`）：

| Nephele（QML） | 本仓库（CSS / DOM） |
|---|---|
| `Layout.fillWidth: true`（每个输入框整行满宽） | 长值字段 `grid-column: 1 / -1`：Base URL、API Key 各占整行；供应商 / 模型 成对占第一行 |
| `cornerRadius: Theme.radiusInput` = 12 | `border-radius: 12px` |
| `background: Rectangle { color: bgColor; border.width: 1 }`（框体常驻） | `background: var(--control-bg) !important; border-color: var(--line) !important` |
| `leftPadding/rightPadding: 10`、`font.pixelSize: 12`（框比字大得多） | `padding: calc(6px × 文字缩放) calc(12px × 文字缩放)`、`min-height: calc(36px × 文字缩放)` |
| 聚焦时描边换 `fairyPurple` | 既有 `:focus` 已换 `--deep` + 3px focus-ring，未改 |

改后实测（同配置）：栅格 `497px 497px`；供应商 497×45、模型 446×45、**Base URL 1006×45**、
API Key 1006×45（全 radius 12、padding 7.5/15px）；Base URL：**373×26 → 1006×45**（宽 ×2.7、高 ×1.7）。

### 级联上的三个坑（都实测过）

1. **`border-radius` 必须带 `!important`** —— 全局控件规则（`styles.css:1871`）是
   `border-radius: 8px !important`，不带 `!important` 的 12px 会被它赢走（第一轮实测就是这个结果：
   `min-height`/`padding` 生效了、圆角仍是 8px）。
2. **要压过「设置页裸值」那条**：`styles.css:3229` 是 `background/border-color: transparent !important`，
   特异性 0,5,1 —— 新规则带上同一串 `:not([type=…])` 拿到 0,9,1 才赢。
3. **供应商下拉的特异性是 0,6,1**：`nephele-settings.css` 的规则带 `:root[data-nephele-settings]` 前缀，
   且该文件在 `styles.css` 之后加载。新规则补一个 `:not([hidden])` 到 0,7,1（只改尺寸与圆角，
   描边色继续由主题 / Nephele 风格决定 —— 不在这里改掉 `--nephele-edge`）。

## 三、设置页的「裸值」口径收窄回数字输入（用户第二条）

用户第二条指出：**只有输入数字才是「裸值 + 聚焦才显框」，其他都该是框**。仓库自己的变更记录
一直是这个口径，而 CSS 没有跟上：

| 版本 | 当时的约定 |
|---|---|
| `docs/CHANGELOG-v0.162.0.md:4` | 「文本、数字、时间、下拉选择和多行输入控件平时隐藏背景与描边」—— 当初就是这样写宽的 |
| `docs/CHANGELOG-v0.167.1.md:4` | 「设置页的**数字输入**在未编辑时保持透明底色、无可见边框」—— 口径已收窄到数字 |

但 `styles.css:3229` 的选择器仍写着 `input:not([type="checkbox"]):not([type="radio"])…`，
把设置页**所有**文本 / URL / 密码 / 搜索 / 多行输入都吃掉。逐分区真渲染扫描（1280×900、
nephele 风格 + 暮光紫深色 + 文字大小 125%）实测：

```
改前：非数字却透明的输入框 = 27 个（可选同步 6 + 全局快捷键 20 + 插件管理 1）
      数字 / 时间仍是裸值 = 8 个（预估时长 / 截止时刻 / 界面缩放 / 提前预警 / 保留数量 / 局域网端口…）
改后：非数字却透明 = 0；数字 / 时间仍是裸值 = 8（原封不动）
```

改动就是那条规则的选择器本身：

```css
/* 改前 */ .set-wrap .settings-section :is(input:not([type=checkbox]):not([type=radio])…, textarea)
/* 改后 */ .set-wrap .settings-section :is(input[type="number"], input[type="time"])
```

连带修好的一处：`.plugin-search-input`（`styles.css:2082` 自带 `border: 1px solid var(--line)` +
`background: var(--panel)`）本来被这条规则压成透明，插件管理页的搜索框一直是「隐形」的，现在
恢复成它自己设计的 715×36 框体。数字 / 时间框保留 `background/border-color: transparent !important`，
是为了压过全局那条 `--control-bg !important`（Nephele 把数字与时间当右对齐的「值」看，
见 `docs/CHANGELOG-v0.163.8.md:4`），聚焦时照旧显出输入框 + 3px 焦点环。

## 四、验证

- **几何（真 CSS 真视口）**：1280×900 与 390×844、`nephele on/off`、文字大小 100% / 125%
  全部跑过；横向溢出恒为 0，逐元素越界检查只在设置分类横向滚动条内部命中（与本次改动无关）。
- **全设置页扫描**：14 个分区逐个点开、量每个 `input / select / textarea` 的
  `backgroundColor / borderTopColor / 尺寸`，按「非数字却透明」计数（见第三节的表）。
- **AI 卡片改前 / 改后对照图**：`output/preview/ai-baseurl-compare-1280.png`（改前 / 改后 / 备选读法
  三带叠放），单张 `ai-baseurl-before-1280.png`、`ai-baseurl-after-1280.png`、`ai-baseurl-after-390.png`。
  改前那一版由探针注入样式**复现**原形态（真渲染数值与原版逐项一致：621/373、38/26、pad 0）。
- **设置页框体改前 / 改后对照图**：`output/preview/settings-inputs-compare-1280.png`
  （差异像素 78,876，集中在可选同步的表单带），单张 `settings-inputs-before-1280.png` /
  `settings-inputs-after-1280.png`。
- **回归守卫**：
  - `scripts/test-v0116-ai.mjs` 增 8 组断言（字段顺序、`ai-base-field` 整行、栅格等宽两列且不许出现
    `1.25fr/.75fr`、输入框 `min-height: calc(36px × var(--ui-text-scale, 1))`、`border-radius: 12px
    !important`、常驻背景、模型箭钮等高）→ **变异测试 8/8**。
  - 新增 `scripts/test-settings-control-boxes.mjs`（设置页框体契约：裸值只许匹配数字 / 时间、
    不许再吃 textarea / select 或宽口径 input、透明必须是 `!important`、聚焦要留焦点环、
    全局控件规则要覆盖 `input/select/textarea`）→ **变异测试 5/5**（含「写回宽口径」
    「连 select 一起吃掉」「去掉焦点环」）。

## 五、影响面

- 桌面 / Android 设置页：可选同步（6 个输入框）、全局快捷键（20 个输入框）、插件管理（搜索框）
  从「透明裸值」恢复成常驻框体；数字 / 时间输入框与其它分区外观不变。AI 与自动任务卡片的字段
  改为整行满宽 + Nephele 尺寸框体。其它视图不受影响。
- 小程序：设置页不在小程序端，不涉及。
- 数据迁移：无（未动存储键、未动 `ai_vault_*` 命令与凭据）。
- 已知边界：`input[type="time"]` 与数字一样按「值」处理（保留裸值 + 聚焦显框）。若只想留纯数字、
  让时间也带框，把第三节那条选择器里的 `, input[type="time"]` 去掉即可（守卫断言要同步改）。
