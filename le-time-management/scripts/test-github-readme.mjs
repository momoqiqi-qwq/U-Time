/* github-readme 的取数与广播守卫测试。
 *
 * 关注三件事：① 仓库地址与 README 元信息的解析（用户粘什么进来都得认）；
 * ② Atom feed 解析（这是唯一的变更来源，畸形/空/限流都不能把插件打死）；
 * ③ 「新提交」的判定与 notice:new 广播 —— 首次只播种不轰炸、一轮只广播一次、
 *    载荷字段名必须与 plugin-guide 的契约一致、广播抛错不许影响抓取。
 * 手法沿用本仓库惯例：node:vm 加载插件真源码 + 假 tide。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/plugins/github-readme/main.js', import.meta.url), 'utf8');

let store = {};
let router = () => ({ status: 200, body: '' });
const emits = [];
const toasts = [];
const context = vm.createContext({
  URL, Set, Map, Date, console, setTimeout, clearTimeout, setInterval, clearInterval,
  document: { getElementById: () => null, createElement: () => ({}), head: { append() {} } },
  tide: {
    ui: { registerView() {} },
    storage: { get: async (k, d) => (k in store ? store[k] : d), set: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); } },
    http: { get: (url) => router(url) },
    events: { emit: (name, data) => { emits.push([name, data]); } },
    notify: (m) => { toasts.push(m); },
    util: { openUrl() {} },
    tasks: { create: () => 'task-1' },
  },
});
vm.runInContext(source.replace(
  '  tide.ui.registerView({',
  '  globalThis.testApi = { parseRepoRef, parseReadmeMeta, atomEntries, atomUrlOf, rawUrlOf, fetchHead, addRepo, syncAll, markSeen, restore, state, repoTitle };\n  tide.ui.registerView({',
), context);
const { parseRepoRef, parseReadmeMeta, atomEntries, atomUrlOf, rawUrlOf, fetchHead, addRepo, syncAll, markSeen, restore, state, repoTitle } = context.testApi;

/* vm 里造的对象带着 context 的 Object.prototype，deepStrictEqual 会连原型一起比、
   跨 realm 永远不相等。断言前先搬回宿主 realm。 */
const host = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/* ── 1. 仓库地址：用户会粘进来的各种形态都得认 ── */
assert.deepEqual(host(parseRepoRef('sindresorhus/execa')), { owner: 'sindresorhus', repo: 'execa', ref: '' }, '最短形式 owner/repo');
assert.deepEqual(host(parseRepoRef('  https://github.com/foo/bar  ')), { owner: 'foo', repo: 'bar', ref: '' }, '完整链接要能剪空白');
assert.deepEqual(host(parseRepoRef('https://github.com/foo/bar/')), { owner: 'foo', repo: 'bar', ref: '' }, '尾斜杠');
assert.deepEqual(host(parseRepoRef('https://github.com/foo/bar.git')), { owner: 'foo', repo: 'bar', ref: '' }, '.git 后缀');
assert.deepEqual(host(parseRepoRef('git@github.com:foo/bar.git')), { owner: 'foo', repo: 'bar', ref: '' }, 'SSH 克隆地址');
assert.deepEqual(host(parseRepoRef('https://github.com/foo/bar/tree/dev/src')), { owner: 'foo', repo: 'bar', ref: 'dev' }, '/tree/<ref>/ 要带出分支');
assert.deepEqual(host(parseRepoRef('https://github.com/foo/bar/issues/5')), { owner: 'foo', repo: 'bar', ref: '' }, '带子路径的链接只取仓库');
assert.equal(parseRepoRef('https://gitee.com/foo/bar'), null, '非 GitHub 域名必须拒（一期只做 GitHub）');
assert.equal(parseRepoRef('https://github.com/foo'), null, '只有 owner 不算仓库');
assert.equal(parseRepoRef(''), null, '空串');
assert.equal(parseRepoRef('foo/bar/baz/qux'), null, '裸路径段数不对不猜');

/* ── 2. README 元信息：一次 /readme 调用给全（branch 从 download_url 里取） ── */
const meta = parseReadmeMeta(JSON.stringify({
  name: 'readme.md', path: 'readme.md', sha: 'aaa',
  download_url: 'https://raw.githubusercontent.com/sindresorhus/execa/main/readme.md',
}));
assert.deepEqual({ owner: meta.owner, repo: meta.repo, branch: meta.branch, path: meta.path, dir: meta.dir },
  { owner: 'sindresorhus', repo: 'execa', branch: 'main', path: 'readme.md', dir: '' }, '根目录 README 的 dir 是空串');
