import { readProductSource } from "./lib/read-product-source.mjs";
/*
 * 应用内自动更新（v0.38.0）回归测试 —— 前端状态机 + 命令桥契约。
 *
 * 做法：**不用静态断言猜行为**，而是给一个只实现所需 API 的迷你 DOM，
 * 再把 `window.__TAURI_INTERNALS__.invoke` 换成可编程的打桩，然后真 import
 * `src/updateChecker.js` 跑一遍：
 *
 *   ① 设置项归一化：autoCheck 只认 `!== false`、skipVersion 必须是字符串、
 *      lastCheckAt 必须是有限数（配置被外力改坏也不能把更新功能搞瘫）。
 *   ② 检查结果四态：有新版本 / 已最新 / 有新版但本平台没产物 / 请求失败。
 *   ③ 启动静默检查的三道闸门：开关关掉、6 小时节流、失败不写 lastCheckAt。
 *   ④ 「忽略此版本」按版本号落盘，并且提示条真的会消失。
 *   ⑤ 命令桥契约：前端发的参数名必须和 Rust 侧 `update_download(url,name,size)`
 *      对得上（Tauri 只做 camelCase 透传，名字错了只会在运行时静默变成缺参）。
 *   ⑥ Android 安装前先探「未知来源授权」：没授权时按钮要走授权页，而不是硬装。
 *   ⑦ 接线：更新面板嵌在「设置 › 关于」里（不是独立分区），提示条跳转目标 = section:"about"。
 *   ⑧ notify 开关只管「弹不弹」：关掉后仍照常检查、状态照常更新，只是不弹左下角通知
 *      （带对照组，避免被别的闸门替它挡枪而假通过）。
 *   ⑨ 「恢复已忽略的版本」不绕过 notify。
 *
 * 为什么值得写：这几条全是「静态看代码看不出来」的时序/闸门逻辑，
 * 而且一旦写错，表现是**更新功能静默失效**（用户什么都看不到），最难排查。
 */
import assert from "node:assert/strict";
import fs from "node:fs";

/* ─────────────────────── 迷你 DOM ─────────────────────── */

class FakeText {
  constructor(text) { this.nodeType = 3; this.textContent = String(text); this.parentNode = null; }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter((x) => x !== this); this.parentNode = null; } }
}

class FakeNode {
  constructor(tag = "") {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this._classes = new Set();
    this._listeners = new Map();
    this.style = { cssText: "", width: "" };
  }
  get className() { return [...this._classes].join(" "); }
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get classList() {
    const set = this._classes;
    return {
      contains: (c) => set.has(c),
      add: (...cs) => cs.forEach((c) => set.add(c)),
      remove: (...cs) => cs.forEach((c) => set.delete(c)),
      toggle: (c, on) => { const next = on === undefined ? !set.has(c) : !!on; if (next) set.add(c); else set.delete(c); return next; },
    };
  }
  setAttribute(key, value) {
    this.attrs[key] = String(value);
    if (key === "class") this.className = value;
    if (key === "hidden") this.hidden = true;
    // 浏览器里 checked 属性＝复选框的初始选中态（toggleSwitch 正是 setAttribute("checked", true)），
    // 替身若不映射，读 input.checked 恒为 undefined，开关断言就成了空转。
    if (key === "checked") this.checked = true;
  }
  getAttribute(key) { return key in this.attrs ? this.attrs[key] : null; }
  /** 走 parentNode 到 body —— 订阅回调里的「节点是否还在文档里」就靠它判断。 */
  get isConnected() {
    let n = this;
    while (n) { if (n === document.body) return true; n = n.parentNode; }
    return false;
  }
  addEventListener(type, fn) { if (!this._listeners.has(type)) this._listeners.set(type, []); this._listeners.get(type).push(fn); }
  removeEventListener(type, fn) { this._listeners.set(type, (this._listeners.get(type) || []).filter((x) => x !== fn)); }
  dispatch(type, event = {}) { for (const fn of [...(this._listeners.get(type) || [])]) fn(event); }
  append(...kids) {
    for (const kid of kids) {
      const node = kid && kid.nodeType ? kid : new FakeText(kid);
      node.parentNode?.children.splice(node.parentNode.children.indexOf(node), 1);
      this.children.push(node);
      node.parentNode = this;
    }
  }
  replaceChildren(...kids) { for (const c of this.children) c.parentNode = null; this.children = []; this.append(...kids); }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter((x) => x !== this); this.parentNode = null; } }
  get textContent() { return this.children.map((c) => c.textContent ?? "").join(""); }
  set textContent(value) { for (const c of this.children) c.parentNode = null; this.children = [new FakeText(value)]; this.children[0].parentNode = this; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const classes = String(selector).replace(/^\./, "").split(".").filter(Boolean);
    const results = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.nodeType !== 1) continue;
        if (classes.every((c) => child._classes.has(c))) results.push(child);
        walk(child);
      }
    };
    walk(this);
    return results;
  }
  focus() { document.activeElement = this; }
  blur() {}
  select() {}
}

