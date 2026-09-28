import { el } from "./ui.js";
import { BUILTIN_PLUGINS } from "./pluginCatalog.js";

// Icons8 / iGoutu 图标源，统一为 Color 彩色风格（来源台账见 public/icons/{plugins,nav}/ATTRIBUTION.md）：
//  · 内置插件：随包 PNG public/icons/plugins/<插件ID>.png（tools/gen-plugin-icons.py 生成）；
//  · 主导航（四象限/时间块/收件箱/插件/设置/快速捕获）：随包 PNG public/icons/nav/<key>.png，
//    与插件同一套 Color 风格 —— v0.42.0 前导航走 CDN 的 iOS Filled 直链，离线即裂且风格不统一；
//  · 随包 PNG 加载失败才回落同风格 CDN 直链，URL 形如 img.icons8.com/color/96/<slug>.png。
const NAV_ICONS8 = {
  quadrant: ["four-squares", "grid-2", "grid"],
  timeline: ["timeline", "vertical-timeline"],
  timeblock: ["clock", "clock--v1"],
  inbox: ["inbox", "filled-in-box"],
  market: ["puzzle", "puzzle-piece"],
  settings: ["settings", "gear"],
  capture: ["inbox", "filled-in-box"],
};

// slug 与 public/icons/plugins/<插件ID>.png 一一对应（由 tools/gen-plugin-icons.py 生成）。
const PLUGIN_ICONS8 = {
  "shiguang-schedule": ["timetable", "calendar"],
  "web-collector": ["bookmark-ribbon", "bookmark"],
  "school-notice": ["school", "classroom"],
  pomodoro: ["tomato", "hourglass"],
  "weekly-report": ["statistics", "combo-chart--v1"],
  "gx-news": ["trophy"],
  "rss-reader": ["rss", "rss-square"],
  "chaoxing-notify": ["books", "graduation-cap"],
  "cppu-notify": ["university", "school-building"],
  // Color 风格没有微信标志，回落绿色对话气泡（随包 PNG 用的是 3d-fluency 的微信标志）。
  "wechat-push": ["speech-bubble", "chat"],
  "cn-holiday": ["lantern", "calendar"],
  "exam-calendar": ["test-passed", "calendar-plus"],
  "plugin-guide": ["help", "question-mark"],
};

const ICONS8 = { ...NAV_ICONS8, ...PLUGIN_ICONS8 };

const MANIFEST_ICON_KEYS = Object.fromEntries(BUILTIN_PLUGINS.map((plugin) => [plugin.id, plugin.icon || plugin.faIcon || "puzzle-piece"]));

const NAV_FA_ICONS = {
  quadrant: "table-cells-large",
  timeline: "timeline",
  timeblock: "clock",
  inbox: "inbox",
  market: "puzzle-piece",
  settings: "gear",
  capture: "inbox",
};

function colorUrl(name) {
  return `https://img.icons8.com/color/96/${name}.png`;
}

export function appIcon(key, title = "") {
  const manifestIcon = MANIFEST_ICON_KEYS[key];
  const isNav = Boolean(NAV_ICONS8[key]);
  // 随包目录：内置插件 → icons/plugins，主导航 → icons/nav；都没有（未知 key）→ 直接 CDN
  const bundledDir = manifestIcon ? "plugins" : isNav ? "nav" : null;
  const candidates = manifestIcon ? [manifestIcon, ...(ICONS8[key] || [])] : (ICONS8[key] || ICONS8.market);
  let index = bundledDir ? -1 : 0;
  let usingFallback = false;
  const img = el("img", {
    class: "app-icon icons8-app-icon",
    src: bundledDir ? `/icons/${bundledDir}/${key}.png` : colorUrl(candidates[index]),
    alt: title || "",
    title: title || null,
    loading: "eager",
    decoding: "async",
    draggable: "false",
    "data-icon-source": bundledDir === "plugins" ? "bundled plugin PNG (Icons8 Color)"
      : bundledDir === "nav" ? "bundled nav PNG (Icons8 Color)"
      : "Icons8 Color",
    "data-icon-key": manifestIcon || candidates[0],
  });
  img.addEventListener("error", () => {
    index += 1;
    if (index < candidates.length) {
      img.src = colorUrl(candidates[index]);
      return;
    }
    if (!usingFallback && key !== "market") {
      usingFallback = true;
      img.src = colorUrl(ICONS8.market[0]);
      return;
    }
    img.style.visibility = "hidden";
  }, { once: false });
  return img;
}

export function outlineAppIcon(name, title = "") {
  const iconName = NAV_FA_ICONS[name] || MANIFEST_ICON_KEYS[name] || name || "puzzle-piece";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "app-outline-icon fa-ic");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `/icons/fontawesome/solid.svg#${iconName}`);
  svg.append(use);
  return svg;
}
