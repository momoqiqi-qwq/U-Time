import { execFileSync } from "node:child_process";
import fs from "node:fs";

const url = new URL("./index.html", new URL("../.workbuddy/audit/", import.meta.url)).href;
const d = execFileSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [
  "--headless=new", "--disable-gpu", "--hide-scrollbars", "--window-size=1180,1400",
  "--virtual-time-budget=20000", "--allow-file-access-from-files", "--dump-dom", url,
], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
fs.writeFileSync(new URL("../.workbuddy/audit/dom.html", import.meta.url), d, "utf8");
console.log("len", d.length, "testApi", d.includes("testApi"), "stage", d.includes('class="stage'), "audit", d.includes('id="audit"'));
const i = d.indexOf('class="stage');
console.log(d.slice(Math.max(0, i - 200), i + 900).replace(/\s+/g, " "));
