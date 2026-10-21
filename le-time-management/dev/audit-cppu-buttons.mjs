// 开发用：把「我的考试 / 我的学分」两页在**真浏览器**里装起来，把每个可点元素逐个点一遍，
// 记录三件事：① 它看得见吗 ② 点得到吗（elementFromPoint 命中自己，没被浮层盖住）
// ③ 点完有反应吗（DOM / jwState / tide 调用任一变化）。不进测试套件。
//
//   node dev/audit-cppu-buttons.mjs      → 终端打印表格 + .workbuddy/audit/report.json
//
// 为什么要真浏览器：插件的事件是**委托在视图容器上**的（mountJwView 里那一串 closest），
// 光静态找 handler 说不清「点了到底有没有反应」—— 折叠区没展开、浮层盖住、CSS 把命中区
// 压成 0 高度，都能让一个「代码里明明接了」的按钮点不动。所以这里连样式一起装上真点。
//
// 数据不是手编的：考试行来自抓包 fixture，用插件自己的 jwExamRow / jwExamPlanOf 解析；
// 学分模块行来自同一份抓包，成绩行按同一张表结构补齐（这个接口当天没抓包）。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\//, "");
const PLUGIN = new URL("../public/plugins/cppu-notify/main.js", import.meta.url);
const STYLES = new URL("../src/styles.css", import.meta.url);
const EXAM_FIXTURE = process.env.EXAM_FIXTURE || "C:/Users/yile/AppData/Local/Temp/jwprobe/jw_exam_fixture.json";
const CREDIT_FIXTURE = process.env.CREDIT_FIXTURE || "C:/Users/yile/AppData/Local/Temp/jwprobe/jw_credit_raw.json";
const OUT = new URL("../.workbuddy/audit/", import.meta.url);
const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

fs.mkdirSync(OUT, { recursive: true });
const source = fs.readFileSync(PLUGIN, "utf8");

// ── 从 main.js 里抠出插件样式（ensureStyle 的那个模板串）与宿主的 :root 令牌 ──
const cssStart = source.indexOf("st.textContent = `");
const cssEnd = source.indexOf("`;", cssStart);
if (cssStart < 0 || cssEnd < 0) throw new Error("找不到 ensureStyle 的样式块，行号变了就改这里");
const pluginCss = source.slice(cssStart + "st.textContent = `".length, cssEnd);
const styles = fs.readFileSync(STYLES, "utf8");
const rootStart = styles.indexOf(":root {") >= 0 ? styles.indexOf(":root {") : styles.indexOf(":root{");
const rootCss = styles.slice(rootStart, styles.indexOf("}", rootStart) + 1);

// ── 把内部函数暴露出来（注入点与测试脚本同一处） ──
const API = "jwState,state,JW_VIEWS,mountJwView,jwPaint,jwExamRow,jwExamPlanOf,jwEnsureExamTerm,jwToggleExamCard";
const injected = `  globalThis.testApi = {${API}, __forceLive: () => { jwSid = state.sid = "audit-session"; }};\n  tide.ui.registerView({`;
if (!source.includes("  tide.ui.registerView({")) throw new Error("注入锚点没找到");
fs.writeFileSync(new URL("plugin.js", OUT), source.replace("  tide.ui.registerView({", injected), "utf8");

