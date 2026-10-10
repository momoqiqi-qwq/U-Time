// 网页收集（web-collector）的默认条目文案与老数据迁移。
//
// 背景：默认条目的备注前缀在 v1.1.0 由「默认收集：」改为「默认：」。老用户的条目
// 早已存进 tide.storage，只改 DEFAULT_ITEMS 不会生效 —— 必须有一次性改写兜住老数据。
//
// 插件源码是 IIFE，这里用 vm 注入 fixture 把内部的 migrateNotes / DEFAULT_ITEMS 暴露出来，
// 直接跑真源码 —— 比读源码猜行为可靠。
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../public/plugins/web-collector/main.js', import.meta.url), 'utf8');

const storage = new Map();
const makeCtx = (protocol) => vm.createContext({
  console,
  // 插件用 location.protocol 判「页面来源是不是 https」（决定 http 的 iframe 会不会被
  // 当混合内容拦掉），所以 fixture 必须给一个真的 location。
  location: { protocol },
  tide: {
    storage: {
      async get(key, fallback) { return storage.has(key) ? storage.get(key) : fallback; },
      async set(key, value) { storage.set(key, value); },
    },
    notify: () => {},
    ui: { registerView: () => {} },
  },
});

/* 跑两遍（页面来源 http: / https:）—— 桌面端是前者、APK 是后者。
   只做字符串断言的话，「条件少写一个」也能骗过去，所以这里直接跑真源码验真值表。 */
function loadPlugin(protocol) {
  const ctx = makeCtx(protocol);
  vm.runInContext(
    src.replace(
      'tide.ui.registerView({',
      '  globalThis.__fx = { migrateNotes, ensureDefaults, DEFAULT_ITEMS, LEGACY_NOTE_PREFIX, DEFAULT_OPEN_MODE, cleartextBlocked,\n'
      + '    extractDropUrls, DROP_MAX,\n'
      + '    get items() { return items; }, set items(v) { items = v; } };\n'
      + '  tide.ui.registerView({',
    ),
    ctx,
  );
  return ctx.__fx;
}
const fx = loadPlugin("http:");

/* ── 〇、cleartextBlocked 真值表（v1.2.4）──
   同一个混合内容根因的第三个受害者：APK 上页面来源是 https，http 的 iframe 被静默拦掉
   ⇒ 「应用内显示」一片空白。判据必须**同时**要求「页面是 https」且「地址是 http」：
   少写前者，桌面端也被误伤（桌面端页面来源是 http，http 地址本来嵌得出来）；
   少写后者，https 地址会被无辜降级。 */
{
  const onHttp = loadPlugin("http:");    // 桌面端：http://tauri.localhost
  const onHttps = loadPlugin("https:");  // Android：https://tauri.localhost
  assert.equal(onHttp.cleartextBlocked("http://daxue.qiyemulu.cn/"), false,
    '桌面端页面来源是 http，http 地址嵌得出来，不许降级');
  assert.equal(onHttp.cleartextBlocked("https://a.edu.cn/"), false, '桌面端 https 地址当然也行');
  assert.equal(onHttps.cleartextBlocked("http://daxue.qiyemulu.cn/"), true,
    'https 页面里的 http 地址 = 混合内容，必被 WebView 拦掉');
  assert.equal(onHttps.cleartextBlocked("https://a.edu.cn/"), false, 'https 页面里的 https 地址不受影响');
  assert.equal(onHttps.cleartextBlocked(""), false, '空地址不能判成被拦');
  assert.equal(onHttps.cleartextBlocked(undefined), false, 'undefined 不能抛也不能判成被拦');
  assert.equal(onHttps.cleartextBlocked("HTTP://A.EDU.CN/"), true, '大小写不敏感，别被大写绕过');
}

/* ── 一、默认条目的文案 ── */
assert.equal(fx.DEFAULT_ITEMS.length, 2, '默认条目应仍是两条');
for (const item of fx.DEFAULT_ITEMS) {
  assert.ok(item.note.startsWith('默认：'), `默认条目备注应以「默认：」开头，实际「${item.note}」`);
  assert.ok(!item.note.includes('默认收集'), `默认条目不该再出现「默认收集」，实际「${item.note}」`);
}
assert.equal(fx.LEGACY_NOTE_PREFIX, '默认收集：', '迁移用的旧前缀常量必须与已落库的老数据一致');

