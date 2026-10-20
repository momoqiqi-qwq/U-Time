import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/* 学习通课件界面：点课程卡片 → 专门的课件界面 → 逐个文件下载。
   这个测试钉住三条曾经踩过、或很容易再踩的规矩：

   1) **一级章节名的提取窗口必须够宽**。真页面里
      `<div class="catalog_title chapter_Thats_bnt">` 到 `<span title="…">` 之间隔了
      700+ 字符的缩进与嵌套 div，窗口给 400 字符时 4 个章全部 MISS（静默退化成"章节 1/2/3/4"）。
      下面 fixture 里塞了 500 个空格的 padding，就是为了钉住这一条。
   2) **附件元数据的字段名是 name / type / size**，不是 filename —— 由
      `/ananas/modules/*` 的 iframe 的 `data` 属性给出，且被 `&quot;` 转义过，
      必须先 decodeEntities 再 JSON.parse。
   3) **大文件不许塞进 IPC**。156 MB 的 PPT 如果走 binary base64 会变成 200 MB 字符串，
      跨 IPC 必然崩；超过阈值一律交给系统浏览器（tide.util.openUrl），小文件才 saveBase64。 */

const source = fs.readFileSync(new URL('../public/plugins/chaoxing-notify/main.js', import.meta.url), 'utf8');

const listeners = {};
const storage = {};
const saved = [];
const opened = [];
const notifies = [];
const styleTags = [];

const host = {
  isConnected: true,
  innerHTML: '',
  addEventListener: (type, fn) => { listeners[type] = fn; },
  querySelector: () => null,
};

// ── 请求桩：按 URL 分流，返回的都是真页面结构的最小复刻 ──────────────────────
const CARD_URL = 'https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?courseid=266302044&clazzid=152530451&cpi=1&enc=abc123def&t=1';
const PAD = ' '.repeat(500);
const CHAPTERS_HTML = `<div class="chapter_body"><div class="chapter_td">
        <div class="chapter_unit">
                            <div class="chapter_item">
                                <div class="catalog_title chapter_Thats_bnt">${PAD}
                                    <div class="inputCheck fl firstNode"><input type="checkbox" name="checkbox" value=""></div>
                                    <div class="catalog_num fl"><span><i><em style="font-style:normal;">1</em></i></span></div>
                                    <div class="catalog_name newCatalog_name" tabindex="0">
                                        <a class="clicktitle">
                                            <span title="科目一：认知">
                                                                        科目一：认知 </span>
                                        </a>
                                    </div>
                                </div>
                                <div class="catalog_level" style="display:block;"><ul><li>
                                    <div class="chapter_item" id="cur1226329091" onclick="toOld('266302044', '1226329091', '152530451',0)" href="javascript:;" title="认知">
                                        <div class="catalog_title"><div class="inputCheck fl"><input type="checkbox" name="checkbox" value="1226329091"></div>
                                        <span class="catalog_sbar">1.1</span>
                                        <div class="catalog_name newCatalog_name"><span>认知</span></div></div>
                                    </div>
                                </li></ul></div>
                            </div>
        </div>
        <div class="chapter_unit">
                            <div class="chapter_item">
                                <div class="catalog_title chapter_Thats_bnt">${PAD}
                                    <div class="catalog_name newCatalog_name" tabindex="0">
                                        <a class="clicktitle"><span title="科目二：装配">科目二：装配</span></a>
                                    </div>
                                </div>
                                <div class="catalog_level"><ul><li>
                                    <div class="chapter_item" id="cur1226329092" onclick="toOld('266302044', '1226329092', '152530451',0)" title="装配">
                                        <span class="catalog_sbar">2.1</span>
                                    </div>
                                </li></ul></div>
                            </div>
        </div></div></div>`;

