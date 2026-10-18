// 拖放/粘贴捕获：把微信聊天文字、网页文本、链接、截图拖进窗口或 Ctrl+V，
// 自动解析中文时间并在对应时间创建时间块
import * as S from "./store.js";
import { el, toast } from "./ui.js";
import { parseWhen, guessCategory, guessQuad } from "./timeParser.js";
import { aiAnalyzeContent, isAiIngestReady } from "./aiIngest.js";
import { openIngestPanel } from "./views/ingestPanel.js";
import { openTaskDrawer } from "./views/drawer.js";
import { previewSchedule } from "./scheduleConflict.js";
import { closeLayer, removeWithMotion } from "./motion.js";
import { looksLikeNoise } from "./captureNoise.js";

let overlay = null;
let dragDepth = 0;

export function initCapture() {
  document.addEventListener("dragenter", onDragEnter);
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("dragleave", onDragLeave);
  document.addEventListener("drop", onDrop);
  document.addEventListener("paste", onPaste);
  window.addEventListener("tide:quick-capture", () => openQuickCapture());
}

export function openQuickCapture() {
  document.querySelector(".quick-cap-mask")?.remove();
  document.querySelector(".quick-cap")?.remove();
  const input = el("textarea", {
    class: "quick-cap-input",
    placeholder: "例如：明天下午 3 点交论文，预计 1 小时\n也可以直接粘贴聊天消息、通知或网址说明…",
    "aria-label": "快速捕获内容",
  });
  const mask = el("div", { class: "drawer-mask quick-cap-mask", onclick: close });
  const panel = el("div", { class: "quick-cap", role: "dialog", "aria-label": "快速捕获" },
    el("div", { class: "quick-cap-head" },
      el("div", {}, el("b", {}, "快速捕获"), el("small", {}, "Ctrl+Enter 创建 · Esc 关闭")),
      el("button", { class: "btn ghost sm", onclick: close }, "关闭"),
    ),
    input,
    el("div", { class: "quick-cap-actions" },
      el("button", { class: "btn pri", onclick: create }, "识别并创建"),
      el("span", { class: "desc" }, "会自动解析日期、时间、分类与预计时长"),
    ),
  );
  function create() {
    const text = input.value.trim();
    if (!text) { toast("先输入要捕获的内容"); input.focus(); return; }
    handleText(text);
    close();
  }
  function close() {
    closeLayer(panel, mask, () => document.removeEventListener("keydown", onKey, true));
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); create(); }
  }
  input.addEventListener("keydown", (e) => e.stopPropagation());
  document.addEventListener("keydown", onKey, true);
  document.body.append(mask, panel);
  setTimeout(() => input.focus(), 0);
}

