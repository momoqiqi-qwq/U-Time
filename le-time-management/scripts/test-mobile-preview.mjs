import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { isMobilePreview, mobilePreviewUrl, previewSnapshot, MOBILE_PREVIEW_KEY } from '../src/mobilePreview.js';

const top = { location: { search: '?mobile-preview=1' } }; top.parent = top;
assert.equal(isMobilePreview(top), false, 'top-level app must keep native runtime');
const frame = { parent: top, location: { search: '?mobile-preview=1' } };
assert.equal(isMobilePreview(frame), true);
assert.equal(isMobilePreview({ parent: top, location: { search: '' } }), false);
assert.equal(mobilePreviewUrl('http://tauri.localhost/index.html?old=1#settings'), 'http://tauri.localhost/index.html?mobile-preview=1');
const production = { tasks: [{ title: 'original' }], settings: { ui: { uiScale: 150, startupView: 'last' }, theme: 'night' }, plugins: {} };
const copy = previewSnapshot(production);
copy.tasks[0].title = 'test';
assert.equal(production.tasks[0].title, 'original');
assert.equal(copy.settings.ui.uiScale, 100);
assert.equal(production.settings.ui.uiScale, 150);
assert.equal(copy.settings.ui.startupView, 'quadrant');
assert.equal(copy.settings.theme, 'night');

const apiSource = fs.readFileSync(new URL('../src/api.js', import.meta.url), 'utf8');
let nativeCalls = 0;
const saved = new Map();
const context = vm.createContext({ isMobilePreview: () => true, MOBILE_PREVIEW_KEY,
  window: { parent: {}, location: { search: '?mobile-preview=1' }, __TAURI_INTERNALS__: { invoke() { nativeCalls++; } } },
  localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
});
vm.runInContext(apiSource.replace(/^import .+;$/gm, '').replaceAll('import.meta.env.DEV', 'false').replace('export const api =', 'globalThis.api ='), context);
await context.api.saveData(copy);
assert.equal(nativeCalls, 0);
assert.equal(saved.has(MOBILE_PREVIEW_KEY), true);
assert.equal(saved.has('tidebalance-data'), false);
assert.equal((await context.api.loadData()).tasks[0].title, 'test');

// 同源桌面宿主提供真实登录会话，预览中的凭据写入/删除只覆盖内存副本。
const loginCalls = [];
context.window.location.origin = 'http://tauri.localhost';
context.window.parent.location = { origin: 'http://tauri.localhost' };
context.window.parent.__TAURI_INTERNALS__ = { async invoke(cmd, args) {
  loginCalls.push({ cmd, args });
  if (cmd === 'plugin_vault_get') return 'saved-login-fixture';
  if (cmd === 'http_session_new') return 'preview-session';
  if (cmd === 'http_session_restore') return 'restored-preview-session';
  if (cmd === 'http_session_export') return [{ url: 'https://sso.cppu.edu.cn', cookie: 'fixture' }];
  if (cmd === 'http_fetch') return { status: 200, body: 'login response' };
  if (cmd === 'des_ecb_encrypt_hex') return 'encrypted-fixture';
  throw new Error(`Unexpected native mutation: ${cmd}`);
} };
assert.equal(context.api.isTauri, false, 'preview must retain isolated app runtime');
assert.equal(await context.api.pluginVaultGet('cppu-notify', 'secret'), 'saved-login-fixture');
assert.equal(await context.api.httpSessionNew(), 'preview-session');
assert.equal(await context.api.httpSessionRestore([{ cookie: 'fixture' }]), 'restored-preview-session');
assert.equal((await context.api.httpFetch('preview-session', 'GET', 'https://sso.cppu.edu.cn')).status, 200);
assert.equal((await context.api.httpSessionExport('preview-session', [])).length, 1);
assert.equal(await context.api.desEncryptHex('fixture', 'fixture'), 'encrypted-fixture');
const callsBeforeWrites = loginCalls.length;
await context.api.pluginVaultSet('cppu-notify', 'secret', 'preview-only-fixture');
assert.equal(await context.api.pluginVaultGet('cppu-notify', 'secret'), 'preview-only-fixture');
assert.equal(await context.api.pluginVaultGet('other-plugin', 'secret'), 'saved-login-fixture');
await context.api.pluginVaultDel('cppu-notify', 'secret');
assert.equal(await context.api.pluginVaultGet('cppu-notify', 'secret'), null);
await context.api.saveData(copy);
assert.equal(loginCalls.length, callsBeforeWrites + 1, 'only the other plugin read reaches native host');
assert.equal(nativeCalls, 0, 'preview never uses its own native runtime');
assert.ok(![...saved.values()].some(value => /saved-login-fixture|preview-only-fixture/.test(value)), 'credentials stay out of localStorage');
context.window.parent.location.origin = 'https://other.example';
assert.equal(await context.api.pluginVaultGet('cppu-notify', 'cookies'), null);
assert.equal(loginCalls.length, callsBeforeWrites + 1, 'different-origin host cannot supply credentials');

const settings = fs.readFileSync(new URL('../src/views/settings.js', import.meta.url), 'utf8');
assert.match(settings, /id: "testing", node: testingCard, label: "测试"/);
assert.ok(!settings.includes('http://127.0.0.1:1420/'));
const testing = fs.readFileSync(new URL('../src/views/settings/testing.js', import.meta.url), 'utf8');
assert.ok(!testing.includes('openExternal'));
assert.match(testing, /el\("iframe"/);
const shell = fs.readFileSync(new URL('../src/shell.js', import.meta.url), 'utf8');
assert.match(shell, /isNativeAndroidRuntime\(\) \|\| isMobilePreview\(\)/);
console.log('PASS: embedded mobile preview, isolated data and credentials, same-origin native automatic login');
