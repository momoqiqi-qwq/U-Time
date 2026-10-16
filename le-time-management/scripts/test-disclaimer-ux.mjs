import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SETTINGS_SEARCH_ENTRIES } from "../src/settingsSearchIndex.js";

const read = (name) => readProductSource(new URL(name, import.meta.url), "utf8");
const code = read("../src/disclaimer.js").replace(/^import .*;\r?\n/gm, "").replace(/export /g, "");
const el = (tag, attrs = {}, ...children) => ({ tag, attrs, children: children.flat().filter(Boolean), nodeType: 1 });
const flatten = (node) => typeof node === "string" ? node : node.children.map(flatten).join(" ");
const walk = (node) => typeof node === "string" ? [] : [node, ...node.children.flatMap(walk)];
function fixture({ version = null, failStorage = false, native = true, later = false } = {}) {
  let answer, next = later, count = 0, writes = 0, last;
  const module = new Function("api", "appConfirm", "el", "localStorage", `${code}\nreturn {showStartupDisclaimer,createDisclaimerContent,DISCLAIMER_VERSION,DISCLAIMER_ACK,DISCLAIMER_SECTIONS,DISCLAIMER_ITEMS,isDisclaimerAcknowledged,readDisclaimerVersion};`)(
    { isTauri: native }, (...args) => { count++; last = args; if (next !== false) { const v = next; next = false; return Promise.resolve(v); } return new Promise((resolve) => { answer = resolve; }); }, el,
    { getItem() { if (failStorage) throw Error("blocked"); return version; }, setItem(_, v) { if (failStorage) throw Error("blocked"); writes++; version = v; } });
  return { ...module, resolve: (v) => answer(v), later: (v) => { next = v; }, get count() { return count; }, get writes() { return writes; }, get version() { return version; }, get last() { return last; } };
}
let f = fixture({ version: "1" });
const a = f.showStartupDisclaimer(), b = f.showStartupDisclaimer();
assert.equal(f.count, 1, "concurrent calls share one dialog");
assert.equal(f.last[2].focusMessage, true);
assert.equal(f.last[1].attrs.tabindex, "0");
f.resolve(false);
assert.deepEqual(await Promise.all([a, b]), [false, false]);
assert.equal(f.version, "1", "cancel leaves old acknowledgement unchanged");
assert.equal(f.writes, 0);
const accepted = f.showStartupDisclaimer(); f.resolve(true);
assert.equal(await accepted, true);
assert.equal(f.version, f.DISCLAIMER_VERSION);
await f.showStartupDisclaimer(); assert.equal(f.count, 2);
f = fixture({ version: f.DISCLAIMER_VERSION }); assert.equal(await f.showStartupDisclaimer(), true); assert.equal(f.count, 0);
f = fixture({ native: false }); assert.equal(await f.showStartupDisclaimer(), false); assert.equal(f.count, 0);
f = fixture({ failStorage: true });
const blocked = f.showStartupDisclaimer(); f.resolve(true); assert.equal(await blocked, true);
await f.showStartupDisclaimer(); assert.equal(f.count, 1, "storage failure does not block startup or repeat within session");
const content = f.createDisclaimerContent();
assert.equal(walk(content).filter((n) => n.tag === "section").length, f.DISCLAIMER_SECTIONS.length);
assert.equal(f.DISCLAIMER_SECTIONS.length, 8, "账号与隐私声明拆条后应有 8 条");
assert.ok(walk(content).every((n) => !String(n.attrs.class).includes("set-hint")), "essential copy must not inherit description hiding");
assert.equal(f.DISCLAIMER_ITEMS.length, f.DISCLAIMER_SECTIONS.length);
for (const required of ["官方", "备用提醒", "AI", "备份", "自动联网", "费用", "API Key", "依法不得免除", "不代表授权所有联网功能"]) {
  assert.ok(flatten(content).includes(required), required);
}
// ── 必须手动勾选：确认按钮在勾上之前是禁用的，取消也绝不写入已读记录 ──
assert.equal(f.DISCLAIMER_ACK.required, true, "启动确认门必须有 required 勾选项");
assert.ok(f.DISCLAIMER_ACK.label.includes("我已逐条阅读"), f.DISCLAIMER_ACK.label);
const gated = fixture({ version: "1" });
const opening = gated.showStartupDisclaimer();
assert.deepEqual(gated.last[2].options.map((o) => o.id), ["ack"], "启动弹窗必须把勾选项交给 appDialog");
assert.equal(gated.last[2].confirmText, "我已阅读并同意");
assert.equal(gated.last[2].cancelText, "稍后阅读");
gated.resolve({ confirmed: false, checks: { ack: false } });
assert.equal(await opening, false, "未勾选时不算已读");
assert.equal(gated.writes, 0, "未勾选不得写入阅读记录");
const gated2 = fixture({ version: "1" });
const opening2 = gated2.showStartupDisclaimer();
gated2.resolve({ confirmed: true, checks: { ack: true } });assert.equal(await opening2, true);
assert.equal(gated2.version, gated2.DISCLAIMER_VERSION, "勾选并确认后才写入当前版本");
// force：本会话已读过、本机也有记录时，复核仍必须真的弹窗；取消不回退已读记录。
assert.equal(await gated2.showStartupDisclaimer(), true, "本会话已读不再弹窗");
assert.equal(gated2.count, 1);
gated2.later({ confirmed: false, checks: { ack: false } });
assert.equal(await gated2.showStartupDisclaimer({ force: true }), false, "force 复核必须真的弹窗");
assert.equal(gated2.count, 2, "force 调用必须重新弹窗");
assert.equal(gated2.version, gated2.DISCLAIMER_VERSION, "复核取消不得抹掉已读记录");
assert.equal(gated2.isDisclaimerAcknowledged(), true);
// 换设备 / 清数据：本机没有记录 → 首次使用仍会弹，且不勾选就不算已读。
const fresh = fixture({ version: null });
const freshOpen = fresh.showStartupDisclaimer();
assert.equal(fresh.count, 1, "首次使用必须弹窗");
fresh.resolve({ confirmed: true, checks: { ack: true } });
assert.equal(await freshOpen, true);
assert.equal(fresh.version, fresh.DISCLAIMER_VERSION);
assert.equal(fixture({ version: "2" }).isDisclaimerAcknowledged(), false, "旧版本说明视为未确认");
const entry = SETTINGS_SEARCH_ENTRIES.find((x) => x.title === "使用说明与免责声明");
assert.equal(entry.section, "about");
assert.ok(entry.keywords.includes("隐私"));
// ── 关于页：折叠栏（铁律七：展开 / 收起都有动画）+ 阅读状态 + 复核入口 ──
const about = read("../src/views/aboutCard.js");
assert.match(about, /createDisclosure\(\{/, "关于页必须用可展开 / 收起的折叠栏承载免责声明");
assert.match(about, /content: createDisclaimerContent\(\)/, "折叠栏正文就是免责声明正文");
assert.match(about, /showStartupDisclaimer\(\{ force: true \}\)/, "复核按钮要能重开确认门");
assert.match(about, /isDisclaimerAcknowledged\(\)/, "折叠栏要显示本机阅读状态");
const disclosure = read("../src/disclosure.js");
assert.match(disclosure, /grid-template-rows|classList\.toggle\("is-open"/, "折叠栏靠 is-open 类切换");
assert.match(disclosure, /panel\.inert = false/, "展开后正文必须恢复可点、可聚焦");
// inert 若与类切换同帧生效，Chrome 不再渲染子树 → 收起方向一帧过渡都没有（实测），所以必须延迟挂。
assert.match(disclosure, /setTimeout\(\(\) => \{ if \(!isOpen\) panel\.inert = true; \}, \d+\)/, "收起的 inert 必须等过渡走完再挂");
assert.match(disclosure, /aria-expanded/, "折叠栏要维护 aria-expanded");
assert.match(disclosure, /"Escape"/, "折叠栏要支持 Escape 收起");
// 设置页按 settings.* 状态整段重挂分区，折叠状态只存 DOM class 会被打回初始值 → 必须按 key 记住。
assert.match(disclosure, /openState\.set\(stateKey/, "折叠状态要按稳定 key 记住");
assert.match(disclosure, /openState\.has\(stateKey\)/, "重建后要恢复上次的开合状态");
const css = read("../src/styles.css");
assert.match(css, /\.disclaimer-scroll\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/);
assert.match(css, /\.disclaimer-dialog[^}]*\.app-dialog-actions\s*\{\s*flex-shrink:\s*0/);
assert.match(css, /\.disclaimer-dialog \.app-dialog-btn\s*\{[^}]*min-height:\s*44px/);
assert.match(css, /\.app-dialog-btn:disabled\s*\{[^}]*cursor:\s*not-allowed/, "禁用的确认键要有可见的禁用态");
const layouts = read("../src/styles/feature-layouts.css");
assert.match(layouts, /\.disclosure\s*\{[^}]*grid-template-rows:\s*0fr[^}]*visibility:\s*hidden/);
assert.match(layouts, /\.disclosure\.is-open\s*\{[^}]*grid-template-rows:\s*1fr/);
assert.match(layouts, /\.disclosure-inner\s*\{[^}]*overflow:\s*hidden/);
assert.match(layouts, /data-ui-motion="reduced"[^}]*\.disclosure[^}]*transition:\s*none/, "减少动效下折叠栏不播动画");
// ── appDialog 的勾选门真的会禁用确认键（真跑 DOM 替身）──
const uiSource = fs.readFileSync(new URL("../src/ui.js", import.meta.url), "utf8");
let active = null;
class Node {
  constructor(tag, attrs = {}, ...children) {
    this.tag = tag; this.attrs = attrs; this.children = []; this.parent = null; this.nodeType = 1;
    this.value = attrs.value; this.checked = Boolean(attrs.checked); this.disabled = false;
    this.append(...children.flat().filter((x) => x != null));
  }
  append(...children) { for (const c of children) { this.children.push(c); if (typeof c === "object") c.parent = this; } }
  get isConnected() { return this === body || Boolean(this.parent?.isConnected); }
  matchesSimple(selector) {
    if (selector === '[tabindex="0"]') return this.attrs.tabindex === "0";
    if (selector === 'a[href]') return this.tag === 'a' && Boolean(this.attrs.href);
    if (selector.startsWith('.')) return selector.slice(1).split('.').every((s) => (this.attrs.class || '').split(' ').includes(s));
    return this.tag === selector;
  }
  // 支持「.a .b」这种后代选择器：末段匹配自身，其余段沿 parent 链回溯。
  matches(selector) {
    const parts = selector.trim().split(/\s+/);
    if (parts.length === 1) return this.matchesSimple(parts[0]);
    let node = this;
    for (let i = parts.length - 1; i >= 0; i--) {
      while (node && !node.matchesSimple(parts[i])) node = node.parent;
      if (!node) return false;
      if (i > 0) node = node.parent;
    }
    return true;
  }
  querySelectorAll(selectors) {
    const options = selectors.split(',').map((s) => s.trim());
    return this.children.filter((n) => typeof n === 'object').flatMap((n) => [...(options.some((s) => n.matches(s)) ? [n] : []), ...n.querySelectorAll(selectors)]);
  }
  querySelector(s) { return this.querySelectorAll(s)[0]; }
  contains(n) { return this === n || this.children.some((c) => typeof c === 'object' && c.contains(n)); }
  focus() { active = this; }
  select() { this.selected = true; }
  getClientRects() { return this.isConnected ? [{}] : []; }
  addEventListener(type, fn) { (this.handlers ||= {})[type] = fn; }
  setAttribute(k, v) { this.attrs[k] = v; }
  remove() { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
}
const body = new Node('body');
const doc = { body, get activeElement() { return active; }, querySelectorAll: (s) => body.querySelectorAll(s), addEventListener() {}, removeEventListener() {} };
const uiEl = (...args) => new Node(...args);
const uiCode = uiSource.slice(uiSource.indexOf('function appDialog('), uiSource.indexOf('/**\n * 底部系统栏')).replace(/export /g, '');
const { appConfirm } = new Function('document', 'el', `${uiCode}\nreturn {appConfirm};`)(doc, uiEl);
const gatedDialog = appConfirm('使用说明与免责声明', uiEl('div', { tabindex: '0' }, '正文'), {
  dialogClass: 'disclaimer-dialog', focusMessage: true, confirmText: '我已阅读并同意', cancelText: '稍后阅读',
  options: [{ id: 'ack', label: '我已逐条阅读并理解上述账号、隐私与数据去向说明。', required: true }],
});
const dbox = body.querySelector('.app-dialog');
const check = dbox.querySelector('.app-dialog-checks input');
const pri = dbox.querySelector('.pri');
assert.ok(check && pri, '勾选项与确认键都要在对话框里');
assert.equal(check.attrs.type, 'checkbox');
assert.equal(check.attrs.required, '', '必勾项要带 required');
assert.equal(pri.disabled, true, '未勾选时确认键必须是禁用的');
assert.equal(active, check, '未勾选时焦点落到勾选项，而不是禁用的确认键');
pri.attrs.onclick({});
assert.equal(body.querySelectorAll('.app-dialog-mask').length, 1, '未勾选点确认键不关闭对话框');
check.checked = true;
check.handlers.change();
assert.equal(pri.disabled, false, '勾选后确认键解禁');
pri.attrs.onclick({});
assert.deepEqual(await gatedDialog, { confirmed: true, checks: { ack: true } }, '勾选确认返回 confirmed + checks');
const plainDialog = appConfirm('普通对话框', '没有勾选项');
assert.equal(body.querySelector('.pri').disabled, false);
body.querySelector('.pri').attrs.onclick({});
assert.equal(await plainDialog, true, '没有勾选项时仍返回布尔值');
console.log("PASS: disclaimer gating, manual acknowledgement, forced re-review, collapsible about panel and dialog checkbox gate");
