/* v0.234.0 · 隐私展示模式（人脸模糊 / 数字 9 化 / 三维图全满）
 *
 * 三条腿：
 *   ① 9 化纯粹函数：个位 / 十位 / 百位 → 9，到底哪些串会被改、哪些必须原样。
 *   ② 真跑一遍 applyPrivacyMask：用最小 DOM 替身把 walker / 还原 / 跳过规则全走一遍
 *      （跳过规则是这功能最容易出错的地方 —— input 的值、代码块、URL 都不能被动）。
 *   ③ 接线守卫：设置分区、设置搜索索引、样式单、顶栏徽标、三维图锚点、人脸锚点。
 *
 * 为什么不用 jsdom：本仓库的测试全是零依赖 node:test 风格，这里只需要 TreeWalker +
 * closest 两个原语，手写替身比拉一个 DOM 实现更稳（也更快）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

/* ── ① 9 化纯粹函数 ─────────────────────────────────────────────────────── */
const { maskDigitsPreserveWidth, nineify } = await import("../src/privacyMask.js");

const mask = maskDigitsPreserveWidth;
assert.equal(mask("128"), "999", "每个数字位都变 9 —— 结果是全 9，不是原数字换个尾巴");
assert.equal(mask("1280"), "9999", "千位以上的数字不额外变 9，但个十百位都要变");
assert.equal(mask("2021005"), "9999999", "学号整串 9 化：2021005 / 2021009 / 2021013 都会落到同一个显示值，看不出原号");
assert.equal(mask("7"), "9", "单个数也一样（不是拼成 999）");
assert.equal(mask("999"), "999", "本来就是 9 的位不动");
assert.equal(mask("0000"), "9999", "0 也要 9 化 —— 全 0 的串最容易漏");
assert.equal(mask("87.5"), "99.9", "小数照常逐位处理");
assert.equal(mask("+86 138 0000 0000"), "+99 999 9999 9999", "分段数字都要处理");
assert.equal(mask("总共 3 个"), "总共 9 个", "混在中文里的数字一并处理");
assert.equal(mask("１２８"), "９９９", "全角数字按全角写回（宽度不变，不挤动排版）");
assert.equal(mask("2026-09-21"), "9999-99-99", "日期整体 9 化");
assert.equal(mask("没有数字"), "没有数字", "不含数字的串原样返回");
assert.equal(mask("v0.233.0"), "v9.999.9", "版本号这种数字也一律处理（展示模式不挑数据）");
assert.equal(mask(null), "", "非字符串输入不炸");
assert.equal(nineify("128"), "999", "nineify 与 maskDigitsPreserveWidth 是同一个函数");

