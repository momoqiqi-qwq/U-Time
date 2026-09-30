// 应用内自动更新：检查 → 下载 → 交给系统安装。
//
// 三条通道，各管一段（Rust 侧见 src-tauri/src/update.rs）：
//   api.updateCheck()    GitHub Releases 的 latest 与本机版本比一次
//   api.updateDownload() 流式下载，边下边从 "update:progress" 事件回报进度
//   api.updateInstall()  Windows 静默重装并自启；Android 交给系统安装器
//
// 行为约定（都是刻意的，改之前先看这段）：
// - **启动检查是「静默」的**：失败不打扰用户（离线、GitHub 限流都当没事发生）。
//   只有「真的发现了可用新版」才弹提示条。手动检查才把错误显示出来。
// - **两个开关分工明确**（都在「设置 › 关于 › 软件更新」）：
//   `autoCheck` 管「启动要不要去查」，`notify` 管「查到新的要不要在左下角弹通知」。
//   两者独立 —— 关掉 `notify` 保留 `autoCheck`，更新仍会被查到并显示在关于页，只是不主动打扰。
// - **节流 6 小时**：`settings.update.lastCheckAt` 只在成功检查后写入。
//   失败不写 → 下次启动还能再试，但也不会疯狂重试（启动本身就不频繁）。
// - **「忽略此版本」按版本号记住**：`settings.update.skipVersion`。发了更新的版本号
//   之后它自然失效（只比对相等），不需要用户回来清理。
// - **「稍后」只活本次会话**：不落盘，重启还会再提示 —— 否则用户关了提示就再也看不到更新。
// - **左下角那张卡只认「值得打扰」的状态**：下载中 / 已下载完 / 失败 / 安装中，外加静默检查
//   发现的新版本。检查失败（离线、GitHub 限流）永远不打扰 —— 靠 `errorStage` 区分是哪一段
//   栽的，判据集中在 `noticeKind()`。
// - **下载完不等于装完**：Android 上返回成功只代表「系统安装界面已拉起」，
//   用户在系统界面点取消我们是收不到信号的，所以文案一律说「已交给系统安装」。
import { api } from "./api.js";
import * as S from "./store.js";
import { el, toast, appConfirm } from "./ui.js";
import { observeStack, refreshStack } from "./notifyStack.js";

/** 静默检查的最小间隔（6 小时）。 */
const CHECK_THROTTLE_MS = 6 * 60 * 60 * 1000;
/** 启动后延迟多久才去检查：让首屏渲染、插件加载先跑完，别抢带宽。 */
const STARTUP_DELAY_MS = 8000;
/** 本机上一次成功启动的应用版本；localStorage 会跨覆盖安装保留。 */
export const INSTALLED_VERSION_KEY = "letime-installed-version";
/** 点过「关闭并安装」后写入的目标版本，用于安装器重启后的精确确认。 */
export const PENDING_UPDATE_VERSION_KEY = "letime-pending-update-version";

function versionStorage() {
  try { return globalThis.localStorage || globalThis.window?.localStorage || null; } catch { return null; }
}

/**
 * 记录本次实际运行版本，并判断这是首次安装、升级成功，还是普通重复启动。
 * storage 参数可注入，既方便单测，也让禁用 DOM storage 的极端环境安全退化。
 */
export function recordInstalledVersion(currentVersion, storage = versionStorage()) {
  const current = String(currentVersion || "").trim();
  if (!storage || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(current)) return null;
  let previous = "";
  let pending = "";
  try {
    previous = String(storage.getItem(INSTALLED_VERSION_KEY) || "").trim();
    pending = String(storage.getItem(PENDING_UPDATE_VERSION_KEY) || "").trim();
    storage.setItem(INSTALLED_VERSION_KEY, current);
    storage.removeItem(PENDING_UPDATE_VERSION_KEY);
  } catch {
    return null;
  }
  if (previous === current) return null;
  if (pending === current || previous) return { kind: "updated", current, previous };
  return { kind: "installed", current, previous: "" };
}

