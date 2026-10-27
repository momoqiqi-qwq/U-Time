import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { bannerPalettes, channelDelta, colorMix, contrastRatio, mixHex, resolveToken, ruleDecls } from './lib/banner-contrast.mjs';
const read = p => fs.readFileSync(new URL('../'+p, import.meta.url),'utf8');
const portal = read('public/plugins/cppu-notify/main.js');
const calendar = read('public/plugins/cppu-notify/calendar.js');
const calIcons = read('public/plugins/cppu-notify/cal-icons.js');
const schedule = read('public/plugins/shiguang-schedule/ui.js');
// 校历 v0.216.0 并进 cppu-notify：calendar.js 变成 ES module 的工厂（不再自己 registerView），
// 把 `export function createCalendarView(tide)` 换成全局赋值再在沙箱里调一次，即可拿到那套内部函数。
// v0.242.0 起 calendar.js 还 import 了 cal-icons.js（同样是 ESM）：把 `export ` 前缀剥掉后与它拼进
// 同一个沙箱 —— 跑的是产品里那份真图标实现（纯字符串拼接，不碰 DOM），不是桩。
const calendarHarness = (box) => vm.runInNewContext(
  calIcons.replace(/^export /gm, '')
    + calendar.replace("import { calIcon } from './cal-icons.js';", '')
      .replace('export function createCalendarView(tide) {', 'globalThis.createCalendarView = function (tide) {')
    + ';globalThis.test = createCalendarView(tide);', box);
