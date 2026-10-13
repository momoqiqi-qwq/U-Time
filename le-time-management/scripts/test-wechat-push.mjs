import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/plugins/wechat-push/main.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../public/plugins/wechat-push/manifest.json', import.meta.url), 'utf8'));

/* ── 1. 官方文档入口：链接必须是 pushplus 官方域名，且经 openUrl 系统浏览器打开 ── */
assert.ok(source.includes('https://www.pushplus.plus/doc/guide/sdk.html'), '必须链接官方使用说明/SDK 文档');
assert.ok(source.includes('https://www.pushplus.plus/doc/guide/api.html'), '必须链接官方消息接口文档');
assert.ok(source.includes('tide.util.openUrl'), '文档链接必须用 openUrl 经系统浏览器打开');
assert.equal(manifest.version, '1.12.0');
assert.ok((manifest.permissions || []).includes('openUrl'), 'manifest 必须声明 openUrl 权限');
assert.ok((manifest.permissions || []).includes('events'), '订阅 notice:new 必须在 manifest 声明 events 权限');
const catalog = fs.readFileSync(new URL('../src/pluginCatalog.js', import.meta.url), 'utf8');
const entry = catalog.slice(catalog.indexOf('"id": "wechat-push"'));
const block = entry.slice(0, entry.indexOf('},\n  {'));
assert.match(block, /"1\.12\.0"/, 'pluginCatalog 必须同步插件新版本号');
assert.match(block, /"openUrl"/, 'pluginCatalog 必须同步 openUrl 权限');

/* ── 2. vm 实测 pushPlus：请求体、成功判定、失败透传 ── */
const calls = [];
let pushplusResp = { status: 200, body: JSON.stringify({ code: 200, msg: '请求成功', data: 'x' }) };
const context = vm.createContext({
  URL, Set, Map, Date, console, setTimeout, clearTimeout, Promise,
  document: { createElement: () => ({ set innerHTML(x) { this.value = x; } }) },
  tide: {
    ui: { registerView() {} },
    storage: { get: async () => null, set: async () => {} },
    http: {
      session: async () => 's1',
      fetch: async (...args) => { calls.push(args); return typeof pushplusResp === 'function' ? pushplusResp(...args) : pushplusResp; },
      get: async () => { throw new Error('not used'); },
    },
    util: { openUrl: async () => {} },
    notify: () => {},
  },
});
vm.runInContext(source.replace('  tide.ui.registerView(', '  globalThis.testApi = {pushPlus, serverChan, state, enqueuePluginNotice, allowedSource, sourceIcon, sourceOptions};\n  tide.ui.registerView('), context);
const { pushPlus, state } = context.testApi;

// 等模块加载期的 loadPrefs 微任务完成，避免其覆盖测试注入的凭据
await new Promise((resolve) => setTimeout(resolve, 0));
state.token = 'd-order-token';
state.topic = 'group-1';
await pushPlus('测试标题', '测试内容');
const [sid, method, url, opts] = calls.at(-1);
assert.equal(sid, 's1');
assert.equal(method, 'POST');
assert.equal(url, 'https://www.pushplus.plus/send');
assert.equal(opts.headers['Content-Type'], 'application/json');
const payload = JSON.parse(opts.body);
assert.equal(payload.token, 'd-order-token');
assert.equal(payload.title, '测试标题');
assert.equal(payload.content, '测试内容');
assert.equal(payload.template, 'txt');
assert.equal(payload.channel, 'wechat');
assert.equal(payload.topic, 'group-1', '填写 Topic 时必须带上群组编码');

// 官方接口：code=200 才算提交成功
pushplusResp = { status: 200, body: JSON.stringify({ code: 903, msg: '发送频率过快' }) };
await assert.rejects(() => pushPlus('t', 'c'), /发送频率过快/, '非 200 返回码必须把官方 msg 透传给用户');
// 错误信息必须带官方返回码（999=服务端验证错误 等要对官方返回码表排查，只有 msg 对不上号）
pushplusResp = { status: 200, body: JSON.stringify({ code: 999, msg: '服务端验证错误' }) };
await assert.rejects(() => pushPlus('t', 'c'), /PushPlus\[999\]服务端验证错误/, '失败信息必须带 PushPlus 返回码');
// HTTP 错误也必须抛出
pushplusResp = { status: 403, body: '' };
await assert.rejects(() => pushPlus('t', 'c'), /HTTP 403/);

