import { readProductSource } from "./lib/read-product-source.mjs";
/* 界面整体缩放（设置 → 界面与交互 → 界面缩放）的回归测试。
 *
 * 分三块：
 *  1. `src/uiScale.js` 的纯逻辑 —— 夹取、步进对齐、非法值兜底。
 *  2. `applyUiScale()` 真的往 documentElement 写了正确的 zoom / --ui-scale / --ui-vw / --ui-vh
 *     （用 vm 注入一个假 document，与 test-dorm-duty.mjs 同一套路）。
 *  3. **源码守卫** —— 这是本次改动最容易回归的部分：
 *     - styles.css 里不许再有 fixed 浮层直接用 `100vw`/`100vh`/`100dvh` 兜底（zoom 下会溢出屏幕）；
 *     - 断点必须保持 `px`，且不许把「缩放跟随断点」当成既成事实写进代码或注释。
 *     第一·条不是风格偏好，是 zoom 生效的前提，破了就等于功能坏掉，所以拿断言钉住。
 *
 * 关于第二条（曾一度写反，这里记录实测结论，别再翻回去）：
 * 本文件曾断言「媒体查询里不许有 px 断点，必须改用 em，em 会跟着 zoom 走」。
 * **那是错的**。无头 Chrome 实测（window-size=1280 → 视口 1264px，zoom=1.5 → html 计算字号 24px）：
 *
 *   @media (max-width: 65em)   → 不命中   （16px 基=1040，24px 基=1560，1264 两者都>，不可分辨）
 *   @media (max-width: 79em)   → **命中** （16px 基=1264 <= 1264 ✓；24px 基=1896 > 1264 应不命中 ✗）
 *   @media (max-width: 1264px) → 命中
 *   html 计算字号实测 24px（说明 zoom 确实把 html 的 font-size 缩放到了 24px）
 *
 * ⇒ **`em` 媒体查询固定按浏览器初始字号（默认 16px）求值，`html { font-size }` 与 `zoom`
 * 都改不动它。** 所以断点只能写 `px`，`zoom` 不会让窄屏断点提前命中 —— 这是本功能的
 * 已知边界（缩放只做「整页等比大小」，不改布局断点），不是缺陷。
 * 想让断点跟随缩放只能走 `@container`，属独立改造。
 *
 * v0.49.0 追加「窄屏自适应」：`applyUiScale` 除了用户设定，还要乘一个
 * `narrowAutoFactor(innerWidth)`（低于 360px 才生效）。所以第二条的判据变成
 * 「zoom = 用户设定 × 自适应」，`--ui-vw/--ui-vh` 必须除以**生效系数**而不是用户设定
 * —— 这一条最容易写错，下面用 288px 视口钉死。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_UI_SCALE,
  NARROW_MIN_FACTOR,
  NARROW_REFERENCE_WIDTH,
  UI_SCALE_ANIM_MS,
  UI_SCALE_LIMITS,
  UI_SCALE_PRESETS,
  __resetUiScaleForTest,
  applyUiScale,
  dragStableScale,
  getAutoScaleFactor,
  getUiScale,
  getUiScaleFactor,
  initUiScale,
  narrowAutoFactor,
  normalizeUiScale,
  parseCustomScaleInput,
} from "../src/uiScale.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readProductSource(path.join(__dirname, "..", rel), "utf8");

/* ────────────────────────── 1. 纯逻辑 ────────────────────────── */

// 区间与步进是功能的对外契约，写死在这里 —— 改了要连着设置页文案一起改。
assert.deepEqual(
  { min: UI_SCALE_LIMITS.min, max: UI_SCALE_LIMITS.max, step: UI_SCALE_LIMITS.step },
  { min: 80, max: 150, step: 5 },
);
assert.equal(DEFAULT_UI_SCALE, 100);

// 合法值原样通过
assert.equal(normalizeUiScale(100), 100);
assert.equal(normalizeUiScale(125), 125);
assert.equal(normalizeUiScale(80), 80);
assert.equal(normalizeUiScale(150), 150);

// 越界夹取
assert.equal(normalizeUiScale(10), 80);
assert.equal(normalizeUiScale(0), 100, "0 视为「没设置过」，回默认而不是夹到 80");
assert.equal(normalizeUiScale(-40), 80);
assert.equal(normalizeUiScale(999), 150);
assert.equal(normalizeUiScale(1e9), 150);
assert.equal(normalizeUiScale(Infinity), 150, "Infinity 夹到上限");

// 非 5 的倍数对齐到最近的档位
assert.equal(normalizeUiScale(117), 115);
assert.equal(normalizeUiScale(118), 120);
assert.equal(normalizeUiScale(83), 85);
assert.equal(normalizeUiScale(82), 80);
assert.equal(normalizeUiScale("125"), 125, "字符串数字来自 input.value，必须认");

// 非法输入兜底
for (const bad of [undefined, null, NaN, "", "abc", {}, [], true]) {
  assert.equal(normalizeUiScale(bad), 100, `非法输入 ${JSON.stringify(bad)} 应回默认 100`);
}

// 幂等：夹过之后再夹一次不变（设置页 input/change 两个事件会连续调用）
for (const raw of [83, 117, 0, 999, NaN]) {
  const once = normalizeUiScale(raw);
  assert.equal(normalizeUiScale(once), once, `normalizeUiScale 应幂等：${raw}`);
}

// 档位按钮必须都在合法区间内，且不重复
const presetValues = UI_SCALE_PRESETS.map(([value]) => value);
assert.equal(new Set(presetValues).size, presetValues.length, "档位不能重复");
for (const value of presetValues) {
  assert.equal(normalizeUiScale(value), value, `档位 ${value}% 必须本身合法`);
}
assert.ok(presetValues.includes(DEFAULT_UI_SCALE), "档位里要有「标准」这一档，否则用户没法回到默认");