const CARDS_HTML = `<div class="ans-cc">
<p class="editor-iframe" draggable="true"><div class="ans-attach-ct ans-job-finished"><div class="ans-job-icon"></div><iframe src="/ananas/modules/pdf/index.html?v=2026-0920-1905" jobid="1" data="{&quot;objectid&quot;:&quot;45d6ce49f25483c9700dd1e54bc34a93&quot;,&quot;name&quot;:&quot;\u300a\u591a\u65cb\u7ffc\u65e0\u4eba\u673a\u300b\u79d1\u76ee\u4e00.pptx&quot;,&quot;type&quot;:&quot;.pptx&quot;,&quot;size&quot;:164185225,&quot;hsize&quot;:&quot;156.58 MB&quot;,&quot;download&quot;:&quot;1&quot;}" class="ans-attach-online insertdoc-online-ppt" objectid="45d6ce49f25483c9700dd1e54bc34a93" download="1" frameborder="0" scrolling="no" allowfullscreen="true"></iframe></div></p>
<p class="editor-iframe" draggable="true"><div class="ans-attach-ct"><iframe src="/ananas/modules/pdf/index.html?v=1" jobid="2" data="{&quot;objectid&quot;:&quot;45f8702b46058b30505aafc82a8b4d1b&quot;,&quot;name&quot;:&quot;\u8bfe\u7a0b\u5206\u7ec4.png&quot;,&quot;type&quot;:&quot;.png&quot;,&quot;size&quot;:680950,&quot;download&quot;:&quot;1&quot;}" class="ans-attach-online insertdoc-online-pdf" objectid="45f8702b46058b30505aafc82a8b4d1b" download="1"></iframe></div></p>
</div>`;

const requests = [];
const context = vm.createContext({
  console, URL, URLSearchParams, Set, Map, Date, JSON, Number, String, Array, Object,
  Promise, RegExp, Math, atob, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  setTimeout: (fn, ms) => { const t = setTimeout(fn, Math.min(ms, 5)); t.unref?.(); return t; },
  clearTimeout,
  getComputedStyle: () => ({ getPropertyValue: () => '0' }),
  window: {
    innerWidth: 390, innerHeight: 780,
    addEventListener: () => {}, removeEventListener: () => {},
    matchMedia: () => ({ matches: false }),
  },
  document: {
    documentElement: {}, getElementById: () => null,
    createElement: () => ({ style: {} }),
    head: { append: (el) => styleTags.push(String(el.textContent || '')) },
    addEventListener: () => {}, removeEventListener: () => {},
  },
  navigator: { vibrate: () => {} },
  tide: {
    version: '0.0.0-test',
    ui: { registerView() {} },
    storage: {
      get: async (k, fallback = null) => (k in storage ? storage[k] : fallback),
      set: async (k, v) => { storage[k] = v; },
    },
    notify: (msg) => { notifies.push(String(msg)); },
    http: {
      session: async () => 'sid-test',
      fetch: async (sid, method, url) => {
        requests.push(url);
        // 注意顺序：`…/mycourse/studentcourse` 也以 `…/mycourse/stu` 开头，先判 studentcourse，
        // 否则章节请求会被当成课程卡片页、拿到空目录。
        if (url.includes('studentcourse')) return { status: 200, finalUrl: url, cookies: [], body: CHAPTERS_HTML };
        if (url.includes('mooc2-ans/mycourse/stu')) {
          return { status: 200, finalUrl: CARD_URL, cookies: [], body: '<html>course page</html>' };
        }
        if (url.includes('knowledge/cards')) return { status: 200, finalUrl: url, cookies: [], body: CARDS_HTML };
        if (url.includes('ananas/status/45d6ce49f25483c9700dd1e54bc34a93')) {
          return {
            status: 200, cookies: [], finalUrl: url,
            body: JSON.stringify({ download: 'http://d0.cldisk.com/download/big?at_=1&ak_=2', pdf: '' }),
          };
        }
        if (url.includes('ananas/status/45f8702b46058b30505aafc82a8b4d1b')) {
          return {
            status: 200, cookies: [], finalUrl: url,
            body: JSON.stringify({ download: 'http://d0.cldisk.com/download/small?at_=1&ak_=2', pdf: '' }),
          };
        }
        if (url.includes('cldisk.com')) return { status: 200, cookies: [], finalUrl: url, body: 'QUJD' };
        return { status: 200, cookies: [], finalUrl: url, body: '{}' };
      },
    },
    assets: {
      saveBase64: async (name, b64) => { saved.push({ name, b64 }); return `/downloads/${name}`; },
      saveText: async () => '/downloads/x.txt',
      json: async () => ({}),
    },
    util: {
      openUrl: (u) => { opened.push(u); },
      openSaved: () => {},
      copy: () => {},
    },
    tasks: { create: () => ({ id: 't' }), update() {}, remove() {} },
    blocks: { create: () => ({}) },
  },
});