/* ── 3. v1.5.0：PushPlus 频次限制防护 ──
   官方规则：相同内容 1 小时限 3 条、每分钟限 5 次，超限返回 999「服务端验证错误」。
   实测事故：15:04 连发 3 条相同测试推送成功，15:05 起第 4 条开始全部 999。 */
assert.match(source, /U-Time测试推送 \$\{at\}/, '测试推送标题必须带时间戳，避免撞「相同内容 1 小时 3 条」限制');
assert.match(source, /lastTestAt/, '测试推送必须有防连点节流');
assert.match(source, /999\|服务端验证/, '失败日志必须识别 999 并给出频次限制提示');
assert.match(source, /推送「\$\{title\.slice\(0, 20\)\}」/, '失败日志必须带上推送标题，便于对号入座');

/* ── 4. v1.7.0 多选 + v1.8.0 攒批：插件消息合并成一条推送 ──
   旧单选下拉（data-scope）已移除；pushScope 数组持久化，老配置从 blockEnabled/taskEnabled 反推。
   v1.8.0 攒批策略（对照 PushPlus 官方限制：相同内容 1 小时限 3 条、每分钟限 5 次、内容 ≤20000 字）：
   首条入队后攒 2 分钟（节流式窗口），到点把队列里全部待发消息合并成一条推送，请求数压到最低。 */
assert.match(block, /"1\.12\.0"/, 'pluginCatalog 必须同步插件新版本号');
assert.match(source, /data-ms="block"/, '多选面板要有「时间块」选项');
assert.match(source, /data-ms="task"/, '多选面板要有「任务截止」选项');
assert.match(source, /data-ms="plugin"/, '多选面板要有「插件收集的新消息」选项');
assert.match(source, /pushScope/, '多选结果必须存进 pushScope');
assert.match(source, /state\.blockEnabled = state\.pushScope\.includes\("block"\)/, 'blockEnabled 必须由 pushScope 派生（tick 逻辑不变）');
assert.match(source, /state\.blockEnabled && state\.taskEnabled \? \["block", "task"\] : state\.blockEnabled \? \["block"\] : state\.taskEnabled \? \["task"\] : \["block", "task"\]/, '老配置必须能反推出初始多选状态');
assert.match(source, /tide\.events\.on\("notice:new", queuePluginNotice\)/, '必须订阅 notice:new 事件');
assert.match(source, /PLUGIN_BATCH_WINDOW_MS = 2 \* 60 \* 1000/, '插件消息必须攒批 2 分钟再发，不能每条广播立即推送');
assert.match(source, /state\.pluginQueue\.slice\(\)/, '一批必须带上队列里全部待发消息，把请求数压到最低');
assert.match(source, /state\.pluginQueue\.length > PLUGIN_QUEUE_CAP/, '消息队列必须有上限');
assert.match(source, /PLUGIN_QUEUE_CAP = 60/, '队列上限 60 条（攒批窗口内足够缓存多个插件的广播）');
assert.match(source, /PLUGIN_CONTENT_LIMIT = 18000/, '单条推送正文必须按 PushPlus 2 万字上限留余量截断');
assert.match(source, /if \(ok\) \{ state\.pluginQueue\.splice\(0, batch\.length\); paintQueue\(\); \}/, '推送成功才出队，失败留下次重试');
assert.match(source, /if \(!state\.pluginTimer\) await flushPluginNotices\(\)/, 'tick 只做失败重试/兜底，攒批窗口倒计时中不得提前发送');
assert.match(source, /\$\{batch\.length\} 条（\$\{now\}）/, '批量推送标题要带条数和时间，避免撞「相同内容 1 小时 3 条」');
assert.doesNotMatch(source, /data-scope/, '旧单选下拉不应残留');