/* ── ② DOM 替身 ─────────────────────────────────────────────────────────── */
/** 只实现被测代码真正用到的原语：querySelectorAll / closest / classList / nodeValue / isConnected。 */
function makeDom() {
  const all = [];
  const el = (tag, { parent = null, ...attrs } = {}) => {
    const classes = new Set();
    const node = {
      tagName: tag.toUpperCase(),
      _attrs: { ...attrs },
      parentElement: parent,
      children: [],
      textNodes: [],
      nodeValue: null,
      isConnected: true,
      get classList() {
        return {
          add: (...names) => names.forEach((n) => classes.add(n)),
          remove: (...names) => names.forEach((n) => classes.delete(n)),
          contains: (n) => classes.has(n),
        };
      },
      getAttribute: (name) => (name in node._attrs ? node._attrs[name] : null),
      setAttribute(name, value) { node._attrs[name] = String(value); },
      removeAttribute(name) { delete node._attrs[name]; },
      hasAttribute: (name) => name in node._attrs,
      closest(selector) {
        const parts = selector.split(",").map((s) => s.trim());
        for (let cur = node.parentElement; cur; cur = cur.parentElement) {
          const hit = parts.some((part) => {
            const attr = part.match(/^\[([a-zA-Z-]+)(?:=['"]([^'"]*)['"])?\]$/);
            if (!attr) return cur.tagName?.toLowerCase() === part.toLowerCase();
            if (!cur.hasAttribute(attr[1])) return false;
            return attr[2] === undefined || cur.getAttribute(attr[1]) === attr[2];
          });
          if (hit) return cur;
        }
        return null;
      },
      querySelectorAll(selector) {
        const parts = selector.split(",").map((s) => s.trim());
        return all.filter((candidate) => {
          if (candidate === node || !isInside(candidate, node)) return false;
          return parts.some((part) => {
            const attr = part.match(/^\[([a-z-]+)\]$/);
            return attr ? candidate.hasAttribute(attr[1]) : candidate.tagName === part.toUpperCase();
          });
        });
      },
      append(child) { child.parentElement = node; node.children.push(child); return child; },
      /** 只支持 SKIP_SELECTOR / FORM_SELECTOR 里出现的那几种写法（标签名与 [attr]）。
          按 DOM 语义从**自身**开始向上找 —— 从 parentElement 起步会漏掉「节点自己就是跳过容器」。 */
      closest(selector) {
        const parts = selector.split(",").map((s) => s.trim());
        for (let cur = node; cur; cur = cur.parentElement) {
          const hit = parts.some((part) => {
            const attr = part.match(/^\[([a-zA-Z-]+)(?:=['"]([^'"]*)['"])?\]$/);
            if (!attr) return cur.tagName?.toLowerCase() === part.toLowerCase();
            if (!cur.hasAttribute(attr[1])) return false;
            return attr[2] === undefined || cur.getAttribute(attr[1]) === attr[2];
          });
          if (hit) return cur;
        }
        return null;
      },
    };
    all.push(node);
    // parent / contenteditable 这类选项要走「建即挂」：漏挂会在树遍历里静默丢掉整棵子树。
    if (parent) parent.children.push(node);
    return node;
  };
  const isInside = (candidate, ancestor) => {
    for (let cur = candidate.parentElement; cur; cur = cur.parentElement) if (cur === ancestor) return true;
    return false;
  };
  /** 文本节点：nodeValue 之外啥也不需要。 */
  const text = (parent, value) => {
    const node = { nodeType: 3, nodeValue: value, parentElement: parent, parentNode: parent, isConnected: true };
    parent.textNodes.push(node);
    return node;
  };
  return { el, text, all };
}

const dom = makeDom();
const body = dom.el("body");
const plain = dom.el("div", { parent: body });
const plainText = dom.text(plain, "共 128 条 · 覆盖率 87%");

const skippedBox = dom.el("div", { parent: body, "data-privacy-skip": "" });
const skippedText = dom.text(skippedBox, "版本 v0.233.0");
const codeBox = dom.el("code", { parent: body });
const codeText = dom.text(codeBox, "const ANSWER = 42");

const input = dom.el("input", { parent: body });
const inputText = dom.text(input, "学号 2021005"); // 真 DOM 里 input 不可能有文本子节点，这里专门验「表单容器整棵跳过」

const editable = dom.el("div", { parent: body, contenteditable: "true" });
const editableText = dom.text(editable, "本人 1990 年生");

const face = dom.el("span", { parent: body, "data-private-face": "" });
const faceImg = dom.el("img", { parent: face });

/* 把 body 挂进文档替身：privacyMask 只看 document.body 的子树，body 自身当容器即可。 */
const rootNode = dom.el("html");
body.parentElement = rootNode;
rootNode.children.push(body);

globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
globalThis.document = {
  documentElement: rootNode,
  body,
  createElement: (tag) => dom.el(tag),
  createTreeWalker(scope, _whatToShow, filter) {
    const list = [];
    const collect = (node) => {
      /* 必须真跑 filter.acceptNode —— 替身忽略过滤器时，这棵树上的「跳过」全变成空断言，
         噪声来源（code 块里的数字、版本号）就会一路绿灯走完扫描。 */
      for (const child of node.textNodes) {
        if (!filter || filter.acceptNode(child) === globalThis.NodeFilter.FILTER_ACCEPT) list.push(child);
      }
      for (const child of node.children) collect(child);
    };
    collect(scope);
    let index = 0;
    return { nextNode: () => list[index++] || null };
  },
  querySelector: () => null,
  querySelectorAll: (selector) => body.querySelectorAll(selector),
};
globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };

