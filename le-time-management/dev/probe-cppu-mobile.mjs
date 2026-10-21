// 窄屏（APK / 390 视口）几何探针：给 shot-cppu-*.mjs 渲出的静态页量真几何。
// 手法见 skill letime-mobile-ui-verify §1：Windows 无头 Chrome 的布局视口被钳在 500px，
// 所以必须用「外层页 + 精确尺寸 iframe」逼出 390 视口，媒体查询才会按 390 生效。
// 判据一律用几何 / 类名，不用 transform。
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.resolve(here, "../.workbuddy/shots");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUTER = path.join(shots, "__mobile-probe.html");

const CASES = [
  { name: "credit-390", src: "credit-390.html" },
  { name: "credit-required-390", src: "credit-required-390.html" },
  { name: "exam-upcoming-390", src: "exam-upcoming-390.html" },
  { name: "exam-open-390", src: "exam-open-390.html" },
  { name: "exam-ended-390", src: "exam-ended-390.html" }
];

const W = Number(process.env.PROBE_W || 390);
const H = 844;
// PROBE_APK=1：量 shot-*.mjs 用 SHOT_APK=1 渲出来的真机壳页面（深色 + 安全区 + 1.3 字号）
const APK = process.env.PROBE_APK === "1";
const SCALE = process.env.PROBE_SCALE || (APK ? "1.3" : "1.15");
const LIST = APK
  ? [
      { name: "exam-upcoming-apk", src: "exam-upcoming-apk.html" },
      { name: "exam-open-apk", src: "exam-open-apk.html" },
      { name: "exam-ended-apk", src: "exam-ended-apk.html" },
      { name: "credit-apk", src: "credit-apk.html" },
      { name: "credit-required-apk", src: "credit-required-apk.html" }
    ]
  : CASES;

const outerHtml = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#fff}iframe{border:0;display:block}</style>
<iframe id="f"></iframe>
<script>
const q = new URLSearchParams(location.search);
const f = document.getElementById("f");
const w = +(q.get("w") || 390), h = +(q.get("h") || 844);
f.style.width = w + "px"; f.style.height = h + "px";
f.onload = () => setTimeout(probe, 250);
f.src = q.get("src");

function rect(el) { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; }

