import * as S from "../../store.js";
import { el, toast, QUADS } from "../../ui.js";
import { toggleSwitch } from "../../switchControl.js";
import { DEFAULT_TASK_PREFERENCES, getTaskPreferences, normalizeTaskPreferences } from "../../taskPreferences.js";

export function createTaskSettingsCard() {
  const card = el("div", { class: "card set-card task-defaults-card" }, el("h2", {}, "任务与排程"));
  const paint = () => {
    const cfg = getTaskPreferences(S.getState().settings);
    const save = (key, value) => {
      const settings = S.getState().settings;
      settings.taskDefaults = normalizeTaskPreferences({ ...getTaskPreferences(settings), [key]: value });
      S.persistSoon();
      return settings.taskDefaults[key];
    };
    const row = (label, control) => el("div", { class: "setting-row" }, el("span", { class: "setting-copy" }, el("b", {}, label)), control);
    const select = (key, label, options) => {
      const input = el("select", { "aria-label": label });
      for (const [value, text] of options) input.append(el("option", { value }, text));
      input.value = String(cfg[key]);
      input.addEventListener("change", () => { input.value = String(save(key, input.value)); });
      return row(label, input);
    };
    const field = (key, label, type) => {
      const input = el("input", { type, value: cfg[key], "aria-label": label,
        ...(type === "number" ? { min: 15, max: 1440, step: 1, class: "setting-number-input" } : {}) });
      const fitNumber = () => {
        if (type === "number") input.style.width = `calc(${Math.max(2, input.value.length)}ch + 2px)`;
      };
      fitNumber();
      if (type === "number") input.addEventListener("input", fitNumber);
      input.addEventListener("change", () => {
        if (!input.value || !input.checkValidity()) {
          input.value = String(getTaskPreferences(S.getState().settings)[key]);
          fitNumber();
          toast(type === "number" ? "请输入 15～1440 分钟的整数" : "请输入有效时刻");
          return;
        }
        input.value = String(save(key, input.value));
        fitNumber();
      });
      return row(label, type === "number" ? el("span", { class: "setting-number-unit" }, input, el("span", {}, "分钟")) : input);
    };
    card.replaceChildren(
      el("h2", {}, "任务与排程"),
      select("defaultQuad", "默认任务象限", QUADS.map((q) => [q.q, q.title])),
      field("defaultEstMin", "默认预估时长", "number"),
      field("defaultDueTime", "默认截止时刻", "time"),
      row("新任务默认开启提醒", toggleSwitch({ checked: cfg.defaultReminderEnabled, ariaLabel: "新任务默认开启提醒",
        onChange: (checked) => save("defaultReminderEnabled", checked) })),
      field("autoScheduleStart", "自动排程起始时间", "time"),
      field("blankBlockMin", "空白时间块默认时长", "number"),
      select("blankBlockCategory", "空白时间块默认分类", S.CATEGORIES.map((c) => [c.id, c.label])),
      el("p", { class: "set-hint" }, "仅影响之后的新建和自动排程。手动选择象限、时长或时间时，以你的选择为准；捕获识别出的时间和象限保持优先。截止时刻在任务设置截止日期后生效。"),
      el("button", { class: "btn ghost sm", type: "button", onclick: () => {
        const settings = S.getState().settings;
        settings.taskDefaults = { ...DEFAULT_TASK_PREFERENCES };
        S.persistSoon(); paint(); toast("已恢复任务与排程默认值");
      } }, "恢复任务与排程默认"),
    );
  };
  paint();
  return card;
}
