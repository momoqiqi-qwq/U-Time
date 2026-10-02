import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../public/plugins/cppu-notify/main.js',import.meta.url),'utf8');
let response, calls=[], vaultData={}, storageData={}, opened=[], notices=[], views=[], saved=[];
const context = vm.createContext({URL,Set,Map,Date,console,setTimeout,clearTimeout,setInterval,clearInterval,
  document:{createElement:()=>({set innerHTML(x){this.value=x;}}),querySelectorAll:()=>[]},
  // 解码不了的验证码图 = OCR 认不出来，用来把「换图重试」循环逼到次数上限
  Image:class{constructor(){this.naturalWidth=0;this.naturalHeight=0;}set src(v){this._src=v;}decode(){return Promise.reject(new Error('cannot decode'));}},
  tide:{ui:{registerView:(def)=>{views.push(def);}},http:{session:async()=>'s1',restoreCookies:async(dump)=>{calls.push(['restore',dump]);return 'restored-sid';},fetch:async(...args)=>{calls.push(args);return typeof response==='function'?response(...args):response;}},storage:{set:async(k,v)=>{storageData[k]=v;},get:async(k,d)=>(k in storageData?storageData[k]:(d===undefined?null:d))},vault:{get:async(key)=>vaultData[key]||null,set:async(key,value)=>{vaultData[key]=value;},del:async(key)=>{delete vaultData[key];}},util:{openUrl:(url)=>opened.push(url),web:{formEncode:(fields)=>Object.entries(fields).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),detectLoginForm:(html,base)=>html.includes('name="uid"')?{action:new URL('/coremail/index.jsp?cus=1',base).href,method:'POST',usernameField:'uid',passwordField:'password',captchaField:'',fields:[{name:'action',value:'login'}]}:null}},notify:(message)=>notices.push(message),assets:{saveBase64:async(name,b64)=>{saved.push([name,b64]);return 'D:/Downloads/'+name;}}}
});
vm.runInContext(source.replace('  tide.ui.registerView({','  globalThis.testApi = {state,cardHtml,loadDetail,loadPage,newSession,cleanText,noticeKind,extractAttachments,downloadAttachment,OCR,restoreCookies,silentRenew,submitLogin,finishPortalLogin,openSideLink,openMailLink,jeLoad,explainHttpError,ensureJwSession,ensureJwLogin,jwLive,jwDict,jwTermName,clearSavedLogin,jwState,jwTaskStatus,jwTaskDetailHtml,jwTaskHtml,jwResultHtml,jwLeaveHtml,jwGradeDone,jwAcademicCreditHtml,jwGradesHtml,jwExportGrades,gradeGpa,gradeSemLabel,jwInnovationCreditHtml,cardState,cardIsRecharge,cardNormalizeBill,cardTotals,cardStatsHtml,cardBalanceFromDetail,cardFetchBalance,cardFetchBills,cardIsExpense};\n  tide.ui.registerView({'),context);
const {state,cardHtml,loadDetail,loadPage,newSession,cleanText,noticeKind,extractAttachments,downloadAttachment,OCR,restoreCookies,silentRenew,submitLogin,finishPortalLogin,openSideLink,openMailLink,jeLoad,explainHttpError,ensureJwSession,ensureJwLogin,jwLive,jwDict,jwTermName,clearSavedLogin,jwState,jwTaskStatus,jwTaskDetailHtml,jwTaskHtml,jwResultHtml,jwLeaveHtml,jwGradeDone,jwAcademicCreditHtml,jwGradesHtml,jwExportGrades,gradeGpa,gradeSemLabel,jwInnovationCreditHtml,cardState,cardIsRecharge,cardNormalizeBill,cardTotals,cardStatsHtml,cardBalanceFromDetail,cardFetchBalance,cardFetchBills,cardIsExpense}=context.testApi;
const item={RESOURCE_ID:'test',PIM_TITLE:'Test <notice>',CREATE_TIME:1};
assert.match(cardHtml(item),/展开正文/);
assert.match(cardHtml(item),/class="pp-detail-shell" aria-hidden="true"/);
assert.doesNotMatch(cardHtml(item),/class="pp-card open"/);
state.expanded.add('test');
assert.match(cardHtml(item),/aria-expanded="true"/);
assert.match(cardHtml(item),/正在加载正文/);
let release;
response=()=>new Promise(resolve=>{release=resolve;});
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
assert.ok(source.includes('if (await loadPage(1)) { buildMain(el); return true; }'), '恢复的门户票据必须先验证，失效后继续走密码兜底');
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
const cppuManifest = JSON.parse(fs.readFileSync(new URL('../public/plugins/cppu-notify/manifest.json', import.meta.url), 'utf8'));
/* 不钉死具体版本号：插件每次改动都要升版本，钉死了就变成「升一次改两处」。
   这里只守格式（三段式），catalog 与 manifest 的一致性由下面那条比。 */
