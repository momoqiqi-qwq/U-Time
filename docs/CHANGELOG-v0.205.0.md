# v0.205.0 · 输入区瘦身：档位栏改成向上浮层，上面的对话不再被顶掉

> 本次改动（实测输出）：
>
> - `node ../tools/sync-version.js --check` → `✓ 三端版本一致：v0.205.0`
> - `node ../tools/gen-theme-dark.js --check` → `✓ 派生调色板已同步（15 套深色变体）`
> - `node ../tools/build-schedule-plugin.js --check` → `✓ shiguang-schedule 生成物与源一致`
> - `node ../tools/sync-plugins.js --check` → `✓ 插件生成物与清单同源（--check 未写盘）：18 个内置插件`
> - `node ../tools/sync-android-native.js --check` → `✓ Android 原生代码与版本化镜像一致`
> - `npm test` → `PASS: 129 个测试脚本全部通过`
>
> 动的文件：`public/plugins/ai-chat/main.js`、`scripts/test-ai-chat.mjs`、`package.json`（0.204.0 → 0.205.0，三端已同步、`package-lock.json` 两处已手改）。

## 用户要求原文

> 这2个按钮弄成到对话框那里去，思考强度弄成下拉栏记得动画

> 让对话拥有更大的空间或者让对话更小或者2个一起，不然看不到上面的对话

（第一条是 v0.204.0 已完成的部分；本条是它的续集：**两颗胶囊进了输入区之后，输入区还是太高、档位栏一展开就把上面对话挤走**。）

## 一、问题不在「收起态高」，在「展开就长高」

v0.204.0 把档位栏做成了输入区里的**普通折叠块**（`display:grid; grid-template-rows:0fr → 1fr`）。它在收起时不占高度，但一展开就**把 `.aichat-bar` 撑高 139px**，而消息流（`.aichat-log`，`flex:1`）只能被压——用户看到的就是「一打开档位，上面的对话就往上跑、看不见了」。

光把收起态的 padding 抠掉几个像素没用：**高度是展开时花掉的**。所以这次两件事一起做：

1. 输入区整体瘦身（收起态从 148px 量级压到 84.32px，桌面 1300 宽实测）；
2. 档位栏从「撑开输入区的折叠块」改成「浮在输入区上方的浮层」，展开时输入区高度**一点不变**。

## 二、输入区瘦身

| | 改前（v0.204.0） | 改后 |
|---|---|---|
| 结构 | 档位栏（折叠块）+ 输入框 + 控件行，三段纵向堆 | 控件行（胶囊左 / 工具右）+ 输入框，两段 |
| 垂直 padding / gap | `16px 2px 2px` / 12px | `8px 2px 0` / 6px |
| 桌面收起态输入区高 | ~148px | **84.32px** |
| 展开档位时消息流高度变化 | −139px（对话被顶掉） | **0** |

关键 CSS：

```css
.aichat-bar{position:relative;display:flex;flex-direction:column;align-items:stretch;gap:6px;flex:none;padding:8px 2px 0;border:0;border-radius:0;border-top:1px solid #c9acd32e;background:transparent;box-shadow:none}
.aichat-compose-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.aichat-compose-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:1 1 auto;min-width:0}
.aichat-compose-tools{display:flex;align-items:center;gap:8px;flex:none;min-width:0;margin-left:auto}
```

`.aichat-bar` 自己当浮层的定位祖先（`position:relative`）—— 这是**唯一**需要的改动，插件页面里没有别的定位上下文可用。

顺序也调了：**先输入框、后控件行**（`ta_before_chips` 实测为 1）。理由是「写字」是主动作，按钮是被动动作；一行按钮压在输入框下面，视觉重量落在最下方，正好贴着对话框底边。

## 三、档位栏改向上浮层

```css
.aichat-effort-menu{position:absolute;z-index:9;left:0;right:0;bottom:calc(100% + 6px);isolation:isolate;display:grid;grid-template-rows:0fr;opacity:0;pointer-events:none;transform:translateY(6px);transition:grid-template-rows 260ms cubic-bezier(.22,1,.36,1),opacity 220ms ease,transform 260ms cubic-bezier(.22,1,.36,1)}
.aichat-effort-menu.open{grid-template-rows:1fr;opacity:1;pointer-events:auto;transform:none}
```

- **仍然保留 0fr → 1fr 的连续插值**（铁律七）：只是容器不再占输入区的布局高度。中间帧实测 130ms 时高度 143.13px（终态 148.8px），opacity 与箭头同时在插值。
- 收起时 `pointer-events:none` + `inert` + `aria-hidden`，`transform:translateY(6px)` 让收起方向也是「往下缩回去」而不是瞬间消失。
- 浮层底边 `calc(100% + 6px)`（实测间隙 4.96px，差的那 1px 是 `.aichat-bar` 的顶边分隔线），窄屏 390 下同样落在视口内（`menu_inside_view=1`）。