/** 启动完成后的右下角安装结果回执。 */
export async function showInstalledVersionNotice() {
  if (!api.isTauri) return null;
  const info = await api.appInfo().catch(() => null);
  const result = recordInstalledVersion(info?.version);
  if (!result) return null;
  const message = result.kind === "updated"
    ? result.previous
      ? `U-Time 已成功更新：v${result.previous} → v${result.current}`
      : `U-Time 已成功更新至 v${result.current}`
    : `U-Time v${result.current} 已安装完成，欢迎使用`;
  toast(message, { ms: 8000, class: "install-success" });
  return result;
}

function rememberPendingUpdate(version) {
  const storage = versionStorage();
  const target = String(version || "").trim();
  if (!storage || !target) return;
  try { storage.setItem(PENDING_UPDATE_VERSION_KEY, target); } catch {}
}

function forgetPendingUpdate() {
  const storage = versionStorage();
  if (!storage) return;
  try { storage.removeItem(PENDING_UPDATE_VERSION_KEY); } catch {}
}

export const DEFAULT_UPDATE_SETTINGS = Object.freeze({
  /** 启动时是否去查一次（关掉后仍可在「关于 › 软件更新」手动检查）。 */
  autoCheck: true,
  /** 发现新版本时是否在左下角弹升级通知。关掉后只在「关于 › 软件更新」里显示状态。 */
  notify: true,
  skipVersion: "",
  lastCheckAt: 0,
});

export function getUpdateSettings() {
  const st = S.getState()?.settings;
  if (!st) return { ...DEFAULT_UPDATE_SETTINGS };
  // 与 settings 下其它子对象（autoBackup / taskReminder / ui）同一套约定：
  // 缺字段就地补默认值，不动 migrations.js —— 新增可选字段不需要数据迁移。
  st.update = { ...DEFAULT_UPDATE_SETTINGS, ...(st.update || {}) };
  // 两个开关都只认「显式 false」才算关：配置被外力写成字符串 / 数字时按开处理，
  // 宁可多提示一次，也不要让更新功能静默失效（那样用户永远发现不了新版）。
  st.update.autoCheck = st.update.autoCheck !== false;
  st.update.notify = st.update.notify !== false;
  st.update.skipVersion = typeof st.update.skipVersion === "string" ? st.update.skipVersion : "";
  st.update.lastCheckAt = Number.isFinite(Number(st.update.lastCheckAt)) ? Number(st.update.lastCheckAt) : 0;
  return st.update;
}

export function setUpdateSettings(patch) {
  const st = S.getState()?.settings;
  if (!st) return getUpdateSettings();
  st.update = { ...getUpdateSettings(), ...(patch || {}) };
  S.persistSoon();
  emit();
  return st.update;
}

/* ───────────────────────── 对外状态 ───────────────────────── */

// phase: idle | checking | uptodate | available | downloading | ready | installing | error
const state = {
  phase: "idle",
  info: null,
  progress: { received: 0, total: 0 },
  /** 下载速率（字节/秒）。Rust 侧只报 received/total，速率由前端按事件时间差算。 */
  speed: 0,
  error: "",
  /** 错误出自哪一段：check（网络/限流，静默）| download | install。决定要不要打扰用户。 */
  errorStage: "",
  message: "",
  /**
   * 本次会话里**最近一次成功检查**的时刻（ms）。失败不覆盖。
   *
   * 为什么要有这个：状态回显只写「已是最新版本（vX）」时，用户没法分辨这是刚查的
   * 还是几十分钟前查的 —— 而 GitHub 的 `releases/latest` 在发版瞬间会有一段时间
   * 仍返回上一个版本（release 从创建到发布之间是草稿，草稿不计入 latest）。
   * 于是「我明明刚发了新版，客户端却说已是最新」的误会重复发生。带上时刻，
   * 用户一眼就能看出这条结果是陈旧的，再点一次即可。
   */
  checkedAt: 0,
  /** Android 的安装授权探测结果；其它平台为 null。 */
  installReady: null,
  downloadedPath: "",
};

