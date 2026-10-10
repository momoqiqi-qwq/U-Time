import { readProductSource } from "./lib/read-product-source.mjs";
/*
 * 「保存完点一下横幅就跳到文件所在目录」的回归测试。
 *
 * 需求原文：「警大插件，下载附件后会弹出通知，点击该通知卡片即可跳转至附件所在的下载目录。」
 * 这条链路横跨四层，任何一层断了都是**静默**的（横幅照样弹，只是点下去没反应）：
 *
 *   插件 tide.notify(msg, { onClick })  →  ui.js toast 整卡可点
 *     →  pluginHost tide.assets.revealSaved  →  api.revealSavedFile
 *     →  Rust reveal_saved_file（校验路径确实在下载目录内）→ 系统文件管理器
 *
 * 三层验证：
 *  ① 行为：真跑 src/ui.js 的 toast()，用迷你 DOM 点卡片 / 敲键盘 / 点内部按钮，
 *     断言「整卡可点、键盘可达、不与 action 按钮打架、回调抛错也要收卡」。
 *  ② 接线：四层的名字必须逐层对得上（`revealSaved` ↔ `revealSavedFile` ↔
 *     `reveal_saved_file` ↔ generate_handler 注册）—— 少一层就是点了没反应。
 *  ③ 安全边界：真跑 Rust 的路径归属判定（rustc 单跑，没装 Rust 就跳过）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(here, "..");

const read = (rel, enc = "utf8") => readProductSource(path.join(appRoot, rel), enc);

/* ─────────────────────── 迷你 DOM ─────────────────────── */

class FakeText {
  constructor(text) { this.nodeType = 3; this._text = String(text); this.parentNode = null; }
  get textContent() { return this._text; }
  remove() { this.parentNode?.removeChild(this); }
}

class FakeNode {
  constructor(tag = "") {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this._classes = new Set();
    this._listeners = new Map();
    this.offsetHeight = 0;
    this.style = {
      cssText: "",
      setProperty: () => {},
      getPropertyValue: () => "",
    };
  }
  get className() { return [...this._classes].join(" "); }
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get classList() {
    const set = this._classes;
    return {
      contains: (c) => set.has(c),
      add: (...cs) => cs.forEach((c) => set.add(c)),
      remove: (...cs) => cs.forEach((c) => set.delete(c)),
      toggle: (c, on) => { const next = on === undefined ? !set.has(c) : !!on; if (next) set.add(c); else set.delete(c); return next; },
    };
  }
  setAttribute(key, value) { this.attrs[key] = String(value); if (key === "class") this.className = value; }
  getAttribute(key) { return key in this.attrs ? this.attrs[key] : null; }
  hasAttribute(key) { return key in this.attrs; }
  addEventListener(type, fn) { if (!this._listeners.has(type)) this._listeners.set(type, []); this._listeners.get(type).push(fn); }
  removeEventListener() {}
  append(...kids) {
    for (const kid of kids) {
      const real = kid && kid.nodeType ? kid : new FakeText(kid);
      real.parentNode?.children.splice(real.parentNode.children.indexOf(real), 1);
      this.children.push(real);
      real.parentNode = this;
    }
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
      this.parentNode = null;
    }
  }
  get textContent() { return this.children.map((c) => c.textContent ?? "").join(""); }
  /** 派发事件并按真 DOM 的规则向上冒泡 —— 卡片要能收到「点的是卡里的按钮」。 */
  fire(type, extra = {}) {
    const event = {
      type, target: this, currentTarget: this, defaultPrevented: false, isComposing: false,
      _stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this._stopped = true; },
      ...extra,
    };
    let node = this;
    while (node) {
      event.currentTarget = node;
      for (const fn of node._listeners.get(type) || []) fn(event);
      if (event._stopped) break;
      node = node.parentNode;
    }
    return event;
  }
  closest(selector) {
    const matches = (n) => selector.startsWith(".")
      ? !!n._classes?.has(selector.slice(1))
      : n.tagName === selector.toUpperCase();
    let node = this;
    while (node) {
      if (node.nodeType === 1 && matches(node)) return node;
      node = node.parentNode;
    }
    return null;
  }
  find(pred) {
    for (const child of this.children) {
      if (child.nodeType !== 1) continue;
      if (pred(child)) return child;
      const found = child.find(pred);
      if (found) return found;
    }
    return null;
  }
}