const state = { settings: { ui: { privacyMask: false } } };
globalThis.window = {
  setTimeout: () => 1,
  clearTimeout: () => {},
  setInterval: () => 1,
  clearInterval: () => {},
  addEventListener: () => {},
  dispatchEvent: () => {},
};
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
// store.js → persistence.js 在非 Tauri 环境走 localStorage；这里给个空实现，
// 事件循环里那条 setTimeout 只会在测试退出前挂着。
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
if (typeof globalThis.setTimeout !== "function") globalThis.setTimeout = () => 1;

/* 引擎从 store 里读偏好（getUiPreferences）。这里把真实 store 用空种子初始化，
   再把 settings.ui.privacyMask 当开关拨 —— 与真机上「设置页写偏好」是同一条读路径。 */
const { initStore, getState } = await import("../src/store.js");
await initStore({ version: 1, tasks: [], blocks: [], settings: {}, plugins: {} });
assert.ok(getState()?.settings, "store 初始化失败（DOM/持久化替身没铺够）");
const setMaskPref = (value) => { getState().settings.ui = { ...(getState().settings.ui || {}), privacyMask: value }; };

/* ── ② 真跑一遍开 / 关 ──────────────────────────────────────────────────── */
const mod = await import("../src/privacyMask.js");
assert.equal(typeof mod.applyPrivacyMask, "function");
assert.equal(typeof mod.initPrivacyMask, "function");

// 关闭态：什么都不该动
setMaskPref(false);
mod.applyPrivacyMask();
assert.equal(plainText.nodeValue, "共 128 条 · 覆盖率 87%", "关着的时候文本不许被改");
assert.equal(face.classList.contains("privacy-blur"), false, "关着的时候人脸不许被模糊");

// 打开
setMaskPref(true);
mod.applyPrivacyMask();
assert.equal(rootNode.getAttribute("data-privacy-mask"), "on", "宿主属性要落在 <html> 上");
assert.equal(plainText.nodeValue, "共 999 条 · 覆盖率 99%", "普通文本里的数字要 9 化");
assert.equal(plain.classList.contains("privacy-masked"), true, "被改过的文本要挂 .privacy-masked");
assert.equal(skippedText.nodeValue, "版本 v0.233.0", "data-privacy-skip 子树整棵不动");
assert.equal(codeText.nodeValue, "const ANSWER = 42", "代码块不动（改数字会让示例代码对不上）");
assert.equal(inputText.nodeValue, "学号 2021005", "表单容器整棵跳过");
assert.equal(editableText.nodeValue, "本人 1990 年生", "可编辑区域不动 —— 改了会和用户输入打架");
assert.equal(face.classList.contains("privacy-blur"), true, "人脸要被标上模糊类");
assert.ok(faceImg, "人脸里的 img 不是 JS 的目标（CSS 统一处理）");

// 关回去：逐节点还原，不留痕迹
setMaskPref(false);
mod.applyPrivacyMask();
assert.equal(rootNode.getAttribute("data-privacy-mask"), "off", "关掉后宿主属性要变 off");
assert.equal(rootNode.getAttribute("data-privacy-full"), null, "关掉后三维图全满标记要撤掉");
assert.equal(plainText.nodeValue, "共 128 条 · 覆盖率 87%", "关掉后要还原成原值");
assert.equal(plain.classList.contains("privacy-masked"), false, "关掉后要摘掉 .privacy-masked");
assert.equal(face.classList.contains("privacy-blur"), false, "关掉后要摘掉模糊");

// 已被应用改写过的文本不许被旧值盖回去
setMaskPref(true);
mod.applyPrivacyMask();
const changed = "新任务 7 条";
plainText.nodeValue = changed;
setMaskPref(false);
mod.applyPrivacyMask();
assert.equal(plainText.nodeValue, changed, "还原只回写还停在 9 化值上的节点 —— 被改写过的文本不许回滚");

