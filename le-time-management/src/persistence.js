// 串行提交 JSON 快照；状态通知独立于业务刷新，保存回执不会触发自动化。
export function createPersistence({ write, snapshot, delay = 350 }) {
  let timer = null, chain = Promise.resolve(), revision = 0, savedRevision = 0;
  let status = { phase: "saved", error: "", savedAt: null };
  const listeners = new Set();
  const publish = (next) => {
    status = { ...status, ...next };
    for (const fn of listeners) { try { fn({ ...status }); } catch (e) { console.error(e); } }
  };
  function flush() {
    clearTimeout(timer); timer = null;
    const run = chain.catch(() => {}).then(async () => {
      const current = snapshot();
      if (!current) throw new Error("数据尚未成功读取，已禁止保存以保护原文件");
      const target = revision;
      const data = structuredClone(current);
      publish({ phase: "saving", error: "" });
      await write(data);
      savedRevision = target;
      publish({ phase: revision === savedRevision ? "saved" : "pending", error: "", savedAt: Date.now() });
    }).catch((error) => {
      publish({ phase: "error", error: String(error?.message || error) });
      throw error;
    });
    chain = run;
    // 自动保存和旧事件处理器可忽略返回值；显式 await 仍收到拒绝结果。
    run.catch(() => {});
    return run;
  }
  return {
    flush,
    schedule() {
      revision++;
      publish({ phase: "pending" });
      clearTimeout(timer);
      timer = setTimeout(() => { flush(); }, delay);
    },
    reset() {
      clearTimeout(timer); timer = null;
      revision = 0; savedRevision = 0;
      publish({ phase: "saved", error: "", savedAt: null });
    },
    getStatus: () => ({ ...status }),
    subscribe(fn) {
      listeners.add(fn); fn({ ...status });
      return () => listeners.delete(fn);
    },
  };
}
