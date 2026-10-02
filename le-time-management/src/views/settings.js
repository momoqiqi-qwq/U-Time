// 设置视图：数据、插件管理、关于
import { api } from "../api.js";
import * as S from "../store.js";
import { el, toast } from "../ui.js";
import { onNavChanged } from "../pluginHost.js";
import { computePluginShortcutMap, getPluginShortcutCustoms, setPluginShortcut } from "../pluginShortcuts.js";
import { pluginShortcutEntries } from "../pluginShortcutEntries.js";
import { DEFAULT_REMINDER_SETTINGS, PRESET_OFFSETS, RING_MAX_OPTIONS, normalizeOffsets, playReminderSound, previewRingSound, reminderLabel, testTaskReminder } from "../taskReminder.js";
import { BUILTIN_SOUNDS, CUSTOM_SOUND_ID, DEFAULT_LOOP_SOUND_ID, DEFAULT_SOUND_ID, isLoopableSound, resolveSound } from "../sound.js";
import { isAndroidRuntime, notifyStatus, askNotifyPermission, openNotifySettings, openExactAlarmSettings } from "../androidNotify.js";
import { createAboutCard } from "./aboutCard.js";
import { DEFAULT_GLOBAL_SHORTCUTS, getShortcutConfig, getGlobalShortcutStatus, applyGlobalShortcuts } from "../globalShortcuts.js";
import { fullBackup, parseFullBackup, downloadText, tasksToCsv, blocksToCsv, importTasksCsv, toIcs, importIcs, exportXlsx, importXlsx, listAutoBackups, createAutoBackup, restoreAutoBackup, deleteAutoBackup } from "../dataCenter.js";
import { scanHealth, repairHealth } from "../dataHealth.js";
import { createInterfaceCard, createThemeCard } from "./settings/appearance.js";
import { createSettingsNavigator } from "./settings/navigator.js";
import { createPluginSettingsCard, isPluginBatchBusy } from "./settings/plugins.js";
import { createAiSettingsCard } from "./settings/ai.js";
import { createSyncCard } from "./settings/sync.js";
import { createKeywordHighlightsCard } from "./settings/highlights.js";
import { createTaskSettingsCard } from "./settings/tasks.js";
import { createCppuLoginCard } from "./settings/cppuLogin.js";
import { createTestingCard } from "./settings/testing.js";
import { toggleSwitch } from "../switchControl.js";
import {
  getUpdateSettings, setUpdateSettings, getUpdateState, subscribeUpdateState,
  describeUpdateState, isUpdaterSupported, checkForUpdates, startUpdate,
  installUpdate, openInstallPermission, clearSkippedVersion,
} from "../updateChecker.js";

let info = null;
let navUnsub = null;
// expanded 是窄屏（手机 / APK）手风琴里已展开的分区 id。它必须活在这里而不是 navigator 内部：
// 在设置里改任何一项都会重渲染整页，状态存在局部变量里会让刚展开的面板当场塌掉。
// 但每次「打开设置」都清空 —— 一进来先给一张分类目录，不预展开任何分区（v0.49.1）。
const settingsNavState = { query: "", filter: "all", expanded: [] };

function revealSettingTarget(root, target) {
  const wanted = String(target || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!wanted) return;
  const candidates = [...root.querySelectorAll([
    ".setting-row", ".pref-presets", ".ai-field", ".sync-step", ".sync-field",
    ".data-section-title", ".plugin-title-row", ".about-section-title", ".update-panel",
    "h2", "h3", "label", "button", "input", "select", "[aria-label]",
  ].join(","))];
  const value = (node) => [node.textContent, node.getAttribute?.("aria-label"), node.getAttribute?.("placeholder"), node.getAttribute?.("title")]
    .filter(Boolean).join(" ").trim().replace(/\s+/g, " ").toLowerCase();
  const exact = candidates.find((node) => value(node) === wanted);
  const matched = exact || candidates.find((node) => value(node).includes(wanted));
  if (!matched) return;
  const anchor = matched.closest?.(".setting-row,.pref-presets,.ai-field,.sync-step,.sync-field,.data-section-title,.plugin-title-row,.about-section-title,.update-panel") || matched;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    anchor.scrollIntoView?.({ block: "center", behavior: "smooth" });
    anchor.classList.add("setting-search-target");
    setTimeout(() => anchor.classList.remove("setting-search-target"), 1800);
  }));
}

