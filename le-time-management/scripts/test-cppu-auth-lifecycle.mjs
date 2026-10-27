import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the shipped lifecycle functions with delayed transports/storage; no real credentials or network.
const source = fs.readFileSync(new URL('../public/plugins/cppu-notify/main.js', import.meta.url), 'utf8');
function slice(from, to) {
  const a = source.indexOf(from), b = source.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `Missing source boundary: ${from} … ${to}`);
  return source.slice(a, b);
}
const code = [
  slice('  let authEpoch =', '  const saveFilter ='),
  slice('  async function saveCookies()', '  /* ── SSO 登录链路 ── */'),
  slice('  let passwordLoginPending =', '  function loginSettingsHtml()'),
  slice('  async function persistCredentials(', '  async function finishPortalTicket('),
  slice('  async function saveNoticeCache()', '  async function restoreNoticeCache()'),
  slice('  async function loadPage(', '  // 筛选结果为 0 时旧的'),
  slice('  async function awFetchList(', '  /* 覆盖区间：'),
].join('\n');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function until(predicate, label) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(`Async checkpoint not reached: ${label}`);
}
const cookies = [{ url: 'https://portal-jw.cppu.edu.cn', cookie: 'tp_up=fixture-token' }];
function harness({ store = {}, vault = {}, overrides = {} } = {}) {
  const storage = { username: 'alice', autoLogin: true, ...store };
  const secrets = { cookies: JSON.stringify({ username: 'alice', cookies }), ...vault };
  const calls = { restore: 0, export: 0, login: 0, mark: 0, fetch: 0, recovery: 0, paint: 0,
    publish: 0, broadcast: 0, inbox: [], caches: [], gets: [], sets: [], deletes: [], notices: [] };
  const cache = {};
  const state = { username: 'alice', sid: null, token: '', savedPassword: 'fixture-password', autoLogin: true,
    pending: { execution: 'fixture-execution' }, captcha: 'fixture-image', loginAt: 12,
    notices: [{ id: 'old' }], details: { old: {} }, fetchedAt: 12, filter: {}, seen: new Set() };
  const box = {
    state, console, navigator: { onLine: true }, loginBusy: false, loginHint: null,
    loginPrefsReady: null, jwSid: 'old-sid', jwBootPromise: null, jwRound: 0, jwRoundLoginFailed: -1,
    jwState: { data: { grade: { old: true }, exam: { old: true } }, at: { old: 1 }, error: {}, term: 'old' },
    awState: { sessionOk: true }, PDATA_VAULT_KEY: 'pdataAuth',
    SSO: 'https://sso.cppu.edu.cn', JW: 'https://sso-jw.cppu.edu.cn',
    PORTAL: 'https://portal-jw.cppu.edu.cn', JWAPP: 'https://jw.cppu.edu.cn', PDATA: 'https://pdata.cppu.edu.cn',
    PAGE_SIZE: 20, PAGES_MAX: 10,
    itemKey: item => item.RESOURCE_ID || item.id, titleOf: item => item.TITLE || '', referer: () => 'https://fixture.invalid',
    paintStatus() {}, paintAll() { calls.paint++; }, publishNotices() { calls.publish++; },
    broadcastNew: async () => { calls.broadcast++; },
    silentRenew: async () => { calls.recovery++; return false; }, restoreNoticeCache: async () => false,
    explainHttpError: error => String(error?.message || error),
    cacheStore: { set: async (key, value) => { calls.caches.push(value); await overrides.cacheSet?.(key, value); cache[key] = value; } },
    forgetPdataAuth() {}, cleanLoginRetries: value => Number(value) || 2,
    tokenFromText: (...values) => values.join(';').match(/tp_up=([^;]+)/)?.[1] || '',
    loginErrorText: error => String(error?.message || error?.fatal || error),
    markLoginAt() { calls.mark++; },
    runLoginAttempts: async options => { calls.login++; await overrides.login?.(options); },
    tide: {
      notify: message => calls.notices.push(message),
      inbox: { create: value => calls.inbox.push(value) },
      storage: {
        get: async (key, fallback) => overrides.storageGet ? overrides.storageGet(key, fallback, storage) : key in storage ? storage[key] : fallback,
        set: async (key, value) => { storage[key] = value; },
      },
      vault: {
        get: async key => { calls.gets.push(key); return overrides.vaultGet ? overrides.vaultGet(key, secrets) : secrets[key] || null; },
        set: async (key, value) => { calls.sets.push(key); await overrides.vaultSet?.(key, value); secrets[key] = value; },
        del: async key => { calls.deletes.push(key); await overrides.vaultDel?.(key); delete secrets[key]; },
      },
      http: {
        restoreCookies: async dump => { calls.restore++; return overrides.restore ? overrides.restore(dump) : 'restored-sid'; },
        exportCookies: async () => { calls.export++; return overrides.export ? overrides.export() : cookies; },
        session: async () => overrides.session ? overrides.session() : 'new-sid',
        fetch: async (...args) => { calls.fetch++; return overrides.fetch ? overrides.fetch(...args) : { status: 200, body: JSON.stringify({ list: [] }) }; },
      },
    },
  };
  vm.runInNewContext(code + '\nglobalThis.auth = { loadPrefs, saveCookies, restoreCookies, clearSavedLogin, persistCredentials, passwordAutoLogin, savedPasswordFor, ensureSid, saveNoticeCache, loadPage, awFetchList };', box);
  return { ...box.auth, box, state, calls, storage, secrets, cache };
}
const tests = [];
const test = (name, run) => tests.push({ name, run });