/* ────────── 1c. 自定义输入框的取舍判据（v0.54.0） ──────────
 *
 * 4 个固定档位覆盖不到中间值，所以设置页多了一个直接敲数字的输入框。
 * 它和滑杆的关键差别是：**输入框是逐字符变化的**。敲「1」（打算输 120）时若照单应用，
 * `normalizeUiScale` 会把它夹成 80% —— 界面在打字途中乱跳。
 *
 * 三态，不是一个布尔 —— 尤其别把「越界」和「半截」混成一类：
 * - `skip`    ：真的没输入内容（空 / 半截 / 非法类型）⇒ 预览与落定都不动界面；
 * - `preview` ：区间内 ⇒ 输入途中就能应用；
 * - `clamp`   ：有数字但越界 ⇒ 输入途中不动（敲「999」的前两下是 9、99），
 *               **落定时照常夹到边界** —— 丢掉用户的输入是错的。 */

// preview：区间内的整数与数字字符串要即时应用，且**夹取对齐后**的值与落定完全一致
for (const [raw, expect] of [
  ["120", 120], [120, 120], [" 110 ", 110], ["100", 100],
  ["80", 80], ["150", 150], ["83", 85], ["117", 115], ["120.5", 120],
]) {
  assert.deepEqual(
    parseCustomScaleInput(raw),
    { mode: "preview", value: expect },
    `${JSON.stringify(raw)} 应即时预览为 ${expect}%`,
  );
}
// clamp：越界要给「夹到边界」的值，且与 normalizeUiScale 同一口径
for (const [raw, expect] of [
  ["79", 80], ["10", 80], ["-40", 80], ["151", 150], ["999", 150], ["1e9", 150],
]) {
  assert.deepEqual(
    parseCustomScaleInput(raw),
    { mode: "clamp", value: expect },
    `${JSON.stringify(raw)} 越界，落定应夹到 ${expect}%`,
  );
}
// 口径必须单一：preview 与 clamp 的值都不许和 normalizeUiScale 分家，
// 否则会出现「预览 110、落定 115」或「输 999 落定成 140」这类分裂。
for (const raw of ["83", "117", "120.5", "99.4", "112", "79", "999", "1e9"]) {
  assert.equal(parseCustomScaleInput(raw).value, normalizeUiScale(raw), `预览/落定口径必须一致：${raw}`);
}

// skip①：半截输入 —— 这些不是「要设成 0 / NaN」，是还没输完
for (const raw of ["", " ", "  ", "-", "+", ".", "abc", "1e", "12x"]) {
  assert.equal(parseCustomScaleInput(raw).mode, "skip", `${JSON.stringify(raw)} 是半截输入，不许动界面`);
}
// skip②：非法类型 —— 而不是「兜底成 100」，那等于替用户改了设置
for (const bad of [null, undefined, {}, [], true, false, NaN, Infinity]) {
  assert.equal(parseCustomScaleInput(bad).mode, "skip", `非法类型 ${JSON.stringify(bad)} 不许应用`);
}
// skip③：空串必须**显式**走 skip，不能靠「Number("") === 0 越界」这条巧合 ——
// 区间一旦放宽到 0，「没输入」就会被当成「设成 0」（这是有意保留的前置守卫）。
assert.equal(parseCustomScaleInput("").mode, "skip");

/* ──────────────── 1b. 窄屏自适应系数（v0.49.0） ──────────────── */

// 基准宽度是功能的对外契约：动它等于改变所有窄屏设备的观感（实测 288px 的 600dpi 屏
// 上，外壳占屏高 26% → 20.6%）。要改就连同设置页文案一起改。
assert.equal(NARROW_REFERENCE_WIDTH, 360);
assert.equal(NARROW_MIN_FACTOR, 0.7);

// 标准手机逻辑宽度（360 / 390 / 412 是最常见的三档）：一律不缩 —— 这是「常规机零影响」的判据
for (const w of [360, 375, 390, 393, 412, 414, 560, 768, 1024, 1440, 3840]) {
  assert.equal(narrowAutoFactor(w), 1, `${w}px 不该触发窄屏自适应`);
}

// 窄于基准：系数 = 宽 / 基准，使内容布局宽度恰好回到基准
assert.equal(narrowAutoFactor(288), 0.8, "288 → 0.8（布局宽度回到 360）");
assert.equal(narrowAutoFactor(324), 0.9);
assert.equal(narrowAutoFactor(320), 320 / 360);
assert.equal(narrowAutoFactor(252), NARROW_MIN_FACTOR, "触到下限");
assert.equal(narrowAutoFactor(1), NARROW_MIN_FACTOR, "再窄也不缩过头");

// 拿不到宽度一律退回 1（宁可不缩，也不要因为读不到视口把界面缩坏）
for (const bad of [undefined, null, NaN, "", "abc", {}, [], 0, -320, Infinity, -Infinity]) {
  assert.equal(narrowAutoFactor(bad), 1, `宽度 ${JSON.stringify(bad)} 应退回 1（不缩）`);
}

// 区间内单调：越窄缩得越多
assert.ok(narrowAutoFactor(300) < narrowAutoFactor(340), "越窄应缩得越多");
assert.ok(narrowAutoFactor(359) < 1);
// 纯函数：同输入同输出
assert.equal(narrowAutoFactor(288), narrowAutoFactor(288));

/* ──────────────── 1d. 拖动稳定映射（v0.58.0） ────────────────
 *
 * 「界面缩放」滑杆的 input 直接改 zoom 时存在**几何正反馈回路**（实测，2026-09-18）：
 * input 改 zoom → 整页含滑杆立即重排，设置弹窗 margin:auto 居中 ⇒ 轨道在指针下水平平移
 * （每 5% 档漂移约 14px）→ 浏览器下一次 pointermove 按**新几何**重算值 → 值跳 → zoom 又变。
 * 实测指针匀速右移时值 95→100→95→105→95→110→90→120→…剧烈振荡；原地 ±1px 微抖，
 * 值在 110→80→125→95 之间摆动 45% —— 用户看到的「一闪一闪」。
 *
 * 修复 = 拖动期间以**按下瞬间冻结的轨道几何**做增量映射（dragStableScale）：
 *   v = normalizeUiScale(v0 + (f(x) - f(x0)) × (max - min))，f(x) = (x-baseLeft)/baseWidth。
 * 轨道平移对 f 与 f0 是同一个平移，差值不变 —— 正反馈在数学上被拆掉。
 * 接线在 views/settings/appearance.js（pointerdown 冻结 rect / input 重映射），
 * 键盘方向键无 pointer 会话、不走本函数。 */

