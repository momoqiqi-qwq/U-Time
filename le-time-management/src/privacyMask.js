/* ── 隐私展示模式（v0.234.0 · v0.245.0 补第四条）────────────────────────────
   屏摄 / 外发截图 / 投屏演示时，把「私人信息」就地模糊掉，不改动任何业务数据。
   四条规则（用户需求）：
     ① 人脸模糊：被标记的肖像元素加模糊滤镜（`data-private-face`）。
     ② 数据 9 化：屏幕上每一段数字，个位 / 十位 / 百位一律变 9 —— 按用户的话
        就是「每个数字位都成 9」，所以整串结果全 9：128 → 999、1280 → 9999、
        学号 2021005 → 9999999、87.5 → 99.9、2026-09-21 → 9999-99-99。
        （需求原文：「将所有数字的个位、十位、百位都变成 9」。）
     ③ 三维图全满：三维图（宿舍床位星图这种）整体画满观感，空位也按占用显示。
     ④ 校名模糊（v0.245.0）：屏幕上出现的「警大 / 警察大学 / 中国人民警察大学 /
        CPPU」一律就地模糊 —— 这四个字比学号更早暴露「截图里的人是谁」。
        （需求原文：「隐私模式将警大 2 个字也模糊掉」。）
     ⑤ 身份文字遮蔽（v0.279.0）：姓名、民族、学院、专业、班级这类**纯文字**身份字段
        既不含数字、也不含校名 —— 前四条一条都碰不到。学号被 9 化、校名被糊掉之后，
        一张截图上唯一还能读出「这是谁」的就剩这几行字（姓名 + 学院 + 班级等于点名）。
        所以插件给这些值打 `data-private-text`，CSS 整块糊掉，扫描时连子树一起跳过：
        糊掉的字不该再被 9 化，否则关掉模式还原出的是 9 化后的值。

   实现取「先渲染再处理」的追加层，不动任何业务渲染路径：
     · 数字：只扫**文本节点**并就地改写；原串存 WeakMap，关掉开关即可逐节点
       还原成干净文本（不留包裹层、不动 DOM 结构）。不碰属性，也不碰
       input / textarea 的值，因此不会改变任何可交互元素的状态。
     · 校名：模糊只能作用于**元素**，所以命中的那一段必须包一层 `<span
       data-private-word>`（纯文本节点没法只糊两个字符）。未命中的文本节点仍然
       走上面那条「就地改写、原样还原」的路，DOM 结构一点不变。
     · 人脸与三维图：CSS 单条规则命中，JS 一律不进扫描循环 —— 星图每帧在转、
       番茄钟每秒在刷，靠 querySelectorAll 去逐个加类会拖慢这两处。
     · 重扫走 MutationObserver + 时间节流：只扫本批新增的子树，1.2s 兜底全量一次。

   五条规则的分工：①②③④ 由宿主自己扫（不用插件知道），
   ⑤ 只能靠插件打标 —— 宿主分不清「防火工程学院」是身份还是业务数据，插件最清楚哪个值是姓名。

   已知取舍：整个应用一视同仁地 9 化 / 模糊校名（真机上要能一键验证），
   需要保留原值的区域用 `data-privacy-skip` 标记，扫描时整棵子树跳过。
   另外只处理**屏幕上的文本节点**：`title` / `aria-label` / `alt` 这类属性里的校名
   不动 —— 它们不在画面上，改了反而会弄坏无障碍名称与悬浮提示的语义。 */
import { getUiPreferences, setUiPreferences } from "./uiPreferences.js";

const HOST_ATTR = "data-privacy-mask";
/** ④ 校名模糊用的包裹层标记：CSS 认它，扫描也靠它整棵跳过（否则自己会把自己无限包下去）。 */
const WORD_ATTR = "data-private-word";
const WORD_CLASS = "privacy-word";
/** ⑤ 身份文字遮蔽：插件给「姓名 / 民族 / 学院 / 专业 / 班级」这类值打上它，CSS 整块糊。
    纯 CSS 属性选择器命中，JS 不进循环 —— 视图重建后属性还在，不需要重新标记。 */
