// 截图验证：一卡通三卡 + 请假汇总卡的徽章落位。
// 页面素材全部是真的：/__app.css = src/styles.css + theme-derived.css（真实主题令牌），
// /probe/cppu-notify.css 与两个 fragment 由 extract-fragments.mjs 从插件真实提取，
// 徽章 PNG 走 /plugins/cppu-notify/badges/ 与线上同一路径。
// 窄屏用「外层页 + 390px 精确 iframe」逼真视口（Windows 无头 Chrome 布局视口被钳在 500px）。
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync, rmSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 仓库根 = docs/design/card-badges 往上三层，别写死本机绝对路径。
const LM = path.resolve(HERE, "../../../le-time-management");
const PROBE = path.join(HERE, "probe");
const OUT = path.join(HERE, "shots");
mkdirSync(OUT, { recursive: true });
const CH = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const CARD_STATUS = "已自动登录并同步 1289 笔一卡通流水（充值 24 笔 / 消费 1265 笔）。";

const page = (mode, body, probe) => `<!doctype html><html lang="zh-CN" data-theme="classic" data-theme-mode="${mode}">
<head><meta charset="utf-8"><title>${mode}</title>
<link rel="stylesheet" href="/__app.css">
<link rel="stylesheet" href="/probe/cppu-notify.css">
<style>html,body{margin:0;background:var(--bg);color:var(--ink);font-family:"Microsoft YaHei",system-ui,sans-serif}
.view{padding:16px 20px}.pp-main{min-width:0}
*,*::before,*::after{transition:none!important;animation:none!important}</style>
</head><body><div class="view plugview"><div class="pp-main"><div class="pp-wrap">${body}</div></div></div>
${probe ? `<script>
window.addEventListener("load", () => setTimeout(() => {
  const de = document.documentElement;
  const imgs = [...document.querySelectorAll("img")].map((i) => ({ src: i.src.split("/").pop(), nw: i.naturalWidth, w: Math.round(i.getBoundingClientRect().width) }));
  const svgs = [...document.querySelectorAll(".pp-metric-ico")].map((s) => {
    const b = s.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), vb: s.getAttribute("viewBox"), color: s.style.color };
  });
  const cards = [...document.querySelectorAll(".yk-total,.yk-spent,.yk-balance")].map((c) => Math.round(c.getBoundingClientRect().width));
  const metrics = [...document.querySelectorAll(".jg-metric")].map((c) => Math.round(c.getBoundingClientRect().width));
  const over = [...document.querySelectorAll(".pp-wrap *")].filter((el) => {
    const b = el.getBoundingClientRect();
    return b.width > 0 && (b.right > de.clientWidth + 1 || b.left < -1);
  }).map((el) => el.className || el.tagName);
  const data = {
    iw: window.innerWidth, mq700: matchMedia("(max-width:700px)").matches,
    scrollW: de.scrollWidth, clientW: de.clientWidth,
    imgs, svgs, cards, metrics, over: over.slice(0, 6),
  };
  if (window.parent !== window) parent.postMessage({ probe: data }, "*");
  else document.title = "PROBE:" + JSON.stringify(data);
}, 400));
</script>` : ""}
</body></html>`;