// 典型轨道几何：设置弹窗里实测量级（left≈900、宽≈200）
const track = { baseLeft: 900, baseWidth: 200 };
// 按下点：指针在轨道 25% 处，按下后第一次 input 的原生值 v0=100
const X0 = 950;

// ① 单调跟随：指针位移决定值，右移只增不减（这是「回路已断」的基本面）
{
  const at = (dx) => dragStableScale({ v0: 100, x0: X0, x: X0 + dx, ...track });
  assert.equal(at(0), 100, "按住不动 = 原值（点轨道跳转后的 v0 必须原样保持）");
  assert.equal(at(10), 105, "右移 5% 轨道宽 → +3.5 满量程 → 对齐 105");
  assert.equal(at(30), 110);
  assert.equal(at(40), 115);
  assert.equal(at(100), 135, "右移半条轨道 → +35 满量程 → 135");
  let prev = at(-200); // 拖出左端 → 80
  assert.equal(prev, 80);
  for (let dx = -199; dx <= 200; dx++) {
    const v = at(dx);
    assert.ok(v >= prev, `指针右移值不许回退：dx=${dx} 时 ${v} < ${prev}`);
    prev = v;
  }
}

// ② 夹取：拖出轨道两端仍落在 [80, 150]（normalizeUiScale 同一口径）
assert.equal(dragStableScale({ v0: 100, x0: X0, x: 5000, ...track }), 150, "拖出右端夹上限");
assert.equal(dragStableScale({ v0: 100, x0: X0, x: -5000, ...track }), 80, "拖出左端夹下限");

// ③ 抖动稳定（本修复的回归核心）：原地 ±1~2px 来回，值必须停在同一档。
//    旧实现（浏览器按漂移后的几何重算）实测同一位置值摆 45%（110→80→125→95）。
{
  const jitters = [0, 1, -1, 1, -1, 0, 2, -2, 1, -2, 0];
  const values = jitters.map((dx) => dragStableScale({ v0: 110, x0: X0, x: X0 + dx, ...track }));
  assert.equal(
    new Set(values).size,
    1,
    `原地微抖只许停在同一档，实测序列：${values.join("→")}`,
  );
}

// ④ 轨道平移被吸收：zoom 变了轨道真的会平移（实测每档 ~14px），但映射基准是冻结的 ——
//    同样的指针位移必须给出同样的值，与「轨道此刻画在哪」无关。
//    数学上 baseLeft 平移对 f 与 f0 同加同减，差不变 —— 这就是断开正反馈的判据。
assert.equal(
  dragStableScale({ v0: 100, x0: X0, x: 980, baseLeft: 900, baseWidth: 200 }),
  dragStableScale({ v0: 100, x0: X0, x: 980, baseLeft: 914, baseWidth: 200 }),
  "轨道平移 14px 不得改变映射值（否则回路复通）",
);

// ⑤ 退化输入兜底：拿不到 rect / 坐标异常时回 v0（夹取对齐），不许 NaN 进 DOM
for (const bad of [
  { v0: 110, x0: X0, x: 980, baseLeft: 900, baseWidth: 0 },
  { v0: 110, x0: X0, x: 980, baseLeft: 900, baseWidth: -5 },
  { v0: 110, x0: X0, x: 980, baseLeft: NaN, baseWidth: 200 },
  { v0: 110, x0: X0, x: 980, baseLeft: undefined, baseWidth: 200 },
  { v0: 110, x0: X0, x: NaN, baseLeft: 900, baseWidth: 200 },
  { v0: 110, x0: NaN, x: 980, baseLeft: 900, baseWidth: 200 },
]) {
  assert.equal(dragStableScale(bad), 110, `退化输入应兜底回 v0：${JSON.stringify(bad)}`);
}
// v0 本身脏：走 normalizeUiScale 的兜底（回默认 100）
assert.equal(dragStableScale({ v0: NaN, x0: X0, x: 980, baseLeft: 900, baseWidth: 0 }), 100);
assert.equal(dragStableScale({}), 100, "空参兜底回默认");

/* ────────────────────── 2. applyUiScale 的 DOM 写入 ────────────────────── */

// 假 document / window：只要 root.style.setProperty / addEventListener 够用就行。
// root 必须带 dataset（v0.54.0 起缩放动画的动效门槛要读 data-ui-motion）。
// raf: true 时 window 挂一个**手动驱动**的 rAF —— 测试用 env.advance(ts) 逐帧喂时间戳，
// 完全可控地推动画（浏览器里 rAF 回调收到的那个 timestamp 就是这么用的）。
function makeEnv({ width = 1440, height = 900, raf = false } = {}) {
  const vars = new Map();
  const listeners = new Map();
  const rafQueue = [];
  const root = {
    dataset: {},
    style: {
      zoom: "",
      setProperty(name, value) { vars.set(name, value); },
      getPropertyValue(name) { return vars.has(name) ? vars.get(name) : ""; },
    },
  };
  const win = {
    innerWidth: width,
    innerHeight: height,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
  };
  if (raf) {
    win.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
    win.matchMedia = (query) => ({ matches: false, media: query });
  }
  return {
    vars,
    listeners,
    rafQueue,
    /** 执行当前排队的一帧回调，把 ts 作为 rAF 时间戳传入。 */
    advance(ts) {
      const batch = rafQueue.splice(0);
      for (const fn of batch) fn(ts);
    },
    document: { documentElement: root },
    window: win,
  };
}