export const TEXT_ATTR = "data-private-text";
/** 文本节点里的连续数字串（半角 + 全角，中文全角数字不能漏）。 */
const DIGIT_RUN_RE = /[0-9０-９]/;
const DIGIT_RUN_RE_G = /[0-9０-９]+/g;
/** 全角 0 的码位：9 化后按全角写回，宽度不变，排版不会被挤动。 */
const FULLWIDTH_ZERO = 0xff10;
const FULLWIDTH_NINE = "\uFF19";

/** ④ 要一起模糊掉的「能定位到具体学校」的词；长词在前，避免「警察大学」把
    「中国人民警察大学」截成两段。CPPU 走 i 开关：`CPPU · ACADEMIC CALENDAR`
    这种大写标题与 `jw.cppu.edu.cn` 这类小写域名一起命中。 */
export const SENSITIVE_WORDS = Object.freeze(["中国人民警察大学", "警察大学", "警大", "CPPU"]);
const WORD_SOURCE = SENSITIVE_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
/** 不带 g：`test()` 复用带 g 的正则会因 lastIndex 忽真忽假。 */
const WORD_TEST_RE = new RegExp(WORD_SOURCE, "i");

/** 扫描时整棵子树跳过的标记（隐私徽标、版本号区、代码块、URL、已包好的校名、已整块糊掉的身份值等）。 */
const SKIP_SELECTOR = `[data-privacy-skip],code,pre,kbd,samp,script,style,[${WORD_ATTR}],[${TEXT_ATTR}]`;
/** 这些容器里的文字是用户输入或表单状态，9 化会改坏表单语义、也可能与 value 打架。 */
const FORM_SELECTOR = "input,textarea,select,option,[contenteditable='true'],[contenteditable='']";
/** 重扫节流：连点 / 快速翻页时不至于每帧扫一遍。 */
const SCAN_COALESCE_MS = 180;
/** 兜底全量重扫周期：三维星图这类每帧重建的视图靠它收口。 */
const FULL_RESCAN_MS = 1200;
/** 一批里新增子树超过这个数，说明整片视图被替换了，直接全量扫更划算。 */
const FULL_RESCAN_BATCH = 24;

/** 节点 → { raw, masked }；WeakMap 不可迭代，另存一份键列表供还原时遍历。 */
const NODE_TEXT = new WeakMap();
const LIVE_NODES = new Set();
/** 校名包裹组：{ raw, parent, nodes }。nodes 是被替换上去的那串（文本 + span），
    还原时整段换回一个装着 raw 的文本节点 —— 还原与「怎么加的」严格互逆。 */
const WORD_GROUPS = new Set();
/** 一屏里被标记过模糊的肖像元素（仅在关闭模式时用一次，之后清空）。 */
const MARKED_FACES = new Set();

let observer = null;
let scanTimer = 0;
let fullTimer = 0;
let pendingRoots = [];
let active = false;

/** 单串 9 化：数字 0~8 逐位变 9（9 保持 9），非数字原样，全角仍写全角。 */
export function maskDigitsPreserveWidth(text) {
  const str = typeof text === "string" ? text : String(text ?? "");
  if (!DIGIT_RUN_RE.test(str)) return str;
  return str.replace(DIGIT_RUN_RE_G, (run) => {
    let out = "";
    for (const ch of run) {
      const code = ch.codePointAt(0);
      out += code >= FULLWIDTH_ZERO && code <= FULLWIDTH_ZERO + 9 ? FULLWIDTH_NINE : "9";
    }
    return out;
  });
}

/** 语义直白的别名：给测试与插件复用的「9 化」入口。 */
export const nineify = maskDigitsPreserveWidth;

/** 这段文字里有没有要模糊掉的校名。 */
export function hasSensitiveWord(text) {
  const str = typeof text === "string" ? text : String(text ?? "");
  return str.length > 0 && WORD_TEST_RE.test(str);
}

/** 按校名把一串文字切成 [{ text, word }]：word=true 的那几段要被包裹模糊。
    纯函数，不碰 DOM —— 测试与插件想自己算「哪几段该糊」都从这里走。 */
export function splitSensitiveWords(text) {
  const str = typeof text === "string" ? text : String(text ?? "");
  const parts = [];
  let last = 0;
  for (const m of str.matchAll(new RegExp(WORD_SOURCE, "gi"))) {
    if (m.index > last) parts.push({ text: str.slice(last, m.index), word: false });
    parts.push({ text: m[0], word: true });
    last = m.index + m[0].length;
  }
  if (!parts.length) return [{ text: str, word: false }];
  if (last < str.length) parts.push({ text: str.slice(last), word: false });
  return parts;
}

