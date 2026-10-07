import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/plugins/chaoxing-notify/main.js', import.meta.url), 'utf8');
const listeners = {}, storage = {}, requests = [];
let focused = false;
const tools = { open: true, contains: () => false, querySelector: () => ({ focus: () => { focused = true; } }) };
const host = { isConnected: true, innerHTML: '', addEventListener: (type, fn) => { listeners[type] = fn; },
  querySelector: selector => selector === '[data-tools]' ? tools : null };
const context = vm.createContext({ console, URL, atob, setTimeout, clearTimeout,
  tide: { ui: { registerView() {} }, notify() {},
    storage: { get: async (k, fallback) => storage[k] ?? fallback, set: async (k, v) => { storage[k] = v; } },
    http: { session: async () => 'fixture', fetch: async (...args) => {
      requests.push(args); return { status: 200, cookies: [], body: JSON.stringify({ notices: { list: [], lastPage: true } }) };
    } } } });
vm.runInContext(source.replace('  tide.ui.registerView({',
  '  globalThis.fixture = { state, paintMain, mount(el) { host = el; wire(); paintMain(); } };\n  tide.ui.registerView({'), context);
const { state, mount, paintMain } = context.fixture;
state.loggedIn = true;
state.ignoredIds.add('hidden');
mount(host);
const target = selector => ({ closest: sel => sel === selector ? {} : null });

// 完整同步必须通过实际点击链路发起请求，完成后结束 loading 并写入同步时间。
await listeners.click({ target: target('[data-full-sync]') });
assert.equal(requests.length, 1);
assert.match(requests[0][2], /getNoticeList/);
assert.equal(state.loading, false);
assert.ok(storage.lastSyncAt > 0);

// 菜单选择继续保存原有刷新策略，恢复移除继续使用本机记录。
await listeners.click({ target: { closest: sel => sel === '[data-mode]' ? { dataset: { mode: 'throttle' } } : null } });
assert.equal(storage.refreshMode, 'throttle');
await listeners.click({ target: target('[data-ignore-reset]') });
assert.equal(state.ignoredIds.size, 0);
assert.equal(storage.ignoredIds.length, 0);

tools.open = true;
let stopped = false;
listeners.keydown({ key: 'Escape', target: { matches: () => false }, stopPropagation: () => { stopped = true; } });
assert.equal(tools.open, false);
assert.equal(focused, true);
assert.equal(stopped, true);
tools.open = true;
await listeners.click({ target: target('none') });
assert.equal(tools.open, false);

// 搜索统计表达当前筛选结果，避免显示未过滤的总数。
state.inbox = [{ id: 'a', title: '数学', body: '', unread: true }, { id: 'b', title: '英语', body: '' }];
state.filter.kw = '数学';
paintMain();
assert.match(host.innerHTML, /显示 1 \/ 共 2 条/);
assert.doesNotMatch(host.innerHTML, /本次新增 0|无 IP 白名单主路径/);
console.log('PASS: 学习通更多菜单实际操作链路、完整同步、刷新策略持久化、恢复移除、Escape 焦点恢复与筛选统计');
