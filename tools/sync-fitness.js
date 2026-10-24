#!/usr/bin/env node
// 从企业微信 PC 端的 sessionStorage 里取出「我的体测」的 Authorization token，
// 顺手用它拉一次成绩，写进 U-Time 的插件缓存 —— 之后打开插件就是最新的。
//
// 为什么要这么绕：sport-wechat.cppu.edu.cn 只认企业微信 OAuth 发下来的 token
// （appid 绑死 wxwork，普通浏览器连授权页都过不去，见插件 fitness.js 头注释），
// 而 U-Time 里没有企业微信的浏览器环境。能拿到这枚 token 的唯一现成入口，
// 就是企业微信自己在本机留下的 sessionStorage。
//
// 用法：
//   node tools/sync-fitness.js              # 同步 token + 拉一次成绩
//   node tools/sync-fitness.js --print      # 只打印 token，不写任何文件
//   node tools/sync-fitness.js --no-fetch   # 只写 token，不联网
//   node tools/sync-fitness.js --dir <path> # 指定插件缓存目录（默认按 tauri identifier 推）
//
// 前提：企业微信里最近打开过「我的体测」。sessionStorage 是 per-session 的，
// 企业微信彻底退出后可能被清掉；token 过期时接口回 -998，重新打开一次体测页即可。
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "le-time-management");

const PRINT = process.argv.includes("--print");
const NO_FETCH = process.argv.includes("--no-fetch");
const dirFlag = process.argv.indexOf("--dir");
const EXPLICIT_DIR = dirFlag >= 0 ? process.argv[dirFlag + 1] : null;

const ORIGIN = "https://sport-wechat.cppu.edu.cn";
const API = ORIGIN + "/api/iot/h5fitness/fitnessAchievementActivity/getAppealInfo";
// 服务端按 UA 判来源，换回普通浏览器 UA 会被当成非企业微信环境。
const WXWORK_UA = "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) "
  + "Chrome/129.0.0.0 Safari/537.36 wxwork/5.0.12 MicroMessenger/7.0.1 NetType/WIFI Language/zh";

const say = (...a) => console.log(...a);

// ── 插件缓存文件名编码 ────────────────────────────────────────────────────
// 必须与 src-tauri/src/plugin_cache.rs 的 encode_component 逐字节一致：
// 只留 [a-z0-9_-]，其余每个 UTF-8 字节写成 ~XX（大写十六进制）。
// 大写字母也编码 —— Windows 文件名不分大小写，A 与 a 会撞成同一个文件。
function encodeComponent(raw) {
  const bytes = Buffer.from(String(raw), "utf8");
  let out = "";
  for (const b of bytes) {
    const isLower = b >= 0x61 && b <= 0x7a;
    const isDigit = b >= 0x30 && b <= 0x39;
    const isSafe = isLower || isDigit || b === 0x5f || b === 0x2d;
    out += isSafe ? String.fromCharCode(b) : "~" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

function pluginCacheDir() {
  if (EXPLICIT_DIR) return EXPLICIT_DIR;
  // Tauri 在 Windows 的 data_dir 是 %APPDATA%\<identifier>，identifier 以 tauri.conf.json 为准
  // （铁律：com.yile.letime，不许回退成 tidebalance）。
  let ident = "com.yile.letime";
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(APP, "src-tauri", "tauri.conf.json"), "utf8"));
    if (conf.identifier) ident = conf.identifier;
  } catch { /* 用默认值 */ }
  return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    ident, "plugin-cache", "cppu-notify");
}

// ── 找企业微信的 Session Storage ──────────────────────────────────────────
/** WXWork 的文档目录可以落在任意盘（本机是 E:\Documents\WXWork），所以把候选盘都探一遍。 */
function wxworkRoots() {
  const roots = [];
  const push = (p) => { if (p && fs.existsSync(p)) roots.push(p); };
  push(path.join(os.homedir(), "Documents", "WXWork"));
  push(path.join(os.homedir(), "Documents", "WXWork Files"));
  for (const drive of ["C:", "D:", "E:", "F:", "G:"]) {
    push(path.join(drive + path.sep, "Documents", "WXWork"));
  }
  return [...new Set(roots)];
}

