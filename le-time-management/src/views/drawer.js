// 任务详情抽屉（四象限右滑出）
import * as S from "../store.js";
import { el, QUADS, toast } from "../ui.js";
import { taskActions } from "../pluginHost.js";
import { PRESET_OFFSETS, normalizeOffsets, reminderLabel } from "../taskReminder.js";
import { closeLayer } from "../motion.js";
import { toggleSwitch } from "../switchControl.js";
import { pluginDisplayName, pluginDisplayIcon } from "../pluginAppearance.js";

export function openTaskDrawer(taskId) {
  document.querySelector(".drawer")?._close?.();
  document.querySelector(".drawer-mask")?.remove();

  const t = S.taskById(taskId);
  if (!t) return;
  S.markTaskSeen(taskId);

  const mask = el("div", { class: "drawer-mask", onclick: close });
  const body = el("div", { class: "dbody" });

  const title = el("h3", {}, t.title);
  const titleInput = el("input", { value: t.title, "aria-label": "任务名称" });
  titleInput.addEventListener("change", () => {
    const value = titleInput.value.trim();
    if (!value) { titleInput.value = t.title; toast("任务名称不能为空"); return; }
    S.updateTask(t.id, { title: value }); refresh();
  });
  const tagsInput = el("input", { value: (t.tags || []).join("，"), placeholder: "用逗号分隔" });
  tagsInput.addEventListener("change", () => S.updateTask(t.id, { tags: [...new Set(tagsInput.value.split(/[,，]/).map(x => x.trim()).filter(Boolean))] }));
  const quadBtns = QUADS.map((qd) => el("button", {
    class: t.quad === qd.q ? "on" : "", "data-q": qd.q,
    onclick: () => { S.updateTask(t.id, { quad: qd.q }); refresh(); },
  }, ["I", "II", "III", "IV"][qd.q - 1]));

  const estSel = el("select", {});
  for (const m of [15, 30, 45, 60, 90, 120, 180]) estSel.append(el("option", { value: m }, S.durLabel(m)));
  if (![15, 30, 45, 60, 90, 120, 180].includes(t.estMin)) estSel.append(el("option", { value: t.estMin }, S.durLabel(t.estMin)));
  estSel.value = String(t.estMin);
  estSel.addEventListener("change", () => { S.updateTask(t.id, { estMin: Number(estSel.value) }); refresh(); });

  const dueInput = el("input", { type: "date", value: t.due || "" });
  dueInput.addEventListener("change", () => { S.updateTask(t.id, { due: dueInput.value || null }); refresh(); });
  const dueTimeInput = el("input", { type: "time", value: t.dueTime || "23:59" });
  dueTimeInput.addEventListener("change", () => { S.updateTask(t.id, { dueTime: dueTimeInput.value || "23:59" }); refresh(); });
  const reminderSwitch = toggleSwitch({
    checked: t.reminderEnabled !== false,
    ariaLabel: "启用此任务的提醒",
    onChange: (value) => { S.updateTask(t.id, { reminderEnabled: value }); refresh(); },
  });
  const reminderBox = el("div", { class: "reminder-picks" });
  // 「自定义分钟 + 添加」独立成一条，不再混进 chips 的 flex-wrap 流里。
  // 🔴 旧版把输入框和按钮直接 append 到 .reminder-picks，9 个元素一起折行 ⇒
  //    每行长短参差、输入框与按钮被拆到两行、桌面端 max-width:245px 挤成 3 行右侧全空。
  const reminderCustom = el("div", { class: "reminder-custom-row" });
  const customOffset = el("input", { type: "number", min: "0", max: "43200", placeholder: "自定义分钟", class: "reminder-custom" });
  const renderReminderPicks = () => {
    const cur = S.taskById(t.id);
    const defaults = S.getState().settings.taskReminder?.defaultOffsets || [60, 10, 0];
    const offsets = Array.isArray(cur?.reminderOffsets) ? normalizeOffsets(cur.reminderOffsets) : normalizeOffsets(defaults);
    reminderBox.replaceChildren();
    for (const off of PRESET_OFFSETS) {
      const on = offsets.includes(off);
      reminderBox.append(el("button", {
        type: "button", class: `reminder-chip${on ? " on" : ""}`,
        onclick: () => {
          const next = on ? offsets.filter((x) => x !== off) : normalizeOffsets([...offsets, off]);
          S.updateTask(t.id, { reminderOffsets: next }); refresh();
        },
      }, off === 0 ? "到点" : reminderLabel(off).replace("截止", "")));
    }
    for (const off of offsets.filter((x) => !PRESET_OFFSETS.includes(x))) {
      reminderBox.append(el("button", { type: "button", class: "reminder-chip on", onclick: () => { S.updateTask(t.id, { reminderOffsets: offsets.filter((x) => x !== off) }); refresh(); } }, `${off} 分钟 ×`));
    }
    // 自定义行独立渲染（顺序：预设 → 自定义值 → 输入行），保证它永远自成一行
    reminderCustom.replaceChildren(customOffset, el("button", { type: "button", class: "btn ghost sm", onclick: () => {
      const n = Math.round(Number(customOffset.value));
      if (!Number.isFinite(n) || n < 0 || n > 43200) return toast("请输入 0～43200 分钟");
      S.updateTask(t.id, { reminderOffsets: normalizeOffsets([...offsets, n]) }); customOffset.value = ""; refresh();
    } }, "添加"));
  };

  const projInput = el("input", { type: "text", value: t.project || "", placeholder: "无" });
  projInput.addEventListener("change", () => { S.updateTask(t.id, { project: projInput.value.trim() }); refresh(); });

  const noteInput = el("textarea", { placeholder: "补充说明…" });
  noteInput.value = t.note || "";
  noteInput.addEventListener("change", () => { S.updateTask(t.id, { note: noteInput.value }); refresh(); });

  const plugBox = el("div", { class: "plug-actions" });
  const renderPlugActions = () => {
    plugBox.replaceChildren();
    if (!taskActions.length) return;
    plugBox.append(el("div", { class: "lab" }, "插 件 动 作"));
    for (const a of taskActions) {
      plugBox.append(el("button", {
        class: "btn ghost sm",
        onclick: () => { try { a.run(structuredClone(S.taskById(t.id))); } catch (e) { toast(`插件动作出错：${e.message}`); } },
      }, a.icon ? `${a.icon} ` : "", a.label));
    }
  };

  // 图片附件：可加可删。加的三条路子 —— Ctrl+V 粘贴截图、把图片拖到这一块、点「选择图片」。
  // 都走 `readImageAsDataUrl` 在本地压到长边 1280 再存，避免一张手机截图十几 MB 撑爆 localStorage。
  const attBox = el("div", {});
  const attBusy = { v: false };
  const saveAtts = (list) => { S.updateTask(t.id, { attachments: list }); refresh(); renderAtts(); };
  const addAttFiles = async (files) => {
    const imgs = Array.from(files || []).filter((f) => /^image\//.test(f.type || ""));
    if (!imgs.length) { toast("只认图片文件"); return; }
    if (attBusy.v) return;
    attBusy.v = true;
    try {
      const cur = () => (S.taskById(t.id)?.attachments) || [];
      const next = cur().slice();
      let ok = 0;
      for (const f of imgs.slice(0, 6)) {
        try { next.push(await readImageAsDataUrl(f)); ok += 1; } catch { /* 单张失败不打断其余的 */ }
      }
      if (!ok) { toast("这些图片读不出来"); return; }
      saveAtts(next);
      toast(ok > 1 ? `已添加 ${ok} 张图片` : "已添加 1 张图片");
    } finally { attBusy.v = false; }
  };

  const renderAtts = () => {
    attBox.replaceChildren();
    const atts = (S.taskById(t.id)?.attachments) || [];
    const pick = el("input", { type: "file", accept: "image/*", multiple: true, style: "display:none" });
    pick.addEventListener("change", () => { addAttFiles(pick.files); pick.value = ""; });

    const zone = el("div", { class: "att-zone" },
      el("div", { class: "att-hint" }, atts.length ? "把图片拖到这里，或 Ctrl+V 粘贴" : "拖入图片 / Ctrl+V 粘贴截图"),
      el("div", { class: "att-zone-acts" },
        el("button", { class: "btn ghost sm", onclick: () => pick.click(), type: "button" }, "选择图片"),
      ),
      pick,
    );
    // dragover 必须 preventDefault，否则 drop 根本不触发
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("over"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault(); zone.classList.remove("over");
      addAttFiles(e.dataTransfer?.files);
    });

    const list = atts.length ? el("div", { class: "att-imgs" },
      ...atts.map((u, i) => el("div", { class: "att-item" },
        el("img", { src: u, onclick: () => window.open(u, "_blank") }),
        el("button", { class: "att-del", title: "移除这张", type: "button",
          onclick: () => saveAtts(atts.filter((_, k) => k !== i)) }, "✕"),
      ))) : null;

    attBox.append(
      el("div", { class: "lab" }, "图 片 附 件", atts.length ? el("span", { class: "att-n" }, ` ${atts.length} 张`) : null),
      list, zone,
    );
  };
  // 粘贴：只要剪贴板里有图片就收下（这才是「Ctrl+V 贴截图」的直觉）；
  // 但若用户正在输入框里，且剪贴板**同时**有文本，就别抢 —— 那时他要的是粘文字。
  const onAttPaste = (e) => {
    if (!document.body.contains(drawer)) return;
    const cd = e.clipboardData;
    if (!cd) return;
    const tgt = e.target;
    const typing = tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable);
    // files 在截图上常常是空的，items 才是可靠的来源
    const fromItems = Array.from(cd.items || [])
      .filter((it) => it.kind === "file" && /^image\//.test(it.type || ""))
      .map((it) => it.getAsFile()).filter(Boolean);
    const imgs = fromItems.length ? fromItems : Array.from(cd.files || []).filter((f) => /^image\//.test(f.type || ""));
    if (!imgs.length) return;
    if (typing && String(cd.getData?.("text/plain") || "").trim()) return;   // 粘文字，别抢
    e.preventDefault();
    addAttFiles(imgs);
  };
  document.addEventListener("paste", onAttPaste, true);

  // ⚠️ 这里是**原生** `Element.append()`，不是 `el()` —— 原生 append 会把非 Node 参数
  // 字符串化后插入，`append(null)` 会真的写出一个文本节点 "null"。
  // 下面 `t.sourcePlugin ? … : null` 在「手动创建的任务」（占绝大多数）时正好取到 null，
  // 于是抽屉里会多出一行裸 `null`（v0.48.0 用户截图报的 bug）。
  // 所以这一串必须先滤掉假值再 append，不能直接照抄 `el()` 的写法。
  body.append(
    ...[
      el("div", { class: "kv" }, el("span", {}, "任务名称"), titleInput),
      // 插件联动提醒：显示来源插件图标与名称（手动创建的任务没有这一行）
      t.sourcePlugin ? el("div", { class: "kv" }, el("span", {}, "来源插件"),
        el("span", { class: "src-plug", title: "这条提醒由插件创建" },
          pluginDisplayIcon(t.sourcePlugin, pluginDisplayName(t.sourcePlugin)),
          el("span", {}, pluginDisplayName(t.sourcePlugin)))) : null,
      el("div", { class: "kv" }, el("span", {}, "标签"), tagsInput),
      el("div", { class: "kv" }, el("span", {}, "所属象限"), el("span", { class: "quadpick" }, ...quadBtns)),
      el("div", { class: "kv" }, el("span", {}, "预估耗时"), estSel),
      el("div", { class: "kv" }, el("span", {}, "截止日期"), dueInput),
      el("div", { class: "kv" }, el("span", {}, "截止时间"), dueTimeInput),
      el("div", { class: "kv" }, el("span", {}, "任务提醒"), el("label", { class: "reminder-toggle" }, reminderSwitch, el("span", {}, "启用"))),
      el("div", { class: "kv reminder-kv" }, el("span", { class: "reminder-kv-lab" }, "提前预警"),
        el("div", { class: "reminder-fields" }, reminderBox, reminderCustom)),
      el("div", { class: "kv" }, el("span", {}, "所属项目"), projInput),
      el("div", { class: "kv", style: "align-items:flex-start" }, el("span", { style: "padding-top:8px" }, "备注"), noteInput),
      attBox,
      el("div", { class: "lab" }, "快 捷 操 作"),
      plugBox,
    ].filter(Boolean),
  );

  const foot = el("div", { class: "dfoot" },
    el("button", { class: "btn pri", onclick: () => { scheduleToToday(t); } }, "排入今天时间块"),
    el("button", {
      class: "btn ghost",
      onclick: () => { S.toggleTask(t.id); refresh(); },
    }, t.done ? "↩ 标记未完成" : "✓ 标记完成"),
    el("button", {
      class: "btn danger",
      onclick: () => {
        const undo = S.deleteTaskUndoable(t.id);
        close();
        toast(`已删除「${t.title}」`, { actionLabel: "撤销", action: undo });
      },
    }, "删除"),
  );

  const drawer = el("div", { class: "drawer" },
    el("div", { class: "dh" }, title, el("button", { class: "btn ghost sm", onclick: close }, "✕ 关闭")),
    body, foot,
  );
  drawer._close = close;
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  document.body.append(mask, drawer);
  renderPlugActions();
  renderAtts();
  renderReminderPicks();

  function refresh() {
    const cur = S.taskById(t.id);
    if (!cur) return close();
    title.textContent = cur.title;
    foot.children[1].textContent = cur.done ? "↩ 标记未完成" : "✓ 标记完成";
    quadBtns.forEach((b) => b.classList.toggle("on", Number(b.dataset.q) === cur.quad));
    estSel.value = String(cur.estMin);
    dueInput.value = cur.due || "";
    dueTimeInput.value = cur.dueTime || "23:59";
    reminderSwitch.checked = cur.reminderEnabled !== false;
    renderReminderPicks();
    noteInput.value = cur.note || "";
    renderPlugActions();
  }
  function close() { closeLayer(drawer, mask, () => {
    document.removeEventListener("keydown", onKey);
    // 粘贴是挂在 document 上的，抽屉关了必须摘掉 —— 否则下次开别的任务会多一个监听者，
    // 贴一张图会被加上两遍（在旧抽屉里就已经加过的那一份还指着已经删掉的任务）。
    document.removeEventListener("paste", onAttPaste, true);
  }); }
}

// 找今天第一个放得下的空闲时段；失败时保留已有安排。
function scheduleToToday(t) {
  try {
    const b = S.placeTask(t, S.todayStr());
    toast(`已排入今天 ${b.start} · ${S.durLabel(b.durMin)}`);
  } catch (e) { toast(e.message); }
}

/** 图片文件 → 压缩后的 dataURL。
    为什么一定要压：原图直接进 localStorage，一张 4MB 的截图 base64 之后约 5.3MB，
    而 localStorage 的配额通常只有 5MB —— 存两张就写不进去，整个 store 的保存都会开始抛。
    所以统一把长边限制在 1280、按 JPEG 0.82 重编码；已经够小的图原样返回，不重复损失画质。
    压缩用 canvas，拿不到 canvas（极老 WebView）就退回 FileReader 原样转 —— 能用比完美重要。 */
function readImageAsDataUrl(file, maxSide = 1280, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const readRaw = () => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ""));
      fr.onerror = () => reject(new Error("图片读取失败"));
      fr.readAsDataURL(file);
    };
    // 已经小于 400KB 的没必要重编码（重编码对小图是纯粹的画质损失）
    if (!file || !file.size || file.size < 400 * 1024) { readRaw(); return; }
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const cv = document.createElement("canvas");
          cv.width = w; cv.height = h;
          const ctx = cv.getContext("2d");
          if (!ctx) { resolve(String(fr.result || "")); return; }
          ctx.drawImage(img, 0, 0, w, h);
          const out = cv.toDataURL("image/jpeg", quality);
          // 少数情况下「压缩后」反而更大（本来就是高压缩比的 PNG）→ 用小的那个
          resolve(out && out.length < String(fr.result).length ? out : String(fr.result || ""));
        } catch { resolve(String(fr.result || "")); }
      };
      img.onerror = readRaw;
      img.src = String(fr.result || "");
    };
    fr.onerror = () => reject(new Error("图片读取失败"));
    fr.readAsDataURL(file);
  });
}
