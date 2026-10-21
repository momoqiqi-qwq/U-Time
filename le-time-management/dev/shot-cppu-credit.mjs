// 开发用：把「我的学分」视图（cppu-credit-ledger）真跑一遍、渲成静态 HTML，
// 再交给无头 Chrome 截图看几何。不进测试套件。
//
//   node dev/shot-cppu-credit.mjs      → .workbuddy/shots/credit-*.html
//
// 三段拼接：宿主 :root 令牌（src/styles.css）+ 插件样式块（main.js 的 ensureStyle）
// + jwAcademicCreditHtml() 的真输出（vm 里跑 main.js）。
// 模块行的口径取自教务真响应 jw_credit_raw.json（15 行课程模块）；
// 培养计划与成绩行按同一份表结构手写 —— 这两个接口当天没抓包，只为把版式画满。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const PLUGIN = new URL("../public/plugins/cppu-notify/main.js", import.meta.url);
const STYLES = new URL("../src/styles.css", import.meta.url);
const CREDIT = process.env.CREDIT_FIXTURE || "C:/Users/yile/AppData/Local/Temp/jwprobe/jw_credit_raw.json";
const OUT = new URL("../.workbuddy/shots/", import.meta.url);
fs.mkdirSync(OUT, { recursive: true });

const source = fs.readFileSync(PLUGIN, "utf8");

const cssStart = source.indexOf("st.textContent = `");
const cssEnd = source.indexOf("`;", cssStart);
if (cssStart < 0 || cssEnd < 0) throw new Error("找不到 ensureStyle 的样式块，行号变了就改这里");
const pluginCss = source.slice(cssStart + "st.textContent = `".length, cssEnd);

const styles = fs.readFileSync(STYLES, "utf8");
const rootStart = styles.indexOf(":root {") >= 0 ? styles.indexOf(":root {") : styles.indexOf(":root{");
const rootEnd = styles.indexOf("}", rootStart);
const rootCss = styles.slice(rootStart, rootEnd + 1);

const noop = () => {};
// 培养计划：KCZXF 总学分 / KCBXXF 必修 / KCXXXF 选修 / SJKCZXF 实践
const PLAN = [{ KCZXF: "165", KCBXXF: "95", KCXXXF: "45", SJKCZXF: "25" }];
// 成绩行：一门课一行，XF 学分 / KCSX 必修选修 / KCMK 模块码。
// ⚠️ 「已获得」不看分数，只认 SFHDXF === "1"（jwGradeDone），漏了它整页学分全是 0。
const GRADES = [
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
];

function render(openCategory) {
  const context = vm.createContext({
    URL, Set, Map, WeakMap, Date, Promise, JSON, Math, RegExp, String, Number, Object, Array, Error, console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    crypto: globalThis.crypto, btoa: globalThis.btoa, TextEncoder, URLSearchParams,
    document: { createElement: () => ({ set innerHTML(x) { this.value = x; } }), querySelectorAll: () => [] },
    Image: class { constructor() { this.naturalWidth = 0; this.naturalHeight = 0; } set src(v) { this._src = v; } decode() { return Promise.reject(new Error("no")); } },
    tide: {
      ui: { registerView: noop },
      http: { session: async () => "s1", restoreCookies: async () => "sid", fetch: async () => ({ status: 200, body: "[]" }) },
      storage: { set: async () => {}, get: async (k, d) => (d === undefined ? null : d) },
      vault: { get: async () => null, set: async () => {}, del: async () => {} },
      util: { openUrl: noop, web: { formEncode: () => "" } },
      notify: noop,
      assets: { saveBase64: async () => "", revealSaved: async () => ({ ok: true }) },
    },
  });
  const API = "jwState,jwAcademicCreditHtml";
  vm.runInContext(source.replace("  tide.ui.registerView({", `  globalThis.testApi = {${API}};\n  tide.ui.registerView({`), context);
  const api = context.testApi;

  const modules = JSON.parse(fs.readFileSync(CREDIT, "utf8")).rows;
  api.jwState.data.creditPlan = PLAN;
  api.jwState.data.creditModule = modules;
  api.jwState.data.grade = GRADES;
  api.jwState.expandedCredit = new Set(openCategory ? [openCategory] : []);
  return api.jwAcademicCreditHtml();
}

/* 真机壳模拟（SHOT_APK=1）：窄屏 + 深色 + 系统字号放大 + 宿主注入的安全区四条边。
   Android WebView 的 env(safe-area-inset-*) 恒为 0，所以让位只能靠 --sat/--sab。 */
const DARK_CSS = fs.readFileSync(new URL("../src/styles/theme-derived.css", import.meta.url), "utf8");
const APK = process.env.SHOT_APK === "1";
const APK_SCALE = process.env.SHOT_SCALE || "1.3";

const page = (body, w) => `<!doctype html><meta charset="utf-8">
<html data-theme="classic" data-theme-mode="${APK ? "dark" : "light"}"
      style="--sat:${APK ? "24px" : "0px"};--sab:${APK ? "48px" : "0px"};--sal:0px;--sar:0px;--ui-text-scale:${APK ? APK_SCALE : 1}">
<style>${rootCss}
html,body{margin:0;background:var(--bg,#f4f3ef);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
body{padding:${APK ? "0" : "14px"};box-sizing:border-box;width:100%;max-width:${w}px}
.view{padding:var(--sat,0px) var(--sar,0px) var(--sab,0px) var(--sal,0px);box-sizing:border-box;min-height:100vh}</style>
<style>${APK ? DARK_CSS : ""}</style>
<style>${pluginCss}</style>
<div class="view"><div class="pp-wrap"><div class="pp-shell"><div class="pp-main">${body}</div></div></div></div>`;

for (const c of [{ name: "credit", open: "" }, { name: "credit-required", open: "required" }, { name: "credit-practice", open: "practice" }]) {
  const body = render(c.open);
  for (const [suffix, w] of APK ? [[`-apk`, 390]] : [["", 1180], ["-390", 390]]) {
    const file = new URL(`${c.name}${suffix}.html`, OUT);
    fs.writeFileSync(file, page(body, w), "utf8");
    console.log("写 " + path.relative(process.cwd(), file.pathname.replace(/^\//, "")));
  }
}
