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
  api.jwState.roomBld = bld;
  return api.jwRoomHtml();
}

const page = (body, w) => `<!doctype html><meta charset="utf-8">
<html data-theme="classic" data-theme-mode="light" style="--sat:0px;--sab:0px;--sal:0px;--sar:0px;--ui-text-scale:1">
<style>${rootCss}
html,body{margin:0;background:var(--bg,#f4f3ef);font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
body{padding:0;box-sizing:border-box;width:100%;max-width:${w}px}
.view{box-sizing:border-box;min-height:100vh}</style>
<style>${pluginCss}</style>
<div class="view"><div class="pp-wrap"><div class="pp-shell"><div class="pp-main"></div></div></div></div>
<script>document.querySelector(".pp-main").innerHTML = ${JSON.stringify(body)};<\/script>`;

for (const [name, bld] of [["room-all", ""], ["room-main-bld", "主楼"]]) {
  for (const [suffix, w] of [["", 1180], ["-390", 390]]) {
    const html = new URL(`${name}${suffix}.html`, OUT);
    fs.writeFileSync(html, page(render(bld), w), "utf8");
    execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--window-size=${w},1400`,
      "--virtual-time-budget=1200", `--screenshot=${path.join(OUT.pathname.replace(/^\//, ""), `${name}${suffix}.png`)}`,
      html.href], { stdio: "ignore" });
    console.log("写 " + name + suffix + ".html / .png");
  }
}
