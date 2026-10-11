/*
 * 内置插件「横幅」配色的共用测试工具（v0.190.0）。
 *
 * 背景：cppu-notify（教务 / 通知 / 一卡通）与 cppu-calendar 的失败横幅，过去是浅米黄硬编码，
 * 换主题、切深色、开 Nephele 都不跟随；现在统一改成主题令牌的 color-mix，
 * 所以测试不能再守「某个色值」，而要按 CSS 里真正写的百分比，把运行时可能出现的色板
 * 逐张代进去实算 WCAG 对比度。
 *
 * 色板矩阵 = 16 套主题 × 浅/深两套 + Nephele 浅/深 = 34 张。
 * 来源与 src/styles.css / theme-derived.css / nephele-settings.css 完全一致（生成物也一并读，
 * 所以「改了 styles.css 忘了重新生成」这类问题在这里也会现形）。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { hexToRgb, contrastRatio, parsePalettes } = createRequire(import.meta.url)("../../../tools/lib/theme-tokens.js");

export { contrastRatio };

/** 解析 `:root[...] { --a: b; ... }` 这类块，按选择器里的键归组 */
function blocksBy(cssText, pattern) {
  const out = {};
  const re = new RegExp(pattern, "g");
  let m;
  while ((m = re.exec(cssText))) out[m[1]] = Object.assign(out[m[1]] || {}, declarations(m[2]));
  return out;
}

function declarations(body) {
  const out = {};
  for (const d of String(body || "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
}

/**
 * 列出运行时可能出现的全部色板。
 * @param {(relPath: string) => string} read 读文件（相对 le-time-management/，如 "../src/styles.css"）
 * @returns {{label: string, tokens: Record<string,string>}[]}
 */
export function bannerPalettes(read) {
  const light = parsePalettes(read("../src/styles.css"));
  const derivedCss = read("../src/styles/theme-derived.css");
  const nepheleCss = read("../src/styles/nephele-settings.css");
  const lightFixes = blocksBy(derivedCss, ':root\\[data-theme="([\\w-]+)"\\]\\s*\\{([^}]*)\\}');
  const darkBlocks = blocksBy(derivedCss, ':root\\[data-theme="([\\w-]+)"\\]\\[data-theme-mode="dark"\\]\\s*\\{([^}]*)\\}');

  const out = [];
  for (const id of Object.keys(light)) {
    const fixed = Object.assign({}, light[id], lightFixes[id] || {});
    out.push({ label: `${id}(浅色)`, tokens: fixed });
    // night 是原生深色主题（色板本身即深色），不参与派生
    out.push({
      label: `${id}(深色)`,
      tokens: id === "night" ? Object.assign({}, fixed) : Object.assign({}, light[id], lightFixes[id] || {}, darkBlocks[id] || {}),
    });
  }

  const nepLight = declarations(/:root\[data-nephele-settings="on"\]\s*\{([^}]*)\}/.exec(nepheleCss)?.[1]);
  const nepDark = declarations(/:root\[data-theme-mode="dark"\]\[data-nephele-settings="on"\]\s*\{([^}]*)\}/.exec(nepheleCss)?.[1]);
  assert.ok(nepLight["--deep"] && nepLight["--panel"], "Nephele 浅色块必须给出 --deep / --panel");
  assert.ok(nepDark["--deep"] && nepDark["--panel"], "Nephele 深色块必须给出 --deep / --panel");
  out.push({ label: "nephele(浅色)", tokens: Object.assign({}, light.classic, nepLight) });
  out.push({ label: "nephele(深色)", tokens: Object.assign({}, light.classic, nepDark) });
  return out;
}

/** 解开 `var(--x)` → `var(--y)` → 十六进制 这类链（--card: var(--panel) 就靠它） */
export function resolveToken(tokens, name) {
  let value = tokens[name];
  for (let i = 0; i < 8 && typeof value === "string"; i++) {
    const m = /^var\((--[\w-]+)\)$/.exec(value.trim());
    if (!m || tokens[m[1]] === undefined) break;
    value = tokens[m[1]];
  }
  return value;
}

/** `color-mix(in srgb, A p%, B)` 对不透明色就是 sRGB 逐通道线性插值 */
export function mixHex(top, bottom, p) {
  const A = hexToRgb(top), B = hexToRgb(bottom);
  assert.ok(A && B, `color-mix 的输入必须是十六进制：${top} × ${bottom}`);
  const c = (k) => Math.round(A[k] * p + B[k] * (1 - p));
  return "#" + ["r", "g", "b"].map((k) => c(k).toString(16).padStart(2, "0")).join("");
}

/** 两个十六进制色的最大通道差（0–255）。守「横幅底色必须离它所在的那层底色足够远」——
 *  存在感不需要靠对比度标准，但也不能像 Nephele 那次一样只差 1 个通道（等于看不见）。 */
export function channelDelta(a, b) {
  const A = hexToRgb(a), B = hexToRgb(b);
  assert.ok(A && B, `通道差需要两个十六进制色：${a} × ${b}`);
  return Math.max(...["r", "g", "b"].map((k) => Math.abs(A[k] - B[k])));
}

/** 取一条 CSS 规则的声明表：优先匹配独占一行的规则（插件里的常规写法），取不到再退化成「第一次单独出现」——
 *  退化时必须排除选择器列表里的同名片段（`.cc-banner,.cc-banner-hint{box-sizing}` 这种），否则会取到错的规则。 */
export function ruleDecls(cssText, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = new RegExp(`^\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(cssText)?.[1]
    ?? new RegExp(`(?<![\\w,.-])${escaped}\\s*\\{([^}]*)\\}`, "m").exec(cssText)?.[1];
  assert.ok(body, `缺少样式规则 ${selector}`);
  return Object.fromEntries([...body.matchAll(/(?:^|;)\s*([\w-]+):([^;]+)/g)].map((m) => [m[1], m[2].trim()]));
}

/** 从 `color-mix(in srgb, var(--deep, #xxx) 12%, var(--panel))` 里取出令牌与百分比 */
export function colorMix(value) {
  const m = /color-mix\(in srgb,\s*var\((--[\w-]+)[^)]*\)\s+([\d.]+)%,\s*var\((--[\w-]+)/.exec(String(value || ""));
  return m ? { top: m[1], pct: Number(m[2]) / 100, bottom: m[3] } : null;
}
