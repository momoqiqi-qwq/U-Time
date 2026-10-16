import { el } from "./ui.js";

let disclosureId = 0;

// 设置页会按 `settings.*` 状态变化整段重建（见 views/settings.js 的 S.subscribe：
// 失效 + 重挂当前分区）。折叠状态若只存在 DOM class 上，重建后会被打回初始值，
// 用户刚收起的说明会自己弹回来。所以按稳定 key（显式 id → title）记住上一次的开合。
const openState = new Map();

/**
 * 可展开 / 收起的说明折叠栏（铁律七：展开与收起都必须有动画）。
 *
 * 高度用 `grid-template-rows: 0fr → 1fr` 过渡 —— 它能连续插值到真实内容高度，
 * 不需要先量高度，收起时也保留中间帧；内层 `overflow: hidden` 负责裁切。
 * 收起状态给面板挂 `inert`：内部按钮既点不到也拿不到键盘焦点，但 DOM 留着，
 * 反向展开能立刻从当前状态接续，不会回到初始位置或叠加动画。
 * 快速连点由 CSS 过渡自身接续（目标状态就地改写），不排队、不残留临时样式。
 *
 * @param {object} opts
 * @param {string} opts.title       触发按钮上的标题
 * @param {Node}   opts.content     正文（折叠容器内，不能自带 padding）
 * @param {string} [opts.description] 按钮下方的常显摘要
 * @param {Node}   [opts.aside]     按钮右侧的状态徽标等
 * @param {boolean}[opts.open]      初始是否展开
 * @param {string} [opts.id]        折叠面板 id（不传则自动生成）
 */
export function createDisclosure({ title, content, description = "", aside = null, open = true, id } = {}) {
  const panelId = id || `disclosure-${++disclosureId}`;
  const panel = el("div", { class: "disclosure", id: panelId },
    el("div", { class: "disclosure-inner" }, content));
  const chevron = el("i", { class: "disclosure-chevron", "aria-hidden": "true" });
  const trigger = el("button", {
    class: "disclosure-trigger",
    type: "button",
    "data-motion": "off",
    "aria-controls": panelId,
  },
    el("span", { class: "disclosure-title" }, title),
    chevron,
  );
  const head = el("div", { class: "disclosure-head" }, trigger, aside);
  const node = el("div", { class: "disclosure-block" }, head, description ? el("p", { class: "disclosure-desc" }, description) : null, panel);

  const stateKey = id || title || panelId;
  let isOpen = false;
  let inertTimer = 0;
  // ⚠️ `inert` 会让 Chrome 不再渲染这棵子树（等价于跳过布局）：若它与类切换同一帧生效，
  // `1fr → 0fr` 的中间帧会直接塌成 0px —— 实测收起方向**一帧过渡都没有**（getAnimations 为空、
  // 每帧都读到 0px），展开方向却正常（inert 立刻解除）。所以：
  //   收起 → 等过渡走完（340ms > 320ms）再挂 inert；展开 → 立刻摘掉。
  // 过渡期间的不可点 / 不可聚焦由 `visibility: hidden`（延迟 320ms 生效）负责，与
  // 设置页既有的 .sync-disclosure 同一套语义；挂上 inert 后连 Tab 也进不去。
  function syncInert() {
    clearTimeout(inertTimer);
    if (isOpen) { panel.inert = false; return; }
    inertTimer = setTimeout(() => { if (!isOpen) panel.inert = true; }, 340);
  }
  function apply(value) {
    isOpen = Boolean(value);
    openState.set(stateKey, isOpen);
    panel.classList.toggle("is-open", isOpen);
    trigger.setAttribute("aria-expanded", String(isOpen));
    trigger.setAttribute("aria-label", `${isOpen ? "收起" : "展开"}${title ? `「${title}」` : "说明"}`);
    syncInert();
  }

  trigger.addEventListener("click", () => apply(!isOpen));
  // Escape 收起并把焦点送回触发按钮（选择器式控件与读屏用户都按这个约定）。
  node.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isOpen) return;
    if (event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    apply(false);
    trigger.focus({ preventScroll: true });
  });
  apply(openState.has(stateKey) ? openState.get(stateKey) : open);

  return { node, trigger, panel, isOpen: () => isOpen, setOpen: apply, toggle: () => apply(!isOpen) };
}