const outer = (src, qs) => `<!doctype html><html><head><meta charset="utf-8"><title>outer</title>
<style>html,body{margin:0;background:#888}iframe{display:block;width:390px;height:100vh;border:0}</style>
</head><body><iframe src="${src}?${qs}"></iframe>
<script>window.addEventListener("message",(e)=>{if(e.data&&e.data.probe)document.title="PROBE:"+JSON.stringify(e.data.probe);});</script>
</body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);
  const mode = url.searchParams.get("mode") || "light";
  if (p === "/__app.css") {
    const a = readFileSync(path.join(LM, "src/styles.css"), "utf8");
    const b = existsSync(path.join(LM, "src/styles/theme-derived.css")) ? readFileSync(path.join(LM, "src/styles/theme-derived.css"), "utf8") : "";
    res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
    return res.end(a + "\n" + b);
  }
  if (p === "/probe/cppu-notify.css") {
    res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
    return res.end(readFileSync(path.join(PROBE, "cppu-notify.css"), "utf8"));
  }
  if (p === "/probe/card.html" || p === "/probe/leave.html") {
    const frag = readFileSync(path.join(PROBE, p.endsWith("card.html") ? "card-fragment.html" : "leave-fragment.html"), "utf8");
    const body = p.endsWith("card.html")
      ? `<div class="yk-status" data-card-status role="status" aria-live="polite">${CARD_STATUS}</div>${frag}`
      : `<div class="jw-kicker">教 务 · 学 生 请 假</div><div class="jw-head"><h3>警大请假</h3><span>2026年秋季学期（20262027-1）</span></div><div class="jw-tip">这里可以直接选课次、填写请假理由并生成申请草稿；点「去教务提交」会免密打开教务，最终提交仍由学校系统确认。</div><div class="jw-leave">${frag}</div>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(page(mode, body, url.searchParams.get("probe") === "1"));
  }
  if (p === "/__outer.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(outer(url.searchParams.get("src"), url.searchParams.toString().replace(/^src=[^&]*&?/, "")));
  }
  const map = [[/^\/plugins\//, path.join(LM, "public/plugins")]];
  for (const [re, base] of map) {
    if (!re.test(p)) continue;
    const file = path.join(base, p.replace(re, ""));
    if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) break;
    res.writeHead(200, { "content-type": file.endsWith(".png") ? "image/png" : "application/octet-stream" });
    return res.end(readFileSync(file));
  }
  res.writeHead(404).end("nope");
});

const shots = [
  ["card-wide-light", "/probe/card.html?mode=light", 1280, 760],
  ["card-wide-dark", "/probe/card.html?mode=dark", 1280, 760],
  ["leave-wide-light", "/probe/leave.html?mode=light", 1280, 620],
  ["leave-wide-dark", "/probe/leave.html?mode=dark", 1280, 620],
  ["card-narrow-light", "/__outer.html?src=/probe/card.html&mode=light", 400, 900],
  ["card-narrow-dark", "/__outer.html?src=/probe/card.html&mode=dark", 400, 900],
  ["leave-narrow-light", "/__outer.html?src=/probe/leave.html&mode=light", 400, 900],
  ["leave-narrow-dark", "/__outer.html?src=/probe/leave.html&mode=dark", 400, 900],
];

if (process.argv[2] === "serve") {
  await new Promise((r) => server.listen(8792, r));
  console.log("serving on 8792");
  // 常驻模式：截图由另一次调用（shoot）完成 —— 同一 node 进程里 execFileSync 拉起的
  // Chrome 连不上本进程的 127.0.0.1（2026-09-18 实测，--dump-dom 出空 DOM）。
  process.on("SIGTERM", () => { server.close(); process.exit(0); });
  setInterval(() => {}, 1 << 30);
} else {
console.log("shooting (server must be running separately)");
let bad = 0;
for (const [name, url, w, h] of shots) {
  const shot = path.join(OUT, name + ".png");
  try {
    execFileSync(CH, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-sandbox",
      `--user-data-dir=${path.join(HERE, "tmp-profile")}`,
      `--window-size=${w},${h}`, "--virtual-time-budget=8000",
      `--screenshot=${shot}`, "http://127.0.0.1:8792" + url,
    ], { stdio: "ignore" });
    const ok = existsSync(shot) && statSync(shot).size > 3000;
    if (!ok) bad++;
    console.log(ok ? "ok  " : "EMPTY", name, existsSync(shot) ? statSync(shot).size : 0);
  } catch (e) { bad++; console.log("ERR ", name, String(e).slice(0, 120)); }
}
rmSync(path.join(HERE, "tmp-profile"), { recursive: true, force: true });
console.log(bad ? `DONE with ${bad} problems` : "DONE all shots ok");
}