/* ── 5. v1.8.1 多选面板可收起 + 展开/收起动画 ──
   事故：.wp-ms-panel 的 display:flex 是作者样式，永远压过 UA 的 [hidden]{display:none}，
   msPanel.hidden 切了也没用 → 面板恒展开收不回去。改为 .on 类切换 + 过渡动画。 */
assert.match(source, /\.wp-ms-panel\.on\{/, '面板必须用 .on 类控制展开态（hidden 属性被 display:flex 压住，不可用）');
assert.doesNotMatch(source, /msPanel\.hidden/, '不得再用 hidden 属性开关面板（根因所在）');
assert.match(source, /setMsOpen\(!msPanel\.classList\.contains\("on"\)\)/, '点按钮必须按当前状态取反开合');
assert.match(source, /if \(!e\.target\.closest\("\[data-ms\]"\)\) setMsOpen\(false\)/, '点外部必须收起面板');
assert.match(source, /aria-expanded/, '按钮必须同步 aria-expanded');
assert.match(source, /wp-ms-caret/, '箭头必须可随开合旋转');
assert.match(source, /transition:opacity \.18s ease,transform \.18s ease/, '展开/收起必须有过渡动画');
assert.match(source, /@media \(prefers-reduced-motion:reduce\)\{\.wp-ms-panel,\.wp-ms-caret\{transition:none\}\}/, '必须尊重 reduced-motion 关掉动画');
assert.match(source, /<div class="wp-ms-panel" data-ms-panel>/, '面板初始为收起态（不再带 hidden 属性）');

/* ── 6. v1.9.0 推送规则细化：插件级勾选（pluginPicks）+ 带图标的多列下拉 ──
   「插件消息」不再是一个总开关管所有插件：勾格按插件排，一格一个源，图标用插件随包 PNG。
   两层判定的行为面直接在 vm 里实测（总开关 / 插件勾 / 未细分默认全放行）。 */
{
  const { enqueuePluginNotice, allowedSource, sourceIcon, sourceOptions } = context.testApi;
  state.pushScope = ["plugin"];
  // 未细分（老配置 / 全勾）= 全部放行，升级不会悄悄少推
  state.pluginPicks = null;
  assert.ok(allowedSource("chaoxing-notify") && allowedSource("gx-news"), '未细分时必须放行所有消息源');
  enqueuePluginNotice({ source: "gx-news", sourceName: "竞赛消息", items: [{ title: "竞赛 A", time: "10:00" }] });
  assert.equal(state.pluginQueue.length, 1, '未细分时消息正常入队');
  // 只勾学习通 → 别的源不入队（不占 PushPlus 频次额度）
  state.pluginPicks = ["chaoxing-notify"];
  enqueuePluginNotice({ source: "gx-news", sourceName: "竞赛消息", items: [{ title: "竞赛 B", time: "10:05" }] });
  assert.equal(state.pluginQueue.length, 1, '未勾选的插件消息不得入队');
  enqueuePluginNotice({ source: "chaoxing-notify", sourceName: "学习通", items: [{ title: "通知 C", time: "10:10" }] });
  assert.equal(state.pluginQueue.length, 2, '勾选的插件消息必须入队');
  // 数组来自 vm realm，deepEqual 会比原型而假红 → 用 join 比原始值
  assert.equal(state.pluginQueue.map((x) => x.id).join(","), "gx-news,chaoxing-notify",
    '队列要记住来源 id，勾选变化时才知道清掉谁');
  // 总开关关掉 → 一律不放行
  state.pushScope = [];
  assert.ok(!allowedSource("chaoxing-notify"), '「插件消息」总开关关掉时任何源都不放行');
  clearTimeout(state.pluginTimer);   // 攒批窗口是 2 分钟计时器，测试不留着它吊住事件循环
  state.pluginTimer = null;
  // 勾格必须覆盖已接入广播的插件，且每个源在推送侧和插件侧的 id 对得上
  const ids = sourceOptions().map((s) => s.id).join(",");
  assert.equal(ids, "chaoxing-notify,cppu-notify,gx-news,rss-reader,school-notice",
    '勾格清单必须与真正广播 notice:new 的插件一一对应（新增消息源要同时补 SOURCE_SEED 和插件侧广播）');
  assert.equal(sourceIcon("chaoxing-notify"), "/icons/plugins/chaoxing-notify.png", '图标必须取插件随包 PNG');
  assert.match(source, /onerror|addEventListener\("error"/, '用户插件没有随包图标时必须退回符号，不能留裂图');
}

/* 多列 + 图标的下拉面板（不是单列文字勾） */
assert.match(source, /data-ms-srcs/, '面板里要有插件勾格容器');
assert.match(source, /\.wp-ms-panel\{[^}]*display:grid[^}]*grid-template-columns:repeat\(auto-fit,minmax\(146px,1fr\)\)/,
  '推送内容面板必须按可用宽度排成多列');
assert.match(source, /\.wp-srcs\{[^}]*grid-template-columns:repeat\(auto-fit,minmax\(132px,1fr\)\)/,
  '插件勾格自身也要多列排布');
assert.match(source, /\.wp-srcs\.off\{[^}]*pointer-events:none/, '总开关关掉时插件勾格必须不可点');
assert.match(source, /wp-ms-ico/, '时间块/任务/插件三格必须带图标');
assert.match(source, /state\.pluginPicks = on\.length === boxes\.length \? null : on/,
  '全部勾回「未细分」，新接入的消息源才会继续默认推送');
assert.match(source, /function pruneQueue\(\)/, '取消勾选后要能清掉队列里等着发的消息');
assert.match(source, /ensurePrefs\(\)\.then\(\(\) => enqueuePluginNotice\(p\)\)/,
  '广播早于偏好读回时必须先等 prefs，否则勾选状态还是默认值会把消息错杀');
/* 无头 Chrome 实测：390px 宽时那一行会换行、按钮被挤到 x=236，面板（302px）从那里展开
   右半边 148px 掉到视口外，勾格看不见也点不到 → 打开时必须按视口右缘夹回来。
   v0.74.0 起那条右缘不是 `innerWidth` 而是 `innerWidth - sar`：横屏时挖孔与侧边三键栏
   占掉一段，视口的边 ≠ 可视区的边（AGENTS.md 铁律四 · 插件安全区）。 */
assert.match(source, /const \[sal, sar\] = \[px\("--sal"\), px\("--sar"\)\]/,
  '夹取用的左右边界必须先读宿主注入的安全区变量');
assert.match(source, /msBtn\.getBoundingClientRect\(\)\.left \+ msPanel\.offsetWidth - \(innerWidth - sar - 12\)/,
  '下拉面板打开时必须量一次可视区右缘并把自己推回可见区域（窄屏换行后按钮靠右会被裁掉）');
assert.match(source, /Math\.min\(Math\.ceil\(over\), msBtn\.getBoundingClientRect\(\)\.left - sal - 12\)/,
  '推回的量还要夹一次，免得把面板顶穿可视区左缘');

/* 四个消息类插件必须真的广播 notice:new，并声明 events 权限（否则勾格是永远不出消息的死选项） */
for (const id of ["chaoxing-notify", "cppu-notify", "gx-news", "rss-reader", "school-notice"]) {
  const plugSrc = fs.readFileSync(new URL(`../public/plugins/${id}/main.js`, import.meta.url), 'utf8');
  assert.match(plugSrc, new RegExp(`tide\\.events\\.emit\\("notice:new",\\s*\\{[\\s\\S]{0,200}source: "${id}"`),
    `${id} 必须广播 notice:new 且带上自己的 source id`);
  const plugMan = JSON.parse(fs.readFileSync(new URL(`../public/plugins/${id}/manifest.json`, import.meta.url), 'utf8'));
  assert.ok((plugMan.permissions || []).includes('events'), `${id} 调用 tide.events 必须在 manifest 声明 events`);
  // 首次抓取只记快照不广播，否则装上插件就把整页历史通知推到微信（各插件的守卫写法都列在这里。
  // gx-news 多源化后按源存快照，「这个源没见过」是 undefined 而不是 null，两种写法都要认）
  assert.match(plugSrc, /stored === (?:null|undefined) \? \[\] :|firstSync|if \(!state\.knownIds\.size\)/,
    `${id} 首次同步不得把历史条目当新消息广播`);
}

/* ── 7. v1.11.0 微信绿：品牌色只落在「通道 + 成功」两处 ──
   事故：整个界面只有一种深青强调色，日志里 ✓ 与 ✗ 同为 --ink-2 灰（成功与失败视觉等价），
   预览头像还是 P/S 字母方块，看不出这是微信消息。全局没有 --ok/--success 令牌，
   绿色语义色就是 --mint（#2EC4B6，偏青）—— 微信场景要用微信自己的 #07C160，
   所以这份绿定义在插件作用域 .wp-wrap 上，不污染全局色板。 */
assert.match(source, /\.wp-wrap\{--wp-wx:#07C160/, '微信绿必须定义在插件自己的作用域（全局 --mint 是青色，微信场景不能借用）');
assert.match(source, /:root\[data-theme-mode="dark"\] \.wp-wrap\{--wp-wx:#2AD37F/,
  '深色主题必须换更亮的绿（#07C160 压深底偏暗）');
assert.match(source, /\.wp-btn\.pri\{background:var\(--wp-wx\);border-color:var\(--wp-wx\);color:#fff\}/,
  '主按钮（获取 Token / 发送测试消息）必须是微信绿实底白字');
assert.match(source, /\.wp-provider button\.on\{border-color:var\(--wp-wx-edge\)/,
  '渠道选中态的描边要跟着绿（原来只有主题深青）');
assert.match(source, /\.wp-card\{border-top:2px solid color-mix\(in srgb,var\(--wp-wx-edge\) 70%/,
  '卡片顶部要有一条绿细线，让「这是微信通道」一眼可辨');
assert.match(source, /class="wp-logo" src="\/icons\/plugins\/wechat-push\.png"/,
  '标题左侧用随包微信 logo PNG（FontAwesome solid 里没有 weixin，只能用它）');
assert.match(source, /data-pill/, '标题右侧要有连接状态胶囊');
assert.match(source, /pill\.textContent = ready && state\.enabled \? "推送中" : ready \? "未开启" : "未配置"/,
  '胶囊三态：只有「开着且凭据齐全」才显绿');
assert.match(source, /pill\.classList\.toggle\("off", !\(ready && state\.enabled\)\)/,
  '未配置 / 未开启时必须摘掉绿态（否则绿胶囊会说谎）');
assert.match(source, /l\.includes\("✓"\) \? "wp-logsuc" : l\.includes\("✗"\) \? "wp-logerr"/,
  '日志 ✓/✗ 必须按行判色，不能再统一 --ink-2');
assert.match(source, /\.wp-logsuc\{color:color-mix\(in srgb,var\(--wp-wx\) 58%/,
  '成功行用微信绿与正文色混出的可读绿（纯 #07C160 压浅底只有 2 点多比 1）');
assert.match(source, /\.wp-logerr\{color:var\(--danger,#B03535\)\}/, '失败行用 --danger');
assert.doesNotMatch(source, /color:var\(--ink-2,#7E8B94\);padding:3px 0/,
  '日志行不得再对 ✓/✗ 一律上同一灰度（失败与成功在视觉上必须区分）');
assert.match(source, /<span class="wp-preview-avatar"><img src="\/icons\/plugins\/wechat-push\.png"/,
  '微信预览头像必须是微信图标（原来是 P/S 字母）');
assert.doesNotMatch(source, /"P" : "S"/, '旧的字母头像必须移除');
assert.doesNotMatch(source, /background:#18a058/, '预览头像的旧硬编码绿底必须清掉，改由 --wp-wx 派生');
assert.match(source, /\.wp-preview-note\{color:#6b6b6b\}/,
  '预览提示压在固定的浅灰底上，不能跟主题走 --ink-2（夜间 --ink-2 变浅 ⇒ 浅字压浅底）');

/* ── 8. v1.12.0 描述精简：把「说明书」从界面里拿掉 ──
   事故：单视图插件实测可见文字 531 字，其中 4 段灰色长说明 + 1 行字距拉开的 kicker 占了一半以上，
   而每一条都在复述旁边按钮/字段已经说清的事（「点『一键获取 Token』打开一对一消息页…」旁边就是那个按钮）。
   删的判据不是「看着啰嗦」，而是「删掉这行，功能还看得懂吗」——看得懂才删；
   所以留下的是操作步骤（扫码登录后复制 Token）和状态说明（✓ 只表示已提交、仅本地模拟）。 */
assert.doesNotMatch(source, /微 信 信 息 推 送/, '字距拉开的 kicker 整行必须删（卡片标题已写微信推送）');
assert.doesNotMatch(source, /推荐使用 PushPlus/, '卡片顶那段 110 字的推荐说明必须删（四件事里三件与按钮/字段重复）');
assert.doesNotMatch(source, /官方文档：/, '文档行不再带「官方文档：」前缀，链接文案自己就说清了');
assert.doesNotMatch(source, /Server酱（兼容）/, '渠道按钮去掉「（兼容）」后缀（「（推荐）」保留）');
assert.doesNotMatch(source, /一键获取 Token/, '「一键」是自夸，按钮只留动词短语');
assert.match(source, />↗ 获取 Token</, '获取 Token 按钮必须还在');
assert.doesNotMatch(source, /打开「一对一消息」页/, 'Token 旁 33 字提示要压成一行短句');
assert.match(source, /扫码登录后复制 Token/, 'Token 旁短提示必须还在 —— 那是真的操作步骤，不是说明');
assert.doesNotMatch(source, /Topic（可选，群组编码）/, 'label 只留字段名，可选性交给 placeholder');
assert.match(source, /placeholder="留空只推给自己"/, 'placeholder 要说清「什么都不填」会怎样');
assert.doesNotMatch(source, /应用内提醒/, '多选面板删掉「应用内提醒」分组标题（勾格本身写着时间块/任务截止）');
assert.match(source, /<span class="wp-ms-cap">插件消息<\/span>/, '「插件收集的新消息」缩成「插件消息」');
assert.doesNotMatch(source, /先攒 2 分钟，再把队列里全部待发消息合并成一条推送/, '攒批说明压成一句');
assert.match(source, /攒 2 分钟后合并发送，省频次额度。/, '攒批结论要留一句（用户需要知道为什么要等）');
assert.doesNotMatch(source, /官方接口为异步，code=200 只代表已接收/, '日志说明压成一句；频次规则只在 999 报错时才由 pushLog 吐出来');
assert.match(source, /✓ 只表示已提交，实际送达以微信为准。/, '「✓ = 已提交、不等于已送达」这句不能删（这是防误解的关键）');
assert.doesNotMatch(source, /查看微信消息预览/, '预览按钮文案缩成「微信预览」');
assert.match(source, />微信预览</, '微信预览按钮必须还在');
assert.doesNotMatch(source, /当前没有对应数据，展示示例内容。/, '预览说明不再分「示例/真实」两句');
assert.match(source, /仅本地模拟，不发送消息</, '「只是本地模拟」必须留（否则用户以为真发了）');
assert.doesNotMatch(source, /sample/, '预览说明不再依赖 sample，变量本身也要清干净');
/* 「显示凭据」按钮：单说一个动词就必须真的跟着状态走 */
assert.match(source, /data-show aria-pressed="false">显示凭据</, '按钮初始文案是「显示凭据」');
assert.doesNotMatch(source, /显示\/隐藏凭据/, '不许退回两个动词并列的旧文案');
assert.match(source, /e\.currentTarget\.textContent = next === "text" \? "隐藏凭据" : "显示凭据"/,
  '按下去要变成「隐藏凭据」：原来只切 input type、文案恒定，单动词写法下就会说谎');

console.log('PASS: wechat-push 官方文档入口、openUrl 权限、PushPlus 请求体与成功/失败判定、返回码透传与频次限制防护、多选面板可收起与开合动画、插件级勾选两层判定与多列图标下拉、微信绿品牌色与日志成败配色、五个消息源插件的 notice:new 广播、描述精简后仍留下操作步骤与成败语义');
