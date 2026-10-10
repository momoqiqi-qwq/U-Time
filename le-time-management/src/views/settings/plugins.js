import { api } from "../../api.js";
import * as S from "../../store.js";
import { el, toast } from "../../ui.js";
import { getRegistry, setEnabled, rescan, removeExternalPlugin, pluginViews } from "../../pluginHost.js";
import { PROJECT_LINKS } from "../../projectLinks.js";
import { pluginAccent, pluginDisplayIcon, pluginDisplayName } from "../../pluginAppearance.js";
import { reducedMotion } from "../../motion.js";
import { getUiPreferences, setUiPreferences } from "../../uiPreferences.js";
import { toggleSwitch } from "../../switchControl.js";
import { withSearchGlyph } from "../../searchField.js";

const selectedPlugins = new Set();
let pluginManageQuery = "";
let pluginManageFilter = "all";
// 批量启停期间置位：setEnabled() 每次都会 emitNavChanged()，设置页订阅了它并整页重渲染。
// 12 个插件的批量操作会因此触发 12 次全页重建（闪烁 + 丢滚动位置），所以批量期间先压住，
// 批量结束自己 rerender() 一次。settings.js 的 onNavChanged 回调据此跳过。
let pluginBatchBusy = false;

export function isPluginBatchBusy() { return pluginBatchBusy; }