/** 每个 profile 一个 Session Storage\leveldb。返回 [{ profile, files: [...] }]。 */
function sessionStores() {
  const out = [];
  for (const root of wxworkRoots()) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name, "WXWorkCefCache", "Session Storage");
      if (!fs.existsSync(dir)) continue;
      let files = [];
      try { files = fs.readdirSync(dir).filter((n) => /\.(log|ldb)$/i.test(n)); } catch { continue; }
      if (files.length) out.push({ profile: e.name, dir, files });
    }
  }
  return out;
}

/** 企业微信在跑，文件被独占；读之前先复制一份到临时目录。 */
function readLocked(file) {
  const tmp = path.join(os.tmpdir(), `letime-fitness-${process.pid}-${path.basename(file)}`);
  try {
    fs.copyFileSync(file, tmp);
    return fs.readFileSync(tmp);
  } catch {
    // 复制失败就直读，仍失败由调用方跳过这个文件
    try { return fs.readFileSync(file); } catch { return null; }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * sessionStorage 在 leveldb 里的样子：
 *   "...map-17-Authorization" + <2 字节前缀> + <UTF-16LE 的 token>
 * 所以按 ASCII 定位 key，再从 key 结尾往后按 UTF-16LE 解，取第一段像 token 的串。
 * 值和 key 都可能是 UTF-16LE（Chromium 对非 ASCII 走宽字符），两条路都试。
 */
function extractTokens(buf) {
  const found = [];
  const haystack = buf.toString("latin1");
  const re = /map-(\d+)-Authorization/g;
  let m;
  while ((m = re.exec(haystack)) !== null) {
    const mapId = Number(m[1]);
    const from = m.index + m[0].length;
    const slice = buf.subarray(from, Math.min(buf.length, from + 512));
    let token = "";

    // 路径一：UTF-16LE（实测走这条）
    const wide = slice.toString("utf16le");
    const wideHit = wide.match(/[A-Za-z0-9+/]{30,}={0,2}/);
    if (wideHit) token = wideHit[0];

    // 路径二：ASCII / latin1（换了 Chromium 版本可能变回窄字符）
    if (!token) {
      const narrow = slice.toString("latin1");
      const narrowHit = narrow.match(/[A-Za-z0-9+/]{30,}={0,2}/);
      if (narrowHit) token = narrowHit[0];
    }

    if (token && token.length >= 30) found.push({ mapId, token });
  }
  return found;
}

function pickToken() {
  const stores = sessionStores();
  if (!stores.length) {
    return { error: "没找到企业微信的 Session Storage。确认本机装过企业微信并打开过「我的体测」。" };
  }
  const candidates = [];
  for (const store of stores) {
    for (const name of store.files) {
      const buf = readLocked(path.join(store.dir, name));
      if (!buf) continue;
      // 先确认这个文件属于体测站点，避免把别的站点的 Authorization 也捞进来
      const hasOrigin = buf.toString("latin1").includes("sport-wechat.cppu.edu.cn")
        || buf.toString("utf16le").includes("sport-wechat.cppu.edu.cn");
      if (!hasOrigin) continue;
      const stat = (() => { try { return fs.statSync(path.join(store.dir, name)).mtimeMs; } catch { return 0; } })();
      for (const t of extractTokens(buf)) {
        candidates.push({ ...t, profile: store.profile, file: name, mtime: stat });
      }
    }
  }
  if (!candidates.length) {
    return { error: "找到了企业微信的会话存储，但里面没有体测的 Authorization。在企业微信里再打开一次「我的体测」后重跑。" };
  }
  // map-<N> 的 N 是递增会话序号，取最大；同号取文件更新的
  candidates.sort((a, b) => (b.mapId - a.mapId) || (b.mtime - a.mtime));
  const best = candidates[0];
  return { token: best.token, mapId: best.mapId, profile: best.profile, count: candidates.length };
}

// ── 拉数据 ────────────────────────────────────────────────────────────────
async function fetchScores(token) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "User-Agent": WXWORK_UA,
      Referer: ORIGIN + "/",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      "Content-Type": "application/json;charset=UTF-8",
      Authorization: token,
    },
    body: "{}",
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 下面统一处理 */ }
  if (!json || typeof json !== "object") {
    return { error: `接口返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}` };
  }
  const code = String(json.status ?? "").trim();
  if (code && code !== "00" && code !== "0") {
    const msg = String(json.msg || "").trim();
    return {
      error: `接口拒绝：status=${code} ${msg}`,
      expired: /过期|登录/.test(msg),
    };
  }
  const data = Array.isArray(json.data) ? json.data : [];
  if (!data.length) return { error: "接口通了但没有记录（token 可能不属于这个身份）" };
  return { items: data };
}

