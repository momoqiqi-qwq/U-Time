import * as S from "../../store.js";
import { el, toast } from "../../ui.js";
import { computePluginShortcutMap, getPluginShortcutCustoms, setPluginShortcut } from "../../pluginShortcuts.js";
import { pluginShortcutEntries } from "../../pluginShortcutEntries.js";
import { DEFAULT_GLOBAL_SHORTCUTS, getShortcutConfig, getGlobalShortcutStatus, applyGlobalShortcuts } from "../../globalShortcuts.js";
import { toggleSwitch } from "../../switchControl.js";

export async function createShortcutCard({ settings, info, render }) {
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

  return shortcutCard;
}
