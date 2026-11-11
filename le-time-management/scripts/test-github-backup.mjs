import assert from "node:assert/strict";
import { readProductSource } from "./lib/read-product-source.mjs";

const read = (rel) => readProductSource(new URL(rel, import.meta.url), "utf8");
const calls = [];
const vault = new Map();
const files = new Map();
let nextSha = 1;

function reply(status, body = {}) {
  return { status, body: JSON.stringify(body), finalUrl: "", contentType: "application/json", location: "", cookies: [] };
}

function githubServer({ method, url, headers, body }) {
  const parsed = new URL(url);
  const path = decodeURIComponent(parsed.pathname);
  calls.push({ method, path, headers, body: body ? JSON.parse(body) : null });
  assert.equal(headers.Authorization, "Bearer ghp-test-token", "PAT 只能进入 Authorization header");
  assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
  if (method === "GET" && path === "/user") return reply(200, { login: "alice" });
  if (method === "GET" && (path === "/repos/alice/Backup-UTime" || path === "/repos/alice/Backup-U-Time")) return reply(404, { message: "Not Found" });
  if (method === "POST" && path === "/user/repos") return reply(201, { name: "Backup-UTime", owner: { login: "alice" }, default_branch: "main", private: true, html_url: "https://github.com/alice/Backup-UTime" });
  if (method === "PUT" && path.includes("/.utime/backups/UTime/")) {
    const name = path.split("/").pop();
    const sha = `sha-${nextSha++}`;
    const contentPath = path.split("/contents/")[1];
    files.set(path, { ...calls.at(-1).body, sha, name, path: contentPath });
    return reply(201, { content: { path: contentPath, sha } });
  }
  if (method === "GET" && path.endsWith("/.utime/backups/UTime")) {
    return reply(200, [...files.entries()].map(([p, value]) => ({ type: "file", name: value.name, path: value.path, sha: value.sha, size: 100 })));
  }
  if (method === "GET" && path.includes("/.utime/backups/UTime/")) {
    const value = files.get(path);
    return value ? reply(200, { content: value.content, path: value.path, sha: value.sha }) : reply(404, { message: "Not Found" });
  }
  if (method === "DELETE" && path.includes("/.utime/backups/UTime/")) return reply(200, {});
  return reply(500, { message: `unhandled ${method} ${path}` });
}

globalThis.window = {
  __TAURI_INTERNALS__: {
    invoke: async (command, args = {}) => {
      if (command === "http_session_new") return "github-test-session";
      if (command === "http_fetch") return githubServer(args);
      if (command === "plugin_vault_set") { vault.set(`${args.pluginId}:${args.key}`, args.value); return null; }
      if (command === "plugin_vault_get") return vault.get(`${args.pluginId}:${args.key}`) || null;
      if (command === "plugin_vault_del") { vault.delete(`${args.pluginId}:${args.key}`); return null; }
      throw new Error(`unhandled command ${command}`);
    },
  },
};

const G = await import("../src/githubBackup.js");
const S = await import("../src/syncLayer.js");

assert.deepEqual(G.parseGitHubRepository("git@github.com:alice/Backup-UTime.git"), {
  owner: "alice", name: "Backup-UTime", fullName: "alice/Backup-UTime", url: "https://github.com/alice/Backup-UTime.git",
});
assert.throws(() => G.parseGitHubRepository("https://evil.example/alice/repo"), /github.com/);
assert.equal(G.defaultGitHubRepository("U-Time"), "Backup-UTime");

await G.saveStoredGitHubToken("ghp-test-token");
assert.equal(await G.loadStoredGitHubToken(), "ghp-test-token");
const created = await G.createDefaultGitHubRepository({ token: "ghp-test-token", appName: "U-Time" });
assert.equal(created.fullName, "alice/Backup-UTime");
assert.equal(created.private, true);

const uploaded = await G.uploadGitHubBackup({
  token: "ghp-test-token", repository: created.url, branch: created.branch, deviceName: "UTime",
  data: { tasks: [{ id: "t1", title: "秘密任务" }], blocks: [], settings: { sync: { github: { repository: created.url } } } }, appVersion: "0.295.0",
});
assert.match(uploaded.path, /^\.utime\/backups\/UTime\/backup-/);
const uploadCall = calls.find((call) => call.method === "PUT");
assert.equal(uploadCall.body.branch, "main");
assert.equal(uploadCall.body.content.includes("ghp-test-token"), false, "PAT 不得进入上传内容");

const rows = await G.listGitHubBackups({ token: "ghp-test-token", repository: created.url, deviceName: "UTime" });
assert.equal(rows.length, 1);
const restored = await G.downloadGitHubBackup({ token: "ghp-test-token", repository: created.url, path: rows[0].path });
assert.equal(restored.snapshot.data.tasks[0].title, "秘密任务");
await G.deleteGitHubBackup({ token: "ghp-test-token", repository: created.url, path: rows[0].path, sha: rows[0].sha });

assert.doesNotMatch(read("../src/githubBackup.js"), /settings\.[^\n]*pat/i);
assert.match(read("../src/views/settings/sync.js"), /createGitHubBackupSection/);
assert.match(read("../src/views/settings.js"), /GitHub PAT/);
assert.equal(S.parseSnapshot(JSON.stringify(restored.snapshot)).data.tasks[0].id, "t1");

console.log("PASS: GitHub 备份（github.com 校验 / 私有仓库自动创建 / Contents API / PAT 密钥库隔离 / 历史恢复与删除）");