/* ── 二、老数据迁移 ── */
storage.clear();
fx.items = [
  { id: 'a', url: 'http://daxue.qiyemulu.cn/', note: '默认收集：大学名录' },
  { id: 'b', url: 'https://www.resource.edu.cn/', note: '默认收集：教育资源入口' },
  // 用户自己写的备注：即便碰巧以同样文字开头，也不该被改写
  { id: 'c', url: 'https://example.com/', note: '默认收集：我自己的备注' },
  { id: 'd', url: 'https://other.com/', note: '普通备注' },
  { id: 'e', url: 'http://daxue.qiyemulu.cn', note: '默认收集：大学名录' }, // 无尾斜杠也算同一条
];
await fx.migrateNotes();
const noteOf = (id) => fx.items.find((x) => x.id === id).note;
assert.equal(noteOf('a'), '默认：大学名录');
assert.equal(noteOf('b'), '默认：教育资源入口');
assert.equal(noteOf('e'), '默认：大学名录', 'URL 尾部斜杠差异不该影响识别');
assert.equal(noteOf('c'), '默认收集：我自己的备注', '非默认条目绝不能被改写');
assert.equal(noteOf('d'), '普通备注');
assert.ok(storage.has('items'), '迁移后必须落盘，否则下次进来又是旧文案');

/* ── 三、没有老数据时不写盘（避免每次进插件都无谓落库）── */
storage.clear();
await fx.migrateNotes();
assert.equal(storage.has('items'), false, '没有需要迁移的条目就不该写盘');

/* ── 四、ensureDefaults 补进来的默认条目用新文案 ── */
storage.clear();
fx.items = [];
await fx.ensureDefaults();
assert.equal(fx.items.length, 2);
for (const item of fx.items) assert.ok(item.note.startsWith('默认：'), item.note);

/* ── 五、已存在的默认条目不该被重复补（缺的那条仍要补上）── */
fx.items = [
  { id: 'x', url: 'http://daxue.qiyemulu.cn/', note: '默认：大学名录' },
  { id: 'y', url: 'https://www.resource.edu.cn', note: '默认：教育资源入口' }, // 无尾斜杠也要认作同一条
];
await fx.ensureDefaults();
assert.equal(fx.items.length, 2, '两条默认都已存在时不该再补');

fx.items = [{ id: 'x', url: 'http://daxue.qiyemulu.cn/', note: '默认：大学名录' }];
await fx.ensureDefaults();
assert.equal(fx.items.length, 2, '缺的那条默认仍要补上');
assert.ok(fx.items.some((x) => x.url === 'https://www.resource.edu.cn/'), '补的应该是缺的那条');

/* ── 六、render 必须真的接上迁移，否则老用户永远看不到新文案 ── */
assert.match(src, /await ensureDefaults\(\);\s*await migrateNotes\(\);/, 'render 里必须调用 migrateNotes');

/* ── 七、卡片编辑框不许把卡片撑爆（长标题/长备注溢出，用户实测截图）── */
const manifest = JSON.parse(fs.readFileSync(new URL('../public/plugins/web-collector/manifest.json', import.meta.url), 'utf8'));
// 1.1.2 → 编辑框字号自适应；1.2.0 → 拆出「自动获取网站图标」与「换图标」两个入口；
// 1.2.1 → manifest 补 notify 权限（此前 tide.notify 每次都抛权限错，收藏/失败提示全被吞掉）；
// 1.2.2 → 打开方式默认由「浏览器打开」改为「应用内显示」；
// 1.2.3 → 图标改走原生侧抓成 data URL（APK 上页面来源是 https，WebView 禁混合内容，
//          内置预置条目的 http 图标直连会被静默拦掉）；
// 1.2.4 → 「应用内显示」碰到 http 明文站点不再挂一个注定空白的 iframe，改成给原因 + 出口
//          （同一个混合内容根因的第三个受害者，见下面第七之二节）。
// 1.3.0 → 小程序端原生收藏适配；
// 1.4.0 → 拖入浏览器标签 / 页面链接即自动收藏（见下面第十一、十二节）。
// 这条断言的作用是「改了行为就必须动版本号」，所以每加一批行为就往上抬一格，别删。
assert.equal(manifest.version, '1.6.0', '改了网页收集的行为必须升 manifest 版本号');
assert.equal(manifest.platforms.miniprogram, 'native', '原生收藏管理已实现，任意网站内嵌不在适配范围');