export function renderSettings(container, opts = {}) {
  settingsNavState.expanded = [];
  settingsNavState.page = "";
  let initialTarget = true;
  // 插件是异步加载的：注册表变化（导航变化）时重渲染，避免卡片缺位。
  // 批量启停插件时先跳过 —— 每关一个插件都会 emitNavChanged()，不挡就会整页重建 N 次。
  navUnsub?.();
  navUnsub = onNavChanged(() => { if (container.isConnected && !isPluginBatchBusy()) render(); });

  const wrap = el("div", { class: "set-wrap" });
  container.append(wrap);

  const render = async () => {
    if (!info) info = await api.appInfo().catch(() => null);
    const settings = S.getState().settings;

    /* 外观与交互：拆成独立模块，避免设置主文件继续膨胀 */
    const uiCard = createInterfaceCard({ rerender: render });
    const testingCard = createTestingCard();
    const cppuLoginCard = createCppuLoginCard();
    const themeCard = createThemeCard();
    const highlightCard = createKeywordHighlightsCard();
    const taskCard = createTaskSettingsCard();

    /* 任务提醒 */
    settings.taskReminder ??= structuredClone(DEFAULT_REMINDER_SETTINGS);
    const rc = settings.taskReminder;
    rc.defaultOffsets = normalizeOffsets(rc.defaultOffsets || DEFAULT_REMINDER_SETTINGS.defaultOffsets);
    const reminderCard = el("div", { class: "card set-card" },
      el("h2", {}, "任务提醒"),
    );
    const enabled = toggleSwitch({ checked: rc.enabled !== false });
    enabled.addEventListener("change", () => { rc.enabled = enabled.checked; S.saveNow(); });
    const vol = el("input", { type: "range", min: "0", max: "100", step: "1", value: Math.round((Number(rc.volume) || 0) * 100) });
    const volText = el("b", {}, `${vol.value}%`);
    vol.addEventListener("input", () => { volText.textContent = `${vol.value}%`; rc.volume = Number(vol.value) / 100; S.persistSoon(); });
    const sound = el("select", {});
    for (const preset of BUILTIN_SOUNDS) sound.append(el("option", { value: preset.id }, preset.label));
    sound.append(el("option", { value: CUSTOM_SOUND_ID }, "自定义音频"));
    sound.value = resolveSound(rc.sound || DEFAULT_SOUND_ID);
    sound.addEventListener("change", () => { rc.sound = sound.value; S.saveNow(); });
    const audioInput = el("input", { type: "file", accept: "audio/*,.mp3,.wav,.m4a,.aac,.ogg", style: "display:none" });
    const audioName = el("span", { class: "audio-name" }, rc.customAudioName || "尚未导入音频");
    audioInput.addEventListener("change", async () => {
      const f = audioInput.files?.[0]; if (!f) return;
      if (f.size > 8 * 1024 * 1024) { toast("音频文件请控制在 8MB 以内"); audioInput.value = ""; return; }
      const reader = new FileReader();
      reader.onload = async () => { rc.customAudio = String(reader.result || ""); rc.customAudioName = f.name; rc.sound = "custom"; sound.value = "custom"; await S.saveNow(); audioName.textContent = f.name; toast("自定义提醒音已导入"); };
      reader.onerror = () => toast("音频读取失败");
      reader.readAsDataURL(f);
    });
    const defaultBox = el("div", { class: "reminder-picks settings-reminder-picks" });
    const customDefault = el("input", { type: "number", min: "0", max: "43200", placeholder: "自定义分钟", class: "reminder-custom" });
    const renderDefaults = () => {
      defaultBox.replaceChildren();
      const cur = normalizeOffsets(rc.defaultOffsets);
      for (const off of PRESET_OFFSETS) {
        const on = cur.includes(off);
        defaultBox.append(el("button", { type: "button", class: `reminder-chip${on ? " on" : ""}`, onclick: () => { rc.defaultOffsets = on ? cur.filter(x => x !== off) : normalizeOffsets([...cur, off]); S.saveNow(); renderDefaults(); } }, off === 0 ? "到点" : reminderLabel(off).replace("截止", "")));
      }
      for (const off of cur.filter(x => !PRESET_OFFSETS.includes(x))) defaultBox.append(el("button", { type: "button", class: "reminder-chip on", onclick: () => { rc.defaultOffsets = cur.filter(x => x !== off); S.saveNow(); renderDefaults(); } }, `${off} 分钟 ×`));
      defaultBox.append(customDefault, el("button", { type: "button", class: "btn ghost sm", onclick: () => { const n = Math.round(Number(customDefault.value)); if (!Number.isFinite(n) || n < 0 || n > 43200) return toast("请输入 0～43200 分钟"); rc.defaultOffsets = normalizeOffsets([...cur, n]); customDefault.value = ""; S.saveNow(); renderDefaults(); } }, "添加"));
    };
    renderDefaults();

    /* 持续长鸣：到点这一档一声短提示音催不动人，要响到用户来处理（或到最长响铃自动停） */
    const ringOn = toggleSwitch({ checked: rc.ringEnabled !== false });
    ringOn.addEventListener("change", () => { rc.ringEnabled = ringOn.checked; S.saveNow(); });
    const ringSound = el("select", {});
    for (const preset of BUILTIN_SOUNDS.filter((p) => p.loop)) ringSound.append(el("option", { value: preset.id }, preset.label));
    ringSound.append(el("option", { value: CUSTOM_SOUND_ID }, "自定义音频循环"));
    ringSound.value = isLoopableSound(rc.ringSound) ? resolveSound(rc.ringSound) : DEFAULT_LOOP_SOUND_ID;
    ringSound.addEventListener("change", () => { rc.ringSound = ringSound.value; S.saveNow(); });
    const ringMax = el("select", {});
    for (const opt of RING_MAX_OPTIONS) ringMax.append(el("option", { value: String(opt.ms) }, opt.label));
    ringMax.value = String(rc.ringMaxMs);
    ringMax.addEventListener("change", () => { rc.ringMaxMs = Number(ringMax.value); S.saveNow(); });

    /* Android 系统通知与后台闹钟：这一节只在 APK 上出现（桌面与浏览器调试没有原生桥） */
    const nativeRows = [];
    if (isAndroidRuntime()) {
      const permState = el("b", { class: "notify-state" }, "检查中…");
      const askBtn = el("button", { class: "btn ghost sm", onclick: async () => { const r = await askNotifyPermission(); await paintNotifyState(); toast(r.granted ? "已允许通知" : "仍未授权：请到系统通知设置里手动打开"); } }, "授权");
      const openBtn = el("button", { class: "btn ghost sm", onclick: () => openNotifySettings() }, "通知设置");
      const exactState = el("b", { class: "notify-state" }, "");
      const exactBtn = el("button", { class: "btn ghost sm", onclick: () => openExactAlarmSettings() }, "去开启");
      const alarmOn = toggleSwitch({ checked: rc.nativeAlarm !== false });
      alarmOn.addEventListener("change", () => {
        rc.nativeAlarm = alarmOn.checked;
        S.saveNow();
        toast(alarmOn.checked ? "已开启后台闹钟：应用被划掉也能到点弹通知" : "已关闭后台闹钟：只剩应用内提醒");
      });
      async function paintNotifyState() {
        const st = await notifyStatus();
        permState.textContent = !st.supported ? "原生桥不可用（请更新 APK）" : st.granted ? "已授权" : "未授权";
        permState.dataset.on = st.granted ? "1" : "0";
        exactState.textContent = st.exact ? "已授权（准点）" : "未授权：深睡时最坏晚几分钟";
        exactState.dataset.on = st.exact ? "1" : "0";
        askBtn.style.display = st.granted ? "none" : "";
        exactBtn.style.display = st.exact ? "none" : "";
      }
      nativeRows.push(
        el("div", { class: "setting-row" }, el("span", {}, "系统通知"),
          el("span", { class: "notify-row" }, permState, askBtn, openBtn)),
        el("div", { class: "setting-row" }, el("span", {}, "精确闹钟"),
          el("span", { class: "notify-row" }, exactState, exactBtn)),
        el("div", { class: "setting-row" }, el("span", {}, "后台闹钟"), alarmOn),
        el("p", { class: "set-hint" }, "关掉后台闹钟就只剩应用内提醒：应用被系统划掉后到点不会有任何动静。国产 ROM（MIUI / 华为 / OPPO）还需在系统里允许本应用「自启动 / 后台运行」，否则闹钟会被省电策略清掉。"),
      );
      paintNotifyState();
    }

    reminderCard.append(
      el("div", { class: "setting-row" }, el("span", {}, "启用任务提醒"), enabled),
      el("div", { class: "setting-row" },
        el("span", {}, "系统弹窗测试"),
        el("button", {
          class: "btn ghost sm", type: "button",
          onclick: async () => {
            const result = await testTaskReminder();
            if (!api.isTauri) return;
            if (result?.applied === false) toast(`系统弹窗发送失败：${result.error || result.reason || "未知原因"}`);
            else toast("系统弹窗命令已发送，请查看 Windows 右下角或通知中心");
          },
        }, "测试提醒")),
      el("div", { class: "setting-row" }, el("span", {}, "提醒音量"), el("span", { class: "volume-row" }, vol, volText)),
      el("div", { class: "setting-row" }, el("span", {}, "提示音"), sound),
      el("div", { class: "setting-row" }, el("span", {}, "自定义音频"), el("span", { class: "audio-actions" }, audioName, el("button", { class: "btn ghost sm", onclick: () => audioInput.click() }, "导入音频"), el("button", { class: "btn ghost sm", onclick: () => playReminderSound(true) }, "试听"))),
      audioInput,
      el("div", { class: "setting-row setting-col" }, el("span", {}, "默认提前预警"), defaultBox),
      el("div", { class: "setting-row" }, el("span", {}, "到点持续长鸣"), ringOn),
      el("div", { class: "setting-row" }, el("span", {}, "长鸣音效"),
        el("span", { class: "audio-actions" }, ringSound, el("button", { class: "btn ghost sm", onclick: () => previewRingSound() }, "试听"))),
      el("div", { class: "setting-row" }, el("span", {}, "最长响铃"), ringMax),
      el("p", { class: "set-hint" }, "只有「已到截止时间」这一档走长鸣，提前预警仍是一声短音。长鸣可用通知上的「停止响铃」或横幅上的同名按钮停掉，到最长响铃时长会自动停。"),
      ...nativeRows,
    );

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

    /* 可选同步：网盘快照的分步引导与一键配置，实现拆在 views/settings/sync.js（和 ai.js 同一个理由）*/
    const syncCard = await createSyncCard({ appVersion: info?.version || "", os: info?.os || "" });

    /* 全局快捷键 */
    const shortcutCfg = getShortcutConfig();
    const shortcutEnabled = toggleSwitch({ checked: shortcutCfg.enabled !== false });
    const commandShortcut = el("input", { type: "text", value: shortcutCfg.commandPalette || DEFAULT_GLOBAL_SHORTCUTS.commandPalette, placeholder: DEFAULT_GLOBAL_SHORTCUTS.commandPalette, spellcheck: "false" });
    const captureShortcut = el("input", { type: "text", value: shortcutCfg.quickCapture || DEFAULT_GLOBAL_SHORTCUTS.quickCapture, placeholder: DEFAULT_GLOBAL_SHORTCUTS.quickCapture, spellcheck: "false" });
    const shortcutStatus = el("div", { class: "shortcut-status" });
    const paintShortcutStatus = (status = getGlobalShortcutStatus()) => {
      if (!status.supported) shortcutStatus.textContent = `${status.errors?.[0] || "当前环境不支持系统级快捷键"}；应用内 Ctrl+K 仍可用。`;
      else shortcutStatus.textContent = [...(status.registered || []).map((x) => `已注册 ${x}`), ...(status.errors || []).map((x) => `失败 ${x}`)].join(" · ") || "全局快捷键已关闭";
    };
    paintShortcutStatus();

    /* 插件快捷键：Alt + 字母直达插件视图。分配规则与侧栏徽标 / 按键命中同源
       （computePluginShortcutMap）：显式指定优先，没设的按**插件中文名首字母（拼音）**
       自动分配、撞车退回插件 ID 首字母，字母先到先得。
       插件视图是异步注册的 —— 每次重渲染现取（pluginShortcutEntries 是统一取数口径）。 */
    const pluginShortcutBox = el("div", {});
    const paintPluginShortcuts = () => {
      pluginShortcutBox.replaceChildren();
      const entries = pluginShortcutEntries();
      if (!entries.length) {
        pluginShortcutBox.append(el("p", { class: "shortcut-hint" }, "暂无已启用且有界面的插件；启用插件后可在这里给它分配 Alt + 字母快捷键。"));
        return;
      }
      // 名字取自 entries 本身，别再各自查一遍显示名 —— 两处取数一旦不同源，
      // 「设置页显示的字母」和「侧栏徽标 / 实际按键」就会对不上。
      const nameOf = new Map(entries.map((e) => [e.pluginId, e.name]));
      const map = computePluginShortcutMap(entries, getPluginShortcutCustoms());
      pluginShortcutBox.append(
        el("p", { class: "shortcut-hint" }, "按 Alt + 字母直接打开对应插件（桌面键盘生效）。输入框留空 = 按插件中文名首字母（拼音）自动分配，撞车时退回插件 ID 首字母；字母先到先得，重复时先设置的生效。"),
        el("div", { class: "shortcut-grid" },
          ...[...map.entries()].flatMap(([pluginId, info]) => {
            const name = nameOf.get(pluginId) || pluginId;
            const input = el("input", {
              type: "text", maxlength: "1", spellcheck: "false",
              value: getPluginShortcutCustoms()[pluginId] || "",
              placeholder: "自动", "aria-label": `${name}的快捷键字母`,
            });
            input.addEventListener("change", () => {
              setPluginShortcut(pluginId, input.value);
              S.saveNow();
              paintPluginShortcuts();
            });
            return [
              el("span", { class: "shortcut-name" },
                el("span", { class: "shortcut-name-text" }, name),
                info.letter ? el("kbd", { class: "shortcut-kbd" }, `Alt+${info.letter}`) : el("span", { class: "shortcut-none" }, "无"),
              ),
              input,
            ];
          }),
        ),
      );
    };
    paintPluginShortcuts();

    const shortcutCard = el("div", { class: "card set-card" },
      el("h2", {}, "全局快捷键"),
      el("div", { class: "setting-row" }, el("span", {}, "启用系统级快捷键"), shortcutEnabled),
      el("div", { class: "shortcut-grid" },
        el("span", {}, "命令面板"), commandShortcut,
        el("span", {}, "快速捕获"), captureShortcut,
      ),
      el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:12px" },
        el("button", { class: "btn pri sm", onclick: async () => {
          shortcutCfg.enabled = shortcutEnabled.checked;
          shortcutCfg.commandPalette = commandShortcut.value.trim() || DEFAULT_GLOBAL_SHORTCUTS.commandPalette;
          shortcutCfg.quickCapture = captureShortcut.value.trim() || DEFAULT_GLOBAL_SHORTCUTS.quickCapture;
          await S.saveNow();
          const status = await applyGlobalShortcuts();
          paintShortcutStatus(status);
          toast(status.errors?.length ? "快捷键已应用，但有冲突或注册失败" : "全局快捷键已应用");
        } }, "应用快捷键"),
        el("button", { class: "btn ghost sm", onclick: async () => {
          shortcutEnabled.checked = true;
          commandShortcut.value = DEFAULT_GLOBAL_SHORTCUTS.commandPalette;
          captureShortcut.value = DEFAULT_GLOBAL_SHORTCUTS.quickCapture;
          shortcutCfg.enabled = true; shortcutCfg.commandPalette = commandShortcut.value; shortcutCfg.quickCapture = captureShortcut.value;
          await S.saveNow();
          paintShortcutStatus(await applyGlobalShortcuts());
          toast("已恢复默认快捷键");
        } }, "恢复默认"),
      ),
      shortcutStatus,
      el("div", { class: "plugin-shortcut-block" },
        el("b", { class: "shortcut-sub-title" }, "插件快捷键"),
        pluginShortcutBox,
      ),
    );

    /* AI：凭据在 Rust 侧加密保存；自动任务只拿白名单操作。 */
    const aiCard = await createAiSettingsCard();

    /* 插件管理：独立模块，避免设置主视图承担市场/权限/导入导出细节 */
    const { card: plugCard, registry: regs } = createPluginSettingsCard({ rerender: render });

    /* 局域网联动 */
    const st = S.getState().settings;
    st.lanPort ??= 27123;
    st.lanToken ??= Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 8);
    let lanStatus = { running: false, url: "" };
    try { lanStatus = await api.lanStatus(); } catch {}

    const lanCard = el("div", { class: "card set-card" },
      el("h2", {}, "局域网联动"),
    );
    const lanBody = el("div", { style: "margin-top:10px" });
    lanCard.append(lanBody);

    const renderLan = () => {
      lanBody.replaceChildren();
      // 回传开关：allow_push 是启动时烘进服务线程的，改完必须重启一次服务才真的生效，
      // 不然界面上开着、网络上其实还是关的 —— 那种「开关是装饰」的 bug 最难查。
      const pushSwitch = toggleSwitch({ checked: Boolean(st.lanPush), ariaLabel: "允许手机推回本机" });
      pushSwitch.addEventListener("change", async () => {
        st.lanPush = pushSwitch.checked;
        await S.saveNow();
        if (!lanStatus.running) {
          toast(st.lanPush ? "已允许回传（下次启动服务生效）" : "已关闭回传");
          return;
        }
        try {
          await api.lanStop();
          lanStatus = { running: true, url: await api.lanStart(st.lanPort, st.lanToken, st.lanPush) };
          toast(st.lanPush ? "已允许回传：手机每次推都要在这台电脑上点「接收」" : "已关闭回传");
          renderLan();
        } catch (e) {
          lanStatus = { running: false };
          renderLan();
          toast(`联动服务重启失败：${e.message || e}`);
        }
      });
      const pushRow = el("div", { class: "lan-push-row" },
        el("label", { class: "lan-push-label" },
          pushSwitch,
          el("span", {}, "允许手机把数据推回本机")),
        el("p", { class: "desc" },
          "关着的时候，网络上不存在任何能改掉这台电脑数据的路径 —— 手机只能读、只能勾选任务和加一条待办。",
          el("br"),
          "开着也不是直接覆盖：手机推过来的数据先进内存等着，必须在电脑上弹出确认、点「接收」才算数，且覆盖前先存一个恢复点。人不在电脑前就没接收，手机上那份会自己作废。",
        ),
      );
      // 状态行：两种状态下都展示，填满卡片下方空间
      const statusRow = (running, port, host) =>
        el("div", { style: "margin-top:14px;padding-top:12px;border-top:1px dashed var(--line)" },
          el("div", { style: "display:flex;flex-wrap:wrap;gap:6px 26px;font-size:calc(12.5px * var(--ui-text-scale));color:var(--ink-2)" },
            el("span", {}, "状态 ", running
              ? el("span", { style: "font-weight:600;color:var(--mint)" }, "● 运行中")
              : el("span", { style: "font-weight:600;color:var(--ink-3)" }, "○ 已停止")),
            port ? el("span", {}, "端口 ", el("b", {}, port)) : null,
            host ? el("span", {}, "本机地址 ", el("b", {}, host)) : null,
          ),
          running
            ? el("div", { style: "margin-top:6px;font-size:calc(12px * var(--ui-text-scale));color:var(--ink-3)" }, "手机需与电脑处于同一 Wi-Fi / 局域网，扫码或打开链接即可配对联动。")
            : el("div", { style: "margin-top:6px;font-size:calc(12px * var(--ui-text-scale));color:var(--ink-3)" }, "启动后手机浏览器 / 小程序可通过二维码或链接远程操作本机任务。"),
        );
      if (lanStatus.running) {
        const lanPort = (lanStatus.url.match(/:(\d+)/) || [])[1] || st.lanPort;
        const lanHost = (lanStatus.url.match(/^http:\/\/([^:/]+)/) || [])[1] || "";
        lanBody.append(
          el("div", { class: "path-code" }, lanStatus.url),
          el("div", { style: "display:flex;gap:14px;margin-top:12px;align-items:center" },
            el("img", { src: `${lanStatus.url.replace("/m?", "/qr.svg?")}`, style: "width:132px;height:132px;border-radius:10px;border:1px solid var(--line);background:#fff" }),
            el("div", { style: "flex:1" },
              el("div", { style: "display:flex;gap:8px;margin-top:10px;flex-wrap:wrap" },
                el("button", { class: "btn ghost sm", onclick: () => { navigator.clipboard?.writeText(lanStatus.url); toast("链接已复制"); } }, "复制链接"),
                el("button", {
                  class: "btn ghost sm",
                  onclick: async () => {
                    try { await api.openUrl(lanStatus.url); }
                    catch { window.open(lanStatus.url, "_blank"); }
                  },
                }, "从浏览器打开"),
                el("button", {
                  class: "btn danger sm",
                  onclick: async () => {
                    try { await api.lanStop(); }
                    catch (e) { toast(`停止失败：${e.message || e}`); return; }
                    // 关键：lanStop 成功后必须更新本地状态再重渲染，
                    // 否则 lanStatus 仍是 running，界面看起来「按了没反应」。
                    lanStatus = { running: false };
                    st.lanAuto = false;
                    S.saveNow();
                    toast("联动服务已停止");
                    renderLan();
                  },
                }, "停止服务"),
              ),
            ),
          ),
          pushRow,
          statusRow(true, lanPort, lanHost),
        );
      } else {
        const portIn = el("input", { type: "number", value: st.lanPort, style: "width:110px;height:34px;border:1px solid var(--line);border-radius:8px;padding:0 10px;background:#fff" });
        lanBody.append(
          el("div", { style: "display:flex;gap:8px;align-items:center;margin-top:4px" },
            el("span", { style: "font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2)" }, "端口"),
            portIn,
            el("button", {
              class: "btn pri sm",
              onclick: async () => {
                st.lanPort = Number(portIn.value) || 27123;
                st.lanAuto = true;
                S.saveNow();
                try {
                  lanStatus = { running: true, url: await api.lanStart(st.lanPort, st.lanToken) };
                  toast("联动服务已启动");
                  renderLan();
                } catch (e) { toast(`启动失败：${e.message || e}`); }
              },
            }, "启动服务"),
          ),
          statusRow(false, st.lanPort, ""),
        );
      }
    };
    renderLan();

    /* 关于 */
    const aboutCard = createAboutCard(info, regs);

    const settingEntries = [
      { id: "tasks", node: taskCard, label: "任务与排程", icon: "sliders", hint: "新建默认值 / 自动排程", keywords: "任务 象限 预估 时长 截止 提醒 自动排程 起始时间 空白时间块 分类 默认" },
      { id: "ui", node: uiCard, label: "界面与交互", icon: "sliders", hint: "密度 / 字号 / 缩放 / 动效 / 窗口", keywords: "密度 文字 字号 缩放 界面大小 整体缩放 放大 缩小 太大 太小 看不清 动效 手势 滑动 启动页 窗口 大小 尺寸 最大化 分辨率 顶部统计 副标题 托盘 关闭 退出 最小化" },
      { id: "theme", node: themeCard, label: "主题", icon: "palette", hint: "配色与阅读模式", keywords: "颜色 夜间 深海 樱花 松林 暮光 极简" },
      { id: "highlights", node: highlightCard, label: "关键词标注", icon: "highlighter", hint: "时间标红 / 字体 / 背景", keywords: "关键词 重点 标注 高亮 时间 日期 红色 字体 背景 颜色" },
      { id: "reminders", node: reminderCard, label: "任务提醒", icon: "bell", hint: "预警时间与提示音", keywords: "提醒 预警 音量 提示音 音频 截止" },
      { id: "data", node: dataCard, label: "数据中心", icon: "database", hint: "备份 / 恢复 / 交换", keywords: "备份 恢复 JSON CSV Excel ICS 自动恢复点 导入 导出" },
      { id: "sync", node: syncCard, label: "可选同步", icon: "cloud-arrow-up", hint: "网盘快照 / 一键配置引导", keywords: "同步 网盘 WebDAV 上传 下载 备份 恢复 坚果云 Nextcloud 应用密码 换手机 换电脑 一键配置" },
      { id: "ai", node: aiCard, label: "AI 与自动任务", icon: "wand-magic-sparkles", hint: "Base / API Key / 安全边界", keywords: "AI Base API Key 模型 自动任务 加密 定时" },
      { id: "shortcuts", node: shortcutCard, label: "全局快捷键", icon: "keyboard", hint: "命令面板 / 快速捕获 / 插件快捷键", keywords: "快捷键 命令面板 快速捕获 Ctrl Alt 插件快捷键 字母" },
      { id: "lan", node: lanCard, label: "局域网联动", icon: "network-wired", hint: "手机联动与二维码", keywords: "手机 WiFi 二维码 端口 配对" },
      { id: "plugins", node: plugCard, label: "插件管理", icon: "puzzle-piece", hint: "启用 / 导入 / 导出", keywords: "插件 权限 导入 ZIP 启用 停用 开发文档" },
      { id: "cppu-login", node: cppuLoginCard, label: "警大登录设置", icon: "gear", hint: "登录重试 / 自动登录", keywords: "警大 门户 账号 登录 自动登录 密码 验证码 重试" },
      { id: "testing", node: testingCard, label: "测试", icon: "mobile-screen-button", hint: "手机预览 / 尺寸 / 横竖屏", keywords: "测试 手机版 预览 模拟 手机 内置浏览器 横屏 竖屏" },
      // 更新入口在「关于」里（软件更新）：关键词挂这儿，搜「更新 / 升级」也能落到关于。
      { id: "about", node: aboutCard, label: "关于", icon: "circle-info", hint: "版本 / 软件更新 / 免责声明 / 开源信息", keywords: "免责声明 使用说明 隐私 数据 官方 权限 版本 更新 升级 检查更新 自动更新 弹窗提示 忽略此版本 卸载 卸载应用 清除数据 删除数据 卸载 U-Time 开源 框架 GitHub 发布 下载 Releases 插件开发 API 文档 项目仓库" },
    ];
    for (const entry of settingEntries) {
      entry.node.classList.add("settings-section");
      entry.node.id = `settings-${entry.id}`;
    }
    const settingsNavigator = createSettingsNavigator(settingEntries, settingsNavState, {
      pages: isAndroidRuntime(),
      onPageChange: opts.onPageChange,
    });
    opts.onNavigator?.(settingsNavigator);
    // 窄屏走手风琴：分区由 navigator 包成「标题行 + 可收放内容」，这里按它给的顺序渲染
    const content = el("div", { class: "settings-content" }, ...settingsNavigator.panels);
    const layout = el("div", { class: `settings-layout${isAndroidRuntime() ? " settings-pages" : ""}` }, settingsNavigator.node, content);
    // 设置中心头卡已移除：纯展示内容占掉首屏空间，左侧分类导航本身已承担引导职责。
    wrap.replaceChildren(layout);
    settingsNavigator.apply();
    // 外部（如更新提示条的「立即更新」）可以点名要停在哪一节。
    // 放在 apply() 之后：select() 会校验 visibleIds，而那正是 apply() 填的。
    if (initialTarget && opts.section) settingsNavigator.select(opts.section, { animate: false });
    if (initialTarget && opts.target) revealSettingTarget(content, opts.target);
    initialTarget = false;
  };
  render();
}