assert.match(cppuManifest.version, /^\d+\.\d+\.\d+$/, '插件版本号必须是三段式 X.Y.Z');
assert.ok((cppuManifest.permissions || []).includes('vault'), 'manifest 必须声明 vault 权限才能用密钥库');
assert.ok((cppuManifest.permissions || []).includes('openUrl'), 'manifest 必须声明 openUrl 权限才能打开校园服务链接');
const catalogSrc = fs.readFileSync(new URL('../src/pluginCatalog.js', import.meta.url), 'utf8');
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
assert.ok(source.includes('data-card-sync') && source.includes('data-card-login'), '一卡通视图必须支持自动登录和主动同步');
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
   四个教务视图原来与 WebVPN / 邮箱 / 学工平铺在一起，现在收进「教务」父项下。 */
assert.match(
  source,
  /url:\s*"https:\/\/jw\.cppu\.edu\.cn\/index\.html"[^}]*label:\s*"教务"[^}]*children:\s*\[[\s\S]*?view:\s*"cppu-xk"[\s\S]*?view:\s*"cppu-qj"[\s\S]*?view:\s*"cppu-credit"[\s\S]*?view:\s*"cppu-cx"[\s\S]*?\]/,
  '「教务」必须是带 children 的父项，且四个教务视图收在 children 里');
assert.match(source, /jwOpen:\s*true/,
  '教务子菜单必须默认展开 —— 这 4 个入口本来就露在外面，默认收起等于把已有功能藏进一次点击之后');

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
/* 用户明确要求：这两个教务功能不接管 */
assert.doesNotMatch(source, /自习室|评分信息/,
  '「自习室查询」「评分信息查询」按用户要求不做，不得出现在侧栏');

assert.ok(source.includes('MAIL_ACCOUNT = "2025290058@cppu.edu.cn"'), '教育邮箱自动登录必须使用用户指定的完整邮箱账号');
assert.match(source, /if \(url === MAIL\) \{ await openMailLink\(btn\); return; \}/,
  '点击教育邮箱必须进入专用自动登录链路，而不是裸开 mail.cppu.edu.cn');
assert.ok(source.includes('readSavedPassword') && source.includes('tide.vault.get("secret")'),
  '教育邮箱必须复用警大通知插件密钥库里保存的同一份密码');
assert.ok(source.includes('mailSessionUrlFromResponse') && source.includes('verifyMailSession'),
  '教育邮箱提交后必须识别 sid 会话入口并二次校验，不能只 POST 一次就宣布成功');
assert.doesNotMatch(source, /const direct = mailSessionUrlFromResponse[\s\S]{0,120}?openUrl\(direct\)/,
  '邮箱首页如果已经返回 sid，也要先校验该入口不是登录页再打开');
const mailFn = source.slice(source.indexOf('async function openMailLink'));
assert.doesNotMatch(mailFn, /data:text\/html|openUrl\([^)]*password/s,
  '邮箱自动登录不能把密码拼进 openUrl/data URL 这类可见地址');