test('disabled auto-login neither exports nor restores cookies', async () => {
  const h = harness(); h.state.autoLogin = false; h.state.sid = 'live';
  await h.saveCookies(); assert.equal(await h.restoreCookies(), false);
  assert.equal(h.calls.export, 0); assert.equal(h.calls.restore, 0); assert.deepEqual(h.calls.sets, []);
  const cold = harness({ store: { autoLogin: false } });
  assert.equal(await cold.restoreCookies(), false, 'cold-start default must respect persisted switch');
  assert.equal(cold.calls.restore, 0);
});

test('concurrent restore uses one transport and preserves active session', async () => {
  const gate = deferred(), h = harness({ overrides: { restore: () => gate.promise } });
  const a = h.restoreCookies(), b = h.restoreCookies();
  await until(() => h.calls.restore === 1, 'restore started'); gate.resolve('restored-sid');
  assert.deepEqual(await Promise.all([a, b]), [true, true]); assert.equal(h.calls.restore, 1);
  assert.equal(h.state.token, 'fixture-token');
  assert.equal(await h.restoreCookies(), true); assert.equal(h.calls.restore, 1);
});

test('clear rejects a late restore result and resets identity caches', async () => {
  const gate = deferred(), h = harness({ overrides: { restore: () => gate.promise } });
  const pending = h.restoreCookies(); await until(() => h.calls.restore === 1, 'restore started');
  await h.clearSavedLogin(); gate.resolve('late-sid');
  assert.equal(await pending, false); assert.equal(h.state.sid, null); assert.equal(h.state.token, '');
  assert.equal(h.state.savedPassword, ''); assert.equal(h.state.pending, null);
  assert.equal(h.state.notices.length, 0); assert.equal(h.box.jwState.data.grade, null);
  assert.equal(h.box.jwState.data.exam, null); assert.equal(h.box.awState.sessionOk, false);
});

test('clearing blocks new hydration and recovery while old secrets still exist on disk', async () => {
  const gate = deferred(), h = harness({
    vault: { secret: JSON.stringify({ username: 'alice', password: 'old-password' }) },
    overrides: { vaultDel: () => gate.promise },
  });
  const clearing = h.clearSavedLogin(); await until(() => h.calls.deletes.length > 0, 'credential deletion started');
  assert.ok(h.secrets.secret && h.secrets.cookies, 'test must hold deletion while old disk values still exist');
  await h.loadPrefs(); assert.equal(await h.restoreCookies(), false);
  await h.persistCredentials('must-not-persist'); await h.saveCookies();
  assert.equal(h.calls.gets.length, 0); assert.equal(h.calls.restore, 0);
  assert.equal(h.state.savedPassword, ''); assert.equal(h.state.sid, null);
  assert.equal(h.calls.sets.length, 0);
  gate.resolve(); await clearing; await h.saveCookies();
  assert.equal(h.secrets.secret, undefined); assert.equal(h.secrets.cookies, undefined);
  assert.equal(h.calls.export, 0); assert.equal(h.calls.sets.length, 0);
});

