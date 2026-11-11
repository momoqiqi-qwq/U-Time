import { el, toast } from "../../ui.js";
import * as S from "../../store.js";
import { toggleSwitch } from "../../switchControl.js";
import { createAutoBackup } from "../../dataCenter.js";
import {
  clearStoredGitHubToken,
  connectGitHubRepository,
  createDefaultGitHubRepository,
  deleteGitHubBackup,
  downloadGitHubBackup,
  listGitHubBackups,
  loadStoredGitHubToken,
  parseGitHubRepository,
  saveStoredGitHubToken,
  uploadGitHubBackup,
} from "../../githubBackup.js";

const DEFAULT_INTERVAL_HOURS = 24;

function formatWhen(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN");
}

function describeError(error) {
  return String(error?.message || error || "GitHub 操作失败");
}

export async function createGitHubBackupSection({ settings, info } = {}) {
  settings.sync ??= {};
  const cfg = settings.sync.github ??= {};
  cfg.intervalHours = Math.min(24 * 30, Math.max(1, Number(cfg.intervalHours) || DEFAULT_INTERVAL_HOURS));
  let hasStoredToken = Boolean(await loadStoredGitHubToken());

  const tokenInput = el("input", {
    type: "password", placeholder: hasStoredToken ? "已加密保存，留空即沿用" : "GitHub Fine-grained PAT",
    autocomplete: "new-password", spellcheck: "false",
  });
  const repoInput = el("input", { type: "url", value: cfg.repository || "", placeholder: "留空则创建私有 Backup-UTime", autocomplete: "off", spellcheck: "false" });
  const branchInput = el("input", { type: "text", value: cfg.branch || "main", placeholder: "main", autocomplete: "off", spellcheck: "false" });
  const deviceInput = el("input", { type: "text", value: cfg.deviceName || "UTime", placeholder: "UTime", autocomplete: "off", spellcheck: "false" });
  const intervalInput = el("input", { type: "number", min: "1", max: "720", value: cfg.intervalHours, style: "width:84px" });
  const autoSwitch = toggleSwitch({ checked: cfg.enabled === true, ariaLabel: "启用 GitHub 自动备份" });
  const status = el("div", { class: "shortcut-status sync-result" });
  const history = el("div", { class: "backup-list" });
  const connectBtn = el("button", { class: "btn pri sm", type: "button" });
  const backupBtn = el("button", { class: "btn ghost sm", type: "button", disabled: !cfg.repository });
  const refreshBtn = el("button", { class: "btn ghost sm", type: "button", disabled: !cfg.repository });
  let busy = false;

  const say = (message, tone = "") => {
    status.className = `shortcut-status sync-result${tone ? ` ${tone}` : ""}`;
    status.textContent = message;
  };
  const setBusy = (value) => {
    busy = value;
    for (const button of [connectBtn, backupBtn, refreshBtn]) button.disabled = value || (!cfg.repository && button !== connectBtn);
  };

  async function resolveToken() {
    const typed = tokenInput.value.trim();
    if (typed) return typed;
    const stored = await loadStoredGitHubToken();
    if (!stored) throw new Error("请先填写 GitHub PAT");
    return stored;
  }

  async function persistConfig(patch = {}) {
    Object.assign(cfg, patch, {
      branch: branchInput.value.trim() || "main",
      deviceName: deviceInput.value.trim() || "UTime",
      intervalHours: Math.min(720, Math.max(1, Number(intervalInput.value) || DEFAULT_INTERVAL_HOURS)),
      enabled: Boolean(autoSwitch.checked),
    });
    await S.saveNow();
  }

  function paintState() {
    const connected = Boolean(cfg.repository);
    connectBtn.textContent = connected ? "重新连接并验证" : "创建并连接私有仓库";
    backupBtn.disabled = busy || !connected;
    refreshBtn.disabled = busy || !connected;
    autoSwitch.disabled = !connected;
    if (!connected) {
      say("未连接 GitHub。留空仓库地址可自动创建私有 Backup-UTime。", "");
    } else if (!status.textContent || status.classList.contains("is-error")) {
      say(`已连接 · ${cfg.repository}${cfg.lastBackupAt ? ` · 上次备份 ${formatWhen(cfg.lastBackupAt)}` : ""}`, "is-ok");
    }
  }

  async function loadHistory() {
    history.replaceChildren();
    if (!cfg.repository) return;
    try {
      const token = await resolveToken();
      const rows = await listGitHubBackups({ token, repository: cfg.repository, branch: cfg.branch || "main", deviceName: cfg.deviceName || "UTime" });
      if (!rows.length) {
        history.append(el("p", { class: "desc" }, "这个设备还没有 GitHub 备份。"));
        return;
      }
      for (const row of rows.slice(0, 12)) {
        const restore = el("button", { class: "btn ghost sm", type: "button" }, "恢复");
        const remove = el("button", { class: "btn ghost sm", type: "button" }, "删除");
        restore.onclick = async () => {
          if (busy || !window.confirm(`恢复 ${row.name}？当前数据会先自动创建一个恢复点。`)) return;
          setBusy(true);
          try {
            say("正在读取 GitHub 备份…");
            const token = await resolveToken();
            const remote = await downloadGitHubBackup({ token, repository: cfg.repository, branch: cfg.branch || "main", path: row.path });
            createAutoBackup("恢复 GitHub 备份前", info?.version || "");
            S.replaceAll(remote.snapshot.data);
            await S.saveNow();
            await persistConfig({ lastBackupAt: remote.snapshot.exportedAt || new Date().toISOString() });
            say(`已恢复 · ${formatWhen(remote.snapshot.exportedAt)}`, "is-ok");
            toast("GitHub 备份已恢复");
          } catch (error) {
            say(describeError(error), "is-error");
          } finally {
            setBusy(false); paintState();
          }
        };
        remove.onclick = async () => {
          if (busy || !window.confirm(`永久删除远端备份 ${row.name}？此操作不可撤销。`)) return;
          setBusy(true);
          try {
            const token = await resolveToken();
            await deleteGitHubBackup({ token, repository: cfg.repository, branch: cfg.branch || "main", path: row.path, sha: row.sha });
            say(`已删除远端备份 · ${row.name}`, "is-ok");
            await loadHistory();
          } catch (error) {
            say(describeError(error), "is-error");
          } finally { setBusy(false); paintState(); }
        };
        history.append(el("div", { class: "backup-row" },
          el("span", {}, el("b", {}, row.name), el("small", {}, `${(Number(row.size || 0) / 1024).toFixed(0)} KB`)),
          el("span", {}, restore, remove),
        ));
      }
    } catch (error) {
      history.append(el("p", { class: "desc" }, `历史读取失败：${describeError(error)}`));
    }
  }

  connectBtn.onclick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const token = await resolveToken();
      let connection;
      if (repoInput.value.trim()) {
        const repo = parseGitHubRepository(repoInput.value);
        say("正在验证 GitHub 仓库…");
        connection = await connectGitHubRepository({ token, repository: repo.url, branch: branchInput.value.trim() });
      } else {
        if (!window.confirm("将使用当前 PAT 创建一个名为 Backup-UTime 的 Private 仓库，并只把 U-Time 数据备份进去。PAT 需要创建用户仓库和写入 Contents 的权限。继续吗？")) return;
        say("正在创建或复用私有 Backup-UTime…");
        connection = await createDefaultGitHubRepository({ token, appName: "U-Time" });
      }
      await saveStoredGitHubToken(token);
      hasStoredToken = true;
      tokenInput.value = "";
      tokenInput.placeholder = "已加密保存，留空即沿用";
      repoInput.value = connection.url;
      branchInput.value = connection.branch || "main";
      await persistConfig({ repository: connection.url, branch: connection.branch || "main", enabled: cfg.enabled === true });
      say(`${connection.created ? "已创建并连接" : "连接成功"} · ${connection.fullName}（${connection.private ? "Private" : "Public"}）`, "is-ok");
      await loadHistory();
      toast("GitHub 备份已连接");
    } catch (error) {
      say(describeError(error), "is-error");
    } finally { setBusy(false); paintState(); }
  };

  backupBtn.onclick = async () => {
    if (busy || !cfg.repository) return;
    setBusy(true);
    try {
      const token = await resolveToken();
      say("正在上传 GitHub 备份…");
      const result = await uploadGitHubBackup({ token, repository: cfg.repository, branch: cfg.branch || "main", deviceName: cfg.deviceName || "UTime", data: S.getState(), appVersion: info?.version || "" });
      await saveStoredGitHubToken(token);
      hasStoredToken = true;
      tokenInput.value = "";
      await persistConfig({ lastBackupAt: result.snapshot.exportedAt, lastBackupPath: result.path });
      say(`备份成功 · ${formatWhen(result.snapshot.exportedAt)}`, "is-ok");
      toast("GitHub 备份已上传");
      await loadHistory();
    } catch (error) { say(describeError(error), "is-error"); }
    finally { setBusy(false); paintState(); }
  };

  refreshBtn.onclick = async () => {
    if (busy) return;
    setBusy(true);
    try { say("正在刷新 GitHub 备份历史…"); await loadHistory(); say("GitHub 备份历史已刷新", "is-ok"); }
    catch (error) { say(describeError(error), "is-error"); }
    finally { setBusy(false); paintState(); }
  };

  autoSwitch.addEventListener("change", async () => {
    try { await persistConfig(); say(autoSwitch.checked ? `已开启自动备份 · 每 ${cfg.intervalHours} 小时检查一次` : "已关闭自动备份", "is-ok"); }
    catch (error) { say(describeError(error), "is-error"); }
  });
  intervalInput.addEventListener("change", () => { persistConfig().catch((error) => say(describeError(error), "is-error")); });
  for (const input of [branchInput, deviceInput]) input.addEventListener("change", () => { persistConfig().catch((error) => say(describeError(error), "is-error")); });

  const forgetBtn = el("button", { class: "btn ghost sm", type: "button" }, "断开并清除 PAT");
  forgetBtn.onclick = async () => {
    if (busy || !window.confirm("断开 GitHub 备份？这只会清除本机连接和 PAT，不会删除 GitHub 上已有备份。")) return;
    await clearStoredGitHubToken();
    hasStoredToken = false;
    Object.assign(cfg, { repository: "", branch: "main", enabled: false, lastBackupAt: "", lastBackupPath: "" });
    repoInput.value = ""; branchInput.value = "main"; tokenInput.value = ""; tokenInput.placeholder = "GitHub Fine-grained PAT"; autoSwitch.checked = false;
    await S.saveNow();
    history.replaceChildren();
    say("已断开，远端备份未删除", "is-ok");
    paintState();
  };

  const card = el("div", { class: "github-backup-card" },
    el("div", { class: "data-section-title" }, "GitHub 备份"),
    el("p", { class: "desc" }, "把 U-Time 数据保存到 GitHub 的 Private 仓库。PAT 只存在本机加密密钥库，不进入 data.json、快照或仓库 URL。"),
    el("div", { class: "sync-form" },
      el("label", { class: "sync-field" }, el("span", {}, "GitHub PAT"), tokenInput),
      el("label", { class: "sync-field" }, el("span", {}, "仓库地址（可留空自动创建）"), repoInput),
      el("label", { class: "sync-field" }, el("span", {}, "分支"), branchInput),
      el("label", { class: "sync-field" }, el("span", {}, "设备名"), deviceInput),
    ),
    el("div", { class: "data-actions" }, connectBtn, backupBtn, refreshBtn, forgetBtn),
    el("div", { class: "setting-row" }, el("span", {}, "启用自动备份"), autoSwitch),
    el("div", { class: "setting-row" }, el("span", {}, "检查间隔（小时）"), intervalInput),
    status,
    el("div", { class: "data-section-title" }, "远端备份历史"),
    history,
  );
  paintState();
  if (cfg.repository) loadHistory();
  return card;
}

