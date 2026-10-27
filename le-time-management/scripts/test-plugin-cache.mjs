// v0.248.0 数据瘦身：tide.cache（插件缓存落独立文件）、自定义图标落库前缩小、自动化撤销快照体积上限。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPluginCache } from "../src/pluginCache.js";
import { shrinkIconDataUrl, shrinkStoredIcons, ICON_SHRINK_THRESHOLD } from "../src/iconShrink.js";
import { LOG_UNDO_KEEP, LOG_SNAPSHOT_MAX, pruneLogSnapshots, snapshotWithinLimit } from "../src/automationLogs.js";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

function fakeBackend({ failGet = false, failSet = false, delay = 0 } = {}) {
  const files = new Map();
  const writes = [];
  const wait = () => new Promise((r) => setTimeout(r, delay));
  return {
    files, writes,
    async get(pid, key) { await wait(); if (failGet) throw new Error("io"); const v = files.get(`${pid}/${key}`); return v === undefined ? null : structuredClone(v); },
    async set(pid, key, value) {
      await wait(); if (failSet) throw new Error("disk full");
      writes.push([key, value]);
      if (value == null) files.delete(`${pid}/${key}`); else files.set(`${pid}/${key}`, structuredClone(value));
    },
  };
}
function harness(backend, legacy = {}) {
  const ns = { ...legacy };
  const pending = Object.create(null);
  let persisted = 0;
  const cache = createPluginCache({ pid: "demo", storage: () => ns, pending: () => pending, persist: () => { persisted++; }, backend });
  return { ns, pending, cache, persisted: () => persisted };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function gatedBackend() {
  const files = new Map(), reads = [], writes = [];
  const be = {
    files, reads, writes, started: deferred(), reply: deferred(),
    get(pid, key) { reads.push(key); be.started.resolve(); return be.reply.promise; },
    async set(pid, key, value) {
      writes.push(value);
      if (value == null) files.delete(`${pid}/${key}`); else files.set(`${pid}/${key}`, value);
    },
  };
  return be;
}

// 1) 透明迁移：storage 里的旧值搬进缓存文件，搬完从 storage 删掉并安排保存
{
  const be = fakeBackend();
  const h = harness(be, { inboxCache: [{ id: 1 }], keep: "pref" });
  assert.deepEqual(await h.cache.get("inboxCache", []), [{ id: 1 }]);
  assert.deepEqual(be.files.get("demo/inboxCache"), [{ id: 1 }], "旧值写进缓存文件");
  assert.ok(!("inboxCache" in h.ns), "迁移后从 storage 删除");
  assert.equal(h.ns.keep, "pref", "不相干的键不动");
  assert.equal(h.persisted(), 1);
  assert.deepEqual(await h.cache.get("missing", "fb"), "fb", "未命中返回 fallback");
}
// 2) set → get 同会话走内存；null 即删除；写入按键串行，最后一次 set 落盘为准
{
  const be = fakeBackend({ delay: 2 });
  const h = harness(be);
  await Promise.all([h.cache.set("k", 1), h.cache.set("k", 2), h.cache.set("k", 3)]);
  assert.deepEqual(be.writes.map((w) => w[1]), [1, 2, 3], "同一个键的写入按调用顺序落盘");
  assert.equal(be.files.get("demo/k"), 3);
  assert.equal(await h.cache.get("k"), 3);
  await h.cache.remove("k");
  assert.equal(be.files.has("demo/k"), false);
  assert.equal(await h.cache.get("k", "gone"), "gone");
  await assert.rejects(() => h.cache.get(""), /缓存键无效/);
  await assert.rejects(() => h.cache.get("x".repeat(201)), /缓存键无效/);
}
// 3) 同键冷读只发一次 IPC；fallback 属于每次调用，不能串给其他调用者。
{
  const be = gatedBackend();
  const h = harness(be);
  const pending = Array.from({ length: 8 }, (_, i) => h.cache.get("k", `fallback-${i}`));
  await be.started.promise;
  be.reply.resolve(null);
  assert.deepEqual(await Promise.all(pending), pending.map((_, i) => `fallback-${i}`));
  assert.equal(be.reads.length, 1, "并发冷读共享进行中的读请求");
  assert.equal(await h.cache.get("k", "later"), "later");
  assert.equal(be.reads.length, 1, "成功的空结果也缓存");
}
// 读盘开始前发生 set：无需再读旧文件。
{
  const be = gatedBackend();
  const h = harness(be, { k: "legacy" });
  const pending = h.cache.get("k");
  const writing = h.cache.set("k", "new");
  assert.equal(await pending, "new");
  await writing;
  assert.equal(be.reads.length, 0);
  assert.deepEqual(be.writes, ["new"]);
}
// 读盘期间发生 set/remove：不能把 legacy 再排进写队列覆盖新值或复活删除值。
for (const value of ["new", null]) {
  const be = gatedBackend();
  const h = harness(be, { k: "legacy" });
  const pending = [h.cache.get("k", "first"), h.cache.get("k", "second")];
  await be.started.promise;
  const writing = value == null ? h.cache.remove("k") : h.cache.set("k", value);
  be.reply.resolve(null);
  await writing;
  assert.deepEqual(await Promise.all(pending), value == null ? ["first", "second"] : [value, value]);
  assert.deepEqual(be.writes, [value], "冷读不可迁移旧值覆盖新写入");
  assert.equal(be.files.get("demo/k") ?? null, value);
  assert.ok(!("k" in h.ns));
}
// 多个冷读只迁移一次；迁移尚未落盘时发生 set，写队列仍以新值收尾。
{
  const be = gatedBackend();
  const migrationStarted = deferred(), migrationDone = deferred();
  const write = be.set;
  be.set = async (pid, key, value) => {
    if (value === "legacy") { migrationStarted.resolve(); await migrationDone.promise; }
    await write(pid, key, value);
  };
  const h = harness(be, { k: "legacy" });
  const pending = [h.cache.get("k"), h.cache.get("k")];
  await be.started.promise;
  be.reply.resolve(null);
  await migrationStarted.promise;
  const writing = h.cache.set("k", "new");
  migrationDone.resolve();
  await writing;
  assert.deepEqual(await Promise.all(pending), ["new", "new"]);
  assert.equal(be.reads.length, 1);
  assert.deepEqual(be.writes, ["legacy", "new"]);
  assert.equal(be.files.get("demo/k"), "new");
  assert.equal(await h.cache.get("k"), "new");
}
// 4) 没有 Tauri（浏览器调试）或后端出错：退回 storage，数据不丢
{
  const h = harness(null, { a: 1 });
  assert.equal(await h.cache.get("a"), 1);
  await h.cache.set("b", 2);
  assert.equal(h.ns.b, 2);
  const warn = console.warn; console.warn = () => {};
  try {
    const bad = harness(fakeBackend({ failSet: true }));
    await bad.cache.set("c", [1]);
    assert.deepEqual(bad.ns.c, [1], "写盘失败时退回 storage");
    const badGet = harness(fakeBackend({ failGet: true }), { d: "legacy" });
    assert.equal(await badGet.cache.get("d"), "legacy", "读盘失败时读 storage");
    assert.equal(badGet.ns.d, "legacy", "读失败不删旧值");
  } finally { console.warn = warn; }
}
// 5) 权限检查与 storage 同口径
{
  const cache = createPluginCache({ pid: "p", storage: () => ({}), persist() {}, backend: fakeBackend(), guard: () => { throw new Error("插件未声明 storage 权限"); } });
  await assert.rejects(() => cache.get("k"), /storage 权限/);
}
// 失败的共享读不能留在内存里；下一次 get 要重新读盘并允许各调用方使用自己的 fallback。
{
  const warn = console.warn; console.warn = () => {};
  try {
    const be = gatedBackend();
    const h = harness(be);
    const pending = [h.cache.get("k", "first"), h.cache.get("k", "second")];
    await be.started.promise;
    be.reply.reject(new Error("io"));
    assert.deepEqual(await Promise.all(pending), ["first", "second"]);
    assert.equal(be.reads.length, 1);
    be.started = deferred(); be.reply = deferred();
    const retry = h.cache.get("k");
    await be.started.promise;
    be.reply.resolve("recovered");
    assert.equal(await retry, "recovered");
    assert.equal(be.reads.length, 2, "读盘失败后可以重试");

    const migrating = gatedBackend();
    const write = migrating.set;
    let attempts = 0;
    migrating.set = async (...args) => {
      if (++attempts === 1) throw new Error("disk full");
      await write(...args);
    };
    const old = harness(migrating, { k: "legacy" });
    const initial = [old.cache.get("k"), old.cache.get("k")];
    await migrating.started.promise;
    migrating.reply.resolve(null);
    assert.deepEqual(await Promise.all(initial), ["legacy", "legacy"]);
    assert.equal(old.ns.k, "legacy", "迁移失败继续保留旧值");
    assert.equal(attempts, 1);
    assert.equal(await old.cache.get("k"), "legacy");
    assert.equal(attempts, 2, "迁移失败不能被缓存，下一次会重试迁移");
    assert.ok(!("k" in old.ns));
    assert.equal(old.persisted(), 1);
  } finally { console.warn = warn; }
}

// 6) 图标缩小：小图原样；大图按最长边缩到 144；缩完更大或解码失败都保留原图
{
  const small = "data:image/png;base64," + "A".repeat(100);
  assert.equal(await shrinkIconDataUrl(small), small);
  const big = "data:image/png;base64," + "B".repeat(ICON_SHRINK_THRESHOLD + 10);
  let drawn = null;
  const opts = {
    loadImage: async () => ({ naturalWidth: 1024, naturalHeight: 512 }),
    createCanvas: (w, h) => ({ getContext: () => ({ drawImage: (_img, _x, _y, dw, dh) => { drawn = [w, h, dw, dh]; } }), toDataURL: () => "data:image/png;base64,small" }),
  };
  assert.equal(await shrinkIconDataUrl(big, opts), "data:image/png;base64,small");
  assert.deepEqual(drawn, [144, 72, 144, 72], "按最长边等比缩放");
  assert.equal(await shrinkIconDataUrl(big, { ...opts, createCanvas: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => big + "CC" }) }), big, "缩完更大就留原图");
  assert.equal(await shrinkIconDataUrl(big, { loadImage: async () => { throw new Error("bad"); } }), big, "解码失败留原图");
  const settings = { pluginOverrides: { a: { icon: big, name: "A" }, b: { icon: small } }, navOverrides: { today: { icon: big } } };
  assert.equal(await shrinkStoredIcons(settings, opts), 2);
  assert.equal(settings.pluginOverrides.a.icon, "data:image/png;base64,small");
  assert.equal(settings.pluginOverrides.a.name, "A");
  assert.equal(settings.pluginOverrides.b.icon, small);
  assert.equal(await shrinkStoredIcons({}, opts), 0);
}

