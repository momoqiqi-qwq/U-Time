/* 校园地图（插件 v1.91.0）：把 cppu-helper 那份校园点位（Rooms.java：7 栋楼 + 13 个地标）
   搬进 U-Time。数据只在本文件存一份，main.js 只负责外壳与注册。

   为什么是离线示意图而不是在线瓦片：
   cppu-helper 用的是 osmdroid + 高德在线瓦片（webrd01.is.autonavi.com）。本应用跑在
   Tauri WebView / Android WebView 里，离线、弱网、CSP 任一不合就整块变白；而这张图要回答的
   只是「A 区在校区哪一侧 / 食堂离宿舍多远」，不需要街道级细节与缩放平移。
   所以按真实经纬度**等比投影**画 SVG（1 user unit ≈ 0.4965 m，横纵同一比例），
   楼名直接画在图里 —— 字号可控，这正是「把楼名加大」要的东西（osmdroid 的 marker title
   是写死的 12sp，改不动）。

   真导航走「在高德打开」：Rooms 里是 GPS 原始值（WGS-84），高德底图是 GCJ-02，
   不换算直接丢 uri.amap.com 会偏 ~500 m，所以本文件带一份 wgs84 → gcj02 换算。

   与主文件的分工：本文件只画 [data-cp-host] 那一块；外壳（校园服务侧栏）由 main.js 画。
   跳「自习室」用 tide.util.navigate("cppu-room")，楼名口径与 main.js 的 jwRoomBuilding 对齐
   （A 栋 / E 栋 / 主楼 / 7S 楼），不另造一套叫法。 */

import { initialHit } from "./pinyin-initials.js";

/* ── 投影 ──────────────────────────────────────────────────────────────────
   校区外接框取 Rooms.java 全部点位的经纬度极值（不是地图截图的像素框）：
   lon 116.65732（边防食堂 / 信网处一带）→ 116.66310（东门，临西昌路）
   lat 39.52922（南门，临恒康道）→ 39.53579（D 区）
   东西 ≈500 m、南北 ≈730 m；按 1:1 比例把 1000 units 铺给东西向，
   南北向就自然是 1468 units（1000 × 728.9 / 496.5）。 */
const MAP = { lon0: 116.65732, lon1: 116.6631, lat0: 39.52922, lat1: 39.53579, w: 1000, h: 1468, pad: 96 };
const VB = { w: MAP.w + MAP.pad * 2, h: MAP.h + MAP.pad * 2 };
const M_PER_DEG_LON = 111320 * Math.cos((39.534 * Math.PI) / 180);
const UNITS_PER_M = MAP.w / ((MAP.lon1 - MAP.lon0) * M_PER_DEG_LON);

const px = (lon) => +(MAP.pad + ((lon - MAP.lon0) / (MAP.lon1 - MAP.lon0)) * MAP.w).toFixed(1);
const py = (lat) => +(MAP.pad + ((MAP.lat1 - lat) / (MAP.lat1 - MAP.lat0)) * MAP.h).toFixed(1);

/* ── 点位 ──────────────────────────────────────────────────────────────────
   big = 图上大字（一眼认得出的短名），sub = 官方全名（小字）。
   note = cppu-helper 里那条位置说明原样搬过来（含教室号，找教室时有用）。
   bld = 自习室（cppu-room）里的楼名口径；宿舍 / 食堂没有对应关系就不写 ——
         点进去只会看到「全部」，那不如不给按钮。
   dx = 标签微调（只解决互相压字，不改点位真坐标）。 */