const toastsBox = new FakeNode("div");
globalThis.document = {
  body: new FakeNode("body"),
  documentElement: { dataset: { uiMotion: "reduced" } },
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => new FakeText(text),
  getElementById: (id) => (id === "toasts" ? toastsBox : null),
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: (selector) => document.body.querySelectorAll(selector),
};

const dispatched = [];
globalThis.window = {
  __TAURI_INTERNALS__: { invoke: (...args) => invokeStub(...args) },
  dispatchEvent: (event) => { dispatched.push(event); return true; },
  addEventListener() {},
  removeEventListener() {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  innerWidth: 1280,
  innerHeight: 800,
};
globalThis.CustomEvent ??= class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
};

/* ─────────────── 打桩的 Tauri invoke ─────────────── */

const calls = [];
let handler = () => { throw new Error("no stub"); };
function invokeStub(cmd, args) {
  calls.push({ cmd, args });
  return handler(cmd, args);
}
const lastCallTo = (cmd) => [...calls].reverse().find((c) => c.cmd === cmd);
const callsTo = (cmd) => calls.filter((c) => c.cmd === cmd);

const RELEASE = {
  current: "0.38.0",
  latest: "0.38.1",
  has_update: true,
  supported: true,
  message: "",
  notes: "## 本次更新\n- 加了应用内更新",
  published_at: "2026-09-15T00:00:00Z",
  release_name: "v0.38.1",
  release_url: "https://github.com/momoqiqi-qwq/U-Time/releases/tag/v0.38.1",
  asset_name: "LeTime-0.38.1-x64-setup.exe",
  asset_url: "https://github.com/momoqiqi-qwq/U-Time/releases/download/v0.38.1/LeTime-0.38.1-x64-setup.exe",
  asset_size: 21 * 1024 * 1024,
  asset_digest: "sha256:" + "ab".repeat(32),
};

/* ─────────────── 加载被测模块 ─────────────── */

const S = await import("../src/store.js");
const api = (await import("../src/api.js")).api;
const U = await import("../src/updateChecker.js");

// 首次启动没有快照返回 null；真实读取异常必须交给恢复页，不能退回空数据。
handler = () => ({ tasks: [], blocks: [], settings: {}, plugins: {} });
await S.initStore({ tasks: [], blocks: [], settings: {}, plugins: {}, inbox: [], automation: {} });
assert.ok(S.getState(), "store 必须初始化成功");

const findButtons = (root, acc = []) => {
  for (const child of root.children) {
    if (child.nodeType !== 1) continue;
    if (child.tagName === "BUTTON") acc.push(child);
    findButtons(child, acc);
  }
  return acc;
};
const buttonByText = (root, text) => findButtons(root).find((b) => b.textContent === text) || null;
const updateToast = () => document.body.children.find((n) => n.nodeType === 1 && n._classes.has("update-toast")) || null;

/* ── ① 设置项归一化 ── */
assert.deepEqual({ ...U.DEFAULT_UPDATE_SETTINGS }, { autoCheck: true, notify: true, skipVersion: "", lastCheckAt: 0 },
  "默认值：启动自动检查开、有新版本就弹提示、无忽略版本、从未检查过");
assert.equal(U.getUpdateSettings().autoCheck, true);
assert.equal(U.getUpdateSettings().notify, true);

/* 首次安装 / 覆盖更新完成：按实际运行版本只提示一次。 */
const memoryStorage = (seed = {}) => {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    data,
  };
};
const firstInstallStorage = memoryStorage();
assert.deepEqual(U.recordInstalledVersion('0.124.0', firstInstallStorage),
  { kind: 'installed', current: '0.124.0', previous: '' },
  '第一次安装应识别为 installed');
assert.equal(U.recordInstalledVersion('0.124.0', firstInstallStorage), null,
  '同一版本重复启动不能反复弹安装完成');
const upgradedStorage = memoryStorage({
  [U.INSTALLED_VERSION_KEY]: '0.123.0',
  [U.PENDING_UPDATE_VERSION_KEY]: '0.124.0',
});
assert.deepEqual(U.recordInstalledVersion('0.124.0', upgradedStorage),
  { kind: 'updated', current: '0.124.0', previous: '0.123.0' },
  '安装器重启后版本变化应识别为 updated');
assert.equal(upgradedStorage.data.has(U.PENDING_UPDATE_VERSION_KEY), false,
  '安装结果检测后必须清掉 pending 标记');

const settings = S.getState().settings;
settings.update = { autoCheck: "no", notify: 0, skipVersion: 12345, lastCheckAt: "abc" };
const normalized = U.getUpdateSettings();
assert.equal(normalized.autoCheck, true, 'autoCheck 只认 `=== false` 才算关：被写成字符串 "no" 也要按开处理');
assert.equal(normalized.notify, true, "notify 同一套约定：写成数字 0 也要按开处理");
assert.equal(normalized.skipVersion, "", "skipVersion 非字符串必须归零，否则 === 比对永远不相等");
assert.equal(normalized.lastCheckAt, 0, "lastCheckAt 非数字必须归零，否则节流计算变成 NaN");