const toastsBox = new FakeNode("div");
globalThis.document = {
  body: new FakeNode("body"),
  documentElement: { dataset: { uiMotion: "reduced" } },
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => new FakeText(text),
  getElementById: (id) => (id === "toasts" ? toastsBox : null),
};
globalThis.window = {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};

const { toast, isSelfActivationKey } = await import("../src/ui.js");

/* ── ① 行为：整卡可点 ── */

let fired = 0;
const clickable = toast("已保存到下载目录：D:/Downloads/方案.pdf", {
  ms: 8000,
  onClickHint: "点击定位文件",
  onClick: () => { fired++; },
});

assert.ok(clickable.node.classList.contains("toast-clickable"),
  "带 onClick 的横幅必须有 .toast-clickable —— 光标与 hover 全靠它，没有就等于一句提示");
const hint = clickable.node.find((n) => n.classList.contains("toast-hint"));
assert.ok(hint, "整卡可点必须带 .toast-hint：用户得知道点下去会发生什么");
assert.equal(hint.textContent, "点击定位文件", "提示文案必须用调用方给的那句");
assert.equal(clickable.node.getAttribute("role"), "button", "整卡可点是交互元素，读屏器要知道");
assert.equal(clickable.node.getAttribute("tabindex"), "0", "整卡可点必须能 Tab 到，否则键盘用户用不了");

clickable.node.fire("click");
assert.equal(fired, 1, "点卡片要跑 onClick");
assert.equal(toastsBox.children.includes(clickable.node), false, "点完必须收卡，不能留着让人重复点");

/* 键盘：Enter / Space 与鼠标等价；别的键不许触发（否则 Tab 之外随便一按就跳走了）。 */
for (const key of ["Enter", " "]) {
  let hits = 0;
  const card = toast("键盘可达", { onClick: () => { hits++; } });
  const event = card.node.fire("keydown", { key });
  assert.equal(hits, 1, `${key === " " ? "空格" : "回车"}必须能触发整卡点击`);
  assert.equal(event.defaultPrevented, true, `${key === " " ? "空格" : "回车"}要 preventDefault，否则页面会跟着滚`);
}
{
  let hits = 0;
  const card = toast("其它键不触发", { onClick: () => { hits++; } });
  card.node.fire("keydown", { key: "a" });
  assert.equal(hits, 0, "只有 Enter / Space 算激活，普通字符键不能跳走");
}

/* 回调抛错也得把卡收掉：卡片留在那儿，用户会以为没点上，一直点。 */
{
  const card = toast("回调抛错", { onClick: () => { throw new Error("boom"); } });
  assert.throws(() => card.node.fire("click"), /boom/);
  assert.equal(toastsBox.children.includes(card.node), false, "onClick 抛错也必须收卡");
}

/* 与动作按钮共存：按钮走自己的动作，整卡不抢焦点也不重复触发。 */
{
  let actionHits = 0, clickHits = 0;
  const card = toast("带按钮的横幅", {
    onClick: () => { clickHits++; },
    action: () => { actionHits++; },
    actionLabel: "撤销",
  });
  assert.equal(card.node.getAttribute("role"), null,
    "卡里已有真按钮时不许把整卡也标成按钮 —— 嵌套交互元素会让读屏器念两次、键盘多一站");
  const button = card.node.find((n) => n.tagName === "BUTTON");
  assert.ok(button, "action 必须渲染出一颗按钮");
  button.fire("click", { target: button });
  assert.equal(actionHits, 1, "点按钮要跑 action");
  assert.equal(clickHits, 0, "点按钮不能再顺带跑一次 onClick");
}

/* 老调用方（没有 onClick）不许被改相：多一个类名或 role 都会动到现有横幅。 */
{
  const plain = toast("操作完成");
  assert.equal(plain.node.classList.contains("toast-clickable"), false, "没传 onClick 的横幅不许变成可点卡");
  assert.equal(plain.node.getAttribute("role"), null);
  assert.equal(plain.node.getAttribute("tabindex"), null);
  assert.equal(plain.node.find((n) => n.classList.contains("toast-hint")), null, "普通横幅不该出现点击提示");
}