assert.equal(rawUrlOf({ owner: 'o', repo: 'r', branch: 'main', dir: '', path: 'readme.md' }),
  'https://raw.githubusercontent.com/o/r/main/readme.md', 'raw 地址自己拼得出，不依赖 download_url');
const nested = parseReadmeMeta(JSON.stringify({
  path: 'docs/README.md', download_url: 'https://raw.githubusercontent.com/o/r/develop/docs/README.md',
}));
assert.deepEqual({ branch: nested.branch, path: nested.path, dir: nested.dir },
  { branch: 'develop', path: 'docs/README.md', dir: 'docs/' }, '子目录 README 要带出目录前缀');
assert.equal(rawUrlOf({ owner: 'o', repo: 'r', branch: 'main', dir: 'docs/', path: 'README.md' }),
  'https://raw.githubusercontent.com/o/r/main/docs/README.md', '子目录拼进 raw 地址');
assert.equal(atomUrlOf({ owner: 'o', repo: 'r', branch: 'main', dir: 'docs/', path: 'README.md' }),
  'https://github.com/o/r/commits/main/docs/README.md.atom', 'per-path Atom 地址：变更检测的唯一来源');
assert.equal(rawUrlOf(nested), 'https://raw.githubusercontent.com/o/r/develop/docs/README.md', 'API 给的完整 path 不能与 dir 重复拼接');
assert.equal(atomUrlOf(nested), 'https://github.com/o/r/commits/develop/docs/README.md.atom');
assert.equal(parseReadmeMeta('{"message":"Not Found"}'), null, '仓库没有 README 要能认出来');
assert.equal(parseReadmeMeta('不是 JSON'), null, '响应体坏了不能抛');

/* ── 3. Atom 解析 ── */
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <id>tag:github.com,2008:/o/r/commits/main/README</id>
  <entry>
    <id>tag:github.com,2008:Grit::Commit/f9264ded3e02f8ae4fbf8f2400b6ede9edd0bd14</id>
    <link type="text/html" rel="alternate" href="https://github.com/o/r/commit/f9264ded"/>
    <title>
        README: fix &amp; tidy
    </title>
    <updated>2026-07-15T16:51:29Z</updated>
    <author><name>张三</name><uri>https://github.com/zhangsan</uri></author>
  </entry>
  <entry>
    <id>tag:github.com,2008:Grit::Commit/aaaa1111</id>
    <title>old</title>
    <updated>2026-01-01T00:00:00Z</updated>
  </entry>