settings.update = { autoCheck: false, notify: false };
assert.equal(U.getUpdateSettings().autoCheck, false, "显式 false 必须真的关掉自动检查");
assert.equal(U.getUpdateSettings().notify, false, "显式 false 必须真的关掉弹窗提示");
// 后面几段测的是检查与提示条，先把两个开关都拨回默认的开。
U.setUpdateSettings({ autoCheck: true, notify: true });

U.setUpdateSettings({ skipVersion: "0.38.1" });
assert.equal(S.getState().settings.update.skipVersion, "0.38.1", "setUpdateSettings 必须写回 store 状态（否则重启就丢）");
U.setUpdateSettings({ skipVersion: "" });

/* ── ②③④ 检查与静默检查 ── */

// 无更新
handler = (cmd) => { assert.equal(cmd, "update_check"); return { ...RELEASE, has_update: false, latest: "0.38.0" }; };
let info = await U.checkForUpdates();
assert.equal(info.has_update, false);
assert.equal(U.getUpdateState().phase, "uptodate", "没有新版必须落在 uptodate，而不是 available");
assert.equal(updateToast(), null, "没有新版绝不许弹提示条");
// 「已是最新」必须带检查时刻：只写版本号时，用户无法分辨这是刚查的还是发版前查的陈旧结果
// —— 线上实测过这个误会（release 从创建到发布之间是草稿，草稿不计入 releases/latest）。
assert.ok(U.getUpdateState().checkedAt > 0, "成功检查后要记下检查时刻");
assert.match(U.describeUpdateState(U.getUpdateState()), /已是最新版本（v0\.38\.0） · \d{2}:\d{2} 检查/, "状态回显要标明这条结果是何时查的");
assert.equal(U.formatCheckTime(0), "", "没有时刻时不渲染尾巴，别显示 1970 或 NaN");
// 时间戳拼接收敛在 withCheckStamp：状态回显与设置页 idle 行都必须走它，避免拼法漂移
assert.equal(U.withCheckStamp("尚未检查", 0), "尚未检查", "withCheckStamp：无时刻时原样返回，别拼出「· undefined」");
assert.match(U.withCheckStamp("已是最新版本（v0.38.0）", Date.now()), /已是最新版本（v0\.38\.0） · \d{2}:\d{2} 检查$/, "withCheckStamp：默认拼成「· HH:MM 检查」");
assert.equal(U.withCheckStamp("基线", 0, { prefix: "上次自动检查 ", suffix: "" }), "基线", "withCheckStamp：自定义前后缀在无时刻时同样不拼接");

// 有更新
handler = () => ({ ...RELEASE });
info = await U.checkForUpdates();
assert.equal(U.getUpdateState().phase, "available");
assert.equal(info.asset_name, "LeTime-0.38.1-x64-setup.exe", "asset 信息要原样交给前端，下载时才不用再查一次");

// 有新版但本平台没有可自动安装的产物
handler = () => ({ ...RELEASE, supported: false, message: "最新发布里没有找到本平台可用的更新包（0.38.1）" });
await U.checkForUpdates();
const st = U.getUpdateState();
assert.equal(st.phase, "available", "有新版但不能自动装，仍是 available（要有「到仓库下载」的出口）");
assert.match(st.message, /没有找到本平台可用/, "必须把「为什么装不了」原样带给用户，否则更新按钮点了没反应");
assert.match(U.describeUpdateState(st), /发现新版本 v0\.38\.1/, "状态回显要说人话");

// 请求失败：返回 null 且不抛
handler = () => { throw new Error("检查更新失败：error sending request"); };
assert.equal(await U.checkForUpdates(), null, "checkForUpdates 不许把异常抛给调用方（手动/静默两条路的处理不同）");
const errState = U.getUpdateState();
assert.equal(errState.phase, "error");
assert.match(errState.error, /检查更新失败/, "错误文本要保留给设置页显示");
assert.ok(errState.checkedAt > 0, "失败不许覆盖上一次成功检查的时刻 —— 否则面板会假装「刚查过」");

/* ── ③ 静默检查的三道闸门 ── */
handler = () => ({ ...RELEASE });
const resetCalls = () => { calls.length = 0; };

// 闸门 a：autoCheck 关 → 一次请求都不发
U.setUpdateSettings({ autoCheck: false, lastCheckAt: 0, skipVersion: "" });
resetCalls();
await U.silentUpdateCheck();
assert.equal(callsTo("update_check").length, 0, "关掉自动检查后，启动静默检查必须一次请求都不发");
assert.equal(updateToast(), null);

// 闸门 b：6 小时内检查过 → 不发
U.setUpdateSettings({ autoCheck: true, lastCheckAt: Date.now() - 60 * 1000 });
resetCalls();
await U.silentUpdateCheck();
assert.equal(callsTo("update_check").length, 0, "6 小时内已检查过就不该再请求（GitHub 未鉴权 API 每小时仅 60 次）");

