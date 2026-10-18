import * as S from '../store.js';
import { el, newBadge, toast } from '../ui.js';
import { toggleSwitch } from '../switchControl.js';
import { getLogs, undoLog, getRules, setRuleEnabled, runAutomation } from '../automation.js';
import { createAiAutomationCard } from './aiAutomationPanel.js';
import { pluginDisplayName, pluginDisplayIcon } from '../pluginAppearance.js';
import { getKeywordHighlights, highlightedText } from '../keywordHighlights.js';
import { BUILTIN_PLUGINS } from '../pluginCatalog.js';
import { emptyArt } from '../emptyArt.js';

// v0.249.0：来源 / 规则的小图形（内联 SVG，currentColor，颜色由 ui-accents.css 按 data-* 给）。
const GLYPH_ATTR='viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const GLYPHS={
  ai:'<path d="M10 3.5l1.6 4.4 4.4 1.6-4.4 1.6L10 15.5l-1.6-4.4L4 9.5l4.4-1.6z"/><path d="M17.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  rule:'<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
  'schedule-due':'<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8.5 14.5h3v3h-3z"/>',
  'exam-remind':'<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  'course-sync':'<path d="M19.5 9A8 8 0 0 0 5 7.5M4.5 15A8 8 0 0 0 19 16.5"/><path d="M5 3.5v4h4M19 20.5v-4h-4"/>',
  'daily-tidy':'<path d="M10 3.5l1.6 4.4 4.4 1.6-4.4 1.6L10 15.5l-1.6-4.4L4 9.5l4.4-1.6z"/><path d="M17.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
};
function glyph(tag,cls,kind){const n=el(tag,{class:cls,'data-kind':kind});n.innerHTML=`<svg ${GLYPH_ATTR}>${GLYPHS[kind]||GLYPHS.rule}</svg>`;return n;}
// 旧条目（v0.249.0 之前进收件箱的）只记了 source 文案没记 sourcePlugin：按内置插件名反查一次。
// 插件推送的文案常是「插件名 + 后缀」（如「警大门户通知」），所以前缀匹配也算。
function pluginIdBySource(label){
  if(!label)return '';
  const hit=BUILTIN_PLUGINS.find(p=>p.name===label)||BUILTIN_PLUGINS.find(p=>p.name&&p.name.length>=2&&label.startsWith(p.name));
  return hit?hit.id:'';
}

