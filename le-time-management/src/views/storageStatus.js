import * as S from "../store.js";
import { el } from "../ui.js";

/* 保存回执的停留时长。以前这块是常驻挂件：订阅时立刻收到一次「已保存」回执，
   于是从启动第一帧起右下角就永远挂着一块「已保存」，用户会以为是没保存成功。
   现在只有「有改动待保存 / 正在保存 / 保存失败」才常驻，成功后亮一下自己退场。 */
const SAVED_LINGER_MS = 1600;

export function mountStorageStatus(root) {
  const label = el("span");
  const retry = el("button", { class: "btn ghost sm", type: "button", onclick: () => S.saveNow() }, "重试保存");
  const exportButton = el("button", { class: "btn ghost sm", type: "button", onclick: async () => {
    const { fullBackup, downloadText } = await import("../dataCenter.js");
    downloadText(`U-Time-未保存数据-${S.todayStr()}.json`, JSON.stringify(fullBackup(), null, 2));
  } }, "导出备份");
  // 首帧必须先写 false：subscribeSaveStatus 会立即回执一次当前状态，
  // 若默认可见，「已保存」会在同一帧闪出来再收回去。
  const node = el("div", {
    class: "storage-status", role: "status", "aria-live": "polite", "data-visible": "false",
  }, label, retry, exportButton);
  root.append(node);

  let hideTimer = null;
  let lastPhase = null;
  const show = () => {
    clearTimeout(hideTimer);
    hideTimer = null;
    node.dataset.visible = "true";
  };
  const hide = () => {
    clearTimeout(hideTimer);
    hideTimer = null;
    node.dataset.visible = "false";
  };

  const unsubscribe = S.subscribeSaveStatus((status) => {
    const previous = lastPhase;
    lastPhase = status.phase;
    node.dataset.phase = status.phase;
    label.textContent = status.phase === "error" ? `保存失败：${status.error}`
      : status.phase === "pending" ? "有更改待保存" : status.phase === "saving" ? "正在保存…" : "已保存";
    retry.hidden = status.phase !== "error";
    exportButton.hidden = status.phase !== "error";
    if (status.phase !== "saved") { show(); return; }
    // 启动首帧的回执不算「刚刚保存过」，别闪那一下。
    if (previous === null) { hide(); return; }
    show();
    hideTimer = setTimeout(hide, SAVED_LINGER_MS);
  });
  return unsubscribe;
}
