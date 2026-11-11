// GitHub 备份：只把仓库连接信息写入 settings，PAT 始终保存在原生密钥库。
// GitHub Contents API 直接上传 JSON 快照，避免引入额外压缩依赖和本地临时文件。
import { api } from "./api.js";
import { makeSnapshot, parseSnapshot } from "./syncLayer.js";

const VAULT_PLUGIN_ID = "core-github-backup";
const VAULT_KEY = "pat";
const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const DEFAULT_BRANCH = "main";
const DEFAULT_APP_NAME = "UTime";

function encodeUtf8Base64(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  return Buffer.from(bytes).toString("base64");
}

function decodeUtf8Base64(value) {
  if (typeof atob === "function") {
    const binary = atob(String(value || "").replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(String(value || ""), "base64").toString("utf8");
}

function safeSegment(raw, fallback = "device") {
  const value = String(raw || "").trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return value || fallback;
}

/** 只接受 github.com 的用户仓库，避免把 PAT 发送到任意主机。 */
export function parseGitHubRepository(raw) {
  let value = String(raw || "").trim();
  if (!value) throw new Error("请先填写 GitHub 仓库地址");
  if (value.startsWith("git@github.com:")) value = `https://github.com/${value.slice("git@github.com:".length)}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://github.com/${value}`;
  let url;
  try { url = new URL(value); } catch { throw new Error("GitHub 仓库地址格式不对"); }
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) {
    throw new Error("仓库地址必须是 github.com 上的 HTTPS 仓库");
  }
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts.length !== 2) throw new Error("仓库地址应为 https://github.com/用户/仓库");
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, "");
  const valid = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  if (!valid.test(owner) || !valid.test(name) || name === "." || name === "..") {
    throw new Error("GitHub 用户名或仓库名包含非法字符");
  }
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}.git`,
  };
}

export function defaultGitHubRepository(appName = DEFAULT_APP_NAME) {
  // 仓库名按应用名生成，但不把空格/标点变成容易混淆的多个分隔符。
  const safeName = String(appName || DEFAULT_APP_NAME).replace(/[^A-Za-z0-9]+/g, "").slice(0, 48) || DEFAULT_APP_NAME;
  return `Backup-${safeName}`;
}

function apiUrl(path) {
  return `${API_ROOT}${path.startsWith("/") ? path : `/${path}`}`;
}

function authHeaders(token, json = false) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${String(token || "")}`,
    "X-GitHub-Api-Version": API_VERSION,
  };
  if (json) headers["Content-Type"] = "application/json; charset=utf-8";
  return headers;
}

function parseJson(body) {
  try { return body ? JSON.parse(body) : null; } catch { return null; }
}

function describeGitHubFailure(status, action = "访问 GitHub") {
  if (status === 401) return "PAT 无效或已过期，请重新生成一个 GitHub Fine-grained PAT";
  if (status === 403) return "GitHub 拒绝了请求，请检查 PAT 权限、仓库权限或 API 限流状态";
  if (status === 404) return `${action}失败：仓库不存在，或 PAT 没有访问它的权限`;
  if (status === 409) return `${action}失败：仓库分支尚未准备好，请稍后重试`;
  if (status === 422) return `${action}失败：GitHub 拒绝了提交内容（可能是仓库名冲突）`;
  if (status >= 500) return `GitHub 服务暂时不可用（HTTP ${status}）`;
  return `${action}失败（HTTP ${status}）`;
}

async function githubRequest(token, method, path, body = null) {
  if (!String(token || "").trim()) throw new Error("还没有填写 GitHub PAT");
  const sid = await api.httpSessionNew();
  const response = await api.httpFetch(sid, method, apiUrl(path), {
    headers: authHeaders(token, body != null),
    body: body == null ? null : JSON.stringify(body),
  });
  const payload = parseJson(response.body);
  if (response.status < 200 || response.status >= 300) {
    const detail = payload?.message ? `：${payload.message}` : "";
    throw new Error(`${describeGitHubFailure(response.status)}${detail}`);
  }
  return payload;
}

export async function saveStoredGitHubToken(token) {
  const value = String(token || "").trim();
  if (!value) return false;
  await api.pluginVaultSet(VAULT_PLUGIN_ID, VAULT_KEY, value);
  return true;
}

export async function loadStoredGitHubToken() {
  try { return (await api.pluginVaultGet(VAULT_PLUGIN_ID, VAULT_KEY)) || ""; }
  catch { return ""; }
}

export async function clearStoredGitHubToken() {
  try { await api.pluginVaultDel(VAULT_PLUGIN_ID, VAULT_KEY); }
  catch { /* 浏览器调试环境没有密钥库 */ }
}

export async function getGitHubUser(token) {
  return githubRequest(token, "GET", "/user");
}

/** 连接已有仓库，并返回 API 返回的默认分支。 */
export async function connectGitHubRepository({ token, repository, branch = "" }) {
  const repo = parseGitHubRepository(repository);
  const data = await githubRequest(token, "GET", `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`);
  if (data?.private !== true) throw new Error("备份仓库必须是 Private，不能把任务数据写入公开仓库");
  return { ...repo, branch: String(branch || data?.default_branch || DEFAULT_BRANCH), private: Boolean(data?.private) };
}

