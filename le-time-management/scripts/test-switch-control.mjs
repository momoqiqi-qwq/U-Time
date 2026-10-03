import { readProductSource } from "./lib/read-product-source.mjs";
/*
 * 滑块开关（.switch）回归测试 —— v0.37.19「设置里的勾选框改滑块 + 详细描述去除」
 *
 * 三件事一起守：
 *   ① 配色：轨道 / 滑块头在 16 套主题 × 浅/深共 32 组下，滑块头与轨道的对比度都要 ≥3:1
 *      （WCAG 1.4.11 非文本对比度：认得出这是个开关、也知道滑块头在哪）。
 *   ② 结构：不再出现「两份互相打架的 .switch 样式」，也不再靠写死的 left 距离移动滑块头。
 *   ③ 覆盖：设置页与任务抽屉里所有「开/关」型勾选框都换成滑块；而**多选型**勾选框
 *      （插件批量删除、AI 每周几）必须**保持**勾选框 —— 它们不是开关，换成滑块是语义错误。
 *
 * 事实源：src/styles.css（浅色）、src/styles/theme-derived.css（深色，生成物）。
 * 配色权重从 styles.css 里解析出来，不在这里抄一份常量，避免两边漂移。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parsePalettes, contrastRatio, hexToRgb } = require("../../tools/lib/theme-tokens.js");

const read = (p) => readProductSource(new URL(p, import.meta.url), "utf8");
const stylesCss = read("../src/styles.css");
const derivedCss = read("../src/styles/theme-derived.css");

/* 剥掉注释的副本：注释里为了说明反例而写出的旧色值是允许的，规则体里出现才要拦。
 * （历史坑：mobileViewport.js 的注释里写了 user-scalable=no，结果被自己的 negative 断言拦下。） */
const css = stylesCss.replace(/\/\*[\s\S]*?\*\//g, "");

/* ── 1. 从 CSS 里取出「实际生效」的轨道配方 ── */
const switchRule = css.match(/\.switch\s*\{([^}]*)\}/);
assert.ok(switchRule, "styles.css 里找不到 .switch 主定义");
const switchBody = switchRule[1];

const mixMatch = switchBody.match(
  /background:\s*color-mix\(\s*in srgb\s*,\s*var\(--ink\)\s*([\d.]+)%\s*,\s*var\(--panel\)\s*\)/,
);
assert.ok(mixMatch, ".switch 关闭态轨道必须是 color-mix(in srgb, var(--ink) N%, var(--panel))，不许硬编码颜色");
const OFF_MIX = Number(mixMatch[1]) / 100;
assert.ok(OFF_MIX > 0 && OFF_MIX < 1, `轨道混合比例不合理：${OFF_MIX}`);

const afterRule = css.match(/\.switch::after\s*\{([^}]*)\}/);
assert.ok(afterRule, "styles.css 里找不到 .switch::after（滑块头）");
assert.match(afterRule[1], /background:\s*var\(--panel\)/,
  "滑块头必须用 var(--panel)：浅色下白、深色下深，才能同时压住中灰轨道和提亮后的强调色");

assert.match(switchBody, /appearance:\s*none/, "input.switch 必须去掉原生勾选框外观（appearance:none）");
assert.match(switchBody, /--switch-w:|width:\s*var\(--switch-w\)/, "尺寸要收敛到 --switch-* 变量");

