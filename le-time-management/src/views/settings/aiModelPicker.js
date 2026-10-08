import { el } from "../../ui.js";
import { attachSelectionGlow } from "../../selectionGlow.js";

let nextId = 0;

// 可编辑模型 ID + 独立搜索列表，折叠容器保留 DOM 完成双向高度过渡。
export function createAiModelPicker(input) {
  const id = `ai-model-list-${++nextId}`;
  const search = el("input", { type: "search", placeholder: "搜索模型名称或 ID", "aria-label": "搜索可用模型", autocomplete: "off" });
  const options = el("div", { class: "ai-model-options", id, role: "listbox", "aria-label": "可用模型" });
  const empty = el("p", { class: "ai-model-empty" }, "填写 API Key 后刷新，或直接输入模型 ID。");
  const content = el("div", { class: "ai-model-content" }, search, options, empty);
  const panel = el("div", { class: "ai-model-disclosure", "aria-hidden": "true" },
    el("div", { class: "ai-model-disclosure-inner" }, content));
  panel.inert = true;
  input.setAttribute("aria-label", "模型 ID");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "none");
  input.setAttribute("aria-controls", id);
  input.setAttribute("aria-expanded", "false");
  const trigger = el("button", {
    type: "button", class: "btn ghost sm ai-model-toggle", "data-motion": "off",
    "aria-label": "展开可用模型", "aria-controls": id, "aria-expanded": "false",
  }, el("i", { class: "ai-model-arrow", "aria-hidden": "true" }));
  const node = el("div", { class: "ai-model-picker" }, el("div", { class: "ai-model-input-row" }, input, trigger), panel);
  const glow = attachSelectionGlow(options, { selector: '.ai-model-option[aria-selected="true"]' });
  let models = [], open = false;

  function syncSelection(animate = true) {
    for (const option of options.querySelectorAll(".ai-model-option")) {
      const selected = option.dataset.modelId === input.value.trim();
      option.setAttribute("aria-selected", String(selected));
      option.classList.toggle("on", selected);
    }
    glow.sync(animate);
  }
  function render() {
    const query = search.value.trim().toLowerCase();
    const visible = models.filter(model => `${model.id} ${model.name}`.toLowerCase().includes(query));
    // 保留光块，不重建整个容器。
    for (const option of options.querySelectorAll(".ai-model-option")) option.remove();
    for (const model of visible) {
      const option = el("button", {
        type: "button", class: "ai-model-option", role: "option", tabindex: "-1", "data-model-id": model.id,
        "aria-selected": String(model.id === input.value.trim()), "data-motion": "off",
        onclick: () => {
          input.value = model.id;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          syncSelection();
          setOpen(false);
          input.focus({ preventScroll: true });
        },
      }, el("b", {}, model.id), model.name && model.name !== model.id ? el("small", {}, model.name) : null);
      options.append(option);
    }
    empty.hidden = visible.length > 0;
    empty.textContent = models.length ? "没有匹配模型，可直接输入模型 ID。" : "填写 API Key 后刷新，或直接输入模型 ID。";
    syncSelection(false);
  }
  function setOpen(value) {
    if (!value && panel.contains(document.activeElement)) input.focus({ preventScroll: true });
    open = value;
    input.setAttribute("aria-expanded", String(open));
    trigger.setAttribute("aria-expanded", String(open));
    trigger.setAttribute("aria-label", open ? "收起可用模型" : "展开可用模型");
    panel.classList.toggle("is-open", open);
    panel.setAttribute("aria-hidden", String(!open));
    panel.inert = !open;
    if (open) glow.sync(false);
  }
  trigger.addEventListener("click", () => {
    if (!open) { search.value = ""; render(); }
    setOpen(!open);
    if (open) search.focus({ preventScroll: true });
  });
  search.addEventListener("input", render);
  input.addEventListener("input", () => syncSelection());
  node.addEventListener("focusout", event => {
    if (event.relatedTarget && !node.contains(event.relatedTarget)) setOpen(false);
    else if (!event.relatedTarget) setTimeout(() => {
      if (!node.contains(document.activeElement)) setOpen(false);
    }, 0);
  });
  node.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Escape" && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false); input.focus(); return;
    }
    // Home / End 在输入框内仍用于移动光标。
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
      || (["Home", "End"].includes(event.key) && event.target.tagName === "INPUT")) return;
    event.preventDefault();
    if (!open) { search.value = ""; render(); setOpen(true); }
    const buttons = [...options.querySelectorAll(".ai-model-option")];
    const current = buttons.indexOf(document.activeElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : current < 0 ? (event.key === "ArrowDown" ? 0 : buttons.length - 1)
        : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    (buttons[index] || search).focus({ preventScroll: true });
    buttons[index]?.scrollIntoView({ block: "nearest" });
  });
  return {
    node,
    setModels(next) { models = next; render(); },
    close() { setOpen(false); },
    dispose() { setOpen(false); glow.dispose(); },
  };
}