// Execute the actual retry policy with controlled transports; no live credentials.
const policy = portal.slice(portal.indexOf('  const cleanLoginRetries ='),portal.indexOf('  function loginSettingsHtml()'));
function authHarness({ retries=2, fail=()=>null, prepareFail=()=>false, storedRetries }={}) {
  const state={loginRetries:retries,pending:{execution:'initial'}};
  const calls={post:0,sessions:0,prepared:0,codes:[],delays:[]};
  const sandbox={state,tide:{storage:{get:async(key,fallback)=>storedRetries ?? fallback}},setTimeout:(fn,ms)=>{calls.delays.push(ms);fn();},
    newSession:async()=>{state.sid='sid-'+(++calls.sessions);},
    fetchLoginHtml:async()=>{calls.prepared++;if(prepareFail(calls.prepared))throw Error('network');return 'exec-'+calls.prepared;},
    fetchCaptcha:async()=>{state.captcha='img-'+calls.prepared;},
    OCR:{recognize:async()=>({code:'code-'+calls.prepared,samples:[]}),confirmSamples:()=>{}},
    submitLogin:async(code)=>{calls.post++;calls.codes.push([code,state.sid,state.pending.execution]);const e=fail(calls.post);if(e)throw e;state.pending=null;}
  };
  vm.runInNewContext(policy+';globalThis.policy={runLoginAttempts,cleanLoginRetries};',sandbox);
  return {...sandbox.policy,state,calls};
}
for(const value of [-1,6,'oops',2.5,Infinity])assert.equal(authHarness().cleanLoginRetries(value),2);
for(const value of [0,1,5,'3'])assert.equal(authHarness().cleanLoginRetries(value),Number(value));
{
 const a=authHarness({fail:n=>n<3?{retry:'server',status:500,retryable:true}:null});
 await a.runLoginAttempts({username:'test',password:'secret',code:'initial'});
 assert.equal(a.calls.post,3);assert.equal(a.calls.sessions,2);assert.deepEqual(a.calls.delays,[800,1600]);
 assert.equal(new Set(a.calls.codes.map(x=>x[2])).size,3,'every retry gets fresh execution');
 assert.equal(a.state.pending,null);
}
{
 const a=authHarness({retries:0,fail:()=>({retry:'network',retryable:true})});
 await assert.rejects(a.runLoginAttempts({username:'test',password:'secret',code:'initial'}));
 assert.equal(a.calls.post,1,'zero disables extra submissions');assert.equal(a.state.pending.password,undefined);
}
{
 const a=authHarness({retries:5,storedRetries:0,fail:()=>({retry:'network',retryable:true})});
 await assert.rejects(a.runLoginAttempts({username:'test',password:'secret',code:'initial'}));
 assert.equal(a.calls.post,1,'next login reads the latest application setting');
 assert.equal(a.state.loginRetries,0);
}
for(const error of [{fatal:'wrong password'},{fatal:'locked'},{retry:'rate limited',retryable:false}]){
 const a=authHarness({retries:5,fail:()=>error});
 await assert.rejects(a.runLoginAttempts({username:'test',password:'secret'}));assert.equal(a.calls.post,1);
}
{
 const a=authHarness({prepareFail:n=>n===1});
 await a.runLoginAttempts({username:'test',password:'secret'});assert.equal(a.calls.post,1);assert.equal(a.calls.sessions,2,'initial page transport failures retry too');
}
{
 const a=authHarness({fail:()=>({retry:'server',retryable:true})});let active=true;
 await assert.rejects(a.runLoginAttempts({username:'test',password:'secret',code:'initial',isActive:()=>active,onRetry:()=>{active=false;}}));
 assert.equal(a.calls.post,1,'detached login form stops retry');
}
{
 const a=authHarness();const first=a.runLoginAttempts({username:'test',password:'secret'});
 await assert.rejects(a.runLoginAttempts({username:'test',password:'secret'}),e=>!!e.fatal);
 await first;assert.equal(a.calls.post,1);
}
// Real submit classification: 5xx/captcha can retry, locked/429/403 cannot.
const submit = portal.slice(portal.indexOf('  async function submitLogin(code)'),portal.indexOf('  // 静默续期：'));
for(const [status,body,expected] of [[500,'服务异常',true],[200,'验证码不正确',true],[429,'请求过频',false],[200,'账号已锁定',false],[403,'禁止访问',false],[200,'账号或密码错误',false]]){
 const sandbox={authEpoch:0,authCurrent:()=>true,state:{pending:{username:'x',password:'x',execution:'e'},sid:'s'},LOGIN_URL:'https://example.invalid',rsaEncrypt:x=>x,cleanText:x=>x,finishPortalLogin:async()=>false,tide:{http:{fetch:async()=>({status,body})}}};
 vm.runInNewContext(submit+';globalThis.submit=submitLogin;',sandbox);
 await assert.rejects(sandbox.submit('1234'),error=>expected?error.retryable===true:!!error.fatal||error.retryable===false);
}
// Imported timetable: parity, multi-period, custom-time, legacy, empty and out of term.
const modelBox={module:{exports:{}}};vm.runInNewContext(read('public/plugins/shiguang-schedule/model.js'),modelBox);
const M=modelBox.module.exports.ShiguangModel;
const table=M.empty('2026-08-31');
table.courses=[
 {id:'a',name:'A',day:1,weeks:[1,3,5],startSection:1,endSection:2},
 {id:'b',name:'B',day:2,weeks:[2,4,6],startSection:3,endSection:5},
 {id:'c',name:'C',day:5,weeks:[1,2],isCustomTime:true,customStartTime:'17:00',customEndTime:'18:00'}
];
const statsCode=schedule.slice(schedule.indexOf('async function calendarWeekStats(date,'),schedule.indexOf("tide.events.on('schedule:week-request'"));
function statsHarness(raw=table){
 let writes=0;const box={M,table:undefined,loaded:false,activePack:()=>null,tide:{storage:{get:async(k,d)=>k==='table'?raw:d,set:()=>{writes++;}}}};
 vm.runInNewContext(statsCode+';globalThis.stats=calendarWeekStats;',box);return {get:box.stats,writes:()=>writes};
}
let h=statsHarness();let stats=await h.get('2026-09-01');
assert.equal(stats.occurrences,2);assert.equal(stats.periods,2);assert.equal(stats.unknownPeriods,1);assert.equal(stats.start,'2026-08-31');assert.equal(stats.end,'2026-09-06');assert.equal(h.writes(),0);
stats=await h.get('2026-09-08');assert.equal(stats.occurrences,2);assert.equal(stats.periods,3);
stats=await h.get('2026-08-30');assert.equal(stats.occurrences,0);
stats=await h.get('2027-03-01');assert.equal(stats.occurrences,0);
assert.equal((await statsHarness(null).get('2026-09-01')).available,false);
assert.equal((await statsHarness(M.empty()).get('2026-09-01')).available,false);
// 连堂课不能等整次课结束才扣除；当前节、课间和结束边界逐节验证。
for(const [time,remaining] of [['07:59',2],['08:00',2],['08:44',2],['08:45',1],['08:50',1],['08:55',1],['09:40',0]]){
 const result=await h.get('2026-08-31',new Date(`2026-08-31T${time}:00`));
 assert.equal(result.periods,2);assert.equal(result.remainingPeriods,remaining,time);
 assert.equal(result.remainingOccurrences,time<'09:40'?2:1);
 assert.equal(result.remainingUnknownPeriods,1);
}
stats=await h.get('2026-09-04',new Date('2026-09-04T17:30:00'));
assert.equal(stats.remainingPeriods,0);assert.equal(stats.remainingOccurrences,1);assert.equal(stats.remainingUnknownPeriods,1);
stats=await h.get('2026-09-04',new Date('2026-09-04T18:00:00'));
assert.equal(stats.remainingOccurrences,0);assert.equal(stats.remainingUnknownPeriods,0);
stats=await h.get('2026-09-06',new Date('2026-09-06T23:59:00'));assert.equal(stats.remainingPeriods,0);
stats=await h.get('2026-09-07',new Date('2026-09-07T00:00:00'));assert.equal(stats.periods,3);assert.equal(stats.remainingPeriods,3);
// Calendar dates and real-current-week highlighting independent of selected day.
class FixedDate extends Date {constructor(...args){super(...(args.length?args:['2026-10-01T12:00:00']));}}
const events={},timeouts=[],box={Date:FixedDate,setTimeout:fn=>timeouts.push(fn),tide:{events:{on:(k,fn)=>events[k]=fn,emit:()=>{}},ui:{registerView:()=>{}}}};
calendarHarness(box);
const C=box.test;C.state.term=C.cleanTerm({jxStart:'2026-08-31',weeks:20,name:'测试学期'},'手动');
assert.equal(C.weekOf('2026-08-30'),0);assert.equal(C.weekOf('2026-08-31'),1);assert.equal(C.weekOf('2027-01-17'),20);assert.equal(C.weekOf('2027-01-18'),0);
C.state.selected='2026-10-15';C.state.month='2026-10';
let cells=C.calendarCells();assert.equal((cells.match(/current-week/g)||[]).length,7);assert.match(cells,/current-week[^>]*data-date="2026-10-01"/);assert.doesNotMatch(cells,/current-week[^>]*data-date="2026-10-15"/);
const root={innerHTML:'',querySelector:()=>({}),querySelectorAll:()=>[]};C.state.root=root;C.paint();
assert.match(root.innerHTML,/2027-01-17/);assert.match(root.innerHTML,/非官方放假日期/);assert.match(root.innerHTML,/暂无可用课表/);
// 起始卡与结束卡合并成一张（v0.216.0）：结束日优先用教务真实 JSRQ，拿不到才退回推算并标明。
{
 assert.equal((root.innerHTML.match(/class="cc-term"/g)||[]).length,1,'摘要区里「当前学期」与「学期教学结束日」必须是同一张卡');
 assert.equal((root.innerHTML.match(/class="cc-date"/g)||[]).length,2,'同一张卡里并排给出起始与结束');
 const official=C.cleanTerm({name:'2026 秋',jxStart:'2026-08-31',weeks:20,termStart:'2026-08-24',termEnd:'2027-01-08'},'教务');
 assert.equal(C.termEndOf(official).official,true,'有官方 JSRQ 就必须用官方值');
 assert.equal(C.termEndOf(official).value,'2027-01-08');
 const card=C.termCardHtml(official);
 assert.match(card,/<div class="cc-dates">/);
 assert.match(card,/起始<\/em><b>2026-08-24<\/b>/,'起始要显示官方 KSRQ（学期开始日），不是教学第 1 周起始日');
 assert.match(card,/结束<\/em><b>2027-01-08<\/b>/);
 assert.match(card,/官方校历学期起止日/);
 assert.match(card,/教学第 1 周起始 2026-08-31/,'KSRQ 与 JXZQSRQ 不同时要补注教学周起始');
 assert.doesNotMatch(card,/非官方放假日期/);
 const guessed=C.cleanTerm({name:'2026 秋',jxStart:'2026-08-31',weeks:20},'手动');
 assert.equal(C.termEndOf(guessed).official,false);assert.equal(C.termEndOf(guessed).value,'2027-01-17');
 assert.match(C.termCardHtml(guessed),/非官方放假日期/,'没有官方值时必须标明是推算');
}
C.requestStats();const id=C.state.statsId;events['schedule:week-response']({id:'stale',available:true});assert.equal(C.state.statsLoading,true);
events['schedule:week-response']({id,available:true,occurrences:12,periods:24,name:'测试',unknownPeriods:0,remainingOccurrences:3,remainingPeriods:5,remainingUnknownPeriods:0});assert.match(root.innerHTML,/本周共 24 节 · 12 次课/);assert.match(root.innerHTML,/还剩 5 节 · 3 次课/);
C.requestStats();events['schedule:week-response']({id:C.state.statsId,available:true,occurrences:0,periods:0,unknownPeriods:0,remainingOccurrences:0,remainingPeriods:0,remainingUnknownPeriods:0});assert.match(root.innerHTML,/还剩 0 节 · 0 次课/);
C.requestStats();events['schedule:week-response']({id:C.state.statsId,available:true,occurrences:1,periods:2,unknownPeriods:0,remainingOccurrences:1,remainingPeriods:3,remainingUnknownPeriods:0});assert.match(root.innerHTML,/课表统计格式无效/);
C.requestStats();events['schedule:week-response']({id:C.state.statsId,available:true,occurrences:1,periods:2,unknownPeriods:0});assert.match(root.innerHTML,/剩余节数暂不可用/);
C.requestStats();timeouts.at(-1)();assert.equal(C.state.statsLoading,false);assert.match(root.innerHTML,/课程表未响应/);
// 自动统计刷新只更新卡片，保留未提交的事项/学期输入和当前日历视图。
const unchangedPage=root.innerHTML,statsCard={outerHTML:''};
root.querySelector=selector=>selector==='[data-week-stats]'?statsCard:{};
C.requestStats();events['schedule:week-response']({id:C.state.statsId,available:true,occurrences:2,periods:4,unknownPeriods:1,remainingOccurrences:1,remainingPeriods:0,remainingUnknownPeriods:1});
assert.equal(root.innerHTML,unchangedPage);assert.match(statsCard.outerHTML,/还剩 0 节（已知） · 1 次课/);assert.match(statsCard.outerHTML,/1 次自定义时间课程未结束/);
// Campus gateway is allowlisted and uses native browser, not insecure iframe scraping.
const api=read('src/api.js');const campus=api.slice(api.indexOf('  async openCampusSite(site)'),api.indexOf('  /** 插件专用会话打开'));
const nativeCalls=[];const nativeApi=new Function('isTauri','invoke','window','return ({'+campus+'});')(true,async(...args)=>nativeCalls.push(args),{});
assert.equal((await nativeApi.openCampusSite('webvpn')).mode,'native');assert.deepEqual(nativeCalls,[['open_internal',{url:'https://webvpn.cppu.edu.cn/'}]]);
await assert.rejects(nativeApi.openCampusSite('https://evil.invalid'));await assert.rejects(nativeApi.openCampusSite('__proto__'));
const blockedApi=new Function('isTauri','invoke','window','return ({'+campus+'});')(false,()=>{}, {open:()=>null});await assert.rejects(blockedApi.openCampusSite('website'));
assert.equal(fs.existsSync(new URL('../public/plugins/cppu-webvpn/manifest.json', import.meta.url)), false);
assert.doesNotMatch(read('src/pluginCatalog.js'), /cppu-webvpn/);
assert.doesNotMatch(read('../miniprogram/core/pluginCatalog.js'), /cppu-webvpn/);
assert.doesNotMatch(portal, /cppu-webvpn|cppu-login-settings/);
// 警大校历并入 cppu-notify（v0.216.0）：独立插件删掉，校历改成通知插件注册的视图，
// 学期边界改成读教务真实字段（cppu-helper v15.0 的 XlFragment 走的同一个 getNowXnxq）。
assert.equal(fs.existsSync(new URL('../public/plugins/cppu-calendar/manifest.json', import.meta.url)), false);
assert.doesNotMatch(read('src/pluginCatalog.js'), /"cppu-calendar"/);
assert.doesNotMatch(read('../miniprogram/core/pluginCatalog.js'), /"cppu-calendar"/);
assert.match(portal, /tide\.ui\.registerView\(\{ id: "cppu-calendar", title: "警大校历", icon: "calendar-week", render: mountCalendarView \}\)/);
assert.match(portal, /import\("\/plugins\/cppu-notify\/calendar\.js"\)/);
assert.match(portal, /termStart: String\(v\.KSRQ \|\| ""\), termEnd: String\(v\.JSRQ \|\| ""\)/,'学期起止要读教务真实 KSRQ / JSRQ');
assert.match(portal, /weeks: Number\(v\.JXZS\) \|\| Number\(v\.XQZS\) \|\| 0/,'教学周数优先 JXZS');
assert.match(portal, /termStart: term\.termStart \|\| "", termEnd: term\.termEnd \|\| ""/,'cppu:term-response 要把官方起止日透传给校历视图');
assert.match(portal, /tide\.util\.openSettings\("cppu-login"\)/);
// 校历的失败横幅整条可点（v0.190.0）：失败状态行就是 <button data-action="retry">，点一下重跑失败的那一步。
{
 const events2={},timers2=[],intervals2=[],cleared2=[],emits2=[],nodes=new Map(),store2={};let storageFail=false;
 const node=sel=>{if(!nodes.has(sel))nodes.set(sel,{onclick:null,onsubmit:null,outerHTML:'',dataset:{}});return nodes.get(sel);};
 const root2={innerHTML:'',querySelector:sel=>node(sel),querySelectorAll:()=>[]};
 const box2={Date:FixedDate,setTimeout:(fn,ms)=>{timers2.push({fn,ms});return timers2.length;},setInterval:(fn,ms)=>{intervals2.push({fn,ms});return intervals2.length;},clearInterval:id=>cleared2.push(id),
  document:{getElementById:()=>null,createElement:()=>({id:'',textContent:''}),head:{append:()=>{}}},
  tide:{events:{on:(k,fn)=>{events2[k]=fn;},emit:(k,p)=>emits2.push([k,p])},
   storage:{get:async(k,d)=>{if(storageFail)throw new Error('磁盘读取失败');return k in store2?store2[k]:d;},set:async(k,v)=>{store2[k]=v;return true;}},
   ui:{registerView:()=>{}}}};
 calendarHarness(box2);
 const K=box2.test,flush=()=>new Promise(r=>setImmediate(r));K.state.root=root2;
 // 1) 没有失败时仍是普通状态行，只有失败那条才变成按钮
 K.state.retry=null;K.state.status='已同步警大教务当前学期';
 assert.equal(K.statusHtml(),'<p class="cc-status" role="status">已同步警大教务当前学期</p>');
 K.state.retry='load';K.state.status='读取校历失败：<img src=x onerror=1>';
 const bannerHtml=K.statusHtml();
 assert.ok(bannerHtml.startsWith('<button type="button" class="cc-banner" data-action="retry"><span class="cc-banner-txt">'),'失败横幅必须是真 button 且整条可点');
 assert.ok(bannerHtml.endsWith('<span class="cc-banner-hint">点击重试</span></button>'),'右侧要有「点击重试」提示');
 assert.doesNotMatch(bannerHtml,/<img/);assert.match(bannerHtml,/&lt;img src=x/);
 // 2) 读取失败：状态行变可点横幅，并真的接上 reload
 storageFail=true;
 await K.reload();await flush();
 assert.match(K.state.status,/^读取校历失败：磁盘读取失败/);assert.equal(K.state.retry,'load');
 assert.match(root2.innerHTML,/data-action="retry"/);assert.match(root2.innerHTML,/点击重试/);
 assert.equal(node('[data-action="retry"]').onclick,K.retryFail,'横幅必须接到 retryFail');
 // 3) 读取成功：横幅消失、坏数据被过滤、课次重新请求
 storageFail=false;
 store2.calendar={term:{name:'测试学期',jxStart:'2026-08-31',weeks:20,source:'手动',updatedAt:'2026-09-01T00:00:00.000Z'},events:[{id:'e1',date:'2026-09-03',title:'开学典礼'},{id:'bad',date:'不是日期',title:'坏数据'},{id:'e2',title:'缺日期'}]};
 emits2.length=0;
 await K.reload();await flush();
 assert.equal(K.state.term.jxStart,'2026-08-31');assert.deepEqual(K.state.events.map(e=>e.title),['开学典礼']);
 assert.equal(K.state.status,'');assert.equal(K.state.retry,null);
 assert.doesNotMatch(root2.innerHTML,/data-action="retry"/);
 // 读取成功后必须真的重画：否则界面会永远停在 reload 开头画的那一帧「正在读取校历…」，
 // 连点横幅重试成功了也看不出来（旧版 0.3.0 就漏了这一笔，v0.190.0 补上）。
 assert.match(root2.innerHTML,/测试学期/,'读取成功后要重画整个视图，把学期名称显示出来');
 assert.doesNotMatch(root2.innerHTML,/正在读取校历/);
 assert.equal(emits2.at(-1)[0],'schedule:week-request','恢复后要重新请求本周课次');
 // 4) 点横幅：load 态重跑读取链路，term 态重跑教务同步
 emits2.length=0;K.state.retry='load';K.retryFail();
 assert.equal(K.state.retry,null,'点下就清掉失败标记，避免横幅留在加载中');
 await flush();assert.equal(emits2.at(-1)[0],'schedule:week-request');
 emits2.length=0;timers2.length=0;K.state.retry='term';K.retryFail();
 assert.equal(K.state.loading,true);assert.match(K.state.status,/正在通过警大门户同步教务学期/);assert.equal(K.state.retry,null);
 assert.equal(emits2.at(-1)[0],'cppu:term-request');
 assert.equal(timers2.filter(t=>t.ms===30000).length,1,'同步要有 30 秒兜底');
 timers2.filter(t=>t.ms===30000).at(-1).fn();
 assert.equal(K.state.loading,false);assert.equal(K.state.retry,'term');assert.match(K.state.status,/同步超时/);
 // 5) 教务回包：失败的重新变横幅，成功的清掉并落盘，过期的 id 不能改状态
 K.syncTerm();
 await events2['cppu:term-response']({id:K.state.requestId,error:'教务暂无有效学期'});
 assert.equal(K.state.retry,'term');assert.equal(K.state.status,'教务暂无有效学期');assert.match(root2.innerHTML,/data-action="retry"/);
 K.syncTerm();const stale=K.state.requestId;K.state.requestId='other';
 await events2['cppu:term-response']({id:stale,term:{jxStart:'2026-01-01',weeks:1,name:'过期'}});
 assert.equal(K.state.term.jxStart,'2026-08-31','过期回包不能改学期');
 K.state.requestId=stale;
 await events2['cppu:term-response']({id:stale,term:{jxStart:'2026-09-07',weeks:18,name:'2026 秋'}});
 assert.equal(K.state.retry,null);assert.equal(K.state.loading,false);assert.equal(K.state.term.jxStart,'2026-09-07');
 assert.equal(store2.calendar.term.jxStart,'2026-09-07','同步结果要落盘');
 assert.doesNotMatch(root2.innerHTML,/data-action="retry"/);
 // 6) 挂载即读取：读失败时首屏就直接给出可点横幅，返回的清理函数要停掉 60 秒自动刷新
 storageFail=true;
 const stop=K.render(root2);await flush();
 assert.equal(K.state.retry,'load');assert.match(root2.innerHTML,/data-action="retry"/);
 assert.equal(intervals2.at(-1).ms,60000);
 stop();assert.equal(cleared2.length,1);assert.equal(K.state.root,null);
 // 7) 源码守卫：手动保存学期也要清掉失败标记
 assert.match(calendar,/state\.term = term; state\.status = "学期设置已保存"; state\.retry = null;/);
 // 8) 配色：三档底与文字都走主题令牌，34 张色板实算 AA
 const bannerDecl=ruleDecls(calendar,'.cc-wrap .cc-banner');
 assert.match(bannerDecl.color,/^var\(--ink,/);
 const restBg=colorMix(bannerDecl.background);
 assert.equal(restBg.top,'--accent');assert.equal(restBg.bottom,'--bg','底色要混视图底色 --bg：混 --card 时 Nephele 的 --bg 正好落在同一档，底色会跟背景差 1 个通道');
 assert.equal(restBg.pct,0.14);
 assert.match(bannerDecl['min-height'],/44px/);assert.match(bannerDecl.cursor,/pointer/);
 const hoverDecl=ruleDecls(calendar,'.cc-wrap .cc-banner:hover');
 const hoverBg=colorMix(hoverDecl.background),activeBg=colorMix(ruleDecls(calendar,'.cc-wrap .cc-banner:active').background);
 assert.equal(hoverBg.pct,0.22);assert.equal(colorMix(hoverDecl['border-color']).pct,0.52);assert.equal(activeBg.pct,0.32);
 assert.match(ruleDecls(calendar,'.cc-wrap .cc-banner:focus-visible').outline,/^3px solid var\(--accent/);
 const hintMix=colorMix(ruleDecls(calendar,'.cc-banner-hint').color);
 assert.ok(hintMix,'「点击重试」提示色必须是 color-mix 出来的');
 assert.equal(hintMix.top,'--accent');assert.equal(hintMix.bottom,'--ink','提示色必须混 --ink，否则深色按下态过不了 AA');
 assert.ok(calendar.includes('@media(prefers-reduced-motion:reduce){.cc-banner,.cc-banner-hint::before{transition-duration:.01ms!important}}'));
 const palettes=bannerPalettes(p=>fs.readFileSync(new URL(p,import.meta.url),'utf8'));
 // 日期是绿色大字（v0.216.0 用户要求）：24px / 800 字重，绿用 light-dark() 成对给值，
 // 且每套主题的卡片底色上至少有一档绿过 AA（浅色主题取深绿、深色主题取亮绿）。
 const dateDecl=ruleDecls(calendar,'.cc-date b');
 assert.match(dateDecl['font-size'],/24px/,'日期要是大字');assert.match(dateDecl['font-weight'],/800/);
 assert.match(dateDecl['font-variant-numeric'],/tabular-nums/,'日期数字要对齐');
 const greenPair=/^light-dark\((#[0-9a-f]{6}),(#[0-9a-f]{6})\)$/i.exec(dateDecl.color);
 assert.ok(greenPair,'日期绿色必须 light-dark() 成对给值，浅色/深色各一档');
 let worstGreen={ratio:99,where:''};
 for(const {label,tokens} of palettes){
  const card=resolveToken(tokens,'--card');
  assert.ok(/^#[0-9a-f]{6}$/i.test(card||''),`${label} 缺少 --card，绿色大字没有可核算的底色`);
  const best=[greenPair[1],greenPair[2]].map(hex=>({hex,ratio:contrastRatio(hex,card)})).reduce((a,b)=>b.ratio>a.ratio?b:a);
  if(best.ratio<worstGreen.ratio)worstGreen={ratio:best.ratio,where:`${label} ${best.hex}`};
 }
 assert.ok(worstGreen.ratio>=4.5,`绿色日期要在每套主题的卡片底色上过 AA：最低 ${worstGreen.ratio.toFixed(2)}:1（${worstGreen.where}）`);
 console.log(`校历日期配色：${palettes.length} 张色板，绿色大字最低 ${worstGreen.ratio.toFixed(2)}:1（${worstGreen.where}）`);
 let worstBody={ratio:99,where:''},worstHint={ratio:99,where:''},worstSep={delta:999,where:''};
 for(const {label,tokens} of palettes){
  const accent=resolveToken(tokens,'--accent'),surface=resolveToken(tokens,'--bg'),ink=resolveToken(tokens,'--ink');
  for(const weight of [restBg.pct,hoverBg.pct,activeBg.pct]){
   const bg=mixHex(accent,surface,weight),hint=mixHex(accent,ink,hintMix.pct);
   const body=contrastRatio(ink,bg),hintRatio=contrastRatio(hint,bg);
   const sep=channelDelta(bg,surface);
   assert.ok(sep>=16,`${label} ${Math.round(weight*100)}%：横幅底色 ${bg} 与视图底色 ${surface} 只差 ${sep} 个通道`);
   if(body<worstBody.ratio)worstBody={ratio:body,where:`${label} ${Math.round(weight*100)}%`};
   if(hintRatio<worstHint.ratio)worstHint={ratio:hintRatio,where:`${label} ${Math.round(weight*100)}%`};
   if(sep<worstSep.delta)worstSep={delta:sep,where:`${label} ${Math.round(weight*100)}%`};
  }
 }
 assert.ok(worstBody.ratio>=4.5&&worstHint.ratio>=4.5,`校历横幅也要过 AA：正文最低 ${worstBody.ratio.toFixed(2)}:1（${worstBody.where}）、提示最低 ${worstHint.ratio.toFixed(2)}:1（${worstHint.where}）`);
 console.log(`校历横幅配色：${palettes.length} 张色板 × 3 态，最低对比度 正文 ${worstBody.ratio.toFixed(2)}:1（${worstBody.where}）、提示 ${worstHint.ratio.toFixed(2)}:1（${worstHint.where}）；底色与视图底色最小通道差 ${worstSep.delta}（${worstSep.where}）`);
}
console.log('PASS: campus calendar, timetable statistics, bounded login retries, application settings, clickable calendar retry banner and removed VPN plugin');
