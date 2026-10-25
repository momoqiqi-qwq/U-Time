// 生成学习通插件的「汉字 → 拼音首字母」压缩表，并注入两个目标文件的标记区：
//   1. le-time-management/public/plugins/chaoxing-notify/main.js（桌面 / Android WebView）
//   2. miniprogram/core/chaoxingCore.js（小程序原生端）
// 数据来源：pinyin-pro（含多音字全部读音，例：重 zhong/chong 都会进表，重庆可被 cq 命中）。
// 范围：U+4E00–U+9FA5 基本区；表外字符在搜索里退化为分隔符，不影响原文包含匹配。
//
// 用法：
//   NODE_PATH=$USERPROFILE/.workbuddy/binaries/node/workspace/node_modules node tools/gen-chaoxing-pinyin.js
//   （或先在任意位置 npm i pinyin-pro，再让 NODE_PATH 指向其 node_modules）
// 生成的片段落在每个文件的
//   /* ══ CX_PY_DATA BEGIN（本脚本生成，勿手改） ══ */
//   ... const CX_PY_DATA = { a: "阿啊...", ... };
//   /* ══ CX_PY_DATA END ══ */
// 之间；再次运行会整段替换，不会碰标记区外的任何代码。
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const TARGETS = [
  path.join(REPO, "le-time-management/public/plugins/chaoxing-notify/main.js"),
  path.join(REPO, "miniprogram/core/chaoxingCore.js"),
];
const BEGIN = "/* ══ CX_PY_DATA BEGIN（本脚本生成，勿手改） ══ */";
const END = "/* ══ CX_PY_DATA END ══ */";

function loadPinyinPro() {
  const candidates = [
    process.env.PINYIN_PRO_PATH,
    process.env.USERPROFILE
      && `${process.env.USERPROFILE}/.workbuddy/binaries/node/workspace/node_modules/pinyin-pro/dist/index.js`,
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return import(url.pathToFileURL(p).href);
  }
  throw new Error("找不到 pinyin-pro：请先安装并设置 PINYIN_PRO_PATH 或使用默认 NODE_PATH 路径");
}

const mod = await loadPinyinPro();
const { pinyin } = mod.default || mod; // CJS 互操作时 API 在 default 上

const groups = new Map(); // 首字母 -> Set(汉字)
for (let code = 0x4e00; code <= 0x9fa5; code++) {
  const ch = String.fromCodePoint(code);
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
/* 数据由 tools/gen-chaoxing-pinyin.js 生成（pinyin-pro，多音字全读音），改完重跑该脚本即可。
   覆盖 U+4E00–U+9FA5；按「首字母 → 汉字串」分组压缩，运行时懒加载成 Map。
   多音字在每个读音的首字母组里各出现一次（重 → zhong 组 + chong 组）。 */
const CX_PY_DATA = {
${dataLines.join(",\n")},
};
${END}`;

let total = 0;
for (const ini of letters) total += groups.get(ini).size;
console.log(`首字母组 ${letters.length} 个，收录读音 ${(total).toLocaleString()} 个（汉字 ${new Set([...groups.values()].flatMap(s => [...s])).size.toLocaleString()} 个，含多音字重复计）。`);

for (const file of TARGETS) {
  const src = fs.readFileSync(file, "utf8");
  const i = src.indexOf(BEGIN);
  const j = src.indexOf(END);
  if (i < 0 || j < 0 || j < i) {
    throw new Error(`${file} 缺少 ${BEGIN} / ${END} 标记，请先手工放入空标记区`);
  }
  fs.writeFileSync(file, src.slice(0, i) + snippet + src.slice(j + END.length), "utf8");
  console.log(`已注入 ${path.relative(REPO, file)}（数据 ${(snippet.length / 1024).toFixed(1)} KB）`);
}
