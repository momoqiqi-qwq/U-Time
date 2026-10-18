// 插件缓存 tide.cache：体积大、丢了也能重新抓回来的数据（通知列表与正文、账单流水、获奖名单…）
// 落到 <数据目录>/plugin-cache/<插件ID>/<键>.json，**不进 data.json**。
//
// 为什么单独一层：tide.storage 的数据住在主状态里，任何一次保存（哪怕只改了一个任务标题）都要把整份
// 状态 structuredClone → IPC → Rust 解析 → 重写磁盘。v0.247 实测 data.json 9.8 MB，真实任务数据不到
// 50 KB，其余大头就是插件缓存与自动化日志。
//
// 迁移是透明的：get 在缓存文件里找不到、但 storage 里还有同名键时，先把旧值写进缓存文件，成功后再从
// storage 删掉 —— 插件只需要把 tide.storage.get/set 换成 tide.cache.get/set。
// 浏览器调试模式（没有 Tauri，backend 为 null）没有文件层，直接退回 storage，行为与以前一致。
//
// 写入按键串行：Rust 侧走 spawn_blocking，同一个键并发写时谁先 rename 不确定，所以后发的 set 要排在
// 前一次落盘之后。内存里留一份最新值，同一会话内的 get 不必再读盘。
//
// 不适合放进来的：用户亲手产生、丢了找不回的东西（收藏、已读标记、偏好设置）—— 缓存文件不进备份与同步。
export const CACHE_KEY_MAX = 200;

const has = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);

/**
 * @param {object} o
 * @param {string} o.pid 插件 ID
 * @param {() => object} o.storage 返回该插件 storage 命名空间（旧数据所在处）
 * @param {() => void} o.persist storage 改动后安排保存
 * @param {{get(pid:string,key:string):Promise<any>, set(pid:string,key:string,value:any):Promise<void>}|null} o.backend
 * @param {() => void} [o.guard] 权限检查（与 tide.storage 同一个 storage 权限）
 */
export function createPluginCache({ pid, storage, persist, backend, guard = () => {} }) {
  const mem = new Map();
  const queue = new Map();

  const check = (key) => {
    guard();
    if (typeof key !== "string" || !key || key.length > CACHE_KEY_MAX) throw new Error(`缓存键无效：${String(key).slice(0, 40)}`);
  };
  const dropLegacy = (key) => {
    const ns = storage();
    if (has(ns, key)) { delete ns[key]; persist(); }
  };
  const write = (key, value) => {
    const run = (queue.get(key) || Promise.resolve()).then(() => backend.set(pid, key, value ?? null));
    const tail = run.then(() => {}, () => {});
    queue.set(key, tail);
    tail.then(() => { if (queue.get(key) === tail) queue.delete(key); });
    return run;
  };

  async function get(key, fallback = null) {
    check(key);
    if (!backend) return storage()[key] ?? fallback;
    if (mem.has(key)) return mem.get(key) ?? fallback;
    await queue.get(key);
    let value;
    try { value = await backend.get(pid, key); }
    catch (error) {
      console.warn(`[tide.cache] ${pid}/${key} 读取失败，本次退回 storage：`, error);
      return storage()[key] ?? fallback;
    }
    const ns = storage();
    const legacy = has(ns, key) ? ns[key] : undefined;
    if (value == null && legacy !== undefined && legacy !== null) {
      try { await write(key, legacy); value = legacy; dropLegacy(key); }
      catch (error) {
        console.warn(`[tide.cache] ${pid}/${key} 迁移失败，旧值继续留在 storage：`, error);
        return legacy ?? fallback;
      }
    } else if (legacy !== undefined) dropLegacy(key);
    // 读盘期间插件可能已经 set 过新值 —— 以内存里的为准，别用旧盘值盖掉它。
    if (mem.has(key)) return mem.get(key) ?? fallback;
    mem.set(key, value ?? null);
    return value ?? fallback;
  }

  async function set(key, value) {
    check(key);
    if (!backend) { storage()[key] = value; persist(); return; }
    mem.set(key, value ?? null);
    try { await write(key, value); dropLegacy(key); }
    catch (error) {
      // 落盘失败（磁盘满 / 权限）：退回 storage，别让刚抓回来的数据就这么丢了。
      console.warn(`[tide.cache] ${pid}/${key} 写入失败，本次退回 storage：`, error);
      if (value == null) delete storage()[key]; else storage()[key] = value;
      persist();
    }
  }

  return { get, set, remove: (key) => set(key, null) };
}