const NODES = [
  { id: "a", kind: "teach", big: "A 区", sub: "综合教学楼", w: 100, h: 66, lat: 39.53523, lon: 116.65923, note: "A104 / A110 等", bld: "A 栋" },
  { id: "b", kind: "teach", big: "B 区", sub: "综合教学楼", w: 100, h: 66, lat: 39.53539, lon: 116.66012, note: "B102 / B110 / B111", bld: "B 栋" },
  { id: "c", kind: "teach", big: "C 区", sub: "综合教学楼", w: 100, h: 66, lat: 39.53539, lon: 116.66103, note: "C301 / C304", bld: "C 栋" },
  { id: "d", kind: "teach", big: "D 区", sub: "综合教学楼", w: 100, h: 66, lat: 39.53579, lon: 116.66007, note: "D 区教室", bld: "D 栋" },
  { id: "e", kind: "teach", big: "E 区", sub: "研究生楼", w: 104, h: 64, lat: 39.5347, lon: 116.66151, note: "E301 / E304 / E306", bld: "E 栋" },
  { id: "b1", kind: "teach", big: "1号教学楼", sub: "纯数字教室", w: 156, h: 72, lat: 39.53343, lon: 116.66044, note: "320 / 430 等纯数字房号", bld: "主楼" },
  { id: "b7", kind: "dorm", big: "7号楼", sub: "宿舍 · 7S", w: 96, h: 62, lat: 39.53448, lon: 116.65788, note: "7S-201 等，与 7 号宿舍楼同一栋", bld: "7S 楼" },
  { id: "d8", kind: "dorm", big: "8号楼", sub: "宿舍楼", w: 96, h: 60, lat: 39.53492, lon: 116.65815, note: "8 号宿舍楼" },
  { id: "d9", kind: "dorm", big: "9号楼", sub: "宿舍楼", w: 96, h: 60, lat: 39.53535, lon: 116.65806, note: "9 号宿舍楼" },
  { id: "cf", kind: "food", big: "边防食堂", sub: "", w: 116, h: 56, lat: 39.53507, lon: 116.65732, note: "边防食堂" },
  { id: "cg", kind: "food", big: "工程食堂", sub: "", w: 116, h: 56, lat: 39.53294, lon: 116.65761, note: "工程食堂" },
  { id: "cq", kind: "food", big: "清真食堂", sub: "", w: 104, h: 56, lat: 39.53189, lon: 116.65782, note: "清真食堂", dx: -10 },
  { id: "o1", kind: "office", big: "1号", big2: "办公楼", sub: "", w: 88, h: 64, lat: 39.5315, lon: 116.66062, note: "1号办公楼" },
  { id: "o2", kind: "office", big: "2号", big2: "办公楼", sub: "", w: 88, h: 64, lat: 39.53169, lon: 116.65838, note: "2号办公楼", dx: 12 },
  { id: "sv", kind: "service", big: "综合服务楼", sub: "", w: 152, h: 66, lat: 39.53429, lon: 116.66234, note: "综合服务楼" },
  { id: "xn", kind: "service", big: "信网处", sub: "信息网络处", w: 92, h: 56, lat: 39.53372, lon: 116.65751, note: "信息网络处" },
  { id: "sh", kind: "service", big: "校史馆", sub: "风雨训练楼", w: 100, h: 60, lat: 39.53166, lon: 116.65935, note: "校史馆 / 风雨训练楼" },
  { id: "ge", kind: "gate", big: "东门", sub: "临西昌路", w: 68, h: 48, lat: 39.53153, lon: 116.6631, note: "正门，临西昌路" },
  { id: "gs", kind: "gate", big: "南门", sub: "临恒康道", w: 68, h: 48, lat: 39.52922, lon: 116.65779, note: "南门，临恒康道" },
]

const KINDS = [
  ["all", "全部"],
  ["teach", "教学"],
  ["dorm", "宿舍"],
  ["food", "食堂"],
  ["office", "办公"],
  ["service", "服务"],
  ["gate", "校门"],
];

const BIG_FS = 28;   // 楼名大字：图上最大的那档（原来 osmdroid marker title 的 12sp 对不上真实比例）
const SUB_FS = 15;   // 官方全名
const GATE_FS = 24;  // 校门比楼小一档

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ── WGS-84 → GCJ-02（高德 / 腾讯底图用的国测局坐标）───────────────────────
   标准公开算法：偏移多项式 + 克拉索夫斯基椭球反算。实测校区一带偏移 = 经 +0.00136°
   （≈117 m）、纬 +0.00453°（≈502 m）—— 不换算的话高德上会落在校门外的街上。 */