const loadModuleInEnv = (env) => {
  const src = readSrc("src/uiScale.js")
    // 剥掉 ESM 导出语法，改成往 globalThis 上挂，好在 vm 里跑
    .replace(/^export\s+/gm, "")
    .concat("\nglobalThis.__uiScale = { __resetUiScaleForTest, applyUiScale, initUiScale, getUiScale, getUiScaleFactor, getAutoScaleFactor, narrowAutoFactor, viewportWidth, viewportHeight, normalizeUiScale, parseCustomScaleInput, dragStableScale, UI_SCALE_LIMITS, UI_SCALE_ANIM_MS, NARROW_REFERENCE_WIDTH, NARROW_MIN_FACTOR };\n");
  const ctx = { console, document: env.document, window: env.window };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.__uiScale;
};

{
  const env = makeEnv({ width: 1440, height: 900 });
  const mod = loadModuleInEnv(env);
  mod.__resetUiScaleForTest();

  // 100%：zoom=1，且 --ui-vw/--ui-vh 恰好等于视口（除以 1）
  assert.equal(mod.applyUiScale(100), 100);
  assert.equal(env.document.documentElement.style.zoom, "1");
  assert.equal(env.vars.get("--ui-scale"), "1");
  assert.equal(env.vars.get("--ui-vw"), "1440px");
  assert.equal(env.vars.get("--ui-vh"), "900px");

  // 150%：zoom=1.5；视口补偿必须是「除以 1.5」的原始长度，否则 fixed 浮层掉到屏幕外
  assert.equal(mod.applyUiScale(150), 150);
  assert.equal(env.document.documentElement.style.zoom, "1.5");
  assert.equal(env.vars.get("--ui-scale"), "1.5");
  assert.equal(env.vars.get("--ui-vw"), "960px", "1440 / 1.5");
  assert.equal(env.vars.get("--ui-vh"), "600px", "900 / 1.5");

  // 80%：放大视口补偿（1440 / 0.8 = 1800），fixed 浮层的坐标空间随之变大
  assert.equal(mod.applyUiScale(80), 80);
  assert.equal(env.document.documentElement.style.zoom, "0.8");
  assert.equal(env.vars.get("--ui-vw"), "1800px");
  assert.equal(env.vars.get("--ui-vh"), "1125px");

  // 非法值：写入的仍是夹取后的合法值，不是原始输入
  mod.applyUiScale(9999);
  assert.equal(env.document.documentElement.style.zoom, "1.5");
  assert.equal(env.vars.get("--ui-vw"), "960px");

  // getUiScale / getUiScaleFactor 与写入保持一致
  mod.applyUiScale(125);
  assert.equal(mod.getUiScale(), 125);
  assert.equal(mod.getUiScaleFactor(), 1.25);
  assert.equal(mod.viewportWidth(), 1440 / 1.25);
  assert.equal(mod.viewportHeight(), 900 / 1.25);

  // resize 后 --ui-vw/--ui-vh 必须刷新（纯 CSS 算不出来，只能靠监听）
  mod.initUiScale();
  const resizeHandlers = env.listeners.get("resize") || [];
  assert.equal(resizeHandlers.length, 1, "resize 监听应恰好挂一次");
  assert.ok((env.listeners.get("orientationchange") || []).length >= 1, "横竖屏切换也要刷（部分 WebView 不发 resize）");
  env.window.innerWidth = 800;
  env.window.innerHeight = 600;
  resizeHandlers[0]();
  assert.equal(env.vars.get("--ui-vw"), String(800 / 1.25) + "px", "resize 后要重算 --ui-vw");
  assert.equal(env.vars.get("--ui-vh"), String(600 / 1.25) + "px", "resize 后要重算 --ui-vh");
  assert.equal(env.document.documentElement.style.zoom, "1.25", "resize 不该改缩放值");

  // initUiScale 幂等：重复调用不得挂出第二组监听（否则每次进设置页都堆一个）
  mod.initUiScale();
  mod.initUiScale();
  assert.equal((env.listeners.get("resize") || []).length, 1, "initUiScale 必须幂等");
}

{
  // ── 窄屏（600dpi 的 1080×2376 实测只有 288×633 CSS px）──
  // 判据：生效系数 = 用户设定 × 自适应，且 --ui-vw/--ui-vh 必须除以**生效系数**。
  const env = makeEnv({ width: 288, height: 633.6 });
  const mod = loadModuleInEnv(env);
  mod.__resetUiScaleForTest();

  assert.equal(mod.applyUiScale(100), 100, "返回值仍是用户设定，不被自适应改写");
  assert.equal(mod.getUiScale(), 100, "设置页显示用户设定");
  assert.equal(mod.getAutoScaleFactor(), 0.8);
  assert.equal(mod.getUiScaleFactor(), 0.8, "生效系数 = 1.0 × 0.8");
  assert.equal(env.document.documentElement.style.zoom, "0.8");
  assert.equal(env.vars.get("--ui-scale"), "0.8");
  assert.equal(env.vars.get("--ui-auto-scale"), "0.8");
  // 🔴 视口补偿除以生效系数：288 / 0.8 = 360。
  //    写成「除以用户设定」（288 / 1）会让 width: var(--ui-vw) 的浮层在 360 宽的
  //    内容坐标系里只画 288 宽 —— 缺一块，且只有窄屏才复现。
  assert.equal(Math.round(parseFloat(env.vars.get("--ui-vw"))), 360);
  assert.equal(Math.round(parseFloat(env.vars.get("--ui-vh"))), 792);
  assert.equal(mod.viewportWidth(), 288 / 0.8);

  // 用户自己再缩到 80%：两段系数相乘（0.8 × 0.8 = 0.64）
  mod.applyUiScale(80);
  assert.equal(mod.getUiScale(), 80);
  assert.equal(mod.getAutoScaleFactor(), 0.8, "自适应部分不随用户设定变");
  assert.equal(Math.round(mod.getUiScaleFactor() * 100), 64);
  assert.equal(Math.round(parseFloat(env.vars.get("--ui-vw"))), Math.round(288 / 0.64));

  // 旋屏到 768px 宽：自适应退出，只剩用户设定
  env.window.innerWidth = 768;
  env.window.innerHeight = 400;
  mod.applyUiScale(80);
  assert.equal(mod.getAutoScaleFactor(), 1);
  assert.equal(mod.getUiScaleFactor(), 0.8);
  assert.equal(env.vars.get("--ui-auto-scale"), "1");
  assert.equal(env.vars.get("--ui-vw"), "960px", "768 / 0.8");

  // 回到标准手机宽度：必须与旧行为逐位一致（这是「常规机零影响」的判据）
  const env2 = makeEnv({ width: 390, height: 844 });
  const mod2 = loadModuleInEnv(env2);
  mod2.__resetUiScaleForTest();
  mod2.applyUiScale(100);
  assert.equal(env2.document.documentElement.style.zoom, "1");
  assert.equal(env2.vars.get("--ui-scale"), "1");
  assert.equal(env2.vars.get("--ui-auto-scale"), "1");
  assert.equal(env2.vars.get("--ui-vw"), "390px");
  assert.equal(env2.vars.get("--ui-vh"), "844px");
}