export function isPrivacyMaskOn() {
  return typeof document !== "undefined" && document.documentElement.getAttribute(HOST_ATTR) === "on";
}

function shouldScan(node) {
  const parent = node.parentElement;
  if (!parent) return false;
  const value = node.nodeValue;
  if (!value) return false;
  if (!DIGIT_RUN_RE.test(value) && !hasSensitiveWord(value)) return false;
  /* 输入框里的文本节点不属于「展示的数据」：contenteditable 富文本、select 的 option
     都走这条跳过；input 的 value 根本不是文本节点，天然不受影响。 */
  if (parent.closest(FORM_SELECTOR)) return false;
  return !parent.closest(SKIP_SELECTOR);
}

/** 校名包裹：把命中的那一段换成 `<span data-private-word>`，其余段落原样写回。
    返回是否真的包成了 —— 拿不到 DOM 原语时（测试替身不全）退回纯 9 化，不抛。 */
function wrapSensitiveWords(node, raw) {
  const doc = node.ownerDocument || (typeof document !== "undefined" ? document : null);
  const parent = node.parentNode;
  if (!doc || !parent || typeof doc.createDocumentFragment !== "function"
    || typeof doc.createTextNode !== "function" || typeof parent.replaceChild !== "function") return false;
  const frag = doc.createDocumentFragment();
  const nodes = [];
  let digitsChanged = false;
  for (const part of splitSensitiveWords(raw)) {
    const text = maskDigitsPreserveWidth(part.text);
    if (text !== part.text) digitsChanged = true;
    if (!part.word) {
      const textNode = doc.createTextNode(text);
      frag.appendChild(textNode);
      nodes.push(textNode);
      continue;
    }
    const span = doc.createElement("span");
    span.setAttribute(WORD_ATTR, "");
    if (span.classList && typeof span.classList.add === "function") span.classList.add(WORD_CLASS);
    span.textContent = text;
    frag.appendChild(span);
    nodes.push(span);
  }
  parent.replaceChild(frag, node);
  if (digitsChanged && parent.classList) parent.classList.add("privacy-masked");
  WORD_GROUPS.add({ raw, parent, nodes, maskedClass: digitsChanged });
  return true;
}

function scan(root) {
  if (!active || !root) return;
  const doc = root.ownerDocument || (typeof document !== "undefined" ? document : null);
  if (!doc || typeof doc.createTreeWalker !== "function" || typeof NodeFilter === "undefined") return;
  /* 新插进来的那段界面，属性也要一起遮 —— 光靠 applyPrivacyMask 只覆盖得到「打开模式那一刻」。 */
  maskPrivateAttrs(root);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (shouldScan(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  /* 先收集、再处理：命中校名的文本节点会被换成 [文本, span, 文本]，
     在 TreeWalker 迭代**途中**改树会让它的当前位置失效（下一跳直接 null），
     后半棵树就被静悄悄漏掉了。 */
  const targets = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!NODE_TEXT.has(node)) targets.push(node);
  }
  pruneWordGroups();
  for (const node of targets) {
    if (!node.parentNode) continue; // 这一批里已被换掉
    const raw = node.nodeValue;
    if (!raw) continue;
    if (hasSensitiveWord(raw)) {
      wrapSensitiveWords(node, raw);
      continue;
    }
    if (NODE_TEXT.has(node)) continue;
    const masked = maskDigitsPreserveWidth(raw);
    if (masked === raw) continue; // 本来就是全 9：无需标记，也不必记账
    NODE_TEXT.set(node, { raw, masked });
    LIVE_NODES.add(node);
    node.nodeValue = masked;
    const parent = node.parentElement;
    if (parent && parent.classList) parent.classList.add("privacy-masked");
  }
}

/** 视图整片重建后，旧包裹组里的节点已经不在文档上 —— 丢掉这些记录，别让 Set 一直长。 */
function pruneWordGroups() {
  if (!WORD_GROUPS.size) return;
  for (const group of WORD_GROUPS) {
    const alive = group.nodes.some((node) => node.isConnected !== false);
    if (!alive) WORD_GROUPS.delete(group);
  }
}

