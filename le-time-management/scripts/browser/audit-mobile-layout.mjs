// Optional Chromium audit of every registered page at Android-sized viewports.
// PLAYWRIGHT_PACKAGE_ROOT points to an isolated npm prefix containing playwright.
import { createRequire } from "node:module";
import { resolve, join } from "node:path";

const require = process.env.PLAYWRIGHT_PACKAGE_ROOT
  ? createRequire(join(resolve(process.env.PLAYWRIGHT_PACKAGE_ROOT), "package.json"))
  : createRequire(import.meta.url);
const { chromium } = require("playwright");
const base = process.env.UTIME_URL || "http://127.0.0.1:5179/";
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || "chrome" });
let failures = 0;

try {
  for (const width of [393, 360]) {
    const page = await browser.newPage({ viewport: { width, height: 852 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true });
    const errors = [];
    page.on("pageerror", error => errors.push(error.stack || error.message));
    await page.addInitScript(() => {
      document.documentElement.style.setProperty("--sat", "32px");
      document.documentElement.style.setProperty("--sab", "24px");
    });
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForSelector(".view");
    const ids = await page.evaluate(() => [...document.querySelectorAll(".nav [data-view]")].map(node => node.dataset.view));
    const pluginIds = await page.evaluate(() => [...document.querySelectorAll(".market-manage-card[data-card-id]")].map(node => node.dataset.cardId));
    const routes = [...new Set([...ids, "quadrant", "timeline", "timeblock", "inbox", "market", ...pluginIds.map(id => `plug:${id}`)])];
    for (const id of routes) {
      await page.evaluate(route => window.dispatchEvent(new CustomEvent("tide:navigate", { detail: route })), id);
      await page.waitForTimeout(300);
      const result = await page.evaluate(() => {
        const view = document.querySelector(".view");
        const content = view?.firstElementChild;
        const rect = content?.getBoundingClientRect();
        const visible = content && getComputedStyle(content).display !== "none";
        return {
          top: rect?.top ?? -1,
          left: rect?.left ?? -1,
          right: rect?.right ?? -1,
          scrollTop: view?.scrollTop ?? -1,
          docWidth: document.documentElement.scrollWidth,
          viewPadding: getComputedStyle(view).paddingTop,
          safeTop: getComputedStyle(view).getPropertyValue("--safe-top-anchor").trim(),
          insetTop: getComputedStyle(document.documentElement).getPropertyValue("--sat").trim(),
          visible,
          error: content?.textContent?.startsWith("插件视图出错") || false,
        };
      });
      const problems = [];
      if (!result.visible || result.error) problems.push("blank/error");
      if (result.top < 31) problems.push(`top=${result.top.toFixed(1)}`);
      if (result.scrollTop > 1) problems.push(`scroll=${result.scrollTop.toFixed(1)}`);
      if (result.docWidth > width + 1) problems.push(`horizontal=${result.docWidth}`);
      if (result.right > width + 1 || result.left < -1) problems.push(`bounds=${result.left.toFixed(1)}..${result.right.toFixed(1)}`);
      if (problems.length) failures++;
      console.log(`${width} ${id}: ${problems.length ? `${problems.join(", ")} [padding=${result.viewPadding}, anchor=${result.safeTop}, inset=${result.insetTop}]` : "OK"}`);
    }
    if (errors.length) {
      failures += errors.length;
      console.log(`${width} page errors: ${errors.join(" | ")}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
if (failures) process.exitCode = 1;