vm.runInContext(
  source.replace('  tide.ui.registerView({',
    '  globalThis.cx = {state,parseChapters,parseAttachments,loadChapters,loadPointFiles,courseEntry,'
    + 'openCourseFiles,refreshCourseFiles,countFiles,fileTargets,downloadFile,downloadAllFiles,'
    + 'fmtBytes,safeFileName,fileRowHtml,courseFilesHtml,paintMain};\n'
    + '  globalThis.cx.mount = (el) => { host = el; ensureStyle(); wire(); paintMain(); };\n'
    + '  globalThis.cx.card = (c) => courseCardHtml(c, "2024", new Date("2026-10-20T00:00:00Z"));\n'
    + '  tide.ui.registerView({'),
  context,
);

const cx = context.cx;

// ── 1. 章节解析：窗口够宽才拿得到一级章节名 ────────────────────────────────
{
  const chapters = cx.parseChapters(CHAPTERS_HTML);
  assert.equal(chapters.length, 2, '两个 chapter_unit 应该解析成两章');
  assert.equal(chapters[0].title, '科目一：认知', '一级章节名必须从深缩进的 span[title] 里取出来');
  assert.equal(chapters[1].title, '科目二：装配');
  assert.equal(chapters[0].points.length, 1);
  assert.equal(chapters[0].points[0].kid, '1226329091', 'knowledgeid 取自 toOld 的第二个参数');
  assert.equal(chapters[0].points[0].no, '1.1', '节号取自 catalog_sbar');
  assert.equal(chapters[1].points[0].kid, '1226329092');
  assert.equal(chapters[1].points[0].no, '2.1');
  // 章标题行（chapter_Thats_bnt）没有 toOld，不能被当成一个知识点
  assert.ok(!chapters[0].points.some((p) => p.name === '科目一：认知' && p.no === ''),
    '章标题行不该产出无编号的知识点');
}

// ── 2. 附件解析：&quot; 转义 JSON + name/type/size 字段 ─────────────────────
{
  const files = cx.parseAttachments(CARDS_HTML);
  assert.equal(files.length, 2);
  assert.equal(files[0].oid, '45d6ce49f25483c9700dd1e54bc34a93');
  assert.equal(files[0].name, '《多旋翼无人机》科目一.pptx', '\\u 转义的中文名必须解出来');
  assert.equal(files[0].size, 164185225, 'size 来自 data 属性，不是接口的 length');
  assert.equal(files[0].kind, 'ppt');
  assert.equal(files[1].kind, 'file', '.png 归到普通附件');
  assert.equal(files[1].size, 680950);
}

// ── 3. 大小与文件名 ────────────────────────────────────────────────────
{
  assert.equal(cx.fmtBytes(164185225), '156.6 MB');
  assert.equal(cx.fmtBytes(680950), '665.0 KB');
  assert.equal(cx.fmtBytes(0), '');
  assert.equal(cx.safeFileName('a/b:c*?"<>|.pptx'), 'a_b_c______.pptx');
}

// ── 4. 全流程：进课件界面 → 读章节 → 读附件 → 渲染 ────────────────────────
await (async () => {
  cx.mount(host);
  const course = { courseid: '266302044', clazzid: '152530451', cpi: '1', teacher: '张三', clazz: '1班', name: '无人机', url: CARD_URL };
  await cx.openCourseFiles(course);

  assert.equal(cx.state.files.err, '', '不该有错误');
  assert.equal(cx.state.files.chapters.length, 2);
  assert.equal(cx.countFiles(), 4, '两节 × 每节两个附件');
  assert.ok(/读取完成/.test(cx.state.files.progress), `进度提示应含「读取完成」，实际：${cx.state.files.progress}`);
  assert.ok(requests.some((u) => u.includes('studentcourse')), '章节走 studentcourse');
  assert.ok(requests.some((u) => u.includes('knowledge/cards')), '附件走 knowledge/cards');

  const html = host.innerHTML;
  assert.ok(html.includes('data-coursedoc-all'), '界面要有「全部下载」');
  assert.ok(html.includes('data-coursedoc-back'), '界面要有返回课程列表');
  assert.ok(html.includes('cx2-files-sec'), '按章节分组渲染');
  assert.ok(html.includes('data-coursedoc-dl'), '每个文件一个下载按钮');
  assert.ok(html.includes('浏览器下载'), '大文件按钮文案要说明交给浏览器');
  assert.ok(html.includes('《多旋翼无人机》科目一.pptx'), '文件名要显示出来');
  assert.ok(html.includes('156.6 MB'), '大小要显示出来');
  assert.ok(!html.includes('cx2-course st-'), '课件界面不该再渲染课程卡片列表');

  // ── 5. 下载分流：大文件交给浏览器，小文件落盘 ──────────────────────────
  const big = cx.state.files.chapters[0].points[0].files[0];
  const small = cx.state.files.chapters[0].points[0].files[1];
  assert.equal(big.size, 164185225);
  assert.equal(small.size, 680950);

  const r1 = await cx.downloadFile(big);
  assert.equal(r1, 'browser', '156 MB 不许走 IPC，必须交给系统浏览器');
  assert.equal(opened.length, 1);
  assert.ok(opened[0].startsWith('http://d0.cldisk.com/download/big'), '打开的是 ananas/status 给的签名直链');
  assert.equal(saved.length, 0, '大文件不该进 saveBase64');

  const r2 = await cx.downloadFile(small);
  assert.equal(saved.length, 1, '小文件走 saveBase64 落盘');
  assert.equal(saved[0].name, '课程分组.png');
  assert.equal(saved[0].b64, 'QUJD');
  assert.equal(r2, '/downloads/课程分组.png');
  assert.ok(cx.state.files.saved.has(small.oid), '下载过的要记下来，页面重绘后显示「已下载」');
  assert.ok(host.innerHTML.includes('已下载'));

  // 批量下载只挑没下过的，所以这里剩 0 个待下（大文件已经交给浏览器，不算 saved）
  const before = saved.length;
  await cx.downloadAllFiles();
  assert.equal(saved.length, before, '大文件重复走浏览器、小文件已 saved，不该再落盘一次');
})();

