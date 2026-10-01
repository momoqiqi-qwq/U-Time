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
 async click(name,extra={}){const target=this.querySelector('[data-card-'+name+']');assert.ok(target,'real shell must contain '+name);return this.fire('click',{target,preventDefault(){},...extra});}
}
function harness({cacheFail=false,optionalFail=false,popupFail=false,deferredSync=false}={}){
 const root=new Root(),state={rows:[],username:'',password:'',accessToken:'',expiresAt:0,loading:false,mode:'month',kind:'in'};
 const calls={sync:0,nav:[],popup:[],paint:0};const timers=new Map();let timerId=0,release;
 const constants={CARD_ORIGIN:'https://yktcard.cppu.edu.cn',CARD_HOME:'https://yktcard.cppu.edu.cn/campus-card/?appId=2',CARD_RECHARGE:'https://yktcard.cppu.edu.cn/campus-card/cardRecharge?appId=2',CARD_CENTER:'https://yktcard.cppu.edu.cn/campus-card/userCenter?appId=2',CARD_BILLING:'https://yktcard.cppu.edu.cn/campus-card/billing/list?appId=24',CARD_CACHE_KEY:'cache',CARD_VAULT_KEY:'secret'};
 const context={...constants,cardState:state,URL,Date,ensureStyle(){},sideShellClass:()=>'',sideHtml:()=>'',sideToggleHtml:()=>'',esc:s=>String(s),cardStatsHtml:()=>'<div>统计</div>',cardCleanRows:r=>r,cardRestoreSecret:async()=>{},cardPaintLogin(){},cardPaintStats(){calls.paint++;},cardSetStatus:(el,text)=>{const node=el.querySelector('[data-card-status]');if(node)node.textContent=text;},bindSide(){if(optionalFail)throw Error('optional');},loadLinkMeta:async()=>{},loadCardAveragePanel(){if(optionalFail)throw Error('optional');},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id),tide:{storage:{get:async()=>{if(cacheFail)throw Error('storage');return null;}},vault:{del:async()=>{}},util:{navigate:id=>calls.nav.push(id),openCardPage:async url=>{calls.popup.push(url);if(popupFail)throw Error('native failed');return {mode:'native'};}}},cardSync:async()=>{calls.sync++;state.loading=true;if(deferredSync)await new Promise(resolve=>{release=resolve;});state.accessToken='fresh';state.expiresAt=Date.now()+60000;state.loading=false;return true;}};
 const result=new Function(...Object.keys(context),shellCode+authCode+mountCode+';return {mountCardView,cardAuthedUrl};')(...Object.values(context));
 const dispose=result.mountCardView(root);
 return {root,state,calls,timers,dispose,mount:()=>result.mountCardView(root),authed:result.cardAuthedUrl,release:()=>release?.(),status:()=>root.querySelector('[data-card-status]').textContent};
}
{
 const h=harness({optionalFail:true,cacheFail:true});await flush();
 for(const name of ['summary','billing','sync','home','recharge','center','reload','open','back'])assert.ok(h.root.querySelector('[data-card-'+name+']'));
 await h.root.click('home');assert.equal(h.root.querySelector('[data-card-web]').hidden,false);assert.equal(h.root.querySelector('[data-card-stats]').hidden,true);assert.match(h.root.querySelector('[data-card-frame]').src,/campus-card\//);
 const frame=h.root.querySelector('[data-card-frame]'), before=frame.assignments.length;await h.root.click('reload');assert.equal(frame.assignments.length,before+1,'refresh navigates iframe again');
 await frame.fire('load');assert.match(h.status(),/以网页为准/,'load event must not claim authentication success');assert.equal(h.timers.size,0);
 await h.root.click('summary');assert.equal(h.root.querySelector('[data-card-web]').hidden,true);assert.equal(h.root.querySelector('[data-card-stats]').hidden,false);
 await h.root.click('sync');assert.match(h.status(),/请先填写/);assert.equal(h.calls.sync,0);
 await h.root.click('recharge');assert.match(h.status(),/请先登录/);assert.equal(h.root.querySelector('[data-card-web]').hidden,true);
 h.state.username='student';h.state.password='secret';
 await h.root.click('sync');assert.equal(h.calls.sync,1);assert.equal(h.root.querySelector('[data-card-sync]').disabled,false);
 await h.root.click('billing');assert.match(frame.src,/billing\/list/,'original bill button opens full official records');
 await h.root.click('recharge');assert.match(frame.src,/cardRecharge/);assert.equal(new URL(frame.src).searchParams.get('synjones-auth'),'fresh');
 await h.root.click('center');assert.match(frame.src,/userCenter/);
 await h.root.click('open');assert.equal(h.calls.popup.length,1);assert.match(h.calls.popup[0],/userCenter/);assert.match(h.status(),/应用内/);
 await h.root.click('back');assert.deepEqual(h.calls.nav,['plug:cppu-notify']);
 await h.root.click('summary');await h.root.click('reload');assert.equal(h.calls.sync,2,'refresh while viewing local bill synchronizes data');
 h.dispose();assert.equal(h.root.handlers.get('click').size,0);assert.equal(h.timers.size,0);
}
{
 const h=harness({deferredSync:true});await flush();h.state.username='u';h.state.password='p';const first=h.root.click('sync');await flush();await h.root.click('sync');assert.equal(h.calls.sync,1,'rapid repeat clicks must be single-flight');assert.equal(h.root.querySelector('[data-card-sync]').disabled,true);h.release();await first;assert.equal(h.root.querySelector('[data-card-sync]').disabled,false);
 // Re-mount on the same host must not accumulate listeners.
 h.state.username='';h.state.password='';const dispose=h.mount();await flush();assert.equal(h.root.handlers.get('click').size,1);await h.root.click('back');assert.equal(h.calls.nav.length,1);dispose();
}
{
 const h=harness({popupFail:true});await flush();await h.root.click('open');assert.match(h.calls.popup[0],/campus-card\/\?appId=2/,'no token opens login-capable homepage instead of a protected deep link');assert.match(h.status(),/操作未完成/);assert.equal(h.root.querySelector('[data-card-open]').disabled,false);
 await h.root.click('home');[...h.timers.values()][0]();assert.match(h.status(),/内嵌限制/);h.dispose();
}
{
 const h=harness();await flush();h.state.accessToken='new';h.state.expiresAt=Date.now()+10000;const result=new URL(h.authed('https://yktcard.cppu.edu.cn/campus-card/?synjones-auth=old&appId=2#route'));assert.equal(result.searchParams.get('appId'),'2');assert.equal(result.searchParams.get('synjones-auth'),'new');assert.equal(result.hash,'#route');h.state.expiresAt=0;assert.equal(new URL(h.authed(result.href)).searchParams.has('synjones-auth'),false);assert.throws(()=>h.authed('https://evil.invalid/'));h.dispose();
}
const api=fs.readFileSync(new URL('../src/api.js',import.meta.url),'utf8');const method=api.slice(api.indexOf('  async openCardPage(url)'),api.indexOf('  /** 插件专用会话打开'));
const nativeCalls=[];const native=new Function('isTauri','invoke','window','return ({'+method+'});')(true,async(...args)=>nativeCalls.push(args),{});
assert.equal((await native.openCardPage('https://yktcard.cppu.edu.cn/campus-card/')).mode,'native');assert.equal(nativeCalls[0][0],'open_internal');
for(const url of ['https://evil.invalid/campus-card/','http://yktcard.cppu.edu.cn/campus-card/','https://yktcard.cppu.edu.cn.evil.invalid/campus-card/','https://yktcard.cppu.edu.cn/elsewhere'])await assert.rejects(native.openCardPage(url));
const web=new Function('isTauri','invoke','window','return ({'+method+'});')(false,()=>{}, {open:()=>null});await assert.rejects(web.openCardPage('https://yktcard.cppu.edu.cn/campus-card/'));
console.log('PASS: all eight actual card toolbar buttons, optional-init failures, visible navigation, auth gating, refresh, native popup, errors, cleanup and duplicate clicks');