function wants(e) {
  const t = [...(e.dataTransfer?.types || [])];
  return t.includes("Files") || t.includes("text/plain") || t.includes("text/uri-list") || t.includes("text/html");
}
function onDragEnter(e) {
  if (!wants(e)) return;
  e.preventDefault();
  dragDepth++;
  showOverlay(e.dataTransfer);
}
function onDragOver(e) {
  if (!wants(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  if (!overlay) showOverlay(e.dataTransfer);
}
function onDragLeave(e) {
  if (!wants(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) hideOverlay();
}
function onDrop(e) {
  if (!wants(e)) return;
  e.preventDefault();
  dragDepth = 0;
  hideOverlay();
  const dt = e.dataTransfer;
  const files = [...(dt.files || [])];
  let text = dt.getData("text/plain") || dt.getData("text/uri-list") || "";
  if (!text.trim()) {
    const html = dt.getData("text/html");
    if (html) text = html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
  }
  if (files.length) handleFiles(files, text.trim());
  else if (text.trim()) handleText(text.trim());
}

function onPaste(e) {
  // 不劫持输入框里的正常粘贴
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const it of items) {
    if (it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) {
        e.preventDefault();
        fileToDataUrl(f)
          .then(async (u) => {
            if (await tryAiIngest({ imageDataUrl: u, fileName: "剪贴板截图" })) return;
            openCaptureModal(u, "");
          })
          .catch(() => {});
        return;
      }
    }
  }
  // 粘贴的纯文本**不自动走 AI**：粘贴是最高频的动作，随手贴一句聊天记录就触发一次
  // 付费请求，用户会觉得这功能在偷偷烧钱。AI 只留给「图片」与「显式拖入的文件」——
  // 拖入是刻意行为，愿意付这个成本。规则解析认不出的文本仍会照旧进任务池。
  const text = e.clipboardData.getData("text/plain");
  if (text && text.trim().length > 1 && /\S/.test(text)) {
    e.preventDefault();
    handleText(text.trim());
  }
}

/* ── 冲突安全放置：捕获流程不再静默覆盖已有安排 ── */
function placeCapturedBlock(patch) {
  const startMin = S.mmOf(patch.start || "09:00");
  const preview = previewSchedule(S.blocksOf(patch.date), { startMin, durMin: patch.durMin }, { dayStart: 7 * 60, dayEnd: 24 * 60 });
  if (preview.ok) return { block: S.addBlock(patch), moved: false, requestedStart: patch.start };
  const alt = preview.alternatives[0];
  if (!alt) return { block: null, moved: false, requestedStart: patch.start, conflicts: preview.conflicts };
  return { block: S.addBlock({ ...patch, start: alt.start }), moved: true, requestedStart: patch.start, conflicts: preview.conflicts };
}

/* ── 文本：自动解析并创建 ── */
function handleText(text) {
  // 名单 / 碎片守卫：从聊天里复制的人名接龙（"1\n刘2\n梁3\n冯"）拼出来
  // 只剩单字与数字，建出来的待办既看不懂也删不干净 —— 一律不进任务池。
  if (looksLikeNoise(text)) {
    toast("这段内容像是名单或碎片，没当成一件事：没有创建任务", { ms: 6000 });
    return;
  }
  const p = parseWhen(text);
  const cat = guessCategory(text);
  const title = p.title;
  const task = S.addTask({
    title,
    quad: guessQuad(p.date),
    estMin: p.endMin ? p.endMin - p.startMin : 60,
    due: p.date,
    tags: ["捕获"],
    note: text.length > 120 ? text.slice(0, 120) + "…" : text,
  });

  if (p.date && p.startMin !== null) {
    const dur = p.endMin ? p.endMin - p.startMin : 60;
    const placed = placeCapturedBlock({ date: p.date, start: S.hhmmOf(p.startMin), durMin: dur, title, taskId: task.id, cat });
    if (!placed.block) {
      toast(`已保存任务「${title}」，但 ${S.hhmmOf(p.startMin)} 时段冲突且当天没有连续空档`, { actionLabel: "调整", ms: 7000, action: () => openTaskDrawer(task.id) });
    } else {
      toast(placed.moved
        ? `已捕获「${title}」；原定 ${placed.requestedStart} 冲突，自动改到 ${placed.block.start}`
        : `已捕获「${title}」→ ${p.date.slice(5).replace("-", "/")} ${placed.block.start} · ${S.durLabel(dur)}`, {
        actionLabel: "查看", ms: 6500,
        action: () => window.dispatchEvent(new CustomEvent("tide:navigate", { detail: "timeblock" })),
      });
    }
  } else if (p.date) {
    const placed = placeCapturedBlock({ date: p.date, start: "09:00", durMin: 60, title, taskId: task.id, cat });
    if (!placed.block) toast(`已保存任务「${title}」，但当天没有可用的 60 分钟连续空档`, { actionLabel: "调整", ms: 6500, action: () => openTaskDrawer(task.id) });
    else toast(placed.moved
      ? `已捕获「${title}」；09:00 有冲突，自动改到 ${placed.block.start}`
      : `已捕获「${title}」→ ${p.date.slice(5).replace("-", "/")}，未写时间，先放在 09:00`, {
      actionLabel: "调整", ms: 6500, action: () => openTaskDrawer(task.id),
    });
  } else {
    toast(`未识别到日期，已存入任务池：「${title}」`, { actionLabel: "查看", ms: 6500, action: () => openTaskDrawer(task.id) });
  }
}

/**
 * 尝试让 AI 接手解析。
 *
 * 返回 `true` = AI 已接手（确认面板已弹出）；`false` = 不可用或失败，**调用方要走老路**。
 * 失败也返回 `false` 是有意的：图片识别失败时退回「手选时间」弹窗，比只弹一个错误框有用得多。
 *
 * 调用前必须先过 `isAiIngestReady()` —— 没配凭据时 `api.aiChat` 会直接抛错，
 * 白等一轮没有意义。
 */
async function tryAiIngest({ text = "", imageDataUrl = "", fileName = "" } = {}) {
  if (!(await isAiIngestReady())) return false;
  try {
    toast(imageDataUrl ? "正在用 AI 读图…" : "正在用 AI 解析…", { ms: 2600 });
    const result = await aiAnalyzeContent({ text, imageDataUrl, fileName });
    openIngestPanel({
      result,
      source: fileName ? `AI 解析 · ${fileName}` : "AI 解析",
      attachments: imageDataUrl ? [imageDataUrl] : [],
    });
    return true;
  } catch (error) {
    toast(`AI 解析失败，改用本地识别：${error?.message || error}`, { ms: 6000 });
    return false;
  }
}

/**
 * 文本的择优路径：**规则优先，AI 兜底**。
 *
 * 规则解析（timeParser）免费、即时、离线可用，对「明天下午 3 点交论文」这类规整消息
 * 已经够用；只有它**认不出日期**时才值得花钱请 AI —— 否则每一次粘贴都要付一次
 * API 费用，用户会觉得这功能在偷偷烧钱。
 */
async function handleTextSmart(text, fileName = "") {
  if (parseWhen(text).date) { handleText(text); return; }
  if (await tryAiIngest({ text, fileName })) return;
  handleText(text);
}

/* ── 文件：图片 → AI 读图（无 AI 时手选时间）；文本 → 择优解析；其他 → 收纳 ── */
async function handleFiles(files, text) {
  for (const f of files.slice(0, 3)) {
    if (f.type.startsWith("image/")) {
      try {
        const dataUrl = await fileToDataUrl(f);
        if (await tryAiIngest({ imageDataUrl: dataUrl, fileName: f.name, text })) continue;
        openCaptureModal(dataUrl, text);
      } catch { toast("这张图片读取失败"); }
    } else if (f.type.startsWith("text/") || /\.(txt|md|csv)$/i.test(f.name)) {
      const content = (await f.text()).slice(0, 4000);
      await handleTextSmart(content, f.name);
    } else if (/\.(pdf|docx?|xlsx?|pptx?)$/i.test(f.name)) {
      // 诚实告知：这些格式要先在应用外转成图片或文本再拖进来。
      // 不假装支持 —— 静默存成附件会让用户以为「已经解析过了」。
      const task = S.addTask({ title: f.name, quad: 3, tags: ["附件"], note: `拖入的文件：${f.name}（该格式暂不支持自动解析，请截图后拖入）` });
      toast(`已收纳「${f.name}」；该格式暂不支持自动解析，可截图后拖入让 AI 读图`, { ms: 7000 });
      void task;
    } else {
      const task = S.addTask({ title: f.name, quad: 3, tags: ["附件"], note: `拖入的文件：${f.name}` });
      toast(`已收纳文件「${f.name}」为任务`);
      void task;
    }
  }
}

function fileToDataUrl(file, max = 900) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL(file.type === "image/png" ? "image/png" : "image/jpeg", 0.82));
      } catch (err) { reject(err); }
      finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片解码失败")); };
    img.src = url;
  });
}

