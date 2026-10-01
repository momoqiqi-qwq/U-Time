import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../public/plugins/github-readme/main.js', import.meta.url), 'utf8');
const listeners = {};
let failStore = false;
const writes = [];
const requests = [];
let releaseFetch = null;
let gate = null;
const root = {
  isConnected: true, innerHTML: '',
  querySelector() { return null; }, querySelectorAll() { return []; },
  addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
};
const feed = '<feed><entry><id>tag:github.com,2008:Grit::Commit/current</id><title>Update</title><updated>2026-09-30T00:00:00Z</updated></entry></feed>';
const ctx = vm.createContext({
  console, URL, Date, setTimeout, clearTimeout,
  setInterval: () => 1, clearInterval() {},
  window: { addEventListener() {}, innerWidth: 1000, innerHeight: 800 },
  document: { activeElement: null, visibilityState: 'visible', addEventListener() {}, getElementById: () => ({}), documentElement: {} },
  tide: {
    ui: { registerView() {} }, notify() {}, events: { emit() {} }, tasks: { create() {} }, util: { openUrl() {} },
    storage: { get: async (_, fallback) => fallback, set: async (key, value) => { if (failStore) throw Error('disk'); writes.push([key, JSON.parse(JSON.stringify(value))]); } },
    http: { get: async (url) => {
      requests.push(url); if (gate) await gate;
      if (url.includes('/readme')) return { status: 200, body: JSON.stringify({ path: 'README.md', download_url: 'https://raw.githubusercontent.com/o/new/main/README.md' }) };
      if (url.endsWith('.atom')) return { status: 200, body: feed };
      return { status: 200, body: '# Updated' };
    } },
  },
});
vm.runInContext(source.replace('  tide.ui.registerView({', `  globalThis.api = {
  state, page, bind, doSync, doAdd, saveEditor, openEditor, closeEditor, repoCard, listHtml, editorHtml, readerHtml, paint,
  getEditor: () => editor, getFeedback: () => feedback, getAdding: () => adding,
  attach: (el) => { rootEl = el; }, setDraft: (v) => { inputDraft = v; },
};\n  tide.ui.registerView({`), ctx);
const a = ctx.api;
a.attach(root);
a.bind(root); a.bind(root);
assert.equal(listeners.click.length, 1, '重复挂载同一个容器不叠加点击处理器');
const repo = () => ({ owner: 'o', repo: 'r', branch: 'main', path: 'README.md', dir: '', sha: 'current', error: '', commit: null });
a.state.repos = [repo()]; a.state.docs['o/r'] = '# Old';
const target = (selector, dataset = {}) => ({ dataset, closest: (s) => s === selector ? target(selector, dataset) : null, matches: (s) => s === selector });
const click = async (selector, dataset) => { for (const fn of listeners.click) await fn({ target: target(selector, dataset) }); };
const input = (field, value) => { for (const fn of listeners.input) fn({ target: { value, dataset: { ghField: field }, matches: () => false } }); };
const key = async (name, field, extra = {}) => { for (const fn of listeners.keydown) await fn({ key: name, target: { dataset: { ghField: field }, matches: () => false }, preventDefault() {}, ...extra }); };
assert.doesNotMatch(source, /window\.prompt|window\.confirm/, '不再借用原生弹窗');
assert.match(a.repoCard(a.state.repos[0]), /data-gh-edit="o\/r"/, '编辑入口不藏在右键菜单');
assert.match(a.repoCard(a.state.repos[0]), /<article[\s\S]*<button[^>]*data-gh-open/, '阅读是独立原生按钮，不嵌套操作按钮');
await click('[data-gh-edit]', { ghEdit: 'o/r' });
assert.equal(a.getEditor().key, 'o/r');
input('name', '我的文档'); input('note', '阅读\n计划');
await key('Enter', 'name', { isComposing: true });
assert.equal(a.state.repos[0].alias, undefined, '输入法选词不触发保存');
await key('Escape', 'name');
assert.equal(a.getEditor(), null); assert.equal(a.state.repos[0].alias, undefined, '取消不改数据');
await click('[data-gh-edit]', { ghEdit: 'o/r' });
input('name', '<script>草稿</script>'); input('note', '阅读\n计划');
a.paint();
assert.match(root.innerHTML, /&lt;script&gt;草稿&lt;\/script&gt;/, '表单输出转义且重绘保留草稿');
a.openEditor('o/r');
assert.equal(a.getEditor().alias, '<script>草稿</script>', '重复编辑不丢草稿');
failStore = true;
await click('[data-gh-save]');
assert.equal(a.state.repos[0].alias, undefined, '落盘失败不伪装成功');
assert.match(a.getEditor().error, /保存失败/);
assert.equal(a.getEditor().saving, false);
failStore = false;
await key('Enter', 'note', { ctrlKey: true });
assert.equal(a.state.repos[0].alias, '<script>草稿</script>');
assert.equal(a.state.repos[0].note, '阅读 计划');
assert.equal(a.getEditor(), null);
a.openEditor('o/r'); input('name', ''); input('note', '');
await click('[data-gh-save]');
assert.equal(a.state.repos[0].alias, ''); assert.equal(a.state.repos[0].note, '');
await click('[data-gh-del]', { ghDel: 'o/r' });
assert.equal(a.state.repos.length, 1, '点移除只打开确认面板');
assert.equal(a.getEditor().remove, true);
await click('[data-gh-cancel]'); assert.equal(a.state.repos.length, 1);
await click('[data-gh-del]', { ghDel: 'o/r' });
failStore = true; await click('[data-gh-save]');
assert.equal(a.state.repos.length, 1, '移除保存失败保留原仓库');
failStore = false; await click('[data-gh-save]');
assert.equal(a.state.repos.length, 0); assert.equal(a.state.docs['o/r'], undefined);
// 同步按钮必须真的发请求；重复点击只发一轮。
a.state.repos = [repo()]; a.state.docs['o/r'] = '# Old';
requests.length = 0;
gate = new Promise((resolve) => { releaseFetch = resolve; });
const sync = click('[data-gh-sync]');
assert.equal(a.state.syncing, true);
assert.match(root.innerHTML, /同步中/);
await click('[data-gh-sync]');
assert.equal(requests.length, 1);
releaseFetch(); gate = null; await sync;
assert.equal(a.state.syncing, false); assert.equal(requests.length, 1, '已有缓存且 SHA 不变不重复拉正文');
a.page.key = 'o/r'; a.page.at = 'reader';
await click('[data-gh-sync-one]');
assert.equal(a.state.docs['o/r'], '# Updated', '重新拉取在 SHA 不变时也获取正文');
assert.ok(requests.some((u) => u.includes('raw.githubusercontent.com')));
// 保存异常也释放同步锁，界面保留可重试错误。
failStore = true; await click('[data-gh-sync]');
assert.equal(a.state.syncing, false); assert.match(a.state.error, /同步未完成/); failStore = false;
// 添加防重复请求、错误保留输入。读取入口点击含标记已读行为。
a.page.at = 'list'; a.setDraft('o/new'); requests.length = 0;
gate = new Promise((resolve) => { releaseFetch = resolve; });
const adding = a.doAdd(root); assert.equal(a.getAdding(), true);
await a.doAdd(root); assert.equal(requests.length, 1);
releaseFetch(); gate = null; await adding;
assert.equal(a.getAdding(), false); assert.equal(a.state.repos.filter((r) => r.repo === 'new').length, 1);
await click('[data-gh-open]', { ghOpen: 'o/r' });
assert.equal(a.page.at, 'reader'); assert.ok(a.state.seen.has('o/r:current'));
console.log('PASS: GitHub 文档交互 —— 真源码委托事件 / 编辑取消保存 / 草稿与转义 / 保存失败 / 移除确认 / 同步请求与防重入 / 强制拉取 / 添加防重 / 已读 / 重复绑定');