// ── fixture：考试计划 / 考试任务（真抓包） + 学分模块（真抓包） + 成绩（按表结构补） ──
const examFx = JSON.parse(fs.readFileSync(EXAM_FIXTURE, "utf8"));
const creditFx = JSON.parse(fs.readFileSync(CREDIT_FIXTURE, "utf8"));
const seed = {
  planRows: examFx.ks.rows,
  termRows: { "20252026-1": examFx.rw1.rows, "20252026-2": examFx.rw2.rows },
  creditPlan: [{ KCZXF: "165", KCBXXF: "95", KCXXXF: "45", SJKCZXF: "25" }],
  creditModules: creditFx.rows,
  // 「已获得」只认 SFHDXF === "1"，漏了它整页学分是 0（v0.272.4 踩过）
  grades: [
    { KCMC: "高等数学（理）1", XF: "5", KCSX: "01", KCMK: "01", XNXQ: "20252026-1", ZPCJ: "88", SFHDXF: "1" },
    { KCMC: "大学计算机", XF: "3", KCSX: "01", KCMK: "01", XNXQ: "20252026-1", ZPCJ: "92", SFHDXF: "1" },
    { KCMC: "大学英语1", XF: "4", KCSX: "01", KCMK: "02", XNXQ: "20252026-1", ZPCJ: "85", SFHDXF: "1" },
    { KCMC: "中国近现代史纲要", XF: "3", KCSX: "01", KCMK: "05", XNXQ: "20252026-1", ZPCJ: "90", SFHDXF: "1" },
    { KCMC: "警察体能训练", XF: "2", KCSX: "01", KCMK: "09", XNXQ: "20252026-1", ZPCJ: "78", SFHDXF: "1" },
    { KCMC: "消防工程导论", XF: "2", KCSX: "02", KCMK: "12", XNXQ: "20252026-1", ZPCJ: "81", SFHDXF: "1" },
    { KCMC: "大学生心理健康", XF: "2", KCSX: "02", KCMK: "12", XNXQ: "20252026-1", ZPCJ: "86", SFHDXF: "1" },
    { KCMC: "军事理论", XF: "2", KCSX: "01", KCMK: "03", XNXQ: "20262027-1" },
    { KCMC: "线性代数", XF: "3", KCSX: "01", KCMK: "01", XNXQ: "20262027-1" },
    { KCMC: "警务实战技能", XF: "3", KCSX: "03", KCMK: "28", XNXQ: "20262027-1" },
    { KCMC: "社会实践", XF: "2", KCSX: "03", KCMK: "28", XNXQ: "20262027-1" },
    { KCMC: "志愿消防宣传", XF: "1", KCSX: "04", KCMK: "28", XNXQ: "20262027-1" },
  ],
};
fs.writeFileSync(new URL("seed.js", OUT), `window.AUDIT_SEED = ${JSON.stringify(seed)};`, "utf8");