/* ── 图片捕获弹窗：预览 + 快速选时间（截图无法本地 OCR，时间需手选） ── */
function openCaptureModal(dataUrl, caption) {
  document.querySelector(".cap-mask")?.remove();
  const p = parseWhen(caption || "");
  const today = S.todayStr();

  const titleIn = el("input", { type: "text", value: caption ? p.title : "图片事件", style: "width:100%" });
  const dateIn = el("input", { type: "date", value: p.date || today });
  const timeIn = el("input", { type: "time", value: p.startMin !== null ? S.hhmmOf(p.startMin) : defaultTime() });
  const durSel = el("select", { style: "height:34px;border:1px solid var(--line);border-radius:8px;background:#fff;padding:0 8px" });
  for (const m of [15, 30, 60, 90, 120, 180]) durSel.append(el("option", { value: m }, S.durLabel(m)));
  durSel.value = p.endMin ? String(p.endMin - p.startMin) : "60";
  const catSel = el("select", { style: "height:34px;border:1px solid var(--line);border-radius:8px;background:#fff;padding:0 8px" });
  for (const c of S.CATEGORIES) catSel.append(el("option", { value: c.id }, c.label));
  catSel.value = guessCategory(caption);

  const mask = el("div", { class: "cap-mask", onclick: close });
  const modal = el("div", { class: "cap-modal" },
    el("div", { class: "cap-h" }, "捕获图片", el("button", { class: "btn ghost sm", onclick: close }, "关闭")),
    el("img", { class: "cap-img", src: dataUrl }),
    el("div", { class: "cap-grid" },
      el("label", {}, "标题"), titleIn,
      el("label", {}, "日期"), dateIn,
      el("label", {}, "开始"), timeIn,
      el("label", {}, "时长"), durSel,
      el("label", {}, "分类"), catSel,
    ),
    el("div", { class: "cap-foot" },
      el("button", { class: "btn pri", onclick: create }, "✓ 创建时间块"),
      el("button", { class: "btn ghost", onclick: onlyTask }, "仅存为任务"),
    ),
  );
  document.body.append(mask, modal);

  function create() {
    const title = titleIn.value.trim() || "图片事件";
    const task = S.addTask({
      title, quad: guessQuad(dateIn.value || null), estMin: Number(durSel.value),
      due: dateIn.value || null, tags: ["捕获"], attachments: [dataUrl],
    });
    if (dateIn.value) {
      const [h, m] = timeIn.value.split(":").map(Number);
      const placed = placeCapturedBlock({ date: dateIn.value, start: timeIn.value || "09:00", durMin: Number(durSel.value), title, taskId: task.id, cat: catSel.value });
      if (placed.block) toast(placed.moved ? `已创建：${title} · 原时段冲突，自动改到 ${placed.block.start}` : `已创建：${title} → ${dateIn.value.slice(5)} ${placed.block.start}`, { actionLabel: "查看", action: () => window.dispatchEvent(new CustomEvent("tide:navigate", { detail: "timeblock" })) });
      else toast(`任务已保存，但 ${timeIn.value || "09:00"} 时段冲突且没有连续空档`, { actionLabel: "调整", action: () => openTaskDrawer(task.id) });
      void h; void m;
    } else {
      toast(`已保存任务「${title}」`);
    }
    close();
  }
  function onlyTask() {
    const task = S.addTask({ title: titleIn.value.trim() || "图片事件", quad: 1, tags: ["捕获"], attachments: [dataUrl] });
    toast(`已保存任务「${task.title}」（含图片附件）`);
    close();
  }
  function close() { closeLayer(modal, mask); }
}

function defaultTime() {
  const d = new Date();
  d.setMinutes(d.getMinutes() + 60 - (d.getMinutes() % 30), 0, 0);
  return S.hhmmOf(d.getHours() * 60 + d.getMinutes());
}

/* ── 拖放覆盖层 ── */
function showOverlay() {
  if (overlay) return;
  overlay = el("div", { class: "drag-overlay" },
    el("div", { class: "drag-overlay-box" },
      el("div", { style: "font-size:calc(40px * var(--ui-text-scale))" }, "⤵"),
      el("div", { class: "t1" }, "松手，U-Time来自动识别"),
      el("div", { class: "t2" }, "聊天文字 / 网页文本 / 链接 → 自动提取日期时间并创建时间块"),
      el("div", { class: "t2" }, "截图 / 图片 / 文本文件 → AI 读图识别，确认后写入任务、时间块或课表"),
    ),
  );
  document.body.append(overlay);
}
function hideOverlay() {
  removeWithMotion(overlay);
  overlay = null;
  dragDepth = 0;
}