// 7) 自动化撤销快照：条数 + 单条体积上限
{
  assert.equal(snapshotWithinLimit(null), null);
  const ok = { tasks: [{ id: 1 }] };
  assert.equal(snapshotWithinLimit(ok), ok);
  const huge = { tasks: [{ id: 1, note: "x".repeat(LOG_SNAPSHOT_MAX) }] };
  assert.equal(snapshotWithinLimit(huge), null, "超过体积上限不留快照");
  const logs = [{ before: huge }, { before: ok }, ...Array.from({ length: LOG_UNDO_KEEP }, () => ({ before: ok }))];
  assert.equal(pruneLogSnapshots(logs), logs, "原地裁剪并返回同一个数组");
  assert.equal(logs[0].before, huge, "不查体积时只裁条数");
  assert.equal(logs[LOG_UNDO_KEEP].before, null);
  pruneLogSnapshots(logs, { checkSize: true });
  assert.equal(logs[0].before, null, "接手旧数据时连体积一起查");
  assert.equal(logs[1].before, ok);
}

// 8) 接线：宿主注入 tide.cache、Rust 命令已注册、卸载插件时清缓存、大缓存键已迁出 storage
{
  const host = read("../src/pluginHost.js");
  assert.match(host, /cache: createPluginCache\(\{/);
  assert.match(host, /guard: \(\) => requirePermission\(man, pid, "storage"\)/);
  const api = read("../src/api.js");
  assert.match(api, /invoke\("plugin_cache_get", \{ pluginId, key \}\)/);
  assert.match(api, /invoke\("plugin_cache_set", \{ pluginId, key, value: value \?\? null \}\)/);
  const lib = read("../src-tauri/src/lib.rs");
  assert.match(lib, /^mod plugin_cache;$/m);
  assert.match(lib, /plugin_cache::plugin_cache_get,\s*plugin_cache::plugin_cache_set,/);
  assert.match(lib, /plugin_cache::clear_plugin_cache\(app, &id\)/);
  const plug = (id) => read(`../public/plugins/${id}/main.js`);
  const cppu = plug("cppu-notify");
  for (const key of ['"noticeCache"', "CARD_CACHE_KEY", "AWARD_CACHE_KEY"]) {
    assert.ok(!cppu.includes(`tide.storage.set(${key}`) && !cppu.includes(`tide.storage.get(${key}`), `cppu ${key} 已迁到 tide.cache`);
    assert.ok(cppu.includes(`cacheStore.set(${key}`) && cppu.includes(`cacheStore.get(${key}`));
  }
  assert.ok(cppu.includes('tide.storage.set("jwCache"'), "jwCache 里混着偏好设置，留在 storage");
  const cx = plug("chaoxing-notify");
  assert.ok(cx.includes('cacheStore.get("inboxCache"') && !cx.includes('tide.storage.set("inboxCache"'));
  for (const src of [cppu, cx]) assert.match(src, /const cacheStore = tide\.cache \|\| tide\.storage;/, "旧宿主没有 tide.cache 时退回 storage");
  assert.match(cx, /raw: slimRaw\(it\)/, "缓存的 raw 只留正文字段");
  const sn = plug("school-notice");
  assert.ok(!/tide\.storage\.(get|set)\(`notices:/.test(sn) && /cacheStore\.(get|set)\(`notices:/.test(sn));
}

console.log("PASS plugin cache / icon shrink / automation snapshot cap");
