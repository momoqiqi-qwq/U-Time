#!/usr/bin/env node
// 「HTML 目录」插件图标生成器（纯 Node，不依赖 Pillow）
//
// 为什么不走 tools/gen-plugin-icons.py：那个脚本的母版 + Icons8 线路都需要 Pillow，
// 而本机 workbuddy 的 python venv 解释器缺失，跑不起来。这里用同一套色板
// （styles.css 的 --deep / --sea / --sun / --coral / --mint）直接画 81×81 透明 PNG，
// 输出到 miniprogram/images/plugins/html-gallery.png —— 那是图标的单一事实源，
// 桌面端副本由 `node tools/sync-plugins.js` 复制过去，**不要手工改输出目录里的 PNG**。
//
// 造型：深青圆角块 + 纸白「页面」+ 顶部三个浏览器圆点 + 山海剪影（图片占位的经典读法）。
// 用法：node tools/gen-html-gallery-icon.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "miniprogram", "images", "plugins", "html-gallery.png");

const SIZE = 81;
const SS = 4; // 超采样倍率：4×4 覆盖采样，边缘够平滑

const C = {
  deep: [0x0f, 0x4c, 0x5c],
  sea: [0x11, 0x8a, 0xb2],
  sun: [0xe3, 0xa0, 0x08],
  coral: [0xff, 0x6b, 0x6b],
  mint: [0x2e, 0xc4, 0xb6],
  paper: [0xf7, 0xf6, 0xf2],
};

const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/** 圆角矩形内的点判定 */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 三角形：同向叉积法 */
function inTriangle(x, y, ax, ay, bx, by, cx, cy) {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/** 取该点的颜色（null = 透明）。后画的形状先判，即画家算法。 */
function sample(x, y) {
  // 页面里的内容（先判最上层）。山脚压到页面底边（64）才像"照片"，悬空会显得没画完。
  if (inCircle(x, y, 50, 32, 5.2)) return C.sun;
  if (inTriangle(x, y, 21, 64, 41, 34, 62, 64) && inRoundRect(x, y, 19, 17, 62, 64, 6)) return C.sea;
  // 三个浏览器圆点
  if (inCircle(x, y, 24.5, 22, 2.1)) return C.coral;
  if (inCircle(x, y, 30.5, 22, 2.1)) return C.sun;
  if (inCircle(x, y, 36.5, 22, 2.1)) return C.mint;
  // 纸白页面
  if (inRoundRect(x, y, 19, 17, 62, 64, 6)) return C.paper;
  // 底色块（上浅下深的双档，模拟母版那种柔和明暗）
  if (inRoundRect(x, y, 4.5, 4.5, 76.5, 76.5, 17)) {
    const t = Math.min(1, Math.max(0, (y - 4.5) / 72));
    const base = lerp(C.sea, C.deep, t);
    // 左上角一层奶油色高光（母版风格里的内高光）
    const hi = Math.max(0, 1 - Math.hypot(x - 18, y - 16) / 34);
    return lerp(base, C.paper, hi * 0.18);
  }
  return null;
}

const px = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (!c) continue;
        r += c[0];
        g += c[1];
        b += c[2];
        a += 1;
      }
    }
    const i = (y * SIZE + x) * 4;
    if (a === 0) continue;
    px[i] = Math.round(r / a);
    px[i + 1] = Math.round(g / a);
    px[i + 2] = Math.round(b / a);
    px[i + 3] = Math.round((a / (SS * SS)) * 255);
  }
}

/* ── 最小 PNG 编码（RGBA8，无滤波）──────────────────────────────────────── */
const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y += 1) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
console.log(`✓ ${path.relative(REPO, OUT)}  ${SIZE}×${SIZE}  ${png.length} bytes`);