const subscribers = new Set();

function snapshot() {
  return { ...state, progress: { ...state.progress }, available: Boolean(state.info?.has_update) };
}

function emit() {
  const value = snapshot();
  // 左下角通知堆叠是状态的另一个消费者：每次状态变化都同步一次卡片。
  renderUpdateNotice();
  for (const fn of subscribers) {
    try { fn(value); } catch (error) { console.error("更新状态订阅回调出错", error); }
  }
}

function patchState(next) {
  Object.assign(state, next);
  emit();
}

export function getUpdateState() { return snapshot(); }

export function subscribeUpdateState(fn) {
  subscribers.add(fn);
  // 立刻先交一次当前状态。和 emit() 一样要 try/catch：订阅回调是调用方的代码，
  // 它在构建期抛错不该把 createXxx() → 设置页渲染整条链路带崩。
  try { fn(snapshot()); } catch (error) { console.error("更新状态订阅回调出错", error); }
  return () => subscribers.delete(fn);
}

export function isUpdaterSupported() {
  return Boolean(api.isTauri) && typeof api.updateCheck === "function";
}

/** 把时刻写成 `HH:MM`（不是今天则带上 `M-D`）—— 状态回显里标「这条结果是何时查的」。 */
export function formatCheckTime(ms) {
  const time = Number(ms);
  if (!Number.isFinite(time) || time <= 0) return "";
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return "";
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = new Date();
  return d.toDateString() === today.toDateString() ? hhmm : `${d.getMonth() + 1}-${d.getDate()} ${hhmm}`;
}

/**
 * 状态文案统一的时间戳拼接：`base · [前缀]HH:MM[ 后缀]`。
 *
 * 时刻为空（0 / 非法）时原样返回 base。所有「文案 + 检查时刻」的拼接必须走这里
 * （目前两处：`describeUpdateState` 的状态回显、设置页 idle 行的「上次自动检查」），
 * 避免各处手拼导致分隔符 / 文案顺序漂移。
 */
export function withCheckStamp(base, ms, { prefix = "", suffix = "检查" } = {}) {
  const at = formatCheckTime(ms);
  if (!at) return base;
  return `${base} · ${prefix}${at}${suffix ? ` ${suffix}` : ""}`;
}

/** 字节数 → 人话体积（1024 进制，MiB / KiB / B）。 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${Math.round(n)} B`;
}

/**
 * git 风格的下载进度行：`12% (16.42 MiB/150.68 MiB) | 1.08 MiB/s`。
 *
 * 两个退化写法都是刻意的：
 * - `total` 未知（release 没给 asset_size）时省掉百分比，只报已下体积 ——
 *   猜一个分母会让那条进度条从 30% 突然跳回 90%，比不报更糟。
 * - 速率还没采到第二个点时显示 `-- B/s` 而不是 `0 B/s`：0 读起来像「卡住了」，
 *   实际只是第一个采样点。
 */
export function formatDownloadMeter({ received = 0, total = 0, speed = 0 } = {}) {
  const sizePart = total > 0 ? `${formatBytes(received)}/${formatBytes(total)}` : formatBytes(received);
  const pct = total > 0 ? `${Math.min(100, Math.floor((received / total) * 100))}% ` : "";
  return `${pct}(${sizePart}) | ${speed > 0 ? `${formatBytes(speed)}/s` : "-- B/s"}`;
}

/**
 * 下载速率采样器：指数滑动平均。
 *
 * Rust 侧按总量切约 200 步长发事件，每个事件之间网络抖一下，瞬时速率就能差几倍，
 * 直接显示会让数字跳成筛子。取 α=0.35 的滑动平均：一次抖动压不住真实提速，
 * 但连续几个慢包能在两三秒内把读数拉下来。
 */
