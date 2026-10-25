# Le时间管理插件图标说明

> 适用：Le时间管理 **v0.27.0+**（主导航随包化自 **v0.42.0**）｜ 对应源码：`src/icons.js`、`src/pluginAppearance.js`、`public/icons/plugins/`、`public/icons/nav/`、`public/icons/fontawesome/`
> v0.27.0 起内置插件图标换成 **Icons8 / iGoutu 的 Color 彩色风格**（来源图标集「标志 · 色版」），随包 PNG；
> **v0.42.0 起主导航 6 个图标也随包化成同一套 Color 风格**（此前走 iOS Filled CDN 直链，离线即裂）。

---

## 一、图标来源（一套 Color 风格，两条随包线路）

| 用途 | 风格 | 落地方式 | 出处 |
|---|---|---|---|
| 主导航：四象限 / 时间块 / 收件箱 / 插件 / 设置 / 快速捕获 | **Color 彩色** | **随包 PNG**：`public/icons/nav/<key>.png` | `tools/gen-plugin-icons.py` → `NAV_ICONS` |
| 12 个内置插件 | **Color 彩色**（`wechat-push` 用 3D 微信标志） | **随包 PNG**：`public/icons/plugins/<插件ID>.png` | `tools/gen-plugin-icons.py` → `ICONS` |
| 未知 key（用户插件 / 外部插件） | Color 彩色 | CDN 回落：`img.icons8.com/color/96/<slug>.png` | `src/icons.js` → `PLUGIN_ICONS8` |

要点：

- **随包 PNG 优先，CDN 只做回落**（离线可用、色彩可控）。
- 插件图标的 key 就是**插件 ID**（不是 manifest 里的 `icon` 字段）——`appIcon(pluginId)`；
  主导航的 key 是 `quadrant / timeblock / inbox / market / settings / capture`——`appIcon(key)`。
- 主导航不再需要强调色染色（旧 iOS Filled 时代的 `ICON_COLORS` 已随随包化删除）；
  插件图标不做灰度与透明度压缩（`.plugin-present-icon` 强制 `opacity: 1`）。

---

## 二、`src/icons.js` 的解析规则

```js
const NAV_ICONS8    = { quadrant: ["four-squares", "grid-2", "grid"], timeblock: ["clock", "clock--v1"], inbox: ["inbox", "filled-in-box"],
                        market: ["puzzle", "puzzle-piece"], settings: ["settings", "gear"], capture: ["inbox", "filled-in-box"] };
const PLUGIN_ICONS8 = { "shiguang-schedule": ["timetable", "calendar"], pomodoro: ["tomato", "hourglass"], /* … */ };
const ICONS8        = { ...NAV_ICONS8, ...PLUGIN_ICONS8 };

appIcon(key)  →
  manifestIcon = MANIFEST_ICON_KEYS[key]                  // 命中内置插件 → /icons/plugins/<key>.png
  isNav        = Boolean(NAV_ICONS8[key])                 // 命中主导航 → /icons/nav/<key>.png
  bundledDir   = manifestIcon ? "plugins" : isNav ? "nav" : null   // 都没命中 → 直接 CDN
  candidates   = manifestIcon ? [manifestIcon, ...ICONS8[key]] : (ICONS8[key] || ICONS8.market)
```

逐条：

1. **随包优先**：命中插件或主导航 key 时先读 `/icons/<plugins|nav>/<key>.png`，加载失败才逐个试 CDN 候选。
2. **候选数组**：同一个语义允许写 1–2 个 slug，第 1 个 404 自动试第 2 个（`quadrant` 的生效 slug 是 `four-squares`，`grid-2` 在 Color 风格下 404）。
3. **逐级回退**：候选耗尽 → 回落 `ICONS8.market[0]`（`puzzle`，彩色拼图）；连它都失败 → `visibility: hidden`，**不出现裂图**。
4. **输出标签**：`<img class="app-icon icons8-app-icon">`，`data-icon-source` 取值 `bundled plugin PNG (Icons8 Color)` / `bundled nav PNG (Icons8 Color)` / `Icons8 Color`，`data-icon-key` 便于在 DevTools 里核对解析结果。

---

## 三、key → 图标映射

### 主导航（`NAV_ICONS8`，Color 彩色；随包 PNG 与 slug 一一对应）

| key | 随包 PNG | 生效 slug | 图形 |
|---|---|---|---|
| quadrant | ✅ | `four-squares`（候选 `grid-2`/`grid` 在 Color 风格下 404） | 四个圆角方块 |
| timeblock | ✅ | `clock` | 时钟 |
| inbox | ✅ | `inbox` | 收件托盘 |
| market | ✅ | `puzzle`（**同时是所有未知 key 的兜底**） | 拼图 |
| settings | ✅ | `settings` | 齿轮 |
| capture | ✅ | `inbox`（与收件箱同形，刻意为之） | 收件托盘 |

### 内置插件（`PLUGIN_ICONS8`，Color 彩色；随包 PNG 与 slug 一一对应）

