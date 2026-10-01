// 插件宿主：加载内置插件与用户插件目录里的插件，注入受控 API
import { api } from "./api.js";
import * as S from "./store.js";
import { toast } from "./ui.js";
import { isAndroidRuntime, postNativeReminder } from "./androidNotify.js";
import { parseWhen, guessCategory, guessQuad } from "./timeParser.js";
import { BUILTIN_IDS, BUILTIN_PLUGINS } from "./pluginCatalog.js";
import { normalizeWebUrl, resolveWebUrl, parseSiteMeta, inferSiteIconName, extractNoticeLinks, extractPager, noticeKind, extractArticleText, detectLoginForm, formEncode, detectSpaShell, matchJsonSiteAdapter, buildJsonSiteListUrl, parseJsonSiteList, parseGenericNoticeJson, extractEmbeddedJsonNotices, extractNoticeApiCandidates } from "./webContent.js";
import { PROJECT_LINKS } from "./projectLinks.js";
import { previewSchedule } from "./scheduleConflict.js";
import { pushInbox } from "./automation.js";
import { spreadsheetFileToCsv } from "./spreadsheet.js";
import { renderNativeSchedule } from "./nativeSchedule.js";
import { BUILTIN_SOUNDS, playSound, resolveSound } from "./sound.js";

const registry = new Map();   // id -> { manifest, source, enabled, error }
const eventBus = new Map();   // event -> Set<{ pluginId, fn }>
const listeners = { navChanged: new Set(), taskActionsChanged: new Set() };
const httpCache = new Map();
const HTTP_CACHE_MAX = 80;
const builtinManifestMap = new Map(BUILTIN_PLUGINS.map((p) => [p.id, p]));
const codeCache = new Map();

export const PLUGIN_PERMISSION_LABELS = {
  ui: "界面 / 视图",
  tasks: "任务读写",
  blocks: "时间块读写",
  storage: "插件本地存储",
  notify: "应用内通知",
  events: "插件事件",
  http: "网络访问",
  openUrl: "打开网页",
  timeParse: "时间语义解析",
  vault: "加密密钥库（保存密码 / 登录票据等敏感凭据）",
  ai: "AI 对话（用「设置 › AI 与自动任务」配好的模型）",
  messages: "读取其他插件推来的消息",
  schoolImport: "学校教务登录与课表脚本导入",
  sound: "播放提醒音",
};

function isPermissionAllowed(man, pid, perm) {
  // v0.11.4：用户只需要决定“插件开 / 关”。manifest.permissions 继续作为
  // 能力声明与运行时边界，避免插件调用未声明的 API；不再提供逐项权限开关。
  return (man.permissions || []).includes(perm);
}

function requirePermission(man, pid, perm) {
  if (!isPermissionAllowed(man, pid, perm)) {
    throw new Error(`插件“${man.name || pid}”没有「${PLUGIN_PERMISSION_LABELS[perm] || perm}」权限`);
  }
}

function cachedHttpGet(url, ttlMs = 5 * 60 * 1000) {
  const key = String(url || "");
  const now = Date.now();
  const hit = httpCache.get(key);
  if (hit && now - hit.at < Math.max(0, Number(ttlMs) || 0)) return hit.promise;
  const promise = api.httpGet(key).then((res) => {
    httpCache.set(key, { at: Date.now(), promise: Promise.resolve(res) });
    if (httpCache.size > HTTP_CACHE_MAX) httpCache.delete(httpCache.keys().next().value);
    return res;
  }).catch((err) => { httpCache.delete(key); throw err; });
  httpCache.set(key, { at: now, promise });
  return promise;
}

export const pluginViews = [];       // { id, title, icon, render, pluginId }
export const taskActions = [];       // { id, label, icon, run(task), pluginId }