// ── 页面：宿主令牌 + 插件样式 + tide 桩 + 插件本体 + 点查脚本 ──
const page = `<!doctype html><meta charset="utf-8"><title>cppu button audit</title>
<style>${rootCss}
html,body{margin:0;background:var(--bg,#f4f3ef);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
body{padding:12px}
.view{padding:0}
#audit{white-space:pre-wrap;font:12px/1.5 Consolas,monospace}
</style>
<style>${pluginCss}</style>
<script>
// tide 桩：记录调用（notify / navigate / openUrl / tasks…），其余一律返回空。
window.__calls = [];
window.__errs = [];
window.addEventListener("unhandledrejection", (e) => window.__errs.push(String(e.reason && e.reason.message || e.reason)));
window.addEventListener("error", (e) => window.__errs.push(String(e.message)));
const rec = (ns, fn) => (...args) => { window.__calls.push(ns + "." + fn); return Promise.resolve(null); };
window.tide = {
  notify: (...a) => { window.__calls.push("notify:" + String(a[0] || "").slice(0, 40)); },
  ui: { registerView: () => {}, selectionGlow: () => {}, waitMask: () => ({ close: () => {} }), on: () => {} },
  http: { session: async () => "audit-session", restoreCookies: async () => null,
    fetch: async () => ({ status: 200, body: '{"rows":[]}' }), dumpCookies: async () => [] },
  storage: { get: async (k, d) => (d === undefined ? null : d), set: async () => {}, remove: async () => {} },
  vault: { get: async () => null, set: async () => {}, del: async () => {}, remove: async () => {} },
  util: { navigate: (...a) => window.__calls.push("navigate:" + a[0]), openUrl: (...a) => window.__calls.push("openUrl:" + String(a[0] || "").slice(0, 30)),
    web: { formEncode: () => "", encode: (s) => String(s || "") }, addDays: (d, n) => d, hhmmOf: () => "", openMailPage: () => {} },
  events: { on: () => {}, off: () => {}, emit: () => {} },
  tasks: { create: (...a) => window.__calls.push("tasks.create") },
  inbox: { create: () => window.__calls.push("inbox.create") },
  assets: { saveBase64: async () => "", revealSaved: async () => ({ ok: true }), saveBase: async () => "" },
  blocks: { createSmart: () => window.__calls.push("blocks.createSmart") },
  log: { info: () => {}, warn: () => {}, error: () => {} },
};
// 固定「现在」：2026-07-06 09:00（20252026-2 那学期正在开考，待考/已结束两组同时存在）
const FIXED = new Date("2026-07-06T09:00:00+08:00").getTime();
const RealDate = Date;
window.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(FIXED); }
  static now() { return FIXED; }
  static parse(v) { return RealDate.parse(v); }
  static UTC(...a) { return RealDate.UTC(...a); }
};
</script>
<script src="seed.js"></script>
<script src="plugin.js"></script>
<pre id="boot"></pre>
<script>
document.getElementById("boot").textContent = "boot:" + (typeof window.testApi) + " errs=" + (window.__errs || []).join(" | ");
</script>
<script>
(async () => {
 try {
  const api = globalThis.testApi;
  const S = api.jwState;
  const seedData = window.AUDIT_SEED;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { rows: [], errs: null };

  const reset = () => {
    api.__forceLive();
    S.term = { code: "20252026-2", name: "2025-2026 学年第 2 学期", jxStart: "2026-02-23", weeks: 20,
      termStart: "2026-02-23", termEnd: "2026-07-19" };
    for (const k of Object.keys(S.data)) S.data[k] = null;
    for (const k of Object.keys(S.at)) S.at[k] = 0;
    for (const k of Object.keys(S.error)) S.error[k] = "";
    for (const k of Object.keys(S.loading)) S.loading[k] = false;
    S.examOpen = new Set();
    S.expandedCredit = new Set();
    S.creditHideDone = false;
    S.examFilter = "";
    S.roomFilter = "";
    S.roomSlot = "all";
    S.courseScope = "week";
    // 考试：计划 + 两个学期的场次（行来自抓包，解析用插件自己的函数）
    const plans = seedData.planRows.map(api.jwExamPlanOf).filter((p) => p.id && p.term);
    plans.sort((a, b) => (a.term < b.term ? 1 : -1));
    S.data.exam = { ok: true, at: Date.now(), plans, current: "20252026-2", terms: {} };
    for (const [term, rows] of Object.entries(seedData.termRows)) S.data.exam.terms[term] = rows.map(api.jwExamRow);
    S.data.creditPlan = seedData.creditPlan;
    S.data.creditModule = seedData.creditModules;
    S.data.grade = seedData.grades;
  };

  const mount = async (viewId) => {
    document.querySelectorAll(".stage").forEach((n) => n.remove());
    reset();
    const host = document.createElement("div");
    host.className = "stage view";
    document.body.appendChild(host);
    const cfg = api.JW_VIEWS.find((v) => v.id === viewId);
    api.mountJwView(host, cfg);
    await sleep(260);          // 等挂载里的 async IIFE 跑完（数据已 seed，不会真的发请求）
    return host;
  };

  const snap = (host) => JSON.stringify({
    dom: host.innerHTML.length,
    calls: window.__calls.length,
    examOpen: [...S.examOpen].sort(),
    expanded: [...S.expandedCredit].sort(),
    hide: S.creditHideDone,
    filter: S.examFilter,
    current: S.data.exam && S.data.exam.current,
  });

  const label = (el) => {
    const data = [...el.attributes].filter((a) => a.name.startsWith("data-") || a.name === "role").map((a) => a.name + "=" + a.value.slice(0, 18));
    const text = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || "").replace(/\\s+/g, " ").trim().slice(0, 22);
    return (el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "")) + " | " + text + (data.length ? " | " + data.join(" ") : "");
  };

  // 被祖先的 overflow 裁掉也算看不见（侧栏收起时的子菜单就是这种：getClientRects 有值，
  // 但在 .pp-side-list 的 max-height:0 之外，点上去是空的）
  const clipAncestor = (el) => {
    const r = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (!/(hidden|clip|auto|scroll)/.test(cs.overflow + cs.overflowY)) continue;
      const ar = a.getBoundingClientRect();
      if (r.bottom <= ar.top + 1 || r.top >= ar.bottom - 1 || r.right <= ar.left + 1 || r.left >= ar.right - 1) return a;
    }
    return null;
  };

  // 把某一份 stage 摆成目标形态（默认 / 全展开 / 侧栏全展开）
  const prep = async (stage, viewId, mode) => {
    if (mode === "expanded") {
      if (viewId === "cppu-exam") [...stage.querySelectorAll(".jw-exam-card")].forEach((c) => api.jwToggleExamCard(c, true));
      else { S.expandedCredit = new Set(["required", "elective", "practice"]); api.jwPaint(); }
    }
    if (mode === "side") {
      for (const t of stage.querySelectorAll("[data-side-sub]")) t.click();
    }
    if (mode !== "default") await sleep(60);
  };

  const SEL = "button, [role=button], input, a[href], summary";
  // 两页细查（默认 / 展开 / 侧栏三种形态）；其余视图只做默认态一遍，
  // 目的是揪「接线漏了」——它们的空状态也各自有按钮（刷新横幅、去教务…）。
  const DEEP = ["cppu-exam", "cppu-credit-ledger"];
  const target = (() => {
    const ids = api.JW_VIEWS.map((v) => v.id);
    return [...DEEP, ...ids.filter((id) => !DEEP.includes(id))];
  })();
  for (const viewId of target) {
    const modes = DEEP.includes(viewId) ? ["default", "expanded", "side"] : ["default"];
    for (const mode of modes) {
      const probeHost = await mount(viewId);
      await prep(probeHost, viewId, mode);
      const nodes = [...probeHost.querySelectorAll(SEL)]
        .filter((n) => (mode === "side" ? !!n.closest(".pp-side") : !n.closest(".pp-side")));
      for (const node of nodes) {
        const stage = await mount(viewId);
        await prep(stage, viewId, mode);
        const el = [...stage.querySelectorAll(SEL)]
          .filter((n) => (mode === "side" ? !!n.closest(".pp-side") : !n.closest(".pp-side")))[nodes.indexOf(node)];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const clip = clipAncestor(el);
        const visible = el.getClientRects().length > 0 && rect.width > 0 && rect.height > 0 && !clip;
        el.scrollIntoView({ block: "center" });
        const r2 = el.getBoundingClientRect();
        const hit = visible ? document.elementFromPoint(r2.left + r2.width / 2, r2.top + r2.height / 2) : null;
        const reachable = !!hit && (hit === el || el.contains(hit));
        const before = snap(stage);
        const isInput = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
        if (visible && !isInput) { try { el.click(); } catch (e) { window.__errs.push("click: " + e.message); } }
        if (visible && isInput) {
          // 输入框不是「点一下」就完事：真的打字，看过滤/计数有没有跟着动
          el.focus();
          el.value = "数学";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await sleep(120);
        const after = snap(stage);
        out.rows.push({
          view: viewId, mode, kind: isInput ? "输入" : "点按", label: label(el), visible, reachable,
          blockedBy: reachable ? "" : (clip ? "被 " + label(clip).slice(0, 24) + " 裁掉" : hit ? label(hit) : "(视口外)"),
          w: Math.round(rect.width), h: Math.round(rect.height),
          effect: before !== after || document.querySelector(".stage") !== stage,
          note: before === after && reachable ? (isInput ? "打字没反应" : "点了没反应") : "",
        });
      }
    }
  }
  out.errs = window.__errs.slice(0, 20);
  const pre = document.createElement("pre");
  pre.id = "audit";
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
 } catch (e) {
  const pre = document.createElement("pre");
  pre.id = "audit";
  pre.textContent = JSON.stringify({ error: String(e && e.message || e), stack: String(e && e.stack || "").slice(0, 600), errs: window.__errs });
  document.body.appendChild(pre);
 }
})();
</script>`;

