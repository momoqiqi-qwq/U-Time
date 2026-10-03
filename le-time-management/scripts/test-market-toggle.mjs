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
assert.equal(card.querySelector('.market-switch-text').textContent,'已关闭');assert.equal(card.querySelector('.btn').disabled,true);
pending=toggle.attrs.onclick(event);release();await pending;
assert.equal(grid.children[0],card);assert.equal(toggle.attrs['aria-checked'],'true');assert.equal(toggle.attrs['aria-label'],'关闭a');
const open=card.querySelector('.market-card-actions').querySelector('.btn');assert.equal(open.disabled,false);open.attrs.onclick();assert.equal(routes.at(-1),'plug:a-fresh','open uses newly registered view');
assert.equal(card.querySelector('.market-view-links').children.length,2,'Android secondary entries restored');
fail=true;pending=toggle.attrs.onclick(event);release();await pending;assert.equal(toggle.attrs['aria-checked'],'true');assert.equal(toggle.attrs['aria-disabled'],'false');assert.ok(messages.at(-1).includes('失败'));
fail=false;reduced=true;const before=animations;pending=toggle.attrs.onclick(event);release();await pending;assert.equal(animations,before,'reduced motion skips label animation');
const enabledFilter=root.querySelector('.market-filters').children[1];enabledFilter.attrs.onclick();assert.equal(root.querySelector('.market-grid').children.length,1);
const remaining=root.querySelector('.market-plugin-switch');remaining.focus();pending=remaining.attrs.onclick(event);release();await pending;
assert.equal(root.querySelector('.market-empty').textContent,'当前筛选下没有插件');assert.equal(active,search,'removing focused filtered card restores focus');
assert.ok(!code.includes('setTimeout(() => renderMarket'));
assert.match(shell,/else if \(activeView === "market"\) refreshMarketState\?\.\(\)/);
console.log('PASS: plugin toggle keeps DOM/scroll/focus, guards concurrency, updates view links/counts, handles failure/filtering and reduced motion');