/* ──────────────── 2b. 切换动画（v0.54.0）：rAF 插值 ──────────────── */

{
  const env = makeEnv({ width: 1440, height: 900, raf: true });
  const mod = loadModuleInEnv(env);
  mod.__resetUiScaleForTest();

  // 起点 100%
  mod.applyUiScale(100);
  assert.equal(env.document.documentElement.style.zoom, "1");
  assert.equal(UI_SCALE_ANIM_MS > 100 && UI_SCALE_ANIM_MS < 500, true, "动画时长应在合理观感区间");

  // animate 路径：返回值与 currentScale 立即到位，DOM 未推帧前仍是旧系数
  let ret = mod.applyUiScale(150, { animate: true });
  assert.equal(ret, 150, "返回值立即是目标设定（设置页显示不撒谎）");
  assert.equal(mod.getUiScale(), 150, "currentScale 立即到位");
  assert.equal(env.document.documentElement.style.zoom, "1", "未推帧时 DOM 仍是旧系数");

  // 首帧：t=0，eased=0，仍画起点（无害帧），并建立时间基准
  env.advance(1000);
  assert.equal(parseFloat(env.document.documentElement.style.zoom), 1, "首帧仍在起点");

  // 中段帧：130ms / 260ms = t=0.5 → easeOutCubic eased=0.875 → factor ≈ 1.4375
  env.advance(1130);
  const z1 = parseFloat(env.document.documentElement.style.zoom);
  assert.ok(z1 > 1 && z1 < 1.5, `中段帧必须落在开区间 (1, 1.5)：${z1}`);
  assert.ok(z1 > 1.2, `easeOutCubic 前半程应推过 1.2（不是匀速也不是迟迟不动）：${z1}`);
  assert.ok(
    Math.abs(parseFloat(env.vars.get("--ui-vw")) - 1440 / z1) < 1e-9,
    "同一帧里 --ui-vw 必须除以**同一个**插值系数（错帧 = 闪烁来源）",
  );
  assert.ok(
    Math.abs(parseFloat(env.vars.get("--ui-vh")) - 900 / z1) < 1e-9,
    "--ui-vh 同样与 zoom 严格同帧",
  );

  // 终帧：t≥1，精确落在目标上（不是渐近尾差），补偿变量与直设逐位一致
  env.advance(1400);
  assert.equal(env.document.documentElement.style.zoom, "1.5", "终帧精确落点");
  assert.equal(env.vars.get("--ui-scale"), "1.5");
  assert.equal(env.vars.get("--ui-vw"), "960px", "1440 / 1.5，与直设逐位一致");
  assert.equal(env.vars.get("--ui-vh"), "600px");
  assert.equal(mod.getUiScaleFactor(), 1.5);
  // 动画结束后不得再排帧（泄漏的循环会一直重写 DOM）
  assert.equal(env.rafQueue.length, 0, "动画结束不得残留 rAF 回调");

  // ── 中途重触发：动画到一半换新目标，从**当前插值位置**续走 ──
  mod.applyUiScale(100); // 不带 animate → 直设回起点
  assert.equal(env.document.documentElement.style.zoom, "1");
  mod.applyUiScale(150, { animate: true });
  env.advance(2000); // 首帧（t=0）
  env.advance(2130); // t=0.5 → 中途 1.4375
  const mid = parseFloat(env.document.documentElement.style.zoom);
  assert.ok(mid > 1 && mid < 1.5, `重触发前应处于插值中途：${mid}`);
  mod.applyUiScale(80, { animate: true });
  assert.equal(
    env.document.documentElement.style.zoom,
    String(mid),
    "重触发瞬间 DOM 不回跳（仍显示旧动画的中途值）",
  );
  // 新动画从 mid 平滑走到 0.8：中段必须夹在 (0.8, mid) 内 —— 若实现错误地从旧起点 1
  // 或旧目标 1.5 出发，中段就会越界
  env.advance(3000); // 新动画首帧（t=0，仍 mid）
  assert.equal(parseFloat(env.document.documentElement.style.zoom), mid, "新动画首帧仍在中途值");
  env.advance(3130); // t=0.5
  const zr = parseFloat(env.document.documentElement.style.zoom);
  assert.ok(zr > 0.8 && zr < mid, `续走的中段帧应落在 (0.8, ${mid})：${zr}`);
  env.advance(3400); // 终帧
  assert.equal(env.document.documentElement.style.zoom, "0.8", "重触发后的终值精确落点");
  assert.equal(env.rafQueue.length, 0, "重触发后旧循环已死、新循环已结束，不残留帧");

  // ── reduced 动效偏好：传了 animate 也必须直设（theme.js 同一门槛规则）──
  env.document.documentElement.dataset.uiMotion = "reduced";
  mod.applyUiScale(125, { animate: true });
  assert.equal(env.document.documentElement.style.zoom, "1.25", "reduced 偏好直接落定，不出动画");
  assert.equal(env.rafQueue.length, 0, "reduced 偏下不该排帧");
  env.document.documentElement.dataset.uiMotion = "full";
  mod.__resetUiScaleForTest();
  env.rafQueue.length = 0;
  mod.applyUiScale(100);
  env.advance(4000);
  env.rafQueue.length = 0;
  mod.applyUiScale(80, { animate: true });
  assert.equal(env.document.documentElement.style.zoom, "1", "full 偏好下未推帧应是旧值（动画在飞）");
  env.document.documentElement.dataset.uiMotion = "";

  // ── 值没变：animate:true 也不出动画（短路，不排帧）──
  mod.__resetUiScaleForTest();
  env.rafQueue.length = 0;
  mod.applyUiScale(100);
  env.advance(5000);
  env.rafQueue.length = 0;
  mod.applyUiScale(100, { animate: true });
  assert.equal(env.document.documentElement.style.zoom, "1");
  assert.equal(env.rafQueue.length, 0, "值没变不该排 rAF 帧");

  // ── resize 取消在飞动画并直设：视口变了，插值前提失效 ──
  mod.initUiScale(); // 2b 块此前没挂过监听，resize 用例要显式初始化（幂等）
  mod.__resetUiScaleForTest();
  env.rafQueue.length = 0;
  mod.applyUiScale(100);
  env.advance(6000);
  env.rafQueue.length = 0;
  mod.applyUiScale(150, { animate: true });
  env.advance(6000); // 首帧
  env.advance(6130); // 中段
  assert.ok(parseFloat(env.document.documentElement.style.zoom) > 1, "动画中段已推进");
  const resizeHandlers = env.listeners.get("resize") || [];
  assert.ok(resizeHandlers.length >= 1, "resize 监听应已挂上");
  env.window.innerWidth = 288; // 视口窄到 288 → 自适应系数 0.8
  resizeHandlers[0](); // applyUiScale(currentScale=150) 直设：150% × 0.8 = 1.2
  // ⚠️ 浮点上 1.5 × 0.8 = 1.2000000000000002 —— 旧直设路径就是这个值（非动画引入），用容差断言
  assert.ok(
    Math.abs(parseFloat(env.document.documentElement.style.zoom) - 1.2) < 1e-9,
    `resize 立即直设新状态（150 × 0.8）：${env.document.documentElement.style.zoom}`,
  );
  env.advance(9000); // 旧动画循环若未被取消，这次推进会把 zoom 写走
  assert.ok(
    Math.abs(parseFloat(env.document.documentElement.style.zoom) - 1.2) < 1e-9,
    "取消后的旧循环不得再写 DOM",
  );
  assert.equal(env.rafQueue.length, 0, "取消后不得残留帧");
}

