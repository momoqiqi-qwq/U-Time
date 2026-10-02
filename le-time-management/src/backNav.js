// 返回键（Android）与浏览器后退：本应用是单页 + 浮层，没有真实页面导航，
// 所以要自己维护历史栈，否则 WebView 的 canGoBack() 永远是 false。
//
// 背景（查实 tauri 2.11.5 的 android-codegen）：TauriActivity 把 wry 的
// handleBackNavigation 固定成 false，而 wry 默认是 true；打开它之后 wry 的策略是
// 「WebView 能回退就 goBack()，不能回退才 finish 掉 Activity」。所以只要保证该回退时
// 能回退，返回键就会先回退、最后才退出应用（MainActivity.kt 里已打开这个开关）。
//
// 历史栈里只有两种格子：
//   · 视图格 `{ ltmView }`              —— 真正切界面时压一格，返回 = 回到上一个界面；
//   · 浮层格 `{ ltmGuard, ltmView }`    —— 浮层打开时压一格，返回 = 关掉最上面那层浮层。
//
// 为什么浮层要用「看 DOM」的办法：浮层（设置弹窗 / 抽屉 / 命令面板 / 快速捕获 / 询问框 /
// AI 规则编辑器）分散在八个模块里各自实现，逐个改去压历史等于以后新增的还会漏。
// 这里只用一个 MutationObserver 盯 document.body，出现 / 消失遮罩就重新对账：
// 浮层开着却没有浮层格 → 补一格；浮层都没了却还剩浮层格 → history.back() 把它退掉。
// 于是浮层无论是被返回键关的、被自己的按钮关的、还是被别的代码 remove() 掉的，
// 历史位置都会自动回到正确的地方，不会留下「按一下没反应」的空格子。
//
// 不变量：**只要还有浮层开着，栈顶就有且只有一格浮层格。**
// 首页且什么都没有时栈里只剩最初那一格，canGoBack() 为 false，返回键直接退出应用
// —— 这正是 Android 的预期，不会出现「先按一下没反应，第二下才退」。
//
// 维护提醒：`OVERLAY_SELECTOR` 是本文件唯一需要跟着浮层一起维护的清单。新增浮层优先
// 直接复用 `.drawer-mask`（那样零改动）；历史上用了自己类名的（命令面板 `.cmd-mask`、
// 另一处捕获浮层 `.cap-mask`）已一并收进来。

const OVERLAY_SELECTOR = ".drawer-mask, .cmd-mask, .cap-mask";
const CLOSING_CLASS = "motion-closing";   // 与 motion.js 的 closeLayer / removeWithMotion 保持一致

let enabled = false;
let readView = () => "";
let applyView = () => {};
let replaying = false;    // 正在按历史还原：期间不要补格子，否则会自己套自己
let reclaiming = false;   // 这次 popstate 是自己发起的 reclaim，不能当成用户按了返回
let lastView = "";        // 当前历史位置代表的视图，用来吞掉「点同一个导航项」的重复压栈
// 我们自己压了几格。>0 就说明「按一下返回有东西可回」——
// 顶栏那颗返回按钮据此显示（见 shell.js）。WebView 里拿不到历史长度，只能自己记。
let depth = 0;

const historyOf = () => (typeof window !== "undefined" ? window.history : globalThis.history);
const docOf = () => (typeof document !== "undefined" ? document : null);

function pushState(state) {
  try { historyOf().pushState(state, ""); depth++; } catch { /* 取不到历史就退化成没有回退 */ }
}

/** 还在屏幕上的浮层遮罩（已经进入关闭动画的不算，否则会连点两次同一层）。 */
function openOverlays() {
  const doc = docOf();
  if (!doc?.querySelectorAll) return [];
  return [...doc.querySelectorAll(OVERLAY_SELECTOR)]
    .filter((mask) => mask.isConnected && !mask.classList.contains(CLOSING_CLASS));
}

/**
 * 关掉最上层浮层，成功返回 true。
 * 三条路径按覆盖广度排序，不挑具体的弹窗类名 —— 以后新加的浮层只要沿用
 * 「遮罩 + 点遮罩关闭」的约定就自动生效（没沿用的话把类名加进 OVERLAY_SELECTOR）。
 */
function closeTopOverlay() {
  const mask = openOverlays().pop();
  if (!mask) return false;
  // 设置子页面先返回分类目录，再次返回才关闭设置。更上层弹窗仍优先关闭。
  if (mask.nextElementSibling?._back?.()) return true;
  const gutted = () => !mask.isConnected || mask.classList.contains(CLOSING_CLASS);

  // ① 遮罩点击即关闭：抽屉 / 设置弹窗 / 快速捕获 / 命令面板 / 询问框 / 规则编辑器都这么绑
  mask.click();
  if (gutted()) return true;

  // ② 面板自己挂了 _close（抽屉与设置弹窗同时提供这条路，作为 ① 的兜底）
  const panel = mask.nextElementSibling;
  if (typeof panel?._close === "function") {
    panel._close();
    if (gutted()) return true;
  }

  // ③ 最后兜底：这一层里带「关闭 / 取消 / 收起 / ×」字样的按钮
  //    （与 motion.js 的 isCloseControl 同一套判据）。只在本层内找，不会误伤底下的界面。
  const closer = [...mask.querySelectorAll("button, [role='button']")].find((btn) => {
    const label = [btn.getAttribute("aria-label"), btn.title, btn.textContent].filter(Boolean).join(" ").trim();
    return /(?:关闭|取消|收起|×|✕)/.test(label);
  });
  if (closer) { closer.click(); return true; }
  return false;
}

