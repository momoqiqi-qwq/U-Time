import * as S from "../../store.js";
import { el, toast } from "../../ui.js";
import { toggleSwitch } from "../../switchControl.js";
import { DEFAULT_KEYWORD_HIGHLIGHTS, normalizeKeywordHighlights, highlightedText } from "../../keywordHighlights.js";

export function createKeywordHighlightsCard() {
  const settings = S.getState().settings;
  const cfg = settings.keywordHighlights = normalizeKeywordHighlights(settings.keywordHighlights);
  const rulesBox = el("div", { class: "keyword-rule-list" });
  const preview = el("div", { class: "keyword-preview", "aria-live": "polite" });
  const enabled = toggleSwitch({ checked: cfg.enabled, ariaLabel: "启用关键词标注" });
  const timeEnabled = toggleSwitch({ checked: cfg.highlightTimes, ariaLabel: "自动标注日期和时间" });
  const timeColor = el("input", { type: "color", value: cfg.timeColor, "aria-label": "时间文字颜色" });

  const persist = () => {
    settings.keywordHighlights = cfg;
    S.touch();
  };
  const paintPreview = () => {
    preview.replaceChildren(
      el("span", { class: "keyword-preview-label" }, "效果预览"),
      el("p", {}, highlightedText("重点：今天 09:30 完成项目汇报，截止 2026-09-21 18:00。", cfg)),
    );
  };
  const paintRules = () => {
    rulesBox.replaceChildren();
    if (!cfg.rules.length) rulesBox.append(el("p", { class: "desc keyword-empty" }, "还没有自定义关键词。添加后，任务、收件箱和时间线里的相同文字会自动着色。"));
    for (const rule of cfg.rules) {
      const word = el("input", { type: "text", value: rule.keyword, maxlength: "40", placeholder: "例如：重点", "aria-label": "关键词" });
      const color = el("input", { type: "color", value: rule.color, "aria-label": `${rule.keyword}的颜色` });
      const mode = el("select", { "aria-label": `${rule.keyword}的标注方式` },
        el("option", { value: "text" }, "字体着色"),
        el("option", { value: "background" }, "背景标注"));
      mode.value = rule.mode;
      const on = toggleSwitch({ checked: rule.enabled, ariaLabel: `启用关键词${rule.keyword}` });
      const remove = el("button", { class: "btn ghost sm keyword-rule-remove", type: "button", title: `删除关键词${rule.keyword}` }, "删除");
      word.addEventListener("change", () => {
        const next = word.value.trim().slice(0, 40);
        if (!next) { word.value = rule.keyword; toast("关键词不能为空"); return; }
        rule.keyword = next; persist(); paintPreview();
      });
      color.addEventListener("input", () => { rule.color = color.value; persist(); paintPreview(); });
      mode.addEventListener("change", () => { rule.mode = mode.value; persist(); paintPreview(); });
      on.addEventListener("change", () => { rule.enabled = on.checked; persist(); paintPreview(); });
      remove.addEventListener("click", () => {
        cfg.rules = cfg.rules.filter((item) => item.id !== rule.id);
        persist(); paintRules(); paintPreview();
      });
      rulesBox.append(el("div", { class: "keyword-rule" }, word, color, mode, on, remove));
    }
  };

  enabled.addEventListener("change", () => { cfg.enabled = enabled.checked; persist(); paintPreview(); });
  timeEnabled.addEventListener("change", () => { cfg.highlightTimes = timeEnabled.checked; persist(); paintPreview(); });
  timeColor.addEventListener("input", () => { cfg.timeColor = timeColor.value; persist(); paintPreview(); });

  const add = el("button", { class: "btn pri sm", type: "button", onclick: () => {
    if (cfg.rules.length >= 20) return toast("最多添加 20 条关键词规则");
    cfg.rules.push({ id: S.uid("mark"), keyword: "重点", color: "#f59e0b", mode: "background", enabled: true });
    persist(); paintRules(); paintPreview();
  } }, "添加关键词");
  const reset = el("button", { class: "btn ghost sm", type: "button", onclick: () => {
    Object.assign(cfg, structuredClone(DEFAULT_KEYWORD_HIGHLIGHTS));
    enabled.checked = cfg.enabled; timeEnabled.checked = cfg.highlightTimes; timeColor.value = cfg.timeColor;
    persist(); paintRules(); paintPreview(); toast("关键词标注已恢复默认");
  } }, "恢复默认");

  paintRules(); paintPreview();
  return el("div", { class: "card set-card keyword-settings" },
    el("h2", {}, "关键词标注"),
    el("p", { class: "desc" }, "让重要文字在任务表、收件箱和时间线中自动显眼。时间默认使用红色字体，自定义关键词可选择字体或背景标注。"),
    el("div", { class: "setting-row" }, el("span", {}, "启用关键词标注"), enabled),
    el("div", { class: "setting-row" }, el("span", {}, "日期和时间自动标红"), el("span", { class: "keyword-time-control" }, timeColor, timeEnabled)),
    preview,
    el("div", { class: "data-section-title" }, "自定义关键词"),
    rulesBox,
    el("div", { class: "data-actions keyword-actions" }, add, reset),
  );
}
