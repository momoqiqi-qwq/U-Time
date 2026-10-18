// 提取 cppu-notify 插件的「真实 CSS + 真实 HTML 片段」供无头 Chrome 截图验证。
// 手法与 scripts/test-cppu.mjs 同源：vm 里打桩 tide，把内部函数暴露出来再调用，
// CSS 走 ensureStyle() 真注入（不手抄），HTML 用种子数据真渲染（不手抄）。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LM = "E:/E-Develop-Project/时间管理软件/le-time-management";
const OUT = path.join(HERE, "probe");
mkdirSync(OUT, { recursive: true });

const source = readFileSync(path.join(LM, "public/plugins/cppu-notify/main.js"), "utf8");

let capturedCss = "";
const context = vm.createContext({
  URL, Set, Map, Date, console, setTimeout, clearTimeout, setInterval, clearInterval,
  document: {
    getElementById: () => null,
    createElement: () => ({ set textContent(v) { capturedCss = v; }, style: {} }),
    head: { append() {}, appendChild() {} },
    querySelectorAll: () => [],
    addEventListener() {},
  },
  tide: {
    ui: { registerView() {} },
    http: { session: async () => "s1", restoreCookies: async () => "sid", fetch: async () => ({ ok: false, status: 0, text: async () => "", json: async () => ({}) }) },
    storage: { _d: {}, async get(k, d) { return k in this._d ? this._d[k] : (d === undefined ? null : d); }, async set(k, v) { this._d[k] = v; } },
    vault: { get: async () => null, set: async () => {}, del: async () => {} },
    util: { openUrl: async () => true, navigate() {} },
    notify: async () => true,
    events: { on() {}, off() {}, emit() {} },
    log: { info() {}, warn() {}, error() {} },
  },
});

const EXPORTS = "cardStatsHtml,jwLeaveSummaryHtml,jwLeaveHtml,cardState,jwState,ensureStyle,esc,cardMoney,cardTotals";
vm.runInContext(
  source.replace("  tide.ui.registerView({", `  globalThis.testApi = {${EXPORTS}};\n  tide.ui.registerView({`),
  context,
);
const api = context.testApi;

// ── 种子数据：数值对齐用户截图（总充值 ¥8800.00 / 已花费 ¥8484.30 / 余额 ¥315.70；请假 6/0/5/1） ──
const day = (m, d) => `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const inRows = [];
for (let i = 0; i < 23; i++) inRows.push({ id: `in${i}`, date: day(9, (i % 27) + 1), amount: 365, note: "一卡通充值", kind: "in", at: Date.parse(day(9, (i % 27) + 1)) });
inRows.push({ id: "in23", date: day(10, 12), amount: 405, note: "一卡通充值", kind: "in", at: Date.parse(day(10, 12)) });
const outRows = [];
for (let i = 0; i < 1264; i++) outRows.push({ id: `out${i}`, date: day(8, (i % 28) + 1), amount: 6.7, note: "食堂消费", kind: "out", at: Date.parse(day(8, (i % 28) + 1)) });
outRows.push({ id: "out1264", date: day(10, 16), amount: 15.5, note: "商超消费", kind: "out", at: Date.parse(day(10, 16)) });

api.cardState.rows = [...inRows, ...outRows];
api.cardState.balance = 315.7;
api.cardState.balanceAt = Date.parse("2026-10-17T20:50:31");
api.cardState.syncedAt = Date.parse("2026-10-17T20:50:31");
api.cardState.username = "2025290058";

const rec = (name, zt) => ({ KCMC: name, SKRQ: "2026-10-14", JC: "3-4", JSXMS: "张三", JSMC: "已请假", SQZT: zt, SQYY: "因身体不适需前往校医院就诊" });
api.jwState.data.qjRecord = [
  rec("大学英语（三）", "1"), rec("高等数学（下）", "1"), rec("大学物理", "1"),
  rec("刑法学", "1"), rec("警务战术", "1"), rec("计算机基础", "3"),
];
api.jwState.data.qjCourse = Array.from({ length: 222 }, (_, i) => ({ KCMC: `课程${i}`, id: String(i) }));
api.jwState.term = { name: "2026年秋季学期", code: "20262027-1" };
api.jwState.at = { qjRecord: Date.parse("2026-10-17T20:50:31"), qjCourse: Date.parse("2026-10-17T20:50:31") };

api.ensureStyle();
writeFileSync(path.join(OUT, "cppu-notify.css"), capturedCss);

const cardHtml = api.cardStatsHtml();
const leaveHtml = api.jwLeaveSummaryHtml();

// 粗校验：图标必须真的在输出里（v1.61.0 起是内联 SVG，不再有 PNG），且数值与截图一致
for (const [tag, html, needles, iconCount] of [
  ["card", cardHtml, ["pp-metric-ico", "¥8800.00", "¥8484.30", "¥315.70"], 3],
  ["leave", leaveHtml, ["pp-metric-ico", ">6<", ">5<", ">1<"], 4],
]) {
  for (const n of needles) {
    if (!html.includes(n)) { console.error(`MISSING in ${tag}: ${n}`); process.exit(1); }
  }
  const n = (html.match(/class="pp-metric-ico"/g) || []).length;
  if (n !== iconCount) { console.error(`ICON COUNT in ${tag}: ${n} != ${iconCount}`); process.exit(1); }
}
writeFileSync(path.join(OUT, "card-fragment.html"), cardHtml);
writeFileSync(path.join(OUT, "leave-fragment.html"), leaveHtml);
console.log("css bytes:", capturedCss.length, "| card bytes:", cardHtml.length, "| leave bytes:", leaveHtml.length);
