import * as S from "../store.js";
import { el } from "../ui.js";

export function mountStorageStatus(root) {
  const label = el("span");
  const retry = el("button", { class: "btn ghost sm", type: "button", onclick: () => S.saveNow() }, "重试保存");
  const exportButton = el("button", { class: "btn ghost sm", type: "button", onclick: async () => {
    const { fullBackup, downloadText } = await import("../dataCenter.js");
    downloadText(`U-Time-未保存数据-${S.todayStr()}.json`, JSON.stringify(fullBackup(), null, 2));
  } }, "导出备份");
  const node = el("div", { class: "storage-status", role: "status", "aria-live": "polite" }, label, retry, exportButton);
  root.append(node);
  const unsubscribe = S.subscribeSaveStatus((status) => {
    node.dataset.phase = status.phase;
    label.textContent = status.phase === "error" ? `保存失败：${status.error}`
      : status.phase === "pending" ? "有更改待保存" : status.phase === "saving" ? "正在保存…" : "已保存";
    retry.hidden = status.phase !== "error";
    exportButton.hidden = status.phase !== "error";
  });
  return unsubscribe;
}
