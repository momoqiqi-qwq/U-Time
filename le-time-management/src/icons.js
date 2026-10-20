import { el } from "./ui.js";
import { BUILTIN_PLUGINS } from "./pluginCatalog.js";

// 随包彩色图标：插件与插件内视图用 Icons8 Color 彩色素材（v0.250.0 曾统一为自有扁平双色母版，
// 侧栏观感退回上一版后只保留主导航那套母版），主导航用自有扁平母版（tools/icon-masters/nav/）；
// 来源台账见 public/icons/{plugins,nav}/ATTRIBUTION.md。下面的 Icons8 slug 只用于随包 PNG 加载失败时的 CDN 回落：
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

// 插件内视图的独立图标（v0.216.0）：同一个插件的不同分类在侧栏各用各的图标。
// 过去侧栏一律拿插件图标（shell.js 的 `PLUGIN_ICONS[pluginId] || v.icon`），于是 cppu-notify
// 的七个分类在侧栏长得一模一样 —— 现在按视图 id 取图。
// key = 视图 id（= registerView 的 id），随包 PNG 由 tools/gen-plugin-icons.py 的 VIEW_ICONS 生成，
// 与插件图标同风格、同目录（public/icons/plugins/<视图 id>.png），这里是 CDN 回落候选。
// 选定后每个视图的图标必须两两不同，且不与同侧栏的其它插件撞（比如 学生请假 不能与
// 警大校历 同用 calendar、警大成绩 不能与周度报告 同用 statistics）。
const VIEW_ICONS8 = {
  "cppu-card": ["bank-cards", "credit-card", "card-in-hand"],
  "cppu-award": ["prize", "trophy"],
  "cppu-xk": ["todo-list", "checklist", "list"],
  "cppu-qj": ["calendar-delete", "calendar-minus", "leave"],
  "cppu-credit": ["line-chart", "combo-chart--v1", "statistics"],
  "cppu-cx": ["medal", "medal2", "diploma"],
  "cppu-calendar": ["calendar", "calendar--v1"],
  // 自习室：教室语义（不是 calendar —— 那是警大校历的）。
  // 首选 classroom 是随包 PNG 的实际来源（tools/icon-masters 里没有、也不许有它的母版）。
  "cppu-room": ["classroom", "door", "open-door"],
  "cppu-growth": ["sprout", "seedling", "plant-under-sun"],
  "cppu-profile": ["contact-card", "id-card", "business-contact"],
  // 上网记录：Dr.COM 自助服务的流量账单，取「联网」语义（不是图表 —— line-chart 已是警大成绩）。
  "cppu-net": ["network", "data-transfer", "network-wireless"],
  "cppu-mail": ["email", "mail", "envelope"],
};

// 视图 id → 轮廓图标用的 FontAwesome 名（与 registerView 的 icon 一致）。
// 注意这里是**两套名字空间**：轮廓走 FA solid sprite，彩色 PNG 走 Icons8 Color slug，别混。
// 取值还有一条硬约束：**同一个侧栏里不许撞** —— 插件图标与其它分类都不能同名，
// 所以 获奖名单 用 award（不是 trophy，那是「竞赛消息」的）、校历 用 calendar-week
// （不是 calendar-days，那是「课程表」的、也不是 calendar-check，那是「考试日历」的）。
const VIEW_FA_ICONS = {
  "cppu-card": "credit-card",
  "cppu-award": "award",
  "cppu-xk": "list-check",
  "cppu-qj": "calendar-xmark",
  "cppu-credit": "chart-line",
  "cppu-cx": "medal",
  "cppu-calendar": "calendar-week",
  // 自习室 用 door-open：一扇开着的门，与教务子菜单里其余视图图标都不撞。
  "cppu-room": "door-open",
  "cppu-growth": "seedling",
  // 个人信息 用 address-card（不是 id-card，那是本插件侧栏「学工」入口的图标）。
  "cppu-profile": "address-card",
  // 上网记录 用 network-wired（chart-line 已是警大成绩、chart-column 已被周度报告占用）。
  "cppu-net": "network-wired",
  "cppu-mail": "envelope",
};

const ICONS8 = { ...NAV_ICONS8, ...PLUGIN_ICONS8, ...VIEW_ICONS8 };

// 有随包 PNG 的 key：内置插件 id（manifest 的 icon/faIcon）＋ 插件内视图 id（VIEW_FA_ICONS）。
const BUNDLED_ICON_KEYS = {
  ...Object.fromEntries(BUILTIN_PLUGINS.map((plugin) => [plugin.id, plugin.icon || plugin.faIcon || "puzzle-piece"])),
  ...VIEW_FA_ICONS,
};

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
  const manifestIcon = BUNDLED_ICON_KEYS[key];
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
      : bundledDir === "nav" ? "bundled nav PNG (flat masters)"
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
  const iconName = NAV_FA_ICONS[name] || BUNDLED_ICON_KEYS[name] || name || "puzzle-piece";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "app-outline-icon fa-ic");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `/icons/fontawesome/solid.svg#${iconName}`);
  svg.append(use);
  return svg;
}