function wgs2gcj(lat, lon) {
  const PI = Math.PI;
  const a = 6378245.0, ee = 0.006693421622965943;
  if (lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271) return { lat, lon };
  const tx = (x, y) => {
    let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
    r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
    r += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
    return r;
  };
  const ty = (x, y) => {
    let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
    r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
    r += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
    return r;
  };
  let dLat = ty(lon - 105, lat - 35);
  let dLon = tx(lon - 105, lat - 35);
  const radLat = (lat / 180) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((a * (1 - ee)) / (magic * sqrtMagic)) * PI);
  dLon = (dLon * 180) / ((a / sqrtMagic) * Math.cos(radLat) * PI);
  return { lat: +(lat + dLat).toFixed(6), lon: +(lon + dLon).toFixed(6) };
}

/* 高德地图 marker 深链：position 必须是 GCJ-02（所以带 coordinate=gaode），
   callnative=1 让手机上直接拉起 App，桌面上退化成网页。 */
export function amapMarkerUrl(node) {
  if (!node) return "";
  const g = wgs2gcj(node.lat, node.lon);
  const name = node.sub ? node.big + "（" + node.sub + "）" : node.big;
  return "https://uri.amap.com/marker?position=" + g.lon + "," + g.lat
    + "&name=" + encodeURIComponent(name) + "&coordinate=gaode&callnative=1";
}

/* ── 图 ─────────────────────────────────────────────────────────────────── */
/* 字要跟着楼的宽度收：A/B 中心距只有 154 units，5 个字一律 28 号会直接压到邻居身上。
   所以先按宽度反算字号（宁可变小也不溢出），再按行数把这一块垂直居中 —— 之前是
   固定「大字基线 = cy + 9.8」，副标题落到矩形下沿外面，看着像被色块压住。
   窄楼（1号/2号办公楼）用 big + big2 折两行，保住大字，而不是把 5 个字压成 14 号。 */
function fitFont(text, boxW, base, floor) {
  const len = Math.max(1, [...String(text)].length);
  return Math.max(floor, Math.min(base, Math.floor((boxW - 12) / len)));
}

function nodeSvg(n) {
  const x = px(n.lon), y = py(n.lat);
  const gate = n.kind === "gate";
  const lx = +(x + (n.dx || 0)).toFixed(1);
  const bigLines = n.big2 ? [n.big, n.big2] : [n.big];
  const bigFs = Math.min(...bigLines.map((t) => fitFont(t, n.w, gate ? GATE_FS : BIG_FS, 15)));
  const subFs = n.sub ? fitFont(n.sub, n.w, gate ? 13 : SUB_FS, 10) : 0;
  const lineH = bigFs * 1.02;
  const blockH = bigLines.length * lineH + (n.sub ? subFs * 1.1 + 2 : 0);
  const top = y - blockH / 2;
  const label = bigLines.join("·") + (n.sub ? " " + n.sub : "");
  let texts = "";
  bigLines.forEach((t, i) => {
    const baseY = +(top + lineH * (i + 0.82)).toFixed(1);
    texts += '<text class="cp-big" x="' + lx + '" y="' + baseY + '" font-size="' + bigFs + '">' + esc(t) + "</text>";
  });
  if (n.sub) {
    const subY = +(top + lineH * bigLines.length + subFs * 0.95 + 2).toFixed(1);
    texts += '<text class="cp-sub" x="' + lx + '" y="' + subY + '" font-size="' + subFs + '">' + esc(n.sub) + "</text>";
  }
  return '<g class="cp-node" data-cp-id="' + n.id + '" data-kind="' + n.kind + '" role="button" tabindex="0"'
    + ' aria-label="' + esc(label) + (n.note ? "，" + esc(n.note) : "") + '">'
    + '<rect class="cp-box" x="' + (x - n.w / 2).toFixed(1) + '" y="' + (y - n.h / 2).toFixed(1) + '" width="' + n.w + '" height="' + n.h + '" rx="' + (gate ? 8 : 11) + '"/>'
    + texts + "</g>";
}

