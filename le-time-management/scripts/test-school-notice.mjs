// school-notice 的两块接线契约：
//   一、站点菜单图标（chip）展开 / 收起站点设置卡片
//   二、图标上的右键菜单
//
// 交互行为（菜单出现在光标处、右键的站点会被切成当前站点、动作打到正确的站点上、
// 点别处 / Esc / 滚动收起、贴边收进视口）用真浏览器验证：
//   node output/school-tabmenu-probe.cjs
//   chrome --headless=new --dump-dom file:///…/output/school-tabmenu-probe.html
// 这里只守那些「改坏了会静默失效」的接线约定 —— 它们没法靠肉眼看出来。
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../public/plugins/school-notice/main.js', import.meta.url), 'utf8');

/* ── 一、菜单项标记与卡片按钮不能重名 ──
   事件委托里卡片分支写在菜单分支之前，一旦同名，菜单点击会被卡片分支抢走：
   不报错、静默失效（同 web-collector「换图标」踩过的坑）。 */
const menuFn = src.match(/function tabMenuHtml\(\)[\s\S]*?\n  \}/);
assert.ok(menuFn, '必须提供 tabMenuHtml()');
const menuBody = menuFn[0];
for (const [act, label] of [['refresh', '刷新通知'], ['login', '登录配置'], ['edit', '编辑'], ['open', '打开网站'], ['remove', '删除站点']]) {
  // 标签可以是条件表达式（busy 时显示「读取中…」），所以只要求该项里出现该文案
  assert.match(menuBody, new RegExp(`item\\("${act}",[^)]*"${label}"`), `菜单必须有「${label}」项（act=${act}）`);
}
assert.match(menuBody, /data-tab-act="\$\{act\}"/, '菜单项统一用 data-tab-act，不要复用卡片按钮的 data-* 标记');
for (const cardMark of ['data-refresh', 'data-edit-site', 'data-login', 'data-open-site', 'data-remove-site']) {
  assert.doesNotMatch(menuBody, new RegExp(cardMark), `菜单项不能叫 ${cardMark} —— 会与卡片按钮的委托分支撞名`);
}
assert.match(menuBody, /data-tab-menu[^>]*role="menu"/, '菜单容器要有 data-tab-menu 与 role=menu（点别处收起要靠它判断）');

/* ── 二、只对标签页 preventDefault ──
   无差别屏蔽原生右键会让「往输入框里粘贴网址」失效。 */