/* ───────────────────── 3. 源码守卫（zoom 成立的硬前提） ───────────────────── */

const styles = readSrc("src/styles.css");

// 3a. fixed 浮层不许拿 100vw/100vh/100dvh 当兜底值 —— zoom 下它们乘上缩放系数会大于屏幕。
//     `var(--ui-vw, 100vw)` 这种写法是**允许**的：兜底只在 JS 没来得及写变量时生效。
const offenders = [];
const declRe = /(^|[;{]\s*)((?:left|right|top|bottom|width|max-width|min-width|height|max-height|min-height|inset)\s*:\s*)([^;}]+)/g;
let m;
while ((m = declRe.exec(styles))) {
  const value = m[3];
  if (!/(^|[^-\w])(?:100vw|100vh|100dvh)/.test(value)) continue;
  // 已被 var(--ui-v*) 包住的直接放行
  const stripped = value.replace(/var\(\s*--ui-v[wh]\s*,[^)]*\)/g, "UI");
  if (!/(^|[^-\w])(?:100vw|100vh|100dvh)/.test(stripped)) continue;
  offenders.push(`${m[2].trim()} ${value.trim()}`);
}
assert.deepEqual(
  offenders,
  [],
  "这些声明在 zoom 下会溢出屏幕，请改用 var(--ui-vw, 100vw) / var(--ui-vh, 100dvh)：\n" + offenders.join("\n"),
);

// 3b. `:root` 里绝不许给 --sat/--sab/--sal/--sar 写兜底默认值。
//     变量一旦在 :root 成为有效值，`var()` 的第二个参数（原生 env()）就永远失效，
//     iOS 与桌面的安全区会整个废掉。这条在 AGENTS.md 里点名过，这里钉死。
const rootBlock = (styles.match(/:root\s*\{[\s\S]*?\n\}/) || [""])[0];
for (const varName of ["--sat", "--sab", "--sal", "--sar"]) {
  assert.ok(
    !new RegExp(`${varName}\\s*:`).test(rootBlock),
    `:root 里不能定义 ${varName}，否则 var() 的 env() 兜底永远不生效`,
  );
}

// 3c. 🔴 固定浮层的边距必须写「÷ --ui-scale」，**不许**再写「视口长 − 边距」。
//     v0.48.0 曾把 bottom / inset 改成 `calc(var(--ui-vh, 100dvh) - N)`，理由是
//     「zoom 下 px 会被缩放」。实测（1280×800，zoom=1 与 1.5 两档，
//     .workbuddy-ai/tmp/probe-inset-zoom.cjs）那是错的：该写法等价于「距屏幕**顶** N」——
//     toast 跑到屏幕上沿、设置弹窗塌成 2×2 被推出屏幕（桌面 >760px 设置页整个打不开，
//     v0.48.0 ~ v0.49.1）。正确写法是「物理边距 N ÷ 系数」。推导见 styles.css 顶部契约第 1 条。
assert.match(styles, /#toasts\s*\{[^}]*bottom:\s*calc\(22px\s*\/\s*var\(--ui-scale/,
  "#toasts 的 bottom 要写「边距 ÷ --ui-scale」");