// ── 6. 卡片本身：主体点击进课件界面，「开课时间」才是展开详情 ───────────────
{
  const html = cx.card({
    courseid: '266302044', clazzid: '152530451', cpi: '1', name: '无人机', teacher: '张三',
    clazz: '1班', start: '2025-09-01', end: '2027-09-01', url: CARD_URL,
  });
  assert.ok(html.includes('data-course-files'), '卡片主体要带进课件界面的标记');
  assert.ok(html.includes('data-course-toggle'), '「开课时间」按钮负责展开详情');
  assert.ok(html.indexOf('data-course-toggle') < html.indexOf('cx2-course-more'),
    '开关按钮要在详情块之前，事件委托按「先内层按钮、后整卡」判断');
}

// ── 7. 会话失效 / 空课程都要说人话，不能白屏 ──────────────────────────────
{
  const ctx2 = vm.createContext({
    console, URL, URLSearchParams, Set, Map, Date, JSON, Number, String, Array, Object,
    Promise, RegExp, Math, atob, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    setTimeout: (fn) => { const t = setTimeout(fn, 5); t.unref?.(); return t; }, clearTimeout,
    getComputedStyle: () => ({ getPropertyValue: () => '0' }),
    window: { innerWidth: 390, innerHeight: 780, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) },
    document: { documentElement: {}, getElementById: () => null, createElement: () => ({ style: {} }), head: { append() {} }, addEventListener() {}, removeEventListener() {} },
    navigator: { vibrate: () => {} },
    tide: {
      version: '0.0.0-test', ui: { registerView() {} },
      storage: { get: async (k, f = null) => f, set: async () => {} },
      notify() {}, assets: { saveBase64: async () => '/x', saveText: async () => '/x', json: async () => ({}) },
      util: { openUrl() {}, openSaved() {}, copy() {} },
      tasks: { create: () => ({}), update() {}, remove() {} }, blocks: { create: () => ({}) },
      http: {
        session: async () => 'sid2',
        // 第一步就跳登录页：模拟 enc 过期
        fetch: async (sid, m, url) => ({ status: 200, cookies: [], finalUrl: 'https://passport2.chaoxing.com/login?refer=x', body: '' }),
      },
    },
  });
  vm.runInContext(
    source.replace('  tide.ui.registerView({', '  globalThis.cx2 = {state,openCourseFiles};\n  tide.ui.registerView({'),
    ctx2,
  );
  const h2 = { isConnected: true, innerHTML: '', addEventListener() {}, querySelector: () => null };
  await ctx2.cx2.openCourseFiles({ courseid: '1', clazzid: '2', name: 'X', url: CARD_URL });
  assert.match(String(ctx2.cx2.state.files.err), /登录/, '会话失效要说「重新登录」，不能抛原始错误');
}

console.log('✓ test-chaoxing-course-files: 课件界面解析、下载分流、卡片入口、失败提示全部通过');
