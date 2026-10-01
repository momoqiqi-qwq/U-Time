import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../src/shell.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('function attachPluginListDrag('),source.indexOf('// 横向工具区',source.indexOf('function attachPluginListDrag(')));
function harness({reduce=false,scale=1}={}){
 const frames=new Map(),timers=new Map();let seq=1,top=100,commits=0,cancels=0;
 const listeners=()=>({handlers:new Map(),addEventListener(name,fn){if(!this.handlers.has(name))this.handlers.set(name,new Set());this.handlers.get(name).add(fn);},removeEventListener(name,fn){this.handlers.get(name)?.delete(fn);},fire(name,event={}){for(const fn of [...(this.handlers.get(name)||[])])fn(event);}});
 const document={...listeners()},window={...listeners()};
 const makeClass=(names=[])=>{const values=new Set(names);return {add:(...a)=>a.forEach(x=>values.add(x)),remove:(...a)=>a.forEach(x=>values.delete(x)),contains:x=>values.has(x)};};
 const list={...listeners(),children:[],classList:makeClass(),isConnected:true,querySelectorAll(){return this.children;},contains(card){return this.children.includes(card);},getBoundingClientRect(){return {top,left:20,width:220*scale};},append(card){this.insertBefore(card,null);},insertBefore(card,ref){const i=this.children.indexOf(card);if(i>=0)this.children.splice(i,1);this.children.splice(ref?this.children.indexOf(ref):this.children.length,0,card);}};
 const body={children:[],append(card){this.children.push(card);card.ghost=true;}};document.body=body;
 function card(id){const item={id,dataset:{pluginId:id},classList:makeClass(),style:{setProperty(k,v){this[k]=v;}},setAttribute(){},removeAttribute(name){if(name==='data-plugin-id')delete this.dataset.pluginId;},getAnimations(){return [];},setPointerCapture(){},releasePointerCapture(){},focus(){},closest(){return this;},cloneNode(){return card(id+'-ghost');},remove(){body.children=body.children.filter(x=>x!==this);},animate(){return {cancel(){cancels++;}}},getBoundingClientRect(){if(this.ghost){const m=this.style.transform?.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px/);return {left:Number(m?.[1]||0)*scale,top:Number(m?.[2]||0)*scale,width:220*scale,height:40*scale};}return {left:20,top:top+list.children.indexOf(this)*44*scale,width:220*scale,height:40*scale};}};Object.defineProperty(item,'nextSibling',{get:()=>list.children[list.children.indexOf(item)+1]});return item;}
 list.children=['a','b','c','d'].map(card);const a=list.children[0];
 const attach=new Function('document','window','navigator','getComputedStyle','getUiScaleFactor','reducedMotion','slotIndexFor','requestAnimationFrame','cancelAnimationFrame','setTimeout','clearTimeout',code+';return attachPluginListDrag;')(document,window,{vibrate(){}},()=>({rowGap:'4'}),()=>scale,()=>reduce,(mids,y)=>{const i=mids.findIndex(mid=>y<mid);return i<0?mids.length:i;},fn=>{const id=seq++;frames.set(id,fn);return id;},id=>frames.delete(id),(fn)=>{const id=seq++;timers.set(id,fn);return id;},id=>timers.delete(id));
 attach(list,()=>commits++);
 const event=(x,y,extra={})=>({target:a,pointerId:1,pointerType:'mouse',button:0,isPrimary:true,clientX:x,clientY:y,preventDefault(){},stopPropagation(){},...extra});
 return {a,list,body,document,window,frames,timers,event,commits:()=>commits,cancels:()=>cancels,scroll:delta=>{top+=delta;document.fire('scroll');},down:()=>list.fire('pointerdown',event(40,110)),move:(x,y)=>{const e=event(x,y);document.fire('pointermove',e);list.fire('pointermove',e);},up:(x,y)=>{const e=event(x,y);document.fire('pointerup',e);list.fire('pointerup',e);},tick:()=>{const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn());},order:()=>list.children.map(x=>x.id).join('')};
}
{
 const h=harness();h.down();h.move(44,110);
 assert.equal(h.body.children.length,1);assert.match(h.body.children[0].style.transform,/translate3d\(24px, 100px, 0\)/,'initial mouse threshold movement is retained');
 assert.equal(h.a.classList.contains('nav-dragging'),true);
 h.move(70,200);assert.match(h.body.children[0].style.transform,/translate3d\(50px, 190px, 0\)/,'ghost follows pointer immediately, before any rAF');
 assert.equal(h.frames.size,1,'sort work coalesces into one frame');h.tick();assert.equal(h.frames.size,0,'stationary pointer does not spin an idle animation loop');
 assert.equal(h.order(),'bcad');h.move(70,120);h.tick();assert.equal(h.order(),'bacd');assert.ok(h.cancels()>0,'old peer animation is cancelled before reverse movement');
 h.up(70,270);assert.equal(h.order(),'bcda','pointerup applies final position without waiting for frame');assert.equal(h.commits(),1);assert.equal(h.body.children.length,0);assert.equal(h.frames.size,0);assert.equal(h.a.dataset.motion,undefined);
 for(const key of ['pointermove','pointerup','pointercancel','scroll'])assert.equal(h.document.handlers.get(key)?.size||0,0,'document cleanup '+key);
}
{
 const h=harness({reduce:true,scale:1.5});h.down();h.move(44,110);assert.equal(h.body.children.length,1,'reduced motion retains essential pointer feedback');h.move(80,170);assert.match(h.body.children[0].style.transform,/translate3d\(40px, 106\.66666666666667px, 0\)/,'zoom coordinates are divided once');h.tick();assert.equal(h.cancels(),0,'reduced motion skips decorative peer animation');h.list.fire('keydown',{key:'Escape',preventDefault(){}});assert.equal(h.order(),'abcd');assert.equal(h.commits(),0);assert.equal(h.body.children.length,0);
}
{
 const h=harness();h.a.dataset.motion='inherit';h.down();h.move(44,110);h.move(50,180);h.tick();h.scroll(-100);h.tick();assert.equal(h.order(),'bcda','scroll re-evaluates slot against current container top');h.window.fire('blur');assert.equal(h.order(),'abcd');assert.equal(h.a.dataset.motion,'inherit');assert.equal(h.frames.size,0);
}
{
 const h=harness();h.down();h.up(40,110);assert.equal(h.commits(),0,'ordinary click never commits ordering');assert.equal(h.body.children.length,0);
 h.list.fire('pointerdown',h.event(40,110,{pointerType:'touch'}));h.move(40,130);assert.equal(h.timers.size,0,'touch scrolling cancels long press');h.up(40,130);assert.equal(h.commits(),0);
 h.list.fire('pointerdown',h.event(40,110,{pointerType:'touch'}));[...h.timers.values()][0]();assert.equal(h.body.children.length,1,'stationary long press activates');h.document.fire('pointercancel',h.event(40,110));assert.equal(h.order(),'abcd');
}
{
 const h=harness();h.list.fire('keydown',{target:h.a,altKey:true,key:'ArrowDown',preventDefault(){}});assert.equal(h.order(),'bacd');assert.equal(h.commits(),1,'keyboard ordering is preserved');
 h.down();h.move(44,110);h.list.fire('pointerdown',h.event(44,110,{pointerId:2,isPrimary:false}));assert.equal(h.body.children.length,1,'second pointer must not replace active drag');h.document.fire('pointercancel',h.event(44,110));assert.equal(h.order(),'bacd');
}
const css=fs.readFileSync(new URL('../src/styles.css',import.meta.url),'utf8');
assert.match(css,/\.nav \.plug-seg > button\.nav-dragging\s*\{[^}]*opacity: 1;[^}]*outline: 2px solid/s);
assert.match(css,/\.plugin-nav-ghost\s*\{[^}]*opacity: 1;[^}]*transition: none/s);
console.log('PASS: sidebar drag direct tracking, coalescing, reverse animation cleanup, final pointerup, scroll, zoom, cancel, touch and full-opacity highlight');