export function createSpeedMeter({ minIntervalMs = 200, alpha = 0.35 } = {}) {
  let lastAt = 0;
  let lastBytes = 0;
  let value = 0;
  return {
    reset() { lastAt = 0; lastBytes = 0; value = 0; },
    /** @returns 平滑后的字节/秒 */
    sample(received, at = Date.now()) {
      const bytes = Number(received) || 0;
      if (!lastAt) { lastAt = at; lastBytes = bytes; return value; }
      const dt = at - lastAt;
      if (dt < minIntervalMs) return value;
      const instant = (bytes - lastBytes) / (dt / 1000);
      if (Number.isFinite(instant) && instant >= 0) {
        value = value > 0 ? value * (1 - alpha) + instant * alpha : instant;
      }
      lastAt = at;
      lastBytes = bytes;
      return value;
    },
  };
}

const speedMeter = createSpeedMeter();

/** 人话版的当前状态（状态回显，设置页与提示条共用）。 */
export function describeUpdateState(value = snapshot()) {
  if (!isUpdaterSupported()) return "浏览器调试模式下不检查更新";
  switch (value.phase) {
    case "checking": return "正在检查…";
    case "uptodate":
      return withCheckStamp(`已是最新版本（v${value.info?.current || "?"}）`, value.checkedAt);
    case "available":
      return withCheckStamp(`发现新版本 v${value.info?.latest}，当前 v${value.info?.current}`, value.checkedAt);
    case "downloading":
      return `正在下载更新包 ${formatDownloadMeter({ ...value.progress, speed: value.speed })}`;
    case "ready": return value.message || "更新包已下载，可以安装了";
    case "installing": return "已交给系统安装，应用即将关闭";
    case "error": return value.error || "更新失败";
    default:
      // idle 时 checkedAt 恒为 0（会话内还没有成功检查过），withCheckStamp 原样返回 base，
      // 与旧逻辑「『尚未检查』不带时刻」等价；一旦回显「最近检查到 vX」则必带时刻。
      return withCheckStamp(
        value.info?.latest ? `最近检查到 v${value.info.latest}` : "尚未检查",
        value.checkedAt,
      );
  }
}

/* ───────────────────────── 检查 ───────────────────────── */

/**
 * 查一次最新版本。
 *
 * **不抛异常**：把结果写进状态并返回 `info`（失败时返回 `null`）。
 * 是否把错误显示给用户由调用方决定 —— 启动静默检查就该装作无事发生，
 * 手动检查才需要看到「网络不可用」。
 */
export async function checkForUpdates({ manual = false } = {}) {
  if (!isUpdaterSupported()) {
    if (manual) toast("浏览器调试模式下不支持应用内更新");
    return null;
  }
  if (state.phase === "checking" || state.phase === "downloading") return state.info;
  patchState({ phase: "checking", error: "", errorStage: "", message: "" });
  try {
    const info = await api.updateCheck();
    // 成功拿到结果才记时刻：失败不能盖掉上一次成功的时间（否则用户会以为刚查过）。
    const checkedAt = Date.now();
    if (!info?.has_update) {
      patchState({ phase: "uptodate", info, error: "", checkedAt });
      if (manual) toast(`已是最新版本 v${info?.current || "?"}`);
      return info;
    }
    if (!info.supported) {
      // 有新版但本平台没有可自动安装的产物：说清楚原因，别让「更新」按钮点了没反应。
      patchState({ phase: "available", info, message: info.message || "当前平台暂不支持应用内更新", checkedAt });
      if (manual) toast(info.message || "当前平台暂不支持应用内更新");
      return info;
    }
    patchState({ phase: "available", info, message: "", checkedAt });
    if (manual) toast(`发现新版本 v${info.latest}`);
    return info;
  } catch (error) {
    const message = String(error?.message || error || "检查更新失败");
    // 失败时保留旧的 checkedAt：面板上「上次成功检查于 HH:MM」是判断结果新鲜度的唯一线索。
    // errorStage 标成 check —— 左下角那张卡只认 download/install，检查失败继续静默。
    patchState({ phase: "error", error: message, errorStage: "check" });
    if (manual) toast(message);
    return null;
  }
}