export function createPluginSettingsCard({ rerender = () => {} } = {}) {
  const githubIcon = el("span", { class: "github-doc-icon", "aria-hidden": "true" });
  githubIcon.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17"><path fill="currentColor" d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.1.79-.25.79-.56v-2.2c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.78 1.2 1.78 1.2 1.04 1.77 2.72 1.26 3.38.96.1-.75.4-1.26.74-1.55-2.57-.3-5.27-1.29-5.27-5.72 0-1.26.45-2.3 1.19-3.1-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.16 1.18A10.97 10.97 0 0 1 12 6.09c.98 0 1.95.13 2.87.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.77.11 3.06.74.8 1.19 1.84 1.19 3.1 0 4.44-2.71 5.42-5.29 5.71.42.36.79 1.07.79 2.16v3.2c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z"/></svg>';
  const websiteLink = el("button", {
    class: "plugin-doc-link",
    title: "打开 U-Time 官方网站",
    onclick: () => PROJECT_LINKS.website ? api.openUrl(PROJECT_LINKS.website) : toast("请先在 src/projectLinks.js 填入你的真实官网地址"),
  }, el("span", { "aria-hidden": "true" }, "↗"), el("span", {}, "官方网站"));
  const docLink = el("button", {
    class: "plugin-doc-link",
    title: "打开 U-Time 项目仓库 / 在线开发文档",
    onclick: () => api.openUrl(PROJECT_LINKS.repository),
  }, githubIcon, el("span", {}, "在线开发文档"));
  const downloadDoc = el("button", {
    class: "plugin-doc-link",
    title: "下载离线插件开发文档",
    onclick: async () => {
      const filename = "U-Time-插件开发文档.md";
      try {
        const res = await fetch(PROJECT_LINKS.pluginDevDocAsset, { cache: "no-store" });
        if (!res.ok) throw new Error(`文档读取失败 (${res.status})`);
        const text = await res.text();
        // 优先真正落盘到系统下载目录（<a download> 在 Tauri WebView 里对 blob: 下载不可靠）
        try {
          const path = await api.saveDownload(filename, text);
          toast(`插件开发文档已保存：${path}`);
          return;
        } catch { /* 浏览器调试环境 → 退回 blob 下载 */ }
        const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = el("a", { href: url, download: filename });
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast("插件开发文档已下载");
      } catch (e) { toast(`下载失败：${e.message || e}`); }
    },
  }, el("span", { "aria-hidden": "true" }, "↓"), el("span", {}, "下载开发文档"));
  const resourceLinks = el("div", { class: "plugin-resource-links" }, websiteLink, docLink, downloadDoc);

  const plugCard = el("div", { class: "card set-card" },
    el("div", { class: "plugin-title-row" }, el("h2", {}, "插件"), resourceLinks),
  );
  const regs = getRegistry();
  const userRegs = regs.filter((r) => r.source !== "builtin");
  const pluginList = el("div", { class: "plugin-manage-list" });
  // v0.184.0：框内不再写中文占位词，只留一颗放大镜（见 src/searchField.js）。
  const pluginSearch = el("input", { class: "plugin-search-input", type: "search", value: pluginManageQuery, placeholder: "", "aria-label": "搜索插件管理列表" });
  const pluginFilter = el("select", { class: "plugin-filter-select", "aria-label": "筛选插件" },
    el("option", { value: "all" }, "全部插件"),
    el("option", { value: "enabled" }, "已启用"),
    el("option", { value: "disabled" }, "已停用"),
    el("option", { value: "builtin" }, "内置插件"),
    el("option", { value: "user" }, "用户插件"),
  );
  pluginFilter.value = pluginManageFilter;
  const pluginVisibleCount = el("span", { class: "market-count" });
  const pluginDescToggle = toggleSwitch({
    checked: getUiPreferences().showPluginDescriptions,
    ariaLabel: "显示插件介绍",
    onChange: (checked) => setUiPreferences({ showPluginDescriptions: checked }),
  });
  const pluginDescControl = el("label", { class: "plugin-desc-toggle" },
    el("span", {}, "显示介绍"),
    pluginDescToggle,
  );
  const applyPluginManageFilter = () => {
    pluginManageQuery = pluginSearch.value;
    pluginManageFilter = pluginFilter.value;
    const q = pluginManageQuery.trim().toLowerCase();
    let shown = 0;
    for (const card of pluginList.children) {
      const enabled = card.dataset.enabled === "true";
      const source = card.dataset.source;
      const passFilter = pluginManageFilter === "all" || (pluginManageFilter === "enabled" && enabled) || (pluginManageFilter === "disabled" && !enabled) || (pluginManageFilter === "builtin" && source === "builtin") || (pluginManageFilter === "user" && source !== "builtin");
      const passSearch = !q || (card.dataset.search || "").includes(q);
      card.hidden = !(passFilter && passSearch);
      if (!card.hidden) shown++;
    }
    pluginVisibleCount.textContent = `${shown} / ${regs.length}`;
  };
  pluginSearch.addEventListener("input", applyPluginManageFilter);
  pluginFilter.addEventListener("change", applyPluginManageFilter);
  plugCard.append(el("div", { class: "plugin-search-row" }, withSearchGlyph(pluginSearch), pluginFilter, pluginDescControl, pluginVisibleCount));
  // 清掉已经不存在的选择，避免重扫后误操作。
  for (const id of [...selectedPlugins]) if (!regs.some((r) => r.id === id)) selectedPlugins.delete(id);

  const pluginImportInput = el("input", { type: "file", accept: ".zip,application/zip", multiple: true, style: "display:none" });
  pluginImportInput.addEventListener("change", async () => {
    const files = [...pluginImportInput.files];
    if (!files.length) return;
    try {
      const all = [];
      for (const file of files) {
        const bytes = [...new Uint8Array(await file.arrayBuffer())];
        const ids = await api.importPluginZip(bytes);
        all.push(...ids);
      }
      await rescan();
      toast(`已导入 ${[...new Set(all)].length} 个插件`);
      rerender();
    } catch (e) {
      toast(`插件导入失败：${e.message || e}`);
    } finally {
      pluginImportInput.value = "";
    }
  });
  plugCard.append(pluginImportInput);

  const selectedIds = () => regs.filter((r) => selectedPlugins.has(r.id)).map((r) => r.id);
  const selectedUserIds = () => userRegs.filter((r) => selectedPlugins.has(r.id)).map((r) => r.id);
  const selectedBuiltinCount = () => regs.filter((r) => r.source === "builtin" && selectedPlugins.has(r.id)).length;
  const saveZipBase64 = (b64, name) => {
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const blob = new Blob([bytes], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  /** 批量启停：只翻转状态确实不同的那些，避免无谓的插件重载。 */
  const applyBulkEnabled = async (on) => {
    const ids = selectedIds();
    if (!ids.length) return toast("请先勾选要批量操作的插件");
    const targets = ids.filter((id) => (S.pluginState(id).enabled !== false) !== on);
    if (!targets.length) return toast(on ? "选中的插件都已开启" : "选中的插件都已关闭");
    pluginBatchBusy = true;
    let done = 0;
    try {
      for (const id of targets) {
        try { await setEnabled(id, on); done++; }
        catch (e) { toast(`${on ? "开启" : "关闭"}「${id}」失败：${e.message || e}`); }
      }
    } finally {
      pluginBatchBusy = false;
    }
    toast(`已${on ? "开启" : "关闭"} ${done} 个插件`);
    rerender();
  };

  const toolbarCount = el("span", { class: "plugin-toolbar-count" });
  const bulkOnBtn = el("button", { class: "btn ghost sm", onclick: () => applyBulkEnabled(true) }, "开启所选");
  const bulkOffBtn = el("button", { class: "btn ghost sm", onclick: () => applyBulkEnabled(false) }, "关闭所选");
  const selectAllBtn = el("button", {
    class: "btn ghost sm",
    onclick: () => {
      // v0.48.0：全选范围 = 全部插件（内置 + 用户），因为批量启停对两者都有效。
      // v0.52.0 批量勾选错落动画：不再整页 rerender —— 就地翻勾选框，
      // 状态变化的可见卡片按 --bi 错落延迟逐个弹起，工具栏计数照旧 paintToolbar()。
      const allOn = regs.length > 0 && regs.every((r) => selectedPlugins.has(r.id));
      const reduced = reducedMotion();
      let bi = 0;
      for (const card of pluginList.children) {
        const pid = card.dataset.pid;
        if (!pid) continue;
        const now = !allOn;
        const changed = selectedPlugins.has(pid) !== now;
        if (changed) {
          now ? selectedPlugins.add(pid) : selectedPlugins.delete(pid);
          const input = card.querySelector(".plugin-select input");
          if (input) input.checked = now;
        }
        if (changed && !reduced && !card.hidden) {
          card.style.setProperty("--bi", `${bi * 45}ms`);
          bi++;
          card.classList.remove("bulk-pop");
          void card.offsetWidth; // 重启动画（连续点击全选也从头弹）
          card.classList.add("bulk-pop");
          card.addEventListener("animationend", () => card.classList.remove("bulk-pop"), { once: true });
          setTimeout(() => card.classList.remove("bulk-pop"), 1200); // animationend 兜底
        }
      }
      paintToolbar();
    },
  }, "全选");
  const deleteSelBtn = el("button", {
    class: "btn danger sm",
    onclick: async () => {
      const ids = selectedUserIds();
      if (!ids.length) return;
      const skipped = selectedBuiltinCount();
      const ok = window.confirm(
        `确定删除选中的 ${ids.length} 个用户插件？\n\n插件文件夹及对应插件状态都会被移除。`
        + (skipped ? `\n\n（选中的 ${skipped} 个内置插件不能删除，会被跳过 —— 可以改用「关闭所选」。）` : ""),
      );
      if (!ok) return;
      let done = 0;
      for (const id of ids) {
        try { await removeExternalPlugin(id); selectedPlugins.delete(id); done++; }
        catch (e) { toast(`删除 ${id} 失败：${e.message || e}`); }
      }
      toast(`已删除 ${done} 个用户插件`);
      rerender();
    },
  }, "删除所选");
  // 勾选只改工具栏按钮的可用态与文案 —— 不再整页 rerender()：
  // 每点一个勾就重建整页（含全部设置分区）在插件多时明显卡顿，还会把滚动位置弹回顶部。
  const paintToolbar = () => {
    const total = selectedIds().length;
    toolbarCount.textContent = total ? `已选 ${total} / ${regs.length}` : `未选择 · 共 ${regs.length} 个插件`;
    toolbarCount.classList.toggle("on", total > 0);
    bulkOnBtn.disabled = !total;
    bulkOffBtn.disabled = !total;
    selectAllBtn.textContent = regs.length && regs.every((r) => selectedPlugins.has(r.id)) ? "取消全选" : "全选";
    const delCount = selectedUserIds().length;
    deleteSelBtn.disabled = delCount === 0;
    deleteSelBtn.textContent = `删除所选${delCount ? ` (${delCount})` : ""}`;
  };

  const toolbar = el("div", { class: "plugin-toolbar" },
    el("button", { class: "btn pri sm", onclick: () => pluginImportInput.click() }, "导入插件"),
    bulkOnBtn,
    bulkOffBtn,
    el("button", {
      class: "btn ghost sm",
      onclick: async () => {
        const ids = selectedUserIds();
        const skipped = selectedBuiltinCount();
        if (!ids.length) return toast(skipped ? "内置插件不能导出，请勾选用户插件" : "请先勾选要导出的用户插件");
        try {
          const b64 = await api.exportPluginsZip(ids);
          saveZipBase64(b64, `U-Time-plugins-${S.todayStr()}.zip`);
          toast(`已导出 ${ids.length} 个用户插件${skipped ? `（跳过 ${skipped} 个内置插件）` : ""}`);
        } catch (e) { toast(`导出失败：${e.message || e}`); }
      },
    }, "导出所选"),
    selectAllBtn,
    el("button", {
      class: "btn ghost sm",
      onclick: async () => { await S.saveNow(); toast("插件配置已保存"); },
    }, "保存配置"),
    deleteSelBtn,
    toolbarCount,
  );
  plugCard.append(toolbar);
  paintToolbar();

  if (!regs.length) {
    plugCard.append(el("p", { class: "desc", style: "padding:8px 0" }, "尚未发现任何插件。"));
  }
  for (const rec of regs) {
    const man = rec.manifest || {};
    const pluginName = pluginDisplayName(rec.id, man.name || rec.id);
    const deletable = rec.source !== "builtin";
    // v0.48.0：勾选框覆盖全部插件（内置插件也能选，用于批量开启/关闭）；
    // 「不能删」只限制删除与导出，不再等于「不能选」，所以不再给内置插件留空位。
    const selector = el("label", {
      class: "plugin-select",
      title: deletable ? "选择此插件（可批量启停 / 导出 / 删除）" : "选择此插件（可批量启停；内置插件不能删除）",
    },
      el("input", {
        type: "checkbox",
        checked: selectedPlugins.has(rec.id) ? true : null,
        "aria-label": `选择插件 ${pluginName}`,
        onchange: (e) => {
          e.currentTarget.checked ? selectedPlugins.add(rec.id) : selectedPlugins.delete(rec.id);
          paintToolbar();
        },
      }));
    const enabledForSwitch = S.pluginState(rec.id).enabled !== false;
    const actions = el("div", { class: "plugin-card-controls" },
      el("span", { class: "plugin-switch-label" }, enabledForSwitch ? "已开启" : "已关闭"),
      el("button", {
        class: `switch plugin-enable-switch${enabledForSwitch ? " on" : ""}`,
        role: "switch",
        "aria-checked": String(enabledForSwitch),
        "aria-label": `${enabledForSwitch ? "关闭" : "开启"}${pluginName}`,
        title: enabledForSwitch ? "关闭插件" : "开启插件",
        onclick: async (e) => {
          const on = !e.currentTarget.classList.contains("on");
          e.currentTarget.classList.toggle("on", on);
          e.currentTarget.setAttribute("aria-checked", String(on));
          e.currentTarget.parentElement?.querySelector(".plugin-switch-label")?.replaceChildren(on ? "已开启" : "已关闭");
          try {
            await setEnabled(rec.id, on);
            toast(on ? `已开启「${pluginName}」` : `已关闭「${pluginName}」`);
            setTimeout(rerender, 120);
          } catch (err) {
            e.currentTarget.classList.toggle("on", !on);
            e.currentTarget.setAttribute("aria-checked", String(!on));
            toast(`切换失败：${err.message || err}`);
          }
        },
      }),
    );
    if (deletable) {
      actions.append(el("button", {
        class: "btn danger sm",
        title: "从用户插件目录删除",
        onclick: async () => {
          const ok = window.confirm(`删除用户插件「${pluginName}」？\n\n这会移除插件文件夹和本插件保存的状态。`);
          if (!ok) return;
          try {
            await removeExternalPlugin(rec.id);
            selectedPlugins.delete(rec.id);
            toast(`已删除「${pluginName}」`);
            rerender();
          } catch (e) { toast(`删除失败：${e.message || e}`); }
        },
      }, "删除"));
    }
    const enabledNow = S.pluginState(rec.id).enabled !== false;
    const card = el("div", {
      class: "plug-card",
      "data-pid": rec.id,
      "data-source": rec.source,
      "data-enabled": String(enabledNow),
      "data-search": `${pluginName} ${rec.id} ${man.description || ""} ${man.author || ""}`.toLowerCase(),
    },
      selector,
      el("div", { class: `plug-ic${rec.id === "weekly-report" ? " alt" : ""}`, style: `--plugin-accent:${pluginAccent(rec.id)}` }, pluginDisplayIcon(rec.id, pluginName)),
      el("div", { class: "plug-info" },
        el("div", { class: "pn" }, pluginName,
          el("span", { class: "src" }, rec.source === "builtin" ? "内置" : "用户目录"),
          ...(man.version ? [el("span", { class: "src" }, `v${man.version}`)] : [])),
        el("div", { class: "pd" }, man.description || "（无描述）"),
        el("div", { class: "pm" },
          `作者 ${man.author || "未知"}`,
          pluginViews.some((v) => v.pluginId === rec.id) ? " · 提供了视图" : ""),
        rec.error ? el("div", { class: "perr" }, `加载失败：${rec.error}`) : null,
      ),
      actions,
    );
    pluginList.append(card);
  }
  plugCard.append(pluginList);
  applyPluginManageFilter();
  plugCard.append(el("div", { style: "padding-top:12px;display:flex;gap:9px" },
    el("button", {
      class: "btn ghost sm",
      onclick: async () => { await rescan(); toast("已重新扫描插件目录"); rerender(); },
    }, "重新扫描"),
  ));
  return { card: plugCard, registry: regs };
}
