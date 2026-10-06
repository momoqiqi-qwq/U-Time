import { el } from "../../ui.js";
import { reducedMotion } from "../../motion.js";

// 分类图标：复用打包内 Font Awesome solid（与快捷 dock 同款根路径）。
// 本地小助手而不是从 shell.js 引入，避免设置视图反向依赖外壳造成循环 import。
function faIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "fa-ic");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `/icons/fontawesome/solid.svg#${name}`);
  svg.append(use);
  return svg;
}

// 窄屏断点与 styles.css 的 ≤980px 设置页规则保持一致。
const NARROW_QUERY = "(max-width: 980px)";

export function createSettingsNavigator(entries, state = {}, { pages = false, tabs = false, onPageChange = () => {} } = {}) {
  const search = el("input", {
    class: "settings-search",
    type: "search",
    value: state.query || "",
    placeholder: "搜索设置，例如：背景、快捷键、WebDAV、提醒…",
    "aria-label": "搜索设置",
  });
  const result = el("span", { class: "settings-result" });
  const list = el("div", { class: "settings-catalog", role: "tablist", "aria-label": "设置分类" });
  const empty = el("div", { class: "settings-empty", hidden: true }, "没有找到匹配的设置项");

  const buttons = new Map();
  let active = state.active || entries[0]?.id || "";
  let visibleIds = new Set(entries.map((entry) => entry.id));

  /* ── 窄屏（Android / 手机）：横向分类行 → 手风琴 ──
     手机上 11 个分类要横向滑才看得全，而且一次只显示一块内容，「下面还有什么」完全看不见。
     所以窄屏改成手风琴：每个分区一个带头图、名称与方向箭头的标题行，点标题就地展开/收起，
     全部分区都在同一页里纵向排列。桌面仍是「左侧分类 + 右侧单页」，只是多出来的这些
     标题行在 CSS 里被隐藏（见 .settings-acc-head 的 display:none 规则）。 */
  const narrow = window.matchMedia ? window.matchMedia(NARROW_QUERY) : { matches: false };
  /* 窄屏下哪些分区是展开的（搜索时会整体替换）。
     初始为空集 = 一进设置页先给一张分类目录，谁都不预展开（v0.49.1）。
     展开状态写回 state 跨重渲染保留 —— 否则在设置里改一项就整页重建，刚展开的面板会当场塌掉。 */
  let expanded = new Set(Array.isArray(state.expanded) ? state.expanded : []);
  const syncExpanded = () => { state.expanded = [...expanded]; };
  const heads = new Map();             // entry.id -> { wrap, head, body }

  const panels = entries.map((entry) => {
    /* 分区末尾的「收起」：展开后的分区比一屏长得多（「主题」有十几张色板卡），
       只能滚回顶部点标题行才收得掉，手机上够不着，就在内容末尾给一个就地入口。
       桌面不显示（.settings-acc-collapse 基础规则 display:none）。 */
    const collapseBtn = el("button", {
      class: "settings-acc-collapse",
      type: "button",
      "aria-label": `收起「${entry.label || entry.id}」`,
      onclick: () => collapseSection(entry.id),
    },
      el("span", { class: "settings-acc-collapse-ico", "aria-hidden": "true" }),
      "收起",
    );
    const body = el("div", { class: "settings-acc-body" }, entry.node, collapseBtn);
    const head = el("button", {
      class: "settings-acc-head",
      type: "button",
      "aria-expanded": "false",
      onclick: () => pages ? select(entry.id) : toggleSection(entry.id),
    },
      el("span", { class: "settings-acc-ico", "aria-hidden": "true" }, faIcon(entry.icon || "gear")),
      el("span", { class: "settings-acc-copy" },
        el("b", {}, entry.label || entry.id),
        entry.hint ? el("small", {}, entry.hint) : null,
      ),
      el("span", { class: "settings-acc-arrow", "aria-hidden": "true" }),
    );
    const wrap = el("section", { class: "settings-acc" }, head, body);
    heads.set(entry.id, { wrap, head, body });
    return wrap;
  });

  /** 窄屏点标题行：展开 / 收起；桌面标题行不可见，兜底当作「切到该分类」。 */
  function toggleSection(id) {
    if (!narrow.matches) { select(id); return; }
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    syncExpanded();
    paintPage({ animate: expanded.has(id) });
  }

  /** 分区末尾的「收起」：收掉内容后把标题行滚回视口顶部。
      不滚的话，下面那块内容一抽走，滚动条位置会让视线停在别的分区中间。 */
  function collapseSection(id) {
    toggleSection(id);
    heads.get(id)?.wrap?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }

  const paintPage = ({ animate = false } = {}) => {
    if (tabs && reducedMotion()) animate = false;
    const isNarrow = !!narrow.matches;
    if (pages) {
      node.hidden = !tabs && Boolean(state.page);
      onPageChange(tabs ? null : entries.find((entry) => entry.id === state.page) || null);
    }
    for (const entry of entries) {
      const view = heads.get(entry.id);
      if (!view) continue;
      const visible = visibleIds.has(entry.id);
      const isActive = entry.id === active && visible;
      entry.node.classList.toggle("settings-section-active", isActive);
      // 窄屏：全部分区都在页面上，收放只看 expanded；桌面：只显示当前分类
      const open = tabs ? isActive : pages ? entry.id === state.page : isNarrow ? visible && expanded.has(entry.id) : isActive;
      if (open) entry.ensure?.();
      view.wrap.hidden = tabs ? !isActive : pages ? (state.page ? !open : !visible) : isNarrow ? !visible : !isActive;
      if (pages) {
        view.head.hidden = open;
        view.head.removeAttribute("aria-expanded");
      }
      view.body.hidden = !open;
      view.wrap.classList.toggle("settings-acc-open", open);
      if (!pages) view.head.setAttribute("aria-expanded", String(open));
      if (animate && open && isNarrow && typeof view.body.animate === "function") {
        view.body.animate([{ opacity: .35 }, { opacity: 1 }], { duration: 160, easing: "cubic-bezier(.22,.8,.22,1)" });
      }
      if (animate && !isNarrow && isActive && typeof entry.node.animate === "function") {
        entry.node.animate([
          { opacity: .45, transform: "translateX(8px)" },
          { opacity: 1, transform: "translateX(0)" },
        ], { duration: 180, easing: "cubic-bezier(.22,.8,.22,1)" });
      }
    }
  };

  const paintActive = () => {
    for (const [id, btn] of buttons) {
      const on = id === active;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-selected", String(on));
      btn.tabIndex = on ? 0 : -1;
      if (tabs && on && !btn.hidden) btn.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "auto" });
    }
  };

  const select = (id, { animate = true } = {}) => {
    const entry = entries.find((item) => item.id === id);
    if (!entry || !visibleIds.has(id)) return;
    active = id;
    state.active = id;
    const wasExpanded = expanded.has(id);
    if (pages) {
      if (!state.page) state.catalogScroll = node.closest(".settings-modal-body")?.scrollTop || 0;
      state.page = id;
    }
    if (narrow.matches) { expanded.add(id); syncExpanded(); }
    paintActive();
    paintPage({ animate });
    // 窄屏下选中一个还是收着的分区时，把它滚到视口顶部 —— 否则点了分类名字还得自己往下翻找，
    // 看起来像「点了没反应」。已经展开过的不再滚，避免用户手动收起来后被反复拽回去。
    if (pages) {
      const scroller = node.closest(".settings-modal-body");
      if (scroller) scroller.scrollTop = 0;
    } else if (!tabs && narrow.matches && !wasExpanded) {
      const view = heads.get(id);
      requestAnimationFrame(() => view?.wrap?.scrollIntoView?.({ block: "start", behavior: animate ? "smooth" : "auto" }));
    }
  };

  const paintButtons = () => {
    list.replaceChildren();
    buttons.clear();
    for (const entry of entries) {
      const btn = el("button", {
        class: `settings-nav-item${active === entry.id ? " on" : ""}`,
        type: "button",
        role: "tab",
        "aria-controls": `settings-${entry.id}`,
        "aria-selected": String(active === entry.id),
        onclick: () => select(entry.id),
        onkeydown: (event) => {
          if (!tabs || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const ids = [...visibleIds];
          const at = ids.indexOf(entry.id);
          const next = event.key === "Home" ? ids[0] : event.key === "End" ? ids.at(-1) : ids[(at + (event.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length];
          event.preventDefault();
          select(next);
          buttons.get(next)?.focus({ preventScroll: true });
        },
      },
        el("span", { class: "settings-nav-ico", "aria-hidden": "true" }, faIcon(entry.icon || "gear")),
        el("span", { class: "settings-nav-item-copy" },
          el("b", {}, entry.label || entry.id),
          entry.hint ? el("small", {}, entry.hint) : null,
        ),
        el("span", { class: "settings-nav-chevron", "aria-hidden": "true" }, "›"),
      );
      buttons.set(entry.id, btn);
      list.append(btn);
    }
  };

  let expandedBeforeSearch = null;

  const apply = () => {
    const q = search.value.trim().toLowerCase();
    state.query = search.value;
    visibleIds = new Set();
    let firstVisible = null;
    for (const entry of entries) {
      const haystack = `${entry.label || ""} ${entry.keywords || ""} ${entry.node.textContent || ""}`.toLowerCase();
      if (q && entry.ensure) entry.ensure().then(() => {
        // 搜索仍覆盖设置项正文；懒加载完成后用同一次查询更新结果。
        if (search.value.trim().toLowerCase() === q) paintSearchResults();
      });
      const searchOk = !q || haystack.includes(q);
      const btn = buttons.get(entry.id);
      if (btn) btn.hidden = !searchOk;
      if (searchOk) {
        visibleIds.add(entry.id);
        if (!firstVisible) firstVisible = entry.id;
      }
    }
    if (!visibleIds.has(active)) active = firstVisible || "";
    state.active = active;
    // 窄屏搜索：命中的分区直接展开（否则搜到的东西全在收起状态，等于没搜）；
    // 清空搜索词时把搜索前的展开状态还回去，别把 11 个分区全留成展开。
    if (narrow.matches && !pages) {
      if (q) {
        if (!expandedBeforeSearch) expandedBeforeSearch = new Set(expanded);
        expanded.clear();
        for (const id of visibleIds) expanded.add(id);
      } else if (expandedBeforeSearch) {
        expanded = new Set(expandedBeforeSearch);
        expandedBeforeSearch = null;
      }
      syncExpanded();
    }
    paintActive();
    paintPage({ animate: false });
    result.textContent = `显示 ${visibleIds.size} / ${entries.length}`;
    empty.hidden = visibleIds.size > 0;
    list.hidden = visibleIds.size === 0;
  };

  /* 断点变化（手机横竖屏切换、桌面窗口拉窄）时重算一次布局。
     v0.49.1：这里不再自动展开当前分类，初始化时也不再预展开 —— 窄屏（手机 / APK）
     进入设置页先给一张分类目录，11 个分区全部收起，展开与否完全交给用户点标题行。
     原先「进窄屏就展开当前分类」是为了避免「点了设置像打开的是一张目录」，
     但用户要的正是这张目录：一进来就被摊开的「界面与交互」占掉整屏，反而看不见别的分类。
     注意：外部点名跳转（select(id)，如更新提示条的「立即更新」）仍会展开目标分区，
     那属于用户明确指定，不算「一进来就展开」。 */
  const onModeChange = () => paintPage({ animate: false });
  narrow.addEventListener?.("change", onModeChange);

  search.addEventListener("input", apply);
  paintButtons();

  const node = el("aside", { class: "settings-sidebar" },
    el("div", { class: "settings-nav-card" },
      el("div", { class: "settings-sidebar-head" },
        el("b", {}, "设置分类"),
        result,
      ),
      search,
      list,
      empty,
    ),
  );

  function back() {
    if (tabs || !pages || !state.page) return false;
    const previous = state.page;
    state.page = "";
    paintPage();
    const scroller = node.closest(".settings-modal-body");
    if (scroller) scroller.scrollTop = state.catalogScroll || 0;
    heads.get(previous)?.head.focus({ preventScroll: true });
    return true;
  }
  function paintSearchResults() {
    if (disposed) return;
    const q = search.value.trim().toLowerCase();
    visibleIds = new Set(entries.filter(entry => `${entry.label || ""} ${entry.keywords || ""} ${entry.node.textContent || ""}`.toLowerCase().includes(q)).map(entry => entry.id));
    for (const [id, button] of buttons) button.hidden = !visibleIds.has(id);
    if (!visibleIds.has(active)) active = visibleIds.values().next().value || "";
    state.active = active;
    if (narrow.matches && !pages && q) {
      expanded = new Set(visibleIds); syncExpanded();
    }
    result.textContent = `显示 ${visibleIds.size} / ${entries.length}`;
    empty.hidden = visibleIds.size > 0; list.hidden = visibleIds.size === 0;
    paintActive(); paintPage();
  }
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; narrow.removeEventListener?.("change", onModeChange); };
  node._back = back;
  function setTabs(value) {
    if (disposed || tabs === Boolean(value)) return;
    tabs = Boolean(value);
    if (!tabs && pages && state.page) state.page = active;
    paintActive();
    paintPage();
  }
  return { node, apply, select, panels, dispose, setTabs };
}