| 插件 ID | 随包 PNG | CDN 风格 / slug | 图形 |
|---|---|---|---|
| `plugin-guide` | ✅ | color `help` → `question-mark` | 蓝色问号 |
| `pomodoro` | ✅ | color `tomato` → `hourglass` | 番茄 |
| `cppu-notify` | ✅ | color `university` → `school-building` | 柱廊建筑 |
| `gx-news` | ✅ | color `trophy` | 金色奖杯 |
| `exam-calendar` | ✅ | color `test-passed` → `calendar-plus` | 考核清单 |
| `shiguang-schedule` | ✅ | color `timetable` → `calendar` | 日历 + 时钟 |
| `web-collector` | ✅ | color `bookmark-ribbon` → `bookmark` | 红色书签 |
| `wechat-push` | ✅（**3d-fluency** 风格） | color `speech-bubble` → `chat`（Color 风格没有微信标志） | 微信标志 |
| `chaoxing-notify` | ✅ | color `books` → `graduation-cap` | 一摞书 |
| `school-notice` | ✅ | color `school` → `classroom` | 校舍 |
| `cn-holiday` | ✅ | color `lantern` → `calendar` | 中式灯笼 |
| `weekly-report` | ✅ | color `statistics` → `combo-chart--v1` | 数据看板 |

> 完整来源台账（slug / sha256 / 消费方 / 许可）见 **`public/icons/plugins/ATTRIBUTION.md`**（由生成脚本写出，不要手改）。

---

## 四、换一个插件的图标（3 步）

**1. 找图标**

打开 <https://igoutu.cn/icons/set/标志--style-color>（或 <https://igoutu.cn/icons/color>），挑一个 **Color** 风格的图标，从 CDN 地址里取 slug：

```
https://img.icons8.com/color/96/tomato.png
                                ^^^^^^ 这就是 slug
```

**2. 登记映射并重新生成**

```bash
# 编辑 tools/gen-plugin-icons.py 的 ICONS：
#   "my-plugin": ("color", "tomato", "番茄专注 / 番茄"),
"$USERPROFILE/.workbuddy/binaries/python/envs/default/Scripts/python.exe" tools/gen-plugin-icons.py
```

脚本会一次写完四处：`le-time-management/public/icons/plugins/<id>.png`、同名台账 `ATTRIBUTION.md`、`miniprogram/images/plugins/<id>.png`，外加主导航 `public/icons/nav/*.png` 与其台账（由脚本里的 `NAV_ICONS` 清单驱动）。
然后把 slug 同步进 `src/icons.js` 的 `PLUGIN_ICONS8` / `NAV_ICONS8`（做 CDN 回落与外部插件兜底）。

**3. 看一眼**：`npm run tauri dev` → 侧栏「插件视图」、插件中心卡片、设置 → 插件，三处确认无裂图、无拼图兜底。

> 没有随包 PNG 的新插件也能显示——只要 ID 在 `PLUGIN_ICONS8` 里，就会走 CDN。
> **ID 不在任何映射里 → 永远显示彩色拼图兜底。**

---

## 五、渲染尺寸与样式（`src/styles.css`）

| 位置 | 选择器 | 显示尺寸 | 容器 |
|---|---|---|---|
| 默认（`appIcon` 通用） | `.app-icon` | 30 × 30 | 行内，`object-fit: contain` |
| ~~顶栏标题~~ | ~~`.topbar-title-mark .app-icon`~~ | — | **已删**（v0.38.2：顶栏不再有那颗 42×42 小框，标题直接写在顶栏内） |
| 侧栏导航 | `.nav button .ic` / `.nav button .ic .app-icon` | 30 × 30（方块 38 × 38） | 圆角 11px |
| 插件中心卡片 | `.mcard .mi .app-icon` | 40 × 40 | 卡片 `.mi` 38 × 38，底色由 `--plugin-accent` 混出 |
| 设置页插件列表 | `.plug-ic .app-icon` | 40 × 40 | 同上 |
| 窄屏（≤760px）侧栏 | `.nav button .ic .app-icon` | 22 × 22 | 紧凑 |

- 插件入口的底板用 `--plugin-accent`（`pluginAppearance.js` 按插件 ID 哈希出的 8 色调色板）：`.nav .plug-list button .ic`、`.market-card-head .mi`、`.plug-card .plug-ic` 都是 `color-mix(--plugin-accent 13%, --panel)` + 内描边，浅色/夜间主题自动适配。
- `.plugin-present-icon { filter: none !important; opacity: 1 !important; }` —— 插件图标不做灰度与透明度压缩（这条在 `styles.css` 后段，能压过前面的 `.icons8-app-icon { opacity: .9 }`）。
- 随包 PNG 是 **81 × 81 画布、图形最长边 58px**，`object-fit: contain` 缩放到目标尺寸；**为 22px 渲染做设计**，选图标时优先挑轮廓粗、负空间大的。