vaultData.secret = JSON.stringify({ password: 'mail-pass' });
state.autoLogin = true; state.savedPassword = ''; calls = []; opened = []; notices = [];
response = (sid, method, url, opts = {}) => {
  if (method === 'GET' && url === 'https://mail.cppu.edu.cn/') {
    return { status: 200, finalUrl: url, body: '<form action="/coremail/index.jsp?cus=1" method="post"><input name="uid"><input name="password" type="password"></form>' };
  }
  if (method === 'POST') {
    return { status: 200, finalUrl: 'https://mail.cppu.edu.cn/coremail/XT5/index.jsp?sid=mail-sid', body: '' };
  }
  if (method === 'GET' && url.includes('sid=mail-sid')) {
    return { status: 200, finalUrl: url, body: '<html><title>Coremail</title><div id="mailbox">Inbox</div></html>' };
  }
  return { status: 404, body: '' };
};
await openMailLink(null);
assert.equal(opened.at(-1), 'https://mail.cppu.edu.cn/coremail/XT5/index.jsp?sid=mail-sid');
const mailPost = calls.find((c) => c[1] === 'POST' && c[2].includes('/coremail/index.jsp'));
assert.ok(mailPost, '教育邮箱自动登录必须向邮箱登录表单提交 POST');
assert.ok(mailPost[3].body.includes('uid=2025290058%40cppu.edu.cn'), '邮箱登录提交体必须带完整邮箱账号');
assert.ok(mailPost[3].body.includes('password=mail-pass'), '邮箱登录提交体必须复用密钥库保存的警大通知密码');
assert.ok(opened.every((url) => !url.includes('mail-pass')), '打开到系统浏览器的 URL 里不能泄露密码');
assert.ok(calls.some((c) => c[1] === 'GET' && c[2].includes('sid=mail-sid')), '打开邮箱前必须用同一 HTTP 会话校验 sid 入口可用');

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
assert.match(source, /\.pp-side-toggle\{[^}]*transition:[^}]*max-height/,
  '把手的高度也要参与过渡，收起时才不会突然消失');
assert.match(source, /@media\(max-width:820px\)[\s\S]*?\.pp-side-toggle\{[^}]*min-height:44px/,
  '手机端把手的点击区必须 ≥44px，手指才点得准');
assert.match(source, /@media\(max-width:820px\)[\s\S]*?\.pp-side-head-toggle\{[^}]*min-height:44px/,
  '手机端展开态头部的「收起」按钮点击区必须 ≥44px（它是手机上的主要收起入口）');
assert.match(source, /@media\(max-width:820px\)[\s\S]*?\.pp-shell:not\(\.side-collapsed\) \.pp-side-toggle\{[^}]*min-height:0/,
  'min-height 会压过 max-height，窄屏展开时把手必须连 min-height 一起归零');
assert.match(source, /@media\(max-width:820px\)[\s\S]*?\.pp-side-btn\{[^}]*min-height:52px[^}]*touch-action:manipulation/,
  '手机端侧栏入口要有 ≥52px 点击区并禁用双击缩放');
assert.ok(source.includes('-webkit-tap-highlight-color:transparent'), '触屏点击不应出现系统高亮块');
assert.match(source, /@media\(prefers-reduced-motion:reduce\)\{[^}]*\.pp-side,[^}]*\.pp-side-toggle[^}]*transition-duration/,
  '开了「移除动画」（Android 省电模式）时，侧栏与把手的过渡也必须跟着降级');
