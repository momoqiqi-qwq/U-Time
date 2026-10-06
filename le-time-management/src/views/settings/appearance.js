import * as S from "../../store.js";
import { el, toast } from "../../ui.js";
import { THEMES, getThemeMode, resolveThemeMode, setTheme, setThemeMode } from "../../theme.js";
import {
  DEFAULT_UI_PREFERENCES,
  NAVBAR_SIZE_OPTIONS,
  NAV_WIDTH_LIMITS,
  NAV_TRANSPARENCY_LIMITS,
  STARTUP_VIEW_OPTIONS,
  TEXT_SCALE_LIMITS,
  WINDOW_SIZE_OPTIONS,
  coreViewIds,
  getUiPreferences,
  resetUiPreferences,
  setUiPreferences,
} from "../../uiPreferences.js";
import { CUSTOM_SIZE_LIMITS, applyWindowSize, isDesktopRuntime, windowSizeHint } from "../../windowSize.js";
import { navDisplayName } from "../../navAppearance.js";
import { NARROW_REFERENCE_WIDTH, UI_SCALE_LIMITS, UI_SCALE_PRESETS, dragStableScale, getAutoScaleFactor, normalizeUiScale, parseCustomScaleInput } from "../../uiScale.js";
import { toggleSwitch } from "../../switchControl.js";

/* 开关行：左侧只有名称，右侧一个滑块开关（说明文字已按要求全部去掉，见 v0.37.19）。 */
function toggleRow(label, checked, onChange) {
  return el("div", { class: "setting-row" },
    el("span", { class: "setting-copy" }, el("b", {}, label)),
    toggleSwitch({ checked, onChange, ariaLabel: label }),
  );
}