export function renderInbox(container){
  const st=S.getState(); st.inbox??=[];
  const highlightCfg=getKeywordHighlights(st.settings);
  const wrap=el('div',{class:'inbox-wrap'});
  const head=el('div',{class:'inbox-head'},el('div',{},el('h2',{},'收件箱与自动化'),el('p',{class:'desc'},'来自通知、考试、课程、内置规则和 AI 自动任务的待确认事项集中在这里。')),el('button',{class:'btn pri sm',onclick:async()=>{await runAutomation('manual');renderInbox(container);toast('自动化已运行');}},'立即运行'));
  const grid=el('div',{class:'inbox-grid'});
  const inboxCard=el('section',{class:'card set-card'},el('h3',{},`收件箱 · ${st.inbox.filter(x=>x.status!=='done').length}`));
  const open=st.inbox.filter(x=>x.status!=='done');
  if(!open.length) inboxCard.append(Object.assign(emptyArt('inbox','收件箱清空了 —— 新的通知、考试节点和 AI 任务会出现在这里'),{className:'empty-art inbox-empty-art'}));
  for(const item of open.slice(0,30)){
    // 来源插件：带上插件图标，一眼看出这条是谁放进来的（通知 / 考试 / 收纳…）。
    // 图标走 pluginDisplayIcon，和抽屉里的「来源插件」完全是同一套 —— 免得同一个插件两处长得不一样。
    const srcLabel = item.source || (item.sourcePlugin ? pluginDisplayName(item.sourcePlugin) : '自动化');
    // v0.249.0：没有插件来源的（AI 自动任务 / 内置规则）也给一个 16px 小图形，整列对齐。
    const srcPid = item.sourcePlugin || pluginIdBySource(item.source);
    const srcIcon = srcPid ? pluginDisplayIcon(srcPid, srcLabel)
      : glyph('span','src-glyph',/AI/i.test(srcLabel)||item.sourceKey?.startsWith?.('ai')?'ai':'rule');
    const srcNode = el('span',{class:'inbox-src'},srcIcon,el('span',{},srcLabel));
    // 附件（收纳进来的截图）：显示张数即可，点「建任务」会把它们一起带过去
    const nAtt = Array.isArray(item.attachments) ? item.attachments.length : 0;
    inboxCard.append(el('div',{class:'inbox-item'},
      el('div',{class:'inbox-item-main'},
        el('div',{class:'inbox-title-row'},el('b',{},highlightedText(item.title,highlightCfg)),newBadge(item.status==='new')),
        el('small',{},srcNode,item.when?el('span',{},highlightedText(` · ${item.when}`,highlightCfg)):null,
          nAtt?el('span',{class:'inbox-att'},` · 图 ${nAtt} 张`):null),
        item.note?el('p',{},highlightedText(item.note,highlightCfg)):null),
      el('div',{class:'inbox-actions'},
        item.suggestion==='create-task'?el('button',{class:'btn pri sm',onclick:()=>{
          // ⚠️ `item.when` 是「2026-01-08 23:59」这种**拼好的展示串**，直接塞进 due 会写出
          // 非法日期（宿主按 YYYY-MM-DD 解析，带时间的会被判废 → 提醒静默失效）。
          // 分开取真正的结构化字段，取不到就留空。
          S.addTask({
            title:item.title, note:item.note||'',
            due:item.date||null, dueTime:item.time||'23:59',
            quad:1, tags:[srcLabel],
            attachments:nAtt?item.attachments.slice():undefined,
          });
          item.status='done';S.saveNow();renderInbox(container);toast('已创建任务');
        }},'建任务'):null,
        item.suggestion==='open-course'?el('button',{class:'btn ghost sm',onclick:()=>window.dispatchEvent(new CustomEvent('tide:navigate',{detail:'plug:shiguang-schedule'}))},'打开课程表'):null,
        el('button',{class:'btn ghost sm',onclick:()=>{item.status='done';S.saveNow();renderInbox(container);}},'完成')
      )));
  }
  const ruleCard=el('section',{class:'card set-card'},el('h3',{},'自动化规则'));
  for(const r of getRules()){
    const ck=toggleSwitch({checked:r.enabled,ariaLabel:'启用自动化规则 '+r.name}); ck.onchange=()=>{setRuleEnabled(r.id,ck.checked);};
    ruleCard.append(el('label',{class:'automation-rule','data-action':r.action},glyph('i','ar-ico',r.action),el('span',{},el('b',{},r.name),el('small',{},`${r.trigger} → ${r.action}`)),ck));
  }
  const aiCard=createAiAutomationCard({rerender:()=>renderInbox(container)});
  const logCard=el('section',{class:'card set-card'},el('h3',{},'自动化日志'));
  const logs=getLogs(); if(!logs.length)logCard.append(el('p',{class:'desc'},'暂无自动化操作记录。'));
  for(const row of logs.slice(0,25)) logCard.append(el('div',{class:'auto-log'},el('div',{},el('b',{},row.message),el('small',{},new Date(row.at).toLocaleString('zh-CN'))),row.before?el('button',{class:'btn ghost sm',onclick:async()=>{if(!confirm('撤销这次自动操作？'))return;await undoLog(row.id);renderInbox(container);toast('已撤销');}},'撤销'):null));
  grid.append(inboxCard,ruleCard,aiCard,logCard);wrap.append(head,grid);container.replaceChildren(wrap);
}
