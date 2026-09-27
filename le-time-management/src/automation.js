import * as S from './store.js';
import { createAutoBackup } from './dataCenter.js';
import { runDueAiAutomations } from './aiAutomation.js';

const clone=x=>structuredClone(x);
let running=false, timer=null, unsub=null;
const DEFAULT_RULES=[
  {id:'deadline-auto-schedule',name:'截止任务自动排程',enabled:true,trigger:'change',action:'schedule-due'},
  {id:'exam-reminders',name:'考试报名 / 打印 / 考试自动提醒',enabled:true,trigger:'hourly',action:'exam-remind'},
  {id:'course-sync',name:'课程自动同步时间块',enabled:false,trigger:'daily',action:'course-sync'},
  {id:'daily-tidy',name:'每日自动整理',enabled:true,trigger:'daily',action:'daily-tidy'},
];
function cfg(){ const s=S.getState(); s.automation??={}; s.automation.rules??=clone(DEFAULT_RULES); s.automation.logs??=[]; return s.automation; }
export function getRules(){return cfg().rules;}
export function setRuleEnabled(id,on){const r=getRules().find(x=>x.id===id);if(r){r.enabled=on;S.touch();}}
export function getLogs(){return cfg().logs;}
function snapshot(){return {tasks:clone(S.getState().tasks),blocks:clone(S.getState().blocks),inbox:clone(S.getState().inbox||[])};}
function log(rule,message,before=null){const a=cfg(); a.logs.unshift({id:S.uid('log'),at:Date.now(),rule,message,before});a.logs=a.logs.slice(0,120);S.touch();}
export async function undoLog(id){const row=getLogs().find(x=>x.id===id);if(!row?.before)throw new Error('这条记录不可撤销');const st=S.getState();st.tasks=row.before.tasks;st.blocks=row.before.blocks;st.inbox=row.before.inbox;log('undo',`撤销：${row.message}`);await S.saveNow();}
function daysDiff(date){const a=new Date(`${S.todayStr()}T00:00:00`),b=new Date(`${date}T00:00:00`);return Math.round((b-a)/86400000);}
async function scheduleDue(){
  const st=S.getState(), today=S.todayStr();
  const scheduled=new Set(st.blocks.map(b=>b.taskId).filter(Boolean));
  const candidates=st.tasks.filter(t=>!t.done&&t.due&&!scheduled.has(t.id)).sort((a,b)=>String(a.due).localeCompare(String(b.due)));
  for(const t of candidates.slice(0,6)){
    const d=daysDiff(t.due); if(d<0||d>14)continue; const before=snapshot();
    let placed=null;
    for(let i=Math.max(0,d-3);i<=d;i++){const date=S.addDays(today,i);try{placed=S.placeTask(t,date,null,t.tags?.includes('学习')?'study':'work');break;}catch{}}
    if(placed){scheduled.add(t.id);log('deadline-auto-schedule',`已自动安排「${t.title}」到 ${placed.date} ${placed.start}`,before);}
  }
}
function addInbox(item){const s=S.getState();s.inbox??=[];const key=item.sourceKey||`${item.source}:${item.title}:${item.when||''}`;if(s.inbox.some(x=>x.sourceKey===key))return null;const row={id:S.uid('in'),status:'new',createdAt:Date.now(),...item,sourceKey:key};s.inbox.unshift(row);S.touch();return row;}
export function pushInbox(item){return addInbox(item);}
async function dailyTidy(){
  const key=`daily:${S.todayStr()}`; if(cfg().lastDaily===key)return; const before=snapshot(); let moved=0;
  for(const t of S.getState().tasks){if(!t.done&&t.due&&t.due<S.todayStr()){t.due=S.todayStr();moved++;}}
  cfg().lastDaily=key; if(moved)log('daily-tidy',`已把 ${moved} 个逾期任务调整到今天`,before); else S.persistSoon();
}
function examReminderFromStorage(){
  const st=S.getState().plugins?.['exam-calendar']?.storage||{}; const source=st.events||st.data?.events||[]; let n=0;
  for(const ev of Array.isArray(source)?source:[]){const date=ev.date||ev.startDate; if(!date)continue; const d=daysDiff(date); if(d<0||d>7)continue; const title=ev.title||ev.name||'考试节点'; if(addInbox({source:'考试日历',sourceKey:`exam:${ev.id||ev.examId||title}:${date}`,title,when:date,note:d===0?'今天':`${d} 天后`,suggestion:'create-task'}))n++;}
  if(n)log('exam-reminders',`发现 ${n} 个未来 7 天考试节点，已放入收件箱`);
}
function dateAdd(date,n){const [y,m,d]=date.split('-').map(Number);return S.fmtDate(new Date(y,m-1,d+n));}
function monday(date){const [y,m,d]=date.split('-').map(Number),dt=new Date(y,m-1,d);return dateAdd(date,-((dt.getDay()+6)%7));}
function courseTimes(table,c){if(c.isCustomTime)return[c.customStartTime,c.customEndTime];const map=new Map((table.timeSlots||[]).map(x=>[Number(x.number),x]));return[map.get(Number(c.startSection))?.startTime,map.get(Number(c.endSection))?.endTime];}
function currentCourseWeek(table){const a=new Date(monday(table.config.semesterStartDate)+'T12:00:00'),b=new Date(monday(S.todayStr())+'T12:00:00');return Math.floor((b-a)/604800000)+1;}
async function courseSync(){
  const table=S.getState().plugins?.['shiguang-schedule']?.storage?.table; if(!table?.courses?.length||!table?.config?.semesterStartDate)return;
  const week=currentCourseWeek(table); if(week<1||week>Number(table.config.semesterTotalWeeks||20))return;
  const start=dateAdd(monday(table.config.semesterStartDate),(week-1)*7); let added=0, conflicts=0; const before=snapshot();
  for(const c of table.courses){if(!(c.weeks||[]).map(Number).includes(week))continue; const [st,en]=courseTimes(table,c);if(!st||!en)continue;const date=dateAdd(start,Number(c.day||1)-1);const dur=Math.max(15,S.mmOf(en)-S.mmOf(st));
    if(S.getState().blocks.some(b=>b.date===date&&b.start===st&&b.title===c.name))continue;
    const busy=S.blocksOf(date).filter(b=>S.mmOf(st)<S.mmOf(b.start)+b.durMin&&S.mmOf(st)+dur>S.mmOf(b.start));
    // 智能冲突重排：只移动由任务产生的可移动时间块，课程/手工时间块视为固定。
    if(busy.length&&busy.every(b=>b.taskId)){
      for(const b of busy){const task=S.taskById(b.taskId); if(!task)continue;S.removeBlock(b.id);let moved=false;for(let offset=S.mmOf(st)+dur;offset<1320;offset+=15){try{S.placeTask(task,date,offset,b.cat);moved=true;break;}catch{}}if(!moved){S.addBlock(b);conflicts++;}}
    }
    const remains=S.blocksOf(date).some(b=>S.mmOf(st)<S.mmOf(b.start)+b.durMin&&S.mmOf(st)+dur>S.mmOf(b.start));
    if(remains){conflicts++;addInbox({source:'课程表',sourceKey:`course-conflict:${c.id}:${date}`,title:`课程冲突：${c.name}`,when:date,note:`${st}-${en} 与固定日程冲突，请手动处理。`,suggestion:'open-course'});continue;}
    S.addBlock({date,start:st,durMin:dur,title:c.name,taskId:null,cat:'study'});added++;
  }
  if(added||conflicts)log('course-sync',`课程自动同步：新增 ${added} 个时间块${conflicts?`，${conflicts} 个冲突待处理`:''}`,before);
}
export async function runAutomation(reason='manual'){
  if(running)return; running=true;
  try {
    const rules=getRules().filter(r=>r.enabled);
    const has=(action)=>rules.some(r=>r.action===action);
    // change 只跑真正需要实时响应的截止任务排程；避免每次编辑都扫描考试/课程。
    if(has('schedule-due')&&(reason==='change'||reason==='startup'||reason==='manual')) await S.batchChanges(scheduleDue);
    if(reason==='startup'||reason==='manual') {
      if(has('daily-tidy')) await S.batchChanges(dailyTidy);
      if(has('exam-remind')) await S.batchChanges(async()=>examReminderFromStorage());
      if(has('course-sync')) await S.batchChanges(courseSync);
      cfg().lastDailyCycle=S.todayStr(); S.persistSoon();
    } else if(reason==='hourly') {
      if(has('exam-remind')) await S.batchChanges(async()=>examReminderFromStorage());
      // 每小时定时器只在跨日后执行 daily 规则，避免一天重复扫描 24 次。
      if(cfg().lastDailyCycle!==S.todayStr()) {
        if(has('daily-tidy')) await S.batchChanges(dailyTidy);
        if(has('course-sync')) await S.batchChanges(courseSync);
        cfg().lastDailyCycle=S.todayStr(); S.persistSoon();
      }
    }
    // AI 自动任务按分钟检查；startup/manual 也会补跑已经到点但尚未执行的规则。
    if(reason==='startup'||reason==='minute'||reason==='manual') await runDueAiAutomations();
  } finally { running=false; }
}
export function initAutomation(appVersion=''){
  cfg(); const s=S.getState(); s.settings.autoBackup??={enabled:true,frequency:'daily',keep:7};
  const ab=s.settings.autoBackup; const last=Number(localStorage.getItem('le-time:auto-backup:last')||0); const gap=ab.frequency==='weekly'?7*86400000:86400000;
  if(ab.enabled!==false&&Date.now()-last>gap){createAutoBackup('定时自动备份',appVersion);localStorage.setItem('le-time:auto-backup:last',String(Date.now()));}
  window.addEventListener('tide:state-changed',()=>{if(running)return;clearTimeout(timer);timer=setTimeout(()=>runAutomation('change'),800);});
  runAutomation('startup'); setInterval(()=>runAutomation('minute'),60*1000); setInterval(()=>runAutomation('hourly'),60*60*1000);
}