function probe() {
  const doc = f.contentDocument, win = f.contentWindow;
  const de = doc.documentElement;
  const cw = de.clientWidth;
  const inScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = win.getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
    }
    return false;
  };
  const offenders = [];
  for (const el of doc.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (inScroller(el)) continue;
    const cls = String(el.className || el.tagName).slice(0, 56);
    if (r.right > cw + 1) offenders.push({ cls, side: "right", v: Math.round(r.right) });
    else if (r.left < -1) offenders.push({ cls, side: "left", v: Math.round(r.left) });
  }
  const many = (sel, n = 8) => [...doc.querySelectorAll(sel)].slice(0, n).map(rect);
  const wrapCount = (sel) => {
    const out = [];
    for (const el of [...doc.querySelectorAll(sel)].slice(0, 12)) {
      const lh = parseFloat(win.getComputedStyle(el).lineHeight) || 0;
      const h = el.getBoundingClientRect().height;
      // 单行判据：高度不超过 1.6 倍行高（行高来自作者样式，11.5~12px 的小字约 21px 单行）
      out.push({ h: Math.round(h), lh: Math.round(lh), wrapped: lh > 0 ? h > lh * 1.6 : false });
    }
    return out;
  };
  const probe = {
    viewport: { w: win.innerWidth, h: win.innerHeight, clientW: cw },
    scrollOverflow: de.scrollWidth - cw,
    offenderCount: offenders.length,
    offenders: offenders.slice(0, 10),
    examCards: many(".jw-exam-card", 6),
    examSumCols: (() => { const el = doc.querySelector(".jw-exam-sum"); return el ? win.getComputedStyle(el).gridTemplateColumns : null; })(),
    examStatHeights: many(".jw-exam-stat", 4).map((r) => r.h),
    examWiWrapped: wrapCount(".jw-exam-wi"),
    examDetailCols: (() => { const el = doc.querySelector(".jw-exam-detail"); return el ? win.getComputedStyle(el).gridTemplateColumns : null; })(),
    chips: many(".pp-chip", 8).map((r, i) => ({ ...r, on: [...doc.querySelectorAll(".pp-chip")][i]?.classList.contains("on") })),
    chipRow: (() => { const el = doc.querySelector(".pp-chips"); return el ? { scroll: el.scrollWidth, client: el.clientWidth } : null; })(),
    kw: (() => { const el = doc.querySelector(".pp-kw, .jw-kw, input[type=search], input[type=text]"); return el ? rect(el) : null; })(),
    creditCourses: many(".jw-credit-course", 6).map((r) => r.h),
    creditStats: many(".jw-credit-stat", 4),
    creditSum: (() => { const el = doc.querySelector(".jw-sum"); return el ? rect(el) : null; })(),
    creditCats: many(".jw-credit-cat", 4),
    // 真机壳两条：宿主 .view 的让位是否真吃到 --sat/--sab；内容首元素有没有被顶到状态栏底下
    shell: (() => { const el = doc.querySelector(".view"); if (!el) return null; const s = win.getComputedStyle(el); return { padTop: s.paddingTop, padBottom: s.paddingBottom }; })(),
    firstTop: (() => { const el = doc.querySelector(".jw-exam-card, .jw-sec, .jw-card"); return el ? Math.round(el.getBoundingClientRect().top) : null; })()
  };
  const pre = doc.createElement("pre");
  pre.id = "probe";
  pre.textContent = JSON.stringify(probe);
  document.body.appendChild(pre);
  document.title = "PROBE-READY";

  // 界面字号放大到 1.15（应用里 --ui-text-scale 的可选档）时再量一次：
  // 三列统计卡最窄只有 117px，放大后「01.12–01.15」这类长值最容易溢出。
  // 改完变量后同步读一次 rect —— 无头 rAF 只有 ~5fps，等帧会等不到。
  de.style.setProperty("--ui-text-scale", SCALE);
  void de.getBoundingClientRect();
  const bad = [];
  for (const el of doc.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (inScroller(el)) continue;
    if (r.right > cw + 1) bad.push({ cls: String(el.className || el.tagName).slice(0, 56), right: Math.round(r.right) });
  }
  probe.scaleBig = { scrollOverflow: de.scrollWidth - cw, offenderCount: bad.length, offenders: bad.slice(0, 6) };
  pre.textContent = JSON.stringify(probe);
}
</script>`;

await fs.writeFile(OUTER, outerHtml, "utf8");

function runChrome(url, profile) {
  return new Promise((res) => {
    const args = [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
      "--allow-file-access-from-files",
      "--user-data-dir=" + profile,
      `--window-size=${W},${H}`,
      "--virtual-time-budget=15000",
      "--dump-dom", url
    ];
    const p = spawn(CHROME, args);
    let buf = "";
    p.stdout.on("data", (d) => (buf += d));
    p.stderr.on("data", () => {});
    p.on("close", () => res(buf));
  });
}

/**
 * 截图模式：--shot <case> <高>
 * 静态页 load 即渲染完成，所以 --screenshot 无需等注入；窗口高必须显式给足，
 * 否则 iframe 下半截被窗口裁掉（skill §1.2.1 第 6 条）。
 */
async function screenshot(caseName, height) {
  const c = CASES.find((x) => x.name === caseName);
  if (!c) throw new Error("未知 case: " + caseName);
  const target = new URL("file:///" + path.join(shots, c.src).replace(/\\/g, "/"));
  const url = new URL("file:///" + OUTER.replace(/\\/g, "/"));
  url.searchParams.set("src", target.href);
  url.searchParams.set("w", String(W));
  url.searchParams.set("h", String(height));
  const png = path.join(shots, "mob-" + caseName + ".png");
  await fs.rm(png, { force: true });
  const profile = path.join(os.tmpdir(), "pp-shot-" + caseName + "-" + Date.now());
  await new Promise((res) => {
    const p = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
      "--allow-file-access-from-files",
      "--user-data-dir=" + profile,
      `--window-size=${W},${height}`,
      "--virtual-time-budget=6000",
      "--screenshot=" + png,
      url.href
    ]);
    p.on("close", res);
  });
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  console.log("shot: " + png);
}

if (process.argv[2] === "--shot") {
  await screenshot(process.argv[3] || "exam-upcoming-390", Number(process.argv[4] || 1500));
  await fs.rm(OUTER, { force: true });
  process.exit(0);
}

function readProbe(html) {
  const m = html.match(/<pre id="probe"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) return { error: "探针没跑起来", head: html.slice(0, 300) };
  const txt = m[1]
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return JSON.parse(txt);
}

const report = {};
for (const c of LIST) {
  const target = new URL("file:///" + path.join(shots, c.src).replace(/\\/g, "/"));
  const url = new URL("file:///" + OUTER.replace(/\\/g, "/"));
  url.searchParams.set("src", target.href);
  url.searchParams.set("w", String(W));
  url.searchParams.set("h", String(H));
  const profile = path.join(os.tmpdir(), "pp-probe-" + c.name + "-" + Date.now());
  const html = await runChrome(url.href, profile);
  report[c.name] = readProbe(html);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}

console.log(JSON.stringify(report, null, 2));
await fs.rm(OUTER, { force: true });
