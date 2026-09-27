// 可选同步层 v2：本地数据仍是事实源；WebDAV 只是显式推送/拉取的远端快照，不后台自动上传。
// v2 起应用密码可选地存进 Rust 侧密钥库（AES-256-GCM 文件）—— 仍然不进 data.json、
// 不进完整备份、也就不会跟着快照上传到网盘。账号体系依旧没有。
import { api } from "./api.js";

function utf8Base64(text) {
  const bytes = new TextEncoder().encode(String(text || ""));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function normalizeWebDavUrl(raw) {
  const url = new URL(String(raw || "").trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error("WebDAV 地址只支持 http/https");
  return url.toString();
}

function authHeaders(username, password) {
  const headers = { Accept: "application/json" };
  if (username || password) headers.Authorization = `Basic ${utf8Base64(`${username || ""}:${password || ""}`)}`;
  return headers;
}

export function makeSnapshot(data, appVersion = "") {
  return {
    format: "le-time-management-sync",
    schema: 1,
    appVersion: String(appVersion || ""),
    exportedAt: new Date().toISOString(),
    data: structuredClone(data),
  };
}

export function parseSnapshot(raw) {
  let obj;
  try { obj = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { throw new Error("远端文件不是有效 JSON"); }
  if (obj?.format === "le-time-management-sync" && obj?.data) return obj;
  // 兼容旧版直接上传 data.json 的情况。
  if (obj && Array.isArray(obj.tasks) && Array.isArray(obj.blocks)) {
    return { format: "legacy-data-json", schema: 0, exportedAt: null, appVersion: "", data: obj };
  }
  throw new Error("远端文件不是 U-Time 可识别的同步快照");
}

export async function uploadWebDav({ url, username, password, data, appVersion }) {
  const target = normalizeWebDavUrl(url);
  const sid = await api.httpSessionNew();
  const snapshot = makeSnapshot(data, appVersion);
  const res = await api.httpFetch(sid, "PUT", target, {
    headers: { ...authHeaders(username, password), "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(snapshot, null, 2),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(describeWebDavFailure(res.status, "put"));
  return { status: res.status, snapshot };
}

export async function downloadWebDav({ url, username, password }) {
  const target = normalizeWebDavUrl(url);
  const sid = await api.httpSessionNew();
  const res = await api.httpFetch(sid, "GET", target, { headers: authHeaders(username, password) });
  if (res.status < 200 || res.status >= 300) throw new Error(describeWebDavFailure(res.status, "get"));
  return parseSnapshot(res.body);
}

export function isPotentiallyUnsafeWebDav(raw) {
  try {
    const url = new URL(String(raw || "").trim());
    return url.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch { return false; }
}

/* ═══════════ 网盘引导层：预设 / 探测目录 / 自动建目录 / 密码入库 ═══════════ */

/* 小白配 WebDAV 的三道墙：不知道根地址长什么样、不知道去哪拿「应用密码」、
   不知道目录必须先存在才能 PUT（否则 409）。预设解决第一道，howto 解决第二道，
   ensureWebDavFolder 解决第三道 —— 三道都在「一键配好」里替他走完。 */
export const WEBDAV_PRESETS = [
  {
    id: "jianguoyun",
    label: "坚果云",
    tagline: "国内直连、免费版够用，最省事",
    root: "https://dav.jianguoyun.com/dav",
    rootEditable: false,
    folder: "U-Time",
    accountLabel: "账号（登录邮箱）",
    accountPlaceholder: "you@example.com",
    passwordLabel: "应用密码",
    passwordPlaceholder: "按下面步骤生成，只有 32 位那一串",
    helpUrl: "https://www.jianguoyun.com/#/safe",
    helpLinkText: "打开坚果云后台",
    howto: [
      "在电脑浏览器打开 jianguoyun.com 并登录（手机上操作更麻烦，建议用电脑）",
      "右上角头像 →「账户信息」→ 左侧「安全选项」→「第三方应用管理」",
      "点「添加应用」，名字随便填（比如 U-Time），然后点生成",
      "把弹出来的那串密码复制、贴到左边 —— 它只显示这一次，关掉就得重新生成",
    ],
    howtoNote: "这里的密码不是网页登录密码。拿登录密码来填，一律会报「账号或密码不对」。",
  },
  {
    id: "nextcloud",
    label: "Nextcloud / ownCloud",
    tagline: "自己搭的云，地址要自己填",
    root: "",
    rootEditable: true,
    rootPlaceholder: "https://cloud.example.com/remote.php/dav/files/你的用户名",
    folder: "U-Time",
    accountLabel: "账号（登录用户名）",
    accountPlaceholder: "你的用户名",
    passwordLabel: "密码或应用密码",
    passwordPlaceholder: "Nextcloud 设置 → 安全 → 设备和应用密码",
    helpUrl: "",
    helpLinkText: "",
    howto: [
      "根地址必须填到 /remote.php/dav/files/用户名 这一层，只填域名会一直报找不到",
      "Nextcloud 若开了 2FA，要在网页「设置 → 安全 → 设备和应用密码」里单独生成一个密码",
    ],
    howtoNote: "",
  },
  {
    id: "custom",
    label: "其他 WebDAV",
    tagline: "黑群晖 / Alist / 自建 Apache 等，填根地址",
    root: "",
    rootEditable: true,
    rootPlaceholder: "https://example.com/dav 或 http://192.168.1.10:5005",
    folder: "U-Time",
    accountLabel: "账号",
    accountPlaceholder: "用户名",
    passwordLabel: "密码",
    passwordPlaceholder: "该 WebDAV 服务的密码",
    helpUrl: "",
    helpLinkText: "",
    howto: [
      "根地址填到「能看见文件列表」的那一层，不要带上文件名",
      "文件夹名可以留空，留空就把快照直接放在根目录",
      "只有 http:// 的地址，密码在内网里是明文走的，建议只在自己的局域网用",
    ],
    howtoNote: "",
  },
];

export const DEFAULT_SYNC_FILE_NAME = "le-time-data.json";
const SYNC_VAULT_PLUGIN_ID = "core-webdav";
const SYNC_VAULT_KEY = "webdav-password";

export function getPreset(id) {
  return WEBDAV_PRESETS.find((p) => p.id === id) || WEBDAV_PRESETS[WEBDAV_PRESETS.length - 1];
}

function splitFolderSegments(folder) {
  return String(folder || "").split("/").map((s) => s.trim()).filter(Boolean);
}

/** 根地址 + 文件夹 + 文件名 → 快照的完整 URL。每一段单独转义，中文文件夹名才不会被拼错。 */
export function buildDavUrl({ root, folder, fileName } = {}) {
  const url = new URL(String(root || "").trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error("网盘地址只支持 http/https");
  const base = url.pathname.replace(/\/+$/, "");
  const segments = [
    ...base.split("/").filter(Boolean).map((s) => decodeOrKeep(s)),
    ...splitFolderSegments(folder),
    String(fileName || DEFAULT_SYNC_FILE_NAME).trim() || DEFAULT_SYNC_FILE_NAME,
  ].map(encodeURIComponent);
  url.pathname = `/${segments.join("/")}`;
  return url.toString();
}

function decodeOrKeep(raw) {
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** 反向解析：把老用户只存了整条 url 的情况拆开。
 *  只返回 origin 与路径段，不猜"哪里算根地址" —— 坚果云的根自带 /dav，
 *  自建服务的根可能带三层路径，边界只有调用方（拿预设去比）知道。 */
export function splitDavUrl(raw) {
  const url = new URL(normalizeWebDavUrl(raw));
  const segments = url.pathname.split("/").filter(Boolean).map(decodeOrKeep);
  const fileName = segments.pop() || DEFAULT_SYNC_FILE_NAME;
  return { origin: url.origin, segments, fileName };
}

/** origin + 若干路径段 → 不带结尾斜杠的根地址。 */
export function composeDavRoot(origin, segments = []) {
  const url = new URL(`${origin}/`);
  url.pathname = `/${segments.filter(Boolean).map(encodeURIComponent).join("/")}`;
  return url.toString().replace(/\/+$/, "");
}

/** 一个根地址自带几层路径（坚果云是 1 层：/dav），用来把整条 url 切出"根以下的文件夹"。 */
export function davRootDepth(root) {
  try { return new URL(String(root || "").trim()).pathname.split("/").filter(Boolean).length; }
  catch { return 0; }
}

/**
 * v0.5x 的老用户只存过整条 url，这里就地拆成「根地址 + 文件夹 + 文件名」，别让人重配一遍。
 * 放在同步层而不是引导卡里：它是纯数据迁移，测试不必为此拉起 DOM。
 */
export function migrateLegacyUrl(cfg) {
  if (cfg.presetId || !cfg.url) return;
  try {
    const { origin, segments, fileName } = splitDavUrl(cfg.url);
    const hit = WEBDAV_PRESETS.find((p) => !p.rootEditable && p.root.startsWith(origin) && davRootDepth(p.root) <= segments.length);
    Object.assign(cfg, {
      presetId: hit ? hit.id : "custom",
      root: hit ? hit.root : composeDavRoot(origin, segments),
      folder: hit ? segments.slice(davRootDepth(hit.root)).join("/") : "",
      fileName,
    });
  } catch {
    cfg.presetId = "custom";
  }
}

/** 快照所在目录的地址（PROPFIND / MKCOL 打在它上面，不是打在文件上）。 */
export function buildDavFolderUrl({ root, folder } = {}) {
  const url = new URL(String(root || "").trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error("网盘地址只支持 http/https");
  const base = url.pathname.replace(/\/+$/, "");
  const segments = [
    ...base.split("/").filter(Boolean).map(decodeOrKeep),
    ...splitFolderSegments(folder),
  ].map(encodeURIComponent);
  url.pathname = `/${segments.join("/")}`;
  return url.toString();
}

/* ── 连接探测 ── */

// PROPFIND 不带 body 会被一部分服务端（含 Nextcloud）直接拒掉，所以按 RFC 发最小查询体。
const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';

/** PROPFIND 一个目录，返回 HTTP 状态码。207=存在，404=不存在，401/403=凭据问题。 */
async function statDavCollection({ url, username, password, sid }) {
  const own = sid || (await api.httpSessionNew());
  const res = await api.httpFetch(own, "PROPFIND", url, {
    headers: { ...authHeaders(username, password), "Content-Type": "application/xml; charset=utf-8", Depth: "0" },
    body: PROPFIND_BODY,
  });
  return { status: res.status, sid: own };
}

/**
 * 把快照要放的目录一层层建出来。
 * 已存在的层直接跳过，所以重复点「一键配好」是幂等的；405（服务端说「这儿已经有了」）
 * 也按成功处理 —— 坚果云和 Apache 在这件事上说法就不一样，不该让用户承担差异。
 */
export async function ensureWebDavFolder({ root, folder, username, password }) {
  const segments = splitFolderSegments(folder);
  if (!segments.length) return { created: [], folderUrl: buildDavFolderUrl({ root, folder: "" }) };
  const sid = await api.httpSessionNew();
  const created = [];
  let current = String(root || "").replace(/\/+$/, "");
  for (const seg of segments) {
    current = `${current}/${encodeURIComponent(seg)}`;
    const { status } = await statDavCollection({ url: `${current}/`, username, password, sid });
    if (status === 207 || status === 200) continue;
    if (status === 401 || status === 403) throw new Error(describeWebDavFailure(status, "auth"));
    // 集合形式（带尾斜杠）是 RFC 4918 的写法：不带时 Apache 会先回 301 再重发一次。
    const mk = await api.httpFetch(sid, "MKCOL", `${current}/`, { headers: authHeaders(username, password) });
    if (mk.status !== 201 && mk.status !== 204 && mk.status !== 405) {
      throw new Error(describeWebDavFailure(mk.status, "mkcol"));
    }
    created.push(seg);
  }
  return { created, folderUrl: current };
}

/**
 * 「一键配好」的第一步：只验账号，不动任何文件。
 * 拿根目录的 PROPFIND 当登录检查用 —— 401 和 404 的区分度比拿快照文件探更好，
 * 因为快照文件还不存在时它两种情况都会回 404，看不出是密码错了还是路径错了。
 */
export async function testWebDavConnection({ root, username, password }) {
  const folderUrl = buildDavFolderUrl({ root, folder: "" });
  const { status } = await statDavCollection({ url: `${folderUrl}/`, username, password });
  if (status === 401 || status === 403) throw new Error(describeWebDavFailure(status, "auth"));
  if (status === 404) throw new Error(describeWebDavFailure(404, "auth"));
  return { status };
}

const WEBDAV_FAILURES = {
  400: "网盘看不懂这个请求。检查一下文件夹名里是不是有 / \\ : * ? \" < > | 这些字符",
  401: "账号或密码不对。坚果云要填的是「第三方应用管理」里生成的应用密码，不是网页登录密码",
  403: "账号能登录，但这个位置不让写。换一个属于你自己账号的目录试试",
  404: "地址找不到。坚果云的根地址应以 /dav 结尾；Nextcloud 必须填到 /remote.php/dav/files/用户名 那一层",
  405: "这个网盘不支持刚才的操作",
  409: "上级目录还不存在，没能把这一层建出来",
  412: "网盘要求条件请求头，这类服务通常不兼容普通 WebDAV 客户端",
  423: "这个文件被别的客户端锁住了，先解除锁定或换个文件名",
  503: "网盘暂时不服务，过一会儿再试",
  507: "网盘空间满了，传不上去",
};
const WEBDAV_ACTION_LABELS = { auth: "登录网盘", mkcol: "建目录", put: "上传快照", get: "读快照" };

/** 状态码 → 人话。小白看不懂 401，但看得懂「那串密码不是登录密码」。 */
export function describeWebDavFailure(status, action = "") {
  // 下载时的 404 和填错地址的 404 完全是两回事，分开说，否则人会去反复检查明明对的根地址。
  if (status === 404 && action === "get") {
    return "网盘上还没有这份快照文件。第一次用请先点「上传本地 → 网盘」传一份上去；如果传过，检查这一台设备填的地址和那台是不是完全一样";
  }
  const base = WEBDAV_FAILURES[status];
  if (base) return `${base}（HTTP ${status}）`;
  if (status >= 500) return `网盘服务端出错（HTTP ${status}），稍后再试`;
  return `${WEBDAV_ACTION_LABELS[action] || "访问网盘"}失败（HTTP ${status}）`;
}

/** 网络层异常也翻成中文 —— Rust 侧回的是 "请求失败: error sending request"，直接甩给用户没用。 */
export function describeSyncError(e) {
  const msg = String(e?.message || e || "未知错误");
  if (/error sending request|dns|failed to lookup|connection refused|timed? ?out|network/i.test(msg)) {
    return "连不上这个地址。检查一下本机能不能上网，以及地址里的端口、域名有没有写错";
  }
  if (/invalid url|relative url|只支持 http/i.test(msg)) return "地址格式不对，得是 http:// 或 https:// 开头的完整地址";
  return msg;
}

/* ── 应用密码的持久化 ── */
/* 走 Rust 侧 AES-256-GCM 密钥库，和 AI 的 API Key 同一套：
   不进 data.json、不进完整备份、也就不会被一起同步到网盘上。 */

export async function saveStoredSyncPassword(password) {
  const value = String(password || "");
  if (!value) return false;
  await api.pluginVaultSet(SYNC_VAULT_PLUGIN_ID, SYNC_VAULT_KEY, value);
  return true;
}

export async function loadStoredSyncPassword() {
  try { return (await api.pluginVaultGet(SYNC_VAULT_PLUGIN_ID, SYNC_VAULT_KEY)) || ""; }
  catch { return ""; }
}

export async function clearStoredSyncPassword() {
  try { await api.pluginVaultDel(SYNC_VAULT_PLUGIN_ID, SYNC_VAULT_KEY); }
  catch { /* 浏览器调试环境没有密钥库，本来也没存过 */ }
}