---

## 六、小程序（`miniprogram/images/`）

| 输出 | 来源 | 消费方 |
|---|---|---|
| `images/tab/<name>{,-on}.png` | `miniprogram/tools/sync-tab-icons.py` 从 `public/icons/fontawesome/solid.svg` 渲染（常态 `#8A979E`、选中 `#0F4C5C`） | `app.json` 的 `tabBar.list[].iconPath` / `selectedIconPath` |
| `images/plugins/<id>.png` | **直接复制** `le-time-management/public/icons/plugins/<id>.png`（同一份彩色素材，字节一致） | `pages/plugins/index.js`、`pages/plugin/index.js` 拼 `/images/plugins/${id}.png` |

重新生成：`python miniprogram/tools/sync-tab-icons.py`（需要 `Pillow` + `cairosvg`；tab 图标仍需 `cairosvg`，插件图标只做复制）。

- 插件彩色素材缺失时脚本会退回 FA 单色渲染并打印插件 ID —— 看到那行提示就去 `tools/gen-plugin-icons.py` 的 `ICONS` 补映射。
- tab 图标仍是单色成对（灰 / 深青），这是 tabBar 的设计要求，不跟随插件图标的彩色化。

> ⚠️ **别运行根目录 `tools/sync-tab-icons.py` / `tools/fetch-ui-icons.py` / `tools/gen-miniprogram-tab-icons.js`**：
> 那是已废弃的 Magnific 彩色方案，读的是早就删除的 `public/icons/<name>.png`，跑起来只会报错或写出不一致的 tab 图标（见第九节）。

---

## 七、授权与署名（硬性要求）

| 资源 | 授权 | 署名位置 |
|---|---|---|
| 主导航图标（6 个随包） | Icons8 / iGoutu · Color | 设置 → 关于（`src/aboutData.js`），链接 <https://igoutu.cn/icons/set/标志--style-color>；`public/icons/nav/ATTRIBUTION.md` |
| 内置插件图标（12 个） | Icons8 / iGoutu · Color（`wechat-push` 为 3D 风格） | 同上 + `public/icons/plugins/ATTRIBUTION.md` |
| 小程序 tabBar 图标 / 插件图标兜底 | Font Awesome Free（Icons: CC BY 4.0） | 设置 → 关于；`public/icons/fontawesome/ATTRIBUTION.md`、`LICENSE.txt` |

红线：素材遵循原作者与平台许可，**不得把素材作为独立图标库转售**；二次分发本项目时保留 `ATTRIBUTION.md` 与设置页署名。

---

## 八、已知缺口（可直接当作待办）

| 缺口 | 表现 | 修法 |
|---|---|---|
| `manifest.json` 的 `icon` / `faIcon` 是死元数据 | 桌面端不读，改了没效果（只有小程序兜底渲染会用） | 保持现状即可；真要清理需三端一起动 |
| Color 风格没有微信标志 | `wechat-push` 只能用 3D 风格，是 12 个图标里唯一风格不同的 | 已在 `ATTRIBUTION.md` 注明；如介意可换成 `color/speech-bubble` |
| 根 `tools/` 三个 Magnific 脚本是死代码 | 读的是已删除的 `public/icons/*.png`，运行即报错 | 删除 `tools/fetch-ui-icons.py`、`tools/sync-tab-icons.py`、`tools/gen-miniprogram-tab-icons.js` |
| `miniprogram/images/plugins/elder-care.png` 是历史残留 | 长辈照护在 v0.11.6 已移除，没有插件再用它 | 直接删 |
| 图标生成脚本未进 npm scripts | 换图标要手敲 python 路径 | 在 `package.json` 加 `icons:plugins` 脚本指向 `tools/gen-plugin-icons.py` |

---

## 九、提交前自检清单

- [ ] 新插件的彩色素材已生成：`public/icons/plugins/<id>.png` 存在且**不是** FA 单色（`tools/gen-plugin-icons.py --check` 全 OK，主导航 6 个 PNG 同一批校验）
- [ ] 换过导航图标时：`src/icons.js` 的 `NAV_ICONS8` 首选 slug 与 `public/icons/nav/ATTRIBUTION.md` 的「生效 slug」一致
- [ ] `src/icons.js` 的 `PLUGIN_ICONS8` 里有对应 ID（否则用户插件/离线回落变成拼图）
- [ ] 小程序副本字节一致：`le-time-management/public/icons/plugins/<id>.png` ≡ `miniprogram/images/plugins/<id>.png`
- [ ] 22px（窄屏侧栏）与 30px（桌面侧栏）下图形都可辨认，浅色 / 夜间两套主题都不糊
- [ ] `ATTRIBUTION.md` 已重新生成，且设置 → 关于的署名条目仍指向图标集入口
- [ ] 改了 `public/` → **按 AGENTS.md 铁律一升版本号**（`package.json` → `tools/sync-version.js` → 补 `package-lock.json` 两处 → `--check` 通过）