**为什么不做成系统原生 select**：铁律七写得很清楚——原生下拉的展开/收起动画不可控，双向动画会丢一半。

## 四、窄屏（390px）顺手修掉的几处

1. **横向溢出（真 bug，非本次引入）**：`.aichat-shortcuts` 原本是 `flex:none`，即按内容宽度排布；手机上它比容器宽，直接把文档撑出横向滚动（实测 `documentElement.scrollWidth=433 > 390`）。改成 `flex:0 1 auto;min-width:0` 后由它自己的 `overflow-x:auto` 接管横滚（`h_scroll=0`）。
2. **窄屏紧凑**：按钮行 gap 收到 6px/4px，档位说明（`small`）收掉只留档位名，并给快捷条一个右缘渐隐（`mask-image`），让「还能往右划」有视觉暗示——否则最后一颗按钮被切成半个，看着像坏了。

```css
@media (max-width:640px){.aichat-compose-row{gap:6px}.aichat-compose-chips{gap:4px}.aichat-compose-tools{gap:6px}.aichat-shortcuts{mask-image:linear-gradient(90deg,#000 calc(100% - 18px),transparent);-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 18px),transparent)}.aichat-lv{padding:7px 8px}.aichat-lv small{display:none}}
```

3. **输入框提示被裁半行（真 bug，非本次引入）**：`textarea` 是 `min-height:34px`、`line-height:1.6`、`font-size:15px`，一行 24px + `padding:3px 0` 刚好塞满，于是窄屏下空态提示折成第二行时下半截字被裁掉。给占位符加单行截断：

```css
.aichat-input::placeholder{color:#bca9cf;opacity:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
```

实测 390 宽下提示恢复整齐一行（「还没配置模型 —— 先写也行，点发送会带你去配置」完整可读）。

## 五、没动的东西（避免踩回归）

- `reasoningEffort` 链路、`THINK_LEVELS` 四档、`THINK_KEY` 落盘键、键盘/Esc/点外部收起、`aria-expanded` / `aria-hidden` / `inert`——全部保持 v0.204.0 的行为，只换了档位栏的**定位方式**与输入区的**排版**。
- 滑动选中光仍然挂在 `ui.thinkMenu` 上（`THINK_ON = "button.aichat-lv.on"`），换档后重新展开光块精确落在该行（实测 `glow_vs_opt_offset=0`）。
- 没有数据迁移、没有宿主 API 变更。

## 六、测试改动（`scripts/test-ai-chat.mjs`）

- `.aichat-bar` 串断言改为新串（含 `position:relative` 与收紧后的 `gap`/`padding`）。
- 新增顺序断言：`<div class="aichat-bar">` < `.aichat-compose-row` < `<textarea class="aichat-input"`。
- `.aichat-compose-chips` 断言补上 `flex:1 1 auto`；窄屏媒体查询断言改为新整串（含渐隐）。
- 档位栏断言从「折叠块」改成「浮层」：`position:absolute`、`bottom:calc(100% + 6px)`、收起 `pointer-events:none`、`transform:translateY(6px)`。

## 七、验证（真应用 + 真插件，无头 Chrome 探针）

探针页挂在 vite dev（`localhost:1420`）里，iframe 载入真外壳 `index.html`，点开 AI 对话插件后量几何量。

```
桌面 1300 收起/展开：closed_bar_h=84.32 | open_bar_h=84.32 | open_menu_h=164.67
                      log_gain_on_open=0     ← 展开档位不再吃对话高度
                      menu_gap=4.96 | menu_inside_view=1
展开过渡（130ms 定格）：transitions_seen=3 | mid_menu_h=143.13 → end_menu_h=148.8
                      箭头 rotate(45deg) → rotate(-135deg)
换档后重新展开：      on_index=3 | glow_style_top=122px | glow_vs_opt_offset=0
手机 390：            h_scroll=0 | closed_bar_h=111.1 | log_gain_on_open=0 | menu_inside_view=1
```

`log_gain_on_open=0` 是本轮的核心验收项：**展开档位栏时消息流高度零变化**。

## 八、验证命令

```bash
cd le-time-management
node ../tools/sync-version.js --check
node ../tools/gen-theme-dark.js --check
node ../tools/build-schedule-plugin.js --check
node ../tools/sync-plugins.js --check
node ../tools/sync-android-native.js --check
npm test
```

> 升版本后 `sync-android-native.js --check` 会先红一次：`sync-version.js` 改了 `src-tauri/tauri.conf.json` 的 version，而 `src-tauri/gen/android/app/src/main/assets/tauri.conf.json` 是它的镜像副本。跑一次不带 `--check` 的同步命令即可，别当异常。

---

**一句话**：档位栏从「撑开输入区的折叠块」变成「浮在输入区上方的浮层」，输入区自身从 148px 收到 84px——展开档位时上面对话一行都不动。
