// 一卡通日均统计：纯日期/金额计算与独立面板。仅使用已同步的本地流水。
const DAY = 86400000;
const MODES = { year: '按年', month: '按月', week: '按周', academic: '按学年' };
const KEY = 'cardAveragePreferences';
export const DEFAULT_KEYWORDS = '食堂,餐厅,餐饮,饭堂,餐馆,快餐,早餐,午餐,晚餐,小吃,面馆,饭店,食苑';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function stamp(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return NaN;
  const value = Date.parse(date + 'T00:00:00Z');
  return Number.isFinite(value) && new Date(value).toISOString().slice(0,10) === date ? value : NaN;
}
const iso = value => new Date(value).toISOString().slice(0,10);
export const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
export function validAcademicStart(value) {
  // 学年边界每年都必须存在，不把 2/29 静默滚入 3 月。
  return /^\d{2}-\d{2}$/.test(String(value)) && Number.isFinite(stamp('2001-'+value));
}
export function cleanPreferences(raw = {}) {
  return { mode: Object.hasOwn(MODES, raw?.mode) ? raw.mode : 'month', scope: raw?.scope === 'all' ? 'all' : 'dining',
    academicStart: validAcademicStart(raw?.academicStart) ? raw.academicStart : '09-01',
    keywords: typeof raw?.keywords === 'string' && raw.keywords.trim() ? raw.keywords.trim().slice(0,500) : DEFAULT_KEYWORDS };
}
export function periodRange(mode, anchor, academicStart = '09-01', today = localToday()) {
  if (!Number.isFinite(stamp(anchor)) || !Number.isFinite(stamp(today))) throw Error('请选择有效日期');
  const year = Number(anchor.slice(0,4)), month = Number(anchor.slice(5,7));
  if (year < 1900 || year > 9998) throw Error('年份应为 1900–9998');
  if (!validAcademicStart(academicStart)) throw Error('学年起始月日格式应为 MM-DD，且每年都存在（不支持 02-29）');
  let start, end, label;
  if (mode === 'year') { start=`${year}-01-01`;end=`${year}-12-31`;label=`${year} 年`; }
  else if (mode === 'month') { start=anchor.slice(0,7)+'-01';end=iso(Date.UTC(year,month,0));label=`${year} 年 ${month} 月`; }
  else if (mode === 'week') { const t=stamp(anchor), offset=(new Date(t).getUTCDay()+6)%7;start=iso(t-offset*DAY);end=iso(stamp(start)+6*DAY);label=`${start} ～ ${end}（周一至周日）`; }
  else if (mode === 'academic') { const first = anchor.slice(5) < academicStart ? year-1 : year;start=`${first}-${academicStart}`;end=iso(stamp(`${first+1}-${academicStart}`)-DAY);label=`${first}—${first+1} 学年`; }
  else throw Error('不支持的统计周期');
  const effectiveEnd = end < today ? end : today;
  const calendarDays = Math.max(0, Math.floor((stamp(effectiveEnd)-stamp(start))/DAY)+1);
  return {start,end,effectiveEnd,calendarDays,label,current:start<=today&&end>=today,future:start>today};
}
export function shiftAnchor(mode, anchor, delta, academicStart='09-01') {
  const range=periodRange(mode,anchor,academicStart), year=Number(range.start.slice(0,4));
  if(mode==='week')return iso(stamp(range.start)+delta*7*DAY);
  if(mode==='month')return iso(Date.UTC(year,Number(range.start.slice(5,7))-1+delta,1));
  return `${year+delta}-${mode==='academic'?academicStart:'01-01'}`;
}
export function classifyExpense(row, keywords=DEFAULT_KEYWORDS) {
  if(row?.kind!=='out')return 'excluded';
  const text=[row.merchant,row.note].filter(v=>typeof v==='string').join(' ');
  if(/退款|退费|冲正|撤销/.test(text))return 'excluded';
  // 商超/洗浴等明确标识优先，避免“食堂旁超市”误入餐费。
  if(/超市|商超|便利店|洗浴|洗澡|洗衣|水费|电费|书店|打印/.test(text))return 'other';
  const words=String(keywords).split(/[,，、;；\n]+/).map(x=>x.trim()).filter(Boolean);
  return words.some(word=>text.includes(word)) ? 'dining' : 'unknown';
}
export function averageSummary(rows, options = {}) {
  const prefs=cleanPreferences(options), range=periodRange(prefs.mode,options.anchor||localToday(),prefs.academicStart,options.today||localToday());
  let totalCents=0, allCents=0, unknownCents=0, unknownCount=0, count=0, allCount=0;
  const dates=new Set();
  for(const row of Array.isArray(rows)?rows:[]) {
    const cents=Math.round(Number(row?.amount)*100);
    if(!Number.isSafeInteger(cents)||cents<=0||!Number.isFinite(stamp(row?.date))||row.date<range.start||row.date>range.effectiveEnd)continue;
    const category=classifyExpense(row,prefs.keywords);
    if(category==='excluded')continue;
    allCents+=cents;allCount++;
    if(category==='unknown'){unknownCents+=cents;unknownCount++;}
    if(prefs.scope==='dining'&&category!=='dining')continue;
    totalCents+=cents;count++;dates.add(row.date);
  }
  const activeDays=dates.size;
  return {...range,scope:prefs.scope,totalCents,allCents,unknownCents,unknownCount,count,allCount,activeDays,
    activeAverage:activeDays?totalCents/100/activeDays:null,
    calendarAverage:count&&range.calendarDays?totalCents/100/range.calendarDays:null};
}
const money = amount => amount == null ? '—' : `¥${amount.toFixed(2)}`;
function styles() {
  if(document.getElementById('card-average-style'))return;
  const node=document.createElement('style');node.id='card-average-style';
  node.textContent=`.ca-panel{border:1px solid var(--line);border-radius:16px;padding:16px;margin:16px 0;background:var(--panel);color:var(--ink)}.ca-head,.ca-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.ca-head{justify-content:space-between}.ca-panel h4{margin:0;font-size:calc(16px * var(--ui-text-scale))}.ca-panel button,.ca-panel input,.ca-panel textarea{font:inherit;color:inherit;border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:7px 10px;min-height:36px}.ca-panel button{cursor:pointer}.ca-panel button[aria-pressed=true]{background:var(--deep);color:var(--on-accent,#fff);border-color:transparent}.ca-panel button:disabled{opacity:.5;cursor:default}.ca-controls{margin:12px 0}.ca-controls label{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.ca-controls input{max-width:190px}.ca-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:12px 0}.ca-metrics article{padding:14px;border-radius:12px;background:color-mix(in srgb,var(--deep) 9%,var(--panel))}.ca-metrics small,.ca-metrics strong,.ca-metrics span{display:block}.ca-metrics strong{font-size:calc(23px * var(--ui-text-scale));margin:7px 0;color:var(--danger)}.ca-metrics small,.ca-panel p,.ca-metrics span{font-size:calc(12px * var(--ui-text-scale));line-height:1.7}.ca-panel p{color:var(--ink-2);margin:7px 0}.ca-panel .ca-warn{color:var(--ink);font-weight:600}.ca-panel summary{cursor:pointer}.ca-settings{display:grid;gap:10px;margin-top:12px}.ca-settings label{display:grid;gap:5px;font-size:calc(12px * var(--ui-text-scale))}.ca-settings textarea{width:100%;box-sizing:border-box;min-height:62px;resize:vertical}.ca-status{min-height:20px}@media(max-width:620px){.ca-metrics{grid-template-columns:1fr}.ca-panel{padding:12px}.ca-controls{gap:6px}}`;
  document.head.append(node);
}
export async function createCardAverages(storage) {
  let prefs=cleanPreferences(), anchor=localToday(), status='', last=null, saving=false, saveQueue=Promise.resolve();
  try {prefs=cleanPreferences(await storage.get(KEY,null));}catch{status='统计偏好读取失败，暂用默认值';}
  const persist=async snapshot=>{
    saveQueue=saveQueue.catch(()=>{}).then(()=>storage.set(KEY,snapshot));
    try {await saveQueue;}catch{status='统计设置保存失败，当前仅在本次会话生效';paint();}
  };
  function paint() {
    if(!last||last.root.isConnected===false)return;
    const {root,rows,meta}=last;styles();
    let result;
    try {result=averageSummary(rows,{...prefs,anchor});}catch(error){status=error.message;anchor=localToday();result=averageSummary(rows,{...prefs,anchor});}
    const title=prefs.scope==='dining'?'日均餐费':'日均消费';
    let selector;
    if(prefs.mode==='year'||prefs.mode==='academic')selector=`<label>${prefs.mode==='academic'?'学年起始年份':'年份'}<input data-ca-anchor type="number" min="1900" max="9998" value="${result.start.slice(0,4)}"></label>`;
    else if(prefs.mode==='month')selector=`<label>月份<input data-ca-anchor type="month" min="1900-01" max="9998-12" value="${anchor.slice(0,7)}"></label>`;
    else selector=`<label>选择周内任意一天<input data-ca-anchor type="date" min="1900-01-01" max="9998-12-31" value="${anchor}"></label>`;
    root.innerHTML=`<section class="ca-panel"><div class="ca-head"><h4>${title}</h4><div class="ca-controls">${[['dining','餐饮消费'],['all','全部消费']].map(([id,label])=>`<button type="button" data-ca-scope="${id}" aria-pressed="${prefs.scope===id}">${label}</button>`).join('')}</div></div><div class="ca-controls">${Object.entries(MODES).map(([id,label])=>`<button type="button" data-ca-mode="${id}" aria-pressed="${prefs.mode===id}">${label}</button>`).join('')}</div><div class="ca-controls"><button type="button" data-ca-shift="-1" aria-label="上一个周期">‹</button>${selector}<button type="button" data-ca-shift="1" aria-label="下一个周期">›</button><button type="button" data-ca-today>回到当前</button></div><b>${esc(result.label)}</b><p>范围：${result.start} ～ ${result.end}${result.current?`；当前统计至 ${result.effectiveEnd}`:''}</p><div class="ca-metrics"><article><small>${prefs.scope==='dining'?'已识别餐饮支出':'已同步消费支出'}</small><strong>${result.count?money(result.totalCents/100):'—'}</strong><span>${result.count} 笔 · ${result.activeDays} 个消费日</span></article><article><small>消费日均</small><strong>${money(result.activeAverage)}</strong><span>所选支出 ÷ ${result.activeDays} 个有该类消费的日期</span></article><article><small>日历日均 · 已同步估算</small><strong>${money(result.calendarAverage)}</strong><span>所选支出 ÷ ${result.calendarDays} 个日历日${result.current?'（只到今天）':''}</span></article></div>${!result.count?`<p class="ca-warn">${result.future?'所选周期尚未开始。':prefs.scope==='dining'&&result.allCount?'此期间未识别到餐饮支出，请检查商户摘要或调整关键词。':'所选期间没有可用消费流水，不能据此认定每天花费为 0 元。'}</p>`:''}<p>本期全部已同步支出 ${money(result.allCents/100)}；其中 ${result.unknownCount} 笔（${money(result.unknownCents/100)}）类别未识别，未计入餐费。</p><p>餐饮依据商户与摘要关键词识别，商超、洗浴等不计入餐费。统计为支出口径，不冲抵退款；不含现金及其他支付渠道。</p><p class="ca-warn">${meta.partial?'账单达到抓取或缓存上限，历史可能不完整。':'仅基于平台已同步流水估算，不保证覆盖完整历史。'}无记录不等于零消费；缺失流水会使日历日均偏低。${meta.syncedAt?` 最后同步：${esc(new Date(meta.syncedAt).toLocaleString('zh-CN',{hour12:false}))}`:' 尚未同步账单。'}</p><details><summary>统计设置 · 学年起始 ${esc(prefs.academicStart)}</summary><form class="ca-settings" data-ca-settings><label>每年学年起始月日（MM-DD）<input name="academicStart" maxlength="5" placeholder="09-01" value="${esc(prefs.academicStart)}" required></label><label>餐饮识别关键词（逗号分隔，可按商户名调整；明确的商超等非餐饮标识优先）<textarea name="keywords" maxlength="500" required>${esc(prefs.keywords)}</textarea></label><button type="submit" ${saving?'disabled':''}>保存统计设置</button></form></details><p class="ca-status" role="status">${esc(status)}</p></section>`;
    root.querySelectorAll('[data-ca-mode]').forEach(button=>button.onclick=()=>{prefs={...prefs,mode:button.dataset.caMode};status='';paint();void persist({...prefs});});
    root.querySelectorAll('[data-ca-scope]').forEach(button=>button.onclick=()=>{prefs={...prefs,scope:button.dataset.caScope};status='';paint();void persist({...prefs});});
    root.querySelectorAll('[data-ca-shift]').forEach(button=>button.onclick=()=>{try{const next=shiftAnchor(prefs.mode,anchor,Number(button.dataset.caShift),prefs.academicStart);periodRange(prefs.mode,next,prefs.academicStart);anchor=next;status='';}catch(error){status=error.message;}paint();});
    root.querySelector('[data-ca-today]').onclick=()=>{anchor=localToday();status='';paint();};
    root.querySelector('[data-ca-anchor]').onchange=event=>{
      const value=event.target.value;
      const next=prefs.mode==='month'?value+'-01':prefs.mode==='year'?value+'-01-01':prefs.mode==='academic'?value+'-'+prefs.academicStart:value;
      try{periodRange(prefs.mode,next,prefs.academicStart);anchor=next;status='';}catch(error){status=error.message;}paint();
    };
    root.querySelector('[data-ca-settings]').onsubmit=async event=>{
      event.preventDefault();if(saving)return;
      const form=event.currentTarget, start=form.elements.namedItem('academicStart').value.trim(), keywords=form.elements.namedItem('keywords').value.trim();
      if(!validAcademicStart(start)||!keywords){const el=root.querySelector('.ca-status');el.textContent='请输入每年有效的学年起始月日（例如 09-01，不支持 02-29）和餐饮关键词';return;}
      prefs=cleanPreferences({...prefs,academicStart:start,keywords});saving=true;status='正在保存…';paint();
      await persist({...prefs});saving=false;if(status==='正在保存…')status='统计设置已保存';paint();
    };
  }
  return {render(root,rows,meta={}){if(!root)return;last={root,rows,meta};paint();}};
}