test('empty transport sessions restore saved cookies, without replacing a newer foreground session', async () => {
  const h = harness(); await h.ensureSid(); assert.equal(h.state.sid, 'new-sid');
  assert.equal(await h.restoreCookies(), true); assert.equal(h.calls.restore, 1);
  assert.equal(h.state.sid, 'restored-sid'); assert.equal(h.state.token, 'fixture-token');
  h.state.token = ''; h.box.jwSid = null;
  assert.equal(await h.restoreCookies(), true); assert.equal(h.calls.restore, 1, 'cookieSessionSid must recognize a restored SSO-only session');

  const gate = deferred(), raced = harness({ overrides: { restore: () => gate.promise } });
  await raced.ensureSid(); const pending = raced.restoreCookies();
  await until(() => raced.calls.restore === 1, 'restore from empty transport started');
  raced.state.sid = 'new-foreground-sid'; raced.state.token = 'new-foreground-token';
  gate.resolve('late-restored-sid'); await pending;
  assert.equal(raced.state.sid, 'new-foreground-sid'); assert.equal(raced.state.token, 'new-foreground-token');
});

test('a late restore cannot attach one account cookies to another account', async () => {
  const gate = deferred(), h = harness({ overrides: { restore: () => gate.promise } });
  const pending = h.restoreCookies(); await until(() => h.calls.restore === 1, 'restore started');
  h.state.username = 'bob'; gate.resolve('alice-sid');
  assert.equal(await pending, false); assert.equal(h.state.sid, null); assert.equal(h.state.token, '');
});

test('late cookie export cannot write back after clearing credentials', async () => {
  const gate = deferred(), h = harness({ overrides: { export: () => gate.promise } }); h.state.sid = 'live';
  const pending = h.saveCookies(); await until(() => h.calls.export === 1, 'export started');
  await h.clearSavedLogin(); gate.resolve(cookies); await pending;
  assert.equal(h.secrets.cookies, undefined); assert.deepEqual(h.calls.sets, []);
});

test('clear runs after an already-started vault write', async () => {
  const gate = deferred(), h = harness({ overrides: { vaultSet: key => key === 'cookies' ? gate.promise : undefined } });
  h.state.sid = 'live'; const saving = h.saveCookies();
  await until(() => h.calls.sets.includes('cookies'), 'vault write started');
  let cleared = false; const clearing = h.clearSavedLogin().then(() => { cleared = true; });
  await Promise.resolve(); assert.equal(cleared, false, 'deletion must wait for the write already in flight');
  gate.resolve(); await Promise.all([saving, clearing]);
  assert.equal(h.secrets.cookies, undefined); assert.equal(h.secrets.secret, undefined);
});

test('clear cannot be undone by a password save already in flight', async () => {
  const gate = deferred(), h = harness({ overrides: { vaultSet: key => key === 'secret' ? gate.promise : undefined } });
  const saving = h.persistCredentials('late-password');
  await until(() => h.calls.sets.includes('secret'), 'password write started');
  const clearing = h.clearSavedLogin(); gate.resolve(); await Promise.all([saving, clearing]);
  assert.equal(h.secrets.secret, undefined); assert.equal(h.state.savedPassword, '');
});

test('one failed deletion does not skip other credentials', async () => {
  const h = harness({ vault: { secret: 'old', pdataAuth: 'old' }, overrides: { vaultDel: key => { if (key === 'secret') throw Error('locked'); } } });
  await h.clearSavedLogin();
  assert.equal(h.secrets.cookies, undefined); assert.equal(h.secrets.pdataAuth, undefined);
  assert.equal(h.storage.autoLoginAt, 0); assert.equal(h.state.savedPassword, '');
});