export function createInterfaceCard({ rerender = () => {} } = {}) {
  const prefs = getUiPreferences();
  const settings = S.getState().settings;
  const densityBox = el("div", { class: "pref-choice", role: "group", "aria-label": "界面密度" });
  for (const [id, label] of [["comfortable", "舒适"], ["compact", "紧凑"]]) {
    densityBox.append(el("button", {
      class: `pref-choice-btn${prefs.density === id ? " on" : ""}`,
      onclick: () => { setUiPreferences({ density: id }); rerender(); },
    }, label));
  }

  // 手机底栏高度：紧凑 / 标准 / 宽松（只影响 ≤900px 的底部导航栏，桌面端无感）
  const navBarBox = el("div", { class: "pref-choice", role: "group", "aria-label": "底栏高度" });
  for (const [id, label] of NAVBAR_SIZE_OPTIONS) {
    navBarBox.append(el("button", {
      class: `pref-choice-btn${prefs.navBarSize === id ? " on" : ""}`,
      onclick: () => { setUiPreferences({ navBarSize: id }); rerender(); },
    }, label));
  }
  // v0.108.0：底栏形态 —— 悬浮玻璃（默认，四周留缝浮起）/ 贴底（通宽压平）；
  // 材质 —— 毛玻璃（默认）/ 实色（低端机关掉实时模糊换流畅）。
  const navDockBox = el("div", { class: "pref-choice", role: "group", "aria-label": "底栏形态" });
  for (const [id, label] of [["float", "悬浮玻璃"], ["docked", "贴底"]]) {
    navDockBox.append(el("button", {
      class: `pref-choice-btn${prefs.navDock === id ? " on" : ""}`,
      onclick: () => { setUiPreferences({ navDock: id }); rerender(); },
    }, label));
  }
  const navGlassBox = el("div", { class: "pref-choice", role: "group", "aria-label": "底栏材质" });
  for (const [id, label] of [["frosted", "毛玻璃"], ["solid", "实色"]]) {
    navGlassBox.append(el("button", {
      class: `pref-choice-btn${prefs.navGlass === id ? " on" : ""}`,
      onclick: () => { setUiPreferences({ navGlass: id }); rerender(); },
    }, label));
  }
  const navRange = (key, label, limits) => {
    const input = el("input", { type: "range", min: String(limits.min), max: String(limits.max), step: String(limits.step), value: String(prefs[key]), "aria-label": label });
    const output = el("output", {}, `${prefs[key]}%`);
    input.addEventListener("input", () => {
      output.textContent = `${input.value}%`;
      setUiPreferences({ [key]: Number(input.value) }, { persist: false });
    });
    input.addEventListener("change", () => setUiPreferences({ [key]: Number(input.value) }));
    return el("span", { class: "pref-range" }, input, output);
  };
  const navWidthRange = navRange("navWidth", "底栏宽度", NAV_WIDTH_LIMITS);
  const navTransparencyRange = navRange("navTransparency", "底栏透明度", NAV_TRANSPARENCY_LIMITS);
  // v0.110.0：悬浮键（‹ 返回 / ⋮ 菜单）垂直档位；互换用开关。
  const fabHeightBox = el("div", { class: "pref-choice", role: "group", "aria-label": "悬浮键高度" });
  for (const [id, label] of [[35, "偏低"], [45, "居中"], [55, "偏高"]]) {
    fabHeightBox.append(el("button", {
      class: `pref-choice-btn${prefs.fabHeight === id ? " on" : ""}`,
      onclick: () => { setUiPreferences({ fabHeight: id }); rerender(); },
    }, label));
  }

  // 「文字大小」80%~150%（TEXT_SCALE_LIMITS 单一事实源）：作用于**全部文字** ——
  // styles.css 与各插件样式里的每一条 font-size 都乘了 --ui-text-scale（守卫：test-text-scale.mjs）。
  const textScale = el("input", {
    type: "range",
    min: String(TEXT_SCALE_LIMITS.min),
    max: String(TEXT_SCALE_LIMITS.max),
    step: String(TEXT_SCALE_LIMITS.step),
    value: String(prefs.textScale),
  });
  const textScaleOut = el("output", {}, `${prefs.textScale}%`);
  textScale.addEventListener("input", () => {
    textScaleOut.textContent = `${textScale.value}%`;
    setUiPreferences({ textScale: Number(textScale.value) }, { persist: false });
  });
  textScale.addEventListener("change", () => setUiPreferences({ textScale: Number(textScale.value) }));

  /* ── 界面缩放（80%~150%）──
     与上面「文字大小」分工不同：文字大小只放大缩小**文字**（全部 font-size 都乘
     --ui-text-scale，控件/间距/图标不动）；界面缩放走 documentElement 的 `zoom`，
     整页等比放大缩小 —— 手机上「整个界面太小」才是主要诉求，光放大字解决不了。
     两个实现坑（fixed 浮层要走 --ui-vw/--ui-vh、100vw/100vh 不能用）见 src/uiScale.js 头部注释。

     与「启动窗口大小」的区别也说清：那个是**桌面端调整窗口**，这个是**调整窗口里的内容**，
     手机上后者才是唯一可用的那个。

     ⚠️ 边界（别在文案里许下做不到的承诺）：缩放**不改变布局断点**。
     媒体查询按真实窗口宽度判定，`zoom` 与 `html { font-size }` 都影响不了它
     （实测见 src/uiScale.js）。所以放大到 150% 时桌面窗口不会自动变成手机布局，
     只是内容整体变大、可容纳的列数变少。 */
  const uiScale = el("input", {
    type: "range",
    min: String(UI_SCALE_LIMITS.min),
    max: String(UI_SCALE_LIMITS.max),
    step: String(UI_SCALE_LIMITS.step),
    value: String(prefs.uiScale),
    "aria-label": "界面缩放",
  });
  const uiScaleOut = el("output", {}, `${prefs.uiScale}%`);
  // WebKit range 轨道不会自动画已选区，按原生 input 值同步 CSS 进度；不拦截拖动/键盘事件。
  const updateRangeTrack = (range) => {
    const min = Number(range.min || 0);
    const max = Number(range.max || 100);
    const value = Number(range.value);
    const progress = Number.isFinite(value) && max > min ? ((value - min) / (max - min)) * 100 : 0;
    range.style.setProperty("--range-progress", `${Math.max(0, Math.min(100, progress))}%`);
  };
  updateRangeTrack(textScale);
  textScale.addEventListener("input", () => updateRangeTrack(textScale));

  /* ── 拖动稳定映射（v0.58.0）──
     input 直接改 zoom 会把整页（含滑杆轨道）按新系数立即重排：设置弹窗是 margin:auto
     居中的 fixed 浮层，轨道在指针下水平平移，浏览器下一次 pointermove 按**新几何**重算值
     → 值跳 → zoom 又变 —— 几何正反馈回路，实测拖动值在 80~125% 之间剧烈振荡
     （用户看到的「一闪一闪」，机理与实测数据见 src/uiScale.js 的 dragStableScale 一节）。
     解法：pointerdown 时冻结轨道几何，拖动期间按「按下瞬间的基准」做增量映射
     （纯函数 dragStableScale），轨道平移被增量数学吸收，回路断开。
     只包「界面缩放」滑杆：「文字大小」只改 font-size、轨道不动，没有这个问题。
     键盘方向键不产生 pointer 事件（无会话），input 走浏览器原生值，行为不变。 */
  let dragSession = null;
  uiScale.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    const rect = uiScale.getBoundingClientRect();
    dragSession = {
      pointerId: e.pointerId,
      x0: e.clientX,
      lastX: e.clientX,
      baseLeft: rect.left,
      baseWidth: rect.width,
      v0: null, // 等第一次 input：浏览器在 pointerdown 后把值跳到点击位置（点轨道跳转语义）
    };
  });
  window.addEventListener("pointermove", (e) => {
    // range input 拖动有隐式指针捕获，move 会冒泡到 window；只认同一个 pointerId，
    // 第二根手指 / 别的指针不干扰会话。
    if (dragSession && e.pointerId === dragSession.pointerId) dragSession.lastX = e.clientX;
  });
  const endDragSession = (e) => {
    if (dragSession && e.pointerId === dragSession.pointerId) dragSession = null;
  };
  window.addEventListener("pointerup", endDragSession);
  window.addEventListener("pointercancel", endDragSession);

  // 拖动时实时预览（persist:false），松手才落盘，避免拖动过程中每 5% 写一次盘。
  // 动画分工（v0.54.0）：input 拖动**直设不动画** —— 拖动本身就是连续输入，
  // 每一档立即生效才是「跟手」；动画留给离散入口（松手落定、点档位、界面预设），
  // 那些才会一步跨 20%+，不动画就是「一闪一闪」。
  uiScale.addEventListener("input", () => {
    if (dragSession) {
      // 第一次 input 的原生值（点轨道跳到点击位置 / 按住 thumb 的当前值）作增量基准 v0。
      if (dragSession.v0 === null) dragSession.v0 = Number(uiScale.value);
      // 用冻结几何把指针位移换算成缩放值并写回控件 —— 覆盖浏览器按漂移后几何算的原生值。
      uiScale.value = String(dragStableScale({
        v0: dragSession.v0,
        x0: dragSession.x0,
        x: dragSession.lastX,
        baseLeft: dragSession.baseLeft,
        baseWidth: dragSession.baseWidth,
      }));
    }
    uiScaleOut.textContent = `${uiScale.value}%`;
    setUiPreferences({ uiScale: Number(uiScale.value) }, { persist: false });
    paintScalePresets();
    paintCustomScale(); // 滑杆动了，自定义输入框要跟着变成「当前值的真实状态」
  });
  uiScale.addEventListener("change", () => {
    // 松手落定走动画：值通常与拖动末态相同（applyUiScale 内「值没变」短路）；
    // 拖到越界位置松手被夹回档位时，才有一次小幅平滑修正。
    const value = setUiPreferences({ uiScale: Number(uiScale.value) }, { animate: true }).uiScale;
    // 越界输入会被 normalize 夹回区间并对齐步进，写回控件让用户看到真实生效值。
    uiScale.value = String(value);
    uiScaleOut.textContent = `${value}%`;
    paintScalePresets();
    paintCustomScale();
  });
  // 放在缩放 input/change 处理器之后：先完成稳定拖动映射、再画已选轨道。
  uiScale.addEventListener("input", () => updateRangeTrack(uiScale));
  uiScale.addEventListener("change", () => updateRangeTrack(uiScale));

  // `.scale-presets` 只加「允许换行」：档位 4 个 + 自定义输入共 5 项，
  // 极窄屏（窄屏自适应把布局宽压到 288 那种）宁可换行也不许横向溢出。
  const scalePresetBox = el("div", { class: "pref-choice scale-presets", role: "group", "aria-label": "界面缩放档位" });
  const scalePresetButtons = [];
  const paintScalePresets = () => {
    for (const [button, value] of scalePresetButtons) {
      button.classList.toggle("on", value === Number(uiScale.value));
    }
  };
  for (const [value, label] of UI_SCALE_PRESETS) {
    const button = el("button", {
      class: `pref-choice-btn${prefs.uiScale === value ? " on" : ""}`,
      type: "button",
      // 档位按钮与滑块是同一个值的两个视图，点档位就等于把滑块拖过去。
      // 点档位是一步跨 20%~70% 的离散跳变，必须走动画（v0.54.0），否则整页「闪一下」。
      onclick: () => {
        uiScale.value = String(value);
        updateRangeTrack(uiScale);
        setUiPreferences({ uiScale: value }, { animate: true });
        uiScaleOut.textContent = `${value}%`;
        paintScalePresets();
        paintCustomScale(); // 命中档位 ⇒ 输入框留空，不重复显示同一个状态
      },
    }, label);
    scalePresetButtons.push([button, value]);
    scalePresetBox.append(button);
  }
  paintScalePresets();

  /* ── 自定义缩放值（与 4 个固定档位同排）──
     4 个档位只覆盖常用值，110% / 135% 这类中间值此前只能靠滑杆一点点拖。
     这里给一个直接输入数字的入口，就放在档位组末尾（用户要求：固定档位在滑块下面，
     自定义也跟在这一排）。

     三条契约（每条都对应一个真实会出问题的地方）：
     - **输入途中只预览「落在区间内」的值**：敲「1」（打算输 120）时若照单应用会被
       `normalizeUiScale` 夹成 80%，界面在打字过程中乱跳 —— 半截输入与越界值都不预览。
     - **落定（回车 / 失焦）才夹取并落盘**：越界值此时照常接住（夹到边界），
       再把真实生效值写回输入框 —— 与滑杆松手夹取同一行为，不丢用户的输入。
     - **命中档位时输入框留空**（placeholder「自定义」），非档位值才填数字并高亮 ——
       否则「标准」高亮着、输入框里又写着 100，同一个状态显示两遍。 */
  const customScale = el("input", {
    type: "number",
    class: "pref-choice-input",
    min: String(UI_SCALE_LIMITS.min),
    max: String(UI_SCALE_LIMITS.max),
    step: String(UI_SCALE_LIMITS.step),
    inputmode: "numeric",
    placeholder: "自定义",
    "aria-label": "自定义界面缩放百分比",
  });
  const isPresetScale = (value) => UI_SCALE_PRESETS.some(([preset]) => preset === value);
  // 高亮单独一个出口：输入途中**只能改这个**，绝不能改输入框的 value（会把用户正在敲的字抹掉）。
  const paintCustomOn = (value) => customScale.classList.toggle("on", !isPresetScale(value));
  const paintCustomScale = () => {
    const value = normalizeUiScale(uiScale.value);
    customScale.value = isPresetScale(value) ? "" : String(value);
    paintCustomOn(value);
  };
  customScale.addEventListener("input", () => {
    // 逐字符输入：只有「落在区间内」才预览。半截（"1" / "-"）与越界都不动界面 ——
    // 判据在 parseCustomScaleInput 里（可单测），两个入口共用同一处。
    const { mode, value } = parseCustomScaleInput(customScale.value);
    if (mode !== "preview") return;
    uiScale.value = String(value);
    updateRangeTrack(uiScale);
    uiScaleOut.textContent = `${value}%`;
    setUiPreferences({ uiScale: value }, { persist: false });
    paintScalePresets();
    paintCustomOn(value);
    paintScaleHint();
  });
  customScale.addEventListener("change", () => {
    const { mode, value } = parseCustomScaleInput(customScale.value);
    if (mode === "skip") {
      paintCustomScale(); // 真的没输入内容（空 / 半截）= 不改动，把输入框还原成当前状态
      return;
    }
    // 与点档位同为一步到位的离散跳变（可能跨 30%+），走动画；滑杆那种连续输入才直设。
    // `clamp`（越界）在这里**照常落定** —— 与滑杆松手夹取同一语义：
    // 用户输完了，就该夹到边界并把真实生效值写回输入框，而不是丢掉他的输入。
    const applied = setUiPreferences({ uiScale: value }, { animate: true }).uiScale;
    uiScale.value = String(applied);
    updateRangeTrack(uiScale);
    uiScaleOut.textContent = `${applied}%`;
    paintScalePresets();
    paintScaleHint();
    paintCustomScale();
  });
  scalePresetBox.append(
    el("span", { class: "pref-choice-custom" },
      customScale,
      el("span", { class: "pref-choice-unit", "aria-hidden": "true" }, "%"),
    ),
  );
  paintCustomScale();

  const uiScaleHint = el("small", { class: "ui-scale-hint" });
  const paintScaleHint = () => {
    const value = Number(uiScale.value);
    const base = value === 100
      ? "当前为标准大小。整页（文字、按钮、间距、图标）会一起缩放；只想放大文字请用上面的「文字大小」。"
      : `整个界面按 ${value}% 显示。手机上界面太小、桌面上想一屏多放些内容都可以用这个。缩小到 80% 可在一屏里看到更多内容；放大后一屏能放的内容变少，必要时窗口需拉大。`;
    // 窄屏自适应（v0.49.0）：本机布局宽度不足 NARROW_REFERENCE_WIDTH 时会再乘一个系数。
    // 不提示的话用户会看到「设了 100% 却比预期小」，所以把实际生效值一并写出来。
    // ⚠️ 这里要用 window.innerWidth（缩放前的布局视口），不是 viewportWidth()
    //    —— 后者已经除以生效系数，读出来恰好是基准宽度，会把提示语说反。
    const auto = getAutoScaleFactor();
    const rawW = typeof window !== "undefined" ? Math.round(window.innerWidth) : 0;
    uiScaleHint.textContent = auto < 1 && rawW > 0
      ? `${base}本机布局宽度只有 ${rawW}px（不足 ${NARROW_REFERENCE_WIDTH}px），已自动等比缩小到 ${Math.round(auto * 100)}%，实际生效 ${Math.round((value / 100) * auto * 100)}% —— 否则顶栏与底栏会占掉过多屏幕。`
      : base;
  };
  paintScaleHint();
  // 拖动与点档位都要刷新提示语，两处都调一次（比在事件里各写一遍稳）。
  uiScale.addEventListener("input", paintScaleHint);
  uiScale.addEventListener("change", paintScaleHint);
  for (const [button] of scalePresetButtons) button.addEventListener("click", paintScaleHint);

  const motion = el("select", {},
    el("option", { value: "system" }, "跟随系统"),
    el("option", { value: "full" }, "完整动效"),
    el("option", { value: "reduced" }, "减少动效"),
  );
  motion.value = prefs.motion;
  motion.addEventListener("change", () => setUiPreferences({ motion: motion.value }));

  const startup = el("select", {});
  // v0.52.0：启动页选项按平台裁剪 —— APK 端不出现时间块 / 收件箱（没有这两个入口），
  // 桌面端不出现时间线。核心视图清单的单一事实源在 uiPreferences.coreViewIds()。
  const coreSet = new Set(coreViewIds());
  for (const [id, label] of STARTUP_VIEW_OPTIONS) {
    if (id !== "last" && !coreSet.has(id)) continue;
    // 跟随侧栏的右键改名（settings.navOverrides）：这里选的就是那几个页面，
    // 写着「收件箱」而侧栏叫别的名字会让人不确定选的是哪一页。「继续上次页面」不是视图，不参与。
    startup.append(el("option", { value: id }, id === "last" ? label : navDisplayName(id, label)));
  }
  startup.value = prefs.startupView;
  startup.addEventListener("change", () => { setUiPreferences({ startupView: startup.value }); toast("启动页设置将在下次打开应用时生效"); });

  /* 启动窗口大小：桌面端启动时套用（实现见 src/windowSize.js）。 */
  const desktopWindow = isDesktopRuntime();
  const windowMode = el("select", {});
  for (const [id, label] of WINDOW_SIZE_OPTIONS) windowMode.append(el("option", { value: id }, label));
  windowMode.value = prefs.startupWindowMode;
  const winW = el("input", { type: "number", class: "win-size", min: String(CUSTOM_SIZE_LIMITS.minWidth), max: String(CUSTOM_SIZE_LIMITS.maxWidth), step: "20", value: String(prefs.startupWindowWidth), "aria-label": "启动窗口宽度" });
  const winH = el("input", { type: "number", class: "win-size", min: String(CUSTOM_SIZE_LIMITS.minHeight), max: String(CUSTOM_SIZE_LIMITS.maxHeight), step: "20", value: String(prefs.startupWindowHeight), "aria-label": "启动窗口高度" });
  const customSize = el("span", { class: "win-size-row" }, winW, el("span", { class: "win-size-sep" }, "×"), winH);
  const windowHint = el("small", { class: "win-size-hint" });
  const syncWindowRow = () => {
    customSize.style.display = windowMode.value === "custom" ? "" : "none";
    windowHint.textContent = windowSizeHint(windowMode.value, {
      startupWindowWidth: Number(winW.value),
      startupWindowHeight: Number(winH.value),
    }) + (desktopWindow ? "" : " 当前环境不支持调整窗口，仅桌面端安装版生效。");
  };
  windowMode.addEventListener("change", () => {
    setUiPreferences({ startupWindowMode: windowMode.value });
    syncWindowRow();
  });
  for (const input of [winW, winH]) {
    input.addEventListener("change", () => {
      setUiPreferences({ startupWindowWidth: Number(winW.value), startupWindowHeight: Number(winH.value) });
      // 越界输入会被 normalize 夹回范围内，写回控件让用户看到真实生效值。
      const fixed = getUiPreferences();
      winW.value = String(fixed.startupWindowWidth);
      winH.value = String(fixed.startupWindowHeight);
      syncWindowRow();
    });
  }
  const applyWindowNow = async () => {
    const out = await applyWindowSize(getUiPreferences());
    if (out.applied) toast(out.mode === "full" ? "窗口已铺满可用区域" : `窗口已调整为 ${out.width} × ${out.height}`);
    else toast(`当前环境无法调整窗口${desktopWindow ? `：${out.reason || "未知原因"}` : ""}`);
  };
  const windowRow = el("div", { class: "setting-row setting-col" },
    el("span", { class: "setting-copy" }, el("b", {}, "启动窗口大小")),
    el("div", { class: "win-size-row" },
      windowMode,
      customSize,
      el("button", { class: "btn ghost sm", type: "button", onclick: applyWindowNow }, "立即应用"),
    ),
    windowHint,
  );
  syncWindowRow();

  // 点关闭按钮的行为：直接退出 / 隐藏到系统托盘。
  // closeBox 先声明、后填 click 逻辑：它的状态在上方托盘开关的 onChange 里也要被改写。
  const closeBox = el("select", {});
  // 存 data.json 的 settings.closeToTray（默认开 = 隐藏到托盘），Rust 关闭事件处理时现读。
  settings.closeToTray ??= true;
  closeBox.append(
    el("option", { value: "exit" }, "直接退出应用"),
    el("option", { value: "tray" }, "隐藏到系统托盘"),
  );
  closeBox.value = settings.closeToTray !== false ? "tray" : "exit";
  closeBox.addEventListener("change", () => {
    settings.closeToTray = closeBox.value === "tray";
    S.saveNow();
    toast(settings.closeToTray
      ? "点关闭按钮将隐藏到系统托盘（右键托盘图标可退出）"
      : "点关闭按钮将直接退出应用");
  });
  const closeRow = el("div", { class: "setting-row" },
    el("span", { class: "setting-copy" }, el("b", {}, "点关闭按钮时")),
    closeBox,
  );

  // 系统托盘开关（放在「点关闭按钮时」之后，两者是「总开关 → 细项」的从属关系）。
  // 关掉后不创建托盘图标（存 data.json 的 settings.trayEnabled，默认开）。
  // 图标创建是**启动时**行为，运行期增删容易留残留 ⇒ 改完提示重启生效。
  settings.trayEnabled ??= true;
  const trayRow = el("div", { class: "setting-row" },
    el("span", { class: "setting-copy" }, el("b", {}, "系统托盘")),
    toggleSwitch({
      checked: settings.trayEnabled !== false,
      ariaLabel: "启用系统托盘",
      onChange: (on) => {
        settings.trayEnabled = on;
        // 关掉托盘时「关闭窗口」的语义必须跟着改：细项若还停在「隐藏到托盘」，
        // 点了关闭应用就直接消失、再也叫不回来（Rust 侧另有同样的一手拦截）。
        if (!on) {
          settings.closeToTray = false;
          closeBox.value = "exit";
        }
        S.saveNow();
        closeRow.style.display = on ? "" : "none";
        toast(on ? "已启用系统托盘（重启应用后出现图标）" : "已关闭系统托盘，点关闭按钮会直接退出（重启后生效）");
      },
    }),
  );
  closeRow.style.display = settings.trayEnabled !== false ? "" : "none";

  const applyPreset = (name, patch) => {
    // 界面预设（含「舒适预设」的 uiScale:100）可能一并改缩放档位，同样走动画；
    // 没改缩放的预设会命中 applyUiScale 的「值没变」短路，不会有假动画。
    setUiPreferences(patch, { animate: true });
    toast(`已应用「${name}」界面预设`);
    rerender();
  };

  return el("div", { class: "card set-card" },
    el("h2", {}, "界面与交互"),
    el("div", { class: "pref-presets", "aria-label": "界面预设" },
      el("button", { class: "btn ghost sm", onclick: () => applyPreset("舒适", { ...DEFAULT_UI_PREFERENCES }) }, "舒适预设"),
      el("button", { class: "btn ghost sm", onclick: () => applyPreset("高密度", { density: "compact", textScale: 95, motion: "system", showTopStats: true, showViewSubtitle: false, showSettingsDescriptions: true }) }, "高密度"),
      el("button", { class: "btn ghost sm", onclick: () => applyPreset("低干扰", { density: "comfortable", textScale: 100, motion: "reduced", showTopStats: false, showViewSubtitle: false, showSettingsDescriptions: true }) }, "低干扰"),
      el("button", {
        class: `btn ghost sm pref-no-description${prefs.showSettingsDescriptions === false ? " on" : ""}`,
        "aria-pressed": String(prefs.showSettingsDescriptions === false),
        onclick: () => applyPreset("无描述", { showSettingsDescriptions: false }),
      }, "无描述"),
    ),
    el("div", { class: "setting-row" }, el("span", { class: "setting-copy" }, el("b", {}, "界面密度")), densityBox),
    el("div", { class: "setting-row" }, el("span", { class: "setting-copy" }, el("b", {}, "底栏高度")), navBarBox),
    el("div", { class: "setting-row" }, el("span", { class: "setting-copy" }, el("b", {}, "底栏形态")), navDockBox),
    el("div", { class: "setting-row" }, el("span", { class: "setting-copy" }, el("b", {}, "底栏材质")), navGlassBox),
    el("div", { class: "setting-row" }, el("span", { class: "setting-copy" }, el("b", {}, "底栏宽度"), el("small", {}, "居中显示，小屏保留按钮可点空间")), navWidthRange),
    el("div", { class: "setting-row" }, el("span", { class: "setting-copy" }, el("b", {}, "底栏透明度"), el("small", {}, "在当前材质上增加透明度，图标和文字保持清晰")), navTransparencyRange),
    el("div", { class: "setting-row" }, el("span", { class: "setting-copy" }, el("b", {}, "悬浮键高度")), fabHeightBox),
    toggleRow("悬浮键左右互换（‹ 在右 · ⋮ 在左）", prefs.fabSwap, (value) => setUiPreferences({ fabSwap: value })),
    el("div", { class: "setting-row" }, el("span", { class: "setting-copy" }, el("b", {}, "文字大小")), el("span", { class: "pref-range" }, textScale, textScaleOut)),
    el("div", { class: "setting-row setting-col" },
      el("div", { class: "setting-row-head" },
        el("span", { class: "setting-copy" }, el("b", {}, "界面缩放")),
        el("span", { class: "ui-scale-value" }, el("span", { class: "pref-range" }, uiScale, uiScaleOut)),
      ),
      scalePresetBox,
      uiScaleHint,
    ),
    el("div", { class: "setting-row" }, el("span", { class: "setting-copy" }, el("b", {}, "页面动效")), motion),
    toggleRow("Nephele 云雾与星尘背景", prefs.nepheleBackground, (value) => setUiPreferences({ nepheleBackground: value })),
    toggleRow("Nephele 风格设置界面", prefs.nepheleSettings, (value) => setUiPreferences({ nepheleSettings: value })),
    toggleRow("应用内打开网页", prefs.openLinksInApp, (value) => {
      setUiPreferences({ openLinksInApp: value });
      toast(value ? "网页将优先在 U-Time 内打开" : "网页将交给系统默认浏览器打开");
    }),
    toggleRow("显示顶部任务统计", prefs.showTopStats, (value) => setUiPreferences({ showTopStats: value })),
    toggleRow("顶部任务统计居中", prefs.centerTopStats, (value) => setUiPreferences({ centerTopStats: value })),
    toggleRow("显示页面副标题", prefs.showViewSubtitle, (value) => setUiPreferences({ showViewSubtitle: value })),
    // 堆叠靠 hover 才展得开，触屏设备（手机端）CSS 里整条不生效 —— 那里摆了开关也拧不动什么，
    // 所以跟着窗口尺寸那一组一起只在桌面出现。
    desktopWindow ? toggleRow("通知叠成一张（鼠标悬停展开）", prefs.notifyStack, (value) => setUiPreferences({ notifyStack: value })) : null,
    toggleRow("触摸左右滑动返回上一页", prefs.swipeNavigation, (value) => setUiPreferences({ swipeNavigation: value })),
    el("div", { class: "setting-row" }, el("span", { class: "setting-copy" }, el("b", {}, "启动后进入")), startup),
    desktopWindow ? windowRow : null,
    desktopWindow ? trayRow : null,
    desktopWindow ? closeRow : null,
    el("div", { class: "data-actions pref-reset" },
      el("button", { class: "btn ghost sm", onclick: () => {
        resetUiPreferences();
        // 界面缩放能到 150%，恢复默认后不重建整页的话，滑块与档位按钮还停在旧值上
        // （而界面已经跳回 100%），看起来像「点了没反应」—— 所以这里必须重渲染。
        toast("界面与交互设置已恢复默认");
        rerender();
      } }, "恢复界面默认"),
    ),
  );
}

