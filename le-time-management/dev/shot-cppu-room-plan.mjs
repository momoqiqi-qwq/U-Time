// 开发用：只截「今天去哪」这张卡，浅色 / 深色、手机 / 桌面各一张，
// 用来核对几何与对比度（整页截图里它离标题太近，容易看不清边距）。
//
//   node dev/shot-cppu-room-plan.mjs → .workbuddy/shots/plan-*.html + *.png
//
// 拼接方式与 shot-cppu-room.mjs 相同：宿主 :root 令牌 + 插件样式块 + jwRoomPlanHtml() 真输出。
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PLUGIN = new URL("../public/plugins/cppu-notify/main.js", import.meta.url);
const STYLES = new URL("../src/styles.css", import.meta.url);
const OUT = new URL("../.workbuddy/shots/", import.meta.url);
fs.mkdirSync(OUT, { recursive: true });

const source = fs.readFileSync(PLUGIN, "utf8");
const cssStart = source.indexOf("st.textContent = `");
const cssEnd = source.indexOf("`;", cssStart);
if (cssStart < 0 || cssEnd < 0) throw new Error("找不到 ensureStyle 的样式块，行号变了就改这里");
const pluginCss = source.slice(cssStart + "st.textContent = `".length, cssEnd);

const styles = fs.readFileSync(STYLES, "utf8");
const rootStart = styles.indexOf(":root {") >= 0 ? styles.indexOf(":root {") : styles.indexOf(":root{");
const rootCss = styles.slice(rootStart, styles.indexOf("}", rootStart) + 1);
/* 深色不是同一个 :root 里的令牌 —— 每个主题的深色色板在 gen-theme-dark.js 的产物里，
   不带上它，「深色」截图其实还是浅色（同一套 var 值），对比度根本验不到。 */
const derivedPath = new URL("../src/styles/theme-derived.css", import.meta.url);
const derivedCss = fs.existsSync(derivedPath) ? fs.readFileSync(derivedPath, "utf8") : "";

const SLOTS = ["01", "02", "03", "04", "05"];
const rooms = (pairs) => pairs.map(([name, codes]) => ({ name, slots: new Map(SLOTS.map((s, i) => [s, String(codes[i])])) }));
const blds = [["A 栋", rooms([
  ["A201", [2, 2, 1, 2, 2]],
  ["A202", [1, 1, 2, 2, 2]],
  ["A203", [2, 2, 2, 2, 1]],
  ["A205", [1, 2, 1, 2, 2]],
])], ["主楼", rooms([["101", [2, 2, 2, 2, 2]]])]];

const noop = () => {};
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
vm.runInContext(source.replace("  tide.ui.registerView({", `  globalThis.testApi = {jwState,jwRoomPlanHtml};\n  tide.ui.registerView({`), context);
const api = context.testApi;

/* 四种状态各来一张：有课有空教室 / 有课但这层这节全占 / 这天没课但往后有 / 课表没拉到 */
const CASES = {
  hit: { rows: [{ SKRQ: "2026-12-01", JC: "03", DDMC: "A201", KCMC: "数字电子技术" }] },
  full: {
    rows: [{ SKRQ: "2026-12-01", JC: "01", DDMC: "A205", KCMC: "大学英语" }],
    blds: [["A 栋", rooms([["A201", [1, 2, 2, 2, 2]], ["A202", [1, 2, 2, 2, 2]], ["A203", [1, 1, 1, 1, 1]]])]],
  },
  away: { rows: [{ SKRQ: "2026-12-03", JC: "01", DDMC: "A101", KCMC: "大学物理" }] },
  idle: { rows: null, error: "会话过期" },
};

const page = (body, w, mode) => `<!doctype html><meta charset="utf-8">
<html data-theme="classic" data-theme-mode="${mode}" style="--sat:0px;--sab:0px;--sal:0px;--sar:0px;--ui-text-scale:1">
<style>${rootCss}</style>
<style>${derivedCss}</style>
<style>${pluginCss}</style>
<style>body{margin:0;padding:14px;background:var(--bg,#f4f3ef);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;width:${w}px;box-sizing:border-box}</style>
<div class="pp-main">${body}</div>`;

for (const [label, cfg] of Object.entries(CASES)) {
  api.jwState.data.qjCourse = cfg.rows;
  api.jwState.error = cfg.error ? { qjCourse: cfg.error } : {};
  api.jwState.at = { qjCourse: Date.parse("2026-12-01T09:00:00") };
  const useBlds = cfg.blds || blds;
  for (const mode of ["light", "dark"]) {
    for (const w of [390, 720]) {
      const html = api.jwRoomPlanHtml({ slots: SLOTS, blds: useBlds, day: "2026-12-01" });
      const name = `plan-${label}-${mode}-${w}`;
      const file = new URL(`${name}.html`, OUT);
      fs.writeFileSync(file, page(html, w, mode), "utf8");
      // 注意：必须 fileURLToPath —— URL.pathname 是百分号编码的，中文目录下 Chrome
      // 会把截图写到一个不存在的路径且**不报错**，结果只看到上一次的旧图。
      const shot = fileURLToPath(new URL(`${name}.png`, OUT));
      execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--window-size=${w},420`,
        "--virtual-time-budget=900", `--screenshot=${shot}`, file.href], { stdio: "ignore" });
      console.log("写 " + name + ".png");
    }
  }
}