assert.match(styles, /\.settings-modal\s*\{[^}]*inset:\s*calc\(36px\s*\/\s*var\(--ui-scale/,
  ".settings-modal 的 inset 要写「边距 ÷ --ui-scale」");
// v0.50.0 用户反馈「设置弹窗左右太宽」：限宽 1120px + margin auto 居中。
// max-width 必须是裸值、不许 ÷ --ui-scale —— zoom 放大时字号一起放大，
// ÷scale 会把大字号挤进没放大的宽度里（与 inset 的「物理边距」语义相反，别搞混）。
assert.match(styles, /\.settings-modal\s*\{[^}]*max-width:\s*1120px[^}]*margin:\s*auto/,
  ".settings-modal 要限宽 1120px 并 margin auto 居中（不许改回全宽铺开）");
assert.doesNotMatch(styles, /\.settings-modal\s*\{[^}]*max-width:\s*calc\([^)]*--ui-scale/,
  ".settings-modal 的 max-width 不许 ÷ --ui-scale（会挤压 zoom 放大后的内容）");
// 反向守卫：定位锚点里出现「--ui-v* − 数值」一律算回归。
// （`calc(var(--ui-vh) * .11)` 这类「乘比例」是合法用法，不要误伤。）
const badAnchors = [...styles.matchAll(/(?:^|[\s;{])(bottom|top|left|right|inset)\s*:[^;]*?calc\(var\(--ui-v[wh][^;]*?-\s*[\d.]+px/g)]
  .map((m) => `${m[1]}: ${m[0].slice(m[0].indexOf("calc")).trim()}`);
assert.deepEqual(badAnchors, [],
  "不许再写「视口长 − 边距」（v0.48.0 的错误写法，v0.49.2 已改回「边距 ÷ --ui-scale」）：\n" + badAnchors.join("\n"));

// 3c-2. 窄屏设置弹窗全屏贴顶 ⇒ 顶栏必须自己让开状态栏。
//       （v0.49.2 用户反馈：APK 里「设置」二字与「关闭」按钮被手机状态栏压住。）
//       Android WebView 不实现 env(safe-area-inset-*)，只有 --sat 是真的 ⇒ 双路写法。
assert.match(styles, /\.settings-modal-head\s*\{\s*padding-top:\s*calc\(12px \+ var\(--sat/,
  "窄屏设置弹窗顶栏要让开状态栏（padding-top 消费 --sat，双路写法）");
// 顶栏那一行还要再往下挪 8px（用户反馈让开状态栏后仍贴得太紧）。
// 必须是子元素外边距、且 margin-bottom 用负值抵消：改成加大 padding-top 会把顶栏
// 连滚动区一起挤高，只留 margin-top 也会撑高 flex 行（flex 交叉轴按 margin box 算）。
assert.match(styles, /\.settings-modal-head\s*>\s*div,\s*\.settings-modal-head\s*>\s*\.btn\s*\{\s*margin-top:\s*8px;\s*margin-bottom:\s*-8px/,
  "窄屏设置弹窗的「设置」与「关闭」要各自下移 8px，且用负 margin 抵掉撑高（顶栏总高不变）");

// 3d. 🔴 反向守卫：**不许**再把断点写成 em。
//     实测 em 媒体查询恒定按浏览器默认 16px 求值，zoom 与 html font-size 都影响不了它，
//     所以 em 断点相对 px 断点没有任何收益，只会让断点值与设计稿脱节。
//     这条是给「又有人想用 em 让断点跟随缩放」准备的 —— 那个思路已被实测推翻。
const emBreakpoints = (styles.match(/@media[^{]*\{/g) || [])
  .filter((head) => /(?:max|min)-width:\s*\d+(?:\.\d+)?em/.test(head));
assert.deepEqual(
  emBreakpoints,
  [],
  "媒体查询断点请用 px：em 媒体查询不跟随 zoom（实测恒定按 16px 求值），改 em 没有收益\n"
    + emBreakpoints.join("\n"),
);

// 3e. 桌面/手机的 px 断点必须一个不少、数量也对得上。
//     ⚠️ 只断言「某断点存在」是不够的：同一个断点在全文件出现多处（760px 有 14 处，
//     v0.52.0 时间线视图 .tlv-* 段 +1、v0.53.0 侧栏操作条窄屏还原 +1），
//     改坏一处、其余仍能匹配 → 假断言（变异测试实测逃逸过）。所以这里钉**精确条数**。
//     这批数字是回退 em 时的对照表；真要新增断点，连着这个表一起改。
const expectedBreakpoints = new Map([
  // 720px 那一处随「自定义背景」的 .bg-grid / .bg-preview 一起删掉了（v0.55.0）。
  // 761/1280：v0.57.0 删掉「统计居中时 761~1280px 把搜索折成图标」的媒体块
  // （搜索恒为纯图标后该块失去目标），761 剩 1 处、1280 整档退场。
  // v0.149.1：免责声明手机布局新增一处 700px 断点。
  [520, 3], [560, 1], [700, 4], [760, 14], [761, 1],
  [800, 1], [820, 1], [900, 4], [901, 1], [980, 3],
]);
const mediaHeads = styles.match(/@media[^{]*\{/g) || [];
const actualBreakpoints = new Map();
for (const head of mediaHeads) {
  for (const hit of head.matchAll(/(?:max|min)-width:\s*(\d+)px/g)) {
    const px = Number(hit[1]);
    actualBreakpoints.set(px, (actualBreakpoints.get(px) || 0) + 1);
  }
}
for (const [px, count] of expectedBreakpoints) {
  assert.equal(
    actualBreakpoints.get(px) || 0,
    count,
    `${px}px 断点应出现 ${count} 处，实际 ${actualBreakpoints.get(px) || 0} 处 —— 回退 em 时改错或漏改了`,
  );
}
for (const px of actualBreakpoints.keys()) {
  assert.ok(expectedBreakpoints.has(px), `出现了预期外的断点 ${px}px，请连同本表一起更新`);
}

// 3f. 设置页真的接了这个值（避免「模块写了但没人调」）
const prefsSrc = readSrc("src/uiPreferences.js");
assert.match(prefsSrc, /uiScale/, "uiPreferences 要认 uiScale 字段");
assert.match(prefsSrc, /applyUiScale/, "applyUiPreferences 里要真的调 applyUiScale");
const appearanceSrc = readSrc("src/views/settings/appearance.js");
assert.match(appearanceSrc, /UI_SCALE_LIMITS/, "设置页滑块的范围要读 UI_SCALE_LIMITS，不能手写数字");
assert.match(appearanceSrc, /界面缩放/, "设置页要有「界面缩放」这一行");

// 3g. 窄屏自适应不许「悄悄生效」：设置页要把实际生效值写出来，否则用户看到
//     「设了 100% 却比预期小」无从解释。提示语里的「本机宽度」必须是缩放前的
//     `window.innerWidth` —— 用 viewportWidth() 会读出生效后的基准宽度，提示语自己说反。
assert.match(appearanceSrc, /getAutoScaleFactor/, "设置页要提示窄屏自适应的实际生效值");
assert.match(appearanceSrc, /window\.innerWidth/, "提示语里的本机宽度要用缩放前的 innerWidth");
// ⚠️ 先剥注释再查：本页的注释里正写着「不是 viewportWidth()」这句解释，
//    不剥注释就会命中自己（这个坑在插件侧踩过一次，记在这里）。
const appearanceCode = appearanceSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");
assert.ok(!/viewportWidth/.test(appearanceCode), "设置页别用 viewportWidth()（那是生效后的宽度，会把提示语说反）");
const mainSrc = readSrc("src/main.js");
assert.match(mainSrc, /initUiScale\(\)/, "启动时要 initUiScale()，否则 resize 监听挂不上");

// 3f-2. 缩放动画接线（v0.54.0）：离散入口走动画、连续入口保持直设，透传链路不许断。
const prefsCode = prefsSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");
assert.match(
  prefsCode,
  /applyUiScale\(cfg\.uiScale,\s*\{\s*animate\s*\}\)/,
  "applyUiPreferences 必须把 animate 透传给 applyUiScale（否则设置页传了也白传）",
);
const appearanceAnimCode = appearanceSrc
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");
assert.ok(
  (appearanceAnimCode.match(/animate:\s*true/g) || []).length >= 3,
  "设置页至少 3 处离散入口（松手 change / 缩放档位按钮 / 界面预设）要传 animate: true",
);
assert.ok(
  appearanceAnimCode.includes("{ persist: false }") && !/persist:\s*false[^}]*animate/.test(appearanceAnimCode),
  "滑杆 input 拖动必须保持 persist:false 直设、不带动画（拖动本身就是连续输入）",
);

// 3f-3. 自定义缩放输入（v0.54.0）：4 个固定档位覆盖不到 110%/135% 这类中间值，要能直接敲数字。
assert.match(appearanceSrc, /type:\s*"number"/, "设置页要有数字输入框（自定义缩放）");
// 两个入口（input 预览 / change 落定）**都**要走同一判据。只查「出现过」是不够的：
// 实测变异「input 里改成就地判据、change 里保留调用」能漏过 —— 于是输入途中乱跳而测试全绿。
assert.ok(
  (appearanceSrc.match(/parseCustomScaleInput\(/g) || []).length >= 2,
  "自定义输入的 input 与 change 两个入口都要走 uiScale.js 的同一判据，不能就地再写一套",
);
// 落定只对 skip 短路 —— 把 clamp（越界）也一起跳过，就是「输了 999 松手后毫无反应」。
assert.match(appearanceAnimCode, /mode === "skip"/, "落定只对「真的没输入」短路，越界要照常夹取落盘");
// 预览只认 preview —— 对 clamp 也预览的话，敲「999」的前两下（9、99）会把界面拽到 80%。
assert.match(appearanceAnimCode, /mode !== "preview"/, "输入途中只预览区间内的值，越界不许预览");
assert.match(appearanceSrc, /pref-choice-custom/, "自定义输入要挂在档位组里（与 4 个固定档位同排）");
// 「是不是档位值」必须按 UI_SCALE_PRESETS 判：手写 80/100/125/150 的话，改档位时会漏改，
// 输入框就会在档位值上仍显示数字（或把自定义值当成档位）。
assert.match(appearanceAnimCode, /UI_SCALE_PRESETS\.some/, "「是否命中档位」要按 UI_SCALE_PRESETS 判，不能手写档位数字");
assert.ok(!/min:\s*"80"/.test(appearanceAnimCode), "自定义输入的范围要读 UI_SCALE_LIMITS，不能手写 80/150");
// 样式：输入框宽度写死（否则输入时整组宽度抽动）、档位组允许换行（极窄屏 5 项不许横向溢出）
assert.match(styles, /\.pref-choice-input\s*\{/, "styles.css 要有自定义缩放输入框的样式");
assert.match(styles, /\.scale-presets\s*\{[^}]*flex-wrap:\s*wrap/, "档位组要允许换行，否则极窄屏 5 项会横向溢出");

// 3f-4. 拖动稳定映射（v0.58.0）：「界面缩放」滑杆的拖动必须走 uiScale.js 的 dragStableScale
//       （pointerdown 冻结轨道 rect + 增量映射）。不许退回「input 直接采用浏览器原生值」——
//       那条路径有实测的几何正反馈回路：input 改 zoom → 轨道在指针下平移（每档 ~14px）→
//       浏览器按新几何重算值 → 值振荡（110↔80↔125↔95）→ 用户看到的「一闪一闪」。
assert.match(appearanceAnimCode, /dragStableScale/, "滑杆拖动必须走 dragStableScale（冻结几何增量映射），直接用原生值会振荡");
assert.match(appearanceAnimCode, /pointerdown/, "拖动会话从 pointerdown 冻结轨道 rect 开始");
assert.match(appearanceAnimCode, /pointercancel/, "pointercancel 也要结束会话（触摸被滚动接管时不许残留旧基准）");

console.log("PASS: UI scale normalization, custom-input parsing, zoom/vw-vh emission, animation interpolation and zoom-safety guards");
