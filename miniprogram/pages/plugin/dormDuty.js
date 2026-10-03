const store = require("../../core/store.js");
const runtime = require("../../core/pluginRuntime.js");

module.exports = {
  /* ── 轮换值日 ──
     与桌面端 dorm-duty 同源存储键（groups / activeId）；页面只负责「读 storage → 纯函数算 →
     写回 storage」，轮换数学全在 core/pluginRuntime.js（那里能在 Node 下真跑边界）。
     一个插件里可以有多套互相独立的轮换（宿舍值日 / 公区卫生…）。 */
  /** 读整份轮换列表（已归一化）。 */
  ddGroups() {
    return runtime.ddGroups(store.pluginStorageGet("dorm-duty", "groups", null), store.todayStr());
  },
  /** 改**当前组**：fn(组) → 新组，写回整份 groups 后重绘。当前组不存在时什么都不做。 */
  ddCommit(fn) {
    const groups = this.ddGroups();
    const id = (this.data.dd && this.data.dd.activeId) || "";
    if (!groups.some((g) => g.id === id)) return;
    store.pluginStorageSet("dorm-duty", "groups", runtime.ddWithGroup(groups, id, fn));
    this.loadDormDuty();
  },
  loadDormDuty() {
    const today = store.todayStr();
    const dd = runtime.dormDutySummary(today);
    dd.newMemberName = (this.data.dd && this.data.dd.newMemberName) || "";
    dd.newLocationName = (this.data.dd && this.data.dd.newLocationName) || "";
    dd.remindBanner = [];
    // 到点提醒：小程序不常驻后台、宿主也不给定时回调，只能在打开本页时补一次。
    // 先落盘「已提醒」再弹提示 —— 万一多个入口同时打开，也只有一个能抢到写入。
    const groups = this.ddGroups();
    const due = runtime.ddDueReminders(groups, today);
    if (due.length) {
      store.pluginStorageSet("dorm-duty", "groups", runtime.ddMarkNotified(groups, due.map((d) => d.groupId), today));
      dd.lastNotified = today;
      dd.remindBanner = due.map((d) => ({ group: d.groupName, name: d.whoName, location: d.location, time: d.time }));
      wx.showToast({
        title: due.length > 1
          ? "有 " + due.length + " 项轮换今天换人"
          : "今天轮到「" + due[0].whoName + "」" + due[0].groupName,
        icon: "none",
      });
      try { if (wx.vibrateShort) wx.vibrateShort({ type: "light" }); } catch (e) { /* 部分机型不支持，忽略 */ }
    }
    this.setData({ dd });
  },
  /** 切换当前轮换。 */
  onDdGroup(e) {
    const id = e.currentTarget.dataset.id;
    if (!this.ddGroups().some((g) => g.id === id)) return;
    store.pluginStorageSet("dorm-duty", "activeId", id);
    this.loadDormDuty();
  },
  onDdGroupNew() {
    const groups = this.ddGroups();
    const ng = runtime.ddAddGroup(groups, store.todayStr(), "轮换 " + (groups.length + 1));
    if (!ng) { wx.showToast({ title: "最多 " + runtime.DD_GROUP_MAX + " 套轮换，先删掉不用的", icon: "none" }); return; }
    store.pluginStorageSet("dorm-duty", "groups", groups.concat([ng]));
    store.pluginStorageSet("dorm-duty", "activeId", ng.id);
    this.loadDormDuty();
    wx.showToast({ title: "已新建「" + ng.name + "」，在下面改名并加成员", icon: "none" });
  },
  onDdGroupDel() {
    const dd = this.data.dd || {};
    if (!dd.canDelGroup) { wx.showToast({ title: "至少要留一套轮换", icon: "none" }); return; }
    this.ddGroupRemove(dd.activeId, dd.groupName);
  },
  /** 整份替换 groups（复制 / 导入 / 删除都要改列表本身，ddCommit 只能改当前组）。 */
  ddSetGroups(groups, activeId) {
    store.pluginStorageSet("dorm-duty", "groups", groups);
    if (activeId) store.pluginStorageSet("dorm-duty", "activeId", activeId);
    this.loadDormDuty();
  },
  /** 「⋯」菜单：桌面端右键菜单的触屏等价物（WebView 长按普通按钮不会触发 contextmenu，
      所以移动端只能给一个显式入口）。操作对象是**被点的那个标签**（data-id），
      不是当前组 —— 否则点「公区值日」的 ⋯ 会去改「宿舍值日」。 */
  onDdGroupMenu(e) {
    const id = e.currentTarget.dataset.id;
    const groups = this.ddGroups();
    if (!groups.some((g) => g.id === id)) return;
    const acts = ["切到这一组", "重命名", "再添加一个", "导入成员"];
    if (groups.length > 1) acts.push("删除这一组");   // 最后一套不可删，干脆不列出来
    wx.showActionSheet({
      itemList: acts,
      success: (res) => {
        const act = acts[res.tapIndex];
        if (act === "切到这一组") this.onDdGroup(e);
        else if (act === "重命名") this.ddGroupRename(id);
        else if (act === "再添加一个") this.ddGroupDuplicate(id);
        else if (act === "导入成员") this.ddGroupImport(id);
        else if (act === "删除这一组") {
          const hit = this.ddGroups().filter((g) => g.id === id)[0];
          if (hit) this.ddGroupRemove(id, hit.name);
        }
      },
    });
  },
  ddGroupRename(id) {
    const hit = this.ddGroups().filter((g) => g.id === id)[0];
    if (!hit) return;
    wx.showModal({
      title: "重命名轮换", editable: true, placeholderText: hit.name, content: hit.name,
      success: (res) => {
        if (!res.confirm) return;
        const name = String(res.content || "").trim();
        if (!name) { wx.showToast({ title: "名字不能为空", icon: "none" }); return; }
        this.ddSetGroups(runtime.ddWithGroup(this.ddGroups(), id,
          (g) => runtime.ddGroupPatch(g, { name: name.slice(0, runtime.DD_NAME_MAX) })));
      },
    });
  },
  /** 复制完立刻要名字 —— 与桌面端「再添加一个」同一流程。取消改名就沿用「XX 2」。 */
  ddGroupDuplicate(id) {
    const out = runtime.ddDuplicateGroup(this.ddGroups(), id, store.todayStr());
    if (!out) { wx.showToast({ title: "最多 " + runtime.DD_GROUP_MAX + " 套轮换，先删掉不用的", icon: "none" }); return; }
    this.ddSetGroups(out.groups, out.activeId);
    wx.showModal({
      title: "给复制出来的这套改个名字", editable: true, placeholderText: out.created.name, content: out.created.name,
      success: (res) => {
        if (!res.confirm) return;
        const name = String(res.content || "").trim();
        if (!name) return;
        this.ddSetGroups(runtime.ddWithGroup(this.ddGroups(), out.created.id,
          (g) => runtime.ddGroupPatch(g, { name: name.slice(0, runtime.DD_NAME_MAX) })));
      },
    });
  },
  ddGroupImport(id) {
    const others = this.ddGroups().filter((g) => g.id !== id);
    if (!others.length) { wx.showToast({ title: "还没有别的轮换可以导入", icon: "none" }); return; }
    wx.showActionSheet({
      itemList: others.map((g) => g.name + "（" + g.members.length + " 人）"),
      success: (res) => {
        const src = others[res.tapIndex];
        if (!src) return;
        const out = runtime.ddImportMembers(this.ddGroups(), id, src.id);
        if (!out.added) { wx.showToast({ title: "那套轮换的人已经都在这份名单里了", icon: "none" }); return; }
        this.ddSetGroups(out.groups);
        const hit = this.ddGroups().filter((g) => g.id === id)[0];
        wx.showToast({ title: "已给「" + (hit ? hit.name : "这套轮换") + "」导入 " + out.added + " 人", icon: "none" });
      },
    });
  },
  ddGroupRemove(id, name) {
    wx.showModal({
      title: "删除轮换",
      content: "删除「" + name + "」？它的成员、换人记录和提醒设置会一起删掉。",
      success: (res) => {
        if (!res.confirm) return;
        const out = runtime.ddRemoveGroup(this.ddGroups(), id, (this.data.dd || {}).activeId);
        if (!out.ok) { wx.showToast({ title: "至少要留一套轮换", icon: "none" }); return; }
        this.ddSetGroups(out.groups, out.activeId);
        wx.showToast({ title: "已删除「" + name + "」", icon: "none" });
      },
    });
  },
  onDdNewNameInput(e) { this.setData({ "dd.newMemberName": e.detail.value }); },
  onDdAddMember() {
    const dd = this.data.dd || {};
    const name = String(dd.newMemberName || "").trim();
    if (!name) { wx.showToast({ title: "先填成员名字", icon: "none" }); return; }
    this.setData({ "dd.newMemberName": "" });
    this.ddCommit((g) => runtime.ddGroupAddMember(g, name));
  },
  /** 改名走 showModal(editable)：比在列表里塞输入框省空间，也不会误触键盘挡住整屏。 */
  onDdRename(e) {
    const id = e.currentTarget.dataset.id;
    const hit = ((this.data.dd || {}).members || []).filter((m) => m.id === id)[0];
    if (!hit) return;
    wx.showModal({
      title: "改成员名字", editable: true, placeholderText: hit.name, content: hit.name,
      success: (res) => {
        if (!res.confirm) return;
        const name = String(res.content || "").trim();
        if (!name) { wx.showToast({ title: "名字不能为空", icon: "none" }); return; }
        this.ddCommit((g) => runtime.ddGroupRenameMember(g, id, name));
      },
    });
  },
  onDdMemberUp(e) { this.ddMove(e.currentTarget.dataset.id, -1); },
  onDdMemberDown(e) { this.ddMove(e.currentTarget.dataset.id, 1); },
  ddMove(id, delta) {
    const groups = this.ddGroups();
    const g = groups.filter((x) => x.id === ((this.data.dd || {}).activeId))[0];
    if (!g) return;
    if (runtime.ddGroupMoveMember(g, id, delta) === g) return;   // 已在首/末位，别写一次没意义的存储
    this.ddCommit((cur) => runtime.ddGroupMoveMember(cur, id, delta));
  },
  ddCurrentTime() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  },
  onDdDragStart(e) {
    const id = e.currentTarget.dataset.id;
    const touch = (e.touches || [])[0];
    const members = ((this.data.dd || {}).members || []);
    const at = members.findIndex((m) => m.id === id);
    if (!id || !touch || at < 0) return;
    this._ddDrag = { id, startY: touch.clientY, from: at };
    this.setData({ "dd.dragMemberId": id });
  },
  onDdDragMove(e) {
    if (!this._ddDrag) return;
    const touch = (e.touches || [])[0];
    if (touch) this._ddDrag.lastY = touch.clientY;
  },
  onDdDragEnd(e) {
    const drag = this._ddDrag;
    this._ddDrag = null;
    this.setData({ "dd.dragMemberId": "" });
    if (!drag) return;
    const touch = (e.changedTouches || [])[0];
    const endY = touch ? touch.clientY : (drag.lastY || drag.startY);
    const rowH = 58; // rpx 视觉高度约等于 58px 级别；只在松手时折算目标位。
    const delta = Math.round((endY - drag.startY) / rowH);
    if (!delta) return;
    const members = ((this.data.dd || {}).members || []);
    const to = Math.max(0, Math.min(members.length - 1, drag.from + delta));
    if (to === drag.from) return;
    this.ddCommit((g) => runtime.ddGroupMoveMemberTo(g, drag.id, to));
  },
  onDdDragCancel() {
    this._ddDrag = null;
    this.setData({ "dd.dragMemberId": "" });
  },
  onDdMemberRemove(e) {
    const id = e.currentTarget.dataset.id;
    const hit = ((this.data.dd || {}).members || []).filter((m) => m.id === id)[0];
    if (!hit) return;
    wx.showModal({
      title: "移除成员", content: "把「" + hit.name + "」移出这套轮换？之后可以从「已移除」恢复。",
      success: (res) => {
        if (!res.confirm) return;
        this.ddCommit((g) => runtime.ddGroupRemoveMember(g, id));
      },
    });
  },
  onDdRestore(e) {
    const id = e.currentTarget.dataset.id;
    this.ddCommit((g) => runtime.ddGroupRestoreMember(g, id));
  },
  onDdPeriod(e) {
    const days = Number(e.currentTarget.dataset.days) || 7;
    this.ddCommit((g) => runtime.ddGroupPatch(g, { periodDays: days }));
  },
  onDdLocationPeriod(e) {
    const days = Number(e.currentTarget.dataset.days);
    if (days >= 1 && days <= 365) this.ddCommit((g) => runtime.ddGroupPatch(g, { locationPeriodDays: days }));
  },
  onDdLocationPeriodCustom() {
    const current = (this.data.dd || {}).cfg.locationPeriodDays || 7;
    wx.showModal({ title: "地点更换间隔", editable: true, content: String(current), placeholderText: "1～365 天", success: (res) => {
      if (!res.confirm) return;
      const days = Number(String(res.content || "").trim());
      if (!Number.isInteger(days) || days < 1 || days > 365) { wx.showToast({ title: "请输入 1～365 天", icon: "none" }); return; }
      this.ddCommit((g) => runtime.ddGroupPatch(g, { locationPeriodDays: days }));
    } });
  },
  onDdNewLocationInput(e) { this.setData({ "dd.newLocationName": e.detail.value }); },
  onDdAddLocation() {
    const name = String((this.data.dd || {}).newLocationName || "").trim();
    if (!name) { wx.showToast({ title: "先输入地点", icon: "none" }); return; }
    const dd = this.data.dd || {};
    if (!dd.canAddLocation) { wx.showToast({ title: "最多添加 12 个地点", icon: "none" }); return; }
    if ((dd.locations || []).some((item) => item.name === name.slice(0, 24))) { wx.showToast({ title: "这个地点已经添加", icon: "none" }); return; }
    this.setData({ "dd.newLocationName": "" });
    this.ddCommit((g) => runtime.ddGroupAddLocation(g, name));
  },
  onDdLocationRename(e) {
    const index = Number(e.currentTarget.dataset.index);
    const current = ((this.data.dd || {}).locations || [])[index];
    if (!current) return;
    wx.showModal({ title: "修改地点", editable: true, content: current.name, success: (res) => {
      if (!res.confirm) return;
      const name = String(res.content || "").trim().slice(0, 24);
      const list = (this.data.dd || {}).locations || [];
      if (!name || list.some((item, i) => i !== index && item.name === name)) { wx.showToast({ title: "地点不能为空或重复", icon: "none" }); return; }
      this.ddCommit((g) => runtime.ddGroupPatch(g, { locations: g.locations.map((v, i) => i === index ? name : v) }));
    } });
  },
  onDdLocationUp(e) { this.ddCommit((g) => runtime.ddGroupMoveLocation(g, Number(e.currentTarget.dataset.index), -1)); },
  onDdLocationDown(e) { this.ddCommit((g) => runtime.ddGroupMoveLocation(g, Number(e.currentTarget.dataset.index), 1)); },
  onDdLocationRemove(e) { this.ddCommit((g) => runtime.ddGroupRemoveLocation(g, Number(e.currentTarget.dataset.index))); },
  /** 每轮人数（多人值日）：1 = 单人；N = 每轮按名单顺序 N 人一起当班。 */
  onDdPerRound(e) {
    const n = Math.max(1, Math.round(Number(e.currentTarget.dataset.n) || 1));
    const cur = (this.data.dd || {}).perRound || 1;
    if (n === cur) return;
    this.ddCommit((g) => runtime.ddGroupPatch(g, { perRound: n }));
  },
  /** 轮换名 / 起始日 / 时刻都改成失焦或选择后提交：输入过程中反复落盘会把 storage 写爆，也没意义。 */
  onDdGroupName(e) {
    const raw = String(e.detail.value || "").trim();
    const cur = (this.data.dd && this.data.dd.groupName) || "";
    if (!raw || raw === cur) { this.loadDormDuty(); return; }    // 空值回显原值，不落盘
    this.ddCommit((g) => runtime.ddGroupPatch(g, { name: raw.slice(0, runtime.DD_NAME_MAX) }));
  },
  onDdStartDate(e) {
    const v = String(e.detail.value || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { this.loadDormDuty(); return; }
    this.ddCommit((g) => runtime.ddGroupPatch(g, { startDate: v }));
  },
  onDdPauseDate(e) {
    const field = e.currentTarget.dataset.field;
    if (field === "pauseStart" || field === "pauseEnd") this.setData({ ["dd." + field]: e.detail.value });
  },
  onDdPauseAdd() {
    const dd = this.data.dd || {}, start = dd.pauseStart, end = dd.pauseEnd;
    if (!start || !end || start > end) { wx.showToast({ title: "请选择有效的起止日期", icon: "none" }); return; }
    this.ddCommit(g => runtime.ddGroupPatch(g, { pauseRanges: g.pauseRanges.concat([{ start, end }]) }));
  },
  onDdPauseRemove(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.ddCommit(g => runtime.ddGroupPatch(g, { pauseRanges: g.pauseRanges.filter((r,i) => i !== index) }));
  },
  onDdRemindToggle(e) {
    this.ddCommit((g) => runtime.ddGroupPatch(g, { remindEnabled: !!e.detail.value }));
  },
  onDdRemindTime(e) {
    const v = runtime.ddNormalizeTime(e.detail.value);
    if (!v) { wx.showToast({ title: "时刻格式不对，已保留原值", icon: "none" }); this.loadDormDuty(); return; }
    this.ddCommit((g) => runtime.ddGroupPatch(g, { remindTime: v }));
  },
  /** 临时换人：一次管一整轮（按轮次起始日记 override），撤销即回到原排班。
      小程序面板是单选（ActionSheet），选谁本轮就整轮换成他一个人；
      桌面 / Android 端支持一次勾选多人，那边写的是数组，本端读取已兼容。 */
  onDdSwap() {
    const dd = this.data.dd || {};
    const members = dd.members || [];
    if (!members.length) return;
    const curIds = dd.currentIds || [];
    wx.showActionSheet({
      itemList: members.map((m) => m.name + (curIds.indexOf(m.id) >= 0 ? "（本轮已是他）" : "")),
      success: (res) => {
        const pick = members[res.tapIndex];
        if (!pick) return;
        if (curIds.indexOf(pick.id) >= 0) { wx.showToast({ title: "本轮已经是他", icon: "none" }); return; }
        // 用视图模型里的本轮起始日（未开始时为空串），别自己再算一遍
        const cycle = dd.cycle;
        if (!cycle) { wx.showToast({ title: "轮换还没开始，无法换人", icon: "none" }); return; }
        const time = this.ddCurrentTime();
        this.ddCommit((g) => runtime.ddGroupSetOverride(g, cycle, pick.id, time, store.todayStr()));
        wx.showToast({ title: "已换人，提醒改为 " + time, icon: "none" });
      },
    });
  },
  onDdSwapClear() {
    const dd = this.data.dd || {};
    if (!dd.cycle) return;
    this.ddCommit((g) => runtime.ddGroupSetOverride(g, dd.cycle, ""));
  },
  onDdAddTask() {
    const dd = this.data.dd || {};
    const who = dd.current;
    if (!who) { wx.showToast({ title: "这一套还没有当班安排", icon: "none" }); return; }
    const today = store.todayStr();
    const title = dd.groupName + " · " + dd.currentNames + (dd.currentLocation ? " · " + dd.currentLocation : "");
    const dup = (store.getState().tasks || []).filter((t) => !t.done && t.due === today && t.title === title)[0];
    if (dup) { wx.showToast({ title: "今天的「" + title + "」已经在任务里了", icon: "none" }); return; }
    store.addTask({ title, due: today, quad: 2, estMin: 15, tags: [dd.groupName] });
    wx.showToast({ title: "已加入今天的任务", icon: "success" });
  },

};