/** 启动时的静默检查：节流 + 尊重开关 + 尊重「忽略此版本」。 */
export async function silentUpdateCheck() {
  if (!isUpdaterSupported()) return;
  const cfg = getUpdateSettings();
  if (!cfg.autoCheck) return;
  if (Date.now() - cfg.lastCheckAt < CHECK_THROTTLE_MS) return;

  const info = await checkForUpdates({ manual: false });
  if (!info) return;                       // 失败：静默，且不写 lastCheckAt，下次启动再试
  // 复用这次检查写入 state 的 checkedAt，而不是再取一次 Date.now()：
  // 「状态回显时间」与「节流记录时间」必须同源 —— 两次取时间会有毫秒级分叉，
  // 排查「上次自动检查」时间线时（比如对照 lastCheckAt 与面板显示的 HH:MM）就对不上了。
  setUpdateSettings({ lastCheckAt: state.checkedAt });
  if (!info.has_update || !info.supported) return;
  if (info.latest === getUpdateSettings().skipVersion) return;
  // 「有新版本时弹窗提示」关掉后：仍然照常检查、照常把状态写进 state（关于页看得到），
  // 只是不在左下角弹通知 —— 所以这一条必须放在最后，别提前 return 掉检查本身。
  if (!getUpdateSettings().notify) return;
  armVersionNotice(info);
}

/* ─────────────────── 左下角通知堆叠（更新） ─────────────────── */

let stackEl = null;
/**
 * 当前那张卡的种类："" | "version" | "live"。
 * 同种类只改文字、绝不重建节点 —— 重建会把入场动画重放一遍，
 * 而下载进度一秒要刷好几次，卡片就会一直「在跳」。
 */
let cardKind = "";
/** live 卡里随进度变化的节点引用（仅 cardKind === "live" 时有效）。 */
let liveRefs = null;
/** 「发现新版本」卡的内容；null = 不显示。 */
let versionNotice = null;
/** 本次会话是否已经主动关掉过版本提示（「稍后」/× 都算）。 */
let dismissedThisSession = false;
/** 用户收掉过下载结果卡（「稍后」）；下次真的开始下载时复位。 */
let liveDismissed = false;

/**
 * 当前该显示哪张卡："" 不显示 / "version" 新版本提示 / "live" 下载与安装。
 *
 * live 优先：一旦真的在下载，进度就是唯一要看的东西 —— 版本号已经写进进度卡标题，
 * 再留一张版本提示卡在后面，只是把它的「立即升级」按钮藏进堆叠里而已。
 */
function noticeKind() {
  const live = state.phase === "downloading" || state.phase === "ready" || state.phase === "installing"
    || (state.phase === "error" && (state.errorStage === "download" || state.errorStage === "install"));
  if (live) return liveDismissed ? "" : "live";
  return versionNoticeActive() ? "version" : "";
}

/**
 * 「发现新版本」卡现在该不该亮。
 *
 * 闸门放在渲染时而不是只放在点亮的那一刻：卡片是常驻的，中途用户点了「忽略此版本」、
 * 或把「弹窗提示」开关关掉，都得当场把已经亮着的那张收掉 —— 只在点亮时查一次的话，
 * 已忽略的版本会一直挂在左下角。
 */
function versionNoticeActive() {
  const info = versionNotice;
  if (!info) return false;
  const cfg = getUpdateSettings();
  return cfg.notify && cfg.skipVersion !== info.latest;
}

