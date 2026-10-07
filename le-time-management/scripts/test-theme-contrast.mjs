import { readProductSource } from "./lib/read-product-source.mjs";
/*
 * 主题对比度回归测试。
 *
 * 面向两条用户可见的诉求：
 *   ① 「深色模式下切换主题没用」→ 每套主题都必须有自己的深色变体，且彼此可区分。
 *   ② 「确保字体和背景颜色不能相似」→ 浅色 / 深色两套色板里，文字与底色的 WCAG 对比度都要过门槛。
 *
 * 事实源：src/styles.css（浅色）+ src/styles/theme-derived.css（派生，生成物）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { THEMES, getThemeProfile } from "../src/themeProfiles.js";
import { DARK_PREVIEW } from "../src/themeDarkPreview.js";

const require = createRequire(import.meta.url);
const {
  parsePalettes, renderDerivedCss, renderPreviewModule, contrastRatio,
  relativeLuminance, hexToRgb, deriveDark,
} = require("../../tools/lib/theme-tokens.js");

const read = (p) => readProductSource(new URL(p, import.meta.url), "utf8");
const stylesCss = read("../src/styles.css");
const derivedCss = read("../src/styles/theme-derived.css");
const pluginSrc = read("../public/plugins/cppu-notify/main.js");

/* ── 1. 生成物必须与事实源一致（防止改了 styles.css 忘了重新生成） ── */
const light = parsePalettes(stylesCss);
const expectedCss = "/* 本文件由 tools/gen-theme-dark.js 生成 */\n" + renderDerivedCss(light, { themeOrder: Object.keys(light) });
assert.equal(
  derivedCss, expectedCss,
  "styles/theme-derived.css 与 styles.css 不一致：请运行 node tools/gen-theme-dark.js",
);
const previewSrc = read("../src/themeDarkPreview.js");
assert.equal(
  previewSrc, renderPreviewModule(light, { themeOrder: Object.keys(light) }),
  "themeDarkPreview.js 与 styles.css 不一致：请运行 node tools/gen-theme-dark.js",
);

/* ── 2. 解析出「实际生效」的两套色板 ── */
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

const darkOverrides = blocksBy(derivedCss, ':root\\[data-theme="([\\w-]+)"\\]\\[data-theme-mode="dark"\\]\\s*\\{([^}]*)\\}');
const lightFixes = blocksBy(derivedCss, ':root\\[data-theme="([\\w-]+)"\\]\\s*\\{([^}]*)\\}');
const themeIds = Object.keys(light);

/* ── 3. 覆盖率：除 night（原生深色）外，每套主题都要有深色变体 ── */
for (const id of themeIds) {
  if (id === "night") continue;
  assert.ok(darkOverrides[id], `${id} 缺少深色变体：深色模式下换主题会没有反应`);
  const missing = ["--bg", "--panel", "--ink", "--ink-2", "--ink-3", "--deep", "--on-deep", "--on-accent"]
    .filter((k) => !darkOverrides[id][k]);
  assert.deepEqual(missing, [], `${id} 的深色变体缺少令牌：${missing.join(", ")}`);
}
for (const id of Object.keys(darkOverrides)) {
  assert.ok(light[id], `theme-derived.css 里有 styles.css 不存在的主题：${id}`);
}

/* ── 4. 对比度门槛 ── */
const LIGHT_MIN = { "--ink": 7, "--ink-2": 4.5, "--ink-3": 3.0, "--deep": 4.5, "--danger": 4.5 };
const DARK_MIN = { "--ink": 7, "--ink-2": 4.5, "--ink-3": 3.0, "--deep": 4.5, "--danger": 4.5 };
const DARK_ACCENTS = ["--sea", "--coral", "--sun", "--grape", "--mint", "--q1", "--q2", "--q3", "--q4"];

const failures = [];
const record = (where, label, fg, bg, need) => {
  const got = contrastRatio(fg, bg);
  if (got + 0.01 < need) failures.push(`${where} ${label} 对比度 ${got.toFixed(2)} < ${need}（${fg} on ${bg}）`);
  return got;
};

