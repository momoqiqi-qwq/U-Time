#!/usr/bin/env node
// 把应用层的汉字 → 拼音首字母表复制一份给 cppu-notify 插件用。
//
// 为什么需要副本：插件跑在 public/plugins/ 下的静态文件里，由 pluginHost 在浏览器中加载，
// **不能 import le-time-management/src/ 的模块**（那个目录不随构建发布）。而"搜索支持首字母 /
// 简写"是硬要求，所以表必须随插件走一份。
//
// 事实源仍然是 le-time-management/src/pinyinInitial.js 的 PY_INITIAL_DATA 段（它自身由
// tools/gen-pinyin-initial.js 从 pinyin-pro 生成）。本脚本只做搬运 + 一致性校验：
//   node tools/gen-cppu-pinyin.js          写入
//   node tools/gen-cppu-pinyin.js --check  只校验（不一致退出 1）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SRC = path.join(ROOT, "le-time-management/src/pinyinInitial.js");
const OUT = path.join(ROOT, "le-time-management/public/plugins/cppu-notify/pinyin-initials.js");
const CHECK = process.argv.includes("--check");

const BEGIN = "/* ══ PY_INITIAL_DATA BEGIN";
const END = "/* ══ PY_INITIAL_DATA END";

const src = fs.readFileSync(SRC, "utf8");
const start = src.indexOf(BEGIN);
const end = src.indexOf(END);
if (start < 0 || end < 0 || end <= start) {
  console.error("✗ 在 src/pinyinInitial.js 里找不到 PY_INITIAL_DATA 段标记");
  process.exit(1);
}
// 只取「const PY_INITIAL_DATA = {...};」这一块：标记之间的说明性注释（多行）不搬，
// 否则会带出没有 /* 开头的注释续行，生成物直接语法错。
const table = /const PY_INITIAL_DATA = \{[\s\S]*?\n\};/.exec(src.slice(start, end))?.[0] || "";
if (!table) {
  console.error("✗ PY_INITIAL_DATA 段里没找到 const PY_INITIAL_DATA = {...};");
  process.exit(1);
}

const body = `// 本文件是生成物，勿手改：node tools/gen-cppu-pinyin.js（校验用 --check）
// 数据源：le-time-management/src/pinyinInitial.js 的 PY_INITIAL_DATA（由 pinyin-pro 生成）。
// 插件不能 import 应用层模块，所以首字母表随插件带一份；改表只改事实源再重跑生成器。
/* ══ PY_INITIAL_DATA BEGIN（生成物，勿手改） ══ */
${table}
/* ══ PY_INITIAL_DATA END ══ */

/** 汉字 → 首字母小写。多音字先到者胜（组按字母序枚举，结果稳定）。 */
const PY_INDEX = (() => {
  const map = new Map();
  for (const [letter, chars] of Object.entries(PY_INITIAL_DATA)) {
    for (const ch of chars) if (!map.has(ch)) map.set(ch, letter);
  }
  return map;
})();

/**
 * 取一段文字的拼音首字母串（小写）。表外汉字与符号直接跳过 ——
 * 姓名里基本不会出现生僻到查不到的字，个别跳过后仍能与相邻首字母连上。
 * 拉丁字母与数字原样保留（"王T" → "wt"）。
 */
export function initialsOf(text) {
  let out = "";
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0);
    if (code >= 65 && code <= 90) out += ch.toLowerCase();
    else if (code >= 97 && code <= 122) out += ch;
    else if (code >= 48 && code <= 57) out += ch;
    else {
      const letter = PY_INDEX.get(ch);
      if (letter) out += letter;
    }
  }
  return out;
}

/* 子序列判定：needle 的字符按序出现在 hay 里即可（"wt" ⊂ "wct"）。 */
function isSubsequence(needle, hay) {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i += 1;
    if (i >= needle.length) return true;
  }
  return i >= needle.length;
}

/**
 * 拉丁字母查询是否命中这段文字：
 * - 首字母串包含（"wct" ⊂ "王晨听"）
 * - 单字简写 / 跳字简写（子序列，"wt" ⊂ "wct"、"gjxjx" 里 "jxj" ⊂ "国家奖学金"）
 * 长度 1 只认包含，免得一个字母把整页人全捞出来。
 */
export function initialHit(text, latin) {
  const q = String(latin || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!q) return false;
  const ini = initialsOf(text);
  if (!ini) return false;
  if (ini.includes(q)) return true;
  return q.length >= 2 && isSubsequence(q, ini);
}
`;

if (CHECK) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (cur === body) {
    console.log("✓ 插件首字母表与事实源一致");
    process.exit(0);
  }
  console.error("✗ 插件的 pinyin-initials.js 与 src/pinyinInitial.js 不一致，重跑 node tools/gen-cppu-pinyin.js");
  process.exit(1);
}

fs.writeFileSync(OUT, body, "utf8");
console.log(`✓ 已生成 ${path.relative(ROOT, OUT)}（${Buffer.byteLength(body)} 字节）`);
