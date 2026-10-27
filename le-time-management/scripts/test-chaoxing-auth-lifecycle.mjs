import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/plugins/chaoxing-notify/main.js', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const inbox = (url) => ({ status: 200, cookies: [], finalUrl: url, body: JSON.stringify({ notices: { list: [], lastPage: true } }) });
function harness({ storage = {}, vault = {}, vaultAvailable = true, vaultFails = false, fetch, vaultSet } = {}) {
  const calls = { login: 0, fetch: [], vault: [], notices: [], published: [] };
  const cache = {};
  let dispose;
  const context = vm.createContext({
    console, URL, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval,
    atob, navigator: { onLine: true },
    document: { getElementById: () => null, createElement: () => ({ style: {} }), head: { append() {} } },
    tide: {
      ui: { registerView() {}, onDispose(fn) { dispose = fn; }, setTaskbarBadge: async () => {}, taskbarBadgeSupported: async () => false },
      storage: { get: async (k, d = null) => k in storage ? storage[k] : d, set: async (k, v) => { storage[k] = v; } },
      cache: { get: async (k, d = null) => k in cache ? cache[k] : d, set: async (k, v) => { cache[k] = v; } },
      vault: vaultAvailable ? {
        get: async (k) => vault[k] ?? null,
        set: async (k, v) => { calls.vault.push(['set', k]); if (vaultFails) throw new Error('vault unavailable'); if (vaultSet) await vaultSet(k, v); vault[k] = v; },
        del: async (k) => { calls.vault.push(['del', k]); delete vault[k]; },
      } : undefined,
      notify: (s) => calls.notices.push(s),
      messages: { publish: (rows) => calls.published.push(rows) },
      util: { desEncryptHex: async () => 'encrypted-test-password' },
      http: {
        session: async () => 'sid-new', restoreCookies: async () => 'sid-restored',
        fetch: async (sid, method, url, options) => {
          calls.fetch.push(url);
          if (url.includes('fanyalogin')) calls.login++;
          if (fetch) { const result = await fetch({ sid, method, url, options, calls }); if (result) return result; }
          if (url.includes('fanyalogin')) return { status: 200, cookies: ['_uid=new-user'], finalUrl: url, body: '{"status":true}' };
          if (url.includes('getNoticeList')) return inbox(url);
          return { status: 200, cookies: [], finalUrl: url, body: '' };
        },
      },
    },
  });
  vm.runInContext(source.replace('  tide.ui.registerView({', '  globalThis.cx = {state,autoLogin,cxLogin,startCookieSession,readSavedAuth,saveAuth,clearAccount,loadCourses,fetchInbox,entryCache,probeTimes,beginManualLogin,epoch:()=>authEpoch};\n  tide.ui.registerView({'), context);
  return { cx: context.cx, calls, storage, vault, cache, context, dispose: () => dispose?.() };
}