const darkPalettes = {};
for (const id of themeIds) {
  const lightTokens = Object.assign({}, light[id], lightFixes[id] || {});
  const darkTokens = id === "night" ? Object.assign({}, lightTokens) : darkOverrides[id];

  // 浅色：文字/底
  for (const [token, need] of Object.entries(LIGHT_MIN)) {
    if (!lightTokens[token]) continue;
    record(`${id}(浅色)`, token, lightTokens[token], lightTokens["--panel"], need);
    record(`${id}(浅色)`, `${token}/bg`, lightTokens[token], lightTokens["--bg"], need);
  }

  // 深色：文字/底
  for (const [token, need] of Object.entries(DARK_MIN)) {
    record(`${id}(深色)`, token, darkTokens[token], darkTokens["--panel"], need);
    record(`${id}(深色)`, `${token}/bg`, darkTokens[token], darkTokens["--bg"], need);
  }
  // 深色：强调色当文字用（标签、图标、链接）
  for (const token of DARK_ACCENTS) {
    if (!darkTokens[token]) continue;
    record(`${id}(深色)`, token, darkTokens[token], darkTokens["--panel"], 4.5);
  }
  // 深色：强调色当按钮底 → 上面的字必须能看
  record(`${id}(深色)`, "--on-deep", darkTokens["--on-deep"], darkTokens["--deep"], 4.5);
  for (const token of ["--sea", "--coral", "--sun", "--grape", "--mint", "--q4"]) {
    if (darkTokens[token]) record(`${id}(深色)`, `--on-accent/${token}`, darkTokens["--on-accent"], darkTokens[token], 3.0);
  }
  // 强调色当按钮底 → 上面的字必须能看（浅色主题用白字，night 与深色版用深字）
  record(`${id}(浅色)`, "--on-deep/--deep", lightTokens["--on-deep"], lightTokens["--deep"], 3.0);

  /* 分类色块上的文字（v0.55.0「一种类型一种颜色」）。
     --cat-* 的值是 var() 引用（这样才跟随主题与深浅色），断言前要解开这一层：
     声明永远取自浅色表（--cat-* 只在基础 :root 里写一次），
     内层 var(--sun) 之类的解析则要用当前模式那张表。
     历史坑：黄 / 红 / 青绿三种底色偏亮，白字只有 2.2~2.8:1 —— 所以 --cat-*-fg
     不是一律沿用 --on-accent，而是按实测选定。 */
  const resolveIn = (tokens, value) => {
    const m = /^var\((--[\w-]+)\)$/.exec(String(value || "").trim());
    return m ? tokens[m[1]] : value;
  };
  for (const cat of ["work", "study", "sport", "life", "rest"]) {
    const decl = lightTokens[`--cat-${cat}`];
    const declFg = lightTokens[`--cat-${cat}-fg`];
    assert.ok(decl && declFg, `${id} 缺少 --cat-${cat} / --cat-${cat}-fg（分类配色的事实源）`);
    const bgLight = resolveIn(lightTokens, decl), fgLight = resolveIn(lightTokens, declFg);
    assert.ok(hexToRgb(bgLight), `${id} 的 --cat-${cat} 解析后不是十六进制：${bgLight}`);
    assert.ok(hexToRgb(fgLight), `${id} 的 --cat-${cat}-fg 解析后不是十六进制：${fgLight}`);
    record(`${id}(浅色)`, `--cat-${cat}-fg`, fgLight, bgLight, 3.0);
    record(`${id}(深色)`, `--cat-${cat}-fg`, resolveIn(darkTokens, declFg), resolveIn(darkTokens, decl), 3.0);
  }

  // 深色模式真的得是深色，浅色模式真的得是浅色。night 是原生深色主题，不参与这组判断。
  if (id !== "night") {
    assert.ok(relativeLuminance(darkTokens["--bg"]) < 0.06, `${id} 的深色 --bg 不够深：${darkTokens["--bg"]}`);
    assert.ok(relativeLuminance(darkTokens["--panel"]) < 0.10, `${id} 的深色 --panel 不够深：${darkTokens["--panel"]}`);
    assert.ok(relativeLuminance(lightTokens["--bg"]) > 0.6, `${id} 的浅色 --bg 不够浅：${lightTokens["--bg"]}`);
    darkPalettes[id] = { bg: darkTokens["--bg"], deep: darkTokens["--deep"] };
  }
  assert.ok(hexToRgb(lightTokens["--ink"]) && hexToRgb(darkTokens["--ink"]), `${id} 的 --ink 必须是十六进制`);
}

