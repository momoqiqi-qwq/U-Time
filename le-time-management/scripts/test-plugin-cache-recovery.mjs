import assert from "node:assert/strict";
import { createPluginCache } from "../src/pluginCache.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function backend() {
  const files = new Map(), writes = [];
  return {
    files, writes, fail: false,
    async get(pid, key) { return structuredClone(files.get(`${pid}/${key}`) ?? null); },
    async set(pid, key, value) {
      writes.push([pid, key, value]);
      if (this.fail) throw new Error("disk full");
      if (value == null) files.delete(`${pid}/${key}`);
      else files.set(`${pid}/${key}`, structuredClone(value));
    },
  };
}
const state = () => ({ storage: {}, cachePending: {} });
const cache = (be, data, pid = "demo") => createPluginCache({
  pid, storage: () => data.current.storage, pending: () => data.current.cachePending,
  persist() {}, backend: be,
});

const warn = console.warn;
console.warn = () => {};
try {
  // 失败更新/删除跨重启恢复；持续失败保留标记，恢复成功后才删 storage 与标记。
  for (const value of ["new", null]) {
    const be = backend(), data = { current: state() };
    be.files.set("demo/k", "old");
    be.fail = true;
    const first = cache(be, data);
    await first.set("k", value);
    data.current = structuredClone(data.current);
    const restarted = cache(be, data);
    assert.equal(await restarted.get("k", "gone"), value ?? "gone", "不能读回旧磁盘值");
    assert.ok(Object.hasOwn(data.current.cachePending, "k"), "持续失败仍保留恢复标记");
    be.fail = false;
    assert.equal(await restarted.get("k", "gone"), value ?? "gone");
    assert.equal(be.files.get("demo/k") ?? null, value);
    assert.ok(!Object.hasOwn(data.current.storage, "k"));
    assert.ok(!Object.hasOwn(data.current.cachePending, "k"));
  }

  // 同 namespace/pid 的重新加载共享写队列和内存。
  {
    const be = backend(), data = { current: state() }, started = deferred(), finish = deferred();
    const set = be.set.bind(be);
    be.set = async (pid, key, value) => {
      if (value === "old") { started.resolve(); await finish.promise; }
      await set(pid, key, value);
    };
    const first = cache(be, data), second = cache(be, data);
    const old = first.set("k", "old");
    await started.promise;
    const latest = second.set("k", "new");
    assert.equal(await first.get("k"), "new");
    finish.resolve();
    await Promise.all([old, latest]);
    assert.equal(be.files.get("demo/k"), "new");
  }

  // 同 namespace/pid 的冷读与迁移同样去重；随后 set 不会被另一实例的 legacy 覆盖。
  {
    const be = backend(), data = { current: state() }, started = deferred(), reply = deferred();
    data.current.storage.k = "legacy";
    let reads = 0;
    be.get = async () => { reads++; started.resolve(); return reply.promise; };
    const reading = [cache(be, data).get("k"), cache(be, data).get("k")];
    await started.promise; reply.resolve(null);
    assert.deepEqual(await Promise.all(reading), ["legacy", "legacy"]);
    assert.equal(reads, 1);
    assert.deepEqual(be.writes.map((item) => item[2]), ["legacy"]);
  }
  {
    const be = backend(), data = { current: state() }, started = deferred(), reply = deferred();
    data.current.storage.k = "legacy";
    let reads = 0;
    be.get = async () => { reads++; started.resolve(); return reply.promise; };
    const first = cache(be, data), second = cache(be, data);
    const reading = [first.get("k"), second.get("k")];
    await started.promise;
    const latest = second.set("k", "new");
    reply.resolve(null);
    await latest;
    assert.deepEqual(await Promise.all(reading), ["new", "new"]);
    assert.equal(reads, 1);
    assert.deepEqual(be.writes.map((item) => item[2]), ["new"]);
  }

  // 不同 key/pid 的缓存状态、读请求和写队列互不阻塞；不同 namespace 不共享 mem。
  {
    const be = backend(), data = { current: state() }, started = deferred(), finish = deferred();
    const set = be.set.bind(be);
    be.set = async (pid, key, value) => {
      if (pid === "demo" && key === "blocked") { started.resolve(); await finish.promise; }
      await set(pid, key, value);
    };
    const first = cache(be, data), blocked = first.set("blocked", "waiting");
    await started.promise;
    await Promise.all([first.set("other", "free"), cache(be, data, "other").set("blocked", "other-plugin")]);
    assert.equal(be.files.get("demo/other"), "free");
    assert.equal(be.files.get("other/blocked"), "other-plugin");
    finish.resolve(); await blocked;
    assert.equal(await first.get("other"), "free");
    be.files.set("demo/other", "fresh");
    assert.equal(await cache(be, { current: state() }).get("other"), "fresh", "不同 namespace 不共享旧 mem");
    assert.equal(await cache(be, data, "other").get("other", "missing"), "missing", "不同 pid 不共享 mem");
  }

  // 旧写失败不能覆盖/清理后续新值的 fallback，正常写随后仍能恢复。
  {
    const be = backend(), data = { current: state() }, started = deferred(), finish = deferred();
    const latestStarted = deferred(), latestDone = deferred();
    be.set = async (_pid, _key, value) => {
      if (value === "old") { started.resolve(); await finish.promise; }
      else { latestStarted.resolve(); await latestDone.promise; }
      throw new Error("disk full");
    };
    const first = cache(be, data), second = cache(be, data);
    const old = first.set("k", "old");
    await started.promise;
    const latest = second.set("k", "new");
    finish.resolve();
    await latestStarted.promise;
    await old;
    assert.ok(!Object.hasOwn(data.current.storage, "k"), "旧失败不能回填后续写入的 storage");
    assert.ok(!Object.hasOwn(data.current.cachePending, "k"));
    latestDone.resolve();
    await Promise.all([old, latest]);
    assert.equal(data.current.storage.k, "new");
    assert.ok(Object.hasOwn(data.current.cachePending, "k"));
  }

  // 相同 API 在 replaceAll 后取新 namespace；旧写的成功/失败都不能碰新元数据。
  for (const fail of [false, true]) {
    const be = backend(), data = { current: state() }, started = deferred(), finish = deferred();
    const set = be.set.bind(be);
    be.set = async (pid, key, value) => {
      if (value === "old") { started.resolve(); await finish.promise; if (fail) throw new Error("disk full"); }
      await set(pid, key, value);
    };
    const api = cache(be, data), old = api.set("k", "old");
    await started.promise;
    data.current = { storage: { k: "imported" }, cachePending: { k: true } };
    finish.resolve();
    await old;
    assert.deepEqual(data.current, { storage: { k: "imported" }, cachePending: { k: true } });
    assert.equal(await api.get("k"), "imported", "新 namespace 不沿用旧 mem");
    assert.equal(be.files.get("demo/k"), "imported");
  }

  // 换 namespace 后到达的旧冷读，不能把捕获的 legacy 写回磁盘。
  {
    const be = backend(), data = { current: state() }, started = deferred(), reply = deferred();
    data.current.storage.k = "legacy";
    const get = be.get.bind(be);
    let first = true;
    be.get = async (...args) => {
      if (first) { first = false; started.resolve(); return reply.promise; }
      return get(...args);
    };
    const api = cache(be, data), oldRead = api.get("k");
    await started.promise;
    data.current = state();
    await api.set("k", "new");
    reply.resolve(null);
    await oldRead;
    assert.deepEqual(be.writes.map((item) => item[2]), ["new"]);
    assert.equal(be.files.get("demo/k"), "new");
  }

  // 不同 namespace 的用户写入仍按物理 pid/key 排队，不能旧写后到反盖新值。
  {
    const be = backend(), data = { current: state() }, started = deferred(), finish = deferred();
    const set = be.set.bind(be);
    be.set = async (pid, key, value) => {
      if (value === "old") { started.resolve(); await finish.promise; }
      await set(pid, key, value);
    };
    const api = cache(be, data), old = api.set("k", "old");
    await started.promise;
    data.current = state();
    const latest = api.set("k", "new");
    finish.resolve();
    await Promise.all([old, latest]);
    assert.equal(be.files.get("demo/k"), "new");
  }

  // 原型名也是合法键；标志不得与用户 storage 同名数据冲突。
  for (const key of ["__proto__", "constructor", "cachePending"]) {
    const be = backend(), data = { current: state() };
    be.fail = true;
    await cache(be, data).set(key, "new");
    assert.ok(Object.hasOwn(data.current.storage, key));
    data.current = structuredClone(data.current);
    be.fail = false;
    assert.equal(await cache(be, data).get(key), "new");
    assert.equal(be.files.get(`demo/${key}`), "new");
    be.fail = true;
    await cache(be, data).remove(key);
    data.current = structuredClone(data.current);
    be.fail = false;
    assert.equal(await cache(be, data).get(key, "gone"), "gone");
    assert.ok(!be.files.has(`demo/${key}`));
  }

  // 浏览器继承 native 的 pending 后，读取与后续修改保持新值/删除语义。
  {
    const be = backend(), data = { current: state() };
    be.files.set("demo/k", "old"); be.fail = true;
    await cache(be, data).remove("k");
    data.current = structuredClone(data.current);
    const browser = cache(null, data);
    assert.equal(await browser.get("k", "gone"), "gone");
    await browser.set("k", "browser");
    data.current = structuredClone(data.current); be.fail = false;
    assert.equal(await cache(be, data).get("k"), "browser");
    assert.equal(be.files.get("demo/k"), "browser");
    be.fail = true;
    await cache(be, data).set("k", "pending");
    data.current = structuredClone(data.current);
    await cache(null, data).remove("k");
    data.current = structuredClone(data.current); be.fail = false;
    assert.equal(await cache(be, data).get("k", "gone"), "gone");
    assert.ok(!be.files.has("demo/k"));
  }
} finally { console.warn = warn; }

console.log("PASS plugin cache recovery / reload ordering / namespace replacement / safe keys");