/* 西昌路（东侧竖向）/ 恒康道（南侧横向）画在外接框外的空白里，
   再各拉一小段引线接到东门 / 南门 —— 图上要说清「出门是哪条路」。 */
function roadsSvg() {
  const eastX = MAP.pad + MAP.w + 40;
  const southY = MAP.pad + MAP.h + 34;
  const ye = py(39.5325);
  return '<g class="cp-roads" aria-hidden="true">'
    + '<rect class="cp-road" x="' + (eastX - 22) + '" y="52" width="44" height="' + (VB.h - 104) + '" rx="4"/>'
    + '<text class="cp-road-name" x="' + eastX + '" y="' + ye + '" transform="rotate(90 ' + eastX + " " + ye + ')">西昌路</text>'
    + '<rect class="cp-road" x="40" y="' + (southY - 22) + '" width="' + (VB.w - 80) + '" height="44" rx="4"/>'
    + '<text class="cp-road-name" x="' + px(116.6602) + '" y="' + (southY + 6) + '">恒康道</text>'
    + '<path class="cp-lead" d="M' + (px(116.6631) - 26) + " " + py(39.53153) + "H" + (eastX - 22) + '"/>'
    + '<path class="cp-lead" d="M' + px(116.65779) + " " + (py(39.52922) - 19) + "V" + (southY - 22) + '"/>'
    + "</g>";
}

export function campusMapNodes() {
  return NODES.map((n) => Object.assign({}, n, { x: px(n.lon), y: py(n.lat) }));
}