// 附件面板背景与文字必须成对跟随主题，按样式引用的令牌实算全部主题和交互状态。
const attachmentRule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(pluginSrc)?.[1];
  assert.ok(body, `缺少附件样式 ${selector}`);
  return Object.fromEntries([...body.matchAll(/(?:^|;)\s*([\w-]+):([^;]+)/g)].map((m) => [m[1], m[2].trim()]));
};
const attachmentPanel = attachmentRule(".pp-att-list");
const attachmentTitle = attachmentRule(".pp-att-list>b");
const attachmentRow = attachmentRule(".pp-att");
const attachmentAction = attachmentRule(".pp-att-action");
const attachmentHover = attachmentRule(".pp-att:hover,.pp-att:focus-visible");
const attachmentToken = (value, palette) => {
  const token = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  assert.ok(token && palette[token], `附件颜色必须使用有效主题令牌：${value}`);
  return palette[token];
};
for (const id of themeIds) {
  const lt = Object.assign({}, light[id], lightFixes[id] || {});
  const dt = id === "night" ? lt : darkOverrides[id];
  for (const [mode, palette] of [["浅色", lt], ["深色", dt]]) {
    const bg = attachmentToken(attachmentPanel.background, palette);
    for (const [label, value] of [["文件名", attachmentRow.color], ["标题", attachmentTitle.color], ["下载", attachmentAction.color]]) {
      record(`${id}(${mode})`, `附件${label}`, attachmentToken(value, palette), bg, 4.5);
    }
    const hoverBg = attachmentToken(attachmentHover.background, palette);
    record(`${id}(${mode})`, "附件悬停/聚焦", attachmentToken(attachmentHover.color, palette), hoverBg, 4.5);
    record(`${id}(${mode})`, "附件悬停/聚焦下载", attachmentToken(attachmentAction.color, palette), hoverBg, 4.5);
  }
}

assert.deepEqual(failures, [], `对比度不达标：\n  ${failures.join("\n  ")}`);

/* ── 5. 每套主题的深色版必须彼此可区分（否则「换主题」等于没换） ── */
const fingerprints = new Map();
for (const [id, v] of Object.entries(darkPalettes)) {
  const key = `${v.bg}|${v.deep}`;
  assert.ok(!fingerprints.has(key), `${id} 的深色配色与 ${fingerprints.get(key)} 完全相同，换主题看不出区别`);
  fingerprints.set(key, id);
}
assert.equal(fingerprints.size, Object.keys(darkPalettes).length);

/* ── 6. 元数据侧：每套主题都要有深色预览色 ── */
for (const theme of THEMES) {
  assert.equal(theme.darkColors.length, 3, `${theme.id} 需要 3 个深色预览色`);
  assert.ok(Object.isFrozen(theme.darkColors), `${theme.id} 的深色预览色必须是冻结的`);
  assert.deepEqual([...theme.darkColors], DARK_PREVIEW[theme.id]);
}
assert.equal(getThemeProfile("night").darkColors.length, 3);

/* ── 7. 源码守卫：不许再把深色一律压成 night，也不许把深色规则绑死在 night 上 ── */
const themeSrc = read("../src/theme.js");
assert.doesNotMatch(themeSrc, /wantsDark\s*\)\s*return\s*"night"/, 'theme.js 不许再把所有主题在深色模式下压成 night');
assert.match(themeSrc, /root\.dataset\.themeMode\s*=\s*resolved\.mode/, "theme.js 必须把「解析后的 light/dark」写进 data-theme-mode");
assert.match(themeSrc, /resolveThemeMode/, "theme.js 需要 resolveThemeMode 处理「跟随系统」");

