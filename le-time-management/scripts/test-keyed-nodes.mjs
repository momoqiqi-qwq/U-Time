import assert from "node:assert/strict";
import { createKeyedNodes } from "../src/keyedNodes.js";

class Node {
  constructor(id) { this.id = id; this.children = []; this.parent = null; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { const list = this.parent?.children || []; return list[list.indexOf(this) + 1] || null; }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  insertBefore(node, before) {
    node.remove();
    const index = before ? this.children.indexOf(before) : this.children.length;
    assert.ok(index >= 0); this.children.splice(index, 0, node); node.parent = this;
  }
}
const parent = new Node("root"), reconcile = createKeyedNodes(parent);
let created = 0;
const entry = (key, signature = "v1") => ({ key, signature, create: () => { created++; return new Node(key); } });
reconcile([entry("a"), entry("b")]);
const [a, b] = parent.children; a.expanded = true;
reconcile([entry("a"), entry("b")]);
assert.equal(created, 2, "无关更新不能创建新节点");
reconcile([entry("b"), entry("a")]);
assert.deepEqual(parent.children, [b, a]); assert.equal(a.expanded, true);
reconcile([entry("b", "v2"), entry("a"), entry("c")]);
assert.notEqual(parent.children[0], b); assert.equal(parent.children[1], a);
assert.equal(b.parent, null);
reconcile([entry("c"), entry("a")]);
assert.deepEqual(parent.children.map(node => node.id), ["c", "a"]);
reconcile([]); assert.equal(parent.children.length, 0);
console.log("PASS: 未变化节点保留、重排复用、局部替换、删除与展开状态");