test('credentials are account-bound, while legacy cookies remain readable', async () => {
  const h = harness({ vault: { secret: JSON.stringify({ username: 'bob', password: 'bob-password' }) } });
  await h.loadPrefs(); assert.equal(h.state.savedPassword, '');
  h.secrets.cookies = JSON.stringify({ username: 'bob', cookies });
  assert.equal(await h.restoreCookies(), false); assert.equal(h.calls.restore, 0);
  h.secrets.cookies = JSON.stringify(cookies);
  assert.equal(await h.restoreCookies(), true); assert.equal(h.calls.restore, 1);
  await h.persistCredentials('alice-password'); await h.saveCookies();
  assert.deepEqual(JSON.parse(h.secrets.secret), { username: 'alice', password: 'alice-password' });
  assert.deepEqual(JSON.parse(h.secrets.cookies), { username: 'alice', cookies });
});

test('clear cancels password hydration and new-session creation', async () => {
  const gate = deferred(), h = harness({ overrides: { vaultGet: key => key === 'secret' ? gate.promise : null } });
  const reading = h.loadPrefs();
  await until(() => h.calls.gets.includes('secret'), 'password hydration started');
  await h.clearSavedLogin(); gate.resolve(JSON.stringify({ username: 'alice', password: 'late-password' }));
  await reading; assert.equal(h.state.savedPassword, '');
  const sessionGate = deferred(), s = harness({ overrides: { session: () => sessionGate.promise } });
  const pending = s.ensureSid(); await s.clearSavedLogin(); sessionGate.resolve('late-sid');
  assert.equal(await pending, null); assert.equal(s.state.sid, null);
});

test('parallel password recovery shares one attempt', async () => {
  const gate = deferred(), h = harness({ overrides: { login: () => gate.promise } });
  const a = h.passwordAutoLogin(), b = h.passwordAutoLogin();
  assert.equal(h.calls.login, 1); gate.resolve();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(h.calls.login, 1); assert.equal(h.calls.mark, 1);
});

test('password failure is cooled down and credentials stay available', async () => {
  const h = harness({ overrides: { login: () => { throw Error('network unavailable'); } } });
  assert.equal(await h.passwordAutoLogin(), false); assert.equal(await h.passwordAutoLogin(), false);
  assert.equal(h.calls.login, 1); assert.equal(h.state.savedPassword, 'fixture-password');
  assert.match(h.box.loginHint.msg, /暂停重复尝试/);
});

test('offline password recovery is skipped without consuming a later attempt', async () => {
  const h = harness(); h.box.navigator.onLine = false;
  assert.equal(await h.passwordAutoLogin(), false); assert.equal(h.calls.login, 0);
  h.box.navigator.onLine = true; assert.equal(await h.passwordAutoLogin(), true); assert.equal(h.calls.login, 1);
});

test('clear invalidates an in-flight password recovery', async () => {
  const gate = deferred(), h = harness({ overrides: { login: () => gate.promise } });
  const pending = h.passwordAutoLogin(); assert.equal(h.calls.login, 1);
  await h.clearSavedLogin(); gate.resolve();
  assert.equal(await pending, false); assert.equal(h.calls.mark, 0); assert.deepEqual(h.calls.sets, []);
  assert.equal(h.secrets.secret, undefined); assert.equal(h.state.savedPassword, '');
});

const noticeResponse = id => ({ status: 200, body: JSON.stringify({ list: [{ RESOURCE_ID: id, TITLE: id }] }) });
test('late notice response after clear cannot publish, cache, or broadcast', async () => {
  const gate = deferred(), h = harness({ overrides: { fetch: () => gate.promise } });
  const pending = h.loadPage(); assert.equal(h.calls.fetch, 1);
  await h.clearSavedLogin(); gate.resolve(noticeResponse('alice-old'));
  assert.equal(await pending, false); assert.equal(h.state.notices.length, 0);
  assert.equal(h.calls.publish, 0); assert.equal(h.calls.caches.length, 0);
  assert.equal(h.calls.inbox.length, 0); assert.equal(h.calls.broadcast, 0);
  assert.equal(h.state.fetching, false);
});