// 闸门 c：超过 6 小时 → 发一次，成功后写 lastCheckAt，并弹提示条
U.setUpdateSettings({ lastCheckAt: Date.now() - 7 * 60 * 60 * 1000, skipVersion: "" });
resetCalls();
await U.silentUpdateCheck();
assert.equal(callsTo("update_check").length, 1, "超过节流窗口必须真的去查一次");
assert.ok(S.getState().settings.update.lastCheckAt > Date.now() - 5000, "成功检查后必须写入 lastCheckAt");
assert.equal(S.getState().settings.update.lastCheckAt, U.getUpdateState().checkedAt,
  "节流记录必须复用状态回显的 checkedAt —— 各自取 Date.now() 会有毫秒级分叉，对照时间线时对不上");
let toast = updateToast();
assert.ok(toast, "发现可自动安装的新版时应弹提示条");
assert.match(toast.textContent, /发现新版本 v0\.38\.1/, "提示条要写明新版本号");
assert.match(toast.textContent, /当前版本 v0\.38\.0/, "提示条要写明当前版本号（用户才知道差多少）");
assert.ok(buttonByText(toast, "立即升级"), "提示条上要有「升级」按钮（用户要求的两个动作之一）");
assert.ok(buttonByText(toast, "忽略此版本"), "提示条上要有「忽略」按钮（用户要求的两个动作之一）");

/* ── ④ 「忽略此版本」 ── */
const ignoreBtn = buttonByText(toast, "忽略此版本");
assert.ok(ignoreBtn, "提示条必须有「忽略此版本」按钮");
ignoreBtn.dispatch("click");
assert.equal(S.getState().settings.update.skipVersion, "0.38.1", "「忽略此版本」必须按版本号落盘");
assert.equal(updateToast(), null, "点了忽略，提示条要立刻消失");

/* 「恢复提示」要当场生效 —— 否则用户点完还得重启才看得到效果，像坏了 */
U.clearSkippedVersion();
assert.equal(S.getState().settings.update.skipVersion, "", "「恢复提示」必须清掉忽略记录");
assert.ok(updateToast(), "「恢复提示」应当场把提示条放回来（不必等下次启动）");

/* 单独验证 skipVersion 这道闸门。
 * 必须在这一步做：上一条 clearSkippedVersion() 已把 `dismissedThisSession` 复位为 false，
 * 所以此时「不弹」只可能是 skipVersion 挡的。若放在「忽略」按钮之后立刻测，
 * dismissed 仍是 true，提示条本来就不会出现 —— 断言会因为错误的原因通过（变异测试抓出来过）。 */
updateToast().remove();                       // 直接摘节点，不动模块内的会话状态
U.setUpdateSettings({ skipVersion: "0.38.1", lastCheckAt: Date.now() - 7 * 60 * 60 * 1000 });
resetCalls();
await U.silentUpdateCheck();
assert.equal(callsTo("update_check").length, 1, "这一步应该真的发了检查请求（否则下面的断言是被节流挡的，等于没测）");
assert.equal(updateToast(), null, "已忽略的版本不该再弹（否则「忽略」按钮形同虚设）");

U.clearSkippedVersion();
assert.ok(updateToast(), "再次恢复提示，提示条应回来");

// 「稍后」只活本次会话：不需要真的等 6 小时，把 lastCheckAt 拨回去再调一次静默检查即可
const laterBtn = buttonByText(updateToast(), "稍后");
assert.ok(laterBtn, "提示条必须有「稍后」按钮");
laterBtn.dispatch("click");
assert.equal(updateToast(), null, "「稍后」要关掉提示条");
U.setUpdateSettings({ lastCheckAt: Date.now() - 7 * 60 * 60 * 1000 });
resetCalls();
await U.silentUpdateCheck();
assert.equal(callsTo("update_check").length, 1, "「稍后」只是不弹提示，不该连检查一起停掉");
assert.equal(updateToast(), null, "「稍后」只活本次会话：同一会话内不该再弹回来");

/* ── ⑤ 命令桥契约 + 下载/安装流程 ── */
handler = (cmd) => {
  if (cmd === "update_check") return { ...RELEASE };
  if (cmd === "update_download") return "C:/Users/x/AppData/Local/com.yile.letime/cache/LeTime-0.38.1-x64-setup.exe";
  if (cmd === "update_ready") return { ready: true, platform: "windows", reason: "" };
  if (cmd === "update_install") return { launched: true, exiting: true };
  if (cmd === "update_open_install_settings") return { opened: true };
  throw new Error(`未打桩的命令：${cmd}`);
};
await U.checkForUpdates();
resetCalls();
assert.equal(await U.startUpdate(), true, "startUpdate 成功应返回 true");

const downloadCall = lastCallTo("update_download");
assert.ok(downloadCall, "必须调用 update_download");
assert.deepEqual(downloadCall.args, {
  url: RELEASE.asset_url,
  name: RELEASE.asset_name,
  size: RELEASE.asset_size,
  digest: RELEASE.asset_digest,
}, "参数名必须与 Rust 侧 update_download(url, name, size, digest) 一致（Tauri 只透传 camelCase）");

