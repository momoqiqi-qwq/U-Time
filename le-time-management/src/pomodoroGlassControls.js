import { attachSelectionGlow } from "./selectionGlow.js";
import { DEFAULT_UI_PREFERENCES, setUiPreferences } from "./uiPreferences.js";

const PARAMETERS = [
  ["pomodoroGlassDistortion", "折射强度", 0, 3, 0.01],
  ["pomodoroGlassHighlight", "边缘高光", 0, 4, 0.1],
  ["pomodoroGlassRadius", "圆角大小", 0, 110, 1],
  ["pomodoroGlassScatter", "散射模糊", 0, 30, 1],
  ["pomodoroGlassFlow", "流动幅度", 0, 1, 0.01],
];
const MATERIALS = [["glass", "液态玻璃"], ["blur", "柔焦玻璃"], ["round", "圆角切片"]];

export function mountPomodoroGlassControls(card, doc = document) {
  if (!card.append || !card.after || !card.querySelector) return null;

  const lens = doc.createElement("div");
  lens.className = "pomodoro-glass-lens";
  lens.setAttribute("role", "group");
  lens.setAttribute("aria-label", "可移动玻璃片");
  const grip = doc.createElement("button");
  grip.type = "button";
  grip.className = "pomodoro-glass-grip";
  grip.textContent = "⠿ 拖动玻璃";
  grip.setAttribute("aria-label", "拖动玻璃片；方向键移动，Shift 加速");
  lens.append(grip);
  card.append(lens);

  const panel = doc.createElement("section");
  panel.className = "pomodoro-glass-lab";
  panel.setAttribute("aria-label", "玻璃材质参数");
  const head = doc.createElement("div");
  head.className = "pomodoro-glass-lab-head";
  const title = doc.createElement("strong");
  title.textContent = "玻璃材质";
  const reset = doc.createElement("button");
  reset.type = "button";
  reset.className = "pomodoro-glass-reset";
  reset.textContent = "重置参数";
  head.append(title, reset);
  const modes = doc.createElement("div");
  modes.className = "pomodoro-glass-materials";
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "玻璃材质");
  for (const [id, label] of MATERIALS) {
    const button = doc.createElement("button");
    button.type = "button";
    button.dataset.material = id;
    button.textContent = label;
    button.addEventListener("click", () => setUiPreferences({ pomodoroGlassMaterial: id }));
    modes.append(button);
  }
  const sliders = doc.createElement("div");
  sliders.className = "pomodoro-glass-sliders";
  const controls = new Map();
  for (const [key, label, min, max, step] of PARAMETERS) {
    const row = doc.createElement("label");
    row.className = "pomodoro-glass-control";
    const caption = doc.createElement("span");
    caption.textContent = label;
    const output = doc.createElement("output");
    output.setAttribute("aria-label", `${label}当前值`);
    const input = doc.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.setAttribute("aria-label", label);
    input.addEventListener("input", () => setUiPreferences({ [key]: Number(input.value) }));
    row.append(caption, output, input);
    sliders.append(row);
    controls.set(key, { row, input, output });
  }
  panel.append(head, modes, sliders);
  card.after(panel);
  const glow = attachSelectionGlow(modes, { selector: 'button[aria-pressed="true"]' });

  function bounds() {
    return { x: Math.max(0, card.clientWidth - lens.offsetWidth - 16), y: Math.max(0, card.clientHeight - lens.offsetHeight - 16) };
  }
  function place(x, y) {
    const max = bounds();
    const left = 8 + Math.min(max.x, Math.max(0, x * max.x));
    const top = 8 + Math.min(max.y, Math.max(0, y * max.y));
    lens.style.left = `${left}px`;
    lens.style.top = `${top}px`;
    return { x: max.x ? (left - 8) / max.x : 0, y: max.y ? (top - 8) / max.y : 0 };
  }
  function sync(prefs) {
    for (const button of modes.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.material === prefs.pomodoroGlassMaterial));
    }
    glow.sync();
    for (const [key, { row, input, output }] of controls) {
      input.value = String(prefs[key]);
      output.textContent = String(prefs[key]);
      const enabled = key === "pomodoroGlassRadius" || prefs.pomodoroGlassMaterial === "glass"
        || (prefs.pomodoroGlassMaterial === "blur" && key === "pomodoroGlassScatter");
      input.disabled = !enabled;
      row.setAttribute("aria-disabled", String(!enabled));
    }
    lens.style.borderRadius = `${Math.min(prefs.pomodoroGlassRadius, lens.offsetHeight / 2)}px`;
    place(prefs.pomodoroGlassX, prefs.pomodoroGlassY);
  }

  let drag = null;
  grip.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const rect = card.getBoundingClientRect();
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY,
      left: lens.offsetLeft - 8, top: lens.offsetTop - 8,
      sx: rect.width / card.clientWidth, sy: rect.height / card.clientHeight };
    grip.setPointerCapture(event.pointerId);
    lens.classList.add("dragging");
  });
  grip.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const max = bounds();
    const x = Math.min(max.x, Math.max(0, drag.left + (event.clientX - drag.x) / drag.sx));
    const y = Math.min(max.y, Math.max(0, drag.top + (event.clientY - drag.y) / drag.sy));
    lens.style.left = `${8 + x}px`;
    lens.style.top = `${8 + y}px`;
    card.dispatchEvent(new Event("pomodoro:glass-moved"));
  });
  function stopDrag(event) {
    if (!drag || (event?.pointerId !== undefined && drag.id !== event.pointerId)) return;
    drag = null;
    lens.classList.remove("dragging");
    const max = bounds();
    setUiPreferences({ pomodoroGlassX: max.x ? (lens.offsetLeft - 8) / max.x : 0,
      pomodoroGlassY: max.y ? (lens.offsetTop - 8) / max.y : 0 });
  }
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) grip.addEventListener(type, stopDrag);
  grip.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 25 : 8;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    const max = bounds();
    const x = Math.min(max.x, Math.max(0, lens.offsetLeft - 8 + delta[0]));
    const y = Math.min(max.y, Math.max(0, lens.offsetTop - 8 + delta[1]));
    setUiPreferences({ pomodoroGlassX: max.x ? x / max.x : 0, pomodoroGlassY: max.y ? y / max.y : 0 });
  });
  reset.addEventListener("click", () => {
    const patch = {};
    for (const key of [...PARAMETERS.map(([name]) => name), "pomodoroGlassX", "pomodoroGlassY"]) patch[key] = DEFAULT_UI_PREFERENCES[key];
    setUiPreferences(patch);
  });

  return { lens, sync, place, dispose() { glow.dispose(); lens.remove(); panel.remove(); } };
}
