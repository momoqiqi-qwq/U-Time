import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = p => fs.readFileSync(new URL('../'+p, import.meta.url),'utf8');
const portal = read('public/plugins/cppu-notify/main.js');
const calendar = read('public/plugins/cppu-calendar/main.js');
const schedule = read('public/plugins/shiguang-schedule/ui.js');
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
 const sandbox={state:{pending:{username:'x',password:'x',execution:'e'},sid:'s'},LOGIN_URL:'https://example.invalid',rsaEncrypt:x=>x,cleanText:x=>x,finishPortalLogin:async()=>false,tide:{http:{fetch:async()=>({status,body})}}};
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
const statsCode=schedule.slice(schedule.indexOf('async function calendarWeekStats(date)'),schedule.indexOf("tide.events.on('schedule:week-request'"));
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
// Calendar dates and real-current-week highlighting independent of selected day.
class FixedDate extends Date {constructor(...args){super(...(args.length?args:['2026-10-01T12:00:00']));}}
const events={},timeouts=[],box={Date:FixedDate,setTimeout:fn=>timeouts.push(fn),tide:{events:{on:(k,fn)=>events[k]=fn,emit:()=>{}},ui:{registerView:()=>{}}}};
vm.runInNewContext(calendar.replace(/\}\)\(\);\s*$/, 'globalThis.test={state,cleanTerm,weekOf,calendarCells,paint,requestStats};})();'),box);
const C=box.test;C.state.term=C.cleanTerm({jxStart:'2026-08-31',weeks:20,name:'测试学期'},'手动');
assert.equal(C.weekOf('2026-08-30'),0);assert.equal(C.weekOf('2026-08-31'),1);assert.equal(C.weekOf('2027-01-17'),20);assert.equal(C.weekOf('2027-01-18'),0);
C.state.selected='2026-10-15';C.state.month='2026-10';
let cells=C.calendarCells();assert.equal((cells.match(/current-week/g)||[]).length,7);assert.match(cells,/current-week[^>]*data-date="2026-10-01"/);assert.doesNotMatch(cells,/current-week[^>]*data-date="2026-10-15"/);
const root={innerHTML:'',querySelector:()=>({}),querySelectorAll:()=>[]};C.state.root=root;C.paint();
assert.match(root.innerHTML,/2027-01-17/);assert.match(root.innerHTML,/非官方放假日期/);assert.match(root.innerHTML,/暂无可用课表/);
C.requestStats();const id=C.state.statsId;events['schedule:week-response']({id:'stale',available:true});assert.equal(C.state.statsLoading,true);
events['schedule:week-response']({id,available:true,occurrences:12,periods:24,name:'测试',unknownPeriods:0});assert.match(root.innerHTML,/12 次课 · 24 节/);
C.requestStats();timeouts.at(-1)();assert.equal(C.state.statsLoading,false);assert.match(root.innerHTML,/课程表未响应/);
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
assert.match(portal, /tide\.util\.openSettings\("cppu-login"\)/);
console.log('PASS: campus calendar, timetable statistics, bounded login retries, application settings and removed VPN plugin');