/* isSelfActivationKey 的既有契约仍要成立（按钮与卡片共用它）。 */
assert.equal(isSelfActivationKey({ currentTarget: toastsBox, target: toastsBox, key: "Enter" }), true);
assert.equal(isSelfActivationKey({ currentTarget: toastsBox, target: {}, key: "Enter" }), false,
  "内部元素上的按键不该当成整卡激活");

/* ── ② 接线：四层名字必须逐层对得上 ── */

const ui = read("src/ui.js");
const host = read("src/pluginHost.js");
const api = read("src/api.js");
const rust = read("src-tauri/src/lib.rs");
const styles = read("src/styles.css");
const plugin = read("public/plugins/cppu-notify/main.js");
const guide = read("public/plugins/plugin-guide/plugin-development.md");

assert.match(api, /async revealSavedFile\(path\)[\s\S]{0,200}invoke\("reveal_saved_file", \{ path \}\)/,
  "api.js 必须有 revealSavedFile 并 invoke reveal_saved_file");

assert.match(host, /async revealSaved\(path\) \{\s*requirePermission\(man, pid, "ui"\);[\s\S]{0,120}api\.revealSavedFile/,
  "tide.assets.revealSaved 必须过 ui 权限闸门再调 api（漏权限就是未声明也能定位文件）");

assert.match(rust, /#\[tauri::command\]\s*fn reveal_saved_file\(app: AppHandle, path: String\)/,
  "Rust 侧必须有 reveal_saved_file 命令");
assert.match(rust, /reveal_saved_file,/, "reveal_saved_file 必须注册进 generate_handler，否则 invoke 直接报「命令不存在」");
assert.match(rust, /tauri_plugin_opener::reveal_item_in_dir/,
  "Windows 定位要走 SHOpenFolderAndSelectItems（reveal_item_in_dir）：只报路径不如直接选中文件");
/* 安全边界：调它的是插件，只能定位自己刚存下的东西 —— 范围必须卡在下载目录内。 */
assert.match(rust, /app\.path\(\)\.download_dir\(\)[\s\S]{0,160}app\.path\(\)\.app_data_dir\(\)/,
  "reveal_saved_file 必须把允许范围定在下载目录 / 应用数据目录上");
assert.match(rust, /path_within\(&target, &root\)/, "范围判定必须真的用上 path_within，不能只算不判");
assert.match(rust, /if !inside \{\s*return Err\("只能定位应用下载目录里的文件"/,
  "越界必须报错返回，不能「查了但还是打开」");
assert.match(rust, /fs::canonicalize\(raw\)\.map_err\(\|_\| "文件不存在或已被移动"/,
  "路径必须先 canonicalize 且要求存在：定位一个已被删掉/移走的路径只会让文件管理器报「找不到」");
assert.match(rust, /#\[cfg\(mobile\)\][\s\S]{0,200}当前平台不支持在文件管理器中定位文件/,
  "Android 没有「在文件夹里选中文件」，必须返回明确的不支持而不是静默失败");

assert.match(plugin, /function notifySaved\(msg, path\)[\s\S]{0,400}onClickHint: "点击定位文件"[\s\S]{0,300}tide\.assets\.revealSaved\(path\)/,
  "警大插件落盘后的横幅必须整卡可点并调 tide.assets.revealSaved");
assert.match(plugin, /const path = await tide\.assets\.saveBase64\(name, res\.body\);\s*notifySaved\(/,
  "附件下载成功那条横幅必须走 notifySaved（点一下定位到刚落盘的文件）");
assert.match(plugin, /notifySaved\(`成绩单图片已保存：\$\{path\}`, path\)/,
  "成绩单图片落盘那条横幅同样要能点 —— 同一个动作两套反应最容易被当成 bug");
assert.match(plugin, /请手动到下载目录查看/, "定位失败（Android）时必须把路径摊开给用户，不能点了没反应");

assert.match(guide, /tide\.assets\.revealSaved/, "插件开发文档必须写清 tide.assets.revealSaved 的用法");
assert.match(guide, /onClickHint/, "插件开发文档必须写清整卡可点横幅的写法");

/* ── 样式：可点这件事得看得见 ── */

const clickRules = styles.match(/\.toast-clickable[^{]*\{[^}]*\}/g) || [];
assert.ok(clickRules.length, "styles.css 必须有 .toast-clickable 规则");
assert.match(styles, /\.toast-clickable\s*\{[^}]*cursor:\s*pointer/,
  "可点横幅必须有 pointer 光标 —— 没有它用户只会以为那是一句提示");
assert.match(styles, /\.toast-clickable:hover\s*\{[^}]*background:/, "hover 要有反馈，否则桌面端完全看不出能点");
assert.match(styles, /\.toast-clickable:focus-visible\s*\{[^}]*outline:/, "键盘焦点必须可见（整卡可 Tab 到）");
assert.match(styles, /\.toast-clickable > span:first-child\s*\{[^}]*overflow-wrap:\s*anywhere/,
  "下载路径是一长串没有空格的字符，不换行会顶破 380px 的卡宽");
assert.match(styles, /\.toast-hint\s*\{[^}]*white-space:\s*nowrap/, "提示语不许被折成两行");

/* ── ③ 安全边界：真跑 Rust 的路径归属判定 ── */

function findRustc() {
  const candidates = [
    process.env.RUSTC,
    path.join(os.homedir(), ".rustup", "toolchains", "stable-x86_64-pc-windows-msvc", "bin", "rustc.exe"),
    path.join(os.homedir(), ".cargo", "bin", "rustc"),
    "rustc",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const rustc = findRustc();
if (!rustc) {
  console.log("SKIP: 未找到 rustc，跳过 path_within 实跑（装了 Rust 会自动生效）");
} else {
  // 原文切出这个纯函数再单跑：抄一份会随源码漂移，等于没测。
  const extracted = rust.match(/\nfn path_within\([\s\S]*?\n\}\n/)?.[0];
  assert.ok(extracted, "lib.rs 里找不到 fn path_within —— 锚点变了，请同步本测试");
  const harness = `${extracted}
fn main() {
    use std::path::Path;
    // 下载目录在、文件在里面 —— 必须放行
    assert!(path_within(Path::new(r"E:\\Downloads\\a.docx"), Path::new(r"E:\\Downloads")));
    assert!(path_within(Path::new(r"E:\\downLoads\\a.docx"), Path::new(r"E:\\Downloads")), "盘符/目录名大小写不该影响判定");
    assert!(path_within(Path::new(r"E:/Downloads/a.docx"), Path::new(r"E:/Downloads")), "正斜杠写法也要上算");
    // 前缀撞名不能放过：Downloads-old 不是 Downloads 的子目录
    assert!(!path_within(Path::new(r"E:\\Downloads-old\\a.docx"), Path::new(r"E:\\Downloads")));
    assert!(!path_within(Path::new(r"C:\\Windows\\System32\\drivers\\etc\\hosts"), Path::new(r"E:\\Downloads")));
    assert!(path_within(Path::new("/tmp/dl/a.txt"), Path::new("/tmp/dl")));
    assert!(!path_within(Path::new("/tmp/dl2/a.txt"), Path::new("/tmp/dl")));
    println!("path_within ok");
}
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "letime-reveal-"));
  const src = path.join(dir, "reveal.rs");
  const exe = path.join(dir, process.platform === "win32" ? "reveal.exe" : "reveal");
  fs.writeFileSync(src, harness, "utf8");
  const compiled = spawnSync(rustc, ["--edition", "2021", "-o", exe, src], { encoding: "utf8" });
  assert.equal(compiled.status, 0, `path_within 单跑编译失败：${compiled.stderr}`);
  const ran = spawnSync(exe, [], { encoding: "utf8" });
  assert.equal(ran.status, 0, `path_within 断言失败：${ran.stdout}${ran.stderr}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("PASS: 保存后点横幅定位文件（整卡可点 / 键盘可达 / 与按钮解耦 / 四层接线 / 路径范围实跑）");