const readyCall = lastCallTo("update_ready");
assert.ok(readyCall, "下载完必须探一次安装就绪状态");
assert.deepEqual(readyCall.args, {}, "update_ready 不接受参数，别多传（Tauri 会因未知字段报错）");

const readyState = U.getUpdateState();
assert.equal(readyState.phase, "ready");
assert.equal(readyState.downloadedPath, "C:/Users/x/AppData/Local/com.yile.letime/cache/LeTime-0.38.1-x64-setup.exe",
  "下载返回的路径要存住，安装时要用");
assert.equal(readyState.installReady.ready, true);

/* ── ⑤b 左下角进度卡：git 风格的下载读数，卡片就地换文案而不是重建 ── */
let resolveDownload;
handler = (cmd) => {
  if (cmd === "update_check") return { ...RELEASE };
  if (cmd === "update_download") return new Promise((done) => { resolveDownload = done; });
  if (cmd === "update_ready") return { ready: true, platform: "windows", reason: "" };
  throw new Error(`未打桩的命令：${cmd}`);
};
await U.checkForUpdates();
const downloadPromise = U.startUpdate();
assert.equal(U.getUpdateState().phase, "downloading", "打桩的下载还没 resolve，此刻必须停在 downloading");
const liveCard = updateToast();
assert.ok(liveCard, "下载中左下角必须出现进度卡（用户不该为了看进度去开设置页）");
assert.ok(liveCard.querySelector("ns-spinner"), "进度卡要有 spinner：数字没动的时候它才是「还在下」的唯一凭据");
assert.match(liveCard.textContent, /正在下载更新包 v0\.38\.1/, "进度卡要写明在下哪个版本");
assert.match(liveCard.textContent, /-- B\/s/, "第一个采样点算不出速率，要写 -- 而不是 0 B/s（0 读起来像卡住了）");
assert.equal(buttonByText(liveCard, "稍后"), null, "正在下载的卡不给「稍后」：Rust 侧没有取消通道，收掉它只会让人以为下载停了");

/* 进度事件：received/total 直接来自 Rust，速率由前端按时间差算（见 createSpeedMeter）。 */
const meter = U.formatDownloadMeter({ received: 16 * 1048576, total: 150 * 1048576, speed: 1.08 * 1048576 });
assert.equal(meter, "10% (16.00 MiB/150.00 MiB) | 1.08 MiB/s", "进度行要照 git 的写法：百分比 + (已下/总量) + 速率");
assert.equal(U.formatDownloadMeter({ received: 1048576, total: 0, speed: 0 }), "(1.00 MiB) | -- B/s",
  "release 没给 asset_size 时省掉百分比，只报已下体积 —— 猜分母会让进度条从 30% 跳回 90%");
assert.equal(U.formatBytes(512), "512 B");
assert.equal(U.formatBytes(2048), "2.0 KiB");
assert.equal(U.formatBytes(0), "0 B");
const speed = U.createSpeedMeter({ minIntervalMs: 100 });
assert.equal(speed.sample(0, 1000), 0, "第一个点没有区间，速率只能是 0（渲染层再把它显示成 --）");
assert.equal(speed.sample(10 * 1024 * 1024, 2000), 10 * 1024 * 1024, "第二个点即瞬时值");
assert.ok(Math.abs(speed.sample(10 * 1024 * 1024 + 5 * 1024 * 1024, 3000) - 10 * 1024 * 1024) < 2 * 1024 * 1024,
  "滑动平均：一次慢包只能把读数往下拉一截，不能直接跳到 5 MiB/s");

resolveDownload("C:/x/LeTime-0.38.1-x64-setup.exe");
await downloadPromise;
assert.equal(updateToast(), liveCard, "下载完成要复用同一张卡（重建会把入场动画重放，进度一秒刷两次就一直「在跳」）");
assert.match(liveCard.textContent, /更新包已下载完成（v0\.38\.1）/);
assert.equal(liveCard.querySelector("ns-spinner").hidden, true, "下完要把 spinner 收掉，它只在该有「正在做」的事时转");
assert.ok(buttonByText(liveCard, "关闭并安装"), "完成卡要就地给出安装入口");

/* 检查失败必须继续静默：左下角那张卡只认下载/安装段的错误。 */
handler = (cmd) => {
  if (cmd === "update_check") throw new Error("网络不可用");
  throw new Error(`未打桩的命令：${cmd}`);
};
assert.equal(await U.checkForUpdates({ manual: true }), null);
assert.equal(U.getUpdateState().errorStage, "check", "检查段的失败要标成 check");
assert.equal(updateToast(), null, "离线 / GitHub 限流不该在左下角弹「失败」卡（启动静默检查的同一条约定）");

