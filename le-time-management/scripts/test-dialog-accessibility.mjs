import assert from "node:assert/strict";
import fs from "node:fs";
const source = fs.readFileSync(new URL("../src/ui.js", import.meta.url), "utf8");
let active = null;
class Node {
  constructor(tag, attrs = {}, ...children) { this.tag = tag; this.attrs = attrs; this.children = []; this.parent = null; this.nodeType = 1; this.value = attrs.value; this.disabled = false; this.append(...children.flat().filter((x) => x != null)); }
  append(...children) { for (const c of children) { this.children.push(c); if (typeof c === "object") c.parent = this; } }
  get isConnected() { return this === body || Boolean(this.parent?.isConnected); }
  matches(selector) {
    if (selector === '[tabindex="0"]') return this.attrs.tabindex === "0";
    if (selector === 'a[href]') return this.tag === 'a' && Boolean(this.attrs.href);
    if (selector.startsWith('.')) return selector.slice(1).split('.').every((s) => (this.attrs.class || '').split(' ').includes(s));
    return this.tag === selector;
  }
  querySelectorAll(selectors) {
    const options = selectors.split(',').map((s) => s.trim());
    return this.children.filter((n) => typeof n === 'object').flatMap((n) => [...(options.some((s) => n.matches(s)) ? [n] : []), ...n.querySelectorAll(selectors)]);
  }
  querySelector(s) { return this.querySelectorAll(s)[0]; }
  contains(n) { return this === n || this.children.some((c) => typeof c === 'object' && c.contains(n)); }
  focus() { active = this; }
  select() { this.selected = true; }
  getClientRects() { return this.isConnected ? [{}] : []; }
  addEventListener(type, fn) { this.attrs['on' + type] = fn; }
  remove() { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
}
const body = new Node('body'), keys = new Set();
const doc = { body, get activeElement() { return active; }, querySelectorAll: (s) => body.querySelectorAll(s),
  addEventListener: (type, fn) => { if (type === 'keydown') keys.add(fn); }, removeEventListener: (type, fn) => keys.delete(fn) };
const el = (...args) => new Node(...args);
const code = source.slice(source.indexOf('function appDialog('), source.indexOf('/**\n * 底部系统栏')).replace(/export /g, '');
const { appConfirm, appPrompt } = new Function('document', 'el', `${code}\nreturn {appConfirm,appPrompt};`)(doc, el);
function key(name, shiftKey = false) {
  const e = { key: name, shiftKey, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  for (const fn of [...keys]) { fn(e); if (e.stopped) break; }
  return e;
}
const trigger = el('button'); body.append(trigger); trigger.focus();
const content = el('div', { tabindex: '0' }, 'Read me');
const rich = appConfirm('Disclosure', content, { dialogClass: 'disclaimer-dialog', focusMessage: true });
const box = body.querySelector('.app-dialog');
assert.ok(box.children.includes(content), 'rich content is not wrapped inside a paragraph');
assert.equal(active, content);
assert.ok(key('Tab', true).prevented); assert.equal(active, box.querySelector('.pri'));
assert.ok(key('Tab').prevented); assert.equal(active, content);
key('Escape'); assert.equal(await rich, false); assert.equal(active, trigger); assert.equal(keys.size, 0);
const plain = appConfirm('Plain', '<b>literal</b>');
assert.equal(body.querySelector('.app-dialog-msg').children[0], '<b>literal</b>', 'plain message stays text');
body.querySelector('.pri').attrs.onclick(); assert.equal(await plain, true); assert.equal(active, trigger);
const input = appPrompt('Name', { value: '  Alice  ' });
assert.equal(active.tag, 'input'); assert.equal(active.selected, true);
active.attrs.onkeydown({ key: 'Enter', stopPropagation() {} }); assert.equal(await input, 'Alice');
const lower = appConfirm('Lower', 'one'), upper = appConfirm('Upper', 'two');
key('Escape'); assert.equal(await upper, false); assert.equal(body.querySelectorAll('.app-dialog-mask').length, 1);
assert.equal(active, body.querySelector('.pri'), 'nested dialog restores focus to underlying dialog');
key('Escape'); assert.equal(await lower, false); assert.equal(active, trigger);
const outside = appConfirm('Backdrop', 'dismiss'); const mask = body.querySelector('.app-dialog-mask');
mask.attrs.onclick({ target: mask }); assert.equal(await outside, false); assert.equal(keys.size, 0);
console.log('PASS: rich/plain dialogs, reading focus, Tab wrapping, Escape, nested focus restoration, prompt and backdrop');
