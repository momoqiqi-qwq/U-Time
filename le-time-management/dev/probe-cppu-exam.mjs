// 开发用几何探针：媒体查询、列数、孤字折行这些只有真浏览器算得出来（vision 描述会飘）。
// 做法：把 .workbuddy/shots 里的静态页复制一份、末尾插一段测量脚本，用 Chrome headless
// --dump-dom 把结果读回来。不依赖 playwright（本包没装）。
//
//   node dev/probe-cppu-exam.mjs exam-upcoming-390.html
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const name = process.argv[2] || "exam-upcoming-390.html";
const src = new URL(`../.workbuddy/shots/${name}`, import.meta.url);
const probe = new URL(`../.workbuddy/shots/_probe.html`, import.meta.url);

const measure = `<script>
(() => {
  const r = {};
  r.viewport = innerWidth + "x" + innerHeight;
  r.overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
  const sum = document.querySelector(".jw-exam-sum");
  r.sumCols = sum ? getComputedStyle(sum).gridTemplateColumns : null;
  r.stats = [...document.querySelectorAll(".jw-exam-stat")].map((el) => {
    const b = el.querySelector("b"), s = el.querySelector("span");
    return { w: Math.round(el.getBoundingClientRect().width),
             b: b && b.textContent, bw: b ? Math.round(b.getBoundingClientRect().width) : 0,
             s: s && s.textContent, sw: s ? Math.round(s.getBoundingClientRect().width) : 0,
             sh: s ? Math.round(s.getBoundingClientRect().height) : 0 };
  });
  r.cards = [...document.querySelectorAll(".jw-exam-card")].map((el) => {
    const where = el.querySelector(".jw-exam-where");
    const items = where ? [...where.querySelectorAll(".jw-exam-wi")].map((i) => {
      const rc = i.getBoundingClientRect();
      return { t: i.textContent, top: Math.round(rc.top), h: Math.round(rc.height) };
    }) : [];
    return { course: el.querySelector(".jw-card-t")?.textContent,
             whereLines: new Set(items.map((i) => i.top)).size,
             items };
  });
  const box = document.createElement("pre");
  box.id = "probe";
  box.textContent = JSON.stringify(r);
  document.body.appendChild(box);
})();
<\/script>`;

fs.writeFileSync(probe, fs.readFileSync(src, "utf8").replace("</body>", measure + "</body>"), "utf8");
// 上面若页面没有 </body>（我们生成的页面就没有），退化成追加到末尾
if (!fs.readFileSync(src, "utf8").includes("</body>")) {
  fs.writeFileSync(probe, fs.readFileSync(src, "utf8") + measure, "utf8");
}
const w = name.includes("390") ? 390 : 1180;
const dom = execFileSync(CHROME, [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", `--window-size=${w},900`,
  "--virtual-time-budget=1500", "--dump-dom", probe.href,
], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const m = dom.match(/<pre id="probe">([\s\S]*?)<\/pre>/);
if (!m) throw new Error("探针没跑起来（找不到 #probe）");
const r = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
console.log(JSON.stringify(r, null, 2));