/* 下载段的失败才弹，而且要能一键续一次。 */
handler = (cmd) => {
  if (cmd === "update_check") return { ...RELEASE };
  if (cmd === "update_download") throw new Error("下载中断：连接重置");
  throw new Error(`未打桩的命令：${cmd}`);
};
await U.checkForUpdates();
assert.equal(await U.startUpdate(), false);
const errorCard = updateToast();
assert.ok(errorCard, "下载失败必须在左下角显示，而不是只写进设置页里");
assert.match(errorCard.textContent, /下载失败/);
assert.match(errorCard.textContent, /下载中断：连接重置/, "失败原因要原样显示");
assert.ok(buttonByText(errorCard, "重试"), "失败卡必须给重试入口");

// Android：未授权未知来源 → installUpdate 必须改走授权页，而不是硬装
handler = (cmd) => {
  if (cmd === "update_check") return { ...RELEASE };
  if (cmd === "update_download") return "/data/user/0/com.yile.letime/cache/update.apk";
  if (cmd === "update_ready") return { ready: false, platform: "android", reason: "需要先允许安装未知来源应用" };
  if (cmd === "update_open_install_settings") return { opened: true };
  if (cmd === "update_install") throw new Error("不应该在未授权时调用 update_install");
  throw new Error(`未打桩的命令：${cmd}`);
};
await U.checkForUpdates();
await U.startUpdate();
const androidState = U.getUpdateState();
assert.equal(androidState.installReady.ready, false, "未授权要如实记下来");
assert.equal(androidState.message, "需要先允许安装未知来源应用", "要把原因显示给用户");
resetCalls();
assert.equal(await U.installUpdate(), true, "未授权时点安装 → 转去授权页，应返回 true（动作已发起）");
assert.equal(lastCallTo("update_install"), undefined, "未授权时绝不能直接调 update_install（会一闪而过地失败）");
assert.ok(lastCallTo("update_open_install_settings"), "未授权时必须打开「安装未知来源应用」授权页");

// 已授权（Windows / Android 都是这条）：确认对话框点「关闭并安装」后，必须真的调 update_install 并带上路径
handler = (cmd) => {
  if (cmd === "update_check") return { ...RELEASE };
  if (cmd === "update_download") return "/tmp/LeTime-0.38.1-x64-setup.exe";
  if (cmd === "update_ready") return { ready: true, platform: "windows", reason: "" };
  if (cmd === "update_install") return { launched: true, exiting: true };
  throw new Error(`未打桩的命令：${cmd}`);
};
await U.checkForUpdates();
await U.startUpdate();
resetCalls();
const installPromise = U.installUpdate();
// appConfirm 是应用内对话框：它把面板挂到 document.body 上等着被点。这里模拟用户点「关闭并安装」。
const confirmBtn = document.body.querySelector(".app-dialog-btn.pri");
assert.ok(confirmBtn, "安装前必须弹确认框（会关掉应用，不能静默执行）");
assert.equal(confirmBtn.textContent, "关闭并安装", "确认按钮文案要写明后果");
confirmBtn.dispatch("click");
assert.equal(await installPromise, true, "确认后 installUpdate 应返回 true");
assert.deepEqual(lastCallTo("update_install").args, { path: "/tmp/LeTime-0.38.1-x64-setup.exe" },
  "参数名必须与 Rust 侧 update_install(path) 一致，且要用 update_download 返回的那个路径");
assert.equal(U.getUpdateState().phase, "installing", "确认后进入 installing，按钮不再可点，避免重复触发安装");

// 下载失败要落到 error 且带上原因
handler = (cmd) => {
  if (cmd === "update_check") return { ...RELEASE };
  if (cmd === "update_download") throw new Error("下载失败：HTTP 404");
  throw new Error(`未打桩的命令：${cmd}`);
};
await U.checkForUpdates();
assert.equal(await U.startUpdate(), false, "下载失败要返回 false");
assert.equal(U.getUpdateState().phase, "error");
assert.match(U.getUpdateState().error, /下载失败：HTTP 404/, "失败原因要原样保留");

/* ── ⑥ 接口形状（前端消费方必须能拿到这些方法） ── */
for (const method of ["updateCheck", "updateDownload", "updateInstall", "updateReady", "updateOpenInstallSettings"]) {
  assert.equal(typeof api[method], "function", `api.js 必须导出 ${method}()`);
}

/* ── ⑦ 接线：更新面板嵌在「关于」里 + 提示条跳转目标 ── */
const read = (p) => readProductSource(new URL(p, import.meta.url), "utf8");

