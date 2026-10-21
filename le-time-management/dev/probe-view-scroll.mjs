// 开发用滚动探针：验证「切走再回来，滚动位置还在」（v0.274.0）。
// 只有真浏览器能证明：`.view` / `.plugview` 到底滚没滚、恢复是瞬移还是在滑。
//
//   npm run dev -- --port 5199 &          # 或者任意 UTIME_URL
//   node dev/probe-view-scroll.mjs http://localhost:5199/
//
// 做法：往 public/ 写一个同源壳页，用 iframe 装真应用（同源才能拿到 contentDocument），
// 壳页里按「滚 → 换页 → 回来」跑一遍并把结果写进 <pre id="out">，Chrome headless
// --dump-dom 读回来，跑完删掉临时页。不依赖 playwright（本包没装）。
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const base = (process.argv[2] || process.env.UTIME_URL || "http://localhost:5199/").replace(/\/$/, "");
const pagePath = new URL("../public/__probe-view-scroll.html", import.meta.url);

const shell = `<!doctype html><meta charset="utf-8"><title>probe-view-scroll</title>
<iframe id="app" src="${base}/" style="width:390px;height:800px;border:0"></iframe>
<pre id="out">running</pre>
<script>
const out = document.getElementById("out");
const lines = [];
const log = (...a) => { lines.push(a.join(" ")); out.textContent = lines.join("\\n"); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = document.getElementById("app");
const doc = () => frame.contentDocument;
const view = () => doc().querySelector(".view");
const nav = (id) => { const w = frame.contentWindow; w.dispatchEvent(new w.CustomEvent("tide:navigate", { detail: id })); };
const scrollTo = (node, top) => { node.style.scrollBehavior = "auto"; node.scrollTop = top; delete node.style.scrollBehavior; };

(async () => {
  for (let i = 0; i < 60; i++) {
    if (view() && doc().querySelector(".nav [data-view]")) break;
    await sleep(150);
  }
  if (!view()) { log("FAIL no .view"); return; }

  nav("market");
  await sleep(900);
  scrollTo(view(), 600);
  await sleep(60);
  const before = view().scrollTop;
  log("market scrolled", before);
  nav("quadrant");
  await sleep(700);
  log("fresh view starts at", view().scrollTop);
  nav("market");
  await sleep(30);
  const early = view().scrollTop;
  await sleep(500);
  const late = view().scrollTop;
  log("back 30ms / 530ms", early, late);
  log(before > 100 && late === before && early === late ? "PASS core" : "FAIL core");

  const ids = [...doc().querySelectorAll(".nav [data-view]")].map((n) => n.dataset.view).filter((id) => id.startsWith("plug:"));
  if (!ids.length) { log("SKIP no plugin views"); return; }
  const pid = ids[0];
  nav(pid);
  await sleep(1500);
  const inner = doc().querySelector(".plugview");
  if (!inner || inner.scrollHeight - inner.clientHeight < 200) { log("SKIP plugin not scrollable"); return; }
  scrollTo(inner, 300);
  await sleep(60);
  const innerBefore = inner.scrollTop;
  nav("quadrant");
  await sleep(700);
  nav(pid);
  await sleep(500);
  const after = doc().querySelector(".plugview")?.scrollTop ?? -1;
  log("plugin", pid, innerBefore, "->", after);
  log(innerBefore > 100 && after === innerBefore ? "PASS plugin" : "FAIL plugin");
})().catch((e) => log("ERROR", e && e.message));
<\/script>`;

fs.writeFileSync(pagePath, shell, "utf8");
const profile = fs.mkdtempSync("probe-scroll-");
let dom = "";
try {
  dom = execFileSync(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--disable-extensions", "--disable-background-networking",
    `--user-data-dir=${profile}`,                 // 不复用正在跑的 Chrome，否则可能不退出
    "--virtual-time-budget=30000", "--dump-dom", `${base}/__probe-view-scroll.html`,
  ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], timeout: 120000 });
} finally {
  fs.rmSync(pagePath, { force: true });
  fs.rmSync(profile, { recursive: true, force: true });
}

const hit = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
if (!hit) throw new Error("探针没跑起来（找不到 #out）");
const body = hit[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
console.log(body.trim());
if (/FAIL|ERROR/.test(body)) process.exitCode = 1;
