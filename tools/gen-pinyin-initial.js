// 生成「汉字 → 拼音首字母」压缩表，注入 le-time-management/src/pinyinInitial.js 的标记区。
//
// 用途：插件快捷键的自动分配字母（Alt + 插件中文名首字母，见 src/pluginShortcuts.js）。
//
// 与 tools/gen-chaoxing-pinyin.js 的关系：同一份数据来源（pinyin-pro，含多音字全部读音），
// 但**只保留 GB2312 可编码的常用字**（6768 字）—— 插件名都是常用词，收全表（U+4E00–U+9FA5
// 共 22973 字）会往核心 bundle 里塞 69 KB；过滤后 22 KB，常用字一个不少。
// 表外汉字（生僻字）解析不出首字母，插件退回「插件 ID 首字母」兜底，不会没有快捷键。
//
// 用法：
//   NODE_PATH=$USERPROFILE/.workbuddy/binaries/node/workspace/node_modules node tools/gen-pinyin-initial.js
//   node tools/gen-pinyin-initial.js --check   # 只校验生成物与事实源是否一致（不写盘）
// 生成的片段落在 src/pinyinInitial.js 的
//   /* ══ PY_INITIAL_DATA BEGIN（本脚本生成，勿手改） ══ */
//   ... const PY_INITIAL_DATA = { a: "阿啊...", ... };
//   /* ══ PY_INITIAL_DATA END ══ */
// 之间；再次运行会整段替换，不碰标记区外的任何代码（解析函数是手写的，在标记区外）。
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const TARGET = path.join(REPO, "le-time-management/src/pinyinInitial.js");
const BEGIN = "/* ══ PY_INITIAL_DATA BEGIN（本脚本生成，勿手改） ══ */";
const END = "/* ══ PY_INITIAL_DATA END ══ */";
const CHECK = process.argv.includes("--check");

function loadPinyinPro() {
  const candidates = [
    process.env.PINYIN_PRO_PATH,
    process.env.USERPROFILE
      && `${process.env.USERPROFILE}/.workbuddy/binaries/node/workspace/node_modules/pinyin-pro/dist/index.js`,
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return import(url.pathToFileURL(p).href);
  }
  throw new Error("找不到 pinyin-pro：请先安装并设置 PINYIN_PRO_PATH，或使用默认 NODE_PATH 路径");
}

/** GB2312 可编码的汉字集合 —— 用「解码反推」拿到，不需要额外的码表文件。 */
function gb2312Chars() {
  const dec = new TextDecoder("gb2312");
  const bytes = [];
  // 区 0xB0–0xF7（汉字区），位 0xA1–0xFE
  for (let hi = 0xb0; hi <= 0xf7; hi++) for (let lo = 0xa1; lo <= 0xfe; lo++) bytes.push(hi, lo);
  return new Set([...dec.decode(new Uint8Array(bytes))]);
}

const mod = await loadPinyinPro();
const { pinyin } = mod.default || mod; // CJS 互操作时 API 在 default 上

const common = gb2312Chars();
const groups = new Map(); // 首字母 -> Set(汉字)
let skipped = 0;
for (let code = 0x4e00; code <= 0x9fa5; code++) {
  const ch = String.fromCodePoint(code);
  if (!common.has(ch)) { skipped++; continue; }
  let readings;
  try {
    // 取完整音节再自己截首字母：pattern:'initial' 对零声母字（安/爱/二/欧…）返回空串会漏字。
    readings = pinyin(ch, { pattern: "pinyin", toneType: "none", multiple: true, type: "array" });
  } catch { continue; }
  for (const r of readings || []) {
    const ini = String(r || "").toLowerCase().charAt(0);
    if (!/^[a-z]$/.test(ini)) continue;
    if (!groups.has(ini)) groups.set(ini, new Set());
    groups.get(ini).add(ch);
  }
}

const letters = [...groups.keys()].sort();
const dataLines = letters.map((ini) => `  ${ini}: "${[...groups.get(ini)].join("")}"`);
const snippet = `${BEGIN}
/* 数据由 tools/gen-pinyin-initial.js 生成（pinyin-pro，多音字全读音；只收 GB2312 常用字），
   改完重跑该脚本即可。覆盖 6768 个常用汉字，按「首字母 → 汉字串」分组压缩，运行时懒建 Map。
   多音字在每个读音的首字母组里各出现一次（重 → zhong 组 + chong 组）。 */
const PY_INITIAL_DATA = {
${dataLines.join(",\n")},
};
${END}`;

let total = 0;
for (const ini of letters) total += groups.get(ini).size;
console.log(`首字母组 ${letters.length} 个，收录读音 ${total.toLocaleString()} 个；` +
  `GB2312 过滤掉生僻字 ${skipped.toLocaleString()} 个。`);

const src = fs.readFileSync(TARGET, "utf8");
const i = src.indexOf(BEGIN);
const j = src.indexOf(END);
if (i < 0 || j < 0 || j < i) {
  throw new Error(`${TARGET} 缺少 ${BEGIN} / ${END} 标记，请先手工放入空标记区`);
}
const next = src.slice(0, i) + snippet + src.slice(j + END.length);
// 报字节数而不是字符串长度 —— 汉字在 UTF-16 里是 1 个 code unit、UTF-8 里是 3 字节，
// 用 .length 报会少算 2/3（实测 7.6K 字符实为 24 KB），体积判断直接失真。
const sizeKB = (Buffer.byteLength(snippet, "utf8") / 1024).toFixed(1);

if (CHECK) {
  if (next === src) {
    console.log(`✓ pinyinInitial.js 与生成器一致（数据 ${sizeKB} KB）`);
  } else {
    console.error("✗ pinyinInitial.js 与生成器不一致，请重跑 node tools/gen-pinyin-initial.js");
    process.exit(1);
  }
} else {
  fs.writeFileSync(TARGET, next, "utf8");
  console.log(`已注入 ${path.relative(REPO, TARGET)}（数据 ${sizeKB} KB）`);
}
