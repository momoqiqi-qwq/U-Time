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
  let persisted = 0;
  const cache = createPluginCache({ pid: "demo", storage: () => ns, persist: () => { persisted++; }, backend });
  return { ns, cache, persisted: () => persisted };
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
// 3) 读盘期间插件已 set 新值：读回来的旧盘值不能盖掉它
{
  const be = fakeBackend({ delay: 5 });
  be.files.set("demo/k", "old");
  const h = harness(be);
  const pending = h.cache.get("k");
  await h.cache.set("k", "new");
  assert.equal(await pending, "new");
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
