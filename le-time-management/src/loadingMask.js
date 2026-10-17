// 启动 / 刷新蒙版（v0.232.0，用户需求「在刷新时，添加一个蒙版。蒙板上面有文字，文字形式，
// 参考左上角的标题，当刷新完成时，取消蒙板」）。
//
// 它盖住的是**整段首屏启动过程**：从 `boot()` 还没开始（HTML 首帧）一直到
// `revealAppWindow()` 把界面交出来为止 —— 也就是「刷新时」的完整窗口期。
// 蒙版上那句字就是左上角那颗字标本身（`U Time WorkSpace` + 哥特黑体渐变 + 下方装饰线），
// DOM 由 brandWordmark.js 给，样式由 styles.css 的 `.brand b` / `.brand-rule` 给，
// 这里**一个色值都不写死**，只负责：容器、居中、遮住界面、以及「刷新完成 → 取消蒙版」的收尾。
//
// 三个容易踩的点：
// ① **必须在首帧就在文档里**（index.html 里那颗 `[data-refresh-mask]` 空壳 + 同步挂载）：
//    等模块加载完再 createElement 的话，弱机上会先闪一下半成品界面。
// ② **字色用的是渐变裁剪**（`background-clip: text`），所以蒙版底色不能随便挑 ——
//    那两套四档渐变是按「浅色侧栏 / Nephele 淡紫毛玻璃 / 深色侧栏」三种底色实算过对比度的
//    （scripts/test-brand-wordmark.mjs）。这里统一走 `--bg`，它是主题自己的页面底色，
//    与侧栏同色系，不会让字标糊在背景上。
// ③ **收尾是「先亮界面、后撤蒙版」**：只摘 `data-app-starting` 会让蒙版立刻消失（无过渡），
//    所以先加 `.leaving` 起淡出，等过渡结束再摘节点；减少动效时同步摘掉，不留空窗。

import { brandMark } from "./brandWordmark.js";

/** 淡出时长，与 CSS 里 `.refresh-mask` 的 `transition` 保持一致（改一处要改两处）。 */
const FADE_MS = 220;
/** 「已经可以显示」的状态类：两帧 rAF 后加上，由 CSS 把它从 opacity:0 淡入到 1。 */
const READY_CLASS = "ready";

const MASK_SELECTOR = "[data-refresh-mask]";

let maskNode = null;
let finishTimer = 0;

function prefersReduced() {
  // 只读系统偏好：应用内的「减少动效」设置此刻还没初始化（uiPreferences 在 boot() 里才跑），
  // 而这块蒙版出现在那之前。设置生效后真正需要尊重它的地方是收尾动画 —— 见 finish()。
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
  }
}

/**
 * 挂上启动蒙版（只铺底色，先不放字）。在 `boot()` 之前**同步**调用一次，重复调用无副作用。
 *
 * 为什么字不在这里放：字标是**渐变裁剪文字**，那两套四档渐变按 `data-theme-mode` 二选一
 * （浅色一套 / 深色一套）。而 `data-theme-mode` 要等 `initTheme()` 才写上去 ——
 * 蒙版却出现在那之前。先铺底色、等主题解析完再 `revealRefreshMask()` 放字，
 * 深色用户就不会看到「先亮色字标、再跳成深色」那一跳。
 * @returns {HTMLElement|null}
 */
export function mountRefreshMask() {
  if (maskNode && maskNode.isConnected) return maskNode;
  const host = document.querySelector(MASK_SELECTOR);
  if (!host) return null;
  // 纯装饰：不要让读屏念它。指针事件由 CSS 一直关着（`pointer-events: none`），
  // 蒙版只负责看，不拦任何点击。
  host.setAttribute("aria-hidden", "true");
  host.removeAttribute("hidden"); // 与 CSS 的 `[hidden]` 那两条配合：摘掉才进不透明态
  maskNode = host;
  return host;
}

/**
 * 把字标放进蒙版并淡入。在 `initTheme()` 之后调（主题色已就位）。重复调用无副作用。
 * @returns {HTMLElement|null}
 */
export function revealRefreshMask() {
  const host = maskNode && maskNode.isConnected ? maskNode : document.querySelector(MASK_SELECTOR);
  if (!host) return null;
  if (!host.querySelector(".brand")) {
    const brand = document.createElement("div");
    brand.className = "brand";
    brand.append(...brandMark("refreshMaskBrandRuleGrad"));
    host.replaceChildren(brand);
  }
  // 首帧透明 → 下一帧淡入；减少动效时直接落到不透明。
  if (prefersReduced()) host.classList.add(READY_CLASS);
  else requestAnimationFrame(() => {
    requestAnimationFrame(() => host.classList.add(READY_CLASS));
  });
  return host;
}

/** 刷新完成 → 取消蒙版。幂等；必须在 `revealAppWindow()` 摘掉 `data-app-starting` 之后调。 */
export function finishRefreshMask() {
  const host = maskNode && maskNode.isConnected ? maskNode : document.querySelector(MASK_SELECTOR);
  if (!host) return;
  maskNode = null;
  // ⚠️ 这里**不能**用 `hidden` 收尾：`[hidden]` 是 display:none，会把淡出直接掐断。
  // 真正的「取消」是下面这两步 —— 起淡出，过渡结束再摘节点。
  host.setAttribute("aria-hidden", "true");

  const drop = () => host.remove();
  // 应用内设置已就绪，这里读的就是用户真正选的那个（system 偏好只在没设过时兜底）。
  let reduced = prefersReduced();
  try {
    const setting = document.documentElement.dataset.uiMotion;
    if (setting === "reduced") reduced = true;
    else if (setting === "full") reduced = false;
  } catch { /* 读不到就按系统偏好 */ }
  if (reduced) { drop(); return; }

  host.classList.add("leaving");
  window.clearTimeout(finishTimer);
  finishTimer = window.setTimeout(drop, FADE_MS + 60);
}
