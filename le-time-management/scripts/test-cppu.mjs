import { readProductSource } from "./lib/read-product-source.mjs";
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { bannerPalettes, channelDelta, colorMix, contrastRatio, mixHex, resolveToken, ruleDecls } from './lib/banner-contrast.mjs';
const source = readProductSource(new URL('../public/plugins/cppu-notify/main.js',import.meta.url),'utf8');
let response, calls=[], vaultData={}, storageData={}, opened=[], notices=[], noticeOpts=[], revealed=[], views=[], saved=[];
/* 邮箱 XML 走 DOMParser。vm 上下文里没有 DOM，这里只实现插件真用到的那点表面：
   tagName / attributes / children / textContent —— 够跑 mailXmlTree 的名字映射。 */
const XML_ENT = { quot: '"', lt: '<', gt: '>', amp: '&', apos: "'" };
const xmlDecode = (s) => s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return XML_ENT[e] ?? m;
});
class XEl {
  constructor(tag) { this.tagName = tag; this.attributes = []; this.children = []; this.text = ''; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  querySelector() { return null; }
}
class MiniDOMParser {
  parseFromString(text) {
    const root = new XEl('#doc');
    const stack = [root];
    const re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
      if (m[2]) {
        const el = new XEl(m[2]);
        const ar = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
        let a;
        while ((a = ar.exec(m[3] || ''))) el.attributes.push({ name: a[1], value: xmlDecode(a[3] ?? a[4] ?? '') });
        stack[stack.length - 1].children.push(el);
        if (!m[4]) stack.push(el);
        continue;
      }
      if (m[5] && m[5].trim()) stack[stack.length - 1].text += xmlDecode(m[5]);
    }
    return { documentElement: root.children[0], querySelector: () => null };
  }
}
const context = vm.createContext({URL,Set,Map,Date,console,setTimeout,clearTimeout,setInterval,clearInterval,
  crypto: globalThis.crypto, btoa: globalThis.btoa, TextEncoder, URLSearchParams, DOMParser: MiniDOMParser,
  document:{createElement:()=>({set innerHTML(x){this.value=x;}}),querySelectorAll:()=>[]},
  // 解码不了的验证码图 = OCR 认不出来，用来把「换图重试」循环逼到次数上限
  Image:class{constructor(){this.naturalWidth=0;this.naturalHeight=0;}set src(v){this._src=v;}decode(){return Promise.reject(new Error('cannot decode'));}},
  tide:{ui:{registerView:(def)=>{views.push(def);}},http:{session:async()=>'s1',restoreCookies:async(dump)=>{calls.push(['restore',dump]);return 'restored-sid';},fetch:async(...args)=>{calls.push(args);return typeof response==='function'?response(...args):response;}},storage:{set:async(k,v)=>{storageData[k]=v;},get:async(k,d)=>(k in storageData?storageData[k]:(d===undefined?null:d))},vault:{get:async(key)=>vaultData[key]||null,set:async(key,value)=>{vaultData[key]=value;},del:async(key)=>{delete vaultData[key];}},util:{openUrl:(url)=>opened.push(url),openMailPage:(url,sid)=>opened.push(['mailPage',url,sid||'']),web:{formEncode:(fields)=>Object.entries(fields).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),detectLoginForm:(html,base)=>html.includes('name="uid"')?{action:new URL('/coremail/index.jsp?cus=1',base).href,method:'POST',usernameField:'uid',passwordField:'password',captchaField:'',fields:[{name:'action',value:'login'}]}:null}},notify:(message,opts)=>{notices.push(message);noticeOpts.push(opts||{});},assets:{saveBase64:async(name,b64)=>{saved.push([name,b64]);return 'D:/Downloads/'+name;},revealSaved:async(p)=>{revealed.push(p);return {ok:true};}}}
});
vm.runInContext(source.replace('  tide.ui.registerView({','  globalThis.testApi = {state,cardHtml,loadDetail,loadPage,newSession,cleanText,noticeKind,extractAttachments,downloadAttachment,OCR,restoreCookies,silentRenew,submitLogin,finishPortalLogin,openSideLink,openMailWeb,jeLoad,explainHttpError,ensureJwSession,ensureJwLogin,jwLive,jwDict,jwTermName,clearSavedLogin,jwState,jwHoursRest,jwTaskStatus,jwTaskDetailHtml,jwTaskHtml,jwResultHtml,jwLeaveHtml,jwGradeDone,jwAcademicCreditHtml,jwGradesHtml,pdataRankCard,pdataRadarCard,pdataRadarSvg,jwExportGrades,gradeGpa,gradeSemLabel,jwInnovationCreditHtml,cardState,filtered,cardIsRecharge,cardNormalizeBill,cardTotals,cardStatsHtml,cardBalanceFromDetail,cardFetchBalance,cardFetchBills,jwStateBlock,mountJwView,JW_VIEWS,cardIsExpense,bannerRefreshHtml,cardSetStatus,mailBridge,mailRsaEscape,mailXmlTree,warmSession,scheduleWarm};\n  tide.ui.registerView({'),context);
const {state,cardHtml,loadDetail,loadPage,newSession,cleanText,noticeKind,extractAttachments,downloadAttachment,OCR,restoreCookies,silentRenew,submitLogin,finishPortalLogin,openSideLink,openMailWeb,jeLoad,explainHttpError,ensureJwSession,ensureJwLogin,jwLive,jwDict,jwTermName,clearSavedLogin,jwState,jwHoursRest,jwTaskStatus,jwTaskDetailHtml,jwTaskHtml,jwResultHtml,jwLeaveHtml,jwGradeDone,jwAcademicCreditHtml,jwGradesHtml,pdataRankCard,pdataRadarCard,pdataRadarSvg,jwExportGrades,gradeGpa,gradeSemLabel,jwInnovationCreditHtml,cardState,filtered,cardIsRecharge,cardNormalizeBill,cardTotals,cardStatsHtml,cardBalanceFromDetail,cardFetchBalance,cardFetchBills,cardIsExpense,jwStateBlock,mountJwView,JW_VIEWS,bannerRefreshHtml,cardSetStatus,mailBridge,mailRsaEscape,mailXmlTree,warmSession,scheduleWarm}=context.testApi;
const item={RESOURCE_ID:'test',PIM_TITLE:'Test <notice>',CREATE_TIME:1};
assert.match(cardHtml(item),/展开正文/);
assert.match(cardHtml(item),/class="pp-detail-shell" aria-hidden="true"/);
assert.doesNotMatch(cardHtml(item),/class="pp-card open"/);
state.expanded.add('test');
assert.match(cardHtml(item),/aria-expanded="true"/);
assert.match(cardHtml(item),/正在加载正文/);
let release;
response=(sid,method,url)=>url.endsWith('getPimAffixList') ? {status:200,body:'[]'} : new Promise(resolve=>{release=resolve;});
const pending=loadDetail('test');
state.expanded.delete('test');
release({status:200,body:JSON.stringify([{PIM_CONTENT:'First<br><br>Second'}])});
await pending;
assert.match(cardHtml(item),/class="pp-detail-shell" aria-hidden="true"/,'Late response must keep collapsed card closed');
assert.doesNotMatch(cardHtml(item),/class="pp-card open"/,'Late response must not reopen collapsed card');
state.expanded.add('test');
assert.match(cardHtml(item),/First\n\nSecond/);
const count=calls.length;
await loadDetail('test');
assert.equal(calls.length,count,'Reopen uses cached content');
assert.match(calls[0][2],/\/tp_up\/up\/pim\/showpim\//);
assert.equal(cleanText('First<br><br>Second'),'First\n\nSecond');
state.details.test={error:'network unavailable'};
assert.match(cardHtml(item),/重试加载正文/);
assert.equal(noticeKind({PIM_TITLE:'英语四六级考试报名通知'}).id,'exam');
assert.equal(noticeKind({PIM_TITLE:'第九届 精武杯 技能比武科目新增禁毒知识竞赛等4项实施方案'}).id,'contest');
assert.equal(noticeKind({PIM_TITLE:'关于图书馆开放时间调整的通知'}).id,'notice');
assert.ok(source.includes('data-kinds'), '警大通知必须提供考试/比赛/通知分类筛选栏');
// v0.159.0 筛选修复：年份粒度；「恢复默认」整体重置（含关键词）；空态可加载更早；点外部收起下拉
assert.ok(source.includes('data-years'), '筛选面板必须提供年份行');
assert.ok(source.includes('data-filter-reset') && source.includes('恢复默认筛选'), '筛选面板必须提供「恢复默认筛选」整体重置');
assert.ok(/filter:\s*\{\s*kw: "", year: "all"/.test(source), '默认筛选必须含 year 维度，重置时关键词才会被整体清掉');
assert.ok(source.includes('document.addEventListener("pointerdown"'), '筛选下拉必须支持点击外部收起');
assert.ok(source.includes('loadOlderUntilMatch'), '筛选结果为空时必须能继续加载更早的通知');
state.notices = [
  { RESOURCE_ID: 'y26', PIM_TITLE: '2026年9月通知', CREATE_TIME: new Date('2026-09-01T08:00:00').getTime() },
  { RESOURCE_ID: 'y25', PIM_TITLE: '2025年4月通知', CREATE_TIME: new Date('2025-04-01T08:00:00').getTime() },
  { RESOURCE_ID: 'yNA', PIM_TITLE: '无时间通知', CREATE_TIME: 0 },
];
state.filter = { kw: '', year: 'all', month: 'all', kind: 'all', hideSeen: false };
assert.equal(filtered().length, 3, '默认筛选应显示全部（含时间未知项）');
state.filter.year = '2025';
assert.equal(filtered().length, 1, '年份筛选只留该年，时间未知项不冒充任何年份');
state.filter = { kw: '不存在的词', year: 'all', month: 'all', kind: 'all', hideSeen: false };
assert.equal(filtered().length, 0, '关键词无匹配时显示 0 条 —— 必须有恢复默认的出路');
state.filter = { kw: '', year: 'all', month: 'all', kind: 'all', hideSeen: false };
const foundAttachments=extractAttachments({ATTACHMENTS:[{FILE_NAME:'实施方案.pdf',FILE_URL:'/tp_up/up/pim/file/download?id=1'}]}, '');
assert.equal(foundAttachments.length,1);
assert.equal(foundAttachments[0].name,'实施方案.pdf');
assert.match(foundAttachments[0].url,/portal-jw\.cppu\.edu\.cn\/tp_up\/up\/pim\/file\/download/);
const affixJson = extractAttachments({AFFIX: JSON.stringify([{FILE_NAME:'参赛名单.xlsx',FILE_URL:'uploadfiles/2026/list.xlsx?id=2&amp;part=1'}])}, '附件：参赛名单');
assert.equal(affixJson.length,1,'详情 AFFIX 的 JSON 字符串应识别为附件');
assert.equal(affixJson[0].name,'参赛名单.xlsx');
assert.match(affixJson[0].url,/list\.xlsx\?id=2&part=1/);
const affixFields = extractAttachments({AFFIX_NAME:'报名表.docx',AFFIX_PATH:'/tp_up/uploadfiles/form.docx'}, '');
assert.equal(affixFields.length,1,'详情 AFFIX_NAME / AFFIX_PATH 应识别为附件');
assert.equal(extractAttachments({}, '附件：只有文件名、没有下载地址').length,0,'纯文字不能伪装成可下载附件');
state.details={};state.expanded.add('attach');calls=[];
response={status:200,body:JSON.stringify([{PIM_CONTENT:'',ATTACHMENTS:[{FILE_NAME:'实施方案.pdf',FILE_URL:'/tp_up/up/pim/file/download?id=1'}]}])};
await loadDetail('attach');
const attachmentItem={RESOURCE_ID:'attach',PIM_TITLE:'附件通知',CREATE_TIME:1};
assert.match(cardHtml(attachmentItem),/附件 1/);
assert.match(cardHtml(attachmentItem),/实施方案\.pdf/);
assert.match(cardHtml(attachmentItem),/下载附件/);
assert.match(cardHtml(attachmentItem),/class="pp-att" data-attach-download="0"/,'点击附件整行应直接触发下载');
const attachmentCalls=calls.length;
await loadDetail('attach');
assert.equal(calls.length,attachmentCalls,'Only-attachment detail should also use cached detail');
// 真实门户格式：正文 JSONP 为空，4 个文件仅存在于独立附件接口。
state.token='test-token';state.details.real={content:'',attachments:[]};calls=[];
const portalAffixes=Array.from({length:4},(_,i)=>({AFFIX_NAME:`uploadfiles/pim/2026/方案${i}.docx`,OTHER_NAME:`实施方案${i}.docx`}));
response=(sid,method,url)=>url.endsWith('getPimAffixList')
  ? {status:200,body:JSON.stringify(portalAffixes)}
  : url.includes('uploadfiles/json/') ? {status:200,body:'jsonp_123({"result":"<p><br></p>"})'}
  : {status:200,body:JSON.stringify([{CONTENT_URL:'/tp_up/uploadfiles/json/example.json',PIM_CONTENT:null}])};
await loadDetail('real');
assert.equal(state.details.real.attachments.length,4,'旧空详情缓存必须刷新并加载独立接口全部附件');
assert.equal(state.details.real.attachments[0].name,'实施方案0.docx');
assert.match(state.details.real.attachments[0].url,/\/tp_up\/uploadfiles\/pim\//);
assert.ok(calls.some(c=>c[2].endsWith('/tp_up/uploadfiles/json/example.json')),'正文路径不能重复 tp_up');
assert.match(cardHtml({RESOURCE_ID:'real'}),/本通知内容在附件中/);
const loadedCalls=calls.length;await loadDetail('real');assert.equal(calls.length,loadedCalls);
// 正文失败不能吃掉附件；附件失败不能吃掉正文，而且必须能重试。
state.details.partial={};
response=(sid,method,url)=>url.endsWith('getPimAffixList') ? {status:200,body:JSON.stringify(portalAffixes)}
  : url.includes('uploadfiles/json/') ? {status:503,body:''}
  : {status:200,body:JSON.stringify([{CONTENT_URL:'uploadfiles/json/example.json',PIM_CONTENT:'备用正文'}])};
await loadDetail('partial');
assert.equal(state.details.partial.content,'备用正文');
assert.equal(state.details.partial.attachments.length,4);
assert.match(cardHtml({RESOURCE_ID:'partial'}),/重试加载正文和附件/);
response=(sid,method,url)=>url.endsWith('getPimAffixList') ? {status:503,body:''} : {status:200,body:'[{"PIM_CONTENT":"完整正文"}]'};
await loadDetail('partial',true);
assert.equal(state.details.partial.content,'完整正文');
assert.match(state.details.partial.attachmentError,/503/);
response=(sid,method,url)=>url.endsWith('getPimAffixList') ? {status:200,body:'[]'} : {status:200,body:'[{"PIM_CONTENT":"完整正文"}]'};
await loadDetail('partial');assert.equal(state.details.partial.detailVersion,2);
response={status:500,body:''};opened=[];notices=[];saved=[];
await downloadAttachment(foundAttachments[0]);
assert.equal(opened.length,0,'附件下载不得退回打开原链接');
assert.equal(saved.length,0);
assert.match(notices.at(-1),/下载失败/);
/* 点击即落盘：抓到的 base64 交给宿主写进系统下载目录，toast 回报完整路径。 */
response={status:200,body:'U1ZL',contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
await downloadAttachment(foundAttachments[0]);
assert.deepEqual(saved,[['实施方案.pdf','U1ZL']]);
assert.match(notices.at(-1),/已保存到下载目录.*实施方案\.pdf/);
/* 「点通知卡片跳到下载目录」：落盘横幅必须整卡可点，且点下去定位的就是刚落盘那条路径。
   少了这条断言，横幅退化成纯文字提示也没人会红。 */
const savedNotice = noticeOpts.at(-1);
assert.equal(typeof savedNotice.onClick,'function','下载完成的通知卡片必须整卡可点（onClick）');
assert.equal(savedNotice.onClickHint,'点击定位文件','整卡可点必须明说点下去会发生什么');
savedNotice.onClick();
await Promise.resolve();
assert.deepEqual(revealed,['D:/Downloads/实施方案.pdf'],'点击卡片必须定位到刚落盘的那个文件');
/* 定位失败（Android 没有「在文件夹里选中文件」）不能静默：要退回把路径摊开给用户。 */
revealed=[];
const failing = {revealSaved:async()=>{throw new Error('当前平台不支持在文件管理器中定位文件');}};
const originalReveal = context.tide.assets.revealSaved;
context.tide.assets.revealSaved = failing.revealSaved;
notices=[];
savedNotice.onClick();
await new Promise((resolve)=>setImmediate(resolve));
assert.match(notices.at(-1),/请手动到下载目录查看.*实施方案\.pdf/,'定位失败时必须把路径再摊开一次，不能点了没反应');
context.tide.assets.revealSaved = originalReveal;
/* 门户票据过期时下载链接会 200 返回登录页，必须拦下，否则会存下一个打不开的"附件"。 */
response={status:200,body:'PGh0bWw+',contentType:'text/html;charset=UTF-8'};
saved=[];notices=[];
await downloadAttachment(foundAttachments[0]);
assert.equal(saved.length,0,'HTML 响应不能落盘成附件');
assert.match(notices.at(-1),/会话已过期/);
response={status:200,body:'{"list":[]}'};
await loadPage(1);
assert.match(calls.at(-1)[2],/\/tp_up\/up\/pim\/allpim\//);
state.token='test-token';calls=[];
response=(sid,method,url)=>url.includes('allpim')?{status:503,body:''}:{status:200,body:'',finalUrl:'https://portal-jw.cppu.edu.cn/tp_up/view;tp_up=renewed?m=up'};
await loadPage(1);
assert.equal(calls.filter(c=>c[2].includes('allpim')).length,2,'Only one renewal retry');
assert.equal(state.fetching,false);
await newSession();const sid=state.sid;await newSession();assert.equal(state.sid,sid);
assert.ok(source.includes('if (!e.target.closest("[data-toggle]")) return;'),'Selecting body text must not collapse');

// 重启后应同时恢复 Cookie Jar 与门户 tp_up，优先复用现成门户会话。
state.sid=null;state.token='';calls=[];
vaultData.cookies=JSON.stringify([{url:'https://portal-jw.cppu.edu.cn',cookie:'CASTGC=tgt; tp_up=saved-token; theme=light'}]);
assert.equal(await restoreCookies(),true);
assert.equal(state.sid,'restored-sid');
assert.equal(state.token,'saved-token');
assert.equal(calls[0][0],'restore');
// v0.245.0 起这一支里多了「记上次自动登录时间」的记账（markLoginAt），v0.247.0 起首屏可能
// 已用本地缓存画过（paintAfterLoad），断言只锁「先验票据、验过才把界面刷出来」这条顺序，
// 不再按整行字面量匹配。
assert.match(source, /if \(await loadPage\(1\)\) \{[^}]*(buildMain|paintAfterLoad)\(el\); return true; \}/, '恢复的门户票据必须先验证，失效后继续走密码兜底');
assert.ok(!source.includes('if (state.token) { buildMain(el); return; }'), '每次重新进入插件都必须验证内存票据，不能直接信任旧 token');

// 只有主 SSO CASTGC 可用时，应逐段走完主 SSO → bridge → sso-jw → portal。
state.token='';calls=[];let renewStep=0;
response=()=>{
  renewStep++;
  if(renewStep===1) return {status:200,body:'<html>sso-jw login</html>',finalUrl:'https://sso-jw.cppu.edu.cn/tpass/login',location:'',cookies:[]};
  if(renewStep===2) return {status:302,body:'',finalUrl:'https://sso.cppu.edu.cn/tpass/login',location:'https://sso-jw.cppu.edu.cn/tpass/bridge?ticket=ST-main',cookies:[]};
  if(renewStep===3) return {status:200,body:'bridge ok',finalUrl:'https://sso-jw.cppu.edu.cn/tpass/bridge?ticket=ST-main',location:'',cookies:['CASTGC=TGT']};
  if(renewStep===4) return {status:302,body:'',finalUrl:'https://sso-jw.cppu.edu.cn/tpass/login',location:'https://portal-jw.cppu.edu.cn/tp_up/view?ticket=ST-portal',cookies:[]};
  return {status:302,body:'',finalUrl:'https://portal-jw.cppu.edu.cn/tp_up/view?ticket=ST-portal',location:'/tp_up/view;tp_up=bridge-token?m=up',cookies:['tp_up=bridge-token; Path=/tp_up']};
};
assert.equal(await silentRenew(),true);
assert.equal(state.token,'bridge-token');
assert.equal(calls.length,5,'主 SSO 票据恢复必须显式补走完整 bridge 换票链路');
assert.ok(calls.every(c=>c[3].followRedirects===false),'静默续期每段都必须禁止自动重定向');

// 密码登录必须禁止自动重定向，并按原 skill 的四段链路逐个消费一次性 ticket。
state.sid='sso-test';state.token='';calls=[];state.pending={username:'student',password:'secret',execution:'exec-1'};
response=(sid,method,url,opts)=>{
  if(method==='POST') return {status:302,body:'',finalUrl:url,location:'https://sso-jw.cppu.edu.cn/tpass/bridge?ticket=ST-1',cookies:[]};
  if(url.includes('/tpass/bridge?ticket=')) return {status:200,body:'bridge ok',finalUrl:url,location:'',cookies:['CASTGC=TGT']};
  if(url.includes('sso-jw.cppu.edu.cn/tpass/login')) return {status:302,body:'',finalUrl:url,location:'https://portal-jw.cppu.edu.cn/tp_up/view?ticket=ST-2',cookies:[]};
  return {status:302,body:'',finalUrl:url,location:'/tp_up/view;tp_up=portal-token?m=up',cookies:['tp_up=portal-token; Path=/tp_up']};
};
await submitLogin('1234');
assert.equal(state.token,'portal-token');
assert.equal(calls.length,4,'密码登录应显式完成主 SSO、bridge、门户换票和门户落票四段请求');
assert.equal(calls[0][1],'POST');
assert.equal(calls[0][3].followRedirects,false,'登录 POST 禁止自动跨域重定向');
assert.ok(calls.slice(1).every(c=>c[3].followRedirects===false),'一次性 ticket 的每段 GET 都禁止自动重定向');

/* ── 8. 自动登录：加密凭据、会话恢复、验证码识别重试链路 ── */
assert.ok(source.includes('tide.vault'), '插件必须通过 tide.vault 存取加密凭据');
assert.ok(source.includes('exportCookies') && source.includes('restoreCookies'), '登录态必须能导出/恢复以跨重启');
assert.ok(source.includes('runLoginAttempts') && source.includes('cleanLoginRetries'), '验证码识别失败必须走可配置的统一重试流程（行为覆盖见 test-cppu-campus）');
assert.ok(source.includes('验证码自动识别 ✓'), '登录界面自动登录状态必须如实展示');

/* ── 8b. 启动预热（v0.272.7）：真的被调用、手机上回到前台也续期、失败短退避 ──
   v0.246.0 写好了 warmSession / scheduleWarm 却**没有任何调用点**，预热一次都没跑过，
   于是「5 天没开就必弹验证码」这个原始问题从未被修掉。下面四条源码断言守调用点，
   五条行为断言（真跑 warmSession）守闸门与退避。 */
assert.match(source, /\bscheduleMailWatch\(\);\s*(?:\r?\n[^\n]*){0,4}?scheduleWarm\(\);/,
  '启动预热必须有调用点（warmSession 之前是纯死代码）');
assert.ok(source.includes('visibilitychange') && source.includes('__cppuWarmKick'),
  'APK 后台会冻结定时器，回到前台必须补一次续期（可见性监听）');
assert.ok(source.includes('WARM_RETRY_MS') && source.includes('autoWarmFailAt'),
  '预热失败必须短退避（30 分钟）而不是按 12 小时压着，否则白天断一次网就整天不续期');
assert.ok(!/warmBusy \|\| loginBusy \|\| state\.sid \|\| state\.viewOpen/.test(source),
  '内存里已有会话不能当作拒绝预热的理由 —— state.sid 整个运行期不清，那样用过一次插件就再也不预热');

// 没 window 的沙箱（测试 / 极早期加载）不发请求也不排程。
assert.equal(await warmSession(), false, '没有 window 的环境必须直接放弃预热');
// 行为：真跑一次成功续期 → 记成功时间、清掉失败退避
context.window = { setTimeout() {}, setInterval() {}, addEventListener() {} };
storageData.username = '20230001';
storageData.autoLogin = true;
storageData.autoWarmAt = 0;
storageData.autoWarmFailAt = 0;
vaultData.secret = JSON.stringify({ password: 'pw' });
vaultData.cookies = JSON.stringify([{ url: 'https://sso.cppu.edu.cn', cookie: 'CASTGC=tgt' }]);
state.sid = null; state.token = ''; state.viewOpen = 0; calls = [];
response = () => ({ status: 200, body: '', finalUrl: 'https://portal-jw.cppu.edu.cn/tp_up/view;tp_up=warm-token?m=up' });
assert.equal(await warmSession(), true, '有授权 + 有票据时预热必须真的把票据续期');
assert.equal(state.token, 'warm-token');
assert.equal(calls[0][0], 'restore', '内存里没有会话时预热要从密钥库恢复票据');
assert.ok(storageData.autoWarmAt > 0, '续期成功必须记下时间，给 12 小时频控用');
assert.equal(storageData.autoWarmFailAt, 0, '成功必须清掉失败退避，否则下一次会被旧时间挡住');
// 行为：频控内不再发请求
calls = [];
assert.equal(await warmSession(), false, '12 小时内不重复续期');
assert.equal(calls.length, 0, '频控命中时一个请求都不该发');
// 行为：内存里已有会话时直接用它续期，不另建会话；失败走短退避
storageData.autoWarmAt = 0; storageData.autoWarmFailAt = 0;
state.sid = 'live-sid'; state.token = ''; calls = [];
response = () => ({ status: 200, body: '<html>login</html>', finalUrl: 'https://sso-jw.cppu.edu.cn/tpass/login', location: '', cookies: [] });
assert.equal(await warmSession(), false, '票据失效时预热必须如实失败');
assert.ok(!calls.some((c) => c[0] === 'restore'), '已有会话时不能 restore 一个新会话把它盖掉');
assert.equal(state.sid, 'live-sid', '预热不许把正在用的会话换掉');
assert.equal(storageData.autoWarmAt, 0, '失败不能写成功时间');
assert.ok(storageData.autoWarmFailAt > 0, '失败必须写退避时间');
calls = [];
assert.equal(await warmSession(), false, '退避期内不再重试');
assert.equal(calls.length, 0, '退避命中时一个请求都不该发');
// 行为：有视图占着会话时预热让路
storageData.autoWarmAt = 0; storageData.autoWarmFailAt = 0; calls = [];
state.viewOpen = 1;
assert.equal(await warmSession(), false, '前台视图占着会话时预热必须让路');
assert.equal(calls.length, 0, '视图开着时预热不许发请求');
// 收尾：别把这些夹具漏给后面的用例
state.viewOpen = 0; state.sid = null; state.token = ''; state.username = '';
storageData.autoWarmAt = 0; storageData.autoWarmFailAt = 0;
delete storageData.username; delete storageData.autoLogin;
delete vaultData.secret; delete vaultData.cookies;
delete context.window;
const cppuManifest = JSON.parse(readProductSource(new URL('../public/plugins/cppu-notify/manifest.json', import.meta.url), 'utf8'));
/* 不钉死具体版本号：插件每次改动都要升版本，钉死了就变成「升一次改两处」。
   这里只守格式（三段式），catalog 与 manifest 的一致性由下面那条比。 */
assert.match(cppuManifest.version, /^\d+\.\d+\.\d+$/, '插件版本号必须是三段式 X.Y.Z');
assert.ok((cppuManifest.permissions || []).includes('vault'), 'manifest 必须声明 vault 权限才能用密钥库');
assert.ok((cppuManifest.permissions || []).includes('openUrl'), 'manifest 必须声明 openUrl 权限才能打开校园服务链接');
const catalogSrc = readProductSource(new URL('../src/pluginCatalog.js', import.meta.url), 'utf8');
const cppuEntry = catalogSrc.slice(catalogSrc.indexOf('"id": "cppu-notify"'));
const cppuBlock = cppuEntry.slice(0, cppuEntry.indexOf('},\n  {'));
/* 版本号只写一处：拿 manifest 的实际版本去比，避免升版本时要改两个地方 */
assert.ok(cppuBlock.includes(`"${cppuManifest.version}"`), `pluginCatalog 必须同步插件版本号（应为 ${cppuManifest.version}）`);
assert.match(cppuBlock, /"vault"/, 'pluginCatalog 必须同步 vault 权限');
assert.match(cppuBlock, /"openUrl"/, 'pluginCatalog 必须同步 openUrl 权限');

assert.doesNotMatch(source, /view: "cppu-webvpn"/, "已移除 WebVPN 插件入口");

/* ── 左侧校园服务栏：十个入口（含一网通办、一卡通、我的请假）+ 标题/图标自动识别 ── */
for (const url of ['https://mail.cppu.edu.cn/', 'https://jw.cppu.edu.cn/index.html', 'https://xg.cppu.edu.cn/XGPhone/Phone/index.html', 'https://xg.cppu.edu.cn/XGPhone/Phone/index.html#/StuDailyLeaveList', 'https://service.cppu.edu.cn/fe/site/service']) {
  assert.ok(source.includes(url), `校园服务栏必须包含 ${url}`);
}
assert.match(source, /\{\s*view:\s*"cppu-card"[^}]*label:\s*"一卡通"[^}]*icon:\s*"credit-card"/,
  '一卡通入口必须是 U-Time 内部视图，不能直接撞受保护充值深链');
assert.ok(source.includes('const CARD_BILLING = CARD_ORIGIN + "/campus-card/billing/list?name=billList&appId=24&loginFrom=h5&type=app"'),
  '一卡通视图必须使用平台账单地址');
assert.ok(source.includes('const CARD_RECHARGE = CARD_ORIGIN + "/campus-card/cardRecharge?name=cardRecharge&appId=2&loginFrom=h5&type=app"'),
  '一卡通充值深链只能作为应用内视图按钮的目标保留');
assert.ok(source.includes('CARD_AUTH_URL') && source.includes('/berserker-auth/oauth/token'), '一卡通必须通过平台 OAuth 自动登录');
assert.ok(source.includes('CARD_BILLS_URL') && source.includes('/berserker-search/search/personal/turnover'), '一卡通充值统计必须读取平台账单接口');
assert.ok(source.includes('CARD_LIST_URL') && source.includes('/berserker-app/ykt/tsm/getCampusCards'), '一卡通余额同步必须先读取校园卡账户');
assert.ok(source.includes('CARD_DETAIL_URL') && source.includes('/berserker-app/ykt/tsm/queryCard'), '一卡通余额必须通过平台实时查询接口获取');
assert.ok(source.includes('CARD_VAULT_KEY = "cardSecret"') && source.includes('tide.vault.set(CARD_VAULT_KEY'), '一卡通账号密码必须保存到加密密钥库');
assert.ok(source.includes('CARD_CACHE_KEY = "cardRechargeCache"'), '一卡通平台账单必须支持本地只读缓存');
assert.ok(source.includes('总充值量') && source.includes('按年份 / 月份 / 日期'), '一卡通视图必须显示总充值量，并说明可按年/月/日汇总');
assert.ok(source.includes('已花费'), '一卡通视图必须显示已花费金额');
assert.ok(source.includes('accinfo'), '一卡通余额必须合并电子账户（本校 ecardConfig 为 type=1，主账户 db_balance 恒为 0）');
assert.ok(source.includes('current=${current}&type=${type}'), '账单流水必须按平台的方向参数分别取入账与支出，不能混在一趟翻页里');
assert.ok(source.includes('year: "按年"') && source.includes('month: "按月"') && source.includes('day: "按日"'),
  '一卡通充值统计必须支持按年、按月、按日三种模式');
assert.ok(source.includes('data-card-login'), '一卡通视图必须支持在视图内登录');
assert.ok(source.includes('if(cardState.username&&cardState.password)return sync();'), '一卡通进入视图时必须自动同步平台账单');
assert.ok(!source.includes('data-card-add') && !source.includes('data-card-del'), '一卡通统计不得再让用户手工新增或删除充值记录');
assert.equal(cardIsRecharge({typeFrom:'1',resume:'校园卡充值'}), true, '平台入账中的充值应被识别');
assert.equal(cardIsRecharge({typeFrom:'1',resume:'微信支付转账',turnoverType:'充值'}), true, '平台真实的微信转账充值不得被误排除');
assert.equal(cardIsRecharge({typeFrom:'0',resume:'食堂消费'}), false, '消费流水不得计入充值量');
assert.equal(cardIsRecharge({typeFrom:'1',resume:'助学金补助'}), false, '补助入账不得误算成充值');
const normalizedBill=cardNormalizeBill({orderId:'bill-1',effectdateStr:'2026-09-22 08:30:00',tranamt:12345,resume:'校园卡充值'});
assert.deepEqual({...normalizedBill},{id:'bill-1',date:'2026-09-22',amount:123.45,note:'校园卡充值',merchant:'',kind:'in',at:Date.parse('2026-09-22 08:30:00')});
assert.equal(cardNormalizeBill({orderId:'bill-9',effectdateStr:'2026-09-21 12:00:00',tranamt:1250,resume:'食堂消费'},'out').kind,'out','支出流水必须打上消费方向');
cardState.rows=[normalizedBill,{...normalizedBill,id:'bill-2',date:'2026-08-01',amount:50},{id:'pay-1',date:'2026-09-20',amount:30,note:'食堂消费',kind:'out',at:0},{id:'pay-2',date:'2026-08-05',amount:7.5,note:'超市消费',kind:'out',at:0}];
cardState.mode='month';
assert.equal(cardTotals().total,173.45,'平台充值流水必须正确汇总总充值量');
assert.equal(cardTotals().spent,37.5,'平台支出流水必须正确汇总已花费');
assert.deepEqual([cardTotals().inCount,cardTotals().outCount],[2,2],'充值与消费的笔数必须分开统计');
assert.equal(cardTotals().items.every((it)=>it.amount>0&&/^\d{4}-\d{2}$/.test(it.key)),true,'消费/充值统计的分桶只能来自流水日期');
cardState.kind='out';
assert.equal(cardTotals().items.reduce((s,it)=>s+it.amount,0),37.5,'切到消费维度后统计必须只汇总消费');
cardState.kind='in';
assert.equal(cardBalanceFromDetail({db_balance:1234,unsettle_amount:66}),13,'当前余额必须按平台分值换算并包含未结算金额');
assert.equal(cardBalanceFromDetail({db_balance:0,unsettle_amount:0,accinfo:[{name:'普通账户',balance:1234},{name:'补贴账户',balance:66}]}),13,
  '本校一卡通主账户恒为 0，余额必须把电子账户 accinfo 算进来');
assert.equal(cardBalanceFromDetail([{db_balance:100,accinfo:[{balance:50}]},{db_balance:250}]),4,
  '名下多张卡的余额必须逐张相加');
assert.throws(()=>cardBalanceFromDetail({db_balance:'bad'}),/余额数据格式异常/,'坏余额数据不得显示为 0 元');
assert.throws(()=>cardBalanceFromDetail({db_balance:0,accinfo:[{balance:'bad'}]}),/电子账户余额数据格式异常/,'坏电子账户数据不得静默算成 0');
calls=[];cardState.sid=null;cardState.accessToken='card-token';cardState.tokenType='bearer';let balanceStep=0;
response=()=>++balanceStep===1
  /* 卡列表回 accinfo、queryCard 不回 —— 余额仍须读到电子账户里的钱 */
  ? {status:200,body:JSON.stringify({code:200,data:{card:[{account:'card-account',lostflag:0,db_balance:0,accinfo:[{name:'普通账户',balance:1234}]}]}})}
  : {status:200,body:JSON.stringify({code:200,data:{retcode:'0',card:[{account:'card-account',db_balance:0,unsettle_amount:66}]}})};
assert.equal(await cardFetchBalance(),13,'余额接口两段调用必须返回实时余额');
assert.match(calls[0][2],/getCampusCards$/);
assert.match(calls[1][2],/queryCard\?account=card-account$/);
assert.equal(calls[1][3].headers['synjones-auth'],'bearer card-token','余额请求必须携带一卡通令牌');
/* 账单必须按平台方向参数各查一趟：type=1 入账、type=2 支出 */
assert.equal(cardIsExpense({typeFrom:'0'}),true,'平台标记为非入账的流水即消费');
assert.equal(cardIsExpense({typeFrom:0}),true,'方向字段是数字时也要认得');
assert.equal(cardIsExpense({typeFrom:'1'}),false,'入账不得记成消费');
assert.equal(cardIsExpense({resume:'食堂消费'}),false,'方向缺失时不得猜成消费');
calls=[];cardState.sid=null;balanceStep=0;
/* 故意让 type=2 那一趟把入账也回出来（服务端忽略 type 参数的情形），并掺一条无方向字段的流水：
   分类只能靠流水自带的 typeFrom，且同一笔不得被两趟查询重复计入 */
response=()=>{const u=calls.at(-1)?.[2]||'';const type=u.includes('type=2')?2:1;
  const income=[{orderId:'in-1',effectdateStr:'2026-09-22 08:30:00',tranamt:12345,typeFrom:'1',resume:'校园卡充值'},{orderId:'in-2',effectdateStr:'2026-09-01 09:00:00',tranamt:5000,typeFrom:'1',resume:'助学金补助'}];
  return {status:200,body:JSON.stringify({code:200,data:{pages:1,records:type===1?income:[...income,{orderId:'out-1',effectdateStr:'2026-09-21 12:00:00',tranamt:1250,typeFrom:'0',resume:'食堂消费'},{orderId:'x-1',effectdateStr:'2026-09-19 10:00:00',tranamt:900,resume:'方向缺失的流水'}]}})}};
const bills=await cardFetchBills();
assert.ok(calls.some((c)=>/personal\/turnover\?.*type=1$/.test(c[2])),'充值流水必须显式按入账类型查询');
assert.ok(calls.some((c)=>/personal\/turnover\?.*type=2$/.test(c[2])),'消费流水必须显式按支出类型查询');
assert.deepEqual(Array.from(bills,(r)=>r.id),['in-1','out-1'],'入账里的补助不得算成充值，重复流水要去重');
assert.deepEqual(Array.from(bills,(r)=>r.kind),['in','out'],'同步结果必须保留每笔流水的收支方向');
cardState.rows=bills;cardState.balance=13;cardState.balanceAt=Date.now();
assert.match(cardStatsHtml(),/一卡通平台充值记录/);
assert.match(cardStatsHtml(),/当前余额/);
assert.match(cardStatsHtml(),/¥13\.00/);
assert.match(cardStatsHtml(),/已花费/,'统计卡必须显示已花费');
assert.match(cardStatsHtml(),/1 笔一卡通平台消费流水/,'已花费要说明它来自平台消费流水');
assert.match(cardStatsHtml(),/data-card-kind="out"/,'统计必须能切到消费维度');
assert.match(cardStatsHtml(),/校园卡账户 \+ 电子账户/,'余额口径必须在页面上说清楚');
assert.match(cardStatsHtml(),/-¥12\.50/,'流水明细里的消费必须带负号');
assert.doesNotMatch(cardStatsHtml(),/--/,'已同步到余额时不得渲染成占位符');
assert.ok(source.includes('data-side') && source.includes('data-goto'), '校园服务栏必须渲染成可点击的入口');
assert.ok(source.includes('tide.util.web.parseSiteMeta'), '标题必须来自网页元信息自动识别');
assert.ok(source.includes('/icons/fontawesome/solid.svg#'), '图标必须使用应用内的 Font Awesome 字形兜底');
assert.ok(source.includes('LINK_META_TTL') && source.includes('quickLinkMeta'), '识别结果必须本地缓存，避免每次进插件都抓七个站点');
assert.match(source, /\{\s*url:\s*"https:\/\/service\.cppu\.edu\.cn\/fe\/site\/service"[^}]*icon:\s*"[a-z-]+"/, '一网通办入口必须自带语义图标，供无法读 favicon 时兜底');
assert.match(source, /\{\s*url:\s*"https:\/\/xg\.cppu\.edu\.cn\/XGPhone\/Phone\/index\.html#\/StuDailyLeaveList"[^}]*icon:\s*"[a-z-]+"/, '「我的请假」入口必须自带语义图标，供无法读 favicon 时兜底');
/* 反面判据①：一卡通走自己的 OAuth2 登录、不接学校统一身份认证（该校部署的 casUrl 是占位符
   xxx.xxx.edu.cn），换不到免登票据 —— 所以 QUICK_LINKS 必须走 view，TICKET_LINKS 不得出现一卡通。 */
const ticketLinksBlock = source.slice(source.indexOf('const TICKET_LINKS'), source.indexOf('const LINK_META_TTL'));
assert.doesNotMatch(ticketLinksBlock, /yktcard\.cppu\.edu\.cn|CARD_/,
  '一卡通不得进 TICKET_LINKS；它必须在应用内视图里按平台自己的登录态走');
/* 反面判据②：「我的请假」是学工 SPA 的 hash 路由（裸开 index.html 返回 200 静态壳、无服务端
   302，登录由该 SPA 自己的 /Login 路由处理），同样不该进 TICKET_LINKS。用完整带 hash 的
   URL 计数 —— 实现里的注释只提路由名，不会把注释算进来。 */
assert.ok((source.split('index.html#/StuDailyLeaveList').length - 1) === 1,
  '「我的请假」URL 只应出现在 QUICK_LINKS 一处，不得同时进 TICKET_LINKS');
/* 反面判据③（本次真正的坑）：用户给的原始地址是登录后的落地页，带一次性授权码与 state
   （用完即废）—— 原样抄进入口的话，点开必然失败。实现里只允许留裸地址 + hash 路由。 */
assert.doesNotMatch(source, /index\.html\?code=|state=QYState/,
  '「我的请假」入口不得写死带一次性授权码 code / state 的地址（用完即废，点开必失败）');
assert.ok(source.includes('bindSide') && source.includes('loadLinkMeta(el)'), '侧栏必须同时绑定在登录页与通知列表页');

/* ── 教务入口做成带子菜单的父项（v1.23.0）────────────────────────
   教务视图原来与 WebVPN / 邮箱 / 学工平铺在一起，现在收进「教务」父项下。
   v1.73.0 起多了「自习室」（教室占用 / 借用）：它原先按用户要求不做，
   现在用户改口要做 —— 所以下面那条「不得出现」的反向断言收窄成只禁评分信息。 */
assert.match(
  source,
  /url:\s*"https:\/\/jw\.cppu\.edu\.cn\/index\.html"[^}]*label:\s*"教务"[^}]*children:\s*\[[\s\S]*?view:\s*"cppu-xk"[\s\S]*?view:\s*"cppu-qj"[\s\S]*?view:\s*"cppu-credit"[\s\S]*?view:\s*"cppu-cx"[\s\S]*?view:\s*"cppu-room"[\s\S]*?\]/,
  '「教务」必须是带 children 的父项，且教务视图（含自习室）都收在 children 里');
assert.match(source, /jwOpen:\s*true/,
  '教务子菜单必须默认展开 —— 这几个入口本来就露在外面，默认收起等于把已有功能藏进一次点击之后');

const sideFnSrc = source.slice(source.indexOf('function sideBtnHtml'), source.indexOf('function sideToggleHtml'));
assert.match(sideFnSrc, /<button[^>]*data-side-sub/,
  '展开/收起必须是父行内的独立 button，不能与整行的 data-goto 共用命中区');
assert.match(sideFnSrc, /data-side-sub[^>]*aria-expanded/,
  '展开箭头必须暴露 aria-expanded');
assert.match(sideFnSrc, /<div class="pp-side-sub/, '子项必须渲染在 .pp-side-sub 容器里');
/* 真 bug 防线：箭头嵌在带 data-goto 的父行里，分支顺序反了点箭头会顺手把教务开进系统浏览器 */
const bindFnSrc = source.slice(source.indexOf('function bindSide'), source.indexOf('/* ═════════ 智慧教务只读接入'));
assert.ok(bindFnSrc.indexOf('"[data-side-sub]"') > -1
  && bindFnSrc.indexOf('"[data-side-sub]"') < bindFnSrc.indexOf('"[data-goto]"'),
  'bindSide 的 [data-side-sub] 分支必须排在 [data-goto] 之前');

assert.match(source, /\.pp-side-sub\{[^}]*grid-template-rows/,
  '子菜单展开必须复用仓库既有的 grid-template-rows 0fr→1fr 手法，不新造机制');
assert.match(source, /\.pp-side-sub \.pp-side-btn\{[^}]*padding-left/, '子项必须缩进，与平级入口区分开');
assert.match(source, /\.pp-side-sub \.pp-side-txt small\{display:none/,
  '子项不显示「在 U-Time 内查看」副行（4 行已经够高，副行是噪音）');
/* 用户明确要求：评分信息查询不接管（自习室查询 v1.73.0 已改口要做，见上） */
assert.doesNotMatch(source, /评分信息/,
  '「评分信息查询」按用户要求不做，不得出现在侧栏');

/* ── 自习室搜索（铁律十：原文 / 拼音首字母 / 跳字简写）──────────────────
   正例三条 + 反例一条。反例是真坑：把一行的所有单元格 join 成一个长串再 includes，
   首字母会跨字段连起来（「阶梯教室 / 第一节」→ jtjsjd1），搜 jd 就假命中，
   而页面上并没有这几个字挨着 —— 所以必须逐字段比。 */
const roomSrc = source.slice(source.indexOf('const loadRoomPinyin'), source.indexOf('function mountJwView'));
assert.match(roomSrc, /import\("\/plugins\/cppu-notify\/pinyin-initials\.js"\)/,
  '自习室搜索必须复用插件内的拼音首字母表（pinyin-initials.js 由 tools/gen-cppu-pinyin.js 生成）');
assert.match(roomSrc, /fields\.some\(\(f\) => roomFieldHits\(f, q\)\)/,
  '自习室过滤必须逐字段比：拼成整串会把首字母跨字段连起来，产生页面上根本不存在的命中');
assert.match(roomSrc, /没有匹配「\$\{raw\}」[^`]*拼音首字母/,
  '搜不到时必须说清能搜哪些字段、也可以打拼音首字母，不能只把计数改成 0');
assert.doesNotMatch(roomSrc, /\.join\(" "\)\.toLowerCase\(\)[\s\S]{0,40}includes\(q\)/,
  '自习室过滤不得退回「整串 includes」——这正是铁律十禁止的假命中写法');

assert.ok(source.includes('MAIL_ACCOUNT = "2025290058@cppu.edu.cn"'), '教育邮箱自动登录必须使用用户指定的完整邮箱账号');
assert.match(source, /if \(url === MAIL_WEB\) \{ await openMailWeb\(btn\); return; \}/,
  '点击教育邮箱必须进入专用自动登录链路，而不是裸开 mail.cppu.edu.cn');
assert.ok(source.includes('readSavedPassword') && source.includes('tide.vault.get("secret")'),
  '教育邮箱必须复用警大通知插件密钥库里保存的同一份密码');
/* v0.259.1 真链路回归：旧实现两处全错 —— ① 往 /coremail/index.jsp?cus=1 POST 明文密码
   （这套部署上 404）；② mbox 打 /coremail/s/json（恒回 FA_INVALID_SESSION）。实测真链路是
   中间件 RSA 登录 → entryhz 落地页换 sid → /js6/s 带 sid 取数，下面按真实报文逐段断言。 */
assert.ok(source.includes('MAIL_LOGIN_API = MAIL_MIDDLE + "/cppu/api/login"')
  && source.includes('MAIL_PUBKEY_API = MAIL_MIDDLE + "/sync/mail/pubkey"'),
  '邮箱登录必须走学校中间件（/cppu/api/login + /sync/mail/pubkey），而不是往邮件站表单提交');
assert.ok(source.includes('MAIL_API = "https://mail.cppu.edu.cn/js6/s"'),
  'mbox 接口必须用 /js6/s：这套部署只认它');
assert.doesNotMatch(source, /\/coremail\/index\.jsp\?cus=1/, '旧的明文登录地址已 404，不能再出现');
assert.doesNotMatch(source, /coremail\/s\/json/, '/coremail/s/json 恒回 FA_INVALID_SESSION，不许再用');
assert.match(source, /em\[1\] = 2;/, '密码必须按 PKCS#1 v1.5 的 type 2（加密）填充：type 1 会被判成密码错');
const mailFn = source.slice(source.indexOf('async function openMailWeb'));
assert.doesNotMatch(mailFn, /data:text\/html|openUrl\([^)]*password/s,
  '邮箱自动登录不能把密码拼进 openUrl/data URL 这类可见地址');

/* ── 邮箱自动登录：真 RSA 密钥 + 真实三段报文 ── */
/* 真实站点是 1024 位 RSA（SPKI 里 02818100 后是 128 字节模数），这里必须同长度：
   2048 位会把模数截错，密文解回来是乱码。 */
const rsaKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
const nHex = Buffer.from(rsaKeys.publicKey.export({ format: 'jwk' }).n, 'base64url').toString('hex').padStart(256, '0');
const MAIL_PUB_HEX = '30819f300d06092a864886f70d010101050003818d0030818902818100' + nHex + '0203010001';
const XML_FOLDERS = '<?xml version="1.0" encoding="UTF-8"?><result><code>S_OK</code><array name="var">'
  + '<object><int name="parent">0</int><object name="flags"><boolean name="system">true</boolean></object>'
  + '<object name="stats"><int name="messageCount">142</int><int name="unreadMessageCount">73</int></object>'
  + '<int name="id">1</int><string name="name">收件箱</string></object>'
  + '<object><int name="parent">0</int><object name="stats"><int name="messageCount">1</int>'
  + '<int name="unreadMessageCount">0</int></object><int name="id">2</int>'
  + '<string name="name">草稿箱</string></object></array></result>';
const XML_LIST = '<?xml version="1.0" encoding="UTF-8"?><result><code>S_OK</code><array name="var">'
  + '<object><int name="fid">1</int><string name="subject">欢迎您使用邮箱</string>'
  + '<string name="from">&quot;邮箱管理员&quot; &lt;admin@cppu.edu.cn&gt;</string>'
  + '<string name="id">AKsAeQCvJQhXfr9*z7ApDarZ</string><date name="sentDate">2025-08-15 03:05:44</date>'
  + '<int name="size">6369</int><object name="flags"><boolean name="read">true</boolean></object></object>'
  + '<object><int name="fid">1</int><string name="subject">一条未读</string>'
  + '<string name="from">企业微信团队 &lt;team@qq.com&gt;</string><string name="id">unread-1</string>'
  + '<date name="sentDate">2025-08-24 14:48:37</date><int name="size">14610</int>'
  + '<object name="flags"><boolean name="read">false</boolean></object></object></array></result>';
const MAIL_DOOR = '<html><head><META HTTP-EQUIV=REFRESH CONTENT="0; URL=x"></head><body><script>'
  + 'window.location.replace("https://mail.cppu.edu.cn/redirect?l=https%3A%2F%2Fmail.cppu.edu.cn%2Fjs6%2Fmain.jsp'
  + '%3Fsid%3Dmail-sid%26show_window%3D0&sid=mail-sid");</script></body></html>';

vaultData.secret = JSON.stringify({ password: 'mail-pass' });
state.autoLogin = true; state.savedPassword = ''; calls = []; opened = []; notices = [];
let loginOk = true;
response = (sid, method, url, opts = {}) => {
  if (method === 'GET' && url === 'https://mailuser.cppu.edu.cn/sync/mail/pubkey') {
    return { status: 200, finalUrl: url, body: 'pubSetting={"pubKey":"' + MAIL_PUB_HEX + '"}' };
  }
  if (method === 'POST' && url === 'https://mailuser.cppu.edu.cn/cppu/api/login') {
    return loginOk
      ? { status: 200, finalUrl: url, body: JSON.stringify({ state: true, location: 'https://entryhz.qiye.163.com/entry/door?hl=zh_CN' }) }
      : { status: 200, finalUrl: url, body: JSON.stringify({ state: false, message: 'input.password.serverError', location: '' }) };
  }
  if (method === 'GET' && url.includes('entryhz.qiye.163.com/entry/door')) {
    return { status: 200, finalUrl: url, body: MAIL_DOOR };
  }
  if (method === 'GET' && url.includes('/redirect?l=')) {
    return { status: 302, finalUrl: 'https://mail.cppu.edu.cn/js6/main.jsp?sid=mail-sid', location: 'x', body: '' };
  }
  if (method === 'GET' && url.includes('/js6/s') && url.includes('getAllFolders')) {
    return { status: 200, finalUrl: url, body: XML_FOLDERS };
  }
  if (method === 'GET' && url.includes('/js6/s') && url.includes('listMessages')) {
    return { status: 200, finalUrl: url, body: XML_LIST };
  }
  return { status: 404, finalUrl: url, body: '' };
};
const loaded = await mailBridge.load();
assert.equal(loaded.ok, true, '邮箱自动登录必须能在中间件链路上跑通：' + loaded.error);
assert.equal(loaded.unread, 73, '未读必须取自 getAllFolders 里 Inbox 的 stats.unreadMessageCount');
assert.equal(loaded.total, 142, '总数必须取自 getAllFolders 里 Inbox 的 stats.messageCount');
assert.equal(loaded.mails.length, 2, '收件箱列表必须解析出邮件');
// v0.268.0：服务端段内顺序不可信（这份 fixture 就是「早的在前」），一律时间倒排 ——
// 最新那封必须排第一，否则「最新在哪」只能靠用户自己找。
assert.equal(loaded.mails[0].date, '2025-08-24 14:48:37', '邮件必须按时间倒序，最新在前');
assert.ok(loaded.mails[0].date > loaded.mails[1].date, '倒序要在整段上成立，不只是第一封');
const welcomeMail = loaded.mails.find((m) => m.subject === '欢迎您使用邮箱');
const unreadMail = loaded.mails.find((m) => m.subject === '一条未读');
assert.ok(welcomeMail && unreadMail, '两封都要解析出来');
assert.equal(welcomeMail.from, '邮箱管理员', '`"名字" <地址>` 只留显示名');
assert.equal(welcomeMail.date, '2025-08-15 03:05:44', 'XML 的 <date name="sentDate"> 要解析成日期');
assert.equal(welcomeMail.read, true, 'flags.read 的布尔必须映射到 read');
assert.equal(unreadMail.read, false, '未读邮件的 read 必须是 false');
const mailPost = calls.find((c) => c[1] === 'POST' && c[2].includes('/cppu/api/login'));
assert.ok(mailPost, '登录必须 POST 到中间件 /cppu/api/login');
const posted = new URLSearchParams(String(mailPost[3].body));
assert.equal(posted.get('accountName'), '2025290058', '中间件要的是不带域名的账号');
assert.equal(posted.get('domain'), 'cppu.edu.cn');
assert.equal(posted.get('language'), 'zh_CN');
assert.equal(
  crypto.privateDecrypt({ key: rsaKeys.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(posted.get('password'), 'base64')).toString(),
  'mail-pass',
  '提交的密码必须是能用 PKCS#1 v1.5（type 2）解回来的密文，且用的密钥库那份密码');
assert.ok(calls.some((c) => c[1] === 'GET' && c[2].includes('/js6/s') && c[2].includes('sid=mail-sid')),
  'mbox 请求必须带上落地页换回来的 sid（只带 Cookie 会回 FA_INVALID_SESSION）');
assert.ok(calls.every((c) => !String(c[2]).includes('/coremail/s/json')), '不能再打 /coremail/s/json');

opened = [];
await openMailWeb(null);
const mailCall = opened.find((item) => Array.isArray(item) && item[0] === 'mailPage');
assert.ok(mailCall, '警大邮箱必须在应用内网页窗口里打开（tide.util.openMailPage）');
assert.equal(mailCall[1], 'https://mail.cppu.edu.cn/static/sirius-web/?version=1791461395966#mailbox',
  '内置窗口必须打开 Coremail 新版前端 Sirius Web 的邮箱首页');
assert.equal(mailCall[2], 'mail-sid', '落地页换回来的 sid 才是 mbox 会话，必须交给内置窗口');
assert.ok(!mailCall[1].includes('sid='), 'sid 不许出现在窗口 URL 里（否则会进浏览历史）');
assert.ok(opened.every((item) => !String(item).includes('mail-pass')), '交给窗口的地址里不能泄露密码');

/* 中间件拒登（密码错）要把原因带给界面，而不是笼统一句「没拿到登录态」 */
loginOk = false;
let foldersDead = true;
const passThrough = response;
response = (sid, method, url, opts = {}) => {
  if (method === 'GET' && url.includes('/js6/s') && foldersDead) {
    return { status: 200, finalUrl: url, body: '<result><code>FA_INVALID_SESSION</code></result>' };
  }
  return passThrough(sid, method, url, opts);
};
const failed = await mailBridge.load();
assert.equal(failed.ok, false);
assert.equal(failed.needLogin, true, '会话被拒要落到「需要登录」而不是通用错误');
assert.match(String(failed.error), /密码|cppu/, '密码错时必须把中间件给的原因带出来');
response = passThrough;

/* ── 校园服务栏可收起 / 展开：默认收起、有动画、自左上角往右下角展开、正文随之让位 ── */
assert.match(source, /sideOpen:\s*false/, '校园服务栏必须默认收起');
assert.match(source, /"pp-shell side-collapsed"/, '默认渲染必须带上 side-collapsed 类');
assert.ok((source.match(/data-side-toggle/g) || []).length >= 2, '收起与展开都要有开关（侧栏头部一个、收起后左上角把手一个）');
/* v1.5.0：展开态头部从「10.5px 灰金小字标题 + 右上角 18px 小三角」改成一个像样的按钮
   （用户反馈「把校园服务变成收起校园服务，按钮长这样」）。两个开关共用同一套视觉。 */
assert.match(source, /class="pp-side-head-toggle"[^>]*data-side-toggle/,
  '展开态头部必须是一个带 data-side-toggle 的「收起」按钮');
assert.ok(!/<div class="pp-side-head"><span>/.test(source),
  '头部不能再渲染成纯文字标题（那个 10.5px 小灰字看不清）');
assert.match(source, /\.pp-side-head-toggle\{[^}]*color:var\(--deep\)/,
  '头部按钮要用与收起把手一致的深青色文字');
assert.match(source, /\.pp-side-head-toggle\{[^}]*letter-spacing:normal/,
  '必须显式清掉字距：头部原来带 letter-spacing:.22em，不清会把按钮文字拉散');
/* v1.6.0：头部只留这一个按钮。原来右边还有个「重新识别标题与图标」的 ↻，但它落在内层溢出的
   那 24px 里，被 overflow:hidden 裁得只剩半个弧；头部的 border-bottom 分隔线又和卡片边框
   一起把头部圈成一个多余的方框。用户看到的就是「右边多余的按钮 + 多余的 1 个框」，两个都删。 */
assert.ok(!source.includes("data-link-sync") && !/pp-side-sync/.test(source),
  '头部右侧的「重新识别」↻ 必须删掉（它被 overflow:hidden 裁掉一半，只剩个残缺的弧）');
assert.ok(!/pp-side-acts/.test(source),
  '↻ 的外层包裹 .pp-side-acts 也要一并删掉，别留死代码');
assert.ok(!/\.pp-side-head\{[^}]*border-bottom/.test(source),
  '头部不能再有 border-bottom 分隔线：卡片边框 + 这条线会把头部圈成一个多余的方框');
assert.match(source, /applySideOpen\(root, !state\.sideOpen\)/, '开关必须真的切换收起状态');
assert.match(source, /\.pp-side\{[^}]*transition:width/, '侧栏宽度必须有过渡，否则没有收起/展开动画');
assert.match(source, /\.pp-shell\.side-collapsed \.pp-side\{width:0/, '收起必须是宽度归零（这样 flex:1 的正文才会跟着移动）');
/* 内层宽度必须等于【卡片的内容盒】宽，不能照抄卡片的 214px 外框宽：214 会让内层比内容盒宽
   24px，多出来的部分被 overflow:hidden 裁掉 —— 右对齐的元素只会剩半个（↻ 就这么被裁的）。
   这里按算式核对，改了 .pp-side 的 width / border / padding 却忘了改内层就会被拦下。 */
{
  const side = source.match(/\.pp-side\{width:(\d+)px;[^}]*?border:(\d+)px solid[^}]*?padding:(\d+)px (\d+)px (\d+)px/);
  const inner = source.match(/\.pp-side-inner\{width:(\d+)px/);
  assert.ok(side && inner, '必须同时写死 .pp-side 的宽/边框/内边距与 .pp-side-inner 的固定宽度');
  const w = +side[1], bd = +side[2], hpad = +side[4];
  const want = w - 2 * bd - 2 * hpad;
  assert.equal(+inner[1], want,
    `内层固定宽度必须等于卡片的内容盒宽（${w} − 2×${bd}px 边框 − 2×${hpad}px 内边距 = ${want}）：`
    + '写卡片外框宽会让内层溢出，右对齐的东西被 overflow:hidden 裁掉一半');
}
assert.match(source, /transform-origin:left top/, '展开方向必须自左上角起');
assert.match(source, /\.pp-shell\.side-collapsed \.pp-side-inner\{transform:scale/, '内层收起时要有缩放，形成左上角到右下角的收放');
assert.match(source, /max-height:0/, '窄屏（≤820px）侧栏是整层叠放，收起要走高度归零');
assert.match(source, /\.pp-side\{[^}]*margin-right:16px/, '侧栏与正文的间距要挂在侧栏自身，收起时才能一起归零');
assert.ok(!/\.pp-shell\{[^}]*gap:16px/.test(source), '外壳不能再用 gap 排版，否则侧栏收起后仍留 16px 空隙');

/* ── 手机端（Android 走同一份前端，窄屏 ≤820px 分支 + 触屏）── */
assert.match(source, /\.pp-shell:not\(\.side-collapsed\) \.pp-side-toggle\{[^}]*max-height:0/,
  '展开时被藏起来的把手必须连高度一起归零，否则窄屏上侧栏与正文之间会留一条看不见的空隙');
/* v1.71.0：主程序 interactions.css 有一条
   `button:not([data-motion="off"], [data-motion="off"] *)`（权重 0,2,1）统管所有按钮的
   position 与 transition —— 只写 `.pp-side-toggle`（0,1,0）会被它整条盖掉：
   实测 width/height 过渡消失（容器尺寸直接跳到终值，只剩字在动），
   position:sticky 也被改回 relative、top:16px 降级成相对位移（把手凭空下移 16px）。
   所以基础规则必须写到 (0,3,0)，这条守卫锁住权重不能再降回去。 */
assert.match(source, /\.pp-shell \.pp-side-toggle\{[^}]*transition:[^}]*width[^}]*height[^}]*transform/,
  '把手的宽 / 高 / 位移必须同时参与过渡，否则「竖变横」只会是跳变（选择器权重须 ≥(0,3,0) 压过 interactions.css 的按钮规则）');
assert.match(source, /\.pp-shell \.pp-side-toggle\{[^}]*position:sticky/,
  '把手要 sticky 钉住：权重不够时会被主程序改回 relative，top 变成相对位移');
assert.match(source, /\.pp-side-toggle>span\{[^}]*transition:transform/,
  '四个字块要各自对 transform 做过渡，字形才会连续滑到位');
assert.ok(!/writing-mode:vertical-rl/.test(source),
  '竖排不许再用 writing-mode：该属性不参与过渡，一改就整段跳变（旧实现就是这个观感）');
assert.match(source, /@media\(max-width:820px\)[\s\S]*?\.pp-shell \.pp-side-toggle\[data-side-toggle\]\{[^}]*min-height:44px/,
  '手机端把手的点击区必须 ≥44px，手指才点得准（权重同样提在 .pp-shell 下）');
assert.match(source, /@media\(max-width:820px\)[\s\S]*?\.pp-side-head-toggle\{[^}]*min-height:44px/,
  '手机端展开态头部的「收起」按钮点击区必须 ≥44px（它是手机上的主要收起入口）');
assert.match(source, /@media\(max-width:820px\)[\s\S]*?\.pp-shell:not\(\.side-collapsed\) \.pp-side-toggle\{[^}]*min-height:0/,
  'min-height 会压过 max-height，窄屏展开时把手必须连 min-height 一起归零');
assert.match(source, /@media\(max-width:820px\)[\s\S]*?\.pp-side-btn\{[^}]*min-height:52px[^}]*touch-action:manipulation/,
  '手机端侧栏入口要有 ≥52px 点击区并禁用双击缩放');
assert.ok(source.includes('-webkit-tap-highlight-color:transparent'), '触屏点击不应出现系统高亮块');
assert.match(source, /@media\(prefers-reduced-motion:reduce\)\{[^}]*\.pp-side,[^}]*\.pp-side-toggle[^}]*transition-duration/,
  '开了「移除动画」（Android 省电模式）时，侧栏与把手的过渡也必须跟着降级');
/* v1.69.0：桌面端收起后的把手与展开态头部是【同一个元素】——收起时是一根竖条（2.3em × 8.5em），
   展开时由 CSS 长成头部那一格（190 × 34），四个字从竖列滑成横行。
   旧实现靠 writing-mode 换排版，属性不能过渡，观感是「竖条直接消失、横按钮直接出现」。
   这四条守卫锁住新做法：断点不撞窄屏、几何对得上头部、逐字位移存在、头部只留占位不出第二个可见开关。 */
{
  const desk = source.match(/@media\(min-width:(\d+)px\)\{([\s\S]*?)\n      \}/);
  assert.ok(desk, '竖排 / 横排两套几何必须写在 min-width 媒体查询里');
  assert.ok(+desk[1] >= 821,
    `把手变形的断点必须 ≥821px：窄屏那套是 max-width:820px（整层叠放、把手满宽），`
    + `两段同时命中会让竖排字落进满宽按钮（当前 ${desk[1]}px）`);
  const body = desk[2];
  assert.match(body, /\.pp-shell:not\(\.side-collapsed\) \.pp-side-toggle\{[^}]*width:190px[^}]*height:34px[^}]*margin-right:-190px[^}]*translate\(-218px,12px\)/,
    '展开态把手必须长成头部那一格（190×34）、用 margin-right:-190px 抵消占位、再平移到头部坐标');
  assert.match(body, /\.pp-shell\.side-collapsed \.pp-side-toggle\{[^}]*width:2\.3em;height:8\.5em/,
    '收起态把手必须是竖条（2.3em 宽 × 8.5em 高）：宽度收窄、高度撑开');
  for (const n of [2, 3, 4, 5]) {
    assert.match(body, new RegExp(`\\.pp-shell\\.side-collapsed \\.pp-side-toggle-ch:nth-child\\(${n}\\)\\{transform:translate\\(\\.[0-9]+em,`),
      `竖排时第 ${n} 个字必须有自己的 translate：逐字位移才能插值出「竖 → 横」的连续变形`);
  }
  assert.match(body, /\.pp-side-head-toggle\{[^}]*visibility:hidden/,
    '展开态头部只作占位：可见可点的必须是同一个把手，否则一屏出现两个同名开关');
}
assert.match(source, /class="pp-side-toggle-arrow"/,
  '把手箭头要单独一个 span：方向翻转靠 CSS 旋转，不是换一个字符');
assert.match(source, /class="pp-side-toggle" data-side-toggle data-motion="off"/,
  '把手必须 data-motion="off"：否则首次点击后 motion.js 挂上 .motion-ripple-host，'
  + '那条 (0,3,1) 规则会补 position:relative / overflow:clip，把 sticky 和 top 打回相对位移');
assert.match(source, /SIDE_LABEL_CHARS/,
  '「校园服务」必须拆成四个独立字块，否则竖排只能退回 writing-mode 那种跳变');
assert.match(source, /@media\(max-width:820px\)[\s\S]*?\.pp-shell \.pp-side-toggle>span\{[^}]*position:static/,
  '窄屏没有竖条那套几何，字块必须退回行内（前缀 .pp-shell 提权重，压过 nth-child 坐标）');
assert.ok(source.includes('AUTO_REFRESH_MS') && source.includes('data-ar'), '插件必须提供低打扰的定时自动刷新开关');
const hostSrc = readProductSource(new URL('../src/pluginHost.js', import.meta.url), 'utf8');
assert.ok(hostSrc.includes('vault: "加密密钥库'), '插件宿主必须定义 vault 权限标签');
assert.ok(hostSrc.includes('requirePermission(man, pid, "vault")'), 'tide.vault 必须走权限校验');
assert.ok(hostSrc.includes('?v=${encodeURIComponent(version)}') && hostSrc.includes('cache: "no-cache"'), '内置插件入口必须按版本破缓存，避免升级后仍运行旧代码');
const apiSrc = readProductSource(new URL('../src/api.js', import.meta.url), 'utf8');
assert.ok(apiSrc.includes('plugin_vault_get') && apiSrc.includes('http_session_restore'), 'api 层必须接通密钥库与会话恢复命令');
assert.ok(apiSrc.includes('followRedirects: opts.followRedirects'), 'api 层必须把重定向策略传给 Rust HTTP 会话');
const libSrc = readProductSource(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
assert.ok(libSrc.includes('fn http_session_export') && libSrc.includes('fn plugin_vault_set'), 'Rust 侧必须提供会话导出与密钥库命令');
assert.ok(libSrc.includes('Policy::none()') && libSrc.includes('follow_redirects'), 'Rust HTTP 会话必须支持禁止自动重定向');
assert.ok(libSrc.includes('reqwest::header::LOCATION'), 'Rust HTTP 响应必须把 Location 暴露给插件逐段换票');

/* ── 9. OCR 纯函数：相似度 / 分类 / 分组 / 归一化 / 阈值 ── */
const bitsA = new Array(256).fill(0);   // 「实心环」图案，代表数字 A
for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
  const edge = x < 3 || x > 12 || y < 3 || y > 12;
  const hole = x > 5 && x < 10 && y > 5 && y < 10;
  bitsA[y * 16 + x] = edge && !hole ? 1 : 0;
}
assert.equal(OCR.similarity(bitsA, bitsA), 1, '同位图相似度必须为 1');
const noisy = [...bitsA];
for (let i = 0; i < 8; i++) noisy[40 + i * 7] ^= 1;
assert.ok(OCR.similarity(bitsA, noisy) > 0.9, '轻微噪点相似度必须接近 1');
const bitsB = new Array(256).fill(0);   // 「左半实心」图案，代表数字 B
for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) bitsB[y * 16 + x] = 1;
const lib = [{ d: 3, bits: bitsB }, { d: 8, bits: bitsA }];
assert.equal(OCR.classify(noisy, lib, []).d, 8, '带噪样本必须归类到最优模板');
assert.equal(OCR.classify(bitsB, lib, [{ b: bitsB.join(''), d: 1 }]).d, 1, '历史样本可以覆盖内置模板');
assert.equal(OCR.normalizeRegion(16, () => true, 0, 0, 16, 16).reduce((a, b) => a + b, 0), 256, '全墨区域归一化后应全为 1');
const leftHalf = OCR.normalizeRegion(16, (x) => x < 8, 0, 0, 16, 16);
assert.equal(leftHalf.filter(Boolean).length, 128, '左半墨区域归一化后应恰好一半为 1');
const g1 = OCR.groupByX([{ pix: [0, 1, 2], minX: 0, maxX: 2, minY: 0, maxY: 1, size: 3 }]);
const g2 = OCR.groupByX([
  { pix: [0], minX: 0, maxX: 0, minY: 0, maxY: 0, size: 1 },
  { pix: [1], minX: 0, maxX: 1, minY: 1, maxY: 1, size: 1 },
  { pix: [9], minX: 9, maxX: 9, minY: 0, maxY: 0, size: 1 },
]);
assert.equal(g1.length, 1);
assert.equal(g2.length, 2, 'x 不重叠的连通域不能合并');
const getMask = (x, y) => (x === y && x < 3) || (x === 3 && y < 3); // 一条 5 像素折线
assert.equal(OCR.components(5, 5, getMask).length, 1, '连通像素必须归为一个连通域');
const hist = new Array(256).fill(0);
for (let i = 0; i < 100; i++) { hist[30]++; hist[220]++; } // 双峰直方图
const th = OCR.otsu(hist, 200);
assert.ok(th > 30 && th <= 220, 'Otsu 阈值必须落在两峰之间（暗峰右移一位）');

/* ── 10. 「教务」等需登录入口：用统一身份认证会话现场换一次性 ticket，交系统浏览器 ──
   裸开 https://jw.cppu.edu.cn/index.html 只会 302 到统一身份认证登录页，所以入口不能直接开它，
   也不能把 token 写死进链接（那是个人凭据，会随公开仓库泄露且必然过期）。 */
assert.ok(source.includes('TICKET_LINKS'), '需登录的入口必须声明换票信息');
assert.ok(source.includes('/tpass/bridge'), 'sso-jw 域没会话时必须能补走 bridge 换票');
assert.ok(!/["'`]token=/.test(source), '插件不得把任何 token 写死进链接');
const jwEntry = { setAttribute(){}, removeAttribute(){} };

// ① 会话有效：一次要票就够，且必须禁止自动重定向（跟着重定向跑到底就是自己把票吃掉）
state.sid='sso-test'; opened=[]; notices=[]; calls=[];
response=(sid,method,url,opts)=>({status:302,body:'',finalUrl:url,location:'https://jw.cppu.edu.cn/cas_callback?ticket=ST-jw',cookies:[]});
await openSideLink('https://jw.cppu.edu.cn/index.html', jwEntry);
assert.equal(calls.length,1,'会话有效时只该向 sso-jw 要一次票');
assert.equal(calls[0][2],'https://sso-jw.cppu.edu.cn/tpass/login?service='+encodeURIComponent('https://jw.cppu.edu.cn/cas_callback'));
assert.equal(calls[0][3].followRedirects,false,'换票请求必须禁止自动重定向');
assert.equal(opened[0],'https://jw.cppu.edu.cn/cas_callback?ticket=ST-jw','必须把带 ticket 的链接交给浏览器');
assert.equal(notices.length,0);

// ② sso-jw 没会话：用主 SSO 的 CASTGC 补走 bridge 落会话后再要一次票
opened=[]; notices=[]; calls=[]; let mintStep=0;
response=(sid,method,url,opts)=>{
  mintStep++;
  if(mintStep===1) return {status:200,body:'<html>sso-jw login</html>',finalUrl:url,location:'',cookies:[]};
  if(mintStep===2) return {status:302,body:'',finalUrl:url,location:'https://sso-jw.cppu.edu.cn/tpass/bridge?ticket=ST-main',cookies:[]};
  if(mintStep===3) return {status:200,body:'bridge ok',finalUrl:url,location:'',cookies:['CASTGC=TGT']};
  return {status:302,body:'',finalUrl:url,location:'https://jw.cppu.edu.cn/cas_callback?ticket=ST-jw2',cookies:[]};
};
await openSideLink('https://jw.cppu.edu.cn/index.html', jwEntry);
assert.equal(calls.length,4,'要不到票时必须是「要票 → bridge → 落票 → 再要票」四段');
assert.ok(calls[1][2].includes('bridge'),'第二段必须走主 SSO 换 bridge 票');
assert.ok(calls.every(c=>c[3].followRedirects===false),'换票链路每一段都必须禁止自动重定向');
assert.equal(opened[0],'https://jw.cppu.edu.cn/cas_callback?ticket=ST-jw2');

// ③ 彻底换不到票：退回裸链接并提示，入口不能点了没反应
opened=[]; notices=[];
response={status:200,body:'<html>login</html>',finalUrl:'https://sso-jw.cppu.edu.cn/tpass/login',location:'',cookies:[]};
await openSideLink('https://jw.cppu.edu.cn/index.html', jwEntry);
assert.equal(opened[0],'https://jw.cppu.edu.cn/index.html','换不到票必须退回裸链接');
assert.equal(notices.length,1,'退回裸链接时要告诉用户可能得先登录');

// ④ 换票只作用于声明过的入口，其余四个照旧直开
opened=[]; calls=[];
await openSideLink('https://webvpn.cppu.edu.cn/');
assert.deepEqual(opened,['https://webvpn.cppu.edu.cn/'],'未声明换票的入口必须仍然直开裸地址');
assert.equal(calls.length,0,'未声明换票的入口不应发起任何请求');

/* ── 11. 智慧教务只读接入（选课 / 请假 / 创新学分）────────────────────────
   三条硬规矩：① 建立教务会话要「要票 → 自己消费落票」两段（跟侧栏「把票交给浏览器」正相反）；
   ② 取数只走通用查询端点 /je/load，请求体配方错了服务端直接回 UNKOWN_ERROR；
   ③ 全程只读，绝不出现写入类端点（提交请假/选课要回教务点）。 */
state.sid = 'jw-test'; state.username = '2025290058'; calls = []; opened = []; notices = [];
const jeJson = (rows) => ({ status: 200, finalUrl: 'https://jw.cppu.edu.cn/je/load', location: '', cookies: [], body: JSON.stringify({ total: rows.length, rows }) });
/* 教务侧真实形状（2026-09-22 真机抓的）：视图型功能只要 funcCode 就能查；
   funcType=sql 的功能必须把它自己的 SELECT 原样回传（queryType/dbSql/queryParamsStr）。 */
const JE_META = {
  'V_JWBZK_XKGL_XKJG_XS': { funcId: 'UEgVc81fir8gotAkmzM', funcType: 'view' },
  'JWBZK.T_JWBZK_XKGL_XYXK': { funcId: 'cxJNVOE1UJU4YwTJyDT', funcType: 'sql', sql: 'SELECT DISTINCT A.ID FROM JWBZK.T_JWBZK_XKGL_XKRW A' },
  /* 自习室查询（2026-10-20 真机抓的）：教务给这个功能配了自己的控制器 /je/zxcx，
     而且 SQL 里带一个 ? 占位符（RQ = 当天），实参声明在 FUNCINFO_QUERYPARAM。
     这两个字段漏一个，服务端就只回一句「数据加载失败！」，前端再误判成登录失效。 */
  'ZXZYCX': { funcId: 'PgJArOD5U54m6aO9h9a', funcType: 'sql', sql: 'SELECT * FROM (select ? rq from dual) DATA_QUERY',
    funcAction: '/je/zxcx', querparam: '[{"name":"RQ","fieldType":"VARCHAR","paramType":"0","defaultValue":"SYSDATE"}]' },
};
const jeMetaJson = (code) => {
  const m = JE_META[code] || {};
  const info = {};
  if (m.sql) info.FUNCINFO_SQL = m.sql;
  if (m.funcAction) info.FUNCINFO_FUNCACTION = m.funcAction;
  if (m.querparam) info.FUNCINFO_QUERYPARAM = m.querparam;
  return { status: 200, finalUrl: 'https://jw.cppu.edu.cn/je/develop/funcInfo/getStaticFuncByCode', location: '', cookies: [], body: JSON.stringify({ funcInfo: { funcId: m.funcId, funcType: m.funcType }, func: { info } }) };
};
const jeMeta = (opts) => decodeURIComponent(String(opts?.body || '')).replace(/\+/g, ' ').match(/FUNCINFO_FUNCCODE=([^&]*)/)?.[1] || '';
response = (sid, method, url, opts = {}) => {
  if (url.startsWith('https://sso-jw.cppu.edu.cn/tpass/login')) return { status: 302, body: '', finalUrl: url, location: 'https://jw.cppu.edu.cn/cas_callback?ticket=ST-self', cookies: [] };
  if (url.startsWith('https://jw.cppu.edu.cn/cas_callback')) return { status: 200, body: '<html>智慧教务</html>', finalUrl: 'https://jw.cppu.edu.cn/index.html', location: '', cookies: [] };
  if (url.endsWith('/je/develop/funcInfo/getStaticFuncByCode')) return jeMetaJson(jeMeta(opts));
  if (url.startsWith('https://jw.cppu.edu.cn/je/load') || url.startsWith('https://jw.cppu.edu.cn/je/zxcx/load')) return jeJson([{ KCMC: '示例课程' }]);
  return { status: 404, body: '', finalUrl: url, location: '', cookies: [] };
};
assert.equal(await ensureJwSession(), true, '换票自消费后应建立教务会话');
assert.equal(jwLive(), true, '教务会话必须记在发起它的那个 sid 上（换会话就要重换票）');
assert.equal(calls.length, 2, '建立教务会话 = 要票 + 落票两段请求');
assert.equal(calls[0][2], 'https://sso-jw.cppu.edu.cn/tpass/login?service=' + encodeURIComponent('https://jw.cppu.edu.cn/cas_callback'), '要票的 service 必须是教务的 cas_callback');
assert.equal(calls[0][3].followRedirects, false, '要票那段必须禁止自动重定向（一次性票据不能被跟到底吃掉）');
assert.equal(calls[1][3]?.followRedirects, undefined, '落票这段要跟着重定向跑完，Cookie Jar 才拿得到 authorization');
assert.equal(calls[1][2], 'https://jw.cppu.edu.cn/cas_callback?ticket=ST-self', '教务会话必须自己消费这张票，区别于侧栏「交给系统浏览器」');

calls = [];
const jeOnce = await jeLoad('xkResult', []);   // 跨 realm 的对象不能 deepEqual（原型不同）
assert.equal(jeOnce.length, 1);
assert.equal(jeOnce[0].KCMC, '示例课程');
assert.equal(calls.length, 2, '教务会话有效时取数 = 功能元信息 + 数据查询两段，不该再换票');
assert.equal(calls[0][2], 'https://jw.cppu.edu.cn/je/develop/funcInfo/getStaticFuncByCode', '查询前要先拿功能元信息（funcType / dbSql 都在里面）');
assert.ok(decodeURIComponent(calls[0][3].body).includes('V_JWBZK_XKGL_XKJG_XS'), '元信息按 funcCode 查');
assert.equal(calls[1][1], 'POST');
assert.equal(calls[1][2], 'https://jw.cppu.edu.cn/je/load', '教务数据只走通用查询端点');
const jeBody = new URLSearchParams(calls[1][3].body);
assert.equal(jeBody.get('funcCode'), 'V_JWBZK_XKGL_XKJG_XS');
assert.equal(jeBody.get('funcId'), 'UEgVc81fir8gotAkmzM', 'funcId 必须用元信息里的功能自身 id，不是菜单 id');
assert.equal(jeBody.get('tableCode'), 'V_JWBZK_XKGL_XKJG');
assert.equal(jeBody.get('_isFunc_'), 'true');
assert.equal(jeBody.get('limit'), '-1', '一次拉全量（分页要靠 j_query，不是靠翻页）');
assert.equal(jeBody.get('queryType'), null, '视图型功能不要回传 SQL');
assert.equal(JSON.parse(jeBody.get('j_query')).custom.length, 0);
assert.equal(calls[1][3].headers.Referer, 'https://jw.cppu.edu.cn/index.html', '/je/load 必须带教务站内来源');
calls = [];
await jeLoad('xkResult', []);
assert.equal(calls.length, 1, '同一功能的元信息必须缓存，不能每次查询都多跳');

// funcType=sql 的功能（学员选课）漏掉回传 SQL 会直接 UNKOWN_ERROR
calls = [];
await jeLoad('xkTask', []);
const taskBody = new URLSearchParams(calls.at(-1)[3].body);
assert.equal(taskBody.get('queryType'), 'sql');
assert.equal(taskBody.get('dbSql'), 'SELECT DISTINCT A.ID FROM JWBZK.T_JWBZK_XKGL_XKRW A', 'sql 型功能要原样回传它自己的 SELECT');
assert.equal(taskBody.get('queryParamsStr'), '[]');

calls = [];
await jeLoad('qjCourse', [{ type: 'and', value: [{ code: 'XNXQ_CODE', type: '=', value: '20262027-1', cn: 'and' }] }]);
const jeQuery = JSON.parse(new URLSearchParams(calls.at(-1)[3].body).get('j_query'));
assert.deepEqual(jeQuery._custom_types, ['group'], '条件组必须声明 group 类型，否则服务端不认');
assert.equal(jeQuery.custom[0].value[0].value, '20262027-1');

// 会话过期的表现不是 401，而是 POST 被 302 回登录页、拿回来一整页 HTML → 换新票重一次
calls = []; let loadHits = 0;
response = (sid, method, url, opts = {}) => {
  if (url.startsWith('https://sso-jw.cppu.edu.cn/tpass/login')) return { status: 302, body: '', finalUrl: url, location: 'https://jw.cppu.edu.cn/cas_callback?ticket=ST-' + loadHits, cookies: [] };
  if (url.startsWith('https://jw.cppu.edu.cn/cas_callback')) return { status: 200, body: '<html>ok</html>', finalUrl: 'https://jw.cppu.edu.cn/index.html', location: '', cookies: [] };
  if (url.endsWith('/je/develop/funcInfo/getStaticFuncByCode')) return jeMetaJson(jeMeta(opts));
  if (url.startsWith('https://jw.cppu.edu.cn/je/load')) {
    loadHits++;
    return loadHits === 1 ? { status: 200, body: '<html>统一身份认证平台</html>', finalUrl: url, location: '', cookies: [] } : jeJson([{ KCMC: '重取到的课程' }]);
  }
  return { status: 404, body: '', finalUrl: url, location: '', cookies: [] };
};
assert.equal((await jeLoad('cxCredit'))[0].KCMC, '重取到的课程', '拿到 HTML 必须换新票重一次');
assert.equal(loadHits, 2, '解析失败只重试一次，不能无限重');
loadHits = 0; response = (sid, method, url) => (url.includes('/je/load') ? { status: 200, body: '<html>nope</html>', finalUrl: url, location: '', cookies: [] } : (url.includes('tpass/login') ? { status: 302, body: '', finalUrl: url, location: 'https://jw.cppu.edu.cn/cas_callback?ticket=x', cookies: [] } : { status: 200, body: '<html>ok</html>', finalUrl: 'https://jw.cppu.edu.cn/index.html', location: '', cookies: [] }));
await assert.rejects(() => jeLoad('qjRecord'), /教务登录态没建立起来/, '两次都拿不到 rows 就说清楚登录态没建起来，不要静默返回空列表');

/* 业务拒绝 ≠ 登录失效（v1.77.0）：自习室这类「后台配列」的功能，服务端回的是 200 + 结构化
   code=UNKOWN_ERROR。旧写法一律当成会话过期去换票重登，横幅显示「自动登录失败」——
   用户以为登录坏了，其实登录是好的，拒绝的是这次查询的配方。 */
await ensureJwLogin(true);
let tpassHits = 0; let bizHits = 0;
response = (sid, method, url) => {
  if (url.includes('tpass/login')) { tpassHits++; return { status: 302, body: '', finalUrl: url, location: 'https://jw.cppu.edu.cn/cas_callback?ticket=x', cookies: [] }; }
  if (url.includes('/je/develop/funcInfo/getStaticFuncByCode')) return { status: 200, body: JSON.stringify({ funcInfo: { funcId: 'UEgVc81fir8gotAkmzM', funcType: 'view' } }), finalUrl: url, location: '', cookies: [] };
  if (url.includes('/je/load')) { bizHits++; return { status: 200, body: JSON.stringify({ code: 'UNKOWN_ERROR', message: 'UNKOWN_ERROR' }), finalUrl: url, location: '', cookies: [] }; }
  return { status: 200, body: '<html>ok</html>', finalUrl: 'https://jw.cppu.edu.cn/index.html', location: '', cookies: [] };
};
await assert.rejects(() => jeLoad('creditModule'), /教务拒绝了这次查询：UNKOWN_ERROR/, '业务拒绝要把服务端原话转出来，别翻成「解析失败」');
assert.equal(bizHits, 1, '业务拒绝不是登录问题，不许重发第二遍查询');
assert.equal(tpassHits, 0, '业务拒绝更不许去换票重登（过去这里会白跑一轮验证码识别，横幅谎报登录失败）');

/* 元信息四种姿势全不回时（v1.77.0 多路探测）：自习室没有硬编码 funcId 可兜底，
   必须当场说「没给出字段定义」，而不是空着 funcId 去撞 /je/load 再被误判成登录失败。 */
calls = [];
response = (sid, method, url) => {
  if (url.includes('/je/develop/funcInfo/getStaticFuncByCode')) return { status: 200, body: JSON.stringify({ funcInfo: {} }), finalUrl: url, location: '', cookies: [] };
  if (url.includes('/je/load')) return { status: 200, body: JSON.stringify({ code: 'UNKOWN_ERROR' }), finalUrl: url, location: '', cookies: [] };
  return { status: 200, body: '<html>ok</html>', finalUrl: 'https://jw.cppu.edu.cn/index.html', location: '', cookies: [] };
};
await assert.rejects(() => jeLoad('room'), /没给出「自习室」的字段定义/, '自习室没有可兜底的 funcId，元信息失败要当场说明');
assert.equal(calls.filter((c) => String(c[2]).includes('/je/load')).length, 0, '字段定义没拿到就不该再去撞查询端点');
assert.ok(calls.filter((c) => String(c[2]).includes('getStaticFuncByCode')).length >= 2, '同一份部署对 GET / POST 接受度不一样，失败要换姿势再试，不能只撞一次');

/* 自习室查询：教务给它配了自己的 load 路径（FUNCINFO_FUNCACTION = /je/zxcx），SQL 里还带一个
   ? 占位符（RQ = 当天），实参声明在 FUNCINFO_QUERYPARAM。旧写法一律打通用 /je/load、且
   queryParamsStr 恒为 "[]"，那个控制器只会回一句「数据加载失败！」，插件再把它当成登录失效
   → 用户看到「自动登录失败」（2026-10-20 真机抓包定位）。 */
calls = [];
response = (sid, method, url) => {
  if (url.includes('/je/develop/funcInfo/getStaticFuncByCode')) return jeMetaJson('ZXZYCX');
  if (url.startsWith('https://jw.cppu.edu.cn/je/zxcx/load')) return jeJson([{ JC: '01', RQ: '2026-10-20' }]);
  return { status: 404, body: '', finalUrl: url, location: '', cookies: [] };
};
const roomRows = await jeLoad('room', []);
assert.equal(roomRows[0].JC, '01', '自习室要从它自己的端点取到行');
const roomCall = calls.at(-1);
assert.equal(roomCall[2], 'https://jw.cppu.edu.cn/je/zxcx/load', '功能配了 FUNCINFO_FUNCACTION 就走它自己的 load 端点，别死磕 /je/load');
const roomBody = new URLSearchParams(roomCall[3].body);
assert.equal(roomBody.get('queryType'), 'sql');
assert.equal(roomBody.get('queryParamsStr'), '[{"name":"RQ","fieldType":"VARCHAR","paramType":"0","defaultValue":"SYSDATE"}]', 'sql 里的 ? 占位符要按 FUNCINFO_QUERYPARAM 原样回传实参声明');
assert.equal(roomBody.get('tableCode'), '', '自习室没有表名可抄，就留空，不能编一个像样的');
assert.equal(calls.filter((c) => String(c[2]).endsWith('/je/load')).length, 0, '配了自己端点的功能不该再撞通用端点');

/* 自习室按日期查看（v1.83.0）：那条 SQL 只有一个 ? 占位符（RQ）。服务端认的实参是
   QUERYPARAM 里声明的 defaultValue —— 换成某天就查那天（2026-10-25 实测空闲 614/630，
   今天 332/630）。只换 defaultValue：fieldType / paramType 少一个，服务端就回
   JSONObject["fieldType"] not found，整条 SQL 直接被拒。 */
const keepQuer = JE_META.ZXZYCX.querparam;
calls = [];
await jeLoad('room', [], { date: '2026-10-25' });
assert.equal(new URLSearchParams(calls.at(-1)[3].body).get('queryParamsStr'),
  '[{"name":"RQ","fieldType":"VARCHAR","paramType":"0","defaultValue":"2026-10-25"}]',
  '选日期时只换 RQ 的 defaultValue，其余声明字段必须原样带回去');
calls = [];
await jeLoad('room', []);
assert.equal(new URLSearchParams(calls.at(-1)[3].body).get('queryParamsStr'),
  '[{"name":"RQ","fieldType":"VARCHAR","paramType":"0","defaultValue":"SYSDATE"}]',
  '没选日期时把声明原样传回去（服务端拿 SYSDATE 当今天）');
assert.equal(keepQuer, JE_META.ZXZYCX.querparam, '上面两条只是换实参，测试夹具本身不该被改掉');

assert.match(roomSrc, /const id = name \|\| jwRoomText\(r\.YW_ID\)/,
  '自习室按教室名分组：YW_ID 在别的数据形态下可能每节次一个，按它分组会把 101 拆成五行「101」');
assert.match(roomSrc, /data-room-date="\$\{esc\(id\)\}"/, '自习室要有日期胶囊（今天 / 明天 / 后天 / 自选）');
assert.match(roomSrc, /data-room-date-in/, '要能选任意一天：原生日期框叠在胶囊行尾');
assert.match(roomSrc, /空闲位 \$\{p?Free\} \/ \$\{p?Seats\}/, '计数行给出那天的空闲位数 —— 用户点日期就是为了这一句');
assert.match(roomSrc, /全天空闲/, '整天一位没占的楼给绿标，省得用户自己换算数字');

/* 按楼筛选（v0.275.0）：17 栋楼一次铺开要滚三屏，先把范围收到自己那栋。
   三处必须同时存在，少一处就是半成品：
   ① 楼胶囊行 data-room-blds + 每颗 data-room-bld-chip（与卡片上的 data-room-bld 分开命名 ——
      同名会让 closest() 把点卡片也当成点胶囊）；
   ② 卡片按选中楼隐藏，但**留在 DOM 里**（[hidden] 而非不渲染），否则搜索框会随着重绘丢焦点；
   ③ 过滤时分母跟着楼走，不能写「全部 N 间」—— 那会让用户以为搜索漏了东西。 */
assert.match(roomSrc, /data-room-blds/, '自习室要有「楼」胶囊组');
assert.match(roomSrc, /data-room-bld-chip="\$\{esc\(id\)\}"/, '「楼」胶囊用独立属性名，不能与卡片的 data-room-bld 撞名');
assert.match(roomSrc, /jwRoomCardHtml\(bld, rooms, slots, sel, !bldSel \|\| bldSel === bld\)/, '选中楼以外的卡片要收起（传 visible）');
assert.match(roomSrc, /card\.hidden = !left \|\| \(!!bldSel && card\.dataset\.roomBld !== bldSel\)/, '过滤要跟楼选择叠加：只靠搜索的话选完楼再搜会把别的楼又放出来');
assert.match(roomSrc, /\[data-room-dates\], \[data-room-blds\], \[data-room-slots\]/, '「楼」这组单选项也要有滑动选中光（铁律六）');

/* 顶部工具栏顺序（v0.275.0 用户指定）：刷新 → 回通知 → 重新登录 → 浏览器打开。
   「去教务」这个名字换掉、并且挪到最右 —— 它是最不常用的一颗，摆在第二个位置挡着常用键。 */
const shellSrc = source.slice(source.indexOf('function jwShellHtml'), source.indexOf('function jwPaint'));
assert.match(shellSrc, /data-jw-site>浏览器打开</, '跳转教务那颗按钮改名为「浏览器打开」');
assert.ok(shellSrc.indexOf('data-jw-back') < shellSrc.indexOf('data-jw-site'), '「浏览器打开」要排到最后');
assert.ok(!shellSrc.includes('>去教务<'), '顶部不再有「去教务」按钮');

/* ── 11.1 传输层抖动：reqwest 的 Display 只有 "error sending request for url (…)" 一句，
   成因（DNS / 超时 / 连接被掐）全在 cause 链里，由 Rust 侧摊平后送上来。
   两条要求：① 读查询遇到毛刺要自己重发一次，别把一次抖动变成一整屏报错；
   ② 重发用尽后要按成因说人话，并把原串留着备查。 */
const dnsBlip = () => new Error('请求失败: error sending request for url (https://jw.cppu.edu.cn/je/load): client error (Connect): dns error: failed to lookup address information: no such host');
const jeRouter = (loadReply) => (sid, method, url, opts = {}) => {
  if (url.endsWith('/je/develop/funcInfo/getStaticFuncByCode')) return jeMetaJson(jeMeta(opts));
  if (url.startsWith('https://jw.cppu.edu.cn/je/load')) return loadReply();
  return { status: 404, body: '', finalUrl: url, location: '', cookies: [] };
};
let blipHits = 0;
response = jeRouter(() => { blipHits++; return blipHits === 1 ? Promise.reject(dnsBlip()) : jeJson([{ KCMC: '抖动后取回的课程' }]); });
assert.equal((await jeLoad('creditModule'))[0].KCMC, '抖动后取回的课程', 'DNS 抖动必须自动重发，一次毛刺不该让整屏没数据');
assert.equal(blipHits, 2, '重发一次就够，不能无限重');

blipHits = 0;
response = jeRouter(() => { blipHits++; return Promise.reject(new Error("Cannot read properties of undefined (reading 'rows')")); });
await assert.rejects(() => jeLoad('grade'), /Cannot read properties/, '代码 bug 这类非传输层错误不许盲目重发');
assert.equal(blipHits, 1, '非抖动错误一次都不该重发');

blipHits = 0;
response = jeRouter(() => { blipHits++; return Promise.reject(dnsBlip()); });
await assert.rejects(() => jeLoad('grade'), /连不上警大的服务器（域名没解析出来）/, '重发用尽要把成因翻成人话');
assert.equal(blipHits, 3, '退避重发最多两次');
response = jeRouter(() => jeJson([{ KCMC: '恢复后的查询' }]));
assert.equal((await jeLoad('grade'))[0].KCMC, '恢复后的查询', '连续失败不会把后续查询永久挡死');

// 分类与「已经是人话就不二次加工」
assert.match(explainHttpError(new Error('请求失败: error sending request for url (x): operation timed out')), /等待响应超时/);
assert.match(explainHttpError(new Error('请求失败: error sending request for url (x): client error (Connect): tcp connect error: connection refused (os error 10061)')), /连不上服务器/);
assert.match(explainHttpError(new Error('请求失败: error sending request for url (x): invalid peer certificate: UnknownIssuer')), /HTTPS 握手/);
assert.match(explainHttpError(new Error('Failed to fetch')), /浏览器预览/);
assert.equal(explainHttpError(new Error('教务登录态已失效，请重新登录')), '教务登录态已失效，请重新登录', '本来就是人话的文案原样透出');

// 重启恢复：dump 里已带教务 authorization 就省一次换票；但 sso-jw 域的同名 Cookie 不算
await clearSavedLogin(); state.sid = null;
vaultData.cookies = JSON.stringify([{ url: 'https://jw.cppu.edu.cn', cookie: 'authorization=keep-me' }, { url: 'https://portal-jw.cppu.edu.cn', cookie: 'tp_up=t' }]);
assert.equal(await restoreCookies(), true);
assert.equal(jwLive(), true, '恢复的 Cookie 里有教务 authorization 时必须直接认这个会话');
await clearSavedLogin(); state.sid = null;
vaultData.cookies = JSON.stringify([{ url: 'https://sso-jw.cppu.edu.cn', cookie: 'authorization=other' }]);
assert.equal(await restoreCookies(), true);
assert.equal(jwLive(), false, 'sso-jw 域的 authorization 不能当成教务会话（域名判定要精确到 https://jw.）');
await clearSavedLogin(); state.sid = null;

/* 只读守门：写入类端点一个都不许出现 */
assert.doesNotMatch(source, /\/je\/doAct|\/je\/develop\/funcInfo\/(save|add|update)|jw\.cppu\.edu\.cn[^"'`\n]*\/(save|submit|add|update|delete)/i,
  '教务接入必须只读：写入类端点没实测过就不许出现在插件里');
assert.ok(source.includes('const JW_LOAD = JWAPP + "/je/load"'), '教务取数端点必须挂在 jw 域，不能混进 sso-jw');

/* 警大学分原入口成为警大成绩，避免教务菜单出现两张重复成绩页；校历 v0.216.0 从独立插件并入；
   学生个人成长中心（pdata）v0.217.0 并入；个人信息 v0.221.0 并入。 */
assert.deepEqual(views.map((v) => v.id).sort(), ['cppu-award', 'cppu-calendar', 'cppu-card', 'cppu-credit', 'cppu-credit-ledger', 'cppu-cx', 'cppu-exam', 'cppu-growth', 'cppu-mail', 'cppu-net', 'cppu-notify', 'cppu-profile', 'cppu-qj', 'cppu-room', 'cppu-xk'],
  '必须注册通知、获奖名单、警大校历、自习室、学生成长、个人信息、上网记录、邮箱、我的学分、我的考试及六个教务/一卡通视图，登录设置属于应用设置');
assert.ok(views.filter((v) => v.id !== 'cppu-notify').every((v) => typeof v.render === 'function'), '插件子视图必须有 render');
assert.ok(views.some((v) => v.id === 'cppu-cx' && v.title === '警大创新学分'), '创新学分视图要有独立标题');
assert.ok(views.some((v) => v.id === 'cppu-credit' && v.title === '警大成绩'), '原警大学分视图应以警大成绩注册');
assert.ok(views.some((v) => v.id === 'cppu-profile' && v.title === '个人信息'), '个人信息视图要有独立标题');
assert.match(source, /view: "cppu-credit", label: "警大成绩"/, '教务菜单应显示警大成绩');
assert.match(source, /id: "cppu-credit", title: "警大成绩"[^\n]*keys: \["grade", "pdataStudy"\][^\n]*menu: JW_MENU\.grades,[\s\S]*?body: \(\) => jwGradesHtml\(\)/,
  '警大成绩入口必须读取成绩接口，并同时拉个人成长中心的绩点排名 / 六维图');
assert.doesNotMatch(source, /view: "cppu-grades"|id: "cppu-grades"/, '不能保留重复的成绩入口');
for (const v of ['cppu-xk', 'cppu-qj', 'cppu-credit', 'cppu-credit-ledger', 'cppu-cx', 'cppu-exam', 'cppu-room', 'cppu-card', 'cppu-award', 'cppu-calendar', 'cppu-growth', 'cppu-profile']) assert.ok(source.includes(`view: "${v}"`), `校园服务栏必须有 ${v} 入口`);
assert.match(source, /url\.startsWith\("view:"\)\) \{ tide\.util\.navigate\("plug:" \+ url\.slice\(5\)\)/,
  'view: 入口必须在插件内切视图，而不是开系统浏览器（教务 SPA 没有 URL 深链）');
assert.match(source, /data-goto="\$\{esc\("view:" \+ item\.view\)\}"/,
  'view 入口必须渲染成 view:<视图 id>，不能拿 undefined 的 item.url 去渲染 data-goto');

/* 字典与学期码：未命中的码一律原样显示 */
assert.equal(jwDict('JC', '03'), '5-6', '节次要按校方字典翻成 5-6 节');
assert.equal(jwDict('SQZT', '1'), '审批中');
assert.equal(jwDict('KCSX', '99'), '99', '未知码必须原样显示，不许编一个好听的词');
assert.equal(jwDict('KCSX', ''), '');
assert.equal(jwTermName('20252026-1'), '2025-2026 学年第 1 学期', '学期码 20252026-1 要读成人话');

/* ── 12. 用真机样本喂渲染函数：范围切换 / 已申请关联 / 分组统计 / 转义 ── */
const dayOffset = (n) => {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
jwState.term = { code: '20262027-1', name: '2026年秋季学期', jxStart: dayOffset(-21), weeks: 28 };  // 今天是第 4 周
jwState.loading = {}; jwState.at = {};
jwState.error = { xkTask: '', xkResult: '', qjRecord: '', qjCourse: '', cxCredit: '' };
jwState.courseScope = 'week';
jwState.data.qjRecord = [{ SKRQ: dayOffset(0), JC: '03', KCMC: '数字电子技术', JSXMS: '刘晓军', JSMC: 'A102', SQYY: '尊敬的老师<img src=x onerror=alert(1)>，因补考冲突', SQZT: '1', YWID: 'bc@17' }];
jwState.data.qjCourse = [
  { ID: 'bc@17', SKRQ: dayOffset(0), XQ: 4, JC: '03', KCMC: '数字电子技术', KCSX: '01', HJLX: '01', JS: '刘晓军', DDMC: 'A102', XF: 3 },
  { ID: 'yy@1', SKRQ: dayOffset(7), XQ: 5, JC: '02', KCMC: 'C语言程序设计A', KCSX: '01', HJLX: '03', JS: '邱宏', DDMC: 'B501', XF: 3 },
];
const leaveWeek = jwLeaveHtml();
assert.ok(leaveWeek.includes('数字电子技术') && !leaveWeek.includes('C语言程序设计A'), '「本周」不能串进下周的课次');
assert.ok(leaveWeek.includes('已申请'), '课次要按 YWID ↔ 课次 ID 关联出「已申请」');
assert.ok(leaveWeek.includes('审批中') && leaveWeek.includes('5-6节'), '请假状态与节次都要走字典翻成人话');
assert.ok(!leaveWeek.includes('<img src=x') && leaveWeek.includes('&lt;img src=x'), '请假理由是自由文本，必须转义后再进 HTML');
jwState.courseScope = 'today';
assert.ok(jwLeaveHtml().includes('数字电子技术'), '「今天」按上课日期精确匹配');
jwState.courseScope = 'term';
const leaveTerm = jwLeaveHtml();
assert.ok(leaveTerm.includes('C语言程序设计A') && leaveTerm.includes('class="jw-row"'), '「本学期」是 200+ 节，必须走紧凑行而不是卡片');
jwState.data.xkResult = [
  { KCH: '1zb1X004K', KCMC: '多旋翼无人机组装与调试', KCSX: '02', XKBMC: '选_1', XF: 1, SKDD: '消训楼410', KKXNXQ: '20262027-1', KKXNXQNAME: '2026年秋季学期', OPERATERCODE: '2025290058' },
  { KCH: '1zc1X011K', KCMC: '反邪教研究', KCSX: '02', XKBMC: '选_2', XF: 1, SKDD: 'A204', KKXNXQ: '20262027-1', KKXNXQNAME: '2026年秋季学期', OPERATERCODE: '8712c0c67d92ff2fe5da1e36591bb80d' },
];
const resultHtml = jwResultHtml();
assert.ok(resultHtml.replace(/<[^>]*>/g, '').includes('2026年秋季学期 · 2 门 · 2 学分'), '已选课程按学期分组并合计学分');
assert.ok(resultHtml.includes('本人自选') && resultHtml.includes('教务代选'), 'OPERATERCODE 是学号=本人自选，是 uuid=教务代选');

/* 剩余学时（v0.271.0）：课次表按课程号对齐 —— 总学时 ΣKXXS，已上只算 SKRQ ≤ 今天的那些。
   选课结果视图自己没有学时字段，所以这里必须验证「对齐」与「不为没数据的课编数」两件事。 */
jwState.data.qjCourse = [
  { ID: 'h@1', KCH: '1zb1X004K', KCMC: '多旋翼无人机组装与调试', KXXS: '2', ZXS: '4', SKRQ: '2026-09-07' },
  { ID: 'h@2', KCH: '1zb1X004K', KCMC: '多旋翼无人机组装与调试', KXXS: '2', ZXS: '4', SKRQ: '2099-01-06' },
];
assert.deepEqual({ ...jwHoursRest(jwState.data.xkResult[0]) }, { total: 4, done: 2, rest: 2 }, '剩余学时 = 总学时 − 已上课时（后半个学期还没上的课次不算已上）');
const hoursHtml = jwResultHtml();
assert.ok(hoursHtml.includes('剩余 2 学时'), '已选课程卡片要标出剩余学时');
assert.match(hoursHtml, /class="jw-tag hours">剩余 2 学时</, '剩余学时标签要带自己的样式类');
assert.match(hoursHtml, /本人自选<\/span><span class="jw-tag hours">剩余 2 学时</, '学时标签排在标签行最后 —— 在「本人自选/教务代选」之后，不去挤教室号（v0.271.1）');
assert.equal((hoursHtml.match(/剩余 \d+ 学时/g) || []).length, 1, '没有排课次的课程（慕课等）一律不给学时标签，绝不按学分折算编一个数');
jwState.data.qjCourse = [
  { ID: 'h@1', KCH: '1zb1X004K', KCMC: '多旋翼无人机组装与调试', KXXS: '2', SKRQ: '2026-09-07' },
];
assert.ok(jwResultHtml().includes('学时已上完'), '剩余 0 时说「学时已上完」，不显示「剩余 0 学时」');
assert.ok(!jwResultHtml().includes('剩余 0 学时'), '剩余学时为 0 时不要保留「剩余 0」这种读不通的文案');
jwState.data.qjCourse = [{ ID: 'h@3', KCMC: '反邪教研究', KXXS: '2', SKRQ: '2099-03-01' }];
assert.deepEqual({ ...jwHoursRest(jwState.data.xkResult[1]) }, { total: 2, done: 0, rest: 2 }, '课次行没给课程号时按课程名对齐，不能因为缺号就把整学期学时算给某一门课');
jwState.data.qjCourse = [];
assert.equal(jwHoursRest(jwState.data.xkResult[0]), null, '课次表为空时不给学时结论');
assert.deepEqual(Array.from(JW_VIEWS.find((v) => v.id === 'cppu-xk').keys), ['xkTask', 'xkResult', 'qjCourse'], '选课视图要多拉课次表，剩余学时才有数据来源');
jwState.data.xkTask = [
  { ID: 'active-task', XKRWMC: '2026年秋季学期线上选修课（慕课）选课', KKXNXQ: '20262027-1', LC: '2', XKRWZT: '2' },
  { ID: 'old-task', XKRWMC: '2025年秋季学期新生选修课选课', KKXNXQ: '20252026-1', LC: '3', XKRWZT: '3' },
];
const taskHtml = jwTaskHtml();
assert.ok(taskHtml.includes('慕课') && taskHtml.includes('第 2 轮'), '选课任务要显示轮次，学期码要翻成学期名');
assert.ok(taskHtml.includes('data-jw-task="active-task"'), '选课任务卡必须可点击进入应用内选课页');
assert.match(taskHtml, /jw-task-card live[\s\S]*正在选课/, '正在选课的任务要显示红色活动状态');
assert.match(taskHtml, /jw-task-card expired[\s\S]*2025年秋季学期新生选修课选课/, '已结束或旧学期任务必须置灰');
assert.equal(jwTaskStatus(jwState.data.xkTask[1]).label, '结束选课', '状态码 3 必须翻成结束选课');
jwState.selectedTaskId = 'active-task';
const taskDetail = jwTaskDetailHtml();
assert.ok(taskDetail.includes('返回任务列表') && taskDetail.includes('本学期已选课程'), '点击任务后的 U-Time 页面要能返回并展示本学期已选课程');
assert.ok(taskDetail.includes('进入教务办理选课'), '正在选课任务要保留最终办理入口');
jwState.selectedTaskId = 'old-task';
assert.ok(!jwTaskDetailHtml().includes('进入教务办理选课'), '已结束任务只能查看，不能显示成仍可办理');
jwState.selectedTaskId = '';
assert.ok(source.includes('const taskBtn = e.target.closest("[data-jw-task]")'), '选课任务点击必须在插件内切换详情页');
jwState.data.creditPlan = [{ KCZXF: 157, KCBXXF: 125, KCXXXF: 32, SJKCZXF: 13 }];
// creditModule 是教务「我的学分」(V_JWBZK_XKGL_XKQK) 的原样形状：按培养方案顺序回，
// 学分字段是补位字符串（"             43.0"），模块码与界面顺序完全无关（军事教育课程=28）。
jwState.data.creditModule = [
  { KCMK: '28', KCSX: '01', XFYQ: '              5.0', HDXF: '              5.0', YXXF: '              0.0', DXXF: '              0.0' },
  { KCMK: '23', KCSX: '01', XFYQ: '             43.0', HDXF: '             27.0', YXXF: '              0.0', DXXF: '             16.0' },
  { KCMK: '21', KCSX: '02', XFYQ: '              2.0', HDXF: '              2.0', YXXF: '              0.0', DXXF: '              0.0' },
  { KCMK: '20', KCSX: '02', XFYQ: '              4.0', HDXF: '              0.0', YXXF: '              3.0', DXXF: '              4.0' },
  { KCMK: '99', KCSX: '02', XFYQ: '              2.0', HDXF: '              0.0', YXXF: '              0.0', DXXF: '              2.0' },
  { KCMK: '30', KCSX: '03', XFYQ: '              6.0', HDXF: '              0.0', YXXF: '              0.0', DXXF: '              6.0' },
];
jwState.data.grade = [
  { KCMC: '军事理论', XF: 2, KCSX: '01', KCMK: '28', SFHDXF: '1', ZPCJ: 88, XNXQ: '20252026-1' },
  { KCMC: '高等数学（理）2', XF: 4, KCSX: '01', KCMK: '23', SFHDXF: '2', ZPCJ: 29, XNXQ: '20252026-2' },
  { KCMC: '人工智能导论（慕课）', XF: 1, KCSX: '02', KCMK: '21', SFHDXF: '1', ZPCJ: 90, XNXQ: '20252026-1' },
  { KCMC: '无人机操控实训', XF: 1, KCSX: '02', KCMK: '20', SFHDXF: '2', ZPCJ: 55, XNXQ: '20262027-1' },
  { KCMC: '方案外无模块码的课', XF: 1, KCSX: '02', SFHDXF: '2', ZPCJ: 40, XNXQ: '20252026-2' },
];
assert.equal(jwGradeDone(jwState.data.grade[0]), true);
assert.equal(gradeSemLabel('20252026-1'), '2025-2026 学年 · 秋');
assert.equal(gradeGpa([{ XF: 2, JD: 4 }, { XF: 1, JD: 1 }]), 3);
let gradePage = jwGradesHtml();
for (const title of ['总学分', '平均绩点', '📈 GPA 走势', '🎯 学分进度', '📊 成绩分布', '🎓 课程构成', '📤 导出成绩单'])
  assert.ok(gradePage.includes(title), `APK 成绩页应包含 ${title}`);
assert.ok(gradePage.includes('2025-2026 学年 · 春') && gradePage.includes('高等数学（理）2'), '按学期列出全部课程');
assert.ok(gradePage.includes('共 5 门 · 总学分 9.0'), '成绩首页须汇总课程数和总学分');
assert.ok(gradePage.includes('参考毕业学分') && gradePage.includes('170（仅供参考）'), '参考毕业学分口径与 APK 相同');
assert.ok(gradePage.includes('data-grade-export'), '导出成绩单按钮应可点击');
assert.ok(gradePage.includes('绩点排名情况') && gradePage.includes('六维图'), '警大成绩下面须有绩点排名情况与六维图两张卡');
jwState.data.pdataStudy = { ok: true, auth: false, message: '', at: Date.now(),
  rank: { QXPM: 6519, XYPM: 622, ZYPM: 145, BJPM: 30 },
  myPoint: { QXPM: 86.4, XYPM: 86.4, ZYPM: 86.4, BJPM: 86.4 },
  topPoint: { QXPM: 572.2, XYPM: 457.3, ZYPM: 457.3, BJPM: 213.8 } };
const rankPage = pdataRankCard();
for (const t of ['全校排名', '学院排名', '专业排名', '班级排名', '数据来源'])
  assert.ok(rankPage.includes(t), `绩点排名情况应包含 ${t}`);
assert.ok(rankPage.includes('>6519<') && rankPage.includes('>622<') && rankPage.includes('>145<') && rankPage.includes('>30<'),
  '四档排名要取成长中心的 RANKING 值（实测 2025 级：全校 6519 / 学院 622 / 专业 145 / 班级 30）');
// 版式与图标照抄站点「绩点排名情况」：左 65px 圆底 + 36×40 图标，右 20px 蓝字数字、下面灰字标签。
// 站点把四个图标内联在 umi.js 里（54×59 PNG 的 data URI），插件原样内嵌、不重画。
const rankIcons = rankPage.match(/data:image\/png;base64,[A-Za-z0-9+/=]+/g) || [];
assert.equal(rankIcons.length, 4, '四档排名各要有一张站点图标');
assert.equal(new Set(rankIcons).size, 4, '四个档位的图标必须各不相同');
assert.match(rankPage, /<b class="jg-rank-num">6519<\/b><small>全校排名<\/small>/, '站点版式：数字在上、标签在下');
assert.ok(rankPage.includes('jg-rank-badge'), '图标要坐在站点那个圆底里');
assert.ok(source.includes('const PDATA_RANK_ICONS = {'), '图标要以 PDATA_RANK_ICONS 常量内嵌在插件里');
for (const key of ['QXPM', 'XYPM', 'ZYPM', 'BJPM'])
  assert.ok(source.includes(`    ${key}: "data:image/png;base64,`), `PDATA_RANK_ICONS 要有 ${key}`);
const radarPage = pdataRadarCard();
assert.ok(radarPage.includes('<svg') && radarPage.includes('jg-radar'), '六维图应画成内联 SVG 雷达图');
assert.ok(radarPage.includes('本人绩点') && radarPage.includes('学霸绩点'), '六维图要有本人/学霸两组图例');
for (const t of ['全校', '学院', '专业', '班级']) assert.ok(radarPage.includes(t), `六维图轴应包含 ${t}`);
assert.equal(pdataRadarSvg({ QXPM: 2, XYPM: 0, ZYPM: 0, BJPM: 0 }, { QXPM: 4, XYPM: 0, ZYPM: 0, BJPM: 0 }).includes('NaN'), false,
  '轴刻度为 0 时不能算出 NaN 坐标');
jwState.data.pdataStudy = { ok: true, auth: false, message: '', at: Date.now(),
  rank: { QXPM: 0, XYPM: 0, ZYPM: 0, BJPM: 0 },
  myPoint: { QXPM: 0, XYPM: 0, ZYPM: 0, BJPM: 0 },
  topPoint: { QXPM: 0, XYPM: 0, ZYPM: 0, BJPM: 0 } };
assert.ok(pdataRankCard().includes('暂未算出') && pdataRadarCard().includes('暂未算出'),
  '新生还没有排行数据时要给出占位而不是空白');
jwState.data.pdataStudy = { ok: false, auth: true, message: '', at: Date.now(),
  rank: { QXPM: 0, XYPM: 0, ZYPM: 0, BJPM: 0 }, myPoint: {}, topPoint: {} };
assert.ok(pdataRankCard().includes('警大通知') && pdataRadarCard().includes('警大通知'),
  '个人成长中心登录态缺失时应指路到警大通知登录');
jwState.data.pdataStudy = null;
assert.ok(jwGradesHtml().includes('还没有拉取过绩点排名'), '未拉取过时给出刷新提示');
// 回归：pdata 学生端按 token 认人，URL 上再挂 _USER 会被服务端当筛选条件用，
// 排行/学情/个人信息等接口会一律返回空集或 code:-1（v0.220.1 修的正是这个）。
const pdataApiBody = source.slice(source.indexOf('async function pdataApi'), source.indexOf('async function pdataApi') + 900);
assert.ok(!pdataApiBody.includes('_USER'), 'pdataApi 不能给 URL 拼 _USER');
assert.match(pdataApiBody, /const url = PDATA \+ path;/, 'pdataApi 直接用调用方给的 path，不追加查询参数');
const drawn = [];
context.document.createElement = () => ({
  getContext: () => ({ fillRect: () => {}, measureText: (s) => ({ width: s.length * 14 }), fillText: (s) => drawn.push(s) }),
  toBlob: (cb) => cb({}), toDataURL: () => 'data:image/png;base64,UE5H',
});
context.File = class { constructor(parts, name) { this.name = name; } };
context.navigator = {};
await jwExportGrades();
assert.ok(drawn.includes('成绩单') && drawn.some((s) => s.includes('平均分')), '导出图应含 APK 的标题和成绩汇总');
assert.ok(saved.some(([name, data]) => name.startsWith('成绩单-') && data === 'UE5H'), '成绩图片应通过宿主下载桥落盘');
// 桌面端 WebView 有导航器分享接口但不支持分享文件，必须直接走落盘，不能弹空面板把兜底截胡。
{
  const before = saved.length;
  let shared = 0;
  context.navigator = { share: async () => { shared++; } };
  await jwExportGrades();
  assert.equal(shared, 0, '没有 canShare 时不得调用 navigator.share（桌面端会挂出空白共享面板）');
  assert.equal(saved.length, before + 1, '没有 canShare 必须回落到宿主下载桥保存');
  context.navigator = { share: async () => { shared++; }, canShare: () => false };
  await jwExportGrades();
  assert.equal(shared, 0, 'canShare 明确返回 false 时不得调用 navigator.share');
  assert.equal(saved.length, before + 2, 'canShare 返回 false 必须回落到宿主下载桥保存');
  context.navigator = { share: async () => { shared++; }, canShare: () => true };
  await jwExportGrades();
  assert.equal(shared, 1, 'canShare 返回 true 时应走原生分享');
  assert.equal(saved.length, before + 2, '走原生分享时不再重复落盘');
  context.navigator = {};
  // 用户取消分享（AbortError）静默返回，不落盘也不报错。
  context.navigator = { share: async () => { const e = new Error('abort'); e.name = 'AbortError'; throw e; }, canShare: () => true };
  await jwExportGrades();
  assert.equal(saved.length, before + 2, '用户取消分享不应再落盘');
  context.navigator = {};
}
jwState.data.grade.push({ KCMC: '<img src=x onerror=alert(1)>', XF: 1, JD: 2, ZPCJ: 66, XNXQ: '20262027-2' });
gradePage = jwGradesHtml();
assert.ok(!gradePage.includes('<img src=x'), '成绩接口返回的课程名必须转义');
jwState.data.grade.pop();
assert.ok(!pdataRadarSvg({}, {}).includes('NaN'), '成长中心返回空对象时雷达图仍要画得出来');
assert.equal(jwDict('KCMK', '28'), '军事教育课程', '模块名必须取教务字典 KCMKDM_1');
assert.equal(jwDict('KCMK', '01'), '自然科学', '模块码与培养方案里的顺序无关，不能按界面次序排号');
let academicCredit = jwAcademicCreditHtml();
assert.ok(academicCredit.includes('必修学分') && academicCredit.includes('2 / 125'), '警大学分必须按培养计划统计必修目标和已获学分');
assert.ok(academicCredit.includes('选修学分') && academicCredit.includes('1 / 32'), '警大学分必须单独统计选修学分');
assert.ok(academicCredit.includes('实践学分') && academicCredit.includes('0 / 13'), '警大学分必须单独统计实践学分');
assert.ok(!academicCredit.includes('军事理论'), '未点开学分卡时不铺课程明细');
assert.match(academicCredit, /data-credit-toggle="elective"[^>]*aria-expanded="false"/, '学分卡必须是可点击的展开按钮');
jwState.expandedCredit.add('elective');
academicCredit = jwAcademicCreditHtml();
assert.ok(academicCredit.includes('已获得学分') && academicCredit.includes('未获得学分'), '展开后课程明细必须显示是否修完');
// 在修但还没出分的课：不能按「未获得」画红框，那会让人以为自己挂了
jwState.data.grade.push({ KCMC: '在修无成绩的课', XF: 2, KCSX: '02', KCMK: '20', SFHDXF: '', XNXQ: '20262027-1' });
const doingPage = jwAcademicCreditHtml();
assert.ok(doingPage.includes('在修 · 未出分'), '没有成绩的课要标「在修 · 未出分」');
assert.ok(!(doingPage.split('在修无成绩的课')[1] || '').slice(0, 400).includes('未获得学分'), '没出分的课不得显示「未获得学分」');
assert.ok(/jw-credit-course doing/.test(doingPage), '在修的课不打失败红框');
jwState.data.grade.pop();
assert.ok(academicCredit.includes('4 个课程模块'), '展开后必须按教务的课程模块分组');
assert.ok(academicCredit.includes('实践技能任选 · 已获得 0 / 要求 4 学分 · 在修 3 · 待修 4'), '模块行要用教务自己的要求/获得/在修/待修，补位字符串要解析成数字');
assert.ok(academicCredit.includes('模块 99 · 已获得 0 / 要求 2 学分 · 待修 2'), '字典没这条码时原样显示模块码，不编类名');
assert.ok(academicCredit.includes('未标注模块 · 1 门 · 已获得 0 / 修读 1 学分'), '没有模块码的课程单独成组，不并进别的模块');
jwState.expandedCredit.add('required');
academicCredit = jwAcademicCreditHtml();
assert.ok(academicCredit.includes('军事教育课程 · 已获得 5 / 要求 5 学分 · 1 门'), '模块组要显示教务模块名和挂在这一模块下的课程数');
assert.ok(academicCredit.includes('公共基础 · 已获得 27 / 要求 43 学分 · 待修 16'), '必修模块必须用教务回的名字，不再显示模块码');
assert.ok(/data-credit-toggle="required" aria-expanded="true"/.test(academicCredit), '展开中的学分卡要标 aria-expanded');
jwState.expandedCredit.add('practice');
academicCredit = jwAcademicCreditHtml();
assert.ok(academicCredit.includes('毕业论文 · 已获得 0 / 要求 6 学分 · 待修 6'), '培养方案里还没有成绩记录的模块也要露面，否则看不到还欠多少学分');
jwState.creditHideDone = true;
academicCredit = jwAcademicCreditHtml();
assert.ok(!academicCredit.includes('军事理论') && academicCredit.includes('高等数学（理）2'), '隐藏已修完后只保留未获得学分的课程');
assert.ok(academicCredit.includes('已隐藏 1 门'), '隐藏掉的门数要在模块组上交代，不能悄悄少课');
assert.ok(academicCredit.includes('未标注模块 · 1 门 · 已获得 0 / 修读 1 学分'), '隐藏已修完时没修完的散课仍然要留着，不能跟着一起消失');
jwState.creditHideDone = false;
jwState.expandedCredit.clear();
jwState.data.cxCredit = [{ DECLARE_YEAR_SEMESTER: '20252026-2', SUM_VALUE: 7, APPLYALL: 7, END_VALUE: 4, XQMC: '廊坊校区', XYDMC: '防火工程二队' }];
jwState.data.cxDetail = [{
  DECLARE_YEAR_SEMESTER: '20252026-2', CONTENT: '全国大学生计算机应用能力与数字素养大赛人工智能应用基础赛项',
  ASSESSMENT_ITEMS: '学科竞赛', CATEGORY: '省部级', ASSESSMENT_CONTENTS_STANDARDS: '三等奖', CREDIT_VALUE: 1,
  SY_AUDFLAG: 'ENDED', SY_CURRENTTASK: '已结束', REASONS_FOR_APPLYING_CREDIT: '竞赛学值分奖励', DECLARATION_DATE: '2026-09-13 19:14:13',
}];
const innovationCredit = jwInnovationCreditHtml();
assert.ok(innovationCredit.includes('创新实践学分') && innovationCredit.includes('申请 7 项 / 已认定 4 项'), '创新学分要保留已发布汇总');
assert.ok(innovationCredit.includes('人工智能应用基础赛项') && innovationCredit.includes('省部级') && innovationCredit.includes('三等奖'), '创新学分必须显示真实项目、级别和奖项');
assert.ok(!innovationCredit.includes('CREDIT_APPLICATIONID_ID') && !innovationCredit.includes('STUDENT_XH'), '创新学分页面不得把数据库内部字段当作项目明细');
assert.ok(source.includes('V_JWBZK_JXJH_JXJH') && source.includes('V_JWBZK_XKGL_XKQK') && source.includes('V_STUDENT_GRADE'), '警大学分必须读取培养计划、教务「我的学分」模块进度和成绩接口');
assert.ok(source.includes('T_SZKP_CXGL_CREDITAPPLICATION_STU'), '创新学分必须读取申报项目明细接口');
for (const k of Object.keys(jwState.data)) jwState.data[k] = null;

/* ── 13. 教务视图冷启动自举：不先打开「警大通知」也必须能自动登录 ──────────
   创新学分 / 选课 / 请假 / 警大学分四个视图与通知视图同属一个插件，但门户会话的引导
   过去只写在通知视图的 render() 里 —— 从侧栏直接点进教务视图永远拿不到登录态，
   只能甩一句「请先在警大通知里完成登录」。现在登录代码只有一份，教务取数自带引导。 */
assert.ok(!source.includes('请先在「警大通知」里完成登录'), '教务取数不得再把用户支回警大通知手工登录');
const jwFlow = (rows = [{ XH: '2025290058' }]) => (sid, method, url, opts = {}) => {
  if (url.startsWith('https://sso-jw.cppu.edu.cn/tpass/login')) return { status: 302, body: '', finalUrl: url, location: 'https://jw.cppu.edu.cn/cas_callback?ticket=ST-boot', cookies: [] };
  if (url.startsWith('https://jw.cppu.edu.cn/cas_callback')) return { status: 200, body: '<html>智慧教务</html>', finalUrl: 'https://jw.cppu.edu.cn/index.html', location: '', cookies: [] };
  if (url.endsWith('/je/develop/funcInfo/getStaticFuncByCode')) return jeMetaJson(jeMeta(opts));
  if (url.startsWith('https://jw.cppu.edu.cn/je/load')) return jeJson(rows);
  return { status: 404, body: '', finalUrl: url, location: '', cookies: [] };
};

// ① 冷启动：密钥库里只有门户 Cookie（没有教务 authorization）→ 恢复会话 → 换票 → 拉到数据
await clearSavedLogin();
state.sid = null; state.token = ''; delete storageData.username;
vaultData.cookies = JSON.stringify([{ url: 'https://portal-jw.cppu.edu.cn', cookie: 'tp_up=old-ticket' }]);
calls = []; response = jwFlow();
assert.equal(await ensureJwLogin(), true, '只恢复门户 Cookie 也要把教务登录态建起来');
assert.equal(jwLive(), true, '引导成功后教务会话必须落在当前会话上');
assert.equal(calls[0][0], 'restore', '引导的第一步是恢复密钥库里的 Cookie');
assert.equal((await jeLoad('cxCredit'))[0].XH, '2025290058', '登录态建好后取数不该再要求先打开警大通知');

// ② 单飞：两个教务视图同时挂载只引导一次（否则会并排跑两套验证码登录）
await clearSavedLogin();
state.sid = null; state.token = '';
vaultData.cookies = JSON.stringify([{ url: 'https://portal-jw.cppu.edu.cn', cookie: 'tp_up=old-ticket' }]);
calls = []; response = jwFlow();
assert.deepEqual(await Promise.all([ensureJwLogin(), ensureJwLogin()]), [true, true]);
assert.equal(calls.filter((c) => c[0] === 'restore').length, 1, '并发引导必须合流');

/* 门户会话彻底没了的样子：要票只回一张登录页，验证码那张图解码不了（= OCR 认不出） */
const jwDead = (sid, method, url, opts = {}) => {
  if (url.includes('/tpass/captcha.jpg')) return { status: 200, body: '', finalUrl: url, location: '', cookies: [] };
  if (url.includes('/tpass/login')) return { status: 200, body: '<html>name="execution" value="exec-9"</html>', finalUrl: url, location: '', cookies: [] };
  return jwFlow()(sid, method, url, opts);
};

// ③ 票据彻底失效但存过密码：自己去走「验证码自动识别」，认不出来就如实报未登录
await clearSavedLogin();
state.sid = null; state.token = '';
storageData.username = '2025290058'; vaultData.secret = JSON.stringify({ password: 'pw' });
calls = []; response = jwDead;
assert.equal(await ensureJwLogin(), false, '验证码一张都没认出来时不能谎报已登录');
assert.equal(calls.filter((c) => String(c[2]).includes('/tpass/captcha.jpg')).length, state.loginRetries + 2, '按设置准备首次及重试验证码，耗尽后另准备一张人工表单验证码（不额外提交）');
assert.equal(calls.filter(c=>c[1]==='POST' && String(c[2]).includes('/tpass/login')).length, 0, 'OCR 未识别时不能提交空验证码');
await assert.rejects(() => jeLoad('cxCredit'), /登录/, '登录没成就要明确报错，不能静默交空列表');

// ④ 既没 Cookie 也没密码：不去白抓验证码，直接判需要人工登录
await clearSavedLogin();
state.sid = null; state.token = ''; delete storageData.username;
calls = []; response = jwDead;
assert.equal(await ensureJwLogin(), false);
assert.equal(calls.filter((c) => String(c[2]).includes('/tpass/captcha.jpg')).length, 0, '没有凭据就不要去抓验证码');

// ⑤ 人工兜底复用同一张登录卡：登录成功后回到发起它的那个视图，而不是跳去通知列表
assert.match(source, /function paintLogin\(el, errMsg, opts = \{\}\)/, '登录卡必须带 opts 才能被各视图复用');
assert.ok(source.includes('opts.onDone'), '登录卡必须能回调到发起登录的那个视图');

/* ── 14. 横幅即刷新入口（用户要求「点击这个横幅也可以刷新」）─────────────────
   教务只读视图里「登录失败，正在显示缓存」那条 .pp-banner 过去是死文字，只能去点上方工具栏。
   现在整条是 <button data-jw-banner-refresh>，由 mountJwView 的 click 委托接到
   和工具栏「刷新」同一个 jwEnsureKeys(keys, true)。下面先用真源码渲染函数验形态，
   再把真视图挂到一个假 DOM 上、真点一次，验「点了确实会去打接口」。 */
jwState.loading = {};
jwState.error = { xkTask: '登录失败，正在显示缓存（更新于 09/22 13:21）；点这条横幅或上方「刷新」可重试，需要重新登录时点「重新登录」。' };
const banner = jwStateBlock('xkTask');
assert.ok(banner.startsWith('<button type="button" class="pp-banner pp-banner-act" data-jw-banner-refresh>') && banner.endsWith('</button>'),
  '错误横幅必须整条渲染成可点的 button，而不是原来那个死 <div class="pp-banner">');
assert.ok(banner.includes('<span class="pp-banner-txt">登录失败，正在显示缓存（更新于 09/22 13:21）') && banner.includes('<span class="pp-banner-act-hint">点击刷新</span>'),
  '横幅文案与「点击刷新」提示要落在同一个按钮里，光有 hover 颜色没人知道能点');
assert.ok(banner.includes('点这条横幅或上方「刷新」可重试'), '文案要正面告诉用户可以点横幅重试');
jwState.loading = { xkTask: true };
assert.equal(jwStateBlock('xkTask', '正在拉取选课任务…'), '<div class="pp-empty">正在拉取选课任务…</div>',
  '加载态保持纯文字占位、不能变按钮 —— 那时候再点只会叠一轮请求');
jwState.loading = {};
jwState.error = {};
assert.equal(jwStateBlock('xkTask'), '', '既没错误也不在加载时不留空盒子');
jwState.error = { xkTask: '<img src=x onerror=alert(1)> 教务接口 500' };
assert.ok(!/<img/.test(jwStateBlock('xkTask')) && jwStateBlock('xkTask').includes('&lt;img src=x'),
  '横幅文案是错误信息自由文本，拼进按钮前必须转义');
jwState.error = { xkTask: '登录失败，正在显示缓存（更新于 09/22 13:21）；点这条横幅或上方「刷新」可重试，需要重新登录时点「重新登录」。' };
jwState.data.xkTask = [{ ID: 'active-task', XKRWMC: '慕课选课', KKXNXQ: '20262027-1', LC: '2', XKRWZT: '2' }];
const taskWithBanner = jwTaskHtml();
assert.ok(taskWithBanner.includes('data-jw-banner-refresh'), '选课任务页的错误横幅也要能点，不能只在某一个页面生效');
assert.ok(taskWithBanner.indexOf('可参加的选课任务') < taskWithBanner.indexOf('data-jw-banner-refresh'),
  '横幅要挂在本小节标题下面，不能被标题甩在后面');
for (const k of Object.keys(jwState.data)) jwState.data[k] = null;
assert.ok(source.includes('if (e.target.closest("[data-jw-banner-refresh]")) {') &&
  source.includes('await jwRefreshWithFeedback(e.target.closest("[data-jw-banner-refresh]"), cfg.keys);'),
  '横幅点击必须接在 jwEnsureKeys(keys, true) 上 —— 和工具栏「刷新」同一条通路，不许另写一套取数');
// 这条通路现在被 jwRefreshWithFeedback 包了一层（按钮变「刷新中…」+ 回一句结果），
// 前提是它里面仍然只调 jwEnsureKeys(keys, true)：别在这层偷偷写第二套取数或跳过强制刷新。
assert.ok(/const jwRefreshWithFeedback = async \(btn, keys\) => \{[\s\S]{0,800}?await jwEnsureKeys\(keys, true\);/.test(source),
  'jwRefreshWithFeedback 内部必须 await jwEnsureKeys(keys, true)');
assert.ok(source.includes('if (e.target.closest("[data-jw-refresh]")) {') &&
  source.includes('await jwRefreshWithFeedback(e.target.closest("[data-jw-refresh]"), cfg.keys);'),
  '工具栏「刷新」也必须走同一条带反馈的通路');
assert.ok(source.includes('.pp-banner-act:focus-visible{outline:3px solid var(--deep'),
  '横幅变成按钮后必须有 focus-visible 焦点环，且要跟着 --deep 走（紫色风格下别留一圈青色）');
assert.ok(/\.pp-banner-act,\.pp-banner-act-hint::before\{transition-duration:\.01ms!important\}/.test(source),
  '横幅新增的 transition 要进 prefers-reduced-motion 白名单');

/* 真挂一次视图 + 真点一次：假 DOM 只补 ensureStyle / jwPaint 用到的那几个接口 */
context.document.getElementById = () => null;
context.document.head = { append: () => {} };
const clickHandlers = [];
const fakeEl = {
  isConnected: true, innerHTML: '', dataset: {},
  addEventListener: (type, fn) => { if (type === 'click') clickHandlers.push(fn); },
  querySelector: () => null,
  querySelectorAll: () => [],
};
const bannerClick = { target: { closest: (sel) => (sel === '[data-jw-banner-refresh]' ? {} : null) } };
const waitFor = async (cond, why) => {
  for (let i = 0; i < 200; i++) { if (cond()) return; await new Promise((r) => setTimeout(r, 5)); }
  assert.fail(`等待超时：${why}`);
};

// ① 登录态坏了但缓存还在（就是截图那一眼）：挂载后应挂出可点的横幅，点它必须再打一轮接口
await clearSavedLogin();
state.sid = null; state.token = '';
storageData.username = '2025290058';
vaultData.secret = JSON.stringify({ password: 'pw' });
vaultData.cookies = JSON.stringify([{ url: 'https://portal-jw.cppu.edu.cn', cookie: 'tp_up=expired-ticket' }]);
storageData.jwCache = {
  at: { xkTask: Date.parse('2026-09-22T13:21:00'), xkResult: Date.parse('2026-09-22T13:21:00') },
  keep: { xkTask: [{ ID: 'old-task', XKRWMC: '缓存里的旧任务', KKXNXQ: '20262027-1', XKRWZT: '3' }], xkResult: [] },
  prefs: {},
};
jwState.at = {}; jwState.loading = {}; jwState.error = {};
calls = []; response = jwDead;
mountJwView(fakeEl, JW_VIEWS.find((v) => v.id === 'cppu-xk'));
const refreshClick = clickHandlers.find((fn) => fn.constructor?.name === 'AsyncFunction');
assert.ok(refreshClick, 'mountJwView 必须把点击委托挂在视图根节点上（否则横幅点了没反应）');
await waitFor(() => String(jwState.error.xkTask || '').includes('登录失败'), '登录失败时视图要挂出「正在显示缓存」横幅');
assert.ok(jwTaskHtml().includes('data-jw-banner-refresh'), '截图那种状态（登录失败 + 缓存）下，横幅必须是可点的按钮');
const beforeRetry = calls.length;
await refreshClick(bannerClick);
assert.ok(calls.length > beforeRetry, '点横幅必须真的再发一轮请求，不能只是重画一遍页面');
assert.ok(!jwState.loading.xkTask && !jwState.loading.xkResult, '点完横幅两个 key 的加载态都要收干净，不能卡在「正在拉取」');
assert.ok(jwTaskHtml().includes('data-jw-banner-refresh'), '这次还是登不上就要留着横幅，让用户能一直点重试（而不是变成死文字）');

// ② 网络/登录恢复后：点横幅要真的把新数据拉回来，并把旧错误清掉
calls = []; response = jwFlow([{ KCMC: '横幅刷新回来的课' }]);
delete vaultData.secret; delete storageData.username;
const beforeRefresh = calls.length;
await refreshClick(bannerClick);
assert.ok(calls.length > beforeRefresh, '横幅刷新同样要走真实取数链路');
assert.equal(jwState.error.xkTask, '', '刷新成功后旧横幅必须清掉');
assert.equal(jwState.error.xkResult, '', '点一条横幅要刷整个视图的 keys，另一条的旧提示不能留着当「刷了没用」');
assert.equal(jwState.data.xkTask[0].KCMC, '横幅刷新回来的课', '横幅刷新要把新数据真的拉回来');
assert.ok(jwState.at.xkTask > 0, '刷新成功要盖新的时间戳，副标题的「更新于」才会跟着走');
assert.ok(!jwTaskHtml().includes('data-jw-banner-refresh'), '数据到手后横幅要自己消失');

/* ③ 配色必须由主题令牌派生（v0.190.0「颜色适配 nephele 风格」）：
   过去横幅是浅米黄硬编码，换主题 / 切深色 / 开 Nephele 都不跟随。现在底色、描边、正文、
   右侧提示全部走 color-mix(令牌)，所以守则也换了：先按 CSS 里真正写的令牌与百分比取数，
   再把 34 张色板（16 套主题 × 浅深 + Nephele 浅深）逐张代进公式实算 WCAG AA。
   改了百分比测试会跟着重算，而不是守住某个写死的色值。 */
const bannerBase = ruleDecls(source, '.pp-banner');
const bannerHint = ruleDecls(source, '.pp-banner-act-hint');
const bannerStates = {
  静止: bannerBase,
  悬停: ruleDecls(source, '.pp-banner-act:hover'),
  按下: ruleDecls(source, '.pp-banner-act:active'),
};
const bodyToken = /^var\((--[\w-]+)/.exec(bannerBase.color || '')?.[1];
assert.equal(bodyToken, '--ink', '横幅正文必须用 --ink（深色模式靠它翻成亮字），不能再写死米黄系色值');
for (const [state, decl] of Object.entries(bannerStates)) {
  const mix = colorMix(decl.background);
  assert.ok(mix, `${state}态的横幅底色必须是 color-mix 出来的`);
  assert.equal(mix.top, '--deep', `${state}态底色要从 --deep 派生 —— Nephele 把 --deep 换成薰衣草紫，横幅才会跟着变紫`);
  assert.equal(mix.bottom, '--bg', `${state}态底色要混在视图底色 --bg 上：横幅挂在视图顶部、不在卡片里，`
    + `而 Nephele 的 --bg(#ece5f4) 正好落在 --deep 与 --panel 的 12% 处 —— 混 --panel 会让底色和背景只差 1 个通道，等于看不见`);
}
// 米黄的这一族色值必须彻底消失（var() 的兜底值不算，那些在令牌缺失时才生效）
const bannerCss = Object.values(bannerStates).map((d) => `${d.background};${d['border-color'] || ''};${d.color}`).join(';') + ';' + bannerHint.color;
for (const old of ['#FFF7E8', '#FFF1D0', '#FDEBC2', '#8A6420', '#8A5A00', '#B26A00', '#E8C87F']) {
  assert.ok(!bannerCss.includes(old), `横幅配色不能再退回米黄硬编码 ${old}——换主题 / 切深色 / 开 Nephele 都跟不上`);
}
const hintMix = colorMix(bannerHint.color);
assert.ok(hintMix, '「点击刷新」提示色必须是 color-mix 出来的');
assert.equal(hintMix.top, '--deep', '提示色要从 --deep 派生');
assert.equal(hintMix.bottom, '--ink', '提示色必须混 --ink：纯 --deep 在 celadon 深色底上只有 3.86:1，过不了 AA');
const palettes = bannerPalettes((p) => readProductSource(new URL(p, import.meta.url), 'utf8'));
assert.equal(palettes.length, 34, '色板矩阵要盖住 16 套主题 × 浅 / 深 + Nephele 浅 / 深');
const statePct = Object.fromEntries(Object.entries(bannerStates).map(([s, d]) => [s, colorMix(d.background).pct]));
assert.ok(statePct.静止 < statePct.悬停 && statePct.悬停 < statePct.按下, `三档底色必须一档比一档重：${JSON.stringify(statePct)}`);
assert.ok(statePct.按下 <= 0.4, `按下态最多混到 40%，再重正文就压不住（当前 ${statePct.按下}）`);
let worstBody = { ratio: 99 }, worstHint = { ratio: 99 }, worstSep = { delta: 999 };
for (const { label, tokens } of palettes) {
  const surface = resolveToken(tokens, '--bg');
  for (const [state, decl] of Object.entries(bannerStates)) {
    const mix = colorMix(decl.background);
    const bg = mixHex(resolveToken(tokens, mix.top), resolveToken(tokens, mix.bottom), mix.pct);
    const body = contrastRatio(resolveToken(tokens, bodyToken), bg);
    const hint = contrastRatio(mixHex(resolveToken(tokens, hintMix.top), resolveToken(tokens, hintMix.bottom), hintMix.pct), bg);
    assert.ok(body >= 4.5, `${label} ${state}态：横幅正文只有 ${body.toFixed(2)}:1（底 ${bg}）`);
    assert.ok(hint >= 4.5, `${label} ${state}态：「点击刷新」提示只有 ${hint.toFixed(2)}:1（底 ${bg}）`);
    const sep = channelDelta(bg, surface);
    assert.ok(sep >= 16, `${label} ${state}态：横幅底色 ${bg} 与视图底色 ${surface} 只差 ${sep} 个通道，看起来会像没画出来`);
    if (body < worstBody.ratio) worstBody = { ratio: body, where: `${label} ${state}态` };
    if (hint < worstHint.ratio) worstHint = { ratio: hint, where: `${label} ${state}态` };
    if (sep < worstSep.delta) worstSep = { delta: sep, where: `${label} ${state}态` };
  }
}
assert.ok(worstBody.ratio >= 4.5 && worstHint.ratio >= 4.5,
  `全部色板都要过 WCAG AA：最差正文 ${worstBody.ratio.toFixed(2)}:1（${worstBody.where}）、最差提示 ${worstHint.ratio.toFixed(2)}:1（${worstHint.where}）`);
console.log(`横幅配色：${palettes.length} 张色板 × 3 态，最低对比度 正文 ${worstBody.ratio.toFixed(2)}:1（${worstBody.where}）、`
  + `提示 ${worstHint.ratio.toFixed(2)}:1（${worstHint.where}）；底色与视图底色最小通道差 ${worstSep.delta}（${worstSep.where}）`);

/* ── 15. 其他警大视图的失败横幅也整条可点（通知 / 一卡通）──────────────────
   用户的第二句要求：其他视图若有「登录失败 / 拉取失败」横幅，也照教务视图改成整条刷新。
   两处复用同一个 bannerRefreshHtml：形态与教务横幅一致，只是 data 标记不同。 */
assert.equal(bannerRefreshHtml('拉取失败：连接超时', 'banner-refresh'),
  '<button type="button" class="pp-banner pp-banner-act" data-banner-refresh><span class="pp-banner-txt">拉取失败：连接超时</span><span class="pp-banner-act-hint">点击刷新</span></button>',
  '通知视图的失败状态行要复用同一个横幅外壳');
assert.ok(bannerRefreshHtml('<img src=x onerror=alert(1)>', 'card-refresh').includes('&lt;img src=x'),
  '横幅文案是错误信息自由文本，拼进去之前必须转义');
assert.ok(bannerRefreshHtml('x', 'card-refresh').includes('data-card-refresh'), '一卡通横幅要带自己的 data 标记');
assert.ok(source.includes('ui.status.innerHTML = bannerRefreshHtml(state.error, "banner-refresh")'),
  '通知视图「登录失败 / 拉取失败」的状态行必须整条换成横幅');
assert.ok(source.includes('if (e.target.closest("[data-banner-refresh]")) loadPage(1);'),
  '点通知视图横幅要等于点工具栏「刷新」= loadPage(1)；状态行每次重绘都换按钮，所以挂容器委托');
assert.ok(source.includes('if (warn) status.innerHTML = bannerRefreshHtml(text, "card-refresh");'),
  '一卡通的状态行在 warn 时也要整条变成横幅');
assert.ok(source.includes("'refresh'"), '一卡通的点击委托要认得 refresh 这个动作名');
assert.ok(source.includes("if(name==='refresh'){"), '一卡通要真的处理 refresh：清旧错误、重新登录、再 sync');
assert.ok(source.includes('await sync(false); return;'), 'refresh 分支必须走到真正的取数（sync），不能只是重画');
// 真跑一次：把 warn / 正常两种状态抛进 cardSetStatus（根节点用假 DOM，只补 querySelector）
const cardStatusEl = {
  innerHTML: '', textContent: '',
  classList: { toggled: [], toggle(cls, on) { cardStatusEl.classList.toggled.push([cls, on]); } },
};
const cardRoot = { querySelector: (sel) => (sel === '[data-card-status]' ? cardStatusEl : null) };
cardSetStatus(cardRoot, '一卡通拉取失败：请检查网络后重试', true);
assert.equal(cardStatusEl.innerHTML, bannerRefreshHtml('一卡通拉取失败：请检查网络后重试', 'card-refresh'),
  '一卡通的失败提示要整条渲染成可点横幅');
cardSetStatus(cardRoot, '已同步 12 条流水', false);
assert.equal(cardStatusEl.textContent, '已同步 12 条流水', '非失败状态仍是普通文字，不能整页都是按钮');
assert.deepEqual(cardStatusEl.classList.toggled, [['warn', true], ['warn', false]], 'warn 类要跟着状态开关');

console.log('PASS: expand/collapse, loading, late response, cache, retry, paragraph preservation, API paths, bounded renewal, clickable 教务 banners and read-only 教务 views');