assert.ok(source.includes('AUTO_REFRESH_MS') && source.includes('data-ar'), '插件必须提供低打扰的定时自动刷新开关');
const hostSrc = fs.readFileSync(new URL('../src/pluginHost.js', import.meta.url), 'utf8');
assert.ok(hostSrc.includes('vault: "加密密钥库'), '插件宿主必须定义 vault 权限标签');
assert.ok(hostSrc.includes('requirePermission(man, pid, "vault")'), 'tide.vault 必须走权限校验');
assert.ok(hostSrc.includes('?v=${encodeURIComponent(version)}') && hostSrc.includes('cache: "no-cache"'), '内置插件入口必须按版本破缓存，避免升级后仍运行旧代码');
const apiSrc = fs.readFileSync(new URL('../src/api.js', import.meta.url), 'utf8');
assert.ok(apiSrc.includes('plugin_vault_get') && apiSrc.includes('http_session_restore'), 'api 层必须接通密钥库与会话恢复命令');
assert.ok(apiSrc.includes('followRedirects: opts.followRedirects'), 'api 层必须把重定向策略传给 Rust HTTP 会话');
const libSrc = fs.readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
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
};
const jeMetaJson = (code) => {
  const m = JE_META[code] || {};
  return { status: 200, finalUrl: 'https://jw.cppu.edu.cn/je/develop/funcInfo/getStaticFuncByCode', location: '', cookies: [], body: JSON.stringify({ funcInfo: { funcId: m.funcId, funcType: m.funcType }, func: { info: m.sql ? { FUNCINFO_SQL: m.sql } : {} } }) };
};
const jeMeta = (opts) => decodeURIComponent(String(opts?.body || '')).replace(/\+/g, ' ').match(/FUNCINFO_FUNCCODE=([^&]*)/)?.[1] || '';
response = (sid, method, url, opts = {}) => {
  if (url.startsWith('https://sso-jw.cppu.edu.cn/tpass/login')) return { status: 302, body: '', finalUrl: url, location: 'https://jw.cppu.edu.cn/cas_callback?ticket=ST-self', cookies: [] };
  if (url.startsWith('https://jw.cppu.edu.cn/cas_callback')) return { status: 200, body: '<html>智慧教务</html>', finalUrl: 'https://jw.cppu.edu.cn/index.html', location: '', cookies: [] };
  if (url.endsWith('/je/develop/funcInfo/getStaticFuncByCode')) return jeMetaJson(jeMeta(opts));
  if (url.startsWith('https://jw.cppu.edu.cn/je/load')) return jeJson([{ KCMC: '示例课程' }]);
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
await assert.rejects(() => jeLoad('qjRecord'), /教务数据解析失败/, '两次都拿不到 rows 就把 HTTP 状态报出来，不要静默返回空列表');

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

/* 警大学分原入口成为警大成绩，避免教务菜单出现两张重复成绩页。 */
assert.deepEqual(views.map((v) => v.id).sort(), ['cppu-card', 'cppu-credit', 'cppu-cx', 'cppu-notify', 'cppu-qj', 'cppu-xk'],
  '必须注册通知及五个教务/一卡通视图，登录设置属于应用设置');
assert.ok(views.filter((v) => v.id !== 'cppu-notify').every((v) => typeof v.render === 'function'), '插件子视图必须有 render');
assert.ok(views.some((v) => v.id === 'cppu-cx' && v.title === '警大创新学分'), '创新学分视图要有独立标题');
assert.ok(views.some((v) => v.id === 'cppu-credit' && v.title === '警大成绩'), '原警大学分视图应以警大成绩注册');
assert.match(source, /view: "cppu-credit", label: "警大成绩"/, '教务菜单应显示警大成绩');
assert.match(source, /id: "cppu-credit", title: "警大成绩"[^\n]*keys: \["grade"\][^\n]*menu: JW_MENU\.grades,[\s\S]*?body: \(\) => jwGradesHtml\(\)/,
  '原警大学分入口必须读取成绩接口并使用 cppu-helper 成绩页及导出功能');
assert.doesNotMatch(source, /view: "cppu-grades"|id: "cppu-grades"/, '不能保留重复的成绩入口');
for (const v of ['cppu-xk', 'cppu-qj', 'cppu-credit', 'cppu-cx', 'cppu-card']) assert.ok(source.includes(`view: "${v}"`), `校园服务栏必须有 ${v} 入口`);
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
  { KCMC: '多旋翼无人机组装与调试', KCSX: '02', XKBMC: '选_1', XF: 1, SKDD: '消训楼410', KKXNXQ: '20262027-1', KKXNXQNAME: '2026年秋季学期', OPERATERCODE: '2025290058' },
  { KCMC: '反邪教研究', KCSX: '02', XKBMC: '选_2', XF: 1, SKDD: 'A204', KKXNXQ: '20262027-1', KKXNXQNAME: '2026年秋季学期', OPERATERCODE: '8712c0c67d92ff2fe5da1e36591bb80d' },
];
const resultHtml = jwResultHtml();
assert.ok(resultHtml.replace(/<[^>]*>/g, '').includes('2026年秋季学期 · 2 门 · 2 学分'), '已选课程按学期分组并合计学分');
assert.ok(resultHtml.includes('本人自选') && resultHtml.includes('教务代选'), 'OPERATERCODE 是学号=本人自选，是 uuid=教务代选');
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
jwState.data.grade.push({ KCMC: '<img src=x onerror=alert(1)>', XF: 1, JD: 2, ZPCJ: 66, XNXQ: '20262027-2' });
gradePage = jwGradesHtml();
assert.ok(!gradePage.includes('<img src=x'), '成绩接口返回的课程名必须转义');
jwState.data.grade.pop();
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

console.log('PASS: expand/collapse, loading, late response, cache, retry, paragraph preservation, API paths, bounded renewal and read-only 教务 views');