// 更新面板的挂载点是「关于」卡片，不再是独立的「更新与维护」分区。
const settingsView = read("../src/views/settings.js");
assert.doesNotMatch(settingsView, /createUpdateSettingsCard/, "旧卡片工厂已废弃：不该再出现在设置页里");
assert.doesNotMatch(settingsView, /id:\s*"update"[^\n]*label:/, "id:\"update\" 分区已并入「关于」，留着会让导航多出一个空分区");
const aboutCard = read("../src/views/aboutCard.js");
assert.match(aboutCard, /createUpdateSettingsPanel/, "「关于」卡片必须挂上软件更新面板（用户要求：设置-关于里能设是否弹提示）");
assert.match(aboutCard, /软件更新/, "面板在关于页里要有「软件更新」小标题，否则用户找不到");
assert.match(settingsView, /id:\s*"about"[^\n]*keywords:[^\n]*更新/, "「关于」分区的关键词要含「更新」，搜「更新」必须能落到关于");
assert.match(settingsView, /renderSettings\(container,\s*opts\s*=\s*\{\}\)/, "renderSettings 要能接收要停靠的分区");

const panelSrc = read("../src/views/settings/update.js");
assert.match(panelSrc, /notify[\s\S]{0,200}toggleSwitch|toggleSwitch[\s\S]{0,200}notify/, "「是否弹出提示」必须是一个真开关");

const checkerSrc = read("../src/updateChecker.js");
assert.match(checkerSrc, /jumpToUpdateSettings[\s\S]*?section:\s*"about"/, "提示条跳转目标必须改成 section:\"about\"（旧 \"update\" 分区已不存在，跳过去会落空）");
assert.match(checkerSrc, /notify:\s*true/, "默认设置里要有 notify:true（新装用户默认弹提示）");

