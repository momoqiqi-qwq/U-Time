/* v0.234.0 · 隐私展示模式（人脸模糊 / 数字 9 化 / 三维图全满 / 校名模糊）
 *
 * 四条腿：
 *   ① 9 化纯粹函数：个位 / 十位 / 百位 → 9，到底哪些串会被改、哪些必须原样。
 *   ② 校名纯粹函数：哪几个词要糊、长词优先、缩写不分大小写、别误伤兄弟院校。
 *   ③ 真跑一遍 applyPrivacyMask：用最小 DOM 替身把 walker / 包裹 / 还原 / 跳过规则全走一遍
 *      （跳过规则是这功能最容易出错的地方 —— input 的值、代码块、URL 都不能被动；
 *       而校名那条还要把文本节点换成 [文本, span, 文本]，替身不支持 replaceChild 就等于没测）。
 *   ④ 接线守卫：设置分区、设置搜索索引、样式单、顶栏徽标、三维图锚点、人脸锚点。
 *
 * 为什么不用 jsdom：本仓库的测试全是零依赖 node:test 风格，这里只需要 TreeWalker +
 * closest + replaceChild 三个原语，手写替身比拉一个 DOM 实现更稳（也更快）。
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

/* ── ② 校名纯粹函数 ─────────────────────────────────────────────────────── */
const {
  SENSITIVE_WORDS, hasSensitiveWord, splitSensitiveWords,
} = await import("../src/privacyMask.js");

assert.deepEqual([...SENSITIVE_WORDS],
  ["中国人民警察大学", "警察大学", "警大", "CPPU"],
  "长词必须排在短词前面 —— 否则「中国人民警察大学」会被先截成「警察大学」");
assert.equal(hasSensitiveWord("警大成绩"), true, "简称要命中");
assert.equal(hasSensitiveWord("就读于中国人民警察大学"), true, "全称要命中");
assert.equal(hasSensitiveWord("中国警察大学"), true, "「警察大学」是全称的子串，也要命中");
assert.equal(hasSensitiveWord("jw.cppu.edu.cn"), true, "缩写不分大小写（域名、抬头全大写标题都要吃住）");
assert.equal(hasSensitiveWord("中国人民公安大学"), false, "别把兄弟院校也糊了");
assert.equal(hasSensitiveWord("没有校名"), false, "普通文案不许误伤");
assert.equal(hasSensitiveWord(""), false, "空串不进正则");
assert.equal(hasSensitiveWord(null), false, "非字符串输入不炸");

assert.deepEqual(splitSensitiveWords("警大通知：中国人民警察大学 CPPU 校历").map((p) => [p.text, p.word]),
  [["警大", true], ["通知：", false], ["中国人民警察大学", true], [" ", false], ["CPPU", true], [" 校历", false]],
  "按命中位置切段：命中的段 word=true，其余原样带着");
assert.deepEqual(splitSensitiveWords("没有校名"), [{ text: "没有校名", word: false }], "没命中就整段返回");
assert.deepEqual(splitSensitiveWords(""), [{ text: "", word: false }], "空串给一个空段，调用方不必特判");
assert.equal(splitSensitiveWords("警大").every((p) => p.word), true, "整串都是校名时不留空段");
assert.equal(splitSensitiveWords("警大警大").length, 2, "同一行出现两次要分成两段（只糊这两处，不是整行）");

/* ── ③ DOM 替身 ─────────────────────────────────────────────────────────── */
/** 只实现被测代码真正用到的原语：querySelectorAll / closest / classList / nodeValue / isConnected，
    外加「校名包裹」必须的 replaceChild / removeChild / createDocumentFragment / createTextNode。 */