function ensureStack() {
  // 容器被外部摘掉（测试直接 remove 节点、热重载换了 body）时必须连「已经建过卡」这个
  // 印象一起清掉：否则下面 renderUpdateNotice 以为卡还在，往新容器里什么都不塞 ——
  // 屏幕上什么都看不到，而且不报任何错。
  if (stackEl && stackEl.parentNode !== document.body) {
    stackEl = null;
    cardKind = "";
    liveRefs = null;
  }
  if (!stackEl) {
    stackEl = el("div", { class: "update-toast notify-stack", role: "status", "aria-live": "polite" });
    document.body.append(stackEl);
    observeStack(stackEl);
  }
  return stackEl;
}

/** 把卡片同步到当前状态。由 emit() 挂在每次状态变化后面，所以必须幂等。 */
function renderUpdateNotice() {
  const kind = noticeKind();
  if (!kind) {
    stackEl?.remove();
    stackEl = null;
    cardKind = "";
    liveRefs = null;
    return;
  }
  const box = ensureStack();
  if (kind !== cardKind) {
    box.replaceChildren(kind === "version" ? buildVersionCard() : buildLiveCard());
    cardKind = kind;
  } else if (kind === "live") {
    paintLive();
  }
  refreshStack(box);
}

/** 点亮「发现新版本」卡。只有静默检查与「恢复提示」会调用 —— 手动检查走 toast 回执。 */
function armVersionNotice(info) {
  if (dismissedThisSession) return;
  versionNotice = info;
  renderUpdateNotice();
}

function buildVersionCard() {
  const info = versionNotice;
  const dismiss = () => {
    dismissedThisSession = true;
    versionNotice = null;
    renderUpdateNotice();
  };
  return el("div", { class: "update-toast-card" },
    el("div", { class: "update-toast-head" },
      el("b", {}, `发现新版本 v${info.latest}`),
      el("button", {
        class: "update-toast-x", type: "button", "aria-label": "关闭", title: "关闭（本次启动不再提示）",
        onclick: dismiss,
      }, "×"),
    ),
    el("p", { class: "update-toast-note" }, `当前版本 v${info.current}`),
    el("div", { class: "update-toast-actions" },
      el("button", {
        class: "btn pri sm", type: "button",
        onclick: () => { versionNotice = null; renderUpdateNotice(); jumpToUpdateSettings(); },
      }, "立即升级"),
      el("button", {
        class: "btn ghost sm", type: "button",
        title: `不再提示 v${info.latest}（设置 › 关于 里可恢复）`,
        onclick: () => {
          setUpdateSettings({ skipVersion: info.latest });
          dismiss();
          toast(`已忽略 v${info.latest}，可在「设置 › 关于 › 软件更新」恢复`);
        },
      }, "忽略此版本"),
      el("button", { class: "btn ghost sm", type: "button", onclick: dismiss }, "稍后"),
    ),
  );
}

/** 「稍后」：收掉结果卡。正在跑的那次下载不受影响（Rust 侧没有取消通道）。 */
function laterButton() {
  return el("button", {
    class: "btn ghost sm", type: "button",
    onclick: () => { liveDismissed = true; renderUpdateNotice(); },
  }, "稍后");
}

function liveActions(st) {
  if (st.phase === "ready") {
    const needPermission = st.installReady && st.installReady.ready === false;
    return [
      el("button", {
        class: "btn pri sm", type: "button",
        onclick: () => (needPermission ? openInstallPermission() : installUpdate()),
      }, needPermission ? "去开启安装权限" : "关闭并安装"),
      laterButton(),
    ];
  }
  if (st.phase === "error") {
    return [
      el("button", {
        class: "btn pri sm", type: "button",
        onclick: () => {
          liveDismissed = false;
          // 下载失败时 info 还在，直接续一次；只有没拿到产物时才重新查。
          if (st.errorStage === "download" && st.info?.asset_url) startUpdate();
          else checkForUpdates({ manual: true });
        },
      }, "重试"),
      laterButton(),
    ];
  }
  // downloading / installing 不给按钮：进度卡自己会走到头。中途能点的只有「稍后」，
  // 而收掉一张正在跑的进度卡只会让人以为下载被取消了。
  return [];
}