/** 还原：只回写「还停在 9 化值上」的节点，之后被应用改写过的文本不动。 */
function restore() {
  for (const node of [...LIVE_NODES]) {
    const rec = NODE_TEXT.get(node);
    LIVE_NODES.delete(node);
    if (!rec) continue;
    try {
      if (node.nodeValue !== rec.masked) continue;
      node.nodeValue = rec.raw;
      const parent = node.parentElement;
      if (parent && parent.classList) parent.classList.remove("privacy-masked");
    } catch { /* 文本节点已置空（.textContent = "" 的中间态）：跳过 */ }
  }
  restoreWords();
}

/** 校名包裹的还原：整段换回一个文本节点（与 wrapSensitiveWords 严格互逆）。 */
function restoreWords() {
  if (!WORD_GROUPS.size) return;
  const groups = [...WORD_GROUPS];
  WORD_GROUPS.clear();
  for (const group of groups) {
    const { parent, nodes, raw } = group;
    try {
      const intact = parent && nodes.length && nodes.every((node) => node.parentNode === parent);
      if (!intact) {
        // 上层已经重建过这段 DOM：只把残留的包裹层标记摘掉，绝不动别人的文本
        for (const node of nodes) node.classList?.remove?.(WORD_CLASS);
        if (group.maskedClass && parent?.classList) parent.classList.remove("privacy-masked");
        continue;
      }
      const doc = parent.ownerDocument || (typeof document !== "undefined" ? document : null);
      const textNode = doc?.createTextNode?.(raw);
      if (!textNode) continue;
      parent.replaceChild(textNode, nodes[0]);
      for (let i = 1; i < nodes.length; i += 1) parent.removeChild(nodes[i]);
      // 包裹时因为「这段里有数字也被 9 化」挂上去的记号，一起摘掉（否则关掉后那行仍偏淡）
      if (group.maskedClass && parent.classList) parent.classList.remove("privacy-masked");
    } catch { /* DOM 已卸载：跳过 */ }
  }
}

/* ⑤ 的属性面（v0.280.0）：CSS 只糊得了文字节点，糊不到属性 ——
   `title=` 悬浮提示、`aria-label=` 读屏播报、`alt=` 图片替代文本，里面照样能写出真名。
   这里在同一个跳过区范围内把它们换成固定串，关掉模式再按记录写回（与文本同一套纪律：
   只还原仍然停在我们写上去的那个值上的属性，应用自己改过的绝不覆盖）。 */
const PRIVATE_ATTRS = Object.freeze(["title", "aria-label", "alt"]);
const ATTR_MASK_TEXT = "已隐藏";
/** 元素 → { title: 原值, ... }；WeakMap 不可迭代，另存一份键列表供还原时遍历。 */
const ATTR_RECORDS = new WeakMap();
const ATTR_NODES = new Set();

/** ⑤ 属性面：把身份字段（含它所在的可交互按钮）上的提示文本换成占位串。 */
function maskPrivateAttrs(scope) {
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  const hosts = new Set();
  for (const holder of scope.querySelectorAll(`[${TEXT_ATTR}],[data-private-face]`)) {
    hosts.add(holder);
    /* 名字常被塞进「给 X 改名」这样的按钮 label 里 —— 属性挂在外层按钮上，
       只认 holder 自己会漏掉它。限定在这几个可交互标签里，避免一路走到页面容器上。 */
    const owner = holder.closest?.("button,a,label,summary");
    if (owner && owner !== holder) hosts.add(owner);
  }
  for (const host of hosts) {
    const targets = [host, ...host.querySelectorAll("[title],[aria-label],[alt]")];
    for (const el of targets) {
      if (ATTR_RECORDS.has(el)) continue;
      const rec = {};
      for (const name of PRIVATE_ATTRS) {
        const raw = el.getAttribute?.(name);
        if (raw == null || raw === "" || raw === ATTR_MASK_TEXT) continue;
        rec[name] = raw;
      }
      const names = Object.keys(rec);
      if (!names.length) continue;
      ATTR_RECORDS.set(el, rec);
      ATTR_NODES.add(el);
      for (const name of names) el.setAttribute(name, ATTR_MASK_TEXT);
    }
  }
}