/* ── 七之二、明文 http 站点在「应用内显示」里不许挂空 iframe（v1.2.4）──
   APK 上页面来源是 https（WebViewAssetLoader 默认 scheme），http 的 iframe 会被当
   **混合内容**静默拦掉 ⇒ 面板一片空白，看起来就是「插件坏了」。桌面端页面来源是 http，
   同一个地址嵌得出来 —— 又是那个「只看桌面端永远复现不了」的签名。
   🔴 判据必须是「页面自己是不是 https」，不能写成「是不是 Android」：
   后者是平台代理，Tauri 一改 scheme 就失效；前者就是混合内容的定义本身。 */
assert.ok(src.includes('const PAGE_IS_HTTPS = location.protocol === "https:"'),
  '判据要用页面来源的协议，不是平台名');
assert.ok(src.includes('const cleartextBlocked = (url) => PAGE_IS_HTTPS && /^http:\\/\\//i.test(String(url || ""));'),
  'cleartextBlocked 必须**同时**要求「页面是 https」且「地址是 http」—— 少一个条件就会误伤');
// 两个分支都要在：降级面板（嵌不出来）与 iframe（嵌得出来）
assert.ok(src.includes('const body = cleartextBlocked(item.url)'),
  'openInside 必须按 cleartextBlocked 分流，不能无条件挂 iframe');
assert.ok(src.includes('? `<div class="wc-web-blocked">'),
  '嵌不出来的地址要渲染降级面板，把原因和出口摆出来');
assert.ok(src.includes(': `<iframe src="${esc(item.url)}"'),
  '嵌得出来的地址仍要照常挂 iframe —— 桌面端就是这么工作的，别一刀切');
// 降级面板里的「浏览器打开」也要接上：原来只 querySelector 了头部那一个
assert.ok(src.includes('panel.querySelectorAll("[data-web-external]").forEach'),
  '两个「浏览器打开」按钮都要接线（querySelector 只会接上头部那个，降级面板里的点了没反应）');
assert.ok(!src.includes('panel.querySelector("[data-web-external]")'),
  '旧的单选写法必须消失 —— 留着一个 querySelector 就等于降级面板里的按钮是死的');
assert.ok(src.includes('.wc-web-blocked{flex:1;display:grid;place-content:center'),
  '降级面板要有居中样式，否则提示文字挤在角落');
assert.match(src, /\.wc-edit\{[^}]*minmax\(0,1fr\)[^}]*\}/, '.wc-edit 两列轨道必须 minmax(0,1fr) —— 1fr 的下限是 min-content，会被长值撑破卡片');
assert.match(src, /\.wc-edit input\{[^}]*min-width:0[^}]*\}/, '.wc-edit input 必须 min-width:0，否则输入框固有宽度把卡片顶破');
assert.match(src, /\.wc-edit input\{[^}]*width:100%[^}]*\}/, '.wc-edit input 必须 width:100% 才会老老实实缩进轨道里');

/* ── 八、超长文字自动缩字号（用户反馈：字超出框了要自动缩小，但不能小到看不清）── */
assert.match(src, /function fitInputFonts\(\)/, '必须提供 fitInputFonts 字号自适应');
assert.match(src, /const MAX = 13, MIN = 11;/, '字号上限 13px、下限 11px —— 下限太小学起来难受');
assert.match(src, /input\.scrollWidth > input\.clientWidth/, '缩字判定必须基于真实溢出（scrollWidth vs clientWidth）');
assert.match(src, /fitInputFonts\(\);\s*\n?\s*\}/, 'paint() 末尾必须调用 fitInputFonts');

/* ── 九、图标要能单独获取/更换，不能和「识别标题」绑死 ──
   用户需求原文：「自动获取网站图标 添加1个变成插件按钮」。
   核心是拆开：抓图标只回写 iconUrl / iconName，不许碰用户改过的标题。 */
