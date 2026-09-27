import * as S from './store.js';

const clone = (x) => structuredClone(x);
const escCsv = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvLine = (a) => a.map(escCsv).join(',');

function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}
export function downloadText(name, text, type='text/plain;charset=utf-8') {
  downloadBlob(name, new Blob([text], { type }));
}

export function fullBackup(appVersion='') {
  return {
    format: 'le-time-backup', schema: 2, appVersion,
    exportedAt: new Date().toISOString(), data: clone(S.getState()),
  };
}
export function parseFullBackup(raw) {
  const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const data = obj?.format === 'le-time-backup' ? obj.data : obj;
  if (!data || !Array.isArray(data.tasks) || !Array.isArray(data.blocks)) throw new Error('不是有效的 U-Time备份');
  return data;
}

export function tasksToCsv(tasks=S.getState().tasks) {
  const rows = [['id','title','note','quadrant','done','estimate_min','tags','project','due','due_time','created_at']];
  for (const t of tasks) rows.push([t.id,t.title,t.note,t.quad,t.done?1:0,t.estMin,(t.tags||[]).join('|'),t.project,t.due||'',t.dueTime||'',t.createdAt||'']);
  return '\ufeff' + rows.map(csvLine).join('\r\n');
}
export function blocksToCsv(blocks=S.getState().blocks) {
  const rows = [['id','date','start','duration_min','title','task_id','category']];
  for (const b of blocks) rows.push([b.id,b.date,b.start,b.durMin,b.title,b.taskId||'',b.cat||'work']);
  return '\ufeff' + rows.map(csvLine).join('\r\n');
}
function parseCsv(text) {
  const out=[]; let row=[], cell='', q=false;
  const src=String(text||'').replace(/^\ufeff/,'');
  for(let i=0;i<src.length;i++){
    const c=src[i], n=src[i+1];
    if(q){ if(c==='"'&&n==='"'){cell+='"';i++;} else if(c==='"') q=false; else cell+=c; }
    else if(c==='"') q=true;
    else if(c===','){row.push(cell);cell='';}
    else if(c==='\n'){row.push(cell.replace(/\r$/,''));out.push(row);row=[];cell='';}
    else cell+=c;
  }
  if(cell.length||row.length){row.push(cell.replace(/\r$/,''));out.push(row);}
  return out;
}
export function importTasksCsv(text) {
  const rows=parseCsv(text); if(rows.length<2) return [];
  const h=rows[0].map(x=>x.trim().toLowerCase());
  const idx=(...names)=>{ for(const n of names){const i=h.indexOf(n); if(i>=0)return i;} return -1; };
  const get=(r,...n)=>{const i=idx(...n);return i>=0?r[i]:'';};
  return rows.slice(1).filter(r=>r.some(Boolean)).map(r=>({
    id:get(r,'id')||S.uid('t'), title:get(r,'title','任务','标题')||'导入任务', note:get(r,'note','备注'),
    quad:Number(get(r,'quadrant','quad','象限'))||1, done:['1','true','yes','是'].includes(String(get(r,'done','完成')).toLowerCase()),
    estMin:Number(get(r,'estimate_min','estmin','预计分钟'))||30, tags:String(get(r,'tags','标签')||'').split(/[|，,]/).map(x=>x.trim()).filter(Boolean),
    project:get(r,'project','项目'), due:get(r,'due','截止日期')||null, dueTime:get(r,'due_time','截止时间')||'23:59', createdAt:Number(get(r,'created_at'))||Date.now(),
  }));
}

