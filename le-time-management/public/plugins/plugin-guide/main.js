(function(){
  const groups=[
    {name:"学习与校园",ids:["shiguang-schedule","school-notice","chaoxing-notify","cppu-notify","exam-calendar"]},
    {name:"效率与专注",ids:["pomodoro","weekly-report"]},
    {name:"信息与提醒",ids:["gx-news","cn-holiday","wechat-push"]},
    {name:"生活与工具",ids:["dorm-duty","web-collector","inbox-drop"]},
  ];
  const docs={
    "shiguang-schedule":["打开课程表，先设置学期与开学日期","可手动添加，或走“教务导入”：选学校登录教务，或改用文件 / 表格导入","确认预览后选择合并或替换"],
    "school-notice":["填写学校通知/公告网址并检测","公开网站可直接同步；需登录时填写登录信息","图片验证码需要本人查看后手动输入"],
    "chaoxing-notify":["使用账号密码或 Cookie 登录学习通","同步通知并查看完整正文","识别到截止时间后可转为 Le 提醒"],
    "cppu-notify":["打开插件进入智慧警大登录流程","自动恢复会话或自动识别验证码登录，认不出时才手工核对","筛选通知并按需转成提醒","左侧「校园服务 → 教务」可切到学生选课 / 学生请假 / 警大成绩 / 创新学分 / 警大校历（校历自 v0.216.0 起并入本插件，不再单独占一个插件）"],
    "exam-calendar":["选择考试类别或时间范围","查看考试节点和来源说明","把需要关注的日期加入计划"],
    "pomodoro":["选择预设时间或输入自定义倒计时","选择已有任务，或直接新建一个专注任务","开始计时；完成后自动累计专注统计"],
    "weekly-report":["打开后自动读取任务与时间块","查看每天投入、分类占比和完成情况","用周报复盘下一周安排"],
    "gx-news":["设置竞赛关键词和筛选条件","刷新获取竞赛通知","重要消息可直接转成提醒"],
    "cn-holiday":["打开即可优先读取本地节假日数据","需要最新调整时再手动联网更新","用于课程、计划和休息日判断"],
    "wechat-push":["按插件页面配置 PushPlus / 推送参数","选择需要推送的提醒","先测试连接，再开启日常使用"],
    "web-collector":["输入网址后点击自动识别并收藏","检查自动识别的网站名称、favicon 和图标","添加备注后保存，之后可搜索、刷新和一键打开"],
    "dorm-duty":["一个插件里可放多套轮换（宿舍值日 / 公区卫生…），各有自己的成员、周期与提醒时刻，互不影响","选中一套轮换后按顺序添加成员，第一个人先当班；设好起始日期与轮换周期（每天 / 每周 / 自定义 N 天）","「宿舍床位 · 值日星图」里选 4 / 6 / 8 人间：上下铺画成星星，星上是成员名字、星上数字是他在轮换里的位次，连线从第 1 位走到第 x 位；亮绿色的星是今天当班的人，点一颗星可以跳到成员列表里那一行，点星上的名字则就地改名","星图能转：立体 / 俯视 / 正视三个机位，拖动转视角、滚轮或触控板捏合缩放（捏合按手势位移等比缩放，滑多少就缩多少）；下面那条「旋转条」能直接把视角拖到某个角度，松手后接着自动旋转，按「停止」就把角度钉住不再转（鼠标压在星图上也会暂停）；嫌床架线框碍事就把「显示床铺」关掉，只剩星星与连线","支持多人值日：在「轮换规则 → 每轮人数」里选 2～4 人（或自定义 N），每轮就按名单顺序 N 人一起当班","需要时给某一轮临时换人（可勾选多人）；到点会提醒当班的人，也可一键加入今日任务","标签可以右键（小程序端点标签后面的「⋯」）：除了切组、改名、删除，还能把整套轮换连成员带规则复制一份再改名，或从别的轮换按名字导入成员，不用重打一遍名字"],
    "inbox-drop":["把聊天文字、通知截图、网页段落或文件直接拖到面板上；聊天里选中的消息也可以 Ctrl+V 粘贴","插件自动认出来源平台、消息类型与日期时间，在确认条上改错了的字段再收下","确认后进应用收件箱，可一键转成任务或排进时间块；重复消息自动去重","截图会跟着任务走（图片附件）；可执行文件会被拒收并说明原因"],
  };
  function esc(s){return String(s||"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
  function platformText(p){const out=[];if(p.windows!=="unavailable")out.push("Windows");if(p.android!=="unavailable")out.push("Android");if(p.miniprogram&&p.miniprogram!=="unavailable")out.push("小程序");return out.join(" · ")||"暂不可用";}
  // 统一打开外链：权限缺失 / 地址为空 / 打开失败都给出可见反馈，而不是静默无反应
  function safeOpen(url){
    if(!url){tide.notify("该链接暂未配置");return;}
    try{
      const r=tide.util.openUrl(url);
      if(r&&typeof r.catch==="function")r.catch(e=>tide.notify("打开失败："+(e&&e.message||e)));
    }catch(e){tide.notify("打开失败："+(e&&e.message||e));}
  }
  const boundRoots=new WeakSet();
  /* 卡片「翻起」的插件 id。桌面端悬停也会翻（纯 CSS），这个集合负责触屏与键盘 ——
     没有它，手机上的卡片就永远只能看到正面那一层。 */
  const flipped=new Set();
  function ensureStyle(){
    if(document.getElementById("pg-guide-style"))return;
    const st=document.createElement("style");st.id="pg-guide-style";
    st.textContent=`.pg-btn{transition:transform .12s ease,box-shadow .15s ease,filter .15s ease}
.pg-btn:hover{transform:translateY(-1px);box-shadow:0 3px 10px rgba(34,48,58,.14);filter:brightness(1.04)}
.pg-btn:active{transform:translateY(0) scale(.97);box-shadow:none}
/* ── 卡片 3D 翻起详情层（来源：LabOrbit /resources 的卡片动画）──
   .pg-front 是正面（图标 / 名称 / 平台 / 简介），.pg-detail 是从底边立起来的步骤层。
   三条缺一不可：perspective 写在**卡片本体**（写详情层上等于自己给自己透视，翻出来是平的）、
   transform-origin:bottom（像合页从底边往上立）、backface-visibility:hidden（转到 -90° 时
   背面朝外，不隐掉会透出反向镜像）。闭合态停在 -90deg 而不是 +90deg，后者会从顶边垂下来。
   visibility 与 transform 分开延迟：展开立刻可见、收起等转完再隐藏，否则收起动画会被半途掐断。 */
.pg-card{position:relative;perspective:1000px;transform-style:preserve-3d;overflow:hidden;background:var(--card,#fff);border:1px solid var(--border,#E4DFD6);border-radius:15px;box-shadow:0 2px 8px rgba(34,48,58,.04)}
/* 正面只有「图标 + 名字」—— 就是 LabOrbit 那张卡的封面：一个标志、一个标题，其余全翻到背面。
   卡片高度由正面撑开（.pg-detail 是 position:absolute;inset:0，高度跟着卡片走），
   所以 min-height 不能撤：正面一旦变矮，详情层会被一起压扁、步骤被裁掉。
   正面整体就是那颗翻转按钮，触屏与键盘点哪儿都能翻。 */
.pg-front{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:11px;box-sizing:border-box;width:100%;padding:18px 16px;min-height:calc(158px * var(--ui-text-scale));font:inherit;text-align:center;color:inherit;background:none;border:0;cursor:pointer;transition:transform .6s cubic-bezier(.175,.885,.32,1.275),opacity .45s ease}
.pg-front img{width:46px;height:46px;border-radius:13px;flex:none;object-fit:contain}
.pg-front-name{font-size:calc(14px * var(--ui-text-scale));font-weight:750;line-height:1.4;overflow-wrap:anywhere}
.pg-detail{position:absolute;inset:0;z-index:5;box-sizing:border-box;display:flex;flex-direction:column;gap:9px;padding:16px;border-radius:inherit;background:var(--card,#fff);overflow:hidden;transform:rotateX(-90deg);transform-origin:bottom;backface-visibility:hidden;visibility:hidden;pointer-events:none;transition:transform .6s cubic-bezier(.175,.885,.32,1.275),visibility 0s linear .6s}
.pg-card.is-flipped .pg-front{transform:scale(.86);opacity:0;pointer-events:none}
.pg-card.is-flipped .pg-detail{transform:rotateX(0deg);visibility:visible;pointer-events:auto;transition:transform .6s cubic-bezier(.175,.885,.32,1.275),visibility 0s linear 0s}
.pg-head{display:flex;gap:10px;align-items:flex-start;flex:none}
.pg-head img{width:30px;height:30px;border-radius:9px;flex:none;object-fit:contain}
.pg-head-main{flex:1;min-width:0;display:flex;justify-content:space-between;gap:10px;align-items:start}
.pg-name{font-size:calc(15px * var(--ui-text-scale))}
.pg-badge{font-size:calc(10px * var(--ui-text-scale));padding:3px 7px;border-radius:10px;background:var(--soft,#F4F1EB);color:var(--muted,#7E8B94);flex:none}
.pg-desc{font-size:calc(12px * var(--ui-text-scale));line-height:1.65;color:var(--muted,#687780);margin:0;overflow-wrap:anywhere}
.pg-steps{padding-left:19px;margin:0;flex:1 1 auto;min-height:0;overflow:auto;font-size:calc(12px * var(--ui-text-scale));line-height:1.8;color:var(--muted,#687780)}
.pg-steps li{margin-bottom:6px}
.pg-more{align-self:flex-end;margin-top:auto;font-family:inherit;border:1px solid var(--border,#E4DFD6);background:var(--soft,#F4F1EB);color:var(--ink,#22303A);border-radius:9px;padding:5px 10px;font-size:calc(11px * var(--ui-text-scale));cursor:pointer;transition:border-color .16s ease,background .16s ease}
.pg-more:hover{border-color:var(--accent,#2F7C83)}
.pg-detail .pg-more{margin-top:0;flex:none}
/* 鼠标能悬停时悬停即翻（这就是 LabOrbit 的触发方式）；触屏没有 hover，走「查看 N 步」按钮 */
@media (hover:hover) and (pointer:fine){
  .pg-card:hover .pg-front{transform:scale(.86);opacity:0;pointer-events:none}
  .pg-card:hover .pg-detail{transform:rotateX(0deg);visibility:visible;pointer-events:auto;transition:transform .6s cubic-bezier(.175,.885,.32,1.275),visibility 0s linear 0s}
}
@media (prefers-reduced-motion:reduce){
  .pg-front,.pg-detail{transition:none!important}
  .pg-card.is-flipped .pg-front,.pg-card:hover .pg-front{transform:none}
}`;
    document.head.append(st);
  }
  /** 「查看 N 步 / 收起」只切 class，不重建 DOM —— 重建会把滚动位置和焦点一起抹掉。 */
  function toggleCard(btn){
    const card=btn.closest&&btn.closest(".pg-card");
    if(!card||!card.classList)return;
    const id=btn.getAttribute("data-pg-more");
    const on=!flipped.has(id);
    if(on)flipped.add(id);else flipped.delete(id);
    card.classList.toggle("is-flipped",on);
    card.querySelectorAll("[data-pg-more]").forEach(b=>b.setAttribute("aria-expanded",String(on)));
  }
  function button(label,fn,primary){const b=document.createElement("button");b.className="pg-btn";b.textContent=label;b.style.cssText=`border:1px solid var(--border,#E4DFD6);background:${primary?"var(--accent,#2F7C83)":"var(--card,#fff)"};color:${primary?"#fff":"var(--ink,#22303A)"};border-radius:10px;padding:8px 11px;cursor:pointer;font-size:calc(12px * var(--ui-text-scale))`;b.onclick=fn;return b;}
  async function downloadDevDoc(){
    try{
      const text=await tide.assets.text("plugin-development.md");
      const filename="U-Time-插件开发文档.md";
      // 优先走宿主真正落盘（<a download> 在 Tauri WebView 里对 blob: 下载不可靠）
      try{
        const path=await tide.assets.saveText(filename,text);
        // 整卡可点：点一下在系统文件管理器里定位到刚存下的那份文档（Windows 会选中它）
        tide.notify("开发文档已保存："+path,{ms:8000,onClickHint:"点击定位文件",onClick:()=>{tide.assets.revealSaved(path).catch(e=>tide.notify("请手动到下载目录查看："+path+"（"+(e&&e.message||e)+"）",{ms:10000}));}});
        return;
      }catch(e){
        // 浏览器调试环境或平台不支持 → 退回 blob 下载
        try{
          const blob=new Blob([text],{type:"text/markdown;charset=utf-8"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
        }catch{/* 下载通道不可用时走剪贴板兜底 */}
        let copied=false;
        try{await navigator.clipboard.writeText(text);copied=true;}catch{}
        tide.notify(copied?"已回退为复制全文到剪贴板（当前环境不支持保存文件）":"文档已开始下载；若未弹出保存框，全文已复制到剪贴板");
      }
    }
    catch(e){tide.notify("下载失败："+(e&&e.message||e));}
  }
  function render(root){
    ensureStyle();
    if(!boundRoots.has(root)){
      boundRoots.add(root);
      // 委托在 root 上、并只挂一次：重挂会叠加处理器，切一次视图就切两次
      root.addEventListener("click",e=>{
        const btn=e.target&&e.target.closest&&e.target.closest("[data-pg-more]");
        if(btn)toggleCard(btn);
      });
    }
    const links=tide.app&&tide.app.links?tide.app.links:{};
    const all=(tide.plugins&&tide.plugins.list?tide.plugins.list():[]).filter(x=>x.id!=="plugin-guide");
    const byId=Object.fromEntries(all.map(x=>[x.id,x]));
    root.innerHTML=`<div style="max-width:1100px;margin:0 auto;padding:24px"><div style="margin-bottom:18px"><h2 style="margin:0 0 7px;font-size:calc(25px * var(--ui-text-scale))">插件使用说明</h2><div style="color:var(--muted,#7E8B94);font-size:calc(13px * var(--ui-text-scale));line-height:1.7">按场景分类查看。插件名称、说明和平台能力直接读取主程序插件目录，避免文档与实际清单分叉。</div></div><div id="guide-resources" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px"></div><div id="guide-groups"></div><div style="margin-top:10px;padding:13px 15px;border:1px solid var(--border,#E4DFD6);border-radius:12px;color:var(--muted,#687780);font-size:calc(12px * var(--ui-text-scale));line-height:1.7">安全提示：当前外部 ZIP 插件仍属于受信任扩展模型。只安装来源可信、你已审核过的插件。</div></div>`;
    const r=root.querySelector("#guide-resources");
    r.append(
      button("官方网站",()=>safeOpen(links.website),true),
      button("项目仓库",()=>safeOpen(links.repository||"https://github.com/momoqiqi-qwq/U-Time")),
      button("下载插件开发文档",downloadDevDoc),
    );
    const host=root.querySelector("#guide-groups");
    groups.forEach(g=>{
      const sec=document.createElement("section");sec.style.cssText="margin:0 0 26px";
      sec.innerHTML=`<h3 style="font-size:calc(16px * var(--ui-text-scale));margin:0 0 12px">${esc(g.name)}</h3><div class="guide-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px"></div>`;
      const grid=sec.querySelector(".guide-grid");
      g.ids.forEach(id=>{
        const p=byId[id]||{id,name:id,description:"插件清单中暂未找到此项。",platforms:{}};
        const steps=docs[id]||["打开插件","按页面提示完成配置","保存后即可使用"];
        const on=flipped.has(id);
        // 正面是「封面」：只有图标 + 名字。平台、简介、步骤全在翻起来的详情层里 ——
        // 这就是 LabOrbit 那张卡的分工：封面朝前、内容朝后。两层共用同一个 icon 变量，
        // 翻过去看到的是同一个标志，不会觉得换了一张卡。
        const icon=`<img src="/icons/plugins/${encodeURIComponent(id)}.png" alt="" onerror="this.style.display='none'">`;
        const front=`<button type="button" class="pg-front" data-pg-more="${esc(id)}" aria-expanded="${on?"true":"false"}" aria-controls="pg-detail-${esc(id)}" aria-label="${esc(p.name)}：查看 ${steps.length} 步操作">${icon}<strong class="pg-front-name">${esc(p.name)}</strong></button>`;
        const head=`<div class="pg-head">${icon}<div class="pg-head-main"><strong class="pg-name">${esc(p.name)}</strong><span class="pg-badge">${esc(platformText(p.platforms||{}))}</span></div></div>`;
        const more=label=>`<button type="button" class="pg-more" data-pg-more="${esc(id)}" aria-expanded="${on?"true":"false"}" aria-controls="pg-detail-${esc(id)}">${label}</button>`;
        const card=document.createElement("article");
        card.className="pg-card"+(on?" is-flipped":"");
        card.innerHTML=`${front}<div class="pg-detail" id="pg-detail-${esc(id)}">${head}<p class="pg-desc">${esc(p.description)}</p><ol class="pg-steps">${steps.map(x=>`<li>${esc(x)}</li>`).join("")}</ol>${more("收起 ▴")}</div>`;
        grid.append(card);
      });
      host.append(sec);
    });
  }
  tide.ui.registerView({id:"plugin-guide",title:"插件使用说明",icon:"circle-question",render});
})();
