import { readProductSource } from "./lib/read-product-source.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
const shell = readProductSource(new URL("../src/shell.js", import.meta.url), "utf8");
const code = shell.slice(shell.indexOf("  function renderMarket(container)"), shell.indexOf("  // ── 内容区左右滑动"));
let active = null, animations = 0;
class N {
  constructor(tag, attrs = {}, ...children) { this.tag = tag; this.attrs = {}; this.dataset = {}; this.children = []; this.parent = null; this.nodeType = 1; this.value = attrs.value || ''; this.disabled = Boolean(attrs.disabled); this.classes = new Set(); for (const [k,v] of Object.entries(attrs)) if(v != null) this.setAttribute(k,v); this.append(...children.flat().filter((n)=>n != null)); }
  setAttribute(k,v) { this.attrs[k]=v; if(k==='class') this.classes=new Set(v.split(' ')); if(k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  get classList() { return {add:(...cs)=>cs.forEach(c=>this.classes.add(c)),remove:(...cs)=>cs.forEach(c=>this.classes.delete(c)),contains:(c)=>this.classes.has(c),toggle:(c,on)=>on?this.classes.add(c):this.classes.delete(c)}; }
  append(...nodes) { for(const n of nodes) { if(typeof n==='object') {n.remove();n.parent=this;}this.children.push(n); } }
  insertBefore(n,b) {n.remove();n.parent=this;this.children.splice(this.children.indexOf(b),0,n);}
  replaceChildren(...nodes) {for(const n of this.children) if(typeof n==='object') n.parent=null; this.children=[];this.append(...nodes);}
  remove() {if(this.parent) this.parent.children=this.parent.children.filter(n=>n!==this);this.parent=null;}
  get isConnected() {return this===root||Boolean(this.parent?.isConnected);}
  set textContent(v) {this.replaceChildren(String(v));} get textContent() {return this.children.map(n=>typeof n==='object'?n.textContent:n).join('');}
  matches(s) {if(s.startsWith('.')) return s.slice(1).split('.').every(c=>this.classes.has(c)); return s===this.tag;}
  querySelectorAll(s) {const selectors=s.split(',').map(s=>s.trim());return this.children.filter(n=>typeof n==='object').flatMap(n=>[...(selectors.some(s=>n.matches(s))?[n]:[]),...n.querySelectorAll(s)]);}
  querySelector(s) {return this.querySelectorAll(s)[0]||null;}
  closest(s) {return s.split(',').some(x=>this.matches(x.trim()))?this:this.parent?.closest(s);}
  addEventListener(k,f) {this.attrs['on'+k]=f;}
  focus() {active=this;}
  getAnimations() {return [];}
  animate() {animations++;return {cancel(){}};}
}
const root=new N('main'), doc={get activeElement(){return active;}};
const regs=['a','b'].map(id=>({id,source:'builtin',manifest:{name:id}}));
const states={a:{enabled:true},b:{enabled:true}};
const views=[{id:'a-view',pluginId:'a',title:'A'},{id:'b-view',pluginId:'b',title:'B'}];
let release, fail=false, requests=0, refresh, reduced=false;
const routes=[],messages=[];
const env={document:doc,el:(...a)=>new N(...a),S:{pluginState:id=>states[id]},getRegistry:()=>[...regs],pluginViews:views,
  pluginDisplayName:(_,n)=>n,pluginDisplayIcon:()=>new N('i'),pluginAccent:()=>'',pluginOrderState:()=>[],normalizePluginOrder:ids=>ids,pluginColor:()=>null,
  isAndroidRuntime:()=>true,reducedMotion:()=>reduced,isSelfActivationKey:()=>true,faIcon:()=>new N('i'),switchTo:id=>routes.push(id),toast:t=>messages.push(t),
  flipByKey:(_,opts)=>opts.mutate(),fadeAway:()=>Promise.resolve(),openPluginContextMenu:()=>{},
  // v0.181.0：卡片尺寸拖动（src/marketCardResize.js）在 renderMarket 里接入，这里给替身。
  attachMarketCardResize:()=>()=>{},resetMarketCardSize:()=>{},
  // v0.184.0：搜索框只留放大镜（src/searchField.js），renderMarket 里用这两个入口，
  // 这里给替身（本 harness 走 new Function + 注入标识符，不解析 import）。
  withSearchGlyph:(input)=>new N('div',{class:'search-field'},input),
  searchGlyph:(cls)=>new N('span',{class:cls||'search-ico'}),
  setEnabled:async(id,on)=>{requests++;await new Promise(resolve=>release=resolve);if(fail)throw Error('test failure');states[id].enabled=on;for(let i=views.length-1;i>=0;i--)if(views[i].pluginId===id)views.splice(i,1);if(on) views.push({id:id+'-fresh',pluginId:id,title:'Fresh'}, {id:id+'-second',pluginId:id,title:'Second'});refresh();},
};
const module = new Function(...Object.keys(env), `let marketQuery='',marketFilter='all',marketSearchOpen=false,repaintMarket,refreshMarketState; const marketTogglePending=new Set(); ${code}; return {renderMarket,refresh:()=>refreshMarketState()};`)(...Object.values(env));
refresh=module.refresh;module.renderMarket(root);
const grid=root.querySelector('.market-grid'), card=grid.children[0], sibling=grid.children[1], search=root.querySelector('.market-search'), toggle=card.querySelector('.market-plugin-switch');
const event={stopPropagation(){}};
grid.scrollTop=120;toggle.focus();
let pending=toggle.attrs.onclick(event);await toggle.attrs.onclick(event);assert.equal(requests,1,'pending ignores repeated clicks');
assert.equal(toggle.attrs['aria-disabled'],'true');release();await pending;
assert.equal(grid.children[0],card);assert.equal(grid.children[1],sibling,'unrelated cards keep identity');assert.equal(root.querySelector('.market-search'),search);
assert.equal(grid.scrollTop,120);assert.equal(active,toggle);assert.equal(toggle.attrs['aria-checked'],'false');
assert.equal(card.querySelector('.market-switch-text').textContent,'已关闭');
/* v0.180.0：卡片上的「打开」按钮已删 —— 卡片自己就是打开入口（点卡片 / 回车都进对应视图），
   那枚按钮与卡片点击完全重复，用户反馈没用。这里改测卡片自身的两条路径。 */
const cardEvent={stopPropagation(){},target:{closest:()=>null}};
assert.equal(card.querySelector('.market-card-actions').querySelector('.btn'),null,'卡片操作区不再有「打开」按钮');
card.attrs.onclick(cardEvent);assert.equal(routes.length,0,'插件停用时点卡片不跳转');assert.ok(messages.at(-1).includes('请先开启这个插件'));
pending=toggle.attrs.onclick(event);release();await pending;
assert.equal(grid.children[0],card);assert.equal(toggle.attrs['aria-checked'],'true');assert.equal(toggle.attrs['aria-label'],'关闭a');
card.attrs.onclick(cardEvent);assert.equal(routes.at(-1),'plug:a-fresh','card click uses newly registered view');
assert.equal(card.querySelector('.market-view-links').children.length,2,'Android secondary entries restored');
fail=true;pending=toggle.attrs.onclick(event);release();await pending;assert.equal(toggle.attrs['aria-checked'],'true');assert.equal(toggle.attrs['aria-disabled'],'false');assert.ok(messages.at(-1).includes('失败'));
fail=false;reduced=true;const before=animations;pending=toggle.attrs.onclick(event);release();await pending;assert.equal(animations,before,'reduced motion skips label animation');
const enabledFilter=root.querySelector('.market-filters').children[1];enabledFilter.attrs.onclick();assert.equal(root.querySelector('.market-grid').children.length,1);
const remaining=root.querySelector('.market-plugin-switch');remaining.focus();pending=remaining.attrs.onclick(event);release();await pending;
assert.equal(root.querySelector('.market-empty').textContent,'当前筛选下没有插件');assert.equal(active,search,'removing focused filtered card restores focus');
assert.ok(!code.includes('setTimeout(() => renderMarket'));
assert.match(shell,/else if \(activeView === "market"\) refreshMarketState\?\.\(\)/);
// v0.180.0：卡片上那枚「打开 / 无视图」按钮不许再回来。
assert.ok(!code.includes('无视图'), '🔴 插件卡片上不该再有「打开」按钮（卡片本身就是入口）');
assert.ok(!/market-card-actions" \}, open,/.test(code), '🔴 卡片操作区只放启停滑块与「⋯」');

/* ── 插件中心布局（v0.176.0）：计数行删除、搜索框紧跟标签行、搜索框与筛选胶囊同款风格 ──
   三条都是「静态断言看不出、用户一眼能看出」的：计数行留着只会把搜索框顶到标签下方第二行，
   圆角写错则搜索框与标签行不是同一套语言。 */
const wrap = root.children[0];
const idxOf = (cls) => wrap.children.findIndex((n) => typeof n === 'object' && n.classes.has(cls));
const iFilters = idxOf('market-filters'), iSearchRow = idxOf('market-search-row'), iHead = idxOf('market-head');
assert.ok(iFilters >= 0 && iSearchRow > iFilters, '搜索行必须排在标签行之后');
assert.equal(iSearchRow, iHead + 1, '搜索行要紧跟在标签行（手机上还夹着搜索开关那一行）后面，中间不许再插计数行');
assert.equal(root.querySelector('.market-count'), null, '🔴 插件中心里不许再有「显示 N / N」计数（筛选档每枚自带数量）');
assert.ok(!code.includes('显示 ${rows.length}'), '市场代码里不该再渲染「显示 N / N」');
const headTools = wrap.children[iHead].children[0];
assert.equal(headTools.children.length, 1, '顶栏工具区只剩手机端的搜索开关（计数已删）');
assert.equal(headTools.children[0].classes.has('market-search-toggle'), true);

const styles = readProductSource(new URL("../src/styles.css", import.meta.url), "utf8");
const PILL = /input\.market-search:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\)\{([^}]*)\}/;
const pill = styles.match(PILL)?.[1] ?? "";
assert.ok(pill, '🔴 圆角/底色必须写在抬高特异性的选择器上：第 1746 行那条通用 input 规则用 !important 把 background/border-radius 钉成 --control-bg/8px，'
  + '特异性 (0,3,1) 压过 .market-search 的 (0,1,0)；两边都带 !important 时**比的是特异性**，所以只写 !important 没用（v0.176.0 真机探针实测）');
assert.match(pill, /border-radius:999px !important/, '搜索框必须和筛选胶囊同款圆角（图3 风格）');
assert.match(pill, /background:var\(--panel\) !important/, '底色要和胶囊同源（--panel），不然被 --control-bg 抢走，两枚控件不是一个色');
assert.doesNotMatch(styles, /\.market-search\{[^}]*border-radius/, '🔴 别在 .market-search 里再写一份圆角/底色：那份 (0,1,0) 会被压掉，是死代码');
assert.match(styles, /\.market-search\{[^}]*border:1px solid var\(--line\)/, '搜索框描边要与胶囊同源');
assert.match(styles, /\.market-search::placeholder\{color:var\(--ink-2\)\}/, '框内提示文字要用胶囊的文字色（否则比标签更抢眼）');
assert.match(styles, /\.market-search-row\{[^}]*margin:4px 0 12px/, '搜索行与标签行之间要收紧，不能空出一整行的距');

console.log('PASS: plugin toggle keeps DOM/scroll/focus, guards concurrency, updates view links/counts, handles failure/filtering and reduced motion; card itself is the open entry (the redundant「打开」button is gone); market layout: count row removed, search right after the filter pills, pill-shaped search box');
