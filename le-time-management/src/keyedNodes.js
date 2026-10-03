// 只替换内容变化的节点；重排复用原节点，保留展开态、焦点及浏览器状态。
export function createKeyedNodes(parent) {
  let previous = new Map();
  return function reconcile(entries) {
    const next = new Map();
    for (const entry of entries) {
      const cached = previous.get(entry.key);
      const node = cached?.signature === entry.signature ? cached.node : entry.create();
      next.set(entry.key, { signature: entry.signature, node });
    }
    for (const [key, value] of previous) if (!next.has(key) || next.get(key).node !== value.node) value.node.remove();
    let cursor = parent.firstChild;
    for (const { node } of next.values()) {
      if (node !== cursor) parent.insertBefore(node, cursor);
      cursor = node.nextSibling;
    }
    previous = next;
  };
}