test('new account can fetch immediately, and old completion cannot release its lock', async () => {
  const oldGate = deferred(), newGate = deferred();
  let count = 0;
  const h = harness({ overrides: { fetch: () => ++count === 1 ? oldGate.promise : newGate.promise } });
  const oldRequest = h.loadPage(); await h.clearSavedLogin(); h.state.username = 'bob'; h.state.sid = 'bob-sid';
  const newRequest = h.loadPage(); assert.equal(h.calls.fetch, 2, 'new generation must not be blocked by old fetching flag');
  oldGate.resolve(noticeResponse('alice-old')); assert.equal(await oldRequest, false);
  assert.equal(h.state.fetching, true, 'old finally cannot unlock the new request');
  newGate.resolve(noticeResponse('bob-new')); assert.equal(await newRequest, true);
  assert.equal(h.state.notices[0].RESOURCE_ID, 'bob-new'); assert.equal(h.state.fetching, false);
  assert.equal(h.cache.noticeCache.username, 'bob'); assert.equal(h.calls.publish, 1);
  assert.equal(h.calls.broadcast, 1); assert.equal(h.calls.inbox.length, 1);
});

test('stale notice transport failure does not restart authentication', async () => {
  const gate = deferred(), h = harness({ overrides: { fetch: () => gate.promise } });
  const pending = h.loadPage(); await h.clearSavedLogin(); gate.reject(Error('late network error'));
  assert.equal(await pending, false); assert.equal(h.calls.recovery, 0); assert.equal(h.calls.paint, 0);
});

test('late award-list response is rejected without merging or saving', async () => {
  const gate = deferred(), h = harness({ overrides: { fetch: () => gate.promise } });
  const pending = h.awFetchList(2); await h.clearSavedLogin(); gate.resolve(noticeResponse('alice-award'));
  await assert.rejects(pending, /登录状态已改变/);
  assert.equal(h.state.notices.length, 0); assert.equal(h.calls.caches.length, 0); assert.equal(h.calls.fetch, 1);
});

test('account-name change alone invalidates an old notice response', async () => {
  const gate = deferred(), h = harness({ overrides: { fetch: () => gate.promise } });
  const pending = h.loadPage(); h.state.username = 'bob'; h.state.notices = [];
  gate.resolve(noticeResponse('alice-old')); assert.equal(await pending, false);
  assert.equal(h.state.notices.length, 0); assert.equal(h.calls.caches.length, 0); assert.equal(h.calls.publish, 0);
});

test('queued old cache snapshot is skipped after credentials clear', async () => {
  const gate = deferred(), h = harness({ overrides: { vaultSet: key => key === 'secret' ? gate.promise : undefined } });
  const writing = h.persistCredentials('new-password'); await until(() => h.calls.sets.includes('secret'), 'vault lock acquired');
  const saving = h.saveNoticeCache(), clearing = h.clearSavedLogin();
  gate.resolve(); await Promise.all([writing, saving, clearing]);
  assert.equal(h.calls.caches.length, 0);
});

test('slow old cache write cannot finish after the newer account cache', async () => {
  const gate = deferred(), h = harness({ overrides: { cacheSet: (key, value) => value.username === 'alice' ? gate.promise : undefined } });
  const oldSave = h.saveNoticeCache(); await until(() => h.calls.caches.length === 1, 'old cache write started');
  const clearing = h.clearSavedLogin(); h.state.username = 'bob'; h.state.notices = [{ RESOURCE_ID: 'bob-new' }];
  const newSave = h.saveNoticeCache(); gate.resolve(); await Promise.all([oldSave, clearing, newSave]);
  assert.deepEqual(h.calls.caches.map(value => value.username), ['alice', 'bob']);
  assert.equal(h.cache.noticeCache.username, 'bob'); assert.equal(h.cache.noticeCache.notices[0].RESOURCE_ID, 'bob-new');
});

let failed = 0;
for (const { name, run } of tests) {
  try { await run(); }
  catch (error) { failed++; console.error(`FAIL: ${name}`, error); }
}
assert.equal(failed, 0, `${failed}/${tests.length} auth lifecycle scenarios failed`);
console.log(`PASS: cppu auth lifecycle — ${tests.length} offline concurrency/account/credential scenarios`);