const shellSrc = read("../src/shell.js");
assert.match(shellSrc, /tide:open-settings/, "shell.js 必须监听 tide:open-settings，否则提示条的「立即升级」跳不进设置页");
assert.match(shellSrc, /openSettingsModal\(e\.detail\?\.section/, "跳转时要把 section 透传给设置页");
const mainSrc = read("../src/main.js");
assert.match(mainSrc, /initUpdateChecker\(\)/, "main.js 的 boot() 必须调用 initUpdateChecker()，否则启动不会自动检查");

/* ── ⑧ notify 开关：管的是「弹不弹」，不是「查不查」 ── */
// 同一组条件（有新版 / 未忽略 / 非会话内关闭）跑两次，只差 notify 一个值。
// 做对照组是必须的：单独断言「notify 关着时没弹」会因为别的闸门（比如会话内 dismissed、
// 或者 lastCheckAt 刚写过被节流挡住）替它挡枪 —— 断言就会因为错误的原因通过。
handler = (cmd) => {
  if (cmd === "update_check") return { ...RELEASE };
  throw new Error(`未打桩的命令：${cmd}`);
};
const runSilent = async (notify) => {
  // `dismissedThisSession`（「稍后」留下的会话内免打扰）没有公开的复位 API，「恢复提示」
  // 是唯一入口。上面刚点过「稍后」，这里不复位的话两次都不会弹 —— 差异测试会退化成
  // 「两边都是 null」的假通过（正是这个断言把这个问题抓出来的）。
  U.setUpdateSettings({ autoCheck: true, notify, skipVersion: "" });
  U.clearSkippedVersion();
  updateToast()?.remove();
  U.setUpdateSettings({ lastCheckAt: Date.now() - 7 * 60 * 60 * 1000 });
  resetCalls();
  await U.silentUpdateCheck();
  const shown = updateToast();
  shown?.remove();
  return { checks: callsTo("update_check").length, shown };
};

const notifyOff = await runSilent(false);
assert.equal(notifyOff.checks, 1, "notify 关掉≠不检查：启动仍要发 update_check");
assert.equal(notifyOff.shown, null, "notify 关掉后不能再弹左下角升级通知");
assert.equal(U.getUpdateState().phase, "available", "状态照常推进到 available，用户手动打开「关于」还能看见");
assert.ok(S.getState().settings.update.lastCheckAt > Date.now() - 5000, "检查本身要留下 lastCheckAt，否则节流失效变成每次启动都查");

const notifyOn = await runSilent(true);
assert.equal(notifyOn.checks, 1, "对照组同样要真发请求（否则弹没弹都无从归因）");
assert.ok(notifyOn.shown, "同条件只把 notify 打开就必须弹 —— 有这条才能证明上面「没弹」是 notify 挡的");

/* ── ⑨ 恢复「已忽略的版本」不能绕过 notify ── */
U.setUpdateSettings({ notify: false, skipVersion: "0.38.1" });
U.clearSkippedVersion();
assert.equal(U.getUpdateSettings().skipVersion, "", "恢复提示要真的清掉 skipVersion");
assert.equal(updateToast(), null, "notify 关着时，「恢复提示」也不该把提示条放回来（那是用户自己关的全局开关）");

U.setUpdateSettings({ notify: true, skipVersion: "0.38.1" });
U.clearSkippedVersion();
assert.equal(U.getUpdateSettings().skipVersion, "");
assert.ok(updateToast(), "对照组：notify 开着时「恢复提示」必须当场放回提示条");
updateToast()?.remove();

/* ── ⑩ 「关于 › 软件更新」面板的构建与订阅 ── */
// 这一节守的是**无头 Chrome 真机探针**抓出来的坑（静态断言完全看不出来）：
// `subscribeUpdateState()` 会**同步**先回调一次，而那一刻 panel 还没被 append 进文档
// （`panel.isConnected` 恒为 false）。旧写法
//   const unsubscribe = subscribeUpdateState(() => { if (!panel.isConnected) { unsubscribe(); … } });
// 会在**暂时性死区**里读 `unsubscribe` → ReferenceError。异常顺着
// createUpdateSettingsPanel → createAboutCard → renderSettings 冒出去，
// 结果是**整个设置页只剩一个标题为「设置」的空弹窗**（实测）。
const { createUpdateSettingsPanel } = await import("../src/views/settings/update.js");

const collect = (root, cls, acc = []) => {
  for (const c of root.children) {
    if (c.nodeType !== 1) continue;
    if (c._classes.has(cls)) acc.push(c);
    collect(c, cls, acc);
  }
  return acc;
};

let panel = null;
// 构建期必须**一点订阅回调错误都没有**。这是本节的真正判据：
// 修复前那次同步回调会抛 ReferenceError（TDZ 读 unsubscribe），而 subscribeUpdateState
// 现在跟 emit() 一样 try/catch，于是它只会变成一行 console.error —— 只看返回值/不抛，
// 是**看不出**这个 bug 的（变异测试第一版就是这么逃逸的）。
const origConsoleError = console.error;
const loggedErrors = [];
console.error = (...a) => { loggedErrors.push(a.map((x) => String((x && x.message) || x)).join(" ").slice(0, 200)); };

assert.doesNotThrow(() => { panel = createUpdateSettingsPanel({ currentVersion: "0.38.0" }); },
  "构建面板不得抛错 —— 抛出去会把整张「关于」卡连同设置页一起渲染中断");
assert.ok(panel, "面板必须返回节点");
assert.ok(panel._classes.has("update-panel"), "面板根类名是 .update-panel（不再自带 set-card 卡片壳）");

const allRows = collect(panel, "setting-row");
const rows = allRows.filter((r) => !r.hidden);
assert.equal(allRows.length, 3, "面板里有三行 .setting-row：两个开关 + 「已忽略的版本」");
assert.equal(rows.length, 2, "没有忽略记录时，「已忽略的版本」那行必须藏着");
assert.deepEqual(rows.map((r) => r.children[0]?.textContent),
  ["启动时自动检查更新", "有新版本时弹窗提示"],
  "两行开关的文案与顺序 —— 用户要的「是否弹出提示」就是第二行");

const sws = rows.map((r) => collect(r, "switch")[0]);
assert.ok(sws[0] && sws[1], "两行都要真的挂上滑块开关");
assert.equal(sws[0].getAttribute("type"), "checkbox", "滑块开关是原生复选框，不是 div 扮的");
assert.equal(sws[0].getAttribute("role"), "switch", "要有 role=switch 给屏幕阅读器");

const status = collect(panel, "update-status")[0];
assert.ok(status, "面板要有状态回显行");
assert.match(status.textContent, /发现新版本 v0\.38\.1/, "构建时就该把当前状态（available）画出来");

// 先挂进文档再交互：拨动开关会 setUpdateSettings → emit，而**脱离文档**的节点被退订是
// 设计行为（那条分支就是干这个的），不先挂载的话后面的订阅断言会因为顺序问题假红。
document.body.append(panel);
const before = status.textContent;

// 拨动开关必须真的写回设置（不是画着好看）
sws[0].checked = false; sws[0].dispatch("change");
assert.equal(U.getUpdateSettings().autoCheck, false, "「启动时自动检查更新」拨到关要写回设置");
sws[0].checked = true; sws[0].dispatch("change");
assert.equal(U.getUpdateSettings().autoCheck, true, "拨回开也要写回");
sws[1].checked = false; sws[1].dispatch("change");
assert.equal(U.getUpdateSettings().notify, false, "「有新版本时弹窗提示」拨到关要写回设置");
sws[1].checked = true; sws[1].dispatch("change");
assert.equal(U.getUpdateSettings().notify, true, "拨回开也要写回");

// 关键：挂载后仍要**订阅着**状态。若首次同步回调把它当场退订了，状态行会永远停在旧文本。
handler = () => ({ ...RELEASE, has_update: false, latest: "0.38.0" });
await U.checkForUpdates();
assert.match(status.textContent, /已是最新版本/,
  "面板挂载后必须仍随状态更新 —— 停在「发现新版本」就说明首次回调把它退订了");
assert.notEqual(status.textContent, before, "状态变了，回显文字就得跟着变");

console.error = origConsoleError;
assert.deepEqual(loggedErrors, [],
  "构建 / 挂载 / 交互全程不得出现订阅回调错误（旧写法在这里抛 ReferenceError，只是被 try/catch 变成了日志）");

console.log("PASS: 应用内自动更新（设置归一化 / 四态检查 / 静默检查三道闸门 / 忽略与稍后 / 命令桥契约 / Android 授权先探 / notify 开关只管「弹不弹」/ 关于页面板构建与订阅，共 55+ 条断言）");
process.exit(0);