export function campusMapSvg() {
  const nodes = NODES.map(nodeSvg).join("");
  // 指北针放进校区框内的右上角空白，别压在右侧西昌路的路带上（那会看起来像路标）。
  const compassX = MAP.pad + MAP.w - 46;
  const barM = 100;
  const barLen = Math.round(UNITS_PER_M * barM);
  return '<svg class="cp-map" viewBox="0 0 ' + VB.w + " " + VB.h + '" xmlns="http://www.w3.org/2000/svg"'
    + ' role="group" aria-label="校园示意图：' + NODES.length + ' 个点位，点击看详情">'
    + '<defs><pattern id="cp-dots" width="40" height="40" patternUnits="userSpaceOnUse">'
    + '<circle class="cp-dot" cx="20" cy="20" r="1.1"/></pattern></defs>'
    + '<rect class="cp-ground" x="0" y="0" width="' + VB.w + '" height="' + VB.h + '" rx="18"/>'
    + '<rect class="cp-grid" x="0" y="0" width="' + VB.w + '" height="' + VB.h + '" rx="18" fill="url(#cp-dots)"/>'
    + '<rect class="cp-bound" x="44" y="44" width="' + (px(116.6631) + 26 - 44) + '" height="' + (py(39.52922) + 19 - 44) + '" rx="26"/>'
    + roadsSvg()
    + nodes
    + '<g class="cp-compass" aria-hidden="true">'
    + '<path d="M' + compassX + ' 100V56" stroke-linecap="round"/>'
    + '<path d="M' + compassX + ' 52l-9 16h18z"/>'
    + '<text x="' + compassX + '" y="124">N</text>'
    + "</g>"
    + '<g class="cp-scale" aria-hidden="true">'
    + '<path d="M70 80h' + barLen + '"/>'
    + '<path d="M70 74v12M' + (70 + barLen) + ' 74v12"/>'
    + '<text x="' + (70 + barLen / 2) + '" y="66">约 ' + barM + " m</text>"
    + "</g>"
    + "</svg>";
}
/* ── 视图 ───────────────────────────────────────────────────────────────── */
export function createCampusMapView(tide, bridge = {}) {
  const styleId = "cp-style";
  const state = { kind: "all", q: "", picked: "" };
  let root = null;
  let glow = null;
  let svgBox = null;
  let timer = 0;

  function styles() {
    if (typeof document === "undefined" || document.getElementById(styleId)) return;
    const node = document.createElement("style");
    node.id = styleId;
    node.textContent = `
.cp-wrap{display:grid;gap:12px;padding:2px 0 18px;font-size:calc(13px * var(--ui-text-scale));color:var(--ink)}
.cp-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.cp-head h2{margin:0;font-size:calc(16px * var(--ui-text-scale));font-weight:600;letter-spacing:.01em}
.cp-head .cp-when{margin-left:auto;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums}
.cp-tip{margin:0;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);line-height:1.65}
.cp-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.cp-kwbox{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:999px;
  background:var(--panel);padding:0 13px;height:32px}
.cp-kwbox .cp-kw-ico{display:inline-flex;color:var(--ink-3,#7E8B94)}
.cp-kw{font:inherit;font-size:calc(12px * var(--ui-text-scale));border:0;background:transparent;color:var(--ink);
  outline:none;width:16em;padding:0}

/* 类别单选（铁律六）：光块由宿主 tide.ui.selectionGlow 画在 .cp-chips 上，
   这里只给容器定位与一套配色，选中项把自己的底色让给光块。 */
.cp-chips{display:flex;gap:6px;position:relative;isolation:isolate;padding:2px;flex-wrap:wrap}
.cp-chips .selection-glow{position:absolute;left:0;top:0;width:0;height:0;opacity:0;pointer-events:none;z-index:0;
  transition:opacity .2s linear;border:1px solid color-mix(in srgb,var(--deep,#0F4C5C) 26%,var(--line));
  border-radius:999px;background:color-mix(in srgb,var(--deep,#0F4C5C) 10%,var(--panel))}
.cp-chips .selection-glow.on{opacity:1}
.cp-chip{position:relative;z-index:1;font:inherit;font-size:calc(12px * var(--ui-text-scale));
  padding:5px 13px;border-radius:999px;cursor:pointer;white-space:nowrap;
  border:1px solid var(--line);background:var(--panel);color:var(--ink-2,#4A5A66)}
.cp-chip.on{background:transparent;border-color:transparent;color:var(--deep,#0F4C5C);font-weight:700}
.cp-chip:focus-visible{outline:2px solid var(--deep,#0F4C5C);outline-offset:2px}

/* 图：外面这层负责滚动与圆角裁切，里面 SVG 定宽（窄屏横向可滑，不把字压小）。 */
.cp-viewport{border:1px solid var(--line);border-radius:var(--radius,14px);background:var(--cp-ground,#F7F4EC);
  overflow:auto;overscroll-behavior:contain;max-height:min(68vh,720px)}
.cp-map{display:block;width:100%;min-width:560px;height:auto}
.cp-map text{font-family:inherit;text-anchor:middle}
.cp-ground{fill:var(--cp-ground,#F7F4EC)}
.cp-grid{opacity:.55}
.cp-dot{fill:var(--cp-dot,#D9D2C2)}
.cp-bound{fill:none;stroke:var(--cp-bound,#C9BFA9);stroke-width:2.4;stroke-dasharray:12 10;opacity:.8}
.cp-road{fill:var(--cp-road,#E8E1D3)}
.cp-road-name{font-size:17px;font-weight:700;fill:var(--cp-road-ink,#5F5445);letter-spacing:.2em;paint-order:stroke;stroke:var(--cp-ground,#FAF8F3);stroke-width:3.5px;stroke-linejoin:round}
.cp-lead{stroke:var(--cp-road,#E8E1D3);stroke-width:14;stroke-linecap:round;fill:none}
.cp-compass path{stroke:var(--cp-ink-2,#5B6670);stroke-width:3;fill:none}
.cp-compass path:last-of-type{fill:var(--cp-ink-2,#5B6670);stroke:none}
.cp-compass text{font-size:15px;fill:var(--cp-ink-2,#5B6670);letter-spacing:.1em}
.cp-scale path{stroke:var(--cp-ink-3,#8C8171);stroke-width:2.4;stroke-linecap:round}
.cp-scale text{font-size:13px;fill:var(--cp-ink-3,#8C8171)}

/* 每栋楼：<rect> 是占地，两行字画在自己中心上。描边光晕用 paint-order=stroke，
   楼挨着楼时字也不会被底色切掉（A/B 中心距只有 154 units）。 */
.cp-node{cursor:pointer;outline:none}
.cp-node .cp-box{stroke-width:2;transition:fill .18s ease,stroke .18s ease}
.cp-node .cp-big{fill:var(--cp-ink,#22303A);font-weight:700;letter-spacing:.02em;
  paint-order:stroke;stroke:var(--cp-halo,#F7F4EC);stroke-width:5;stroke-linejoin:round}
.cp-node .cp-sub{fill:var(--cp-ink-3,#7E8B94);paint-order:stroke;stroke:var(--cp-halo,#F7F4EC);
  stroke-width:4;stroke-linejoin:round}
.cp-node:hover .cp-box,.cp-node:focus-visible .cp-box{stroke:var(--deep,#0F4C5C);stroke-width:3}
.cp-node.is-pick .cp-box{stroke:var(--deep,#0F4C5C);stroke-width:3.4}
.cp-node[data-dim="1"]{opacity:.14}

.cp-k-teach .cp-box{fill:var(--cp-teach-f,#DCEAF2);stroke:var(--cp-teach-s,#3D7EA6)}
.cp-k-dorm .cp-box{fill:var(--cp-dorm-f,#E7E3F4);stroke:var(--cp-dorm-s,#6A5AA6)}
.cp-k-food .cp-box{fill:var(--cp-food-f,#FBE6D5);stroke:var(--cp-food-s,#C4753C)}
.cp-k-office .cp-box{fill:var(--cp-office-f,#E3EEE3);stroke:var(--cp-office-s,#4E8A5E)}
.cp-k-service .cp-box{fill:var(--cp-service-f,#F3EADB);stroke:var(--cp-service-s,#A08A5E)}
.cp-k-gate .cp-box{fill:var(--cp-gate-f,#DEE3E7);stroke:var(--cp-gate-s,#6C7A85)}

/* 详情：grid-template-rows 0fr→1fr 做展开/收起（铁律七）—— 内容一直在 DOM 里，
   收起是连续插值到 0，不是 display:none 一把切掉。 */
.cp-detail{display:grid;grid-template-rows:0fr;transition:grid-template-rows .26s cubic-bezier(.2,.7,.3,1)}
.cp-detail.open{grid-template-rows:1fr}
.cp-detail>div{overflow:hidden}
.cp-card{display:grid;gap:8px;border:1px solid var(--line);border-left:3px solid var(--deep,#0F4C5C);
  border-radius:12px;background:var(--panel);padding:12px 14px;margin-top:2px}
.cp-card-h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.cp-card-h b{font-size:calc(15px * var(--ui-text-scale));font-weight:700}
.cp-card-h .cp-k{font-size:calc(10.5px * var(--ui-text-scale));padding:2px 8px;border-radius:999px;
  color:var(--deep,#0F4C5C);background:color-mix(in srgb,var(--deep,#0F4C5C) 11%,transparent)}
.cp-card p{margin:0;font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#4A5A66);line-height:1.7}
.cp-card .cp-geo{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums}
.cp-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
.cp-btn{font:inherit;font-size:calc(12px * var(--ui-text-scale));padding:6px 14px;border-radius:999px;cursor:pointer;
  border:1px solid var(--line);background:var(--panel);color:var(--ink);display:inline-flex;align-items:center;gap:6px}
.cp-btn:hover{border-color:var(--deep,#0F4C5C)}
.cp-btn.cp-primary{background:var(--deep,#0F4C5C);border-color:transparent;color:#fff}
.cp-btn:focus-visible{outline:2px solid var(--deep,#0F4C5C);outline-offset:2px}
.cp-empty{margin:0;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);line-height:1.7}

[data-theme-mode="dark"] .cp-wrap{--cp-ink:#F1EBDF;--cp-ink-2:#C6CDD2;--cp-ink-3:#98A2A9;--cp-halo:#1B2226;
  --cp-ground:#1B2226;--cp-dot:#2C353A;--cp-bound:#43504F;--cp-road:#242D32;--cp-road-ink:#CBD5DA;
  --cp-teach-f:#1F3846;--cp-teach-s:#4E9BC7;--cp-dorm-f:#2B2740;--cp-dorm-s:#8C7CD4;
  --cp-food-f:#40301F;--cp-food-s:#D08A4C;--cp-office-f:#22362A;--cp-office-s:#63A877;
  --cp-service-f:#372F21;--cp-service-s:#BFA271;--cp-gate-f:#2B3439;--cp-gate-s:#8697A1}

@media (prefers-reduced-motion: reduce){
  .cp-node .cp-box,.cp-detail,.cp-chips .selection-glow{transition:none}
}
`;
    document.head.append(node);
  }

  /* 铁律十：原文 / 拼音首字母 / 跳字简写都认，且逐字段比 —— 不做 join(" ") 后整串比，
     否则「西昌路」+「东门」会被拼出一个不存在的命中。 */
  const fieldsOf = (n) => [n.big, n.sub, n.note, n.bld].filter(Boolean);

  function hit(node, raw) {
    const q = String(raw || "").trim().toLowerCase().replace(/\s+/g, "");
    if (!q) return true;
    const fields = fieldsOf(node);
    if (fields.some((f) => String(f).toLowerCase().replace(/\s+/g, "").includes(q))) return true;
    if (/[a-z]/.test(q)) return fields.some((f) => initialHit(f, q));
    return false;
  }

  function visible(node) {
    return (state.kind === "all" || node.kind === state.kind) && hit(node, state.q);
  }

  function paint() {
    if (!root) return;
    let shown = 0;
    for (const g of root.querySelectorAll(".cp-node")) {
      const node = NODES.find((n) => n.id === g.dataset.cpId);
      const on = node ? visible(node) : false;
      if (on) shown += 1;
      g.dataset.dim = on ? "0" : "1";
      g.classList.toggle("is-pick", state.picked === (node && node.id));
    }
    const meta = root.querySelector("[data-cp-meta]");
    if (meta) {
      const narrowed = state.kind !== "all" || state.q;
      meta.textContent = narrowed ? shown + " / " + NODES.length + " 个点位" : NODES.length + " 个点位";
    }
    const empty = root.querySelector("[data-cp-empty]");
    if (empty) {
      empty.hidden = shown > 0;
      if (!shown) {
        empty.textContent = "没有匹配「" + state.q + "」的位置。搜楼名、教室号（如 A104）、食堂或校门都行，"
          + "也认拼音首字母（xwc = 信息网络处）与跳字简写（sht = 清真食堂按首字母跳字）。";
      }
    }
    glow?.sync?.();
  }

  function detailHtml() {
    const node = NODES.find((n) => n.id === state.picked);
    if (!node) return "";
    const kindLabel = (KINDS.find(([k]) => k === node.kind) || [, ""])[1];
    const tag = node.kind === "gate" ? "出入口" : kindLabel;
    return '<div class="cp-card">'
      + '<div class="cp-card-h"><b>' + esc(node.big) + '</b><span class="cp-k">' + esc(tag) + "</span></div>"
      + (node.sub ? "<p>" + esc(node.sub) + "</p>" : "")
      + (node.note && node.note !== node.sub && node.note !== node.big ? "<p>" + esc(node.note) + "</p>" : "")
      + '<span class="cp-geo">' + node.lat.toFixed(5) + "°N · " + node.lon.toFixed(5) + "°E · WGS-84 原始坐标</span>"
      + '<div class="cp-acts">'
      + '<button type="button" class="cp-btn cp-primary" data-cp-amap="' + esc(node.id) + '">在高德打开</button>'
      + (node.bld ? '<button type="button" class="cp-btn" data-cp-room="' + esc(node.bld) + '">看「' + esc(node.bld) + '」的自习室</button>' : "")
      + "</div></div>";
  }

  function pick(id) {
    const node = NODES.find((n) => n.id === id);
    state.picked = node && state.picked !== id ? id : "";
    const box = root && root.querySelector("[data-cp-detail]");
    if (box) {
      box.innerHTML = state.picked ? '<div>' + detailHtml() + "</div>" : "";
      box.classList.toggle("open", Boolean(state.picked));
    }
    paint();
  }

  function render(host) {
    styles();
    root = host;
    root.innerHTML = '<div class="cp-wrap">'
      + '<div class="cp-head"><h2>校园地图</h2><span class="cp-when" data-cp-meta></span></div>'
      + '<p class="cp-tip">按 cppu-helper 的官方坐标等比排布（不像素拉伸），点楼看位置说明；真导航点「在高德打开」。</p>'
      + '<div class="cp-bar"><span class="cp-kwbox">'
      + '<span class="cp-kw-ico"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.8-3.8"/></svg></span>'
      + '<input class="cp-kw" type="text" data-cp-q value="' + esc(state.q) + '" placeholder="搜楼 / 教室 / 食堂，可打拼音首字母…" aria-label="搜楼、教室、食堂、校门（支持原文、拼音首字母与跳字简写）">'
      + "</span></div>"
      + '<div class="cp-chips" data-cp-chips>' + KINDS.map(([k, label]) =>
        '<button type="button" class="cp-chip' + (state.kind === k ? " on" : "") + '" data-cp-kind="' + k + '" aria-pressed="' + (state.kind === k) + '">' + esc(label) + "</button>").join("")
      + "</div>"
      + '<div class="cp-viewport" data-cp-view>' + campusMapSvg() + "</div>"
      + '<p class="cp-empty" data-cp-empty hidden></p>'
      + '<div class="cp-detail" data-cp-detail></div>'
      + "</div>";

    svgBox = root.querySelector("[data-cp-view]");
    const chips = root.querySelector("[data-cp-chips]");
    if (chips && tide.ui && typeof tide.ui.selectionGlow === "function") {
      glow?.dispose?.();
      glow = tide.ui.selectionGlow(chips, { selector: ".cp-chip.on" });
    }

    root.addEventListener("click", (e) => {
      const chip = e.target.closest?.("[data-cp-kind]");
      if (chip && chips.contains(chip)) {
        state.kind = chip.dataset.cpKind || "all";
        for (const c of chips.querySelectorAll("[data-cp-kind]")) {
          const on = c.dataset.cpKind === state.kind;
          c.classList.toggle("on", on);
          c.setAttribute("aria-pressed", String(on));
        }
        state.picked = "";
        const box = root.querySelector("[data-cp-detail]");
        if (box) { box.innerHTML = ""; box.classList.remove("open"); }
        paint();
        return;
      }
      const amap = e.target.closest?.("[data-cp-amap]");
      if (amap) {
        const url = amapMarkerUrl(NODES.find((n) => n.id === amap.dataset.cpAmap));
        if (url) tide.util?.openUrl?.(url);
        return;
      }
      const room = e.target.closest?.("[data-cp-room]");
      if (room) {
        if (typeof bridge.openRoom === "function") bridge.openRoom(room.dataset.cpRoom);
        else tide.util?.navigate?.("cppu-room");
        return;
      }
      const g = e.target.closest?.("[data-cp-id]");
      if (g && svgBox && svgBox.contains(g)) pick(g.dataset.cpId);
    });

    root.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const g = e.target.closest?.("[data-cp-id]");
      if (!g) return;
      e.preventDefault();
      pick(g.dataset.cpId);
    });

    root.addEventListener("input", (e) => {
      const input = e.target.closest?.("[data-cp-q]");
      if (!input) return;
      const value = input.value;
      clearTimeout(timer);
      timer = setTimeout(() => { state.q = value; paint(); }, 90);
    });

    paint();
    return () => { clearTimeout(timer); glow?.dispose?.(); glow = null; root = null; svgBox = null; };
  }

  return { render, state };
}