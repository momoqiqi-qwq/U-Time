// 插件缓存 tide.cache：体积大、丢了也能重新抓回来的数据（通知列表与正文、账单流水、获奖名单…）
// 正常落到 <数据目录>/plugin-cache/<插件ID>/<键>.json，不进 data.json。
// 写盘失败时暂存 storage 与宿主 cachePending，恢复成功后才清理这份回退值。
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
// 同键的并发冷读共享一次 IPC 与旧值迁移，fallback 仍由每次 get 独立决定。
// 失败写入在宿主 cachePending 留标记，下次读取先重放最新值/删除，不能让旧磁盘覆盖 fallback。
//
// 不适合放进来的：用户亲手产生、丢了找不回的东西（收藏、已读标记、偏好设置）—— 缓存文件不进备份与同步。
export const CACHE_KEY_MAX = 200;

const has = (obj, key) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);
const put = (obj, key, value) => Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
// 同一插件重新加载时沿用同一份逻辑状态；replaceAll 换命名空间后不能沿用旧内存。
const scopes = new WeakMap();
// 文件位置由 pid/key 决定，namespace 替换后的新写入也必须排在旧 IO 后面。
const writeQueues = new Map();

/**
 * @param {object} o
 * @param {string} o.pid 插件 ID
 * @param {() => object} o.storage 返回该插件 storage 命名空间（旧数据所在处）
 * @param {() => void} o.persist storage 改动后安排保存
 * @param {() => object} [o.pending] 宿主持久化的失败写标记（与插件 storage 分开；true + 缺失值代表删除）
 * @param {{get(pid:string,key:string):Promise<any>, set(pid:string,key:string,value:any):Promise<void>}|null} o.backend
 * @param {() => void} [o.guard] 权限检查（与 tide.storage 同一个 storage 权限）
 */
export function createPluginCache({ pid, storage, pending, persist, backend, guard = () => {} }) {
  const scope = () => {
    const ns = storage();
    if (!scopes.has(ns)) scopes.set(ns, new Map());
    const plugins = scopes.get(ns);
    if (!plugins.has(pid)) plugins.set(pid, { mem: new Map(), reads: new Map(), tokens: new Map(), writing: new Map(), pending: Object.create(null) });
    const state = plugins.get(pid);
    return { ns, state, dirty: pending ? pending() : state.pending };
  };
  const valueOf = ({ ns, state, dirty }, key) => {
    if (state.writing.has(key)) return state.mem.get(key);
    if (has(dirty, key)) return has(ns, key) ? ns[key] : null;
    return state.mem.has(key) ? state.mem.get(key) : has(ns, key) ? ns[key] : null;
  };

  const check = (key) => {
    guard();
    if (typeof key !== "string" || !key || key.length > CACHE_KEY_MAX) throw new Error(`缓存键无效：${String(key).slice(0, 40)}`);
  };
  const dropLegacy = ({ ns, dirty }, key) => {
    let changed = false;
    if (has(ns, key)) { delete ns[key]; changed = true; }
    if (has(dirty, key)) { delete dirty[key]; changed = true; }
    if (changed) persist();
  };
  const write = (key, value, valid = () => true) => {
    if (!writeQueues.has(pid)) writeQueues.set(pid, new Map());
    const queue = writeQueues.get(pid);
    const run = (queue.get(key) || Promise.resolve()).then(async () => {
      if (!valid()) return false;
      await backend.set(pid, key, value ?? null);
      return true;
    });
    const tail = run.then(() => {}, () => {});
    queue.set(key, tail);
    tail.then(() => {
      if (queue.get(key) === tail) queue.delete(key);
      if (!queue.size && writeQueues.get(pid) === queue) writeQueues.delete(pid);
    });
    return run;
  };

  async function read(context, key) {
    const { ns, state, dirty } = context;
    const { mem, tokens, writing } = state;
    await writeQueues.get(pid)?.get(key);
    if (storage() !== ns || writing.has(key)) return valueOf(context, key);
    const token = tokens.get(key);
    const current = () => storage() === ns && tokens.get(key) === token;
    if (has(dirty, key)) {
      const value = has(ns, key) ? ns[key] : null;
      try {
        if (await write(key, value, current) && current()) {
          dropLegacy(context, key);
          mem.set(key, value ?? null);
        }
      } catch (error) {
        console.warn(`[tide.cache] ${pid}/${key} 恢复写入失败，继续保留待写值：`, error);
      }
      return valueOf(context, key);
    }
    if (mem.has(key)) return mem.get(key);
    let value;
    try { value = await backend.get(pid, key); }
    catch (error) {
      console.warn(`[tide.cache] ${pid}/${key} 读取失败，本次退回 storage：`, error);
      return valueOf(context, key);
    }
    // 读盘期间 set/remove 已更新内存时，不再迁移旧值，否则旧值会排在新写入后覆盖磁盘。
    if (mem.has(key)) return mem.get(key);
    if (!current()) return value;
    const legacy = has(ns, key) ? ns[key] : undefined;
    if (value == null && legacy !== undefined && legacy !== null) {
      try {
        if (!await write(key, legacy, current)) return valueOf(context, key);
        value = legacy;
        if (current()) dropLegacy(context, key);
      }
      catch (error) {
        console.warn(`[tide.cache] ${pid}/${key} 迁移失败，旧值继续留在 storage：`, error);
        return valueOf(context, key);
      }
    } else if (legacy !== undefined) dropLegacy(context, key);
    // 迁移落盘期间仍可能有 set/remove —— 以内存里的为准，别用旧值盖掉它。
    if (mem.has(key)) return mem.get(key);
    mem.set(key, value ?? null);
    return value;
  }

  async function get(key, fallback = null) {
    check(key);
    const context = scope();
    const { ns, state, dirty } = context;
    const { mem, reads, writing } = state;
    if (!backend) return (has(ns, key) ? ns[key] : null) ?? fallback;
    if (mem.has(key) && (writing.has(key) || !has(dirty, key))) return mem.get(key) ?? fallback;
    if (!reads.has(key)) reads.set(key, read(context, key));
    const pending = reads.get(key);
    try { return (await pending) ?? fallback; }
    finally { if (reads.get(key) === pending) reads.delete(key); }
  }

  async function set(key, value) {
    check(key);
    const context = scope();
    const { ns, state, dirty } = context;
    const { mem, tokens, writing } = state;
    const token = {};
    tokens.set(key, token);
    mem.set(key, value ?? null);
    if (!backend) {
      if (value == null) delete ns[key]; else put(ns, key, value);
      persist();
      return;
    }
    writing.set(key, token);
    try { await write(key, value); if (tokens.get(key) === token) dropLegacy(context, key); }
    catch (error) {
      // 落盘失败（磁盘满 / 权限）：退回 storage，别让刚抓回来的数据就这么丢了。
      console.warn(`[tide.cache] ${pid}/${key} 写入失败，本次退回 storage：`, error);
      if (tokens.get(key) === token) {
        if (value == null) delete ns[key]; else put(ns, key, value);
        put(dirty, key, true);
        persist();
      }
    }
    finally { if (writing.get(key) === token) writing.delete(key); }
  }

  return { get, set, remove: (key) => set(key, null) };
}