/** 首次使用优先创建 Backup-UTime；同名仓库已存在时复用，不重复创建。 */
export async function createDefaultGitHubRepository({ token, appName = DEFAULT_APP_NAME } = {}) {
  const user = await getGitHubUser(token);
  const owner = String(user?.login || "").trim();
  if (!owner) throw new Error("GitHub 没有返回当前用户，无法创建备份仓库");
  const name = defaultGitHubRepository(appName);
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  try {
    const existing = await githubRequest(token, "GET", path);
    if (existing?.private !== true) {
      throw new Error(`同名仓库 ${owner}/${name} 已存在但不是 Private。为避免公开数据，请改用私有仓库或先处理该同名仓库`);
    }
    return {
      owner, name, fullName: `${owner}/${name}`,
      url: `https://github.com/${owner}/${name}.git`,
      branch: existing?.default_branch || DEFAULT_BRANCH,
      created: false, private: Boolean(existing?.private),
    };
  } catch (error) {
    if (!/仓库不存在|没有访问它的权限/.test(String(error?.message || ""))) throw error;
  }
  const created = await githubRequest(token, "POST", "/user/repos", {
    name,
    private: true,
    description: "U-Time private data backups",
    auto_init: true,
  });
  return {
    owner: created?.owner?.login || owner,
    name: created?.name || name,
    fullName: `${created?.owner?.login || owner}/${created?.name || name}`,
    url: created?.html_url ? `${created.html_url}.git` : `https://github.com/${owner}/${name}.git`,
    branch: created?.default_branch || DEFAULT_BRANCH,
    created: true, private: Boolean(created?.private),
  };
}

function contentsPath(repo, deviceName, fileName = "") {
  const safeDevice = safeSegment(deviceName, "device");
  const suffix = fileName ? `/${safeSegment(fileName, "backup.json")}` : "";
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/.utime/backups/${encodeURIComponent(safeDevice)}${suffix}`;
}

function backupFileName(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `backup-${iso}-${Math.random().toString(36).slice(2, 8)}.json`;
}

export async function uploadGitHubBackup({ token, repository, branch = DEFAULT_BRANCH, deviceName = "UTime", data, appVersion = "" } = {}) {
  const repo = parseGitHubRepository(repository);
  const fileName = backupFileName();
  const snapshot = makeSnapshot(data, appVersion);
  const payload = await githubRequest(token, "PUT", contentsPath(repo, deviceName, fileName), {
    message: `U-Time backup ${snapshot.exportedAt}`,
    branch: branch || DEFAULT_BRANCH,
    content: encodeUtf8Base64(JSON.stringify(snapshot, null, 2)),
  });
  return { repo, branch: branch || DEFAULT_BRANCH, deviceName: safeSegment(deviceName), fileName, path: payload?.content?.path || contentsPath(repo, deviceName, fileName), sha: payload?.content?.sha || "", snapshot };
}

export async function listGitHubBackups({ token, repository, branch = DEFAULT_BRANCH, deviceName = "UTime" } = {}) {
  const repo = parseGitHubRepository(repository);
  const path = contentsPath(repo, deviceName);
  const query = `?ref=${encodeURIComponent(branch || DEFAULT_BRANCH)}`;
  const items = await githubRequest(token, "GET", `${path}${query}`);
  if (!Array.isArray(items)) return [];
  return items.filter((item) => item?.type === "file" && /^backup-[^/]+\.json$/i.test(String(item.name || "")))
    .sort((a, b) => String(b.name).localeCompare(String(a.name)))
    .map((item) => ({ name: item.name, path: item.path, sha: item.sha, size: item.size || 0, url: item.html_url || "" }));
}

export async function downloadGitHubBackup({ token, repository, branch = DEFAULT_BRANCH, path } = {}) {
  const repo = parseGitHubRepository(repository);
  const safePath = String(path || "").replace(/^\/+/, "");
  if (!safePath.startsWith(".utime/backups/") || safePath.includes("..")) throw new Error("备份路径不合法");
  const payload = await githubRequest(token, "GET", `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/${safePath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch || DEFAULT_BRANCH)}`);
  if (!payload?.content) throw new Error("GitHub 没有返回备份内容");
  return { ...payload, snapshot: parseSnapshot(decodeUtf8Base64(payload.content)) };
}

export async function deleteGitHubBackup({ token, repository, branch = DEFAULT_BRANCH, path, sha } = {}) {
  const repo = parseGitHubRepository(repository);
  const safePath = String(path || "").replace(/^\/+/, "");
  if (!safePath.startsWith(".utime/backups/") || safePath.includes("..")) throw new Error("备份路径不合法");
  if (!sha) throw new Error("缺少远端备份版本标识");
  return githubRequest(token, "DELETE", `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/contents/${safePath.split("/").map(encodeURIComponent).join("/")}`, {
    message: `Delete U-Time backup ${safePath.split("/").pop()}`,
    sha,
    branch: branch || DEFAULT_BRANCH,
  });
}

/** 自动备份只使用已经连接好的仓库，不在后台偷偷创建云端仓库。 */
export async function maybeRunGitHubAutoBackup({ config, data, appVersion = "" } = {}) {
  if (!config?.enabled || !config.repository) return { skipped: true, reason: "disabled" };
  const intervalHours = Math.min(24 * 30, Math.max(1, Number(config.intervalHours) || 24));
  const last = Date.parse(config.lastBackupAt || "") || 0;
  if (Date.now() - last < intervalHours * 3600000) return { skipped: true, reason: "not-due" };
  const token = await loadStoredGitHubToken();
  if (!token) return { skipped: true, reason: "no-token" };
  const result = await uploadGitHubBackup({ token, repository: config.repository, branch: config.branch || DEFAULT_BRANCH, deviceName: config.deviceName || "UTime", data, appVersion });
  config.lastBackupAt = result.snapshot.exportedAt;
  return { skipped: false, result };
}