function restorePrivateAttrs() {
  if (!ATTR_NODES.size) return;
  for (const el of [...ATTR_NODES]) {
    ATTR_NODES.delete(el);
    const rec = ATTR_RECORDS.get(el);
    ATTR_RECORDS.delete(el);
    if (!rec) continue;
    for (const name of Object.keys(rec)) {
      try {
        if (el.getAttribute?.(name) !== ATTR_MASK_TEXT) continue; // 应用自己改过：不盖回去
        el.setAttribute(name, rec[name]);
      } catch { /* 已卸载 */ }
    }
  }
}

function markFaces(scope) {
  for (const el of scope.querySelectorAll("[data-private-face]")) {
    el.classList.add("privacy-blur");
    MARKED_FACES.add(el);
  }
}

function unmarkFaces() {
  for (const el of MARKED_FACES) {
    try { el.classList.remove("privacy-blur"); } catch { /* 已卸载 */ }
  }
  MARKED_FACES.clear();
}

/** 一次性应用：装上 / 摘掉全部隐私标记。幂等，可重复调用（每次偏好变化调一次）。 */
export function applyPrivacyMask() {
  if (typeof document === "undefined") return;
  active = getUiPreferences().privacyMask === true;
  document.documentElement.setAttribute(HOST_ATTR, active ? "on" : "off");
  if (!active) {
    stopObserver();
    restore();
    restorePrivateAttrs();
    unmarkFaces();
    return;
  }
  markFaces(document);
  scan(document.body);
  maskPrivateAttrs(document);
  startObserver();
}

function flushScan() {
  scanTimer = 0;
  const roots = pendingRoots;
  pendingRoots = [];
  if (!active) return;
  if (roots.length >= FULL_RESCAN_BATCH) { scan(document.body); return; }
  for (const node of roots) {
    if (!node.isConnected) continue;
    // 元素节点整棵扫；文本节点只补自己那一个
    if (node.nodeType === 1) scan(node);
    else if (node.parentNode) scan(node.parentNode);
  }
}

function scheduleScan(roots) {
  pendingRoots.push(...roots);
  if (pendingRoots.length >= FULL_RESCAN_BATCH) { scan(document.body); pendingRoots = []; }
  if (!scanTimer) scanTimer = window.setTimeout(flushScan, SCAN_COALESCE_MS);
}

function startObserver() {
  if (observer || typeof MutationObserver !== "function" || typeof document === "undefined") return;
  observer = new MutationObserver((records) => {
    const roots = [];
    for (const rec of records) {
      if (rec.type === "characterData") { roots.push(rec.target); continue; }
      for (const node of rec.addedNodes) roots.push(node);
    }
    if (roots.length) scheduleScan(roots);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  fullTimer = window.setInterval(() => { if (active) scan(document.body); }, FULL_RESCAN_MS);
}

function stopObserver() {
  if (observer) { observer.disconnect(); observer = null; }
  if (scanTimer) { window.clearTimeout(scanTimer); scanTimer = 0; }
  if (fullTimer) { window.clearInterval(fullTimer); fullTimer = 0; }
  pendingRoots = [];
}

/** 样式单：设置页与顶栏徽标都靠它。同一 href 只插一次。 */
export function ensurePrivacyMaskStyles(href = "/src/styles/privacy-mask.css") {
  if (typeof document === "undefined") return null;
  const existing = document.querySelector(`link[data-privacy-mask-css="${href}"]`);
  if (existing) return existing;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.setAttribute("data-privacy-mask-css", href);
  document.head.appendChild(link);
  return link;
}

/** 顶栏徽标：开着展示模式时点亮，关掉即隐藏。 */
export function syncPrivacyBadge(root = document) {
  const badge = root.querySelector?.(".privacy-badge");
  if (!badge) return null;
  badge.hidden = getUiPreferences().privacyMask !== true;
  return badge;
}

export function initPrivacyMask() {
  if (typeof document === "undefined") return;
  ensurePrivacyMaskStyles();
  applyPrivacyMask();
  window.addEventListener("tide:ui-preferences-changed", () => {
    applyPrivacyMask();
    syncPrivacyBadge();
  });
  syncPrivacyBadge();
}

/** 设置页开关的写入口：写偏好后由 tide:ui-preferences-changed 回流到 applyPrivacyMask。 */
export function setPrivacyMask(enabled) {
  return setUiPreferences({ privacyMask: enabled === true });
}
