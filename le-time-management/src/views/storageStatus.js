import * as S from "../store.js";
import { el } from "../ui.js";

/* 这块浮标现在只报「真出事」。
   历史教训有两层：最早是常驻挂件（启动第一帧就收到 saved 回执，永远挂着一块「已保存」）；
   后来改成成功后亮 1.6 秒，仍然天天复活 —— 因为 persistSoon() 的调用方不只是用户操作：
   插件后台轮询（cppu-notify / school-notice）、提醒计时、自动整理、更新检查都会写快照，
   每写一次就 pending → saving → saved 走一遍，右下角于是每隔几秒闪一次「已保存」。

   契约（只跟状态有关，不看谁触发的）：
     ① saved：永不露面。保存成功不需要回执。
     ② pending / saving：先按住 STUCK_MS；到点还没落到别的状态，才算「卡住了」露出来。
     ③ error：立刻露面并常驻，重试 / 导出按钮跟着它。
   后台写入正常完成 → 永远不会看到这块浮标。 */
const STUCK_MS = 1500;

export function mountStorageStatus(root) {
  const label = el("span");
  const retry = el("button", { class: "btn ghost sm", type: "button", onclick: () => S.saveNow() }, "重试保存");
  const exportButton = el("button", { class: "btn ghost sm", type: "button", onclick: async () => {
    const { fullBackup, downloadText } = await import("../dataCenter.js");
    downloadText(`U-Time-未保存数据-${S.todayStr()}.json`, JSON.stringify(fullBackup(), null, 2));
  } }, "导出备份");
  // 首帧必须先写 false：subscribeSaveStatus 会立即回执一次当前状态。
  const node = el("div", {
    class: "storage-status", role: "status", "aria-live": "polite", "data-visible": "false",
  }, label, retry, exportButton);
  root.append(node);

  let stuckTimer = null;
  const clearStuck = () => { clearTimeout(stuckTimer); stuckTimer = null; };
  const show = () => { node.dataset.visible = "true"; };
  const hide = () => { clearStuck(); node.dataset.visible = "false"; };
  // 同一次 pending/saving 序列只记一次时：连续回执不重置计时，避免长写入被无限推迟。
  const armStuck = () => {
    if (stuckTimer) return;
    stuckTimer = setTimeout(() => {
      stuckTimer = null;
      const phase = node.dataset.phase;
      // 到点时已经落回 saved / 失败，就交给那两条分支处理。
      if (phase === "pending" || phase === "saving") show();
    }, STUCK_MS);
  };

  const unsubscribe = S.subscribeSaveStatus((status) => {
    node.dataset.phase = status.phase;
    label.textContent = status.phase === "error" ? `保存失败：${status.error}`
      : status.phase === "pending" ? "有更改待保存" : status.phase === "saving" ? "正在保存…" : "已保存";
    const failed = status.phase === "error";
    retry.hidden = !failed;
    exportButton.hidden = !failed;
    if (failed) { clearStuck(); show(); return; }
    if (status.phase === "saved") { hide(); return; }
    armStuck();
  });
  return () => { clearStuck(); unsubscribe(); };
}
