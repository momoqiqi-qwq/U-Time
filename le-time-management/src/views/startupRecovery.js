import { api } from "../api.js";
import { migrateState } from "../migrations.js";
import { el } from "../ui.js";

// 初始化失败时只显示恢复页，不启动提醒、插件或自动化，不提交空状态。
export function renderStartupRecovery(root, error) {
  const message = el("p", { class: "desc", role: "alert" }, String(error?.message || error));
  const status = el("p", { class: "desc", role: "status" });
  const retry = el("button", { class: "btn pri", type: "button", onclick: () => location.reload() }, "重新读取");
  const file = el("input", { type: "file", accept: ".json,application/json", "aria-label": "选择有效备份" });
  let busy = false;
  file.addEventListener("change", async () => {
    if (busy || !file.files?.[0]) return;
    busy = true; file.disabled = true; retry.disabled = true;
    try {
      const { parseFullBackup } = await import("../dataCenter.js");
      const next = parseFullBackup(await file.files[0].text());
      migrateState(next); // 包括未来 schema 拒绝；确认前不写磁盘。
      if (!window.confirm("用这份备份恢复数据？恢复前会保留本机原始数据副本。")) return;
      await api.recoverData(next);
      location.reload();
    } catch (e) { status.textContent = `恢复失败：${String(e?.message || e)}`; }
    finally { busy = false; file.disabled = false; retry.disabled = false; file.value = ""; }
  });
  root.replaceChildren(el("main", { class: "startup-recovery" },
    el("h1", {}, "数据暂时无法读取"), message,
    el("p", {}, "已停止保存，原始数据不会被空数据覆盖。请重试读取，或选择有效的 JSON 备份恢复。"),
    retry, file, status));
}