assert.match(src, /addEventListener\("contextmenu"[\s\S]{0,160}?closest\?\.\("\[data-site\]"\)[\s\S]{0,80}?preventDefault\(\)/,
  'contextmenu 必须先判断命中的是站点标签再 preventDefault');
assert.match(src, /contextmenu[\s\S]{0,200}?if \(!tab\) return;/, '非标签的右键要直接返回，保留原生菜单');

/* ── 三、右键的站点必须变成当前站点 ──
   菜单动作与卡片按钮共用一套实现（都作用于 active()），不切站点就会去操作别的站点。 */
assert.match(src, /async function openTabMenu\(id, x, y\)[\s\S]{0,120}?if \(id !== activeId\) await switchSite\(id\)/,
  'openTabMenu 必须先切到被右键的站点');
assert.match(src, /tabMenu = \{\s*id,[\s\S]{0,160}?window\.innerWidth[\s\S]{0,160}?window\.innerHeight/,
  '菜单坐标要按视口夹紧，否则贴右/下边会被窗口裁掉');
assert.match(src, /const site = active\(\); tabMenu = null;/, '执行动作前先收起菜单');

/* ── 四、菜单要真的渲染进 paint()，且左键点图标要收起它 ── */
assert.match(src, /\$\{tabMenu \? tabMenuHtml\(\) : ""\}/, 'paint() 必须渲染 tabMenuHtml()');
assert.match(src, /const chip = e\.target\.closest\("\[data-site\]"\);\s*if \(chip\) \{\s*tabMenu = null;[\s\S]{0,900}?if \(id !== activeId\) \{ sitePanel = false; return switchSite\(id\); \}/,
  '左键点站点图标要先收起右键菜单，再走「同站点切展开态 / 异站点切站点」的分支');
assert.match(src, /const menuAct = e\.target\.closest\("\[data-tab-act\]"\); if \(menuAct\) return runTabAction\(menuAct\.dataset\.tabAct\);/,
  '菜单项点击要派发到 runTabAction');
assert.match(src, /function closeTabMenu\(\) \{ if \(!tabMenu\) return; tabMenu = null; paint\(\); \}/,
  'closeTabMenu 要幂等（未打开时不重绘）');

/* ── 五、「点别处 / Esc / 滚动」的 document 级监听只绑一次 ──
   宿主元素会随 render 重建，绑在 host 上会丢；绑在 document 上不设闸门会越绑越多。 */
assert.match(src, /if \(!tabMenuDismissBound\) \{[\s\S]{0,700}?addEventListener\("pointerdown"[\s\S]{0,700}?"Escape"[\s\S]{0,300}?addEventListener\("scroll"/,
  'document 上的收起监听（pointerdown / Escape / scroll）必须由 tabMenuDismissBound 闸门包住');
assert.match(src, /closest\("\[data-tab-menu\]"\) \|\| t\.closest\("\[data-site\]"\)/, '点菜单自身或标签页时不该被 pointerdown 提前收起');
assert.match(src, /if \(event\.button === 2\) return;/, '右键另一个标签时不该先收起（交给 contextmenu 重新定位）');

/* ── 六、删除站点：卡片按钮与菜单必须共用同一个实现 ── */
const removeCalls = [...src.matchAll(/removeSite\(site\)/g)].length;
assert.ok(removeCalls >= 3, `removeSite 应被定义 + 卡片 + 菜单三处引用，实际 ${removeCalls}`);
assert.doesNotMatch(src, /if \(e\.target\.closest\("\[data-remove-site\]"\)\) \{ editing = false;/,
  '卡片「删除」不该再内联一份删除逻辑 —— 两处实现迟早走岔');
assert.match(src, /loginDraft\.delete\(site\.id\); lastErrors\.delete\(site\.id\); hiddenUrls = \[\];/,
  '删除站点要连同已填凭据一起清掉');

/* ── 七、站点设置卡片收进菜单图标 ──
   卡片默认收起、点图标才展开。这里守的是「收起态下功能不能丢」：
   公告列表必须照常显示，登录框 / 编辑框被触发时必须自己把卡片摊开。 */
const hit = (needle, why) => assert.ok(src.includes(needle), `${why}（缺：${needle}）`);

hit('<div class="sn-sites"><span class="sn-sites-label">站点</span>', '图标行要有「站点」标签容器');
hit('${sites.map((x) => chipHtml(x, site)).join("")}</div></div>` : ""}</div>${tabMenu',
  '图标行必须在「添加站点」卡片内（卡片闭合 div 之后才是右键菜单）');
assert.doesNotMatch(src, /<div class="sn-tabs">/, '旧的整行文字标签要删掉，否则两处选站点');
assert.doesNotMatch(src, /\.sn-tab\{/, '旧的 .sn-tab 样式是死代码，一并删');

hit('${site ? `${sitePanel ? `<section class="sn-card sn-site">', '站点卡片只在 sitePanel 为真时渲染');
hit('</section>` : ""}<div class="sn-toolbar">',
  '只收 <section> 本身：工具条和公告列表在收起态必须照常渲染');
assert.match(src, /notices = \[\]; sitePanel = false; await loadHidden\(activeId\)/,
  'render() 每次进插件都要收回起态（展开态刻意不落盘）');
assert.match(src, /if \(act === "edit"\) \{ editing = true; sitePanel = true;/,
  '右键「编辑」要先展开卡片 —— 编辑框长在卡片里，收着等于点了没反应');
assert.match(src, /if \(act === "login"\) \{ sitePanel = true; return openLoginConfig\(site\); \}/,
  '右键「登录配置」要先展开卡片，登录框才看得见');
assert.match(src, /sitePanel = true;\s*notices = \[\]; return \{ login: true/,
  '读到登录页要自动展开卡片，否则列表只剩「请先完成登录」却够不着表单');
assert.match(src, /if \(sitePanel\) \{[\s\S]{0,200}?s\.loginUrl = v\.trim\(\); await save\(\); \}/,
  '收起卡片或切换站点前要把没保存的「登录网址」落盘：卡片整块重绘，不收着就凭空丢了');
assert.match(src, /if \(id !== activeId\) \{ sitePanel = false; return switchSite\(id\); \}\s*sitePanel = !sitePanel;/,
  '点异站点只切换并保持设置卡片收起；只有再点当前站点才展开');

hit('favHtml(x, " big") || `<span class="sn-fav big no-img"', '图标三层降级全空时要补首字母方块，别留空位');
hit('data-site="${esc(x.id)}"', 'chip 要保留 data-site：右键菜单和「点别处收起」都靠它判定');
assert.match(src, /\.sn-chip \.sn-chip-name\{display:inline;/,
  '所有站点 chip 都要显示站名，不能让非当前站点只剩难以辨认的图标');
assert.doesNotMatch(src, /\.sn-chip \.sn-chip-name\{display:none\}/,
  '站点名称不能默认隐藏');
assert.match(src, /\.sn-chip\.cur::after\{content:"⌄"/, '收起态的当前 chip 要有向下箭头（可展开的暗示）');
assert.match(src, /\.sn-chip\.on::after\{content:"⌃"/, '展开态的当前 chip 要翻成向上箭头');
assert.match(src, /\.sn-site\{animation:sn-site-in/,
  '展开动画挂在挂载时播放：靠 .sn-site 类，收起时元素不渲染，所以不能用 transition');

/* ── 八、翻页：一次刷新不能只读用户填的那一页 ──
   实测（北京大学本科招生网「通知公告」，2026-09-19 抓取）：一页 8 条、共 46 页，
   分页网址是 index.htm、index1.htm …（页码写在文件名上，第 2 页才是 index1）。
   插件原先只请求一个网址，等于永远只看得到最近 8 条。 */
assert.match(src, /const pager = adapter \? null : buildPager\(res\.body, finalUrl\);/,
  'HTML 列表页才翻页；JSON 适配器读的是站点接口，没有分页器可翻（翻它等于把接口返回当 HTML 解析）');
assert.match(src, /await walkPages\(site, pager, Math\.min\(\.\.\.pager\.read\) \+ 1, PAGE_ROUND - 1\)/,
  '刷新要接着第一页往下读 PAGE_ROUND - 1 页；起点用已读页号而不是写死 2（用户填的可能就是第 3 页）');
assert.match(src, /const \{ total, pages \} = tide\.util\.web\.extractPager\(html, pageUrl\);/,
  '页码表要取自 tide.util.web.extractPager：分页器只印「1…5 + 末页」的窗口，抄字面链接翻不过第 5 页');
assert.match(src, /if \(total <= 1 \|\| pages\.length < 2\) return null;/,
  '认不出分页器就整块不启用，别挂一个「共 1 页」还摆个按不动的按钮');
assert.match(src, /if \(!url \|\| pager\.read\.has\(page\)\) continue;/, '读过的页和没链接的页都不再请求');
assert.match(src, /pager\.read\.add\(page\);[\s\S]{0,300}?catch \{ continue; \}/,
  '页码要**先**记进 read 再发请求：单页失败（超时/4xx）跳过继续往下，既不能让一页把整轮抓取和已到手的条目一起废掉，也不能每轮重试同一页');
assert.match(src, /if \(notices\.length > before\) gained\+\+;/,
  '只有真带来新条目的页才计入本轮页数，否则连着几页重复条目会把这轮白白耗光');
assert.match(src, /\.sort\(\(a, b\) => \(b\.date \|\| ""\)\.localeCompare\(a\.date \|\| ""\)[\s\S]{0,90}?\.slice\(0, MAX_ROWS\)/,
  '多页合并要按网址去重 + 按日期倒序 + 截到缓存上限（被截掉的只能是最旧的）');
assert.match(src, /await walkPages\(site, pager, lastReadPage\(pager\) \+ 1, PAGE_ROUND\)/,
  '「再读 N 页」从上次读到的页号之后接着走');
assert.match(src, /function pagerHtml\(site\)/, '要有 pagerHtml()');
hit('</span>${pagerHtml(site)}${hiddenUrls.length', '分页进度要渲染进工具条（条数后面、恢复已删除前面）');
assert.match(src, /if \(e\.target\.closest\("\[data-more-pages\]"\)\) return loadMorePages\(site\);/,
  '按钮标记必须是 data-more-pages 并派发到 loadMorePages（别复用 data-refresh 之类会被前面的委托分支抢走）');
assert.match(src, /async function loadMorePages\(site\) \{\s*const pager = pagers\.get\(site\.id\);\s*if \(!pager \|\| busy\) return;\s*busy = true; paint\(\);/,
  '翻页要置 busy 并重绘：五页请求要跑好几秒，没有「读取中」用户只当按钮坏了');
assert.match(src, /pagers\.delete\(site\.id\);\s*\n\s*await cacheStore\.set\(`notices:\$\{site\.id\}`, \[\]\);/,
  '改网址要作废分页表：页码网址是按旧目录推出来的，留着会往旧站点的页上翻');
assert.match(src, /hiddenUrls = \[\]; pagers\.delete\(site\.id\);/, '删除站点要一起清掉分页状态');
assert.doesNotMatch(src, /notices\.slice\(0, 100\)|storage\.set\(`notices:\$\{id\}`, notices\)/,
  '缓存条数上限一律走 MAX_ROWS，不要再散落 100 字面量或写出不截断的那份');

/* ── 九、防卡顿：列表从 8 条变上百条之后新增的两处代价 ──
   ① DOM：一次把 100 条全建进 innerHTML，搜索框每敲一个字都要重建整页；
      → 与 rss-reader / cppu-notify 同一套分块渲染（先画一屏，点「显示更多」补）。
   ② 网络：五页串行，单页看门狗 30 秒 → 最坏「处理中…」按分把钟，看着像按钮死了；
      → 一轮翻页有总时限，到点就停并把原因说清，剩下的页留给下一次点击。 */
assert.match(src, /const CHUNK = 20;\s*let rendered = CHUNK;/, '要有分块渲染的块大小与当前渲染条数');
assert.match(src, /total = matched\(\)\.length, shown = rows\.slice\(0, rendered\);/, 'paint() 只渲染前 rendered 条');
assert.match(src, /class="sn-list"\$\{iconStyleAttr\(site\)\}>\$\{shown\.map\(\(n, i\) =>/, '列表 map 必须走 shown，不能回到 rows（那样分块等于没做）');
assert.match(src, /\$\{rows\.length > shown\.length \? `<button class="sn-btn sn-more" data-more-rows>▾ 显示更多（还有 \$\{rows\.length - shown\.length\} 条）<\/button>` : ""\}<\/div>/,
  '「显示更多」要长在列表容器内部，并显示还剩几条');
assert.match(src, /if \(e\.target\.closest\("\[data-more-rows\]"\)\) \{ rendered \+= CHUNK; return paint\(\); \}/,
  '「显示更多」只加渲染条数并重绘，绝不发请求');
assert.doesNotMatch(src, /data-more-pages[^"]*"[^>]*>\s*▾ 显示更多/, '两个按钮标记不能混用：data-more-pages 是翻站点分页（要请求），data-more-rows 只是补渲染');
assert.equal([...src.matchAll(/resetChunk\(\)/g)].length, 4,
  '分块收回首屏只在「列表换了一批内容」的四处：刷新 / 切站点 / 换关键词 / 切筛选（再读 N 页与显示更多刻意不收回）');
assert.match(src, /notices = got\.rows; resetChunk\(\);/, '刷新拿到新列表要收回分块');
assert.match(src, /query = e\.target\.value; resetChunk\(\); paint\(\);/, '搜索换结果集要收回分块（否则每敲一字都在重建已展开的上百条）');
assert.match(src, /const deadline = Date\.now\(\) \+ PAGE_BUDGET;/, '一轮翻页要设总时限');
assert.match(src, /if \(Date\.now\(\) > deadline\) return \{ gained, slow: true \};\s*\n\s*pager\.read\.add\(page\);/,
  '时限必须在**发请求之前**判：写在请求之后等于白等最后一页的 30 秒');
assert.match(src, /if \(slow\) toast\(/, '被时限砍停要说「站点响应太慢」，不能报成「没读到新通知」');
assert.match(src, /else if \(notices\.length >= MAX_ROWS\) toast\(/, '缓存满了也要单独说，否则用户以为翻页坏了');
assert.match(src, /gained < round && page <= pager\.total && notices\.length < MAX_ROWS/, '读满上限后立即停止翻页，不再白请剩下几页');

console.log('PASS: school-notice 站点入口与右键菜单接线（图标收进添加卡片 / 收起态不丢列表 / 菜单标记不撞名 / 先切站点 / 收起闸门 / 删除共用实现）+ 翻页接线（刷新连读多页 / 单页失败不中断 / 读过的页不重复请求 / 合并去重截断 / 分页进度上工具条 / 状态随站点清理）+ 防卡顿（分块渲染与四处收回 / 两个「更多」按钮不混用 / 翻页总时限在请求前判 / 慢站与缓存满分开提示）');