// 只留插件渲染用得到的字段（与 fitness.js / fitness-seed.json 同一份口径）
const KEEP = ["id", "projectName", "projectUnit", "projectIcon", "score",
  "scoreOriginal", "fraction", "level", "remark", "testTime", "termName"];
function slim(rows) {
  return rows.map((r) => {
    const o = {};
    for (const k of KEEP) {
      let v = r[k];
      if (typeof v === "string" && ["", "null", "undefined"].includes(v.trim())) v = "";
      o[k] = v == null ? "" : v;
    }
    return o;
  });
}

// ── main ──────────────────────────────────────────────────────────────────
(async () => {
  const picked = pickToken();
  if (picked.error) {
    console.error("✗ " + picked.error);
    process.exit(1);
  }
  say(`✓ 找到 token（profile ${picked.profile}，map-${picked.mapId}，共 ${picked.count} 枚候选）`);
  if (PRINT) {
    say(picked.token);
    return;
  }

  const dir = pluginCacheDir();
  fs.mkdirSync(dir, { recursive: true });

  const tokenFile = path.join(dir, encodeComponent("fitnessToken") + ".json");
  fs.writeFileSync(tokenFile, JSON.stringify({
    token: picked.token,
    savedAt: Date.now(),
    source: `wxwork:${picked.profile}:map-${picked.mapId}`,
  }, null, 2) + "\n");
  say("✓ token -> " + tokenFile);

  if (NO_FETCH) return;

  const got = await fetchScores(picked.token);
  if (got.error) {
    console.error("✗ " + got.error);
    if (got.expired) {
      console.error("  在企业微信里重新打开一次「我的体测」，再跑本脚本。");
    }
    process.exit(2);
  }
  const items = slim(got.items);
  const dataFile = path.join(dir, encodeComponent("fitnessScores") + ".json");
  fs.writeFileSync(dataFile, JSON.stringify({
    items, fetchedAt: Date.now(), source: "api",
  }, null, 2) + "\n");
  say(`✓ ${items.length} 条记录 -> ${dataFile}`);

  // 顺手给一个人话摘要，方便在终端里确认「这次拉到的是不是自己要的」
  const byProject = new Map();
  for (const it of items) {
    const k = it.projectName || "未命名";
    const cur = byProject.get(k);
    const score = Number(String(it.fraction ?? 0));
    if (!cur || score > cur.score) byProject.set(k, { score, text: it.score, level: it.level });
  }
  say("");
  say("  项目            成绩            得分   等级");
  for (const [name, v] of [...byProject.entries()].sort((a, b) => b[1].score - a[1].score)) {
    say("  " + name.padEnd(14, "　") + String(v.text || "—").padEnd(14, " ")
      + String(v.score).padStart(5) + "   " + (v.level || "—"));
  }
  say("");
  say("打开 U-Time 的「我的体测」即可看到（插件优先读这份缓存，不再联网）。");
})().catch((e) => {
  console.error("✗ 未预期的错误：" + (e && e.message ? e.message : e));
  process.exit(1);
});
