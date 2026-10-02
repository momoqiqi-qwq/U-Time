import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/plugins/cppu-notify/main.js', import.meta.url), 'utf8');
const store = {};
const context = vm.createContext({
  URL, Date, Set, Map, console, setTimeout, clearTimeout, setInterval, clearInterval,
  tide: { ui: { registerView() {} }, storage: {
    async get(key, fallback) { return store[key] ?? fallback; },
    async set(key, value) { store[key] = structuredClone(value); },
  } },
});
vm.runInContext(source.replace('  tide.ui.registerView({',
  '  globalThis.api = { state, jwState, saveNoticeCache, restoreNoticeCache, jwSaveCache, jwRestoreCache };\n  tide.ui.registerView({'), context);
const { state, jwState, saveNoticeCache, restoreNoticeCache, jwSaveCache, jwRestoreCache } = context.api;
state.username = 'account-a';
state.notices = [{ RESOURCE_ID: 'n1', PIM_TITLE: 'cached notice' }];
state.details = { n1: { content: 'cached body' }, n2: { error: 'network error' } };
state.fetchedAt = 12345;
state.savedPassword = 'must-not-be-cached';
await saveNoticeCache();
assert.ok(!JSON.stringify(store.noticeCache).includes('must-not-be-cached'));
state.notices = []; state.details = {}; state.fetchedAt = 0;
assert.equal(await restoreNoticeCache(), true);
assert.equal(state.notices[0].PIM_TITLE, 'cached notice');
assert.equal(state.details.n1.content, 'cached body');
assert.equal(state.fetchedAt, 12345);
state.username = 'account-b'; state.notices = [];
assert.equal(await restoreNoticeCache(), false, 'another account must not see cached notices');
assert.equal(state.notices.length, 0);
store.noticeCache = { username: 'account-b', notices: [], at: 456 };
assert.equal(await restoreNoticeCache(), true, 'a successful empty result is also cached');
store.noticeCache = { username: 'account-b', notices: null };
assert.equal(await restoreNoticeCache(), false);
jwState.data.grade = [{ KCMC: 'cached course', ZPCJ: 90 }];
jwState.at.grade = 678;
await jwSaveCache();
jwState.data.grade = null; jwState.at = {};
await jwRestoreCache();
assert.equal(jwState.data.grade[0].ZPCJ, 90);
assert.equal(jwState.at.grade, 678);
state.username = 'account-c'; jwState.data.grade = null;
await jwRestoreCache();
assert.equal(jwState.data.grade, null);
delete store.jwCache.username;
await jwRestoreCache();
assert.equal(jwState.data.grade[0].KCMC, 'cached course', 'legacy caches remain readable');
assert.match(source, /!jwLive\(\) && el\.isConnected && cfg\.keys\.some/);
assert.match(source, /data-jw-login/);
console.log('PASS: CPPU persistent notice and grade caches, account isolation, legacy cache compatibility');