// Legacy credentials leave ordinary storage only after the encrypted write succeeds.
{
  const h = harness({ storage: { creds: { uname: 'alice', password: 'test-secret' }, sessionCookie: '_uid=alice' } });
  await h.cx.readSavedAuth(0);
  assert.equal(JSON.parse(h.vault.loginAuth).creds.uname, 'alice');
  assert.equal(h.storage.creds, null); assert.equal(h.storage.sessionCookie, null);
  const failed = harness({ storage: { creds: { uname: 'alice', password: 'test-secret' }, sessionCookie: '_uid=alice' }, vaultFails: true });
  await failed.cx.readSavedAuth(0);
  assert.equal(failed.storage.creds.password, 'test-secret');
  assert.equal(failed.storage.sessionCookie, '_uid=alice');
  assert.equal(failed.calls.notices.length, 1);
}
// New credentials never fall back to cleartext if the host has no vault.
{
  const h = harness({ vaultAvailable: false });
  h.cx.state.creds = { uname: 'alice', password: 'test-secret' };
  h.cx.state.cookie = '_uid=alice';
  assert.equal(await h.cx.saveAuth(), false);
  assert.equal(h.storage.creds, undefined); assert.equal(h.storage.sessionCookie, undefined);
  assert.equal(h.calls.notices.length, 1);
}
// A transient Cookie validation failure keeps both credentials and suppresses repeated password attempts.
{
  const saved = JSON.stringify({ version: 1, creds: { uname: 'alice', password: 'p' }, cookie: '_uid=alice' });
  const h = harness({ vault: { loginAuth: saved }, fetch: ({ url }) => url.includes('getNoticeList') ? { status: 503, body: '', finalUrl: url } : null });
  await h.cx.readSavedAuth(0);
  assert.equal(await h.cx.autoLogin(), false);
  assert.equal(h.cx.state.creds.uname, 'alice'); assert.equal(h.cx.state.cookie, '_uid=alice');
  assert.equal(h.vault.loginAuth, saved); assert.equal(h.calls.login, 0);
  const before = h.calls.fetch.length;
  assert.equal(await h.cx.autoLogin(), false); assert.equal(h.calls.fetch.length, before);
  assert.ok(h.storage.autoLoginFailureAt > 0);
}
// HTTP failures from the course service never trigger a password submission.
{
  const h = harness({ fetch: ({ url }) => url.includes('visit/courses/list') ? { status: 500, cookies: [], finalUrl: url, body: 'gateway error' } : null });
  h.cx.state.creds = { uname: 'alice', password: 'p' };
  await assert.rejects(h.cx.loadCourses(), /HTTP 500/);
  assert.equal(h.calls.login, 0);
}
// Foreground/background recovery joins one password login; the session commits once.
{
  const gate = deferred();
  const h = harness({ fetch: async ({ url }) => { if (url.includes('fanyalogin')) { await gate.promise; } } });
  h.cx.state.creds = { uname: 'alice', password: 'p' };
  const a = h.cx.autoLogin(), b = h.cx.autoLogin(true);
  assert.equal(a, b);
  gate.resolve();
  assert.equal(await a, true); assert.equal(await b, true); assert.equal(h.calls.login, 1);
  assert.equal(h.cx.state.loggedIn, true);
  // A successful recent password login must not block valid Cookie restoration after restart.
  const next = harness({ storage: { ...h.storage }, vault: { ...h.vault } });
  await next.cx.readSavedAuth(0);
  assert.equal(await next.cx.autoLogin(), true); assert.equal(next.calls.login, 0);
}
// Explicit account denial is retained for correction, and is not retried after a restart.
{
  const h = harness({ fetch: ({ url }) => url.includes('fanyalogin') ? { status: 200, cookies: [], finalUrl: url, body: '{"status":false,"msg":"密码错误"}' } : null });
  h.cx.state.creds = { uname: 'alice', password: 'p' };
  assert.equal(await h.cx.autoLogin(), false); assert.equal(h.storage.autoLoginBlocked, true);
  assert.equal(h.cx.state.creds.uname, 'alice');
  assert.equal(await h.cx.autoLogin(), false); assert.equal(h.calls.login, 1);
  const next = harness({ storage: { ...h.storage }, vault: { loginAuth: JSON.stringify({ version: 1, creds: h.cx.state.creds, cookie: '' }) } });
  await next.cx.readSavedAuth(0);
  assert.equal(await next.cx.autoLogin(), false); assert.equal(next.calls.login, 0);
}
// A delayed login result cannot restore an account after the user switches away.
{
  const gate = deferred(), entered = deferred();
  const h = harness({ fetch: async ({ url }) => { if (url.includes('fanyalogin')) { entered.resolve(); await gate.promise; } } });
  h.cx.state.creds = { uname: 'alice', password: 'p' };
  h.cx.state.courses = [{ name: 'private-course' }]; h.cx.state.notice = { body: 'private-detail' };
  h.cx.state.files.course = { name: 'private-course' }; h.cx.state.readOverrides.set('private-id', true);
  h.cx.entryCache.set('private-course', { enc: 'signed-entry' }); h.cx.probeTimes.set('private-id', Date.now());
  const pending = h.cx.autoLogin(); await entered.promise;
  await h.cx.clearAccount(); gate.resolve();
  assert.equal(await pending, false);
  assert.equal(h.cx.state.loggedIn, false); assert.equal(h.cx.state.sid, null);
  assert.equal(h.cx.state.cookie, ''); assert.equal(h.cx.state.creds, null);
  assert.equal(h.cx.state.courses.length, 0); assert.equal(h.cx.state.files.course, null); assert.equal(h.cx.state.notice, null);
  assert.equal(h.cx.state.readOverrides.size, 0); assert.equal(h.cx.entryCache.size, 0); assert.equal(h.cx.probeTimes.size, 0);
  assert.equal(h.storage.autoLoginPaused, true); assert.equal(h.vault.loginAuth, undefined);
  assert.equal(h.cache.inboxCache.length, 0);
}
// Clearing waits behind an already-started encrypted write, then removes it permanently.
{
  const gate = deferred(), entered = deferred();
  const h = harness({ vaultSet: async () => { entered.resolve(); await gate.promise; } });
  h.cx.state.creds = { uname: 'alice', password: 'p' }; h.cx.state.cookie = '_uid=alice';
  const saving = h.cx.saveAuth().catch((e) => e.authKind); await entered.promise;
  const clearing = h.cx.clearAccount(); gate.resolve();
  assert.equal(await saving, 'cancelled'); await clearing;
  assert.equal(h.vault.loginAuth, undefined); assert.equal(h.storage.creds, null);
}
// Plugin disposal also invalidates delayed success, independently of rendering.
{
  const gate = deferred(), entered = deferred();
  const h = harness({ fetch: async ({ url }) => { if (url.includes('fanyalogin')) { entered.resolve(); await gate.promise; } } });
  h.cx.state.creds = { uname: 'alice', password: 'p' };
  const pending = h.cx.autoLogin(); await entered.promise; h.dispose(); gate.resolve();
  assert.equal(await pending, false); assert.equal(h.cx.state.loggedIn, false); assert.equal(h.vault.loginAuth, undefined);
}
console.log('PASS: 学习通自动登录生命周期：加密迁移、失败保留、冷却、并发合并、账号清理与迟到结果取消');
