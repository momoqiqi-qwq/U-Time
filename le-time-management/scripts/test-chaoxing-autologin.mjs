import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/* 学习通：课程列表失败的三条真因 + 课程域会话的定点自愈 + 时间轴视图也能进课件。

   这个测试钉住四条容易再踩的规矩：

   1) **课程域（mooc2-ans）与收件箱域（notice）的会话不是同一个生命周期**。自动登录只在打
      开插件时跑一次、且只验收件箱，于是会出现「通知都能看、课程列表一片红」。过期时必须
      用保存的账号重登一次再把这次请求重放，而不是让用户自己去点切换登录。
   2) **自动重登必须有冷却**。任务栏角标每 5 分钟刷新一次，没有冷却就等于静默连续登录，
      fanyalogin 会直接风控失败。
   3) **失败文案要能定位**：被踢回登录页 / HTTP 非 200 / 页面里没有卡片，是三种完全不同的
      故障，报同一句「登录态可能失效」等于什么都没说。
   4) **时间轴视图的课程条目必须点得动**。学年分组视图的卡片带 data-course-files，
      时间轴视图早期只渲染了名字，点上去毫无反应 —— 用户以为插件坏了。 */

const source = fs.readFileSync(new URL('../public/plugins/chaoxing-notify/main.js', import.meta.url), 'utf8');

const COURSES_HTML = `<ul class="course-list">
  <li class="course clearfix">
    <input class="courseId" name="courseId" value="266302044">
    <input class="clazzId" name="clazzId" value="152530451">
    <input class="cpi" name="cpi" value="123456_1">
    <a href="https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=266302044&amp;clazzid=152530451&amp;cpi=1&amp;enc=abc123"><span class="course-name" title="无人机系统">无人机系统</span></a>
    <p class="line2 color3" title="张三">张三</p>
    <p>班级：25防火一队</p>
    <p>开课时间：2025-09-01～2027-09-01</p>
  </li>
</ul>`;

function makeSandbox({ creds = null, coursesMode = 'expired', cardCount = 1 } = {}) {
  const calls = { courses: 0, login: 0 };
  const state = { coursesMode, cardCount };
  const storage = {};
  const host = { isConnected: true, innerHTML: '', addEventListener() {}, querySelector: () => null };

  const coursesBody = () => {
    if (state.coursesMode === 'no-cards') return '<html><body>没有课程</body></html>';
    if (state.coursesMode === 'broken-cards') {
      return '<ul>' + Array.from({ length: state.cardCount }, () => '<li class="course "><input class="courseId" value="not-a-number"></li>').join('') + '</ul>';
    }
    return COURSES_HTML;
  };

  const context = vm.createContext({
    console, URL, URLSearchParams, Set, Map, Date, JSON, Number, String, Array, Object,
    Promise, RegExp, Math, atob, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, Math.min(ms, 5)); t.unref?.(); return t; },
    clearTimeout,
    getComputedStyle: () => ({ getPropertyValue: () => '0' }),
    window: {
      innerWidth: 390, innerHeight: 780,
      addEventListener() {}, removeEventListener() {},
      matchMedia: () => ({ matches: false }),
    },
    document: {
      documentElement: {}, getElementById: () => null,
      createElement: () => ({ style: {} }),
      head: { append() {} },
      addEventListener() {}, removeEventListener() {},
    },
    navigator: { vibrate: () => {} },
    tide: {
      version: '0.0.0-test',
      ui: { registerView() {} },
      storage: {
        get: async (k, fallback = null) => (k in storage ? storage[k] : fallback),
        set: async (k, v) => { storage[k] = v; },
      },
      notify() {},
      assets: { saveBase64: async () => '/x', saveText: async () => '/x', json: async () => ({}) },
      util: { openUrl() {}, openSaved() {}, copy() {}, desEncryptHex: async () => 'deadbeef' },
      tasks: { create: () => ({}), update() {}, remove() {} },
      blocks: { create: () => ({}) },
      http: {
        session: async () => 'sid-test',
        restoreCookies: async () => 'sid-restored',
        fetch: async (sid, method, url) => {
          if (String(url).includes('visit/courses/list')) {
            calls.courses += 1;
            if (state.coursesMode === 'expired') {
              return { status: 200, cookies: [], finalUrl: 'https://passport2.chaoxing.com/login?refer=x', body: '' };
            }
            if (state.coursesMode === 'http-500') return { status: 500, cookies: [], finalUrl: url, body: 'oops' };
            return { status: 200, cookies: [], finalUrl: url, body: coursesBody() };
          }
          if (String(url).includes('fanyalogin')) {
            calls.login += 1;
            // 重登成功后课程域恢复，模拟「换了一张新票据」
            state.coursesMode = 'ok';
            return { status: 200, cookies: [{ name: '_uid', value: 'u1' }], finalUrl: url, body: JSON.stringify({ status: true }) };
          }
          return { status: 200, cookies: [], finalUrl: url, body: '<html></html>' };
        },
      },
    },
  });

  vm.runInContext(
    source.replace('  tide.ui.registerView({',
      '  globalThis.cx = {state,loadCourses,courseErrorText,courseTimelineHtml,coursesExpired,reloginAt:()=>reloginAt,setReloginAt:(v)=>{reloginAt=v}};\n'
      + '  globalThis.cx.mount = (el) => { host = el; ensureStyle(); wire(); paintMain(); };\n'
      + '  tide.ui.registerView({'),
    context,
  );
  const cx = context.cx;
  cx.state.creds = creds;
  cx.state.sid = 'sid-test';
  cx.mount(host);
  return { cx, calls, host, state };
}