/* 开态：两种宿主都要覆盖 —— button.switch.on 与 input.switch:checked */
assert.match(css, /:is\(\.switch\.on,\s*\.switch:checked\)\s*\{\s*background:\s*var\(--deep\)/,
  "开态轨道要同时认 .switch.on（插件按钮）和 .switch:checked（设置页勾选框）");

/* ── 2. 不许再有第二份 .switch 定义、也不许再用写死的 left 移动滑块头 ── */
const switchDefs = [...css.matchAll(/^\.switch\s*\{/gm)].length;
assert.equal(switchDefs, 1, `.switch 主定义应只有一处，实际 ${switchDefs} 处（曾经的 36×20 覆盖块要删掉）`);
const travelByLeft = [...css.matchAll(/\.switch[^{]*::after\s*\{[^}]*left:\s*\d+px[^}]*\}/g)].map((m) => m[0]);
assert.deepEqual(travelByLeft, [],
  `滑块头改用 transform 位移，不许再写死 left：\n  ${travelByLeft.join("\n  ")}`);
assert.match(css, /:is\(\.switch\.on,\s*\.switch:checked\)::after\s*\{\s*transform:\s*translateX/,
  "开态位移必须是 transform: translateX(calc(var(--switch-w) - var(--switch-h)))");

/* 旧版写死的轨道色 / 滑块头色不许回来 */
for (const hard of ["#D8D2C6"]) {
  assert.ok(!css.includes(hard), `不许再硬编码开关底色 ${hard}（深色模式下会亮得刺眼）`);
}
const hardKnob = [...css.matchAll(/\.switch::after\s*\{[^}]*background:\s*#/g)].map((m) => m[0]);
assert.deepEqual(hardKnob, [], "滑块头不许硬编码颜色，要用 var(--panel)");

assert.match(css, /prefers-reduced-motion[\s\S]{0,120}\.switch/,
  "减少动效时必须关掉滑块头的过渡");

/* 深色模式那条「压掉输入框硬编码底色」的 !important 规则必须排除 .switch。
 * 否则开关的轨道被整体刷成 var(--panel)（和滑块头同色），深色下开与关只剩滑块头位置、
 * 颜色完全分不出来 —— 这个 bug 静态断言看不出来，是实机 390px 探针量到轨道色 == 面板色才暴露的。 */
assert.match(css, /:root\[data-theme-mode="dark"\]\s*input:not\(\.switch\)/,
  '深色下压输入框底色的规则必须写成 input:not(.switch)，否则滑块开关会被一起刷成 --panel');

/* ── 3. 配色对比度：16 主题 × 浅/深 = 32 组 ── */
function blocksBy(cssText, pattern) {
  const out = {};
  const re = new RegExp(pattern, "g");
  let m;
  while ((m = re.exec(cssText))) {
    const decls = {};
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls[d[1]] = d[2].trim();
    out[m[1]] = Object.assign(out[m[1]] || {}, decls);
  }
  return out;
}
const light = parsePalettes(stylesCss);
const darkOverrides = blocksBy(derivedCss, ':root\\[data-theme="([\\w-]+)"\\]\\[data-theme-mode="dark"\\]\\s*\\{([^}]*)\\}');
const lightFixes = blocksBy(derivedCss, ':root\\[data-theme="([\\w-]+)"\\]\\s*\\{([^}]*)\\}');

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
/** color-mix(in srgb, a Wa, b) —— 无 alpha 时就是逐通道线性插值（CSS Color 5 对 srgb 的定义）。 */
function mixSrgb(a, b, weightA) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return "#" + hex2(A.r * weightA + B.r * (1 - weightA))
    + hex2(A.g * weightA + B.g * (1 - weightA))
    + hex2(A.b * weightA + B.b * (1 - weightA));
}
const channelSpread = (hex) => {
  const { r, g, b } = hexToRgb(hex);
  return Math.max(r, g, b) - Math.min(r, g, b);
};
const channelDelta = (a, b) => {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return Math.max(Math.abs(A.r - B.r), Math.abs(A.g - B.g), Math.abs(A.b - B.b));
};

const KNOB_MIN = 3;      // WCAG 1.4.11：认得出滑块头在哪
const NEUTRAL_MAX = 28;  // 关闭态轨道必须是中性灰（通道极差），不能是某个强调色
const STATE_MIN = 10;    // 开/关两个轨道不能是同一块颜色

const failures = [];
const seen = [];
for (const id of Object.keys(light)) {
  const lightTokens = Object.assign({}, light[id], lightFixes[id] || {});
  const darkTokens = id === "night" ? Object.assign({}, lightTokens) : darkOverrides[id];
  for (const [mode, tokens] of [["浅色", lightTokens], ["深色", darkTokens]]) {
    if (!tokens || !tokens["--panel"] || !tokens["--deep"] || !tokens["--ink"]) continue;
    const panel = tokens["--panel"];
    const deep = tokens["--deep"];
    const offTrack = mixSrgb(tokens["--ink"], panel, OFF_MIX);

    const knobOff = contrastRatio(offTrack, panel);
    const knobOn = contrastRatio(deep, panel);
    if (knobOff + 0.01 < KNOB_MIN) failures.push(`${id}(${mode}) 关闭态滑块头/轨道 ${knobOff.toFixed(2)} < ${KNOB_MIN}`);
    if (knobOn + 0.01 < KNOB_MIN) failures.push(`${id}(${mode}) 打开态滑块头/轨道 ${knobOn.toFixed(2)} < ${KNOB_MIN}`);

    const spread = channelSpread(offTrack);
    if (spread > NEUTRAL_MAX) failures.push(`${id}(${mode}) 关闭态轨道不够中性（通道极差 ${spread} > ${NEUTRAL_MAX}）：${offTrack}`);

    const stateDelta = channelDelta(offTrack, deep);
    if (stateDelta < STATE_MIN) failures.push(`${id}(${mode}) 开/关轨道几乎同色（通道差 ${stateDelta} < ${STATE_MIN}）`);

    seen.push(`${id}/${mode}`);
  }
}
assert.deepEqual(failures, [], `滑块开关配色不达标：\n  ${failures.join("\n  ")}`);
assert.equal(seen.length, Object.keys(light).length * 2,
  `配色必须覆盖全部主题的浅/深两套，实际只算了 ${seen.length} 组`);

/* ── 4. 用法：设置页 + 任务抽屉 + 收件箱全部换成滑块 ── */
const SWITCH_USERS = {
  "../src/views/settings.js": "设置主页（任务提醒 / 自动备份 / 系统级快捷键）",
  "../src/views/settings/appearance.js": "界面与交互 / 自定义背景",
  "../src/views/drawer.js": "任务抽屉的提醒开关",
  "../src/views/inbox.js": "收件箱自动化规则的启停开关",
};
for (const [file, what] of Object.entries(SWITCH_USERS)) {
  const src = read(file);
  assert.match(src, /import\s*\{[^}]*toggleSwitch[^}]*\}\s*from\s*["'][^"']*switchControl\.js["']/,
    `${file} 必须从 switchControl.js 引 toggleSwitch（${what}）`);
  assert.match(src, /toggleSwitch\(\{/, `${file} 必须真的用上 toggleSwitch（${what}）`);
  const raw = [...src.matchAll(/type:\s*"checkbox"/g)].length;
  assert.equal(raw, 0, `${file} 里还有 ${raw} 个手搓的 type:"checkbox"，应改用 toggleSwitch（${what}）`);
}

const controlSrc = read("../src/switchControl.js");
assert.match(controlSrc, /export\s+function\s+toggleSwitch/, "switchControl.js 必须导出 toggleSwitch");
assert.match(controlSrc, /export\s+const\s+SWITCH_CLASS\s*=\s*"switch"/, "switchControl.js 必须导出 SWITCH_CLASS = \"switch\"");
assert.match(controlSrc, /type:\s*"checkbox"/, "滑块的语义必须是原生 checkbox，不是 div 扮的");
assert.match(controlSrc, /role:\s*"switch"/, "滑块要带 role=\"switch\" 供读屏软件识别");

/* 多选型勾选框必须保持勾选框：它们不是开关，换成滑块反而是语义错误 */
const pluginSettings = read("../src/views/settings/plugins.js");
assert.match(pluginSettings, /type:\s*"checkbox"[\s\S]{0,200}plugin-select|plugin-select[\s\S]{0,200}type:\s*"checkbox"/,
  "插件批量选择是多选，必须保持勾选框");
const aiPanel = read("../src/views/aiAutomationPanel.js");
assert.match(aiPanel, /type:\s*"checkbox"/,
  "AI 自动任务的「每周几」是多选，必须保持勾选框");

/* 插件中心 / 插件市场的开关仍然是 <button class="switch">，不能因为这次改动断掉 */
assert.match(pluginSettings, /switch[\s\S]{0,80}plugin-enable-switch/, "插件启用开关必须继续用 .switch 类名");

/* ── 4.5 插件里的勾样式开关也要换成滑块（v0.40.0：番茄 / 学习通 / 微信推送）──
   这三个插件的开关都是「单值开/关」，不再是勾选框；多选型勾选框不在此列（见上）。
   插件拿不到 toggleSwitch 模块（插件沙箱只有 tide API），所以直接用全局 .switch 类 +
   role="switch"——语义仍是原生 checkbox，外观与设置页同一套 CSS。
   v1.7.0 微信推送例外：「推送内容」是 data-ms 的多选勾选框（时间块/任务截止/插件消息），
   多选必须保持 checkbox，统计裸开关前先剥掉。 */
const PLUGIN_TOGGLE_SOURCES = {
  "../public/plugins/pomodoro/main.js": { what: "番茄专注的提醒开关（提醒前弹窗 / 完成弹窗等）", multiSelect: [] },
  "../public/plugins/chaoxing-notify/main.js": { what: "学习通的「只看未读」与「保存登录信息」开关", multiSelect: [] },
  "../public/plugins/wechat-push/main.js": {
    what: "微信推送的启用开关（推送内容是多选勾选框，必须保持 checkbox）",
    multiSelect: ["data-ms="],
    /* v1.9.0 的插件级勾格是 DOM 建的（模板字符串里没有它的影子），按标记剥不掉。
       只放行「带 data-src 的那一颗」：它是多选型勾格的一格，不是开/关滑块。 */
    multiSelectDom: [/const cb = document\.createElement\("input"\);\s*cb\.type = "checkbox";\s*cb\.dataset\.src = s\.id;/g],
  },
};
for (const [file, cfg] of Object.entries(PLUGIN_TOGGLE_SOURCES)) {
  const what = cfg.what;
  const src = read(file);
  const hasSwitchClass = /class="[^"]*\bswitch\b[^"]*"/.test(src) || /className\s*=\s*"switch"/.test(src);
  const hasSwitchRole = /role="switch"/.test(src) || /setAttribute\(\s*"role"\s*,\s*"switch"\s*\)/.test(src);
  assert.ok(hasSwitchClass && hasSwitchRole,
    `${file} 至少要把勾选框换成 .switch 类 + role="switch" 的滑块（${what}）`);
  // 把「已是滑块」的两种写法挖掉之后，不许再剩任何裸 checkbox：
  //  a) 标签形态：带 switch 类的 <input> 整段挖掉
  //  b) DOM 形态：input.type = "checkbox" 后 200 字符内跟上 className = "switch" 的整对挖掉
  //  c) 多选型勾选框（multiSelect 列出的标记）整段挖掉——它们不是开关，允许用 checkbox
  let rest = src.replace(/<input[^>]*class="[^"]*\bswitch\b[^"]*"[^>]*>/g, "");
  rest = rest.replace(/input\.type\s*=\s*"checkbox";(?=[\s\S]{0,200}?input\.className\s*=\s*"switch";)/g, "");
  for (const marker of cfg.multiSelect) {
    rest = rest.replace(new RegExp(`<input[^>]*${marker}[^>]*>`, "g"), "");
  }
  for (const rx of cfg.multiSelectDom || []) rest = rest.replace(rx, "");
  const bare = [...rest.matchAll(/type\s*=\s*[\'"]checkbox[\'"]/g)].length;
  assert.equal(bare, 0, `${file} 里还有 ${bare} 个裸勾选框开关，应换成 .switch 滑块（${what}）`);
}

/* ── 5. 详细描述：删掉的必须真的删掉，保留的必须真的保留 ── */
/* 设置页的全部卡片源码。目录整体扫，不要手写文件清单 ——
 * v0.60.0 把「可选同步」拆成 settings/sync.js 时，写死的清单就让下面的标题守卫假失败了。 */
const SETTINGS_SOURCES = [
  read("../src/views/settings.js"),
  ...fs.readdirSync(new URL("../src/views/settings/", import.meta.url)).sort()
    .filter((f) => f.endsWith(".js"))
    .map((f) => read(`../src/views/settings/${f}`)),
  read("../src/views/aboutCard.js"),
  read("../src/views/aiAutomationPanel.js"),
  read("../src/shell.js"),
].join("\n");

const REMOVED = [
  "控制信息密度、文字、动效、手势和启动行为",
  "紧凑模式会减少卡片、导航和列表留白",
  "手机端底部导航栏的按钮高度与图标大小",
  "适合高分屏、远距离显示或更大字号需求",
  "减少动效可降低页面切换与按钮过渡",
  "关闭后顶部更清爽",
  "每次打开应用时的默认窗口大小",
  "选择固定页面，或继续上次离开的位置",
  "界面、插件、数据和同步集中在这里调整",
  "设置任务截止提醒的默认预警时间",
  "提醒在 U-Time运行期间触发",
  "完整备份、表格交换、日历交换和自动恢复点集中在这里",
  "适合 Nextcloud / 坚果云兼容 WebDAV",
  "桌面端即使应用不在前台也能呼出命令面板",
  "手机相机扫码 → 浏览器打开即可使用",
  "令牌已自动生成，随链接/二维码分发",
  "本地优先的时间管理工具",
  "安全提示：插件现在只保留总开关",
  "AI 仅获得应用内任务、时间块和收件箱摘要",
  "到点后 AI 只会执行时间管理白名单操作",
  "不会操作本地文件",
  "可以创建多个定时 AI 任务",
];
const reAdded = REMOVED.filter((text) => SETTINGS_SOURCES.includes(text));
assert.deepEqual(reAdded, [], `这些说明文字已按要求删除，不要加回来：\n  ${reAdded.join("\n  ")}`);

/* 反面：状态回显 / 空状态 / 标签类文案不能跟着一起删掉（删过头也是 bug） */
const MUST_KEEP = [
  "还没有自动恢复点。",
  "尚未发现任何插件。",
  "当前生效：",
  "读取中…",
];
const overDeleted = MUST_KEEP.filter((text) => !SETTINGS_SOURCES.includes(text));
assert.deepEqual(overDeleted, [], `这些是状态回显 / 空状态，不能一起删掉：\n  ${overDeleted.join("\n  ")}`);

/* 卡片的 <h2> 标题必须留着 —— 描述删掉后标题就是唯一的识别信息。
 * 注意要钉住 el("h2", {}, "X") 这个整体，不能只找字符串：分区导航的 label 里也有同样的字，
 * 只找字符串的话把标题改成空串也照样通过（变异测试抓出来过）。 */
for (const title of ["界面与交互", "任务提醒", "数据中心", "可选同步", "全局快捷键", "局域网联动", "主题", "插件", "关于 U-Time"]) {
  assert.ok(SETTINGS_SOURCES.includes(`el("h2", {}, "${title}")`),
    `设置卡片标题「${title}」丢了`);
}

/* 自定义背景已在 v0.55.0 移除：导航项、卡片标题、分区 id 都不许回来。
   只删卡片不删导航项的话，搜索「背景」仍会命中一个落到空白区的分类。 */
assert.ok(!SETTINGS_SOURCES.includes("自定义背景"),
  "「自定义背景」已移除，设置源码里不许再出现（导航项与卡片标题都要删干净）");
assert.ok(!/id:\s*"background"/.test(SETTINGS_SOURCES),
  "设置分区 id \"background\" 已移除，不许再出现在 settingEntries 里");

console.log(`PASS: 滑块开关（${seen.length} 组配色 ≥${KNOB_MIN}:1、设置页与任务抽屉全部改滑块、多选型勾选框未被误改、${REMOVED.length} 条详细描述已清除且状态文案保留）`);