assert.match(src, /async function fetchIcon\(/, '必须单独提供 fetchIcon(url)，只取图标');
assert.match(src, /async function probeIcon\(/, '顶栏「自动获取网站图标」要有对应处理函数');
assert.match(src, /async function refreshIcon\(id\)/, '卡片「换图标」要有对应处理函数');
// fetchIcon 的回写字段只许「图标三件套」—— 这是「不误伤标题」的契约：
// refreshIcon 里是 Object.assign(item, got)，多回一个 title/note 就会覆盖用户手改的内容。
// iconData 是 v0.73.0 加的（APK 上 http favicon 直连被 WebView 静默拦掉，改原生侧抓成 data URL），
// 它只落在图标上，不碰标题。
assert.match(src, /return \{ iconUrl, iconName: iconName \|\| "globe", iconData: await fetchIconData\(iconUrl\) \};/,
  'fetchIcon 必须回 { iconUrl, iconName, iconData } 三件套');
assert.doesNotMatch(src, /return \{ iconUrl[^}]*\b(title|note|host)\b/,
  'fetchIcon 不许回 title/note/host —— Object.assign 会覆盖用户手改的内容');
// 顶栏与卡片按钮的 data 标记必须不同，否则事件委托里顶栏分支会抢走卡片的点击
assert.match(src, /data-probe-icon/, '顶栏按钮用 data-probe-icon');
assert.match(src, /data-fetch-icon/, '卡片按钮用 data-fetch-icon');
assert.match(src, /closest\("\[data-probe-icon\]"\)[\s\S]*?closest\("\[data-id\]"\)/,
  '顶栏 data-probe-icon 分支必须在 closest("[data-id]") 之前 —— '
  + '两者若同名，卡片「换图标」永远拿不到条目 id');
assert.match(src, /data-fetch-icon[^>]*title=/, '卡片「换图标」要有 title 说明它和「刷新名称/图标」的区别');
// 预览条里的图标地址：长 URL 必须保持一行 + 横向滚动
// （实测用 word-break:break-all 会在 390px 窄屏把 .../favicon.ico 折成 4 行竖排，几乎读不出来）
assert.match(src, /\.wc-preview-text code\{[^}]*white-space:nowrap/, '图标地址要 nowrap，不能逐字符折行');
assert.doesNotMatch(src, /\.wc-preview-text code\{[^}]*word-break:break-all/,
  '图标地址不能用 word-break:break-all —— 窄屏会把 URL 折成竖排');
assert.match(src, /@media\(max-width:640px\)\{[\s\S]*?\.wc-preview-text\{flex-basis:100%\}/,
  '窄屏下图标地址要独占一行（否则按钮挤占宽度，URL 只剩十几个字符可见）');

/* ── 十、打开方式默认「应用内显示」──
   用户要求：点卡片「打开」默认在本应用的面板里加载，不再跳出到系统浏览器。
   三处默认值（模块初始化 / storage 读取 fallback / 脏值兜底）必须全部指向同一个常量 ——
   漏改任何一处，就会在「storage 里没有 openMode」或「存了脏值」这两条路径上退回浏览器打开。 */
assert.equal(fx.DEFAULT_OPEN_MODE, 'inside', '默认打开方式必须是应用内显示');
assert.match(src, /openMode = DEFAULT_OPEN_MODE, iconPreview/,
  '模块初始化必须用 DEFAULT_OPEN_MODE，不能写死 external');
assert.match(src, /openMode = await tide\.storage\.get\("openMode", DEFAULT_OPEN_MODE\)/,
  'storage 读取的 fallback 必须是 DEFAULT_OPEN_MODE，且读到的值要原样赋给 openMode（尊重用户已存的选择）');
assert.match(src, /!\["external", "inside"\]\.includes\(openMode\)\) openMode = DEFAULT_OPEN_MODE/,
  '脏值兜底也要落回 DEFAULT_OPEN_MODE');
assert.match(src, /if \(openMode === "inside"\) openInside\(item\);/, 'openItem 仍以 openMode 为准');
// 下拉框的选中态必须跟 openMode 走 —— 默认 inside ⇒ 打开插件第一眼看到的就是「应用内显示」
assert.match(src, /<option value="inside"\$\{openMode === "inside" \? " selected" : ""\}>应用内显示<\/option>/,
  '「应用内显示」选项必须在 openMode === "inside" 时选中');
assert.match(src, /<option value="external"\$\{openMode === "external" \? " selected" : ""\}>浏览器打开<\/option>/,
  '「浏览器打开」选项必须在 openMode === "external" 时选中（两条一起钉住方向，反转会被抓到）');
// 反面：任何一处把 external 写死成默认/兜底都算漏改
assert.doesNotMatch(src, /"openMode",\s*"external"/, '不该再有把 external 当 fallback 的写法');
assert.doesNotMatch(src, /openMode = "external"/, '不该再有把 external 写死为默认值的写法');

/* ── 十一、拖入即收藏：从 dataTransfer 里挑网址 ──
   拖法的差异必须分开认（拖浏览器标签 / 拖选中链接 / 拖网址文件三者的 dataTransfer 不一样），
   而且**带 Files 的绝不能接管** —— 那可能是截图或文档，原本归宿主的全局快速捕获（建任务）。
   这里跑真的 extractDropUrls，比读源码猜正则可靠。 */
const dt = (types, data = {}) => ({ types, getData: (t) => data[t] ?? "" });
// vm 里创建的数组带的是沙箱的 Array 原型，deepStrictEqual 会因为原型不同判不等 ——
// 先 Array.from 复制成宿主数组再比。
const dropUrls = (d) => Array.from(fx.extractDropUrls(d));

// 拖浏览器标签：Chromium 给 text/plain（地址）+ text/html（<a>，标题文字也在里面）
assert.deepEqual(dropUrls(dt(["text/plain", "text/html"], {
  "text/plain": "https://www.example.edu.cn/",
  "text/html": '<a href="https://www.example.edu.cn/">示例大学 · 首页</a>',
})), ["https://www.example.edu.cn/"], '拖标签应取到那一个网址');

// text/plain 是「标题 空格 地址」那种（从书签栏 / 别的应用拖过来），也要能挑出地址
assert.deepEqual(dropUrls(dt(["text/plain"], {
  "text/plain": "国家教育资源公共服务平台 https://www.resource.edu.cn/",
})), ["https://www.resource.edu.cn/"], 'plain 里混着标题文字也要挑出网址');

// plain 空的退化路径：只有 text/html（个别浏览器拖标签只给 html）
assert.deepEqual(dropUrls(dt(["text/plain", "text/html"], {
  "text/html": '<a href="https://a.edu.cn/x">A 校</a>',
})), ["https://a.edu.cn/x"], 'plain 为空时要回退到 text/html');

// uri-list 优先：它是纯地址清单，不能被 plain/html 里的杂链接污染
assert.deepEqual(dropUrls(dt(["text/uri-list", "text/plain"], {
  "# 拖书签文件夹时的注释行": "",
  "text/uri-list": "# from bookmarks\nhttps://a.edu.cn/\nhttps://b.edu.cn/",
  "text/plain": "顺带选中的文字里有 https://noise.edu.cn/ 一句",
})), ["https://a.edu.cn/", "https://b.edu.cn/"], 'uri-list 存在时不得混进 plain 里的杂链接');

// 去重（大小写差异视同一条）+ 尾部中文标点剥掉
assert.deepEqual(dropUrls(dt(["text/plain"], {
  "text/plain": "https://A.EDU.CN/ https://a.edu.cn/ 看完 https://c.edu.cn/。还有 https://c.edu.cn/、",
})), ["https://A.EDU.CN/", "https://c.edu.cn/"], '重复地址要去掉、尾部中文标点不能留下');

// 一次拖多个（多选标签 / 书签文件夹）要有上限，否则一次拖进来几十条会把识别打瘫
assert.equal(dropUrls(dt(["text/uri-list"], {
  "text/uri-list": Array.from({ length: fx.DROP_MAX + 9 }, (_, i) => `https://s${i}.edu.cn/`).join("\n"),
})).length, fx.DROP_MAX, `一次最多收 ${fx.DROP_MAX} 个`);

// 🔴 带 Files 一律不接管（拖截图 / 拖文档要照旧走全局捕获建任务）
assert.deepEqual(dropUrls(dt(["Files", "text/plain"], { "text/plain": "截图.png https://a.edu.cn/" })), [],
  'Files 拖入必须交回全局捕获，即使文本里碰巧有地址');
// 没有可认类型 / 纯文本里没有网址 / dataTransfer 残缺 —— 都返回空，让 drop 放行
assert.deepEqual(dropUrls(dt([], {})), [], '没有可用类型应为空');
assert.deepEqual(dropUrls(dt(["text/plain"], { "text/plain": "这段笔记里没有任何链接" })), [], '纯文本无链接应为空');
assert.deepEqual(dropUrls(dt(["text/plain"], { "text/plain": "javascript:alert(1)" })), [], '非 http(s) 的伪协议绝不能被收进来');
assert.deepEqual(dropUrls({ types: ["text/plain"], getData: () => { throw new Error("SecurityError"); } }), [],
  'getData 抛错不应冒泡打断 drop');

/* ── 十二、拖入的接线：必须拦住宿主的全局捕获 ──
   宿主 src/capture.js 在 document 上挂了 dragenter/dragover/drop（气泡阶段），
   把任何拖进来的东西解析成「任务 + 时间块」。插件视图挂在 .plugview 里、在其上游，
   所以**不 stopPropagation 就等于这个功能根本没生效**；而 dragover 不 preventDefault
   浏览器根本不认这是可放置目标，drop 永远不触发。 */
assert.match(src, /host\.addEventListener\("dragenter"/, 'dragenter 必须绑在插件容器上');
assert.match(src, /host\.addEventListener\("dragover"/, 'dragover 必须绑在插件容器上');
assert.match(src, /host\.addEventListener\("drop"/, 'drop 必须绑在插件容器上');
for (const ev of ["dragenter", "dragover", "dragleave", "drop"]) {
  // 逐个处理器按「从本行到下一个 addEventListener 之间」掐出代码块。
  // 用宽松正则跨行匹配会一路吞到后面那个处理器，前面那个丢了 stopPropagation 也照样绿。
  const from = src.indexOf(`host.addEventListener("${ev}"`);
  assert.ok(from > 0, `${ev} 必须绑在插件容器 host 上`);
  const rest = src.slice(from + 1);
  const next = rest.search(/host\.addEventListener\(|return \(\) =>/);
  const block = next < 0 ? rest : rest.slice(0, next);
  assert.match(block, /droppable\(e\)/, `${ev} 要先过 droppable 门卫（带 Files 的不接管）`);
  assert.ok(block.includes("stopPropagation"), `${ev} 必须 stopPropagation，否则被宿主全局捕获抢走`);
}
// dragover 的 preventDefault 单独钉：不 preventDefault，浏览器根本不认这是可放置目标，
// drop 永远不触发 —— 少了这一行整个功能静默失效，是最容易写错又最难发现的一处。
assert.match(src, /host\.addEventListener\("dragover"[\s\S]{0,240}?e\.preventDefault\(\)[\s\S]{0,120}?dropEffect = "copy"/,
  'dragover 必须 preventDefault 并声明 dropEffect = copy');
// 挑不出网址时必须放行：drop 里那道判空分支内不得出现 preventDefault / stopPropagation
// —— 否则纯文本拖进这一页会「什么都不发生」，而它原本的行为是交给宿主全局捕获建任务。
// 按「取址 → 判空分支收尾」精确掐段来查，不用宽松的 [\s\S]*? 距离匹配
// （距离匹配会把写在 return 之前的拦截一起放过）。
const dropBody = src.slice(src.indexOf('host.addEventListener("drop"'), src.indexOf('return () =>'));
assert.ok(dropBody.length > 80, 'drop 处理段要能被定位到，否则这条断言形同虚设');
const guardFrom = dropBody.indexOf('extractDropUrls(e.dataTransfer)');
assert.ok(guardFrom > 0, 'drop 里必须先同步取出网址再决定接不接管');
const guardDecl = dropBody.indexOf('if (!urls.length)', guardFrom);
const guard = dropBody.slice(guardFrom, dropBody.indexOf('}', guardDecl));
assert.ok(guardDecl > guardFrom && guard.length > 10, 'urls 判空分支要存在（没网址就早退）');
assert.doesNotMatch(guard, /preventDefault|stopPropagation/,
  '没解析出网址时不得 preventDefault / stopPropagation，要照旧交给全局捕获');
assert.match(dropBody.slice(dropBody.indexOf('}', guardDecl)), /e\.preventDefault\(\)[\s\S]{0,80}e\.stopPropagation\(\)[\s\S]{0,120}collectDropped\(urls\)/,
  '解析出网址后才拦事件，并走 collectDropped 落库');
// 三条收藏入口共用 collect，落库点全文件只能有一处（否则拖入与输入框的行为会分叉）
assert.equal((src.match(/items\.unshift\(\{ id: uid\(\), note: ""/g) || []).length, 1,
  'items.unshift 只应存在于 collect 一处');
assert.match(src, /if \(busy \|\| !urls\.length\) return;/, '拖入收藏要有 busy 门禁，不能和输入框并发抢写');
// 拖入提示只做描边与文案，不得新建 fixed 浮层（浮层要自己让开四边安全区，见 AGENTS.md 铁律四）
assert.doesNotMatch(src, /\.wc-dropping[^{}]*\{[^}]*position:fixed/, '拖拽提示不许用 position:fixed 自建遮罩');
assert.match(src, /\.wc-dropping \.wc\{[^}]*outline:2px dashed var\(--deep\)/, '落区要有可见的描边反馈');

console.log('PASS: web-collector 默认条目文案（默认收集 → 默认）、老数据一次性迁移、卡片编辑框宽度约束与图标单独获取、打开方式默认应用内显示、拖入即收藏挑址与拦住全局捕获');
