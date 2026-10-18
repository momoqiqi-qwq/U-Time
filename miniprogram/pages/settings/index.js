// 设置页：数据统计、备份导出/导入（与桌面端同一 JSON 格式）、关于
const store = require("../../core/store.js");
const taskReminder = require("../../core/taskReminder.js");
const appMeta = require("../../core/appMeta.js");
const transfer = require("../../core/transfer.js");
const files = require("../../core/files.js");
const undo = require("../../core/undo.js");
const lan = require("../../core/lanSync.js");

Page({
  data: {
    stats: { tasks: 0, open: 0, done: 0, blocks: 0, kb: "0" },
    importText: "", fileName: "", preview: null, restoreMode: 0, restoreOptions: ["合并：新增记录，重号保留本机", "替换：用备份完整恢复"],
    lanAddress: "", lanToken: "", lanMessage: "", lanBusy: false, pushId: "", storageError: "", locked: false,
    reminder: { enabled: true, volume: 75, sound: "beep", customAudioName: "尚未导入" },
    soundOptions: ["内置提示音", "自定义音频"],
    showPluginDesc: false,
    about: appMeta,
  },

  onLoad() { this._unloaded = false; const cfg = store.getState().settings.miniLan || {}; this.setData({ lanAddress:cfg.address || "",lanToken:cfg.token || "" }); },
  onShow() { if (this._unsub) this._unsub(); this._unsub = store.subscribe(() => this.refresh()); this.refresh(); },
  onHide() { if (this._unsub) { this._unsub(); this._unsub = null; } },
  onUnload() { this._unloaded = true; this.onHide(); },

  refresh() {
    const st = store.getState();
    const open = st.tasks.filter((t) => !t.done).length;
    let kb = "0";
    let total = 0, limit = 10240;
    try {
      kb = String(Math.max(1, Math.round(JSON.stringify(st).length / 1024)));
    } catch (e) { /* 忽略 */ }
    try {
      const info = wx.getStorageInfoSync(); total = info.currentSize || 0; limit = info.limitSize || 10240;
    } catch (e) { /* 忽略 */ }
    const rc = taskReminder.cfg();
    this.setData({
      storageError: store.storageStatus().error, locked: store.storageStatus().locked,
      showPluginDesc: !!(st.settings && st.settings.showPluginDesc),
      reminder: { enabled: rc.enabled !== false, volume: Math.round((Number(rc.volume)||0)*100), sound: rc.sound || "beep", customAudioName: rc.customAudioName || "尚未导入" },
      stats: {
        tasks: st.tasks.length,
        open,
        done: st.tasks.length - open,
        blocks: st.blocks.length,
        kb,
        total, limit,
        warn: total > limit * .75,
      },
    });
  },

  onReminderEnabled(e) { const c=taskReminder.cfg(); c.enabled=!!e.detail.value; store.saveNow(); this.refresh(); },
  onReminderVolume(e) { const c=taskReminder.cfg(); c.volume=Number(e.detail.value)/100; store.saveNow(); this.setData({"reminder.volume":Number(e.detail.value)}); },
  onSoundChange(e) { const c=taskReminder.cfg(); c.sound=+e.detail.value===1?"custom":"beep"; store.saveNow(); this.refresh(); },
  onTestSound() { taskReminder.play(); },
  onImportAudio() {
    wx.chooseMessageFile({count:1,type:"file",extension:["mp3","wav","m4a","aac","ogg"],success:(r)=>{
      const f=r.tempFiles&&r.tempFiles[0]; if(!f)return;
      if(f.size>8*1024*1024){wx.showToast({title:"音频请控制在 8MB 内",icon:"none"});return;}
      wx.saveFile({tempFilePath:f.path,success:(x)=>{const c=taskReminder.cfg(); c.customAudioPath=x.savedFilePath; c.customAudioName=f.name||"自定义音频"; c.sound="custom"; store.saveNow(); this.refresh(); wx.showToast({title:"提醒音已导入",icon:"none"});},fail:()=>wx.showToast({title:"音频保存失败",icon:"none"})});
    }});
  },

  onShowPluginDesc(e) { store.getState().settings.showPluginDesc = !!e.detail.value; store.saveNow(); this.refresh(); },

  onPlugins() { wx.navigateTo({ url: "/pages/plugins/index" }); },
  // 赞助：小程序里没有「保存到下载目录」，走系统图片预览（长按可保存/转发）。
  onPreviewSponsor() { wx.previewImage({ urls: ["/images/support/sponsor-qr.png"], current: "/images/support/sponsor-qr.png" }); },

  async onExport() {
    try { await files.copyText(JSON.stringify(transfer.fullBackup(appMeta.version), null, 2)); }
    catch (error) { files.notifyError(error); }
  },
  async onExportFile(e) {
    try {
      if (store.storageStatus().locked) throw new Error("原存档不可读，不能导出空白保护视图作为备份");
      const kind=e.currentTarget.dataset.kind;
      const data=kind==="tasks"?transfer.tasksToCsv():kind==="blocks"?transfer.blocksToCsv():kind==="ics"?transfer.toIcs():JSON.stringify(transfer.fullBackup(appMeta.version),null,2);
      const ext=kind==="tasks"||kind==="blocks"?"csv":kind==="ics"?"ics":"json";
      await files.exportText("U-Time-"+(kind||"backup")+"-"+store.todayStr()+"."+ext,data);
    }catch(error){files.notifyError(error);}
  },
  onImportText(e) { this._fileText=null;this._pending=null;this.setData({ importText:e.detail.value,fileName:"",preview:null }); },
  onRestoreMode(e) { this.setData({restoreMode:Number(e.detail.value)}); },
  async onChooseBackup() {
    try { const file=await files.readText(["json","csv"]); if(file&&!this._unloaded){this._fileText=file.text;this._fileCsv=/\.csv$/i.test(file.name);this._pending=null;this.setData({fileName:file.name,importText:"",preview:null});this.onImport();} }
    catch(error){files.notifyError(error);}
  },
  onImport() {
    try {
      const text=this._fileText||this.data.importText;
      if(!String(text||"").trim())throw new Error("请选择备份文件或粘贴 JSON");
      this._pending=this._fileText&&this._fileCsv?transfer.parseTasksCsv(text):transfer.parseFullBackup(text);
      this.setData({preview:transfer.summary(this._pending)});
    }catch(error){this._pending=null;this.setData({preview:null});files.notifyError(error);}
  },
  onConfirmImport() {
    if(!this._pending)return;
    const pending=this._pending, mode=this.data.restoreMode===1?"replace":"merge";
    wx.showModal({title:mode==="replace"?"确认替换当前数据":"确认合并备份",content:mode==="replace"?"当前任务、时间块、收件箱和插件配置将被备份替换。建议先导出当前备份。":"仅补充新记录和缺少的设置；相同 id 的任务、已有插件配置以本机为准。",confirmColor:mode==="replace"?"#C43C3C":"#0F4C5C",success:r=>{
      if(!r.confirm)return;
      try { transfer.importBackup(pending,mode);undo.clear();this._pending=null;this._fileText=null;this.setData({importText:"",fileName:"",preview:null});this.refresh();wx.showToast({title:"导入并保存成功",icon:"none"}); }
      catch(error){files.notifyError(error);}
    }});
  },
  onInbox() { wx.navigateTo({url:"/pages/inbox/index"}); },
  onLanInput(e) { const key=e.currentTarget.dataset.field;if(["lanAddress","lanToken"].includes(key))this.setData({[key]:e.detail.value}); },
  lanTarget() {
    const target=lan.parseTarget(this.data.lanAddress,this.data.lanToken);
    this.setData({lanAddress:target.base,lanToken:target.token});
    if(!store.storageStatus().locked){store.getState().settings.miniLan={address:target.base,token:target.token};if(!store.saveNow())throw new Error("配对信息未能保存，请先释放本机存储空间");}
    return target;
  },
  async onLanInfo() {
    if(this.data.lanBusy)return;
    try {const target=this.lanTarget();this.setData({lanBusy:true,lanMessage:"正在连接电脑…"});const info=await lan.info(target);if(!this._unloaded)this.setData({lanMessage:"电脑有 "+info.tasks+" 条任务、"+info.blocks+" 个时间块。电脑版本 "+(info.appVersion||"未知")});}
    catch(error){if(!this._unloaded)this.setData({lanMessage:files.errorText(error)});}
    finally{if(!this._unloaded)this.setData({lanBusy:false});}
  },
  async onLanPull() {
    if(this.data.lanBusy)return;
    try {const target=this.lanTarget();this.setData({lanBusy:true,lanMessage:"正在拉取，只读取电脑数据…"});const pending=await lan.pull(target);if(this._unloaded)return;this._pending=pending;this.setData({preview:transfer.summary(pending),fileName:"来自局域网电脑",importText:"",lanMessage:"已读取到备份。请在上方预览区选择合并或替换，再确认导入。"});}
    catch(error){if(!this._unloaded)this.setData({lanMessage:files.errorText(error)});}
    finally{if(!this._unloaded)this.setData({lanBusy:false});}
  },
  onLanPush() {
    if(this.data.lanBusy||store.storageStatus().locked)return;
    wx.showModal({title:"向电脑提交本机快照",content:"这是整份替换请求，不是增量合并。电脑必须开启允许回传，并在电脑弹窗中点“接收”；接收前会由电脑建立恢复点。仅在可信 Wi-Fi 使用。",success:async r=>{
      if(!r.confirm)return;
      try{const target=this.lanTarget();this.setData({lanBusy:true,lanMessage:"正在提交，尚未生效…",pushId:""});const ack=await lan.push(target,store.getState());this._pushTarget=target;if(!this._unloaded)this.setData({pushId:ack.id,lanMessage:"已提交，等待电脑端确认。电脑确认后点击“查询接收结果”；离开本页不会代替电脑确认。"});}
      catch(error){if(!this._unloaded)this.setData({lanMessage:files.errorText(error)});}
      finally{if(!this._unloaded)this.setData({lanBusy:false});}
    }});
  },
  async onLanStatus() {
    if(!this.data.pushId||!this._pushTarget||this.data.lanBusy)return;
    this.setData({lanBusy:true});
    try{const result=await lan.status(this._pushTarget,this.data.pushId);if(!this._unloaded)this.setData({lanMessage:result.status==="accepted"?"电脑已确认接收":result.status==="pending"?"仍在等待电脑上的确认":"电脑未接收："+(result.note||result.status)});}
    catch(error){if(!this._unloaded)this.setData({lanMessage:files.errorText(error)});}
    finally{if(!this._unloaded)this.setData({lanBusy:false});}
  },

  onResetSeed() {
    wx.showModal({
      title: "清空当前数据",
      content: "清空当前任务、排程、收件箱与插件配置。请先导出备份。旧版迁移回退副本不自动删除；首启不会添加示例数据。",
      confirmText: "确认清空",
      confirmColor: "#C43C3C",
      success: (r) => {
        if (!r.confirm) return;
        try { store.commitSnapshot(store.seed()); undo.clear(); this.refresh(); wx.showToast({ title: "当前数据已清空", icon: "none" }); }
        catch (error) { files.notifyError(error); }
      },
    });
  },
});
