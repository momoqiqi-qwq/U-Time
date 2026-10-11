import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../public/plugins/cppu-notify/main.js',import.meta.url),'utf8');
const pick=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
const mountCode=pick('  function mountCardView(el) {','  /* ── 登录界面');
const shellCode=pick('  function cardShellHtml() {','  function mountCardView');
const authCode=pick('  function cardAuthedUrl(url) {','  async function cardSaveSecret');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
class Node {
 constructor(attrs={}){this.attrs=attrs;this.dataset={};for(const[k,v]of Object.entries(attrs))if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v;this.hidden=Object.hasOwn(attrs,'hidden');this.value=attrs.value||'';this.disabled=false;this.textContent='';this.handlers=new Map();this.assignments=[];this.classList={toggle(){},remove(){},add(){}};}
 set src(v){this._src=v;this.assignments.push(v);}get src(){return this._src||'about:blank';}
 setAttribute(k,v){this.attrs[k]=v;}focus(){this.focused=true;}
 closest(selector){const name=selector.slice(1,-1);return Object.hasOwn(this.attrs,name)?this:null;}
 addEventListener(k,fn){if(!this.handlers.has(k))this.handlers.set(k,new Set());this.handlers.get(k).add(fn);}
 removeEventListener(k,fn){this.handlers.get(k)?.delete(fn);}
 fire(k,e={}){return Promise.all([...(this.handlers.get(k)||[])].map(fn=>fn(e)));}
}
class Root extends Node {
 constructor(){super();this.nodes=new Map();this.isConnected=true;}
 set innerHTML(html){this.html=html;this.nodes=new Map();for(const tag of html.matchAll(/<[a-z][^>]*>/g)){const attrs={};for(const attr of tag[0].matchAll(/(data-[\w-]+|hidden|value|src)(?:="([^"]*)")?/g))attrs[attr[1]]=attr[2]||'';const node=new Node(attrs);for(const key of Object.keys(attrs))if(key.startsWith('data-'))this.nodes.set('['+key+']',node);}}
 get innerHTML(){return this.html;}
 querySelector(selector){return this.nodes.get(selector)||null;}
 contains(node){return [...this.nodes.values()].includes(node);}
 click(name,extra={}){const target=this.querySelector('[data-card-'+name+']');assert.ok(target,'点击目标 [data-card-'+name+'] 必须先挂到视图里');return this.fire('click',{target,preventDefault(){},...extra});}
}
/* 视图里能点的东西分三类：
   ① 外壳 HTML 里自带的 —— 状态行（失败时整条变成重试横幅）。
   ② 运行时生成的 —— 登录表单的按钮（cardPaintLogin）、口径切换（cardStatsHtml）、更换账号（cardPaintLogin）。
   ③ v1.41.0 起外壳不再渲染的旧工具栏入口（统计/账单/同步账单/首页/充值/账户中心/刷新/应用内新窗/回通知）——
      它们的处理器保留备用，这里照旧挂上并驱动一遍，避免哪天要恢复时处理器已经腐烂。 */
const RUNTIME=['login','change','mode','kind','refresh'];
const LEGACY=['summary','billing','sync','home','recharge','center','reload','open','back'];
function harness({cacheFail=false,optionalFail=false,popupFail=false,deferredSync=false,legacy=false,credentials=false}={}){
 const root=new Root(),state={rows:[],username:credentials?'student':'',password:credentials?'secret':'',accessToken:'',expiresAt:0,loading:false,mode:'month',kind:'in'};
 const calls={sync:0,nav:[],popup:[],vaultDel:0,paint:0};const timers=new Map();let timerId=0,release;
 const constants={CARD_ORIGIN:'https://yktcard.cppu.edu.cn',CARD_HOME:'https://yktcard.cppu.edu.cn/campus-card/?appId=2',CARD_RECHARGE:'https://yktcard.cppu.edu.cn/campus-card/cardRecharge?appId=2',CARD_CENTER:'https://yktcard.cppu.edu.cn/campus-card/userCenter?appId=2',CARD_BILLING:'https://yktcard.cppu.edu.cn/campus-card/billing/list?appId=24',CARD_CACHE_KEY:'cache',CARD_VAULT_KEY:'secret'};
 const context={...constants,cardState:state,URL,Date,ensureStyle(){},sideShellClass:()=>'',sideHtml:()=>'',sideToggleHtml:()=>'',esc:s=>String(s),cardStatsHtml:()=>'<div>统计</div>',cardCleanRows:r=>r,cardRestoreSecret:async()=>{},cardPaintLogin(){},cardPaintStats(){calls.paint++;},cardSetStatus:(el,text)=>{const node=el.querySelector('[data-card-status]');if(node)node.textContent=text;},bindSide(){if(optionalFail)throw Error('optional');},loadLinkMeta:async()=>{},loadCardAveragePanel(){if(optionalFail)throw Error('optional');},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),tide:{storage:{get:async()=>{if(cacheFail)throw Error('storage');return null;}},vault:{del:async()=>{calls.vaultDel++;}},util:{navigate:id=>calls.nav.push(id),openCardPage:async url=>{calls.popup.push(url);if(popupFail)throw Error('native failed');return {mode:'native'};}}},cardSync:async()=>{calls.sync++;state.loading=true;if(deferredSync)await new Promise(resolve=>{release=resolve;});state.accessToken='fresh';state.expiresAt=Date.now()+60000;state.loading=false;return true;}};
 const result=new Function(...Object.keys(context),shellCode+authCode+mountCode+';return {mountCardView,cardAuthedUrl};')(...Object.values(context));
 const mount=()=>{const dispose=result.mountCardView(root);for(const name of RUNTIME.concat(legacy?LEGACY:[])){const attrs={};attrs['data-card-'+name]=name==='mode'?'year':name==='kind'?'out':'';root.nodes.set('[data-card-'+name+']',new Node(attrs));}return dispose;};
 const dispose=mount();
 return {root,state,calls,timers,dispose,mount,authed:result.cardAuthedUrl,release:()=>release?.(),status:()=>root.querySelector('[data-card-status]').textContent};
}
/* ── A. 外壳契约：统计就是视图主体，顶部装饰与工具栏不再渲染（v1.41.0 用户要求）────────
   用户原话：「删除图上所有元素。只有统计有用，但这个小按钮不用建，直接显示总界面即可。」
   图上那一整条＝kicker + 标题头 + 9 个按钮的工具栏 + 说明段，全部删除；「统计」按钮也不再建，
   因为统计内容已经是视图本身。这条断言就是那次要求的回归守卫。 */
{
 const h=harness({optionalFail:true,cacheFail:true});await flush();
 const shell=h.root.html;
 for(const gone of ['pp-toolbar','jw-kicker','jw-head','data-card-summary','data-card-billing','data-card-sync','data-card-home','data-card-recharge','data-card-center','data-card-reload','data-card-open','data-card-back'])
  assert.ok(!shell.includes(gone),`一卡通视图顶部不该再渲染 ${gone}`);
 assert.match(shell,/<div class="pp-wrap">\s*<div class="yk-status"/,'状态行必须是统计视图的第一个元素，顶上不留任何装饰');
 for(const keep of ['pp-side','data-card-status','data-card-login-box','data-card-stats','data-card-web'])
  assert.ok(shell.includes(keep),`一卡通视图必须保留 ${keep}`);
 assert.equal(h.root.querySelector('[data-card-stats]').hidden,false,'统计直接作为视图主体显示，不用再点按钮切回来');
 assert.equal(h.root.querySelector('[data-card-web]').hidden,true,'官方网页容器默认不占位');
 assert.equal(h.root.handlers.get('click').size,1,'点击委托必须挂在外壳容器上（口径切换 / 失败重试都走它）');
 h.dispose();assert.equal(h.root.handlers.get('click').size,0,'dispose 要摘掉点击委托');
}
/* ── B. 仍然可达的交互：失败横幅重试、视图内登录、口径切换、自动同步 ────────────── */
{
 const h=harness({optionalFail:true,cacheFail:true});await flush();
 assert.ok(h.status().length>0,'缓存与可选模块都失败时，状态行仍要给可读提示，不能留白');
 assert.equal(h.root.querySelector('[data-card-stats]').hidden,false,'缓存读失败也不影响统计区显示');
 assert.equal(h.root.handlers.get('click').size,1,'可选初始化失败不能连带丢掉点击委托');
 await h.root.click('refresh');
 assert.match(h.status(),/请先填写/,'没有凭据时点失败横幅要先要账号，而不是空跑一趟同步');
 assert.equal(h.calls.sync,0);
 h.state.username='student';h.state.password='secret';
 await h.root.click('refresh');
 assert.equal(h.calls.sync,1,'有凭据时点失败横幅要真的重新登录并重拉数据');
 const before=h.calls.paint;
 await h.root.click('mode');await h.root.click('kind');
 assert.equal(h.calls.paint,before+2,'年/月/日与充值/消费切换只重画统计，不触发网络');
 assert.equal(h.calls.sync,1,'口径切换不得顺带再同步一次');
 assert.equal(h.state.mode,'year');assert.equal(h.state.kind,'out');
 await h.root.click('change');
 assert.match(h.status(),/请输入新账号与密码/);
 assert.equal(h.state.accessToken,'');assert.equal(h.state.password,'');
 assert.equal(h.calls.vaultDel,1,'更换账号要把旧凭据从密钥库删掉');
 h.dispose();assert.equal(h.timers.size,0,'dispose 后不留计时器');
}
/* ── C. 凭据在库时进入视图即自动同步；同步在飞行中不得并发第二趟 ──────────────── */
{
 const h=harness({credentials:true});await flush();
 assert.equal(h.calls.sync,1,'密钥库里有凭据时，进入视图要自动同步一次，用户不必再去找按钮');
 h.dispose();
}
{
 const h=harness({credentials:true,deferredSync:true});await flush();
 const first=h.root.click('refresh');await flush();
 const second=h.root.click('refresh');await flush();
 assert.equal(h.calls.sync,1,'同步还没回来时再点失败横幅不得并发第二趟');
 h.release();await first;await second;h.dispose();
}
{
 const h=harness();await flush();
 const dispose=h.mount();await flush();
 assert.equal(h.root.handlers.get('click').size,1,'重复挂载同一宿主不得堆积点击委托');
 dispose();h.dispose();
}
/* ── D. 旧工具栏入口：外壳已不渲染，处理器保留备用，仍驱动一遍防腐烂 ───────────── */
{
 const h=harness({legacy:true});await flush();
 await h.root.click('home');
 assert.equal(h.root.querySelector('[data-card-web]').hidden,false);assert.equal(h.root.querySelector('[data-card-stats]').hidden,true);
 const frame=h.root.querySelector('[data-card-frame]'),before=frame.assignments.length;
 await h.root.click('reload');assert.equal(frame.assignments.length,before+1,'重载要再导一次 iframe');
 await frame.fire('load');assert.match(h.status(),/以网页为准/,'load 事件不能宣称已登录成功');assert.equal(h.timers.size,0);
 await h.root.click('summary');
 assert.equal(h.root.querySelector('[data-card-web]').hidden,true);assert.equal(h.root.querySelector('[data-card-stats]').hidden,false);
 await h.root.click('sync');assert.match(h.status(),/请先填写/);assert.equal(h.calls.sync,0);
 h.state.username='student';h.state.password='secret';
 await h.root.click('sync');assert.equal(h.calls.sync,1);assert.equal(h.root.querySelector('[data-card-sync]').disabled,false);
 await h.root.click('billing');assert.match(frame.src,/billing\/list/,'账单入口要打开平台完整流水');
 await h.root.click('recharge');assert.match(frame.src,/cardRecharge/);assert.equal(new URL(frame.src).searchParams.get('synjones-auth'),'fresh');
 await h.root.click('center');assert.match(frame.src,/userCenter/);
 await h.root.click('open');assert.equal(h.calls.popup.length,1);assert.match(h.calls.popup[0],/userCenter/);
 await h.root.click('back');assert.deepEqual(h.calls.nav,['plug:cppu-notify']);
 h.dispose();
}
{
 const h=harness({legacy:true,popupFail:true});await flush();
 await h.root.click('open');
 assert.match(h.calls.popup[0],/campus-card\/\?appId=2/,'没有令牌时要开可登录的首页，而不是受保护深链');
 assert.match(h.status(),/操作未完成/);assert.equal(h.root.querySelector('[data-card-open]').disabled,false);
 h.dispose();
}
/* ── E. 深链鉴权与原生开窗白名单（与视图外壳无关，一直是硬门槛）──────────────── */
{
 const h=harness();await flush();h.state.accessToken='new';h.state.expiresAt=Date.now()+10000;const result=new URL(h.authed('https://yktcard.cppu.edu.cn/campus-card/?synjones-auth=old&appId=2#route'));assert.equal(result.searchParams.get('appId'),'2');assert.equal(result.searchParams.get('synjones-auth'),'new');assert.equal(result.hash,'#route');h.state.expiresAt=0;assert.equal(new URL(h.authed(result.href)).searchParams.has('synjones-auth'),false);assert.throws(()=>h.authed('https://evil.invalid/'));h.dispose();
}
const api=fs.readFileSync(new URL('../src/api.js',import.meta.url),'utf8');const method=api.slice(api.indexOf('  async openCardPage(url)'),api.indexOf('  /** 插件专用会话打开'));
const nativeCalls=[];const native=new Function('isTauri','invoke','window','return ({'+method+'});')(true,async(...args)=>nativeCalls.push(args),{});
assert.equal((await native.openCardPage('https://yktcard.cppu.edu.cn/campus-card/')).mode,'native');assert.equal(nativeCalls[0][0],'open_internal');
for(const url of ['https://evil.invalid/campus-card/','http://yktcard.cppu.edu.cn/campus-card/','https://yktcard.cppu.edu.cn.evil.invalid/campus-card/','https://yktcard.cppu.edu.cn/elsewhere'])await assert.rejects(native.openCardPage(url));
const web=new Function('isTauri','invoke','window','return ({'+method+'});')(false,()=>{}, {open:()=>null});await assert.rejects(web.openCardPage('https://yktcard.cppu.edu.cn/campus-card/'));
console.log('PASS: card view renders statistics as the whole view (no kicker, no title head, no toolbar, no tip), keeps status/login/stats, auto-syncs on entry, retries from the failure banner, switches 年/月/日 and 充值/消费, and still honors deep-link auth');