/* ── ③ 接线守卫 ─────────────────────────────────────────────────────────── */
const settings = read("../src/views/settings.js");
const appearance = read("../src/views/settings/appearance.js");
const mainJs = read("../src/main.js");
const shell = read("../src/shell.js");
const prefs = read("../src/uiPreferences.js");
const index = read("../src/settingsSearchIndex.js");
const css = read("../src/styles/privacy-mask.css");
const html = read("../index.html");
const helper = read("../src/privacyMask.js");

assert.match(settings, /\{ id: "privacy", create:/, "设置里要有独立分区（不然塞进「界面与交互」会淹掉）");
assert.match(appearance, /export function createPrivacyCard/, "隐私卡要有独立出口");
assert.match(appearance, /maskDigitsPreserveWidth\(sample\)/, "样例串要与实际实现同源算出来");
assert.match(mainJs, /initPrivacyMask\(\)/, "启动时要接上引擎");
assert.ok(/initPrivacyMask\(\);[\s\S]{0,200}renderShell/.test(mainJs) === false && /renderShell[\s\S]{0,400}initPrivacyMask\(\)/.test(mainJs),
  "initPrivacyMask 必须在 renderShell 之后 —— 它要扫刚挂上去的那棵树");
assert.match(prefs, /privacyMask: false/, "偏好默认关闭");
assert.match(prefs, /next\.privacyMask = next\.privacyMask === true/, "只有显式 true 才算开");
assert.match(prefs, /root\.dataset\.privacyMask = cfg\.privacyMask \? "on" : "off"/, "宿主属性由偏好落根");

// 设置搜索：分区必须在索引里，且标题是真的能在卡里找到的文案
assert.match(index, /privacy: \[\s*\n\s*\["隐私展示"/, "搜索索引要收新分区");
assert.match(index, /\["隐私展示模式",/, "开关那一行也要能被搜到");
assert.match(index, /privacy: "隐私展示"/, "分区中文名映射表要同步");
assert.match(appearance, /el\("h2", \{\}, "隐私展示"\)/, "索引标题「隐私展示」要真的出现在卡里");
assert.match(appearance, /toggleRow\("隐私展示模式"/, "索引标题「隐私展示模式」要真的出现在卡里");

// 三条规则各自的锚点都得在
assert.match(appearance, /人脸模糊/, "设置页要写清人脸会怎样");
assert.match(appearance, /三维图全满/, "设置页要写清三维图会怎样");
assert.match(shell, /quick-menu-avatar[\s\S]{0,80}data-private-face/, "快捷菜单头像是人脸锚点");
assert.match(shell, /class: "privacy-badge"/, "顶栏要有展示模式徽标");
assert.match(helper, /syncPrivacyBadge/, "徽标显隐要有出口函数");
assert.match(read("../public/plugins/dorm-duty/main.js"), /data-private-full/, "三维星图要有全满锚点");
assert.match(read("../public/plugins/inbox-drop/main.js"), /id-preview" data-private-face/, "本人截图预览算人脸锚点");

// 样式：ON 才生效、模糊用 filter、全满压住插件自身的三级选择器
for (const rule of [":root[data-privacy-mask=\"on\"] [data-private-face]", ".privacy-masked", "[data-private-full] .dd-bed.empty"]) {
  assert.ok(css.includes(rule), `样式单里缺少 ${rule}`);
}
assert.match(css, /filter: blur\(/, "人脸模糊必须用 filter（不改布局）");
assert.match(css, /pointer-events: none/, "模糊层不许吃掉点击（头像常常是按钮）");
assert.match(css, /!important/, "三维图全满要压住插件目录里排在其后的选择器");
assert.match(html, /styles\/privacy-mask\.css/, "index.html 要静态引一份（开着模式启动时首屏就位）");

console.log("PASS: 隐私展示模式 —— 数字 9 化（2021005 → 9999999）、人脸模糊、三维图全满、"
  + "跳过规则（input / 代码块 / 可编辑区 / data-privacy-skip）与关闭还原全部通过；设置分区与搜索索引已接线");
