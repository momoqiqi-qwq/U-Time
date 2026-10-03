// 小程序静态校验：JSON 可解析、页面文件齐全、图标存在且 ≤40KB、WXML 无字面反斜杠n
// 用法：node tools/check-miniprogram.js
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let err = 0;
const bad = (msg) => { console.log("✗ " + msg); err++; };

function walk(dir, fn) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) { if (!["node_modules", ".git"].includes(f)) walk(p, fn); }
    else fn(p);
  }
}

// 1. 所有 JSON 可解析
walk(ROOT, (p) => {
  if (p.endsWith(".json")) {
    try { JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) { bad("JSON 解析失败: " + p + " " + e.message); }
  }
});

// 2. app.json 页面四件套 + tabBar 图标
const app = JSON.parse(fs.readFileSync(path.join(ROOT, "app.json"), "utf8"));
for (const pg of app.pages) {
  for (const ext of [".js", ".json", ".wxml", ".wxss"]) {
    if (!fs.existsSync(path.join(ROOT, pg + ext))) bad("缺文件: " + pg + ext);
  }
}
for (const it of app.tabBar.list) {
  for (const k of ["iconPath", "selectedIconPath"]) {
    const ip = path.join(ROOT, it[k]);
    if (!fs.existsSync(ip)) bad("缺图标: " + it[k]);
    else if (fs.statSync(ip).size > 40 * 1024) bad("图标超 40KB: " + it[k]);
  }
}
// tabBar 页面必须在 pages 里且在前
for (const it of app.tabBar.list) {
  if (!app.pages.includes(it.pagePath)) bad("tabBar 页面未注册: " + it.pagePath);
}

// 3. WXML 不允许出现字面「反斜杠 + n」
walk(ROOT, (p) => {
  if (p.endsWith(".wxml")) {
    const s = fs.readFileSync(p, "utf8");
    if (s.includes("\\n")) bad("WXML 含字面 反斜杠n: " + p);
  }
});

// 4. JS 里 require 的本地模块都存在
walk(ROOT, (p) => {
  if (!p.endsWith(".js")) return;
  const s = fs.readFileSync(p, "utf8");
  for (const m of s.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
    const target = path.resolve(path.dirname(p), m[1]);
    if (!fs.existsSync(target)) bad("require 找不到: " + m[1] + " (在 " + p + ")");
  }
});

// 5. 所有 JavaScript 可解析（不执行代码，不要求真实 wx/DOM）。
walk(ROOT, (p) => {
  if (!p.endsWith(".js")) return;
  try { new Function(fs.readFileSync(p,"utf8").replace(/^#![^\n]*\n/,"")); }
  catch (e) { bad("JS 语法错误: " + p + " " + e.message); }
});
function controllerSource(file, seen = new Set()) {
  if (seen.has(file)) return "";
  seen.add(file);
  const source = fs.readFileSync(file, "utf8");
  return source + [...source.matchAll(/\.\.\.require\(["'](\.[^"']+)["']\)/g)]
    .map(match => controllerSource(path.resolve(path.dirname(file), match[1]), seen)).join("\n");
}
for (const pg of app.pages) {
  const js = controllerSource(path.join(ROOT,pg+".js")), wxml = fs.readFileSync(path.join(ROOT,pg+".wxml"),"utf8");
  for (const match of wxml.matchAll(/(?:bind|catch)(?::)?[a-zA-Z]+\s*=\s*["']([A-Za-z_$][\w$]*)["']/g)) {
    if (!new RegExp("\\b" + match[1] + "\\s*(?:\\(|:)").test(js)) bad("未找到事件处理器: " + pg + " " + match[1]);
  }
}

// 6. 小程序版本必须与桌面 package.json 一致
try {
  const desktopPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "le-time-management", "package.json"), "utf8"));
  const appMeta = require(path.join(ROOT, "core", "appMeta.js"));
  if (appMeta.version !== desktopPkg.version) bad("小程序版本与桌面 package.json 不一致: " + appMeta.version + " != " + desktopPkg.version);
} catch (e) { bad("版本一致性校验失败: " + e.message); }

console.log(err ? "发现 " + err + " 个问题" : "✓ 静态校验全部通过");
process.exit(err ? 1 : 0);
