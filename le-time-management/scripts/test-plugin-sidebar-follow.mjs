import { readProductSource } from "./lib/read-product-source.mjs";
import assert from 'node:assert/strict';
import fs from 'node:fs';
// 侧栏插件拖动：原件自己跟手（v0.197.0）
// 假 DOM 把 src/pluginListDrag.js 真跑起来，验的是**没有第二份条目**：
// 拖动中 body 上不许出现任何节点，位移只写在原件与让位项身上。
const source=readProductSource(new URL('../src/shell.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('function attachPluginListDrag('),source.indexOf('// 横向工具区',source.indexOf('function attachPluginListDrag(')));
function harness({reduce=false,scale=1}={}){
 const frames=new Map(),timers=new Map();let seq=1,top=100,commits=0,cancels=0,animates=0;
 const listeners=()=>({handlers:new Map(),addEventListener(name,fn){if(!this.handlers.has(name))this.handlers.set(name,new Set());this.handlers.get(name).add(fn);},removeEventListener(name,fn){this.handlers.get(name)?.delete(fn);},fire(name,event={}){for(const fn of [...(this.handlers.get(name)||[])])fn(event);}});
 const document={...listeners()},window={...listeners()};
 const makeClass=(names=[])=>{const values=new Set(names);return {add:(...a)=>a.forEach(x=>values.add(x)),remove:(...a)=>a.forEach(x=>values.delete(x)),contains:x=>values.has(x)};};
 const list={...listeners(),children:[],classList:makeClass(),isConnected:true,querySelectorAll(){return this.children;},contains(card){return this.children.includes(card);},getBoundingClientRect(){return {top,left:20,width:220*scale};},append(card){this.insertBefore(card,null);},insertBefore(card,ref){const i=this.children.indexOf(card);if(i>=0)this.children.splice(i,1);this.children.splice(ref?this.children.indexOf(ref):this.children.length,0,card);}};
 // body 只用来抓「还有没有跟手副本」：新模型下一个节点都不该挂上去。
 const body={children:[],append(card){this.children.push(card);}};document.body=body;
 // 假几何刻意**忽略自身 transform**：getBoundingClientRect 拿到的就是未位移位置，
 // 正好是落点推演要用的那套坐标（真 DOM 里由 JS 缓存兑现）。
 function card(id){const item={id,dataset:{pluginId:id},classList:makeClass(),style:{setProperty(k,v){this[k]=v;}},setAttribute(){},removeAttribute(name){if(name==='data-plugin-id')delete this.dataset.pluginId;},getAnimations(){return [];},setPointerCapture(){},releasePointerCapture(){},focus(){},closest(sel){return sel==='.nav-act'?null:this;},remove(){this.gone=true;},animate(){animates++;return {cancel(){cancels++;}}},getBoundingClientRect(){return {left:20,top:top+list.children.indexOf(this)*44*scale,width:220*scale,height:40*scale};}};Object.defineProperty(item,'nextSibling',{get:()=>list.children[list.children.indexOf(item)+1]});return item;}
 list.children=['a','b','c','d'].map(card);const a=list.children[0];
 const attach=new Function('document','window','navigator','getComputedStyle','getUiScaleFactor','reducedMotion','slotIndexFor','requestAnimationFrame','cancelAnimationFrame','setTimeout','clearTimeout',code+';return attachPluginListDrag;')(document,window,{vibrate(){}},()=>({rowGap:'4'}),()=>scale,()=>reduce,(mids,y)=>{const i=mids.findIndex(mid=>y<mid);return i<0?mids.length:i;},fn=>{const id=seq++;frames.set(id,fn);return id;},id=>frames.delete(id),(fn)=>{const id=seq++;timers.set(id,fn);return id;},id=>timers.delete(id));
 attach(list,()=>commits++);
 const event=(x,y,extra={})=>({target:a,pointerId:1,pointerType:'mouse',button:0,isPrimary:true,clientX:x,clientY:y,preventDefault(){},stopPropagation(){},...extra});
 return {a,list,body,document,window,frames,timers,event,commits:()=>commits,cancels:()=>cancels,animates:()=>animates,scroll:delta=>{top+=delta;document.fire('scroll');},down:()=>list.fire('pointerdown',event(40,110)),move:(x,y)=>{const e=event(x,y);document.fire('pointermove',e);list.fire('pointermove',e);},up:(x,y)=>{const e=event(x,y);document.fire('pointerup',e);list.fire('pointerup',e);},tick:()=>{const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn());},order:()=>list.children.map(x=>x.id).join('')};
}
{
 // ① 鼠标拖动：原件自己跟手，其余项各让一格，松手才落地 DOM。
 const h=harness();h.down();h.move(44,110);
 assert.equal(h.a.classList.contains('nav-dragging'),true,'原件必须自己带上拖动类（不再有浮起副本）');
 assert.equal(h.body.children.length,0,'body 上不许出现任何跟手节点');
 assert.match(h.a.style.transform,/^translate3d\(4px, 0px, 0\)$/,'激活当次就按已发生的位移定位，不先在原位闪一帧');
 h.move(70,200);assert.match(h.a.style.transform,/^translate3d\(30px, 90px, 0\)$/,'原件在指针事件里直接跟手，不等 rAF');
 assert.equal(h.frames.size,1,'落点推演合并成一个动画帧');h.tick();assert.equal(h.frames.size,0,'指针停住不空转');
 assert.equal(h.order(),'abcd','拖动中不许重排 DOM');
 assert.equal(h.list.children[1].style.transform,'translate3d(0, -44px, 0)','跨过的项各让一格（原件离开原位后它补上来）');
 assert.ok(!h.list.children[2].style.transform,'没跨过的项不许动');
 assert.equal(h.animates(),0,'拖动中不启动任何 WAAPI 动画');
 h.move(70,120);h.tick();
 assert.equal(h.list.children[1].style.transform,'','反向拖回来时让位必须原样撤销');
 h.move(70,270);h.up(70,270);
 assert.equal(h.order(),'bcda','松手才把 DOM 顺序落地');assert.equal(h.commits(),1);assert.equal(h.frames.size,0);
 assert.equal(h.list.children[0].style.transform,'','落地后让位位移必须清零（自然位置即最终位置，不会跳）');
 assert.equal(h.a.style.transform,'','落地后原件自己的位移必须清零');
 assert.equal(h.body.children.length,0);
 assert.equal(h.animates(),1,'松手落位动画只播一次');
 assert.equal(h.a.dataset.motion,undefined,'拖动期间的 motion=off 必须还原');
 for(const key of ['pointermove','pointerup','pointercancel','scroll'])assert.equal(h.document.handlers.get(key)?.size||0,0,'document cleanup '+key);
}
{
 // ② 减少动效 + 界面缩放 1.5：位移按视口像素 ÷ 缩放写回，装饰性动画全部跳过。
 const h=harness({reduce:true,scale:1.5});h.down();h.move(44,110);
 assert.equal(h.a.classList.contains('nav-dragging'),true,'减少动效仍然保留跟手反馈');
 assert.equal(h.list.children[1].style.transition,'none','减少动效时让位直接跳过去，不吃过渡');
 h.move(80,170);assert.match(h.a.style.transform,/^translate3d\(26\.66\d*px, 40px, 0\)$/,'缩放坐标只除一次');
 h.tick();assert.equal(h.animates(),0,'减少动效不启动落位动画');
 h.up(80,170);assert.equal(h.animates(),0,'减少动效松手也不补动画');assert.equal(h.commits(),1);
}
{
 // ③ 容器自身滚动：原件要按滚动量补回来，否则指针不动它也从指针底下飘走。
 const h=harness();h.a.dataset.motion='inherit';h.down();h.move(44,110);h.move(50,180);h.tick();h.scroll(-100);h.tick();
 assert.match(h.a.style.transform,/^translate3d\(10px, 170px, 0\)$/,'祖先滚动后原件仍贴着指针');
 assert.equal(h.order(),'abcd','滚动只改落点，不动 DOM');
 h.window.fire('blur');assert.equal(h.order(),'abcd','失焦取消：顺序一行没动');
 assert.equal(h.a.dataset.motion,'inherit');assert.equal(h.frames.size,0);
}
{
 // ④ 点击 / 触屏长按：没拖就不许提交，Escape 与 pointercancel 都要能干净收场。
 const h=harness();h.down();h.up(40,110);assert.equal(h.commits(),0,'普通点击不改顺序');assert.equal(h.body.children.length,0);
 h.list.fire('pointerdown',h.event(40,110,{pointerType:'touch'}));h.move(40,130);assert.equal(h.timers.size,0,'触屏滑动取消长按');h.up(40,130);assert.equal(h.commits(),0);
 h.list.fire('pointerdown',h.event(40,110,{pointerType:'touch'}));[...h.timers.values()][0]();assert.equal(h.a.classList.contains('nav-dragging'),true,'触屏长按后激活');
 h.document.fire('pointercancel',h.event(40,110));assert.equal(h.order(),'abcd');assert.equal(h.a.classList.contains('nav-dragging'),false);
}
{
 // ⑤ 键盘排序与多指：第二根手指不许顶掉正在进行的拖动。
 const h=harness();h.list.fire('keydown',{target:h.a,altKey:true,key:'ArrowDown',preventDefault(){}});assert.equal(h.order(),'bacd');assert.equal(h.commits(),1,'Alt+↓ 键盘排序照旧');
 h.down();h.move(44,110);h.list.fire('pointerdown',h.event(44,110,{pointerId:2,isPrimary:false}));assert.equal(h.a.classList.contains('nav-dragging'),true,'第二根手指不许顶掉当前拖动');
 h.document.fire('pointercancel',h.event(44,110));assert.equal(h.order(),'bacd');
}
{
 // ⑥ v0.152.0 行尾悬停操作条（… 更多 / 📌 置顶）长在导航按钮**内部**：
 // closest 会一路找到外层 button[data-plugin-id]，不设守卫就会「按一下更多，插件被拖走」。
 const h=harness();
 const act={closest:(sel)=>(sel==='.nav-act'?act:null)};
 h.list.fire('pointerdown',{...h.event(40,110),target:act});
 h.move(70,200);
 assert.equal(h.a.classList.contains('nav-dragging'),false,'按在操作条上不许起拖');
 assert.equal(h.commits(),0,'按在操作条上不许改动插件顺序');
 assert.equal(h.body.children.length,0);
}
const css=readProductSource(new URL('../src/styles.css',import.meta.url),'utf8');
assert.match(css,/\.nav \.plug-seg > button\.nav-dragging\s*\{[^}]*opacity: 1;[^}]*outline: 2px solid/s,'被拖项保留实心高亮（它现在是唯一可见的那一份）');
assert.match(css,/\.plug-seg\.plugin-drag-live > button\[data-plugin-id\]\s*\{[^}]*transition: transform 140ms/s,'让位项必须有位移动画');
assert.match(css,/\.plug-seg\.plugin-drag-live > button\.nav-dragging\s*\{\s*transition: none; \}/,'被拖项必须排除在让位过渡之外，否则跟手变迟滞');
assert.doesNotMatch(css,/\.plugin-nav-ghost\s*\{/,'跟手副本的样式规则必须整段删除（注释里留一句说明不算）');
console.log('PASS: sidebar drag keeps a single copy, direct tracking, peer slide, DOM lands on pointerup, scroll, zoom, reduced motion, cancel, touch and keyboard');
