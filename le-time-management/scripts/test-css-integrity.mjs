import { readProductSource } from "./lib/read-product-source.mjs";
/* CSS 完整性守卫（v0.58.0）。
 *
 * 为什么需要它 —— 一个**已随 v0.57.0 发出去**的真 bug：
 * `src/styles.css` 里那段讲 zoom 与断点的大注释，结尾被**整段复制了一遍**，
 * 于是第一个注释结束符提前把注释关掉，第二份正文裸露成了样式表正文：
 *
 *     属于独立改造，不要在这一版里顺手做。 <结束符>        ← 注释在这里就结束了
 *     这是本功能的**已知边界，不是缺陷**：……  <结束符>     ← 裸文本 + 孤儿结束符
 *     body { … }
 *
 * 浏览器把这段裸文本当成**选择器**往下吞，直到撞上 `body {` 的 `{`，
 * 于是整条选择器非法 ⇒ **`body` 规则被整条丢弃**。实测（无头 Chrome，同一份产物）：
 *
 *     有垃圾：fontFamily="Noto Sans SC"（兜底）  overflow=visible  color=rgb(0,0,0)
 *     清干净：fontFamily="Segoe UI","Microsoft YaHei",…  overflow=hidden  color=rgb(34,48,58)
 *
 * 也就是说：字体族、`overflow:hidden`、正文颜色全部静默失效，而且**没有任何报错** ——
 * 唯一线索是 vite 构建时 esbuild 的一句 `▲ [WARNING] Unexpected "*"`，很容易被刷过去。
 * 这段注释本身是 v0.55 之前的遗留，谁也没想到它会吃掉 body 规则。
 *
 * 两道闸门：
 *  1. **结构扫描**（本文件自带 tokenizer，零依赖）—— 根因就是「孤儿注释结束符」，
 *     所以直接查它，顺带查未闭合注释与花括号配平。这条**确定能抓住**上面那个 bug。
 *  2. **esbuild 解析告警为 0** —— 覆盖其它畸形 CSS（错位的声明、非法嵌套等）。
 *     ⚠️ 注意 esbuild 的**恢复能力比浏览器强**：它会在告警的同时照常输出 `body{…}`，
 *     所以「产物里还有 body 规则」**不能**当判据，只有**告警数**才有分辨力。
 *
 * 覆盖面：`src/` `public/` `miniprogram/` 下所有 `.css` / `.wxss`。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, "..");
const repoRoot = path.join(appRoot, "..");

/* ── 1. 结构扫描：孤儿结束符 / 未闭合注释 / 花括号配平 ── */

/**
 * 逐字符走一遍，跳过注释与字符串字面量（`content: "<结束符>"` 不能误报）。
 * 返回问题清单，每项形如 `L12: 孤儿结束符`。
 */
function scanStructure(text) {
  const issues = [];
  let i = 0;
  let depth = 0;
  let line = 1;
  let quote = null;

  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];

    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (quote) {
      if (c === "\\") { i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) {
        issues.push(`L${line}: 注释未闭合（开注释之后再无结束符）`);
        break;
      }
      line += (text.slice(i, end + 2).match(/\n/g) || []).length;
      i = end + 2;
      continue;
    }
    // 🔴 根因：注释外的结束符 —— 它意味着前面某个注释**提前闭合**了
    if (c === "*" && n === "/") {
      issues.push(`L${line}: 孤儿注释结束符（不在注释里 ⇒ 之前的注释提前闭合，裸文本会被当成选择器）`);
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth < 0) { issues.push(`L${line}: 多余的 }`); depth = 0; }
    }
    i++;
  }

  if (depth !== 0) issues.push(`文件末尾花括号不平衡（depth=${depth}）`);
  return issues;
}

function collectCssFiles() {
  const out = [];
  const walk = (p) => {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const e of fs.readdirSync(p)) walk(path.join(p, e));
      return;
    }
    if (/\.(css|wxss)$/.test(p)) out.push(p);
  };
  const roots = ["src", "public"].map((d) => path.join(appRoot, d)).concat([path.join(repoRoot, "miniprogram")]);
  for (const r of roots) walk(r);
  return out.sort();
}

const cssFiles = collectCssFiles();
assert.ok(cssFiles.length >= 10, `应扫到至少 10 个 CSS/WXSS 文件，实际 ${cssFiles.length}`);

const structuralIssues = [];
for (const f of cssFiles) {
  for (const msg of scanStructure(readProductSource(f, "utf8"))) {
    structuralIssues.push(`${path.relative(repoRoot, f)} ${msg}`);
  }
}
assert.deepEqual(
  structuralIssues,
  [],
  "CSS 结构异常（注释/花括号）—— 裸文本会被浏览器当成选择器吞掉后面的规则：\n  " +
    structuralIssues.join("\n  "),
);

/* ── 2. esbuild 解析告警必须为 0（样式表真的能被解析） ── */

const esbuild = await import("esbuild");
const styles = readProductSource(path.join(appRoot, "src/styles.css"), "utf8");
const parsed = await esbuild.transform(styles, { loader: "css", minify: true });

assert.deepEqual(
  parsed.warnings.map((w) => `${w.text} @L${w.location?.line}`),
  [],
  "src/styles.css 存在 esbuild 解析告警（畸形 CSS ⇒ 浏览器会丢弃整条规则）",
);
assert.deepEqual(parsed.errors ?? [], [], "src/styles.css 存在 esbuild 解析错误");

/* ── 3. 正面锚点：`body` 那条基础规则必须真的在产物里（不是被吞掉） ── */

// 它承载 font-family / font-size / overflow:hidden —— 被吞掉时页面外观静默走样，
// 所以除了「没有畸形」还要钉住「该在的确实在」。
// 注意排除 `html,body{height:100%}` 那条：它不含 font-family，不能拿来当锚点。
const bodyBlocks = [...parsed.code.matchAll(/(?:^|\})\s*body\s*\{([^}]*)\}/g)].map((m) => m[1]);
assert.ok(bodyBlocks.length > 0, "产物里找不到基础 `body { … }` 规则（可能被前面的裸文本吞掉了）");
const baseBody = bodyBlocks.find((b) => /overflow:\s*hidden/.test(b) && /font-family/.test(b));
assert.ok(
  baseBody,
  "基础 `body { … }` 规则里必须同时有 overflow:hidden 与 font-family —— 缺了说明这条规则被吞掉了",
);

console.log("PASS: test-css-integrity.mjs");