const darkRulesOnNight = [...stylesCss.matchAll(/:root\[data-theme="night"\][^{]*\{/g)].map((m) => m[0]);
assert.equal(darkRulesOnNight.length, 1,
  `除 night 自身的色板外，不应再有只对 night 生效的深色规则（否则换主题 / 跟随系统时会漏）：\n  ${darkRulesOnNight.join("\n  ")}`);
assert.match(stylesCss, /:root\[data-theme-mode="dark"\] input/, "输入控件的深色覆盖必须按 data-theme-mode 生效");

/* 危险色必须是令牌，不许再硬编码。
 * 历史坑：.plug-info .perr / .popmenu button.warn / .plugin-context-item.danger / .btn.danger
 * 写死 #B03535 / #c24141，深色面板上只有 1.4~1.9:1（右键「移除」、插件市场报错看不清）。 */
const hardcodedDanger = [...stylesCss.matchAll(/^[^\n]*color:\s*#(?:B03535|c24141)\b[^\n]*$/gim)].map((m) => m[0].trim());
assert.deepEqual(hardcodedDanger, [],
  `不许再硬编码危险色，请改用 var(--danger)：\n  ${hardcodedDanger.join("\n  ")}`);
assert.match(stylesCss, /\.plugin-context-item\.danger\s*\{\s*color:\s*var\(--danger\)/,
  "右键菜单的「移除」项必须用 var(--danger)");
assert.match(stylesCss, /\.popmenu button\.warn\s*\{\s*color:\s*var\(--danger\)/,
  "弹出菜单的告警项必须用 var(--danger)");

/* ── 8. deriveDark 是纯函数：同样输入必须同样输出 ── */
assert.deepEqual(deriveDark(light.classic), darkOverrides.classic);

/* ── 9. 内置插件的语义标签：深色模式必须自己把文字色翻亮 ──
 * 踩过的坑：cppu-notify 的教务视图注释写着「一律用主题变量，深色模式自动跟随」，
 * 但 .jw-tag.ok / .warn / .live 三个语义色仍是浅色硬编码（#0B6B60 / #8A6420 / #B42318）。
 * 压在深色标签底上实测只有 1.38~2.17:1 —— 「1 学分」这种 10.5px 小字几乎读不出。
 * 宿主 styles.css 的「内置插件深色兼容层」白名单里没有 .jw-* / .yk-*，兜不住这一族，
 * 所以插件侧必须自带 [data-theme-mode="dark"] 覆盖。这里按公式实算，不达 WCAG AA 就红。 */
/** color-mix(in srgb, A p%, B) 与 rgba 叠加都是 sRGB 通道线性插值，共用一个 blend */
const blend = (top, bottom, p) => {
  const A = hexToRgb(top), B = hexToRgb(bottom);
  const c = (k) => Math.round(A[k] * p + B[k] * (1 - p));
  return `#${["r", "g", "b"].map((k) => c(k).toString(16).padStart(2, "0")).join("")}`;
};
const MIX_RE = /color-mix\(in srgb,\s*var\((--[\w-]+)\)\s+([\d.]+)%,\s*var\((--[\w-]+)\)\)/;
const tagRules = [...pluginSrc.matchAll(/\[data-theme-mode="dark"\]\s*\.jw-tag\.(ok|warn|live)\s*\{([^}]*)\}/g)];
assert.equal(tagRules.length, 3, "三个语义标签都必须有 [data-theme-mode=\"dark\"] 覆盖");
const sunTextRules = [...pluginSrc.matchAll(/\[data-theme-mode="dark"\][^{]*\.yk-(?:status\.warn|spent b|ledger-row\.out b)[^{]*\{([^}]*)\}/g)];
assert.ok(sunTextRules.length >= 1, "一卡通的「已消费」文字色必须有深色覆盖");

for (const id of themeIds) {
  const lt = Object.assign({}, light[id], lightFixes[id] || {});
  const dt = id === "night" ? Object.assign({}, lt) : darkOverrides[id];
  for (const [, variant, body] of tagRules) {
    const bg = MIX_RE.exec(/background:([^;]*)/.exec(body)[1]);
    const fg = MIX_RE.exec(/(?:^|;)color:([^;]*)/.exec(body)[1]);
    assert.ok(bg && fg, `${id} 的 .jw-tag.${variant} 深色覆盖必须用 color-mix 成对给出底色与文字色`);
    const bgHex = blend(dt[bg[1]], dt[bg[3]], Number(bg[2]) / 100);
    record(`${id}(深色)`, `.jw-tag.${variant}`, blend(dt[fg[1]], dt[fg[3]], Number(fg[2]) / 100), bgHex, 4.5);
  }
  for (const [, body] of sunTextRules) {
    const fg = MIX_RE.exec(/color:([^;]*)/.exec(body)[1]);
    assert.ok(fg, `${id} 的 .yk-* 告警文字色必须用 color-mix 翻亮`);
    record(`${id}(深色)`, ".yk-* 告警文字", blend(dt[fg[1]], dt[fg[3]], Number(fg[2]) / 100), dt["--panel"], 4.5);
  }
}
/* 反向守卫：深色覆盖写好了，浅色那三个硬编码值也不许被顺手换成 var() ——
   浅色 --mint / --sun 直接当文字色只有 2~3:1，这正是本次要修的同一族问题。 */
for (const variant of ["ok", "warn", "live"]) {
  const lightRule = new RegExp(`^\\s*\\.jw-tag\\.${variant}\\{[^}]*color:#[0-9A-Fa-f]{6}`, "m").exec(pluginSrc);
  assert.ok(lightRule, `.jw-tag.${variant} 的浅色规则必须保留硬编码文字色（浅色下才达标）`);
}

assert.deepEqual(failures, [], `对比度不达标：\n  ${failures.join("\n  ")}`);

console.log(`PASS: 主题对比度（${themeIds.length} 套主题 × 浅/深两套色板 + 内置插件语义标签，均过 WCAG 门槛，深色版互不相同）`);