/* ── 插件消息汇聚（notice:new 的宿主侧抄送）───────────────────────────────
 *
 * 五家消息类插件（门户 / 学习通 / 学校通知 / 竞赛 / RSS）都按同一份载荷广播
 * `notice:new`：`{ source, sourceName, total, items:[{ title, time, sender }] }`。
 * 谁想"看看别的插件推来了什么"，原本只能自己去 `events.on` 蹲着 —— 可插件是一个个
 * 加载的，晚加载的那个根本听不到早加载插件在启动阶段就广播掉的消息，症状是
 * "有时候看得见有时候看不见"，最难查。所以宿主在 emit 这一层顺手抄一份。
 *
 * 只存内存、只留最近 120 条：消息的原始事实仍在各插件自己的存储里，这里只是一份
 * 跨插件视图。落进 data.json 就要连带迁移、备份、小程序三端一致，代价远大于价值；
 * 需要跨重启留存的调用方（AI 对话插件）自己把它并入私有存储。
 */
const MESSAGE_FEED = [];
const MESSAGE_SEEN = new Set();
const MESSAGE_MAX = 120;
const MESSAGE_SNAPSHOTS = new Map();

/** 插件主动公开当前列表的摘要；source 固定为发布者，不能读或冒充别家的私有存储。 */
export function publishPluginMessages(pluginId, pluginName, items) {
  const source = String(pluginId || "");
  if (!source) return;
  const rows = Array.isArray(items) ? items : [];
  MESSAGE_SNAPSHOTS.set(source, rows.slice(0, MESSAGE_MAX).map((raw) => {
    const item = raw && typeof raw === "object" ? raw : {};
    return {
      source, sourceName: String(item.sourceName || pluginName || source).slice(0, 60),
      title: String(item.title || "").trim().slice(0, 240),
      time: String(item.time || "").trim().slice(0, 60),
      sender: String(item.sender || "").trim().slice(0, 80),
      at: Number(item.at) || Date.now(),
    };
  }).filter((item) => item.title));
}

export function collectNotice(payload, fromPluginId) {
  const p = payload && typeof payload === "object" ? payload : {};
  const items = Array.isArray(p.items) ? p.items : [];
  const source = String(p.source || fromPluginId || "unknown");
  const sourceName = String(p.sourceName || source);
  const fresh = [];
  items.forEach((raw) => {
    const it = raw && typeof raw === "object" ? raw : {};
    const title = String(it.title || "").trim();
    if (!title) return;
    const time = String(it.time || "").trim();
    const key = `${source}|${time}|${title}`;
    if (MESSAGE_SEEN.has(key)) return;
    MESSAGE_SEEN.add(key);
    fresh.push(title);
    MESSAGE_FEED.push({ source, sourceName, title, time, sender: String(it.sender || "").trim(), at: Date.now() });
  });
  if (fresh.length && isAndroidRuntime()) {
    postNativeReminder({ key: `plugin-notice:${fromPluginId || source}`, at: Date.now(),
      title: `U-Time · ${sourceName.slice(0, 60)} · ${fresh.length} 条新消息`,
      body: fresh.slice(0, 3).map((title) => title.slice(0, 180)).join("\n"), urgent: false, taskActions: false });
  }
  // 去重集合跟着队列一起裁，否则跑久了 Set 只增不减。
  if (MESSAGE_FEED.length > MESSAGE_MAX) {
    MESSAGE_FEED.splice(0, MESSAGE_FEED.length - MESSAGE_MAX);
    MESSAGE_SEEN.clear();
    MESSAGE_FEED.forEach((m) => MESSAGE_SEEN.add(`${m.source}|${m.time}|${m.title}`));
  }
}

/** 最近的消息，新的在前。宿主内部与测试都用这一个出口。
 *  深拷贝统一走 structuredClone（v0.109.0）：宿主交给插件的数据全部是 store 的
 *  纯 JSON 结构，直接结构化克隆即可 —— 不再「序列化成字符串再解析回来」，
 *  大列表（几百条任务/消息）上显著更快，中间字符串与解析垃圾也不再产生。 */
