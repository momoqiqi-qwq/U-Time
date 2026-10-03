import * as S from "../../store.js";
import { el, toast } from "../../ui.js";
import { fullBackup, parseFullBackup, downloadText, tasksToCsv, blocksToCsv, importTasksCsv, toIcs, importIcs, exportXlsx, importXlsx, listAutoBackups, createAutoBackup, restoreAutoBackup, deleteAutoBackup } from "../../dataCenter.js";
import { scanHealth, repairHealth } from "../../dataHealth.js";
import { toggleSwitch } from "../../switchControl.js";

export async function createDataCard({ settings, info, render }) {
    /* 数据中心：完整备份 + CSV / Excel / ICS + 自动备份 */
    settings.autoBackup ??= { enabled: true, frequency: "daily", keep: 7 };
    const ab = settings.autoBackup;
    const dataCard = el("div", { class: "card set-card" },
      el("h2", {}, "数据中心"),
      el("div", { style: "margin:10px 0" }, el("div", { class: "path-code" }, info ? (info.data_dir || info.dataDir || "未知") : "读取中…")),
    );
    const backupInput = el("input", { type: "file", accept: ".json,application/json", style: "display:none" });
    const csvInput = el("input", { type: "file", accept: ".csv,text/csv", style: "display:none" });
    const xlsxInput = el("input", { type: "file", accept: ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", style: "display:none" });
    const icsInput = el("input", { type: "file", accept: ".ics,text/calendar", style: "display:none" });
    const mergeImported = async ({ tasks = [], blocks = [] }, label) => {
      createAutoBackup(`导入 ${label} 前`, info?.version || "");
      const st = S.getState();
      const taskIds = new Set(st.tasks.map(x => x.id));
      const blockIds = new Set(st.blocks.map(x => x.id));
      const now = Date.now();
      const cleanTasks = tasks.filter(x => !taskIds.has(x.id)).map(x => ({ ...x, createdAt: x.createdAt || now, isNew: true }));
      const cleanBlocks = blocks.filter(x => !blockIds.has(x.id)).map(x => ({ ...x, createdAt: x.createdAt || now, isNew: true }));
      const ok = window.confirm(`准备导入：任务 ${cleanTasks.length} 条，时间块 ${cleanBlocks.length} 条。\n\n将与现有数据合并，并已创建自动恢复点。是否继续？`);
      if (!ok) return;
      st.tasks.push(...cleanTasks); st.blocks.push(...cleanBlocks); await S.saveNow();
      toast(`已导入 ${cleanTasks.length} 个任务、${cleanBlocks.length} 个时间块`); render();
    };
    backupInput.addEventListener("change", async () => { const f = backupInput.files?.[0]; if (!f) return; try { const next = parseFullBackup(await f.text()); createAutoBackup("恢复完整备份前", info?.version || ""); if (!confirm(`此操作会替换当前全部数据。\n备份中包含 ${next.tasks.length} 个任务、${next.blocks.length} 个时间块。继续？`)) return; S.replaceAll(next); await S.saveNow(); toast("完整备份已恢复"); render(); } catch (e) { toast(`导入失败：${e.message}`); } finally { backupInput.value = ""; } });
    csvInput.addEventListener("change", async () => { const f = csvInput.files?.[0]; if (!f) return; try { await mergeImported({ tasks: importTasksCsv(await f.text()), blocks: [] }, "CSV"); } catch (e) { toast(`CSV 导入失败：${e.message}`); } finally { csvInput.value = ""; } });
    xlsxInput.addEventListener("change", async () => { const f = xlsxInput.files?.[0]; if (!f) return; try { await mergeImported(await importXlsx(f), "Excel"); } catch (e) { toast(`Excel 导入失败：${e.message}`); } finally { xlsxInput.value = ""; } });
    icsInput.addEventListener("change", async () => { const f = icsInput.files?.[0]; if (!f) return; try { await mergeImported(importIcs(await f.text()), "ICS"); } catch (e) { toast(`ICS 导入失败：${e.message}`); } finally { icsInput.value = ""; } });
    dataCard.append(
      el("div", { class: "data-section-title" }, "完整备份 / 恢复"),
      el("div", { class: "data-actions" },
        el("button", { class: "btn pri", onclick: () => { downloadText(`U-Time-full-backup-${S.todayStr()}.json`, JSON.stringify(fullBackup(info?.version || ""), null, 2), "application/json"); toast("完整备份已导出"); } }, "导出 JSON 完整备份"),
        el("button", { class: "btn ghost", onclick: () => backupInput.click() }, "恢复 JSON 备份"),
        el("button", { class: "btn ghost", onclick: async () => { await S.saveNow(); toast("已立即保存"); } }, "立即保存"),
      ),
      el("div", { class: "data-section-title" }, "表格 / 日历交换"),
      el("div", { class: "data-actions" },
        el("button", { class: "btn ghost sm", onclick: () => downloadText(`U-Time-任务-${S.todayStr()}.csv`, tasksToCsv(), "text/csv;charset=utf-8") }, "导出任务 CSV"),
        el("button", { class: "btn ghost sm", onclick: () => downloadText(`U-Time-时间块-${S.todayStr()}.csv`, blocksToCsv(), "text/csv;charset=utf-8") }, "导出时间块 CSV"),
        el("button", { class: "btn ghost sm", onclick: () => csvInput.click() }, "导入任务 CSV"),
        el("button", { class: "btn ghost sm", onclick: async () => { try { await exportXlsx(); } catch (e) { toast(`Excel 导出失败：${e.message}`); } } }, "导出 Excel .xlsx"),
        el("button", { class: "btn ghost sm", onclick: () => xlsxInput.click() }, "导入 Excel .xlsx"),
        el("button", { class: "btn ghost sm", onclick: () => downloadText(`U-Time-${S.todayStr()}.ics`, toIcs(), "text/calendar;charset=utf-8") }, "导出 ICS"),
        el("button", { class: "btn ghost sm", onclick: () => icsInput.click() }, "导入 ICS"),
      ),
      backupInput, csvInput, xlsxInput, icsInput,
    );
    const abEnabled = toggleSwitch({ checked: ab.enabled !== false });
    const abFreq = el("select", {}, el("option", { value: "daily" }, "每天"), el("option", { value: "weekly" }, "每周")); abFreq.value = ab.frequency || "daily";
    const abKeep = el("input", { type: "number", min: "3", max: "30", value: ab.keep || 7, style: "width:84px" });
    const backupList = el("div", { class: "backup-list" });
    const paintBackups = () => { backupList.replaceChildren(); const rows = listAutoBackups(); if (!rows.length) { backupList.append(el("p", { class: "desc" }, "还没有自动恢复点。")); return; } for (const row of rows.slice(0, 10)) backupList.append(el("div", { class: "backup-row" }, el("span", {}, el("b", {}, row.reason), el("small", {}, `${new Date(row.at).toLocaleString("zh-CN")} · ${(JSON.stringify(row.payload).length / 1024).toFixed(0)} KB`)), el("span", {}, el("button", { class: "btn ghost sm", onclick: async () => { if (!confirm("恢复这个自动备份？当前数据会先再建一个恢复点。")) return; createAutoBackup("手动恢复前", info?.version || ""); await restoreAutoBackup(row.id); toast("已恢复自动备份"); render(); } }, "恢复"), el("button", { class: "btn ghost sm", onclick: () => { deleteAutoBackup(row.id); paintBackups(); } }, "删除")))); };
    dataCard.append(
      el("div", { class: "data-section-title" }, "自动备份 / 恢复点"),
      el("div", { class: "setting-row" }, el("span", {}, "启用自动备份"), abEnabled),
      el("div", { class: "setting-row" }, el("span", {}, "频率"), abFreq),
      el("div", { class: "setting-row" }, el("span", {}, "保留数量"), abKeep),
      el("div", { class: "data-actions" }, el("button", { class: "btn ghost sm", onclick: () => { createAutoBackup("手动恢复点", info?.version || ""); paintBackups(); toast("恢复点已创建"); } }, "现在创建恢复点")),
      backupList,
    );
    const persistAb = () => { ab.enabled = abEnabled.checked; ab.frequency = abFreq.value; ab.keep = Math.min(30, Math.max(3, Number(abKeep.value) || 7)); S.saveNow(); };
    abEnabled.onchange = persistAb; abFreq.onchange = persistAb; abKeep.onchange = persistAb; paintBackups();
    /* v0.111.0 数据体检：扫描孤儿块 / 重复 id / 超期 NEW / 非法日期。修复前先建
       恢复点（与导入/恢复同一条安全网）；analyze/repairPlan 是纯函数，行为面在
       scripts/test-data-health.mjs。 */
    const healthReport = el("div", { class: "health-report desc", style: "margin-top:8px" });
    const paintHealth = () => {
      const { issues, checked } = scanHealth();
      healthReport.replaceChildren();
      if (!issues.length) { healthReport.append(`✓ 未发现问题（任务 ${checked.tasks} · 时间块 ${checked.blocks}）`); return { issues }; }
      for (const it of issues) healthReport.append(el("div", {}, `• ${it.label} × ${it.count} —— ${it.detail}`));
      return { issues };
    };
    const healthBtn = el("button", { class: "btn ghost sm", onclick: async () => {
      const { issues } = paintHealth();
      if (!issues.length) { toast("数据很干净"); return; }
      const total = issues.reduce((s2, x) => s2 + x.count, 0);
      if (!confirm(`发现 ${total} 处问题。\n修复前会先创建一个恢复点（可随时回退）。\n继续修复吗？`)) return;
      createAutoBackup("数据体检修复前", info?.version || "");
      const fixed = await repairHealth();
      const n = fixed.reduce((s2, x) => s2 + x.count, 0);
      toast(`已修复 ${n} 处（恢复点已留好）`);
      paintHealth(); render();
    } }, "开始体检");
    dataCard.append(
      el("div", { class: "data-section-title" }, "数据体检"),
      el("div", { class: "data-actions" }, healthBtn),
      healthReport,
    );

  return dataCard;
}
