/* ── 隐私展示模式（v0.234.0）──────────────────────────────────────────────
   屏摄 / 外发截图 / 投屏演示时，把「私人信息」就地模糊掉，不改动任何业务数据。
   三条规则（用户需求）：
     ① 人脸模糊：被标记的肖像元素加模糊滤镜（`data-private-face`）。
     ② 数据 9 化：屏幕上每一段数字，个位 / 十位 / 百位一律变 9 —— 按用户的话
        就是「每个数字位都成 9」，所以整串结果全 9：128 → 999、1280 → 9999、
        学号 2021005 → 9999999、87.5 → 99.9、2026-09-21 → 9999-99-99。
        （需求原文：「将所有数字的个位、十位、百位都变成 9」。）
     ③ 三维图全满：三维图（宿舍床位星图这种）整体画满观感，空位也按占用显示。

   实现取「先渲染再处理」的追加层，不动任何业务渲染路径：
     · 数字：只扫**文本节点**并就地改写；原串存 WeakMap，关掉开关即可逐节点
       还原成干净文本（不留包裹层、不动 DOM 结构）。不碰属性，也不碰
       input / textarea 的值，因此不会改变任何可交互元素的状态。
     · 人脸与三维图：CSS 单条规则命中，JS 一律不进扫描循环 —— 星图每帧在转、
       番茄钟每秒在刷，靠 querySelectorAll 去逐个加类会拖慢这两处。
     · 重扫走 MutationObserver + 时间节流：只扫本批新增的子树，1.2s 兜底全量一次。

   已知取舍：整个应用一视同仁地 9 化（真机上要能一键验证），
   需要保留原值的区域用 `data-privacy-skip` 标记，扫描时整棵子树跳过。 */
import { getUiPreferences, setUiPreferences } from "./uiPreferences.js";

const HOST_ATTR = "data-privacy-mask";
/** 文本节点里的连续数字串（半角 + 全角，中文全角数字不能漏）。 */
const DIGIT_RUN_RE = /[0-9０-９]/;
const DIGIT_RUN_RE_G = /[0-9０-９]+/g;
/** 全角 0 的码位：9 化后按全角写回，宽度不变，排版不会被挤动。 */
const FULLWIDTH_ZERO = 0xff10;
const FULLWIDTH_NINE = "\uFF19";
/** 扫描时整棵子树跳过的标记（隐私徽标、版本号区、代码块、URL 等）。 */
const SKIP_SELECTOR = "[data-privacy-skip],code,pre,kbd,samp,script,style";
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

export function isPrivacyMaskOn() {
  return typeof document !== "undefined" && document.documentElement.getAttribute(HOST_ATTR) === "on";
}

function shouldScan(node) {
  const parent = node.parentElement;
  if (!parent) return false;
  const value = node.nodeValue;
  if (!value || !DIGIT_RUN_RE.test(value)) return false;
  /* 输入框里的文本节点不属于「展示的数据」：contenteditable 富文本、select 的 option
     都走这条跳过；input 的 value 根本不是文本节点，天然不受影响。 */
  if (parent.closest(FORM_SELECTOR)) return false;
  return !parent.closest(SKIP_SELECTOR);
}

function scan(root) {
  if (!active || !root) return;
  const doc = root.ownerDocument || (typeof document !== "undefined" ? document : null);
  if (!doc || typeof doc.createTreeWalker !== "function" || typeof NodeFilter === "undefined") return;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (shouldScan(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (NODE_TEXT.has(node)) continue;
    const raw = node.nodeValue;
    const masked = maskDigitsPreserveWidth(raw);
    if (masked === raw) continue; // 本来就是全 9：无需标记，也不必记账
    NODE_TEXT.set(node, { raw, masked });
    LIVE_NODES.add(node);
    node.nodeValue = masked;
    const parent = node.parentElement;
    if (parent && parent.classList) parent.classList.add("privacy-masked");
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
    unmarkFaces();
    return;
  }
  markFaces(document);
  scan(document.body);
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