function makeDom() {
  const all = [];
  const isInside = (candidate, ancestor) => {
    for (let cur = candidate.parentElement; cur; cur = cur.parentElement) if (cur === ancestor) return true;
    return false;
  };
  /** 维护三个视图的次序：childNodes 是唯一事实源，textNodes / children 由它派生。 */
  const reindex = (node) => {
    node.textNodes = node.childNodes.filter((c) => c.nodeType === 3);
    node.children = node.childNodes.filter((c) => c.nodeType !== 3);
  };
  const matchPart = (candidate, part) => {
    const attr = part.match(/^\[([a-zA-Z-]+)(?:=['"]([^'"]*)['"])?\]$/);
    if (!attr) return candidate.tagName?.toLowerCase() === part.toLowerCase();
    if (!candidate.hasAttribute(attr[1])) return false;
    return attr[2] === undefined || candidate.getAttribute(attr[1]) === attr[2];
  };
  const el = (tag, { parent = null, ...attrs } = {}) => {
    const classes = new Set();
    const node = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      _attrs: { ...attrs },
      parentElement: parent,
      parentNode: parent,
      childNodes: [],
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
      get textContent() {
        return node.childNodes
          .map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent))
          .join("");
      },
      /** 真 DOM 里赋 textContent 会把子节点全换成一个文本节点 —— 被测代码靠这个语义造包裹层。 */
      set textContent(value) {
        for (const c of node.childNodes) { c.parentNode = null; c.parentElement = null; }
        node.childNodes = [];
        reindex(node);
        const str = String(value ?? "");
        if (str) node.appendChild({ nodeType: 3, nodeValue: str, parentElement: null, parentNode: null, isConnected: true, get textContent() { return this.nodeValue; }, set textContent(v) { this.nodeValue = String(v ?? ""); } });
      },
      getAttribute: (name) => (name in node._attrs ? node._attrs[name] : null),
      setAttribute(name, value) { node._attrs[name] = String(value); },
      removeAttribute(name) { delete node._attrs[name]; },
      hasAttribute: (name) => name in node._attrs,
      /** 只支持 SKIP_SELECTOR / FORM_SELECTOR 里出现的那几种写法（标签名与 [attr]）。
          按 DOM 语义从**自身**开始向上找 —— 从 parentElement 起步会漏掉「节点自己就是跳过容器」。 */
      closest(selector) {
        const parts = selector.split(",").map((s) => s.trim());
        for (let cur = node; cur; cur = cur.parentElement) {
          if (parts.some((part) => matchPart(cur, part))) return cur;
        }
        return null;
      },
      querySelectorAll(selector) {
        const parts = selector.split(",").map((s) => s.trim());
        return all.filter((candidate) => {
          if (candidate === node || !isInside(candidate, node)) return false;
          return parts.some((part) => matchPart(candidate, part));
        });
      },
      appendChild(child) {
        if (child.nodeType === 11) { // DocumentFragment：拆开挂进去，它自己不留内容
          const kids = [...child.childNodes];
          child.childNodes = [];
          for (const kid of kids) node.appendChild(kid);
          return child;
        }
        child.parentElement = node;
        child.parentNode = node;
        node.childNodes.push(child);
        reindex(node);
        return child;
      },
      append(child) { return node.appendChild(child); },
      replaceChild(next, old) {
        const index = node.childNodes.indexOf(old);
        if (index < 0) return old;
        const incoming = next.nodeType === 11 ? [...next.childNodes] : [next];
        if (next.nodeType === 11) next.childNodes = [];
        node.childNodes.splice(index, 1, ...incoming);
        for (const c of incoming) { c.parentElement = node; c.parentNode = node; }
        old.parentNode = null;
        old.parentElement = null;
        reindex(node);
        return old;
      },
      removeChild(old) {
        const index = node.childNodes.indexOf(old);
        if (index < 0) return old;
        node.childNodes.splice(index, 1);
        old.parentNode = null;
        old.parentElement = null;
        reindex(node);
        return old;
      },
    };
    all.push(node);
    // parent / contenteditable 这类选项要走「建即挂」：漏挂会在树遍历里静默丢掉整棵子树。
    if (parent) parent.appendChild(node);
    return node;
  };
  /** 文本节点：nodeValue 之外只需要 parentNode / replaceChild 认得它。 */
  const text = (parent, value) => {
    const node = {
      nodeType: 3, nodeValue: value, parentElement: parent, parentNode: parent, isConnected: true,
      get textContent() { return node.nodeValue; },
      set textContent(v) { node.nodeValue = String(v ?? ""); },
    };
    if (parent) parent.appendChild(node);
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

/* ⑤ 身份文字（v0.279.0）：姓名 / 学院这类「既没有数字、也不含校名」的值，靠插件打标、
   CSS 整块糊。扫描器必须把它当跳过区 —— 已经把字糊掉了再去做 9 化，
   关掉模式时还原出来的就是 9 化后的值，等于把数据改坏。 */
const idTextBox = dom.el("span", { parent: body, "data-private-text": "" });
const idTextNode = dom.text(idTextBox, "张三");
const idTextMixed = dom.el("div", { parent: body, "data-private-text": "" });
const idTextMixedNode = dom.text(idTextMixed, "示例学院 示例专业");

/* ⑤ 的属性面（v0.280.0）：CSS 糊不到属性 —— title 悬浮提示、aria-label 读屏、alt 替代文本
   照样能把真名写出来。这三个要跟文字走同一套保存 / 还原纪律。 */
const attrBox = dom.el("button", {
  parent: body, "data-private-text": "", "aria-label": "给 张三 改名", title: "点击名字以改名",
});
const attrBoxText = dom.text(attrBox, "张三");
const attrImg = dom.el("img", { parent: body, "data-private-face": "", alt: "张三的照片" });

/* 校名相关的四个夹具：带数字的、不带数字的、跳过区里的、全称的。 */
const wordBox = dom.el("div", { parent: body });
const wordText = dom.text(wordBox, "警大成绩 87.5 分");
const pureWordBox = dom.el("h2", { parent: body });
const pureWordText = dom.text(pureWordBox, "警大通知");
const skippedWordBox = dom.el("div", { parent: body, "data-privacy-skip": "" });
const skippedWordText = dom.text(skippedWordBox, "警大 版本号区域");
const schoolBox = dom.el("p", { parent: body });
const schoolText = dom.text(schoolBox, "就读于中国人民警察大学");

/* 把 body 挂进文档替身：privacyMask 只看 document.body 的子树，body 自身当容器即可。 */
const rootNode = dom.el("html");
body.parentElement = rootNode;
rootNode.appendChild(body);

globalThis.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
globalThis.document = {
  documentElement: rootNode,
  body,
  createElement: (tag) => dom.el(tag),
  createTextNode: (value) => {
    const node = {
      nodeType: 3, nodeValue: String(value ?? ""), parentElement: null, parentNode: null, isConnected: true,
      get textContent() { return node.nodeValue; },
      set textContent(v) { node.nodeValue = String(v ?? ""); },
    };
    return node;
  },
  createDocumentFragment: () => {
    const frag = {
      nodeType: 11,
      childNodes: [],
      appendChild(child) { child.parentNode = frag; frag.childNodes.push(child); return child; },
    };
    return frag;
  },
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

/* ── ③ 真跑一遍开 / 关 ──────────────────────────────────────────────────── */
const mod = await import("../src/privacyMask.js");
assert.equal(typeof mod.applyPrivacyMask, "function");
assert.equal(typeof mod.initPrivacyMask, "function");

// 关闭态：什么都不该动
setMaskPref(false);
mod.applyPrivacyMask();
assert.equal(plainText.nodeValue, "共 128 条 · 覆盖率 87%", "关着的时候文本不许被改");
assert.equal(face.classList.contains("privacy-blur"), false, "关着的时候人脸不许被模糊");
assert.equal(wordText.nodeValue, "警大成绩 87.5 分", "关着的时候校名不许被包");

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

// ⑤ 身份文字：整块交给 CSS，扫描器一律跳过
assert.equal(idTextNode.nodeValue, "张三", "⑤ data-private-text 子树里的文字一个字符都不改（模糊是 CSS 的事）");
assert.equal(idTextMixedNode.nodeValue, "示例学院 示例专业",
  "⑤ 跳过区里的数字与校名都不处理 —— 整块已糊，改字只会让还原失真");

// ⑤ 属性面：提示文本同样不许露真名
assert.equal(attrBox.getAttribute("aria-label"), "已隐藏", "aria-label 里的真名要换成占位串（读屏会念出来）");
assert.equal(attrBox.getAttribute("title"), "已隐藏", "title 的悬浮提示也要换（鼠标一停就现原形）");
assert.equal(attrImg.getAttribute("alt"), "已隐藏", "人脸元素的 alt 同样处理");
assert.equal(attrBoxText.nodeValue, "张三", "属性被换掉不影响子树文字（文字交给 CSS 糊）");

// ④ 校名：只糊命中的那一段，其余文本照常 9 化，结构不散
assert.equal(wordText.parentNode, null, "原文本节点要被整段换掉（纯文本节点糊不了两个字符）");
const wordSpans = wordBox.children.filter((c) => c.nodeType === 1);
assert.equal(wordSpans.length, 1, "只包命中那一段，不许把整句都包进去");
const wordSpan = wordSpans[0];
assert.equal(wordSpan.getAttribute("data-private-word"), "", "包裹层要能被 CSS 认出来（空值属性）");
assert.equal(wordSpan.classList.contains("privacy-word"), true, "同时挂可读的类名供调试");
assert.equal(wordSpan.textContent, "警大", "包住的正是校名本身，一字不多");
assert.equal(wordBox.textContent, "警大成绩 99.9 分", "同一条里的数字照样 9 化 —— 两条规则叠加而不是二选一");
assert.equal(wordBox.classList.contains("privacy-masked"), true, "带数字的那段被改过，要挂上已遮蔽记号");

assert.equal(pureWordText.parentNode, null, "纯校名文本也要被包");
assert.equal(pureWordBox.textContent, "警大通知", "校名本身不改字符（只糊，不换字）");
assert.equal(pureWordBox.classList.contains("privacy-masked"), false, "这段没数字，不该挂 .privacy-masked");

assert.equal(skippedWordText.nodeValue, "警大 版本号区域", "data-privacy-skip 子树里的校名不糊");
assert.equal(skippedWordBox.children.filter((c) => c.nodeType === 1).length, 0, "跳过区不许被塞进包裹层");

assert.equal(schoolText.parentNode, null, "全称也要被替换成包裹层");
assert.equal(schoolBox.children.filter((c) => c.nodeType === 1).map((c) => c.textContent).join(""),
  "中国人民警察大学", "长词优先：全称一次包住，不拆成「中国人民 + 警察大学」");
assert.equal(schoolBox.textContent, "就读于中国人民警察大学", "包裹不改文字内容");

// 重复开：不二次包裹（否则每重扫一次就套一层壳，深度会一直长）
assert.equal(wordSpan.children.length, 0, "包裹层里不许再套一层 —— 它在扫描时是跳过区");
const childCount = wordBox.childNodes.length;
const spanCount = wordBox.children.length;
const totalWordMarks = body.querySelectorAll("[data-private-word]").length;
assert.equal(totalWordMarks, 3, "三处命中各一个包裹层");
mod.applyPrivacyMask();
assert.equal(wordBox.childNodes.length, childCount, "重扫不许再包一次（[data-private-word] 必须进跳过表）");
assert.equal(wordBox.children.length, spanCount, "包裹层数量不能翻倍");
assert.equal(body.querySelectorAll("[data-private-word]").length, totalWordMarks,
  "整棵树里的包裹层总数不许增长 —— 内层套娃在外层 children 上看不出来，得按总数卡");
assert.equal(wordBox.textContent, "警大成绩 99.9 分", "重扫后文本仍然正确");

// 关回去：逐节点还原，不留痕迹
setMaskPref(false);
mod.applyPrivacyMask();
assert.equal(rootNode.getAttribute("data-privacy-mask"), "off", "关掉后宿主属性要变 off");
assert.equal(rootNode.getAttribute("data-privacy-full"), null, "关掉后三维图全满标记要撤掉");
assert.equal(plainText.nodeValue, "共 128 条 · 覆盖率 87%", "关掉后要还原成原值");
assert.equal(plain.classList.contains("privacy-masked"), false, "关掉后要摘掉 .privacy-masked");
assert.equal(face.classList.contains("privacy-blur"), false, "关掉后要摘掉模糊");

assert.equal(wordBox.textContent, "警大成绩 87.5 分", "关掉后校名与数字都要还原成原文");
assert.equal(attrBox.getAttribute("aria-label"), "给 张三 改名", "关掉后 aria-label 要还原");
assert.equal(attrBox.getAttribute("title"), "点击名字以改名", "关掉后 title 要还原");
assert.equal(attrImg.getAttribute("alt"), "张三的照片", "关掉后 alt 要还原");
assert.equal(wordBox.childNodes.length, 1, "包裹层必须消失，不许留空壳");
assert.equal(wordBox.childNodes[0].nodeType, 3, "还原成一个纯文本节点（与包裹前严格互逆）");
assert.equal(wordBox.children.length, 0, "不许留 span");
assert.equal(wordBox.classList.contains("privacy-masked"), false, "关掉后要摘掉 .privacy-masked");
assert.equal(pureWordBox.textContent, "警大通知", "纯校名那段也要还原");
assert.equal(pureWordBox.childNodes.length, 1, "纯校名那段同样只留一个文本节点");
assert.equal(schoolBox.textContent, "就读于中国人民警察大学", "全称那段还原回一句话");

// 已被应用改写过的文本不许被旧值盖回去
setMaskPref(true);
mod.applyPrivacyMask();
const changed = "新任务 7 条";
plainText.nodeValue = changed;
setMaskPref(false);
mod.applyPrivacyMask();
assert.equal(plainText.nodeValue, changed, "还原只回写还停在 9 化值上的节点 —— 被改写过的文本不许回滚");

/* ── ④ 接线守卫 ─────────────────────────────────────────────────────────── */
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
assert.match(index, /\["校名模糊",/, "「校名模糊」这条要能被搜到（不然用户只会搜「学校 / 缩写」）");
assert.match(index, /privacy: "隐私展示"/, "分区中文名映射表要同步");
assert.match(appearance, /el\("h2", \{\}, "隐私展示"\)/, "索引标题「隐私展示」要真的出现在卡里");
assert.match(appearance, /toggleRow\("隐私展示模式"/, "索引标题「隐私展示模式」要真的出现在卡里");
assert.match(appearance, /校名模糊/, "索引标题「校名模糊」要真的出现在卡里");

// 四条规则各自的锚点都得在
assert.match(appearance, /人脸模糊/, "设置页要写清人脸会怎样");
assert.match(appearance, /三维图全满/, "设置页要写清三维图会怎样");
assert.match(appearance, /校名模糊/, "设置页要写清校名会怎样");
assert.match(appearance, /身份字段模糊/, "设置页要写清第五条（姓名/学院这类）会怎样");

/* ⑤ 身份文字的打标必须真的落在插件里 —— 房主测不到它，只能靠这几条锚点守着。
   宿主分不清「防火工程学院」是身份还是业务数据，漏一处就是一个真名原样露出。 */
assert.match(read("../public/plugins/cppu-notify/profile.js"), /<h2 data-private-text>/, "个人信息页姓名要打标");
assert.match(read("../public/plugins/cppu-notify/profile.js"), /pf-face" data-private-face/, "个人信息页头像算人脸锚点");
/* v0.281.0：「学生成长」并进「个人信息」，growth.js 不再存在 —— 原来那三块
   （校园生活 / 我的考勤 / 奖惩记录）现在画在 profile.js 里，打标口径必须跟着一起搬过来，
   别在合并时把成长数据的姓名/人脸锚点丢了。 */
const mergedProfile = read("../public/plugins/cppu-notify/profile.js");
assert.equal((mergedProfile.match(/data-private-text/g) || []).length >= 3, true,
  "合并后个人信息页要有多处 data-private-text（身份卡姓名 + 可复制字段值），别在合并时丢打标");
assert.match(mergedProfile, /我的考勤[\s\S]*暂无出勤记录/, "成长数据的考勤块要在这页里");
assert.match(mergedProfile, /奖惩记录[\s\S]*暂无奖惩记录/, "成长数据的奖惩块要在这页里");
assert.match(read("../public/plugins/cppu-notify/award-list.js"), /data-private-text/, "获奖名单的人名要打标（一屏几十个真名）");
assert.match(read("../public/plugins/dorm-duty/main.js"), /class="dd-bed-name" data-private-text/,
  "床位人名牌要打标（宿舍号 + 真人名的组合是最容易被认出来的）");
assert.match(shell, /quick-menu-avatar[\s\S]{0,80}data-private-face/, "快捷菜单头像是人脸锚点");
assert.match(shell, /class: "privacy-badge"/, "顶栏要有展示模式徽标");
assert.match(shell, /隐私展示模式已开启：人脸模糊、数字 9 化、三维图全满、校名模糊、身份字段模糊/, "徽标提示要列全五条");
assert.match(helper, /syncPrivacyBadge/, "徽标显隐要有出口函数");
assert.match(read("../public/plugins/dorm-duty/main.js"), /data-private-full/, "三维星图要有全满锚点");
assert.match(read("../public/plugins/inbox-drop/main.js"), /id-preview" data-private-face/, "本人截图预览算人脸锚点");

// 样式：ON 才生效、模糊用 filter、全满压住插件自身的三级选择器
for (const rule of [
  ":root[data-privacy-mask=\"on\"] [data-private-face]",
  ":root[data-privacy-mask=\"on\"] [data-private-text]",
  ":root[data-privacy-mask=\"on\"] [data-private-word]",
  ".privacy-masked",
  "[data-private-full] .dd-bed.empty",
]) {
  assert.ok(css.includes(rule), `样式单里缺少 ${rule}`);
}
assert.match(css, /filter: blur\(/, "人脸模糊必须用 filter（不改布局）");
assert.match(css, /pointer-events: none/, "模糊层不许吃掉点击（头像常常是按钮）");
assert.match(css, /!important/, "三维图全满要压住插件目录里排在其后的选择器");
assert.match(css, /\[data-private-word\] \{\s*\n\s*display: inline-block;\s*\n\s*filter: blur\(/,
  "校名那层也要用 filter（换字符会改宽度、断行与复制结果），且得给 filter 一个稳定渲染块");
assert.match(css, /:root\[data-privacy-mask="on"\] \[data-private-text\] \{[\s\S]{0,160}filter: blur\(/,
  "身份文字同样用 filter 糊，不换字符（关掉模式要能原样还原）");
assert.match(css, /:root\[data-privacy-mask="on"\] \[data-private-text\] \{[\s\S]{0,200}user-select: none/,
  "糊掉的字必须禁选 —— 拖选复制到原文等于白糊");
assert.match(html, /styles\/privacy-mask\.css/, "index.html 要静态引一份（开着模式启动时首屏就位）");

/* ── ⑤ v0.252.0 · 左下角一键关闭键 ────────────────────────────────────────
   需求原文：「开启隐私模式后，在左下角添加一个按钮，用于一键关闭该模式」。
   三条必须钉死的事：
     ① 它走 railActions 注册表（不是手写 DOM），否则拖拽重排会漏掉它；
     ② 显隐读**偏好**而不是宿主属性 —— renderShell 早于 initPrivacyMask，
        读 data-privacy-mask 会读到还没写上去的值（开机即开着模式 → 键不出现）；
     ③ 它自己必须 data-privacy-skip：整屏都被 9 化 / 糊校名时，这个入口不能跟着糊掉。 */
const layouts = read("../src/styles/feature-layouts.css");
assert.match(shell, /registerRailAction\(\{\s*\n\s*id: "privacy-off"/,
  "关闭键必须走注册表（id: privacy-off）");
assert.match(shell, /btn\.hidden = getUiPreferences\(\)\.privacyMask !== true/,
  "显隐必须由偏好驱动");
assert.match(shell, /btn\.setAttribute\("data-privacy-skip", ""\)/,
  "关闭键自己不许被打码（它是唯一固定入口）");
assert.match(shell, /setPrivacyMask\(false\)/, "点击必须真的把模式关掉（写偏好而不是改 DOM）");
assert.match(shell, /window\.addEventListener\("tide:ui-preferences-changed", sync\)/,
  "设置页开关也要能把它收回去（同一个事件源）");
assert.match(layouts, /\.rail-dock > \.rail-dock-btn\[hidden\] \{ display: none; \}/,
  "hidden 必须显式 display:none（.rail-bottom > button 的 display:flex 压得过 UA 的 [hidden]）");
// 它和深浅色键落在同一种磁贴上 ⇒ 图标色必须随主题反色（写死 #17323A 在深色下只有 1.07:1）
const mainCss = read("../src/styles.css");
assert.match(mainCss, /\.rail-bottom > \.privacy-off-btn \.ic \{ color: var\(--ink\); \}/,
  "关闭键的图标色要走 --ink（与 .theme-toggle-btn 同一条对比度根因）");
assert.match(mainCss, /\.rail-bottom > \.privacy-off-btn \.ic \.fa-ic,/,
  "FA 图标要单独给 15px 尺寸（app-icon 那条管不到它）");

console.log("PASS: 隐私展示模式 —— 数字 9 化（2021005 → 9999999）、人脸模糊、三维图全满、"
  + "校名模糊（警大 / 警察大学 / 中国人民警察大学 / CPPU 只糊命中段、长词优先、重扫不二次包裹）、"
  + "跳过规则（input / 代码块 / 可编辑区 / data-privacy-skip）与关闭还原全部通过；"
  + "设置分区、搜索索引与顶栏徽标已接线");