function createSwatch(item, dark) {
  const colors = dark ? item.darkColors : item.colors;
  return el("span", { class: "theme-swatch", "aria-hidden": "true" },
    ...colors.map((color) => el("i", { style: `background:${color}` })),
  );
}

export function createThemeCard() {
  const settings = S.getState().settings;
  const selectedId = settings.theme || "classic";
  const selectedMode = getThemeMode();
  const themeCard = el("div", { class: "card set-card" },
    el("h2", {}, "主题"),
  );
  const modeNote = el("p", { class: "desc theme-mode-note" });
  const modeBox = el("div", { class: "theme-mode", role: "radiogroup", "aria-label": "显示模式" });
  for (const [id, label] of [
    ["system", "跟随系统"],
    ["light", "浅色模式"],
    ["dark", "深色模式"],
  ]) {
    const on = selectedMode === id;
    modeBox.append(el("button", {
      class: `theme-mode-btn${on ? " on" : ""}`,
      type: "button",
      role: "radio",
      "aria-checked": String(on),
      onclick: (event) => {
        setThemeMode(id, { animate: true });
        for (const node of modeBox.querySelectorAll(".theme-mode-btn")) {
          const active = node === event.currentTarget;
          node.classList.toggle("on", active);
          node.setAttribute("aria-checked", String(active));
        }
        paintModeNote();
        paintSwatches();
        toast(`已切换为${label}${id === "system" ? `（当前 ${resolveThemeMode() === "dark" ? "深色" : "浅色"}）` : ""}`);
      },
    }, el("b", {}, label)));
  }
  const themeGrid = el("div", { class: "theme-grid", role: "radiogroup", "aria-label": "界面主题" });

  // 夜间护眼本身就是深色主题，不受模式影响；其余主题按当前模式显示对应色板。
  const isDarkPreview = (item) => item.colorScheme === "dark" || resolveThemeMode() === "dark";
  const swatchNodes = new Map();
  const paintSwatches = () => {
    for (const [item, node] of swatchNodes) {
      const colors = isDarkPreview(item) ? item.darkColors : item.colors;
      [...node.children].forEach((dot, index) => { dot.style.background = colors[index]; });
    }
  };
  const paintModeNote = () => {
    const resolved = resolveThemeMode();
    const system = getThemeMode() === "system";
    // 只报「现在实际生效的是哪套配色」这一个状态，不再附带主题数量之类的说明（v0.37.19）。
    modeNote.textContent = `当前生效：${resolved === "dark" ? "深色配色" : "浅色配色"}` +
      (system ? `（跟随系统，检测到系统为${resolved === "dark" ? "深色" : "浅色"}）` : "");
  };

  const selectTheme = (item, button) => {
    if (button.classList.contains("on")) return;
    setTheme(item.id, { animate: true });
    for (const node of themeGrid.querySelectorAll(".theme-card")) {
      const on = node === button;
      node.classList.toggle("on", on);
      node.setAttribute("aria-checked", String(on));
      node.tabIndex = on ? 0 : -1;
    }
    toast(`已切换到「${item.name}」${item.colorScheme === "dark" ? "（深色主题）" : ""}`);
  };

  for (const item of THEMES) {
    const selected = selectedId === item.id;
    const swatch = createSwatch(item, isDarkPreview(item));
    swatchNodes.set(item, swatch);
    const button = el("button", {
      class: `theme-card theme-${item.id}${selected ? " on" : ""}`,
      type: "button",
      role: "radio",
      "aria-checked": String(selected),
      tabindex: selected ? "0" : "-1",
    },
      swatch,
      el("span", { class: "theme-card-copy" }, el("b", {}, item.name)),
      el("span", { class: "theme-selected-mark", "aria-hidden": "true" }, "✓"),
    );
    button.addEventListener("click", () => selectTheme(item, button));
    themeGrid.append(button);
  }
  paintModeNote();

  themeGrid.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...themeGrid.querySelectorAll(".theme-card")];
    const current = Math.max(0, buttons.indexOf(document.activeElement));
    const step = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1;
    const next = buttons[(current + step + buttons.length) % buttons.length];
    next.focus();
    next.click();
  });

  themeCard.append(modeBox, themeGrid);
  return themeCard;
}