function buildLiveCard() {
  const refs = {
    spinner: el("span", { class: "ns-spinner", "aria-hidden": "true" }),
    title: el("b", { class: "update-live-title" }),
    meter: el("span", { class: "update-live-meter" }),
    note: el("p", { class: "update-toast-note", hidden: true }),
    actions: el("div", { class: "update-toast-actions" }),
  };
  liveRefs = refs;
  const card = el("div", { class: "update-toast-card update-live", "data-pin": "" },
    el("div", { class: "update-live-row" },
      refs.spinner,
      el("div", { class: "update-live-body" }, refs.title, refs.meter, refs.note),
    ),
    refs.actions,
  );
  paintLive();
  return card;
}

/** 只改文字与按钮，不动卡片结构（见 cardKind 那段注释）。 */
function paintLive() {
  const refs = liveRefs;
  if (!refs) return;
  const st = snapshot();
  const failed = st.phase === "error";
  const downloaded = st.progress.total || st.progress.received;
  refs.spinner.hidden = st.phase !== "downloading" && st.phase !== "installing";
  refs.note.hidden = !failed;
  refs.meter.hidden = failed;
  switch (st.phase) {
    case "downloading":
      refs.title.textContent = `正在下载更新包 v${st.info?.latest || "?"}…`;
      refs.meter.textContent = formatDownloadMeter({ ...st.progress, speed: st.speed });
      break;
    case "ready":
      refs.title.textContent = `更新包已下载完成（v${st.info?.latest || "?"}）`;
      refs.meter.textContent = formatBytes(downloaded);
      break;
    case "installing":
      refs.title.textContent = "已交给系统安装，应用即将关闭";
      refs.meter.textContent = formatBytes(downloaded);
      break;
    case "error":
      refs.title.textContent = st.errorStage === "install" ? "安装失败" : "下载失败";
      refs.note.textContent = st.error || "更新失败";
      break;
    default:
      refs.title.textContent = "正在处理更新…";
      refs.meter.textContent = "";
  }
  refs.actions.replaceChildren(...liveActions(st));
}

/** 「立即升级」不在这里直接下载，而是把用户带到「关于 › 软件更新」—— 那里有进度、说明与安装按钮。 */
function jumpToUpdateSettings() {
  window.dispatchEvent(new CustomEvent("tide:open-settings", { detail: { section: "about" } }));
}


/* ───────────────────────── 下载与安装 ───────────────────────── */

export async function startUpdate() {
  const info = state.info;
  if (!info?.asset_url) return false;
  if (!info.supported) { toast(info.message || "当前平台暂不支持应用内更新"); return false; }
  if (state.phase === "downloading") return false;

  // 每次下载从零开始算速率：上一次下载的平均值接到这一次头上会先跳一段假数字。
  speedMeter.reset();
  liveDismissed = false;
  patchState({
    phase: "downloading",
    progress: { received: 0, total: Number(info.asset_size) || 0 },
    speed: 0,
    error: "",
    errorStage: "",
    message: "",
  });
  try {
    const path = await api.updateDownload(
      info.asset_url,
      info.asset_name,
      Number(info.asset_size) || 0,
      info.asset_digest || "",
    );
    patchState({ phase: "ready", downloadedPath: path, message: "" });
    // Android 要单独问一次「授权开了没」：没开的话点「安装」只会看到安装界面一闪而过。
    if (typeof api.updateReady === "function") {
      const ready = await api.updateReady().catch(() => null);
      if (ready && ready.ready === false) {
        patchState({
          installReady: ready,
          message: ready.reason || "需要先允许安装未知来源应用",
        });
      } else {
        patchState({ installReady: ready });
      }
    }
    return true;
  } catch (error) {
    patchState({ phase: "error", errorStage: "download", error: String(error?.message || error || "下载失败") });
    return false;
  }
}