export function listNotices(limit = 30) {
  const merged = MESSAGE_FEED.slice().reverse();
  MESSAGE_SNAPSHOTS.forEach((rows) => merged.push(...rows));
  const seen = new Set();
  return structuredClone(merged.sort((a, b) => b.at - a.at).filter((item) => {
    const key = `${item.source}|${item.time}|${item.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, Math.min(MESSAGE_MAX, Math.max(1, Number(limit) || 30))));
}

const yieldUi = () => new Promise((resolve) => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve(), { timeout: 40 });
  else setTimeout(resolve, 0);
});

export function onNavChanged(fn) { listeners.navChanged.add(fn); return () => listeners.navChanged.delete(fn); }
export function onTaskActionsChanged(fn) { listeners.taskActionsChanged.add(fn); return () => listeners.taskActionsChanged.delete(fn); }
function emitNavChanged() { listeners.navChanged.forEach((f) => f()); }


export function getRegistry() { return [...registry.values()]; }

async function loadManifest(id, source) {
  // 内置插件清单已经在构建时生成到 pluginCatalog，启动时不再重复发 manifest 请求。
  if (source === "builtin") {
    const man = builtinManifestMap.get(id);
    if (!man) throw new Error(`内置插件清单不存在：${id}`);
    return { ...man, platforms: man.platforms ? { ...man.platforms } : undefined };
  }
  const raw = await api.readPluginFile(`${id}/manifest.json`);
  return JSON.parse(raw);
}

async function loadCode(man, source) {
  const entry = man.entry || "main.js";
  const version = String(man.version || "0");
  const key = `${source}:${man.id}:${version}:${entry}`;
  if (codeCache.has(key)) return codeCache.get(key);
  const pending = (async () => {
    if (source === "builtin") {
      // 内置插件会独立升版本。入口 URL 必须带版本，否则 WebView/浏览器会长期命中
      // 旧的 main.js 强缓存，出现“清单已升级、实际仍运行旧插件”的错位。
      const url = `/plugins/${man.id}/${entry}?v=${encodeURIComponent(version)}`;
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`入口拉取失败 (${res.status})`);
      return res.text();
    }
    return api.readPluginFile(`${man.id}/${entry}`);
  })();
  codeCache.set(key, pending);
  try { return await pending; }
  catch (e) { codeCache.delete(key); throw e; }
}

/* ── 注入给插件的 API ── */
function makeApi(man, source) {
  const pid = man.id;
  const ns = () => S.pluginState(pid).storage;
  return {
    id: pid,
    manifest: man,

    app: {
      links: {
        website: PROJECT_LINKS.website || "",
        repository: PROJECT_LINKS.repository,
      },
    },

    plugins: {
      list: () => BUILTIN_PLUGINS.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        author: plugin.author,
        description: plugin.description,
        icon: plugin.icon,
        platforms: plugin.platforms ? { ...plugin.platforms } : {},
      })),
    },

    storage: {
      async get(key, fallback = null) { requirePermission(man, pid, "storage"); return ns()[key] ?? fallback; },
      async set(key, value) { requirePermission(man, pid, "storage"); ns()[key] = value; S.persistSoon(); },
    },

    tasks: {
      list: () => { requirePermission(man, pid, "tasks"); return structuredClone(S.getState().tasks); },
      // 插件创建的任务自动记住来源插件（sourcePlugin），四象限/详情抽屉据此显示插件图标；
      // 以宿主注入为准，插件自己传的同名字段会被覆盖，防止伪装来源。
      create: (patch) => { requirePermission(man, pid, "tasks"); return S.addTask({ ...patch, sourcePlugin: pid }); },
      update: (id, patch) => { requirePermission(man, pid, "tasks"); return S.updateTask(id, patch); },
      remove: (id) => { requirePermission(man, pid, "tasks"); return S.removeTask(id); },
    },

    inbox: {
      create: (item) => { requirePermission(man, pid, "tasks"); return pushInbox({ source: man.name || pid, ...item }); },
    },

    blocks: {
      list: (date) => { requirePermission(man, pid, "blocks"); return structuredClone(S.blocksOf(date)); },
      preview: (patch, ignoreId = null) => {
        requirePermission(man, pid, "blocks");
        const date = patch?.date || S.todayStr();
        const startMin = patch?.startMin ?? S.mmOf(patch?.start || "09:00");
        return structuredClone(previewSchedule(S.blocksOf(date), { ...patch, startMin }, { ignoreId }));
      },
      create: (patch) => { requirePermission(man, pid, "blocks"); return S.addBlock(patch); },
      createSmart: (patch) => {
        requirePermission(man, pid, "blocks");
        const date = patch?.date || S.todayStr();
        const startMin = patch?.startMin ?? S.mmOf(patch?.start || "09:00");
        const preview = previewSchedule(S.blocksOf(date), { ...patch, startMin });
        if (preview.ok) return { block: S.addBlock(patch), moved: false, conflicts: [] };
        const alt = preview.alternatives[0];
        if (!alt) throw new Error("目标时段冲突，且当天没有足够的连续空闲时间");
        return { block: S.addBlock({ ...patch, start: alt.start }), moved: true, requestedStart: patch?.start || S.hhmmOf(startMin), conflicts: preview.conflicts };
      },
      update: (id, patch) => { requirePermission(man, pid, "blocks"); return S.updateBlock(id, patch); },
      remove: (id) => { requirePermission(man, pid, "blocks"); return S.removeBlock(id); },
    },

    ui: {
      registerView(def) {
        requirePermission(man, pid, "ui");
        // `immersive: true` = 该视图要占满整屏，窄屏下隐藏 APP 全局底栏（见 shell.js 的
        // `.rail-hidden` 与 styles.css）。适合「一屏内要放下大块内容」的视图（如课程表：
        // 7 天 × 全部节次要在一屏里排开，底栏那 ~50px 直接决定末尾节次是否要滚动）。
        // 声明式而不是在 shell 里按插件 id 硬编码，插件才能自己决定要不要沉浸。
        pluginViews.push({ ...def, pluginId: pid, immersive: def.immersive === true,
          // 课表：默认安装包不带原版 Compose 运行时，所以原生渲染只做增强 ——
          // 探测不到运行时就把 def.render（插件自带的课表界面）顶上去，别留死面板。
          ...(pid === "shiguang-schedule" && api.isTauri
            ? { render: (el, ctx) => renderNativeSchedule(el, ctx, def.render) }
            : {}) });
        emitNavChanged();
      },
      registerTaskAction(def) {
        requirePermission(man, pid, "ui");
        taskActions.push({ ...def, pluginId: pid });
        listeners.taskActionsChanged.forEach((f) => f());
      },
    },

    assets: {
      async text(path) {
        requirePermission(man, pid, "ui");
        const clean = String(path || "").replace(/\\/g, "/");
        if (!clean || clean.startsWith("/") || clean.includes("..")) throw new Error("资源路径必须是插件目录内的相对路径");
        if (source === "builtin") {
          const version = encodeURIComponent(String(man.version || "0"));
          const res = await fetch(`/plugins/${pid}/${clean}?v=${version}`, { cache: "no-cache" });
          if (!res.ok) throw new Error(`资源拉取失败 (${res.status})`);
          return res.text();
        }
        return api.readPluginFile(`${pid}/${clean}`);
      },
      async json(path) { return JSON.parse(await this.text(path)); },
      async spreadsheetText(file) {
        requirePermission(man, pid, "ui");
        return spreadsheetFileToCsv(file);
      },
      // 文本真正落盘到系统下载目录（返回完整路径）。<a download> 在 Tauri WebView 里不可靠
      async saveText(filename, text) {
        requirePermission(man, pid, "ui");
        return api.saveDownload(String(filename || ""), String(text ?? ""));
      },
      // 二进制落盘（附件、图片）：base64 与 tide.http.fetch 的 binary: true 同格式。
      // 别拿 saveText 存二进制 —— 那个按文本写，docx / pdf 会坏。
      async saveBase64(filename, base64) {
        requirePermission(man, pid, "ui");
        return api.saveDownloadBase64(String(filename || ""), String(base64 ?? ""));
      },
    },

    notify: (msg, opts) => { requirePermission(man, pid, "notify"); return toast(`${man.name}：${msg}`, opts); },

    // 提醒声音：与应用设置里的「任务提醒」共用一份音效目录（src/sound.js），
    // 插件不需要自带音频资源，也不用自己碰 AudioContext。
    sound: {
      presets: () => {
        requirePermission(man, pid, "sound");
        return BUILTIN_SOUNDS.map(({ id, label, note }) => ({ id, label, note }));
      },
      play: ({ sound, volume, customAudio } = {}) => {
        requirePermission(man, pid, "sound");
        return playSound({ sound: resolveSound(sound), volume, customAudio });
      },
    },

    events: {
      on(name, fn) {
        requirePermission(man, pid, "events");
        if (!eventBus.has(name)) eventBus.set(name, new Set());
        eventBus.get(name).add({ pluginId: pid, fn });
      },
      emit(name, data) {
        requirePermission(man, pid, "events");
        // 消息类插件的 notice:new 由宿主抄一份进跨插件队列，见 collectNotice 注释。
        if (name === "notice:new") collectNotice(data, pid);
        (eventBus.get(name) || []).forEach((entry) => { try { entry.fn(data); } catch (e) { console.error(e); } });
      },
    },

    // 跨插件消息视图：新消息由 notice:new 抄收，历史列表由插件主动公开摘要。
    messages: {
      list: (limit = 30) => { requirePermission(man, pid, "messages"); return listNotices(limit); },
      publish: (items) => { requirePermission(man, pid, "events"); publishPluginMessages(pid, man.name, items); },
    },

    // 网络桥：Rust 端抓取，绕开 WebView CORS；每次调用都会校验插件是否在 manifest 中声明了 http 能力。
    http: {
      get: (url) => { requirePermission(man, pid, "http"); return api.httpGet(url); },
      // 图标抓取：返回 data URL。必须走这里而不是 `<img src=远程地址>` ——
      // Android 页面来源是 https，WebView 会拦掉 http 图标（详见 api.js 注释）。
      getIcon: (url) => { requirePermission(man, pid, "http"); return api.httpGetIcon(url); },
      getCached: (url, ttlMs) => { requirePermission(man, pid, "http"); return cachedHttpGet(url, ttlMs); },
      session: () => { requirePermission(man, pid, "http"); return api.httpSessionNew(); },
      fetch: (sid, method, url, opts) => { requirePermission(man, pid, "http"); return api.httpFetch(sid, method, url, opts); },
      // Cookie 整体导出/恢复：插件把登录态存进密钥库，应用重启后恢复，免验证码续期。
      exportCookies: (sid, urls) => { requirePermission(man, pid, "http"); return api.httpSessionExport(sid, urls); },
      restoreCookies: (cookies) => { requirePermission(man, pid, "http"); return api.httpSessionRestore(cookies); },
    },

    // AI 对话桥：复用「设置 › AI 与自动任务」里用户自己配的 Base URL / 模型 / Key。
    //
    // 为什么只给两个方法、不做加工：凭据只在 Rust 侧的 AES-256-GCM 保险箱里，
    // 前端与插件都拿不到 key；上游是 OpenAI 兼容的 `/chat/completions`，
    // **非流式** —— 一次请求拿回整段文本，所以插件侧要自己处理「等待态」。
    // Rust 侧的硬限制（一次 ≤24 条消息、文本总量 ≤60000 字符）原样抛中文错误，
    // 上下文裁剪是调用方的事，宿主不替插件偷偷删消息 —— 静默丢上下文比报错更难查。
    ai: {
      chat: (messages, opts = {}) => {
        requirePermission(man, pid, "ai");
        return api.aiChat(messages, opts.temperature);
      },
      // {configured, baseUrl, model, keyMasked}：插件据此决定是问 AI 还是引导去配置。
      status: () => { requirePermission(man, pid, "ai"); return api.aiVaultStatus(); },
    },

    schoolImporter: {
      open: ({ url, script, title }) => { requirePermission(man, pid, "schoolImport"); return api.schoolImportOpen(url, script, title); },
      onMessage: (handler) => { requirePermission(man, pid, "schoolImport"); return api.schoolImportListen(handler); },
    },

    // 加密密钥库：值只存 Rust 侧 AES-256-GCM 文件，不进 data.json / 备份 / 同步。
    vault: {
      get: (key) => { requirePermission(man, pid, "vault"); return api.pluginVaultGet(pid, key); },
      set: (key, value) => { requirePermission(man, pid, "vault"); return api.pluginVaultSet(pid, key, value); },
      del: (key) => { requirePermission(man, pid, "vault"); return api.pluginVaultDel(pid, key); },
    },

    util: {
      today: S.todayStr, addDays: S.addDays, mmOf: S.mmOf, hhmmOf: S.hhmmOf, durLabel: S.durLabel,
      openUrl: (url) => { requirePermission(man, pid, "openUrl"); return api.openUrl(url); },
      openCampusSite: (site) => {
        requirePermission(man, pid, "openUrl");
        if (pid !== "cppu-webvpn") throw new Error("校园网站窗口仅对警大 WebVPN 插件开放");
        return api.openCampusSite(site);
      },
      openCardPage: (url) => {
        requirePermission(man, pid, "openUrl");
        if (pid !== "cppu-notify") throw new Error("一卡通网页窗口仅对警大插件开放");
        return api.openCardPage(url);
      },
      openUrlWithSession: (url, sid) => {
        requirePermission(man, pid, "openUrl");
        requirePermission(man, pid, "http");
        if (pid !== "chaoxing-notify") throw new Error("网页登录态转交仅对学习通插件开放");
        return api.openUrlWithHttpSession(url, sid);
      },
      parseWhen: (...args) => { requirePermission(man, pid, "timeParse"); return parseWhen(...args); },
      guessCategory: (...args) => { requirePermission(man, pid, "timeParse"); return guessCategory(...args); },
      guessQuad: (...args) => { requirePermission(man, pid, "timeParse"); return guessQuad(...args); },
      navigate: (view) => { requirePermission(man, pid, "ui"); return window.dispatchEvent(new CustomEvent("tide:navigate", { detail: view })); },
      desEncryptHex: (plain, key) => { requirePermission(man, pid, "http"); return api.desEncryptHex(plain, key); },
      web: {
        normalizeUrl: (...args) => { requirePermission(man, pid, "http"); return normalizeWebUrl(...args); },
        resolveUrl: (...args) => { requirePermission(man, pid, "http"); return resolveWebUrl(...args); },
        parseSiteMeta: (...args) => { requirePermission(man, pid, "http"); return parseSiteMeta(...args); },
        inferIconName: (...args) => { requirePermission(man, pid, "http"); return inferSiteIconName(...args); },
        extractNoticeLinks: (...args) => { requirePermission(man, pid, "http"); return extractNoticeLinks(...args); },
        extractPager: (...args) => { requirePermission(man, pid, "http"); return extractPager(...args); },
        detectSpaShell: (...args) => { requirePermission(man, pid, "http"); return detectSpaShell(...args); },
        matchJsonSiteAdapter: (...args) => { requirePermission(man, pid, "http"); return matchJsonSiteAdapter(...args); },
        buildJsonSiteListUrl: (...args) => { requirePermission(man, pid, "http"); return buildJsonSiteListUrl(...args); },
        parseJsonSiteList: (...args) => { requirePermission(man, pid, "http"); return parseJsonSiteList(...args); },
        parseGenericNoticeJson: (...args) => { requirePermission(man, pid, "http"); return parseGenericNoticeJson(...args); },
        extractEmbeddedJsonNotices: (...args) => { requirePermission(man, pid, "http"); return extractEmbeddedJsonNotices(...args); },
        extractNoticeApiCandidates: (...args) => { requirePermission(man, pid, "http"); return extractNoticeApiCandidates(...args); },
        noticeKind: (...args) => { requirePermission(man, pid, "http"); return noticeKind(...args); },
        extractArticleText: (...args) => { requirePermission(man, pid, "http"); return extractArticleText(...args); },
        detectLoginForm: (...args) => { requirePermission(man, pid, "http"); return detectLoginForm(...args); },
        formEncode: (...args) => { requirePermission(man, pid, "http"); return formEncode(...args); },
      },
    },
  };
}

/**
 * 由**宿主核心**向插件广播事件（插件与插件之间用 `tide.events.emit`）。
 *
 * 为什么需要它：核心要做的事，有些**必须由插件自己落地**。典型例子是 AI 解析出的课程
 * 要写进课表 —— 核心直接写插件的 storage 会绕过插件的内存副本，而课程表 `ui.js`
 * 的 `loadAll` 会把 tables/table 缓存在内存里，下一次它自己保存就把新数据覆盖回去了。
 * 广播出去、由插件用 `M.normalize` + `M.mergeTables` + `persist` 走自己的链路才安全。
 *
 * **返回每个订阅者的处理结果**，让调用方能区分三种情况：
 * 没有订阅者（`[]`）⇒ 要降级；处理成功；处理抛错 ⇒ 要报错。
 * 混成一个布尔值就只能靠猜，而「静默丢数据」是这个项目最不能接受的结果。
 *
 * 异步：插件的处理常常要落盘（`persist`），不等它就没法知道到底成没成。
 */
export async function emitPluginEvent(name, data) {
  const set = eventBus.get(name);
  if (!set || !set.size) return [];
  const results = [];
  for (const entry of set) {
    try {
      results.push({ pluginId: entry.pluginId, ok: true, value: await entry.fn(data) });
    } catch (error) {
      console.error(`插件 ${entry.pluginId} 处理事件 ${name} 失败:`, error);
      results.push({ pluginId: entry.pluginId, ok: false, error: String(error?.message || error) });
    }
  }
  return results;
}

function removeRegistrations(id) {
  for (let i = pluginViews.length - 1; i >= 0; i--) if (pluginViews[i].pluginId === id) pluginViews.splice(i, 1);
  for (let i = taskActions.length - 1; i >= 0; i--) if (taskActions[i].pluginId === id) taskActions.splice(i, 1);
  for (const [name, set] of eventBus) {
    for (const entry of [...set]) if (entry.pluginId === id) set.delete(entry);
    if (!set.size) eventBus.delete(name);
  }
  listeners.taskActionsChanged.forEach((f) => f());
}

async function runPlugin(id, source) {
  const rec = registry.get(id);
  try {
    rec.error = null;
    rec.loaded = false;
    removeRegistrations(id);
    const code = await loadCode(rec.manifest, source);
    // 受控沙箱：插件只拿到 tide API，拿不到全局 window
    new Function("tide", `"use strict";\n${code}`)(makeApi(rec.manifest, source));
    rec.loaded = true;
  } catch (e) {
    rec.error = String(e && e.message || e);
    console.error(`插件 ${id} 加载失败:`, e);
  }
}

export async function initPluginHost() {
  const sources = [
    ...BUILTIN_IDS.map((id) => ({ id, source: "builtin" })),
    ...(await api.listPlugins().catch(() => [])).map((p) => ({ id: p.id, source: "external" })),
  ];
  const fresh = sources.filter(({ id }) => !registry.has(id));
  const records = await Promise.all(fresh.map(async ({ id, source }) => {
    const rec = { id, source, manifest: null, enabled: true, error: null, loaded: false, code: null };
    registry.set(id, rec);
    try {
      rec.manifest = await loadManifest(id, source);
      rec.manifest.id = rec.manifest.id || id;
      S.pluginState(id);
      if (S.pluginState(id).enabled !== false) rec.code = await loadCode(rec.manifest, source);
    } catch (e) {
      rec.error = String(e && e.message || e);
    }
    return rec;
  }));

  // 清单和入口文件并行读取；插件执行之间主动让出主线程，避免大插件连续解析造成首屏卡顿。
  for (const rec of records) {
    if (!rec.manifest || rec.error || S.pluginState(rec.id).enabled === false) continue;
    await yieldUi();
    try {
      removeRegistrations(rec.id);
      new Function("tide", `"use strict";\n${rec.code}`)(makeApi(rec.manifest, rec.source));
      rec.loaded = true;
      rec.code = null;
    } catch (e) {
      rec.error = String(e && e.message || e);
      console.error(`插件 ${rec.id} 加载失败:`, e);
    }
  }
  emitNavChanged();
}

export async function setEnabled(id, on) {
  S.setPluginEnabled(id, on);
  const rec = registry.get(id);
  if (!rec) return;
  rec.enabled = on;
  if (on) await runPlugin(id, rec.source);
  if (!on) {
    // 从导航、任务动作、事件订阅里摘掉该插件注册的内容
    removeRegistrations(id);
    rec.loaded = false;
  }
  emitNavChanged();
}

export async function removeExternalPlugin(id) {
  const rec = registry.get(id);
  if (!rec) throw new Error("插件不存在");
  if (rec.source === "builtin") throw new Error("内置插件不能删除，可停用");
  await setEnabled(id, false);
  await api.deletePlugin(id);
  S.removePluginState(id);
  registry.delete(id);
  emitNavChanged();
}

// 清空注册表后重新发现并加载插件（设置页「重新扫描」用）
export async function rescan() {
  pluginViews.length = 0;
  taskActions.length = 0;
  registry.clear();
  await initPluginHost();
}