function icsDate(date, time='00:00') { return `${date.replace(/-/g,'')}T${String(time||'00:00').replace(':','')}00`; }
function icsEsc(s=''){return String(s).replace(/\\/g,'\\\\').replace(/\n/g,'\\n').replace(/,/g,'\\,').replace(/;/g,'\\;');}
export function toIcs() {
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Le Time Management//CN','CALSCALE:GREGORIAN'];
  for(const b of S.getState().blocks){
    const start=S.mmOf(b.start), end=start+(Number(b.durMin)||30);
    lines.push('BEGIN:VEVENT',`UID:${icsEsc(b.id)}@le-time`,`DTSTART:${icsDate(b.date,b.start)}`,`DTEND:${icsDate(b.date,S.hhmmOf(end))}`,`SUMMARY:${icsEsc(b.title)}`,`CATEGORIES:${icsEsc(b.cat||'work')}`,'END:VEVENT');
  }
  for(const t of S.getState().tasks.filter(x=>x.due)){
    lines.push('BEGIN:VTODO',`UID:${icsEsc(t.id)}@le-time`,`SUMMARY:${icsEsc(t.title)}`,`DUE:${icsDate(t.due,t.dueTime||'23:59')}`,`STATUS:${t.done?'COMPLETED':'NEEDS-ACTION'}`,`DESCRIPTION:${icsEsc(t.note||'')}`,'END:VTODO');
  }
  lines.push('END:VCALENDAR'); return lines.join('\r\n');
}
function parseIcsDate(v=''){ const m=String(v).match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/); return m?{date:`${m[1]}-${m[2]}-${m[3]}`,time:m[4]?`${m[4]}:${m[5]}`:'00:00'}:null; }
export function importIcs(text){
  const unfolded=String(text).replace(/\r?\n[ \t]/g,''); const lines=unfolded.split(/\r?\n/); const events=[]; let cur=null;
  for(const line of lines){
    if(line==='BEGIN:VEVENT'||line==='BEGIN:VTODO'){cur={kind:line.slice(6)};continue;} if(!cur)continue;
    if(line==='END:VEVENT'||line==='END:VTODO'){events.push(cur);cur=null;continue;}
    const p=line.indexOf(':'); if(p<0)continue; const k=line.slice(0,p).split(';')[0],v=line.slice(p+1).replace(/\\n/g,'\n').replace(/\\,/g,',').replace(/\\;/g,';').replace(/\\\\/g,'\\'); cur[k]=v;
  }
  const tasks=[],blocks=[];
  for(const e of events){
    if(e.kind==='VTODO') { const d=parseIcsDate(e.DUE); tasks.push({id:S.uid('t'),title:e.SUMMARY||'导入待办',note:e.DESCRIPTION||'',quad:1,done:e.STATUS==='COMPLETED',estMin:30,tags:['ICS'],project:'',due:d?.date||null,dueTime:d?.time||'23:59',createdAt:Date.now()}); }
    else { const a=parseIcsDate(e.DTSTART), z=parseIcsDate(e.DTEND); if(!a)continue; let dur=30; if(z&&z.date===a.date)dur=Math.max(15,S.mmOf(z.time)-S.mmOf(a.time)); blocks.push({id:S.uid('b'),date:a.date,start:a.time,durMin:dur,title:e.SUMMARY||'导入日程',taskId:null,cat:'work'}); }
  }
  return {tasks,blocks};
}

export async function exportXlsx() {
  const XLSX = await import('xlsx');
  const wb=XLSX.utils.book_new();
  const tasks=S.getState().tasks.map(t=>({标题:t.title,备注:t.note||'',象限:t.quad,完成:t.done?'是':'否',预计分钟:t.estMin,标签:(t.tags||[]).join('、'),项目:t.project||'',截止日期:t.due||'',截止时间:t.dueTime||''}));
  const blocks=S.getState().blocks.map(b=>({日期:b.date,开始:b.start,时长分钟:b.durMin,标题:b.title,分类:b.cat||'work',关联任务:b.taskId||''}));
  XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(tasks),'任务'); XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(blocks),'时间块');
  const buf=XLSX.write(wb,{bookType:'xlsx',type:'array'}); downloadBlob(`U-Time-${S.todayStr()}.xlsx`,new Blob([buf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
}
export async function importXlsx(file) {
  const XLSX=await import('xlsx'); const wb=XLSX.read(await file.arrayBuffer(),{type:'array'}); const tasks=[],blocks=[];
  const tSheet=wb.Sheets['任务']||wb.Sheets[wb.SheetNames[0]]; if(tSheet){for(const r of XLSX.utils.sheet_to_json(tSheet,{defval:''})) tasks.push({id:S.uid('t'),title:r['标题']||r.title||'导入任务',note:r['备注']||'',quad:Number(r['象限'])||1,done:['是','1','true'].includes(String(r['完成']).toLowerCase()),estMin:Number(r['预计分钟'])||30,tags:String(r['标签']||'').split(/[、,，|]/).filter(Boolean),project:r['项目']||'',due:r['截止日期']||null,dueTime:r['截止时间']||'23:59',createdAt:Date.now()});}
  const bSheet=wb.Sheets['时间块']; if(bSheet){for(const r of XLSX.utils.sheet_to_json(bSheet,{defval:''})) if(r['日期']) blocks.push({id:S.uid('b'),date:String(r['日期']).slice(0,10),start:r['开始']||'09:00',durMin:Number(r['时长分钟'])||30,title:r['标题']||'导入日程',cat:r['分类']||'work',taskId:null});}
  return {tasks,blocks};
}

const BACKUP_KEY='le-time:auto-backups:v1';
export function listAutoBackups(){ try{return JSON.parse(localStorage.getItem(BACKUP_KEY)||'[]');}catch{return [];} }
export function createAutoBackup(reason='自动备份',appVersion=''){
  const cfg=S.getState().settings?.autoBackup||{}; const max=Math.min(30,Math.max(3,Number(cfg.keep)||7));
  const rows=listAutoBackups(); rows.unshift({id:`bk_${Date.now()}`,at:Date.now(),reason,payload:fullBackup(appVersion)}); localStorage.setItem(BACKUP_KEY,JSON.stringify(rows.slice(0,max))); return rows[0];
}
export function restoreAutoBackup(id){ const row=listAutoBackups().find(x=>x.id===id); if(!row)throw new Error('备份不存在'); S.replaceAll(parseFullBackup(row.payload)); return S.saveNow(); }
export function deleteAutoBackup(id){ localStorage.setItem(BACKUP_KEY,JSON.stringify(listAutoBackups().filter(x=>x.id!==id))); }
