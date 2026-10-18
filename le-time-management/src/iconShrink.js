// 自定义图标落库前先缩小。
// 以前上传的原图直接转 base64 存进 settings：1 MB 的 PNG 落库就是 1.33 MB 字符串（v0.247 实测课程表图标
// 1,338,462 字符，占当时 data.json 的 14%），每次保存都要跟着整份重写。导航 / 插件图标最大只画
// 48 CSS px，按 DPR 3 算 144 px 足够清晰。
//
// 小于阈值的 data URL（含绝大多数 SVG、已经很小的 PNG）原样保留，不做有损处理；
// 缩完反而更大（极少见，比如本来就是高压缩 WebP）也保留原图。拿不到 canvas 时退回原图 —— 能用比完美重要。
export const ICON_MAX_PX = 144;
export const ICON_SHRINK_THRESHOLD = 48 * 1024;

function defaultLoadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图标解码失败"));
    img.src = src;
  });
}
function defaultCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export async function shrinkIconDataUrl(dataUrl, {
  max = ICON_MAX_PX, threshold = ICON_SHRINK_THRESHOLD, loadImage = defaultLoadImage, createCanvas = defaultCanvas,
} = {}) {
  const src = String(dataUrl || "");
  if (!src.startsWith("data:image/") || src.length <= threshold) return src;
  try {
    const img = await loadImage(src);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return src;
    const scale = Math.min(1, max / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = createCanvas(cw, ch);
    const ctx = canvas.getContext("2d");
    if (!ctx) return src;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, cw, ch);
    const out = canvas.toDataURL("image/png");
    return typeof out === "string" && out.startsWith("data:image/") && out.length < src.length ? out : src;
  } catch {
    return src;
  }
}

/** 启动时把已经落库的超大图标补缩一次（v0.248.0 之前上传的）。原地修改，返回缩小了几个。 */
export async function shrinkStoredIcons(settings, options = {}) {
  const threshold = options.threshold ?? ICON_SHRINK_THRESHOLD;
  let changed = 0;
  for (const table of [settings?.pluginOverrides, settings?.navOverrides]) {
    if (!table || typeof table !== "object") continue;
    for (const entry of Object.values(table)) {
      const icon = entry?.icon;
      if (typeof icon !== "string" || icon.length <= threshold) continue;
      const next = await shrinkIconDataUrl(icon, options);
      if (next !== icon) { entry.icon = next; changed++; }
    }
  }
  return changed;
}