/** 跳到「安装未知来源应用」授权页（仅 Android 有意义）。 */
export async function openInstallPermission() {
  if (typeof api.updateOpenInstallSettings !== "function") return false;
  try {
    await api.updateOpenInstallSettings();
    patchState({ message: "已打开授权页面，开启「允许安装未知应用」后回来继续" });
    return true;
  } catch (error) {
    toast(String(error?.message || error || "打不开授权页面"));
    return false;
  }
}

/**
 * 真正开始安装。
 *
 * Windows 上 Rust 侧启动安装器后会立刻 `app.exit(0)` —— **这个 invoke 很可能等不到
 * resolve 就随进程一起没了**，属于预期行为，所以这里不把「没有返回值」当失败。
 */
export async function installUpdate() {
  if (state.phase !== "ready" || !state.downloadedPath) return false;
  if (state.installReady && state.installReady.ready === false) {
    return openInstallPermission();
  }
  const ok = await appConfirm(
    "关闭并安装更新",
    "应用会立即关闭，安装完成后自动重新打开。请先保存正在编辑的内容。",
    { confirmText: "关闭并安装", cancelText: "稍后" },
  );
  if (!ok) return false;
  patchState({ phase: "installing", error: "", errorStage: "" });
  rememberPendingUpdate(state.info?.latest);
  try {
    await api.updateInstall(state.downloadedPath);
    return true;
  } catch (error) {
    // 能走到这里说明应用还活着 —— 那是真失败（权限被拒 / 文件被清理）。
    forgetPendingUpdate();
    patchState({ phase: "error", errorStage: "install", error: String(error?.message || error || "安装失败") });
    return false;
  }
}

/** 忘记「忽略此版本」，让提示条重新出现。 */
export function clearSkippedVersion() {
  setUpdateSettings({ skipVersion: "" });
  // 「恢复提示」必须当场生效：`dismissedThisSession` 是「本次启动不再打扰」的闸门，
  // 用户主动要求恢复时还把它留着，按钮就得等到下次启动才起作用 —— 看起来像坏了。
  dismissedThisSession = false;
  // 但「有新版本时弹窗提示」是用户自己关的全局开关，恢复忽略不等于绕过它。
  if (getUpdateSettings().notify && state.info?.has_update && state.info.supported) armVersionNotice(state.info);
  toast("已恢复更新提示");
}

/* ───────────────────────── 启动挂载 ───────────────────────── */

let progressBound = false;

async function bindProgress() {
  if (progressBound || !api.isTauri) return;
  progressBound = true;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen("update:progress", (event) => {
      const payload = event.payload || {};
      // 只在下载阶段刷新，避免迟到的进度事件把「已下载完」的状态打回 downloading。
      if (state.phase !== "downloading") return;
      const received = Number(payload.received) || 0;
      patchState({
        progress: { received, total: Number(payload.total) || 0 },
        speed: Math.round(speedMeter.sample(received)),
      });
    });
  } catch (error) {
    console.warn("更新进度事件订阅失败（不影响下载，只是没有进度条）:", error);
  }
}

/**
 * 在 `boot()` 里调用一次。
 *
 * 刻意**延迟**且**不 await**：更新检查绝不能挡住首屏。
 */
export function initUpdateChecker() {
  if (!isUpdaterSupported()) return;
  getUpdateSettings();
  bindProgress();
  // 不等 8 秒的联网检查：这是本地版本比对，首屏出现后即可给出安装成功回执。
  showInstalledVersionNotice().catch(() => {});
  setTimeout(() => { silentUpdateCheck().catch(() => {}); }, STARTUP_DELAY_MS);
}
