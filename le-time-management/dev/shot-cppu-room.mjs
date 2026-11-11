// 开发用：把「自习室」视图真跑一遍、渲成静态 HTML 再截图看几何。
// 不进测试套件（test-*.mjs 才是），只给改布局时对照一眼。
//
//   node dev/shot-cppu-room.mjs      → .workbuddy/shots/room-*.html + *.png
//
// 三段拼接（与 shot-cppu-exam.mjs 同一套路）：宿主 :root 令牌（src/styles.css）
// + 插件自己的样式块（main.js 的 ensureStyle）+ jwRoomHtml() 的真输出。
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
/* 深色色板在生成物里（gen-theme-dark.js），不带上它 data-theme-mode="dark" 只是换了个属性、颜色没变 */
const derivedPath = new URL("../src/styles/theme-derived.css", import.meta.url);
const derivedCss = fs.existsSync(derivedPath) ? fs.readFileSync(derivedPath, "utf8") : "";

/* 夹具：3 栋楼 × 4 间 × 5 个节次，主楼有全天空闲的、有全占的 —— 好一次看到三种标 */
const SLOTS = ["01", "02", "03", "04", "05"];
function rows() {
  const out = [];
  const plan = [
    ["101", "主楼", 0, 0, 0, 0, 0],   // 全天空闲
    ["102", "主楼", 1, 1, 1, 1, 1],   // 全天占用
    ["103", "主楼", 1, 2, 2, 1, 2],
    ["104", "主楼", 2, 2, 2, 2, 2],
    ["A201", "A 栋", 2, 2, 1, 2, 2],
    ["A202", "A 栋", 1, 1, 2, 2, 2],
    ["jtj101", "阶梯教室", 2, 1, 1, 2, 2],
  ];
  for (const [name, , ...codes] of plan) {
    codes.forEach((code, i) => out.push({ YWMC: name, JC: SLOTS[i], SFZY: String(code), RQ: "2026-10-21" }));
  }
  return out;
}

const noop = () => {};
function render(bld) {
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
  vm.runInContext(source.replace("  tide.ui.registerView({", `  globalThis.testApi = {jwState,jwRoomHtml};\n  tide.ui.registerView({`), context);
  const api = context.testApi;
  api.jwState.data.room = rows();
  api.jwState.at.room = Date.parse("2026-10-21T22:17:00");
  api.jwState.term = { code: "20262027-1", name: "2026-2027 学年第 1 学期" };
  // 首页「今天去哪」（v1.90.0）：与自习室行同一天的一节课，落在 A 栋 2 层（A201 / A202）
  api.jwState.data.qjCourse = [{ SKRQ: "2026-10-21", JC: "03", DDMC: "A201", KCMC: "数字电子技术" }];
  api.jwState.at.qjCourse = Date.parse("2026-10-21T22:17:00");
  api.jwState.roomBld = bld;
  return api.jwRoomHtml();
}

const page = (body, w, mode = "light") => `<!doctype html><meta charset="utf-8">
<html data-theme="classic" data-theme-mode="${mode}" style="--sat:0px;--sab:0px;--sal:0px;--sar:0px;--ui-text-scale:1">
<style>${rootCss}</style>
<style>${derivedCss}</style>
<style>html,body{margin:0;background:var(--bg,#f4f3ef);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
body{padding:0;box-sizing:border-box;width:100%;max-width:${w}px}
.view{box-sizing:border-box;min-height:100vh}</style>
<style>${pluginCss}</style>
<div class="view"><div class="pp-wrap"><div class="pp-shell"><div class="pp-main"></div></div></div></div>
<script>document.querySelector(".pp-main").innerHTML = ${JSON.stringify(body)};<\/script>`;

for (const [name, bld] of [["room-all", ""], ["room-main-bld", "主楼"]]) {
  for (const [suffix, w] of [["", 1180], ["-390", 390]]) {
    // 深色只出一张手机宽度：看的是「今天去哪」那张卡的底/边/小字，桌面版同一套令牌
    for (const mode of w === 390 ? ["light", "dark"] : ["light"]) {
      const tag = mode === "dark" ? `${suffix}-dark` : suffix;
      const html = new URL(`${name}${tag}.html`, OUT);
      fs.writeFileSync(html, page(render(bld), w, mode), "utf8");
      // 必须 fileURLToPath：URL.pathname 是百分号编码的，中文目录下 Chrome 会把截图
      // 写到一个不存在的路径且不报错 —— 留下上一次的旧图，看着像「改动没生效」。
      const shot = fileURLToPath(new URL(`${name}${tag}.png`, OUT));
      execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--window-size=${w},1400`,
        "--virtual-time-budget=1200", `--screenshot=${shot}`,
        html.href], { stdio: "ignore" });
      console.log("写 " + name + tag + ".html / .png");
    }
  }
}