// ── 1. 课程域过期 + 存了账号：自动重登一次并重放请求 ─────────────────────────
await (async () => {
  const { cx, calls } = makeSandbox({ creds: { uname: 'u', password: 'p' } });
  const courses = await cx.loadCourses();
  assert.equal(calls.login, 1, '课程域被踢回登录页时必须自动重登一次');
  assert.equal(calls.courses, 2, '重登后要把这次课程请求重放一次，而不是直接报错');
  assert.equal(courses.length, 1, '重放成功后课程要正常解析出来');
  assert.equal(courses[0].courseid, '266302044');
  assert.equal(courses[0].clazzid, '152530451');
  assert.ok(/mooc2-ans/.test(courses[0].url), '课程门户地址取卡片里的 <a href>');
  assert.equal(cx.state.error || '', '', '自愈成功不该在界面上留错误');
})();

// ── 2. 冷却：30 分钟内不重复自动重登（任务栏角标每 5 分钟刷新一次）───────────
await (async () => {
  const { cx, calls, state } = makeSandbox({ creds: { uname: 'u', password: 'p' } });
  await cx.loadCourses();
  const loginsAfterFirst = calls.login;
  assert.equal(loginsAfterFirst, 1);

  // 会话再次失效，但还在冷却窗口里
  state.coursesMode = 'expired';
  cx.state.courses = [];
  const before = calls.courses;
  let err = null;
  try { await cx.loadCourses(); } catch (e) { err = e; }
  assert.ok(err, '冷却期内仍然失效时要把错误抛给界面');
  assert.equal(calls.login, loginsAfterFirst, '冷却期内不许再登录一次（会被 fanyalogin 风控）');
  assert.equal(calls.courses, before + 1, '只重放课程请求，不重登');
  assert.match(String(err.message), /课程域会话已失效|没有成功/, `错误要指向课程域会话，实际：${err.message}`);
})();

// ── 3. 没有保存账号：不许无意义地重登，文案要点名「切换登录」─────────────────
await (async () => {
  const { cx, calls } = makeSandbox({ creds: null });
  let err = null;
  try { await cx.loadCourses(); } catch (e) { err = e; }
  assert.ok(err);
  assert.equal(calls.login, 0, '没有账号密码就不该尝试重登');
  assert.match(String(err.message), /切换登录/, `文案必须给出可执行动作，实际：${err.message}`);
})();

// ── 4. 三种失败形态的文案各不相同 ────────────────────────────────────────────
await (async () => {
  const expired = makeSandbox({ creds: null });
  const e1 = expired.cx.courseErrorText({ status: 200, finalUrl: 'https://passport2.chaoxing.com/login?refer=x', body: '' });
  assert.match(e1, /课程域会话已失效/);

  const boom = makeSandbox({ creds: null });
  const e2 = boom.cx.courseErrorText({ status: 500, finalUrl: 'https://mooc2-ans.chaoxing.com/visit/courses/list', body: 'oops' });
  assert.match(e2, /HTTP 500/);
  assert.ok(!/登录/.test(e2), 'HTTP 500 不是登录问题，不要误导用户去重新登录');

  const empty = makeSandbox({ creds: null });
  const e3 = empty.cx.courseErrorText({ status: 200, finalUrl: 'https://mooc2-ans.chaoxing.com/visit/courses/list', body: '<html>无课程</html>' });
  assert.match(e3, /没有课程卡片/);
  assert.match(e3, /字节/, '文案要带字节数，出问题时截图就能定位');
})();

// ── 5. 解析全落空 / 一张卡都没有，处理方式不同 ───────────────────────────────
await (async () => {
  const broken = makeSandbox({ creds: null, coursesMode: 'broken-cards', cardCount: 3 });
  let err = null;
  try { await broken.cx.loadCourses(); } catch (e) { err = e; }
  assert.ok(err, '有卡片但字段全解析不出 = 平台改版，必须报错');
  assert.match(String(err.message), /卡片结构/);

  const none = makeSandbox({ creds: null, coursesMode: 'no-cards' });
  const list = await none.cx.loadCourses();
  assert.equal(list.length, 0, '一张卡都没有（本学期无课）不该报错，交给界面显示空列表');
})();

// ── 6. 时间轴视图的课程条目点得动 ────────────────────────────────────────────
{
  const { cx } = makeSandbox({ creds: null });
  const html = cx.courseTimelineHtml(
    [{ courseid: '1', clazzid: '2', name: '无人机', teacher: '张三', start: '2025-09-01' }],
    '2024',
    new Date('2026-10-20T00:00:00Z'),
  );
  assert.ok(html.includes('data-course-files'), '时间轴条目也要能进课件界面');
  assert.ok(html.includes('data-key="1_2"'), 'data-key 必须是 courseid_clazzid，事件委托靠它找回课程');
  assert.ok(html.includes('role="button"'), '键盘用户也要能进（Enter / 空格）');
}

console.log('✓ test-chaoxing-autologin: 课程域自愈、重登冷却、失败文案分流、时间轴条目可点全部通过');