/** 按 DOM 现状对账历史栈：该补浮层格就补，该退掉多余的就退。 */
function syncGuard() {
  if (!enabled || replaying || reclaiming) return;
  const guarded = historyOf()?.state?.ltmGuard === true;
  const open = openOverlays().length > 0;
  if (open && !guarded) {
    pushState({ ltmGuard: true, ltmView: readView() });
  } else if (!open && guarded) {
    reclaiming = true;
    try { historyOf().back(); } catch { reclaiming = false; }
  }
}

function onPopState(event) {
  // 无论这一格是什么，popstate 都消耗掉一格。先记账再分支：
  // 分支里会 applyView → switchTo → commit → 刷新返回按钮，那时必须已经减过了。
  depth = Math.max(0, depth - 1);

  // 自己发起的 reclaim：这一格本来就是多余的，退掉就算完事，不关浮层也不切视图。
  if (reclaiming) { reclaiming = false; return; }

  // 有浮层先关浮层 —— 用户刚退掉的那一格正是浮层打开时压的那一格。
  if (closeTopOverlay()) { syncGuard(); return; }

  const target = event?.state && typeof event.state.ltmView === "string" ? event.state.ltmView : "";
  if (!target || target === readView()) return;
  replaying = true;
  try { applyView(target); } finally { replaying = false; lastView = target; }
}

/** 这批 DOM 变更里有没有出现 / 消失遮罩元素（含作为子树被加入或移除的情况）。 */
function touchesOverlay(records, key) {
  for (const record of records) {
    for (const node of record[key] || []) {
      if (typeof node?.matches !== "function") continue;   // 文本节点等
      if (node.matches(OVERLAY_SELECTOR) || node.querySelector?.(OVERLAY_SELECTOR)) return true;
    }
  }
  return false;
}

/**
 * 挂上返回键 / 后退的历史栈。必须在首屏视图定下来之后调用一次。
 * @param {{readView: () => string, applyView: (id: string) => void}} options
 * @returns {() => void} 卸载函数（测试与热重载用）
 */
export function initBackNav({ readView: read, applyView: apply }) {
  readView = read;
  applyView = apply;
  // 最初那一格也要带视图，否则第一次后退拿不到目标视图名（只能靠 applyView 兜底）。
  try { historyOf().replaceState({ ...(historyOf().state || {}), ltmView: readView() }, ""); } catch { /* 忽略 */ }

  let queued = false;
  const observer = typeof MutationObserver === "function"
    ? new MutationObserver((records) => {
      if (queued) return;
      if (!touchesOverlay(records, "addedNodes") && !touchesOverlay(records, "removedNodes")) return;
      queued = true;
      // 一次操作可能连续增删多个节点，等这一轮 DOM 稳定下来再对账。
      queueMicrotask(() => { queued = false; syncGuard(); });
    })
    : null;
  observer?.observe(docOf()?.body || docOf()?.documentElement, { childList: true, subtree: true });

  window.addEventListener("popstate", onPopState);
  enabled = true;
  depth = 0;              // 重新挂载（热重载 / 测试）时把记账归零
  lastView = readView();
  // 挂载时可能已经有浮层开着（例如首屏弹出的引导），补一次对账。
  syncGuard();

  return () => {
    observer?.disconnect();
    window.removeEventListener("popstate", onPopState);
    enabled = false;
  };
}

/**
 * 应用内是否还有可回退的一格（浮层格或视图格）。
 * 顶栏返回按钮据此显示 —— 首页且无浮层时返回 false，按钮就不该出现
 * （那种情况下返回等于退出应用，不该给按钮）。
 */
export function canGoBack() { return enabled && depth > 0; }

/**
 * 等价于按一次 Android 返回键：先关最上层浮层，没有浮层才回上一个视图。
 * 刻意复用 history.back() 而不是自己实现一套 —— 浮层与视图的优先级、
 * 「程序性重渲染不压栈」这些规则全在 onPopState 里，走同一条路才不会两边不一致。
 * @returns {boolean} 是否真的发起了回退（false = 没地方可回，调用方可以忽略）
 */
export function goBack() {
  if (!canGoBack()) return false;
  try { historyOf().back(); } catch { return false; }
  return true;
}

/**
 * 视图真正切换后调用（由 shell 的 switchTo 触发）。
 * 同一视图的重复切换不压栈 —— 否则点一下当前导航项就会多出一格，
 * 返回键按下去看着「没反应」（退到的是同一个界面）。
 */
export function noteViewChange(view) {
  if (!enabled || replaying || !view) return;
  if (view === lastView) return;
  const hist = historyOf();
  if (hist?.state?.ltmGuard === true) {
    // 浮层开着时切视图（插件注册表变化等）：栈顶这格是浮层格，把它的视图名改成新视图。
    // 既不额外压一格（返回键会要多按），也不会让以后退到这一格时跳回旧界面。
    try { hist.replaceState({ ...hist.state, ltmView: view }, ""); } catch { /* 忽略 */ }
    lastView = view;
    return;
  }
  lastView = view;
  pushState({ ltmView: view });
}
