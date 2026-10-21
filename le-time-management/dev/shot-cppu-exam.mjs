// 开发用：把「我的考试」视图真跑一遍、渲成静态 HTML，用无头 Chrome 截图看几何。
// 不进测试套件（test-*.mjs 才是），这里只给改样式时对照一眼。
//
//   node dev/shot-cppu-exam.mjs            → .workbuddy/shots/exam-*.html
//
// 三段拼接：宿主 :root 令牌（src/styles.css）+ 插件自己的样式块（main.js 的 ensureStyle）
// + jwExamHtml() 的真输出（vm 里跑 main.js，注入固定「今天」）。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const PLUGIN = new URL("../public/plugins/cppu-notify/main.js", import.meta.url);
const STYLES = new URL("../src/styles.css", import.meta.url);
const FIXTURE = process.env.EXAM_FIXTURE || "C:/Users/yile/AppData/Local/Temp/jwprobe/jw_exam_fixture.json";
const OUT = new URL("../.workbuddy/shots/", import.meta.url);
fs.mkdirSync(OUT, { recursive: true });

const source = fs.readFileSync(PLUGIN, "utf8");

/* ① 插件的样式块：ensureStyle() 里那个模板字面量 */
const cssStart = source.indexOf("st.textContent = `");
const cssEnd = source.indexOf("`;", cssStart);
if (cssStart < 0 || cssEnd < 0) throw new Error("找不到 ensureStyle 的样式块，行号变了就改这里");
const pluginCss = source.slice(cssStart + "st.textContent = `".length, cssEnd);

/* ② 宿主的主题令牌：只要 :root 那一段（浅色），够画真配色 */
const styles = fs.readFileSync(STYLES, "utf8");
const rootStart = styles.indexOf(":root {") >= 0 ? styles.indexOf(":root {") : styles.indexOf(":root{");
const rootEnd = styles.indexOf("}", rootStart);
const rootCss = styles.slice(rootStart, rootEnd + 1);

/* ③ 在 vm 里跑 main.js，塞一份真抓包的考试数据，再把「今天」钉死 */
const noop = () => {};
function render(now, term) {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    URL, Set, Map, WeakMap, Date: FakeDate, Promise, JSON, Math, RegExp, String, Number, Object, Array, Error, console,
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
  const API = "jwState,jwExamRow,jwExamPlanOf,jwExamHtml,jwApplyExamFilter";
  vm.runInContext(source.replace("  tide.ui.registerView({", `  globalThis.testApi = {${API}};\n  tide.ui.registerView({`), context);
  const api = context.testApi;

  // fixture：{ ks:{rows:[计划]}, rw1:{rows:[安排]}, rw2:{rows:[安排]} }
  const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const plans = fx.ks.rows.map(api.jwExamPlanOf);
  const terms = { [plans[0].term]: fx.rw1.rows.map(api.jwExamRow) };
  if (fx.rw2) terms[plans[1].term] = fx.rw2.rows.map(api.jwExamRow);
  api.jwState.data.exam = { ok: true, at: now, plans, current: term, terms };
  api.jwState.term = { code: "20262027-1", name: "2026-2027 学年第 1 学期" };
  return api.jwExamHtml();
}

/* 真机壳模拟（SHOT_APK=1）：Android WebView 里 env(safe-area-inset-*) 恒为 0，
   宿主 .view 自己吃 --sat/--sab/--sal/--sar 四条注入变量；暗色由 [data-theme-mode="dark"]
   的派生令牌决定。窄屏 + 深色 + 系统字号放大这三件事叠在一起才是手机上真实的观感。 */
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

/* 两态：① 今天 2026-10-20（当前学期没排考 → 回退到最近一个学期，全已结束）
        ② 今天 2026-01-13（有进行中 / 待考 / 红标下一场） */
const cases = [
  { name: "exam-ended", now: Date.parse("2026-10-20T09:00:00"), term: "20252026-2" },
  { name: "exam-upcoming", now: Date.parse("2026-01-13T10:10:00"), term: "20252026-1" },
  // 摊开第一张卡看折叠区长什么样（只改渲染出来的 HTML，不影响插件的真实状态）
  { name: "exam-open", now: Date.parse("2026-01-13T10:10:00"), term: "20252026-1", openFirst: true },
];
for (const c of cases) {
  let body = render(c.now, c.term);
  if (c.openFirst) {
    body = body.replace('class="jw-exam-card', 'class="jw-exam-card open').replace('aria-expanded="false"', 'aria-expanded="true"');
  }
  for (const [suffix, w] of APK ? [[`-apk`, 390]] : [["", 1180], ["-390", 390]]) {
    const file = new URL(`${c.name}${suffix}.html`, OUT);
    fs.writeFileSync(file, page(body, w), "utf8");
    console.log("写 " + path.relative(process.cwd(), file.pathname.replace(/^\//, "")));
  }
}
