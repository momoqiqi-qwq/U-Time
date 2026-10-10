(function(){
  const groups=[
    {name:"学习与校园",ids:["shiguang-schedule","school-notice","chaoxing-notify","cppu-notify","cppu-calendar","exam-calendar"]},
    {name:"效率与专注",ids:["pomodoro","weekly-report"]},
    {name:"信息与提醒",ids:["gx-news","cn-holiday","wechat-push"]},
    {name:"生活与工具",ids:["dorm-duty","web-collector","inbox-drop"]},
  ];
  const docs={
    "shiguang-schedule":["打开课程表，先设置学期与开学日期","可手动添加，或走“教务导入”：选学校登录教务，或改用文件 / 表格导入","确认预览后选择合并或替换"],
    "school-notice":["填写学校通知/公告网址并检测","公开网站可直接同步；需登录时填写登录信息","图片验证码需要本人查看后手动输入"],
    "chaoxing-notify":["使用账号密码或 Cookie 登录学习通","同步通知并查看完整正文","识别到截止时间后可转为 Le 提醒"],
    "cppu-notify":["打开插件进入智慧警大登录流程","自动恢复会话或自动识别验证码登录，认不出时才手工核对","筛选通知并按需转成提醒"],
    "cppu-calendar":["点击同步教务学期，或手动填写教学起始日与周数","按月查看教学周次","点选日期添加自己的考试、返校等事项"],
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
  function ensureStyle(){
    if(document.getElementById("pg-guide-style"))return;
    const st=document.createElement("style");st.id="pg-guide-style";
    st.textContent=`.pg-btn{transition:transform .12s ease,box-shadow .15s ease,filter .15s ease}
.pg-btn:hover{transform:translateY(-1px);box-shadow:0 3px 10px rgba(34,48,58,.14);filter:brightness(1.04)}
.pg-btn:active{transform:translateY(0) scale(.97);box-shadow:none}`;
    document.head.append(st);
  }
  function button(label,fn,primary){const b=document.createElement("button");b.className="pg-btn";b.textContent=label;b.style.cssText=`border:1px solid var(--border,#E4DFD6);background:${primary?"var(--accent,#2F7C83)":"var(--card,#fff)"};color:${primary?"#fff":"var(--ink,#22303A)"};border-radius:10px;padding:8px 11px;cursor:pointer;font-size:calc(12px * var(--ui-text-scale))`;b.onclick=fn;return b;}
  async function downloadDevDoc(){
    try{
      const text=await tide.assets.text("plugin-development.md");
      const filename="U-Time-插件开发文档.md";
      // 优先走宿主真正落盘（<a download> 在 Tauri WebView 里对 blob: 下载不可靠）
      try{
        const path=await tide.assets.saveText(filename,text);
        tide.notify("开发文档已保存："+path);
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
    groups.forEach(g=>{const sec=document.createElement("section");sec.style.cssText="margin:0 0 26px";sec.innerHTML=`<h3 style="font-size:calc(16px * var(--ui-text-scale));margin:0 0 12px">${esc(g.name)}</h3><div class="guide-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px"></div>`;const grid=sec.querySelector(".guide-grid");g.ids.forEach(id=>{const p=byId[id]||{id,name:id,description:"插件清单中暂未找到此项。",platforms:{}};const steps=docs[id]||["打开插件","按页面提示完成配置","保存后即可使用"];const card=document.createElement("article");card.style.cssText="background:var(--card,#fff);border:1px solid var(--border,#E4DFD6);border-radius:15px;padding:16px;box-shadow:0 2px 8px rgba(34,48,58,.04)";card.innerHTML=`<div style="display:flex;gap:10px;align-items:flex-start"><img src="/icons/plugins/${encodeURIComponent(id)}.png" alt="" style="width:30px;height:30px;border-radius:9px;flex:none;object-fit:contain" onerror="this.style.display='none'"><div style="flex:1;min-width:0;display:flex;justify-content:space-between;gap:10px;align-items:start"><strong style="font-size:calc(15px * var(--ui-text-scale))">${esc(p.name)}</strong><span style="font-size:calc(10px * var(--ui-text-scale));padding:3px 7px;border-radius:10px;background:var(--soft,#F4F1EB);color:var(--muted,#7E8B94);flex:none">${esc(platformText(p.platforms||{}))}</span></div></div><p style="font-size:calc(12px * var(--ui-text-scale));line-height:1.65;color:var(--muted,#687780);margin:9px 0 10px">${esc(p.description)}</p><ol style="padding-left:19px;margin:0;font-size:calc(12px * var(--ui-text-scale));line-height:1.8">${steps.map(x=>`<li>${esc(x)}</li>`).join("")}</ol>`;grid.append(card);});host.append(sec);});
  }
  tide.ui.registerView({id:"plugin-guide",title:"插件使用说明",icon:"circle-question",render});
})();