fs.writeFileSync(new URL("index.html", OUT), page, "utf8");

const url = new URL("index.html", OUT).href;
console.log("跑 " + url);
const dom = execFileSync(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars",
  `--window-size=${process.env.AUDIT_W || 1180},1400`, "--virtual-time-budget=60000",
  "--allow-file-access-from-files", "--dump-dom", url,
], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const m = dom.match(/<pre id="audit">([\s\S]*?)<\/pre>/);
if (!m) {
  console.error("没拿到审计结果，页面可能抛错了。先看 .workbuddy/audit/index.html");
  process.exit(1);
}
const data = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
fs.writeFileSync(new URL("report.json", OUT), JSON.stringify(data, null, 2), "utf8");

const bad = data.rows.filter((r) => r.visible && (!r.reachable || !r.effect));
console.log(`\n共 ${data.rows.length} 个可点元素，可疑 ${bad.length} 个`);
for (const r of data.rows) {
  const flag = !r.visible ? "·" : !r.reachable ? "✗遮挡" : !r.effect ? "✗无反应" : "✓";
  console.log(`${flag} [${r.view.replace("cppu-", "")}/${r.mode}] ${r.w}×${r.h} ${r.label}${r.blockedBy ? "  ← " + r.blockedBy : ""}${r.note ? "  " + r.note : ""}`);
}
if (data.errs.length) console.log("\n页面报错：\n" + data.errs.join("\n"));
console.log("\n报告：" + path.relative(ROOT, new URL("report.json", OUT).pathname.replace(/^\//, "")));