</feed>`;
const entries = atomEntries(ATOM);
assert.equal(entries.length, 2, '两个 entry');
assert.equal(entries[0].sha, 'f9264ded3e02f8ae4fbf8f2400b6ede9edd0bd14', 'sha 取 <id> 尾段');
assert.equal(entries[0].title, 'README: fix & tidy', '标题剪掉 Atom 的换行缩进并解实体');
assert.equal(entries[0].author, '张三', '作者名');
assert.equal(entries[0].time, '2026-07-15T16:51:29Z', '时间原样带 ISO');
assert.equal(entries[0].url, 'https://github.com/o/r/commit/f9264ded', 'commit 链接');
assert.equal(entries[1].author, '', '没有 author 节点时留空，不编作者');
assert.deepEqual(host(atomEntries('<feed></feed>')), [], '空 feed');
assert.deepEqual(host(atomEntries('')), [], '空响应');
assert.deepEqual(host(atomEntries('<entry>没有 id')), [], '畸形 XML 退化成空列表而不是抛');

/* ── 4. 添加与首轮播种：首轮只记不广播 ── */
const REPO = { owner: 'o', repo: 'r', branch: 'main', dir: '', path: 'README.md' };
const readmeJson = JSON.stringify({ path: 'README.md', download_url: 'https://raw.githubusercontent.com/o/r/main/README.md' });
router = (url) => {
  if (url.includes('api.github.com')) return { status: 200, body: readmeJson };
  if (url.endsWith('.atom')) return { status: 200, body: ATOM };
  if (url.includes('raw.githubusercontent.com')) return { status: 200, body: '# 标题\n\n正文' };
  return { status: 404, body: '' };
};
const added = await addRepo('https://github.com/o/r');
assert.equal(added.ok, true, '添加成功');
assert.equal(state.repos.length, 1, '仓库进列表');
assert.equal(state.repos[0].sha, 'f9264ded3e02f8ae4fbf8f2400b6ede9edd0bd14', '添加即播种当前 commit');
assert.equal(emits.length, 0, '🔴 添加与首轮抓取不得广播（否则首次运行把历史全推一遍）');
assert.ok(state.docs['o/r'].includes('# 标题'), 'README 原文进缓存');

/* ── 5. 重复添加同一仓库 ── */
const again = await addRepo('o/r');
assert.equal(again.ok, false, '重复添加要认出来');
assert.match(again.error, /已经/, '重复添加要说明为什么没加');
assert.equal(state.repos.length, 1, '重复添加不产生第二条');

/* ── 6. 有新 commit 才广播，且一轮只广播一次 ── */
const NEW = ATOM.replace('f9264ded3e02f8ae4fbf8f2400b6ede9edd0bd14', 'bbbb222233334444').replace('README: fix &amp; tidy', 'README: 补表格');
router = (url) => {
  if (url.endsWith('.atom')) return { status: 200, body: NEW };
  if (url.includes('raw.githubusercontent.com')) return { status: 200, body: '# 新正文' };
  return { status: 200, body: '' };
};
await syncAll();
assert.equal(emits.length, 1, '一轮同步最多一次广播');
const [evtName, payload] = emits[0];
assert.equal(evtName, 'notice:new', '事件名');
assert.deepEqual(Object.keys(payload).sort(), ['items', 'source', 'sourceName', 'total'], '🔴 载荷字段名必须照 plugin-guide 的契约，不能自创');
assert.equal(payload.source, 'github-readme', 'source 用插件 id');
assert.equal(typeof payload.sourceName, 'string', 'sourceName 给人看');
assert.equal(payload.total, 1, '一条新提交');
assert.deepEqual(Object.keys(payload.items[0]).sort(), ['sender', 'time', 'title'], '🔴 item 只有 title/time/sender 三个字段');
assert.ok(payload.items[0].title.includes('o/r'), '标题带仓库名，多仓库混在一起才分得清');
assert.ok(payload.items[0].title.includes('补表格'), '标题带 commit 说明');
assert.equal(payload.items[0].sender, '张三', 'sender 用提交作者');
assert.equal(state.repos[0].sha, 'bbbb222233334444', 'sha 前移到最新');
assert.ok(state.docs['o/r'].includes('# 新正文'), '变了才重拉 README');

/* ── 7. 再同步一次没有新东西：不广播、不重拉正文 ── */
let rawHits = 0;
router = (url) => {
  if (url.endsWith('.atom')) return { status: 200, body: NEW };
  if (url.includes('raw.githubusercontent.com')) { rawHits += 1; return { status: 200, body: '# 新正文' }; }
  return { status: 200, body: '' };
};
await syncAll();
assert.equal(emits.length, 1, '无变化不广播');
assert.equal(rawHits, 0, 'sha 没变就不该再下载整份 README');

/* ── 8. 已读只影响界面，不参与广播差分 ── */
markSeen('o/r', 'bbbb222233334444');
assert.equal(state.repos[0].unread, 0, '看过之后未读清零');
await syncAll();
assert.equal(emits.length, 1, '🔴 用已读集合做差分会把没点开的旧提交重推一遍，这里必须仍然不广播');

/* ── 9. 一次多条：total 报全量，items 只给前 5 条 ── */
// GitHub 的 Atom 是「新在前」（实测 torvalds/linux 的 feed 第一条即最新提交），
// 所以构造时 c6 排最前 —— 插件取 entries[0] 当 head 依赖的就是这个顺序。
state.repos[0].sha = 'older';
const many = `<feed>${Array.from({ length: 7 }, (_, i) => 6 - i).map((i) => `<entry><id>tag:github.com,2008:Grit::Commit/c${i}</id><title>m${i}</title><updated>2026-09-2${i}T00:00:00Z</updated></entry>`).join('')}</feed>`;
router = (url) => (url.endsWith('.atom') ? { status: 200, body: many } : { status: 200, body: 'x' });
emits.length = 0;
await syncAll();
assert.equal(emits[0][1].total, 7, 'total 是全部新条数');
assert.equal(emits[0][1].items.length, 5, '🔴 items 必须 slice(0,5)，省推送频次');
assert.equal(state.repos[0].sha, 'c6', 'head 取 feed 第一条（最新在前）');

/* ── 10. 广播抛错不许影响抓取 ── */
context.tide.events.emit = () => { throw new Error('订阅者炸了'); };
state.repos[0].sha = 'older2';
router = (url) => (url.endsWith('.atom') ? { status: 200, body: many } : { status: 200, body: 'y' });
await syncAll();
assert.equal(state.repos[0].sha, 'c6', '🔴 广播失败也要照常推进 sha（否则下次重播同一批）');
context.tide.events.emit = (name, data) => { emits.push([name, data]); };

/* GitHub 页面域名不可达时，提交列表 API 是备用路径；只在 Atom 失败时调用。 */
router = (url) => {
  if (url.endsWith('.atom')) throw new Error('connection timed out');
  if (url.includes('/commits?')) return { status: 200, body: JSON.stringify([{
    sha: 'api-fallback', commit: { message: 'README 修订\n详细内容', author: { date: '2026-09-28T00:00:00Z', name: '张三' } },
    html_url: 'https://github.com/o/r/commit/api-fallback',
  }]) };
  return { status: 404, body: '' };
};
const fallback = await fetchHead(REPO);
assert.equal(fallback.entries[0].sha, 'api-fallback');
assert.equal(fallback.entries[0].title, 'README 修订');

/* ── 11. 限流与网络错误 ── */
router = (url) => (url.endsWith('.atom') ? { status: 403, body: 'API rate limit exceeded' } : { status: 200, body: '' });
const r11 = await syncAll();
assert.equal(r11.throttled, true, '403 认作限流');
assert.match(state.repos[0].error, /频繁|限流/, '限流要给人话文案');
assert.equal(state.repos[0].sha, 'c6', '限流不得把 sha 清掉');
router = () => { throw new Error('Failed to fetch'); };
await syncAll();
assert.match(state.repos[0].error, /网络|失败/, '网络异常写进该仓库的错误位');
assert.equal(state.repos.length, 1, '一个仓库失败不影响列表');

/* ── 12. 存储与恢复 ── */
store = {};
await context.testApi.state.persist();
assert.ok(store.repos && store.seen, '仓库列表与已读各自落盘');
assert.ok(store.known, '广播差分用的 sha 快照单独落盘');
const restored = await context.testApi.restore();
assert.equal(restored, true, '能恢复');
assert.equal(state.repos.length, 1, '恢复出仓库');
// 真正的回归风险：广播差分用的 sha 快照要是没落盘，重启后第一轮就会把历史重推一遍
router = (url) => (url.endsWith('.atom') ? { status: 200, body: many } : { status: 200, body: 'x' });
const emitted = emits.length;
await syncAll();
assert.equal(emits.length, emitted, '🔴 恢复后 sha 快照还在，同一批提交不得重推');

/* ── 13. 卡片右键菜单的三项外观：别名 / 备注 / 图标，只影响显示 ── */
const ICON = String.fromCodePoint(0x1F527);
assert.equal(repoTitle(state.repos[0]), 'o/r', '没改过名就显示 owner/仓库名');
state.repos[0].alias = '网关服务';
state.repos[0].note = '每周一看看有没有新方案';
state.repos[0].icon = ICON;
assert.equal(repoTitle(state.repos[0]), '网关服务', '改过名之后卡片与阅读页都用别名');
assert.equal(atomUrlOf(state.repos[0]), 'https://github.com/o/r/commits/main/README.md.atom', '🔴 改名不许动取数地址（别名只是给人看的）');
await state.persist();
state.repos.length = 0;
assert.equal(await restore(), true, '带外观字段的记录能恢复');
assert.deepEqual({ alias: state.repos[0].alias, note: state.repos[0].note, icon: state.repos[0].icon },
  { alias: '网关服务', note: '每周一看看有没有新方案', icon: ICON }, '三项都落盘，重启后还在');
// 老数据（这个功能之前存的）没有这三个字段：不能因此显示 undefined，也不能报错
store.repos = [{ owner: 'o', repo: 'r', branch: 'main', dir: '', path: 'README.md', sha: '', commit: null, at: 0, size: 0, error: '', unread: 0 }];
await restore();
assert.equal(repoTitle(state.repos[0]), 'o/r', '🔴 旧记录缺字段时退回 owner/仓库名');
assert.equal(state.repos[0].note, undefined, '旧记录没有备注位，界面按"没有备注"渲染');

console.log('PASS: github-readme —— 地址解析 / README 元信息 / Atom 解析 / 首轮只播种 / 一轮一广播 / 载荷契约 / items 截断 / 广播抛错不吞抓取 / 限流与网络降级 / 落盘恢复 / 卡片别名备注图标');
