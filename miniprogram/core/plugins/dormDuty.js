const { store, holidayData, examData, WEEK_CN, CAT_LABEL, pad2, dateMs, dayDiff, weekday, durationLabel } = require("./common.js");
/* ════ 轮换值日（dorm-duty）════
   与桌面端 public/plugins/dorm-duty/main.js **同源的轮换数学**：用「起始日 + 周期」切段，一段一人。
   为什么不是「每天算一个人」：每周轮换时整周都该是同一个人，否则会天天催人。

   一个插件里可以放**多套轮换**（宿舍值日 / 公区卫生…），每套各有成员、周期、起始日、换人记录
   与提醒设置，互不影响。存储结构（与桌面端逐字一致，备份可跨端恢复）：
     groups   : [{ id, name, startDate, periodDays, remindEnabled, remindTime, sound,
                   members, removed, overrides, lastNotified }]
     activeId : 界面当前选中的那一套
   旧版（单套轮换）把数据平铺在 members / config / overrides / removed / lastNotified 上，
   `ddMigrateLegacy()` 会把它迁成一组。**旧键留着不删**：删了就没法回退到旧版本。

   这里只放纯函数，**一律接收显式数据**（不在函数内部读 store），这样 Node 下能直接真跑边界；
   `dormDutySummary()` 是唯一读 store 的入口，页面用它取视图模型。 */
const DD_NAME_DEFAULT = "值日";
const DD_GROUP_MAX = 12;    // 最多几套轮换（防病态数据把界面撑爆）
const DD_PERIODS = [
  { days: 1, label: "每天" },
  { days: 3, label: "每 3 天" },
  { days: 7, label: "每周" },
  { days: 14, label: "每两周" },
];
const DD_UPCOMING = 6;      // 后续轮次展示条数
const DD_REMOVED_KEEP = 12; // 「已移除」最多保留几个
const DD_NAME_MAX = 12;     // 轮换名（如「宿舍值日」/「公区卫生」）
const DD_MEMBER_MAX = 16;   // 成员名
const DD_LOCATION_MAX = 12;
const DD_LOCATION_NAME_MAX = 24;
// 宿舍床位数（桌面端 3D 星图用）。小程序不画这张图，但**必须跟着归一化** ——
// 不然一份脏数据在桌面被夹回默认档、在小程序原样留存，两端备份恢复后就不一致了。
const DD_ROOM_SIZES = [0, 4, 6, 8];
const DD_ROOM_DEFAULT = 4;

function ddValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return false;
  const [y,m,d] = s.split("-").map(Number);
  return new Date(Date.UTC(y,m-1,d)).toISOString().slice(0,10) === s;
}
/** 合法时刻 → "HH:MM"；非法返回 null。
    只校验 /^\d{2}:\d{2}$/ 是不够的："25:99" 能过格式校验，换算成分钟是 1599，
    超过一天的最大值 1439 —— 于是「还没到点」永远成立，提醒被**静默关掉**（不报错不提示）。
    时 0–23、分 0–59 必须真校验。桌面端踩过这个坑，这里同一套规则。 */
function ddNormalizeTime(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? "" : v).trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) return null;
  return pad2(h) + ":" + pad2(mi);
}
function ddPeriodLabel(days) {
  const hit = DD_PERIODS.filter((p) => p.days === days)[0];
  return hit ? hit.label : "每 " + days + " 天";
}
function ddDefaultConfig(today) {
  return { dutyName: DD_NAME_DEFAULT, startDate: today, periodDays: 7, remindEnabled: true, remindTime: "08:00", sound: "beep" };
}
/** 旧版「配置」的归一化。现在只在**迁移**时用到（新结构把字段平铺在组上）。
    配置损坏不能把插件变成白屏，一律退回可用默认值；未识别的键（如桌面端的 sound）原样保留。
    只接受**普通对象**：字符串 / 数组也能被 Object.assign 展开成 {"0":…,"1":…} 这种垃圾键，
    会被原样写回 storage 跟着备份走。 */
function ddNormalizeConfig(raw, today) {
  const base = ddDefaultConfig(today);
  const usable = raw && typeof raw === "object" && !Array.isArray(raw);
  const c = Object.assign({}, base, usable ? raw : {});
  c.dutyName = String(c.dutyName || "").trim().slice(0, DD_NAME_MAX) || DD_NAME_DEFAULT;
  if (!ddValidDate(c.startDate)) c.startDate = base.startDate;
  c.periodDays = Math.min(365, Math.max(1, Math.round(Number(c.periodDays) || 7)));
  c.remindTime = ddNormalizeTime(c.remindTime) || "08:00";
  c.remindEnabled = c.remindEnabled !== false;
  c.sound = String(c.sound || "beep");
  return c;
}
function ddMembers(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((m) => m && m.id)
    .map((m) => ({ id: String(m.id), name: String(m.name || "").slice(0, DD_MEMBER_MAX).trim() || "未命名" }));
}
function ddLocations(raw) {
  const names = (Array.isArray(raw) ? raw : []).map((v) => String(v || "").trim().slice(0, DD_LOCATION_NAME_MAX)).filter(Boolean);
  return names.filter((v, i) => names.indexOf(v) === i).slice(0, DD_LOCATION_MAX);
}

  // 暂停段包含首尾日期；合并交叠日期，避免同一天重复扣除。
  function ddPauseRanges(raw) {
    const ranges = (Array.isArray(raw) ? raw : []).filter(r => r && ddValidDate(r.start) && ddValidDate(r.end) && r.start <= r.end)
      .map(r => ({ start: r.start, end: r.end })).sort((a,b) => a.start.localeCompare(b.start));
    const out = [];
    for (const r of ranges) {
      const last = out[out.length - 1];
      if (last && dayDiff(last.end, r.start) <= 1) { if (r.end > last.end) last.end = r.end; }
      else out.push(r);
    }
    return out;
  }
  function ddPausedAt(g, date) { return ddPauseRanges(g.pauseRanges).some(r => r.start <= date && date <= r.end); }
  // [起始日, date) 中真正计入轮换的天数。
  function ddActiveDays(g, date) {
    let days = dayDiff(g.startDate, date);
    for (const r of ddPauseRanges(g.pauseRanges)) {
      const a = r.start < g.startDate ? g.startDate : r.start;
      const b = r.end < date ? store.addDays(r.end, 1) : date;
      if (a < b) days -= dayDiff(a, b);
    }
    return days;
  }
  // 有效日序号反解为自然日期，按日期段跳过，可处理多年假期。
  function ddActiveDate(g, index) {
    let date = store.addDays(g.startDate, index);
    for (const r of ddPauseRanges(g.pauseRanges)) {
      if (r.end < g.startDate) continue;
      const start = r.start < g.startDate ? g.startDate : r.start;
      if (start > date) break;
      date = store.addDays(date, dayDiff(start, r.end) + 1);
    }
    return date;
  }
  function ddShiftActive(g, date, days) { return ddActiveDate(g, ddActiveDays(g, date) + days); }
  function ddCycleEndOf(g, date, period) {
    return ddActiveDate(g, (Math.floor(ddActiveDays(g, date) / period) + 1) * period - 1);
  }

function ddUid(prefix) { return (prefix || "m") + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/** 宿舍人数归一化：没设过（老数据 / null / 空串）或认不出的值退回默认档；0 是「明确关掉」。 */
function ddRoomSize(v) {
  const s = v == null ? "" : String(v).trim();
  if (!s) return DD_ROOM_DEFAULT;
  const n = Math.round(Number(s));
  return DD_ROOM_SIZES.indexOf(n) >= 0 ? n : DD_ROOM_DEFAULT;
}

/* ── 轮换组的归一化 / 迁移 ── */
/** 一套轮换的默认值。 */
function ddDefaultGroup(today, name) {
  return {
    id: ddUid("g"),
    name: String(name || "").trim().slice(0, DD_NAME_MAX) || DD_NAME_DEFAULT,
    startDate: ddValidDate(today) ? today : store.todayStr(),
    periodDays: 7,
    perRound: 1,
    roomSize: DD_ROOM_DEFAULT,
    pauseRanges: [],
    locations: [],
    locationPeriodDays: 7,
    remindEnabled: true,
    remindTime: "08:00",
    sound: "beep",
    members: [], removed: [], overrides: {}, lastNotified: "",
  };
}
/** 归一化一组。未识别的键原样保留 —— 别端（桌面）字段不能被抹掉。 */
function ddNormalizeGroup(raw, today) {
  const base = ddDefaultGroup(today, null);
  const usable = raw && typeof raw === "object" && !Array.isArray(raw);
  const g = Object.assign({}, base, usable ? raw : {});
  g.id = String(g.id || "").trim() || base.id;
  g.name = String(g.name || "").trim().slice(0, DD_NAME_MAX) || DD_NAME_DEFAULT;
  if (!ddValidDate(g.startDate)) g.startDate = base.startDate;
  g.periodDays = Math.min(365, Math.max(1, Math.round(Number(g.periodDays) || 7)));
  g.locationPeriodDays = Math.min(365, Math.max(1, Math.round(Number(g.locationPeriodDays) || 7)));
  g.locations = ddLocations(g.locations);
  g.pauseRanges = ddPauseRanges(g.pauseRanges);
  // 每轮人数：1 = 单人（历史默认）。不 clamp 到当前成员数（成员会变），计算时用模运算兜底。
  g.perRound = Math.min(DD_MEMBER_MAX, Math.max(1, Math.round(Number(g.perRound) || 1)));
  // 宿舍床位数：只认 0（关闭）/ 4 / 6 / 8，与桌面端 ROOM_SIZES / normalizeRoomSize 同一套语义。
  g.roomSize = ddRoomSize(g.roomSize);
  g.remindTime = ddNormalizeTime(g.remindTime) || "08:00";
  g.remindEnabled = g.remindEnabled !== false;
  g.sound = String(g.sound || "beep");
  g.members = ddMembers(g.members);
  g.removed = ddMembers(g.removed).slice(0, DD_REMOVED_KEEP);
  g.overrides = g.overrides && typeof g.overrides === "object" && !Array.isArray(g.overrides)
    ? Object.assign({}, g.overrides) : {};
  g.lastNotified = String(g.lastNotified || "");
  return g;
}
/** 归一化整份组列表。重复 id 会让「切换轮换」指错对象，必须剔掉。 */
function ddGroups(raw, today) {
  const out = [];
  const seen = {};
  const list = Array.isArray(raw) ? raw : [];
  for (let i = 0; i < list.length && out.length < DD_GROUP_MAX; i++) {
    const g = ddNormalizeGroup(list[i], today);
    if (seen[g.id]) continue;
    seen[g.id] = 1;
    out.push(g);
  }
  return out;
}
/** 旧版单套轮换 → 一组。没有任何旧数据时返回空数组（由调用方决定要不要建默认组）。 */
function ddMigrateLegacy(legacy, today) {
  const L = legacy && typeof legacy === "object" ? legacy : {};
  const hasAny = (Array.isArray(L.members) && L.members.length > 0)
    || !!L.config
    || !!L.lastNotified
    || (L.overrides && typeof L.overrides === "object" && Object.keys(L.overrides).length > 0);
  if (!hasAny) return [];
  const cfg = ddNormalizeConfig(L.config, today);
  return [ddNormalizeGroup({
    name: cfg.dutyName,
    startDate: cfg.startDate,
    periodDays: cfg.periodDays,
    remindEnabled: cfg.remindEnabled,
    remindTime: cfg.remindTime,
    sound: cfg.sound,
    members: L.members,
    removed: L.removed,
    overrides: L.overrides,
    lastNotified: L.lastNotified,
  }, today)];
}
/** 当前该显示哪一组：存的 activeId 有效就用它，否则退回第一组；没有组时返回 ""。 */
function ddActiveId(groups, activeId) {
  const list = groups || [];
  if (!list.length) return "";
  return list.some((g) => g.id === activeId) ? String(activeId) : list[0].id;
}

/* ── 轮换数学（纯函数，只吃传入的那一组） ── */
const ddPeriod = (g) => Math.max(1, Math.round(Number(g && g.periodDays) || 1));
/** 每轮当班人数（多人值日）：1 = 单人。 */
const ddPerRound = (g) => Math.max(1, Math.round(Number(g && g.perRound) || 1));
/** 某天落在哪一轮：返回该轮起始日；起始日之前返回 null（轮换还没开始）。 */
function ddCycleStartOf(g, date) {
  const start = g && g.startDate;
  if (!ddValidDate(start) || !ddValidDate(date)) return null;
  const diff = ddActiveDays(g, date);
  if (diff < 0) return null;
  if (ddPausedAt(g, date)) return null;
  return ddActiveDate(g, Math.floor(diff / ddPeriod(g)) * ddPeriod(g));
}
const ddCycleIndexAt = (g, cycleStart) => Math.floor(ddActiveDays(g, cycleStart) / ddPeriod(g));
function ddLocationCycleStartOf(g, date) {
  if (!ddValidDate(g.startDate) || !ddValidDate(date)) return null;
  const diff = ddActiveDays(g, date);
  if (diff < 0) return null;
  if (ddPausedAt(g, date)) return null;
  return ddActiveDate(g, Math.floor(diff / g.locationPeriodDays) * g.locationPeriodDays);
}
function ddLocationAt(g, date) {
  if (!g.locations.length) return "";
  const start = ddLocationCycleStartOf(g, date);
  return start ? g.locations[Math.floor(ddActiveDays(g, start) / g.locationPeriodDays) % g.locations.length] : "";
}
const ddIsCycleStartDay = (g, date) => ddCycleStartOf(g, date) === date;
/** 某一轮「正常轮换」该当班的一批人（不看临时换人）：成员环上取 perRound 人的滑动窗口。 */
function ddNormalAssignees(g, cycleStart) {
  if (!cycleStart || !g.members.length) return [];
  const per = ddPerRound(g);
  const len = g.members.length;
  const idx = ddCycleIndexAt(g, cycleStart);
  const out = [];
  for (let i = 0; i < per; i++) out.push(g.members[(idx * per + i) % len]);
  const seen = {};
  const uniq = [];
  out.forEach((m) => { if (!seen[m.id]) { seen[m.id] = 1; uniq.push(m); } });
  return uniq;
}
/** 某一轮「正常轮换」该谁（单人行，兼容旧调用）：多人时取第一个。 */
function ddNormalFor(g, cycleStart) {
  return ddNormalAssignees(g, cycleStart)[0] || null;
}
/** 某一轮的临时换人名单里**真的还在名单里**的人（保序、去重）。
    override 值是双格式：单人 = 字符串 id（历史格式，桌面端写入），多人 = id 数组。
    指向已被移除的人要过滤掉 —— 全部失效时返回空数组，由调用方退回正常排班。 */
function ddOverrideHits(g, cycleStart) {
  const v = cycleStart ? (g.overrides || {})[cycleStart] : "";
  const ids = Array.isArray(v) ? v : (v ? [v] : []);
  const seen = {};
  const hits = [];
  ids.forEach((raw) => {
    const id = String(raw || "");
    if (!id || seen[id]) return;
    seen[id] = 1;
    const m = g.members.filter((x) => x.id === id)[0];
    if (m) hits.push(m);
  });
  return hits;
}
/** 某一轮的换人是否**真的生效**（单人行，兼容旧调用）：多人换人时取第一个。
    指向已被移除的人时不算换人 —— 否则界面会显示「已换人 · 原 X」而实际当班的就是 X。 */
function ddOverrideHit(g, cycleStart) {
  return ddOverrideHits(g, cycleStart)[0] || null;
}
/** 某天的当班人（可能多人）：没成员 / 没开始 → 空数组；有临时换人 → 换上的名单。 */
function ddAssigneesFor(g, date) {
  const cycle = ddCycleStartOf(g, date);
  if (!cycle || !g.members.length) return [];
  const hits = ddOverrideHits(g, cycle);
  return hits.length ? hits : ddNormalAssignees(g, cycle);
}
/** 编辑列表按真实轮换顺序排列，拖动索引与保存位置一致。 */
function ddMembersInDateOrder(g, date) {
  return g.members.slice();
}
/** 某天的当班人（单人行，兼容旧调用）：多人时取第一个。 */
function ddAssigneeFor(g, date) {
  return ddAssigneesFor(g, date)[0] || null;
}

/* ── 组的增删改（不可变：一组进、一组出；页面只负责把结果写回 storage） ── */
/** 把某一组替换成 fn 处理后的新组。 */
function ddWithGroup(groups, id, fn) {
  return (groups || []).map((g) => (g.id === id ? fn(g) : g));
}
function ddGroupPatch(g, patch) {
  return Object.assign({}, g, patch || {});
}
function ddGroupAddLocation(g, name) {
  const n = String(name || "").trim().slice(0, DD_LOCATION_NAME_MAX);
  if (!n || (g.locations || []).indexOf(n) >= 0 || (g.locations || []).length >= DD_LOCATION_MAX) return g;
  return ddGroupPatch(g, { locations: (g.locations || []).concat(n) });
}
function ddGroupMoveLocation(g, index, delta) {
  const list = (g.locations || []).slice();
  const to = index + delta;
  if (index < 0 || to < 0 || to >= list.length) return g;
  const hold = list[index]; list[index] = list[to]; list[to] = hold;
  return ddGroupPatch(g, { locations: list });
}
function ddGroupRemoveLocation(g, index) {
  const list = (g.locations || []).slice();
  if (index < 0 || index >= list.length) return g;
  list.splice(index, 1);
  return ddGroupPatch(g, { locations: list });
}
function ddGroupAddMember(g, name) {
  const n = String(name || "").trim().slice(0, DD_MEMBER_MAX);
  if (!n) return g;
  return Object.assign({}, g, { members: (g.members || []).concat([{ id: ddUid("m"), name: n }]) });
}
function ddGroupRenameMember(g, id, name) {
  const n = String(name || "").trim().slice(0, DD_MEMBER_MAX);
  if (!n) return g;
  return Object.assign({}, g, { members: (g.members || []).map((m) => (m.id === id ? { id: m.id, name: n } : m)) });
}
function ddGroupMoveMember(g, id, delta) {
  const members = g.members || [];
  const i = members.map((m) => m.id).indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= members.length) return g;
  const next = members.slice();
  const tmp = next[i]; next[i] = next[j]; next[j] = tmp;
  return Object.assign({}, g, { members: next });
}
function ddGroupMoveMemberTo(g, id, toIndex) {
  const members = g.members || [];
  const from = members.map((m) => m.id).indexOf(id);
  const to = Math.max(0, Math.min(members.length - 1, Math.round(Number(toIndex))));
  if (from < 0 || to < 0 || from === to) return g;
  const next = members.slice();
  const hit = next.splice(from, 1)[0];
  next.splice(to, 0, hit);
  return Object.assign({}, g, { members: next });
}
/** 移除成员：进「已移除」可恢复，并把指向他的临时换人一并清掉（否则会留一条永远命中不了的 override）。
    override 值有双格式：单人字符串直接删；多人数组里滤掉他，滤空了整个键也删掉。 */
function ddGroupRemoveMember(g, id) {
  const hit = (g.members || []).filter((m) => m.id === id)[0];
  if (!hit) return g;
  const ov = {};
  Object.keys(g.overrides || {}).forEach((k) => {
    const v = g.overrides[k];
    if (Array.isArray(v)) {
      const next = v.filter((x) => x !== id);
      if (next.length) ov[k] = next;
    } else if (v !== id) {
      ov[k] = v;
    }
  });
  return Object.assign({}, g, {
    members: g.members.filter((m) => m.id !== id),
    removed: [{ id: hit.id, name: hit.name }].concat(g.removed || []).slice(0, DD_REMOVED_KEEP),
    overrides: ov,
  });
}
function ddGroupRestoreMember(g, id) {
  const hit = (g.removed || []).filter((m) => m.id === id)[0];
  if (!hit) return g;
  return Object.assign({}, g, {
    members: (g.members || []).concat([{ id: hit.id, name: hit.name }]),
    removed: (g.removed || []).filter((m) => m.id !== id),
  });
}
/** 记 / 撤临时换人。memberId 传空 = 撤销这一轮的换人。
    小程序端的换人面板是单选（ActionSheet），所以这里写**字符串**（历史格式，
    桌面端 / 旧版本客户端都能读）；桌面端的多选换人写数组，本端读取时用 ddOverrideHits 兼容。 */
function ddGroupSetOverride(g, cycle, memberId, remindTime, today) {
  const next = Object.assign({}, g.overrides || {});
  if (memberId) next[cycle] = memberId; else delete next[cycle];
  const patch = { overrides: next };
  const t = memberId ? ddNormalizeTime(remindTime) : "";
  if (t) patch.remindTime = t;
  if (memberId && today && g.lastNotified === today) patch.lastNotified = "";
  return Object.assign({}, g, patch);
}
/** 新建一套轮换（返回新组，由调用方 concat 进列表并切过去）。到上限返回 null。 */
function ddAddGroup(groups, today, name) {
  if ((groups || []).length >= DD_GROUP_MAX) return null;
  return ddDefaultGroup(today, name);
}
/** 删除一套轮换。**最后一套不许删** —— 删光界面就没有可编辑的对象了。
    返回 { ok, groups, activeId }：删掉的正是当前组时，activeId 落到邻居。 */
function ddRemoveGroup(groups, id, activeId) {
  const list = groups || [];
  if (list.length <= 1) return { ok: false, groups: list, activeId: activeId };
  const idx = list.map((g) => g.id).indexOf(id);
  if (idx < 0) return { ok: false, groups: list, activeId: activeId };
  const next = list.slice(0, idx).concat(list.slice(idx + 1));
  const nextActive = activeId === id ? next[Math.min(idx, next.length - 1)].id : activeId;
  return { ok: true, groups: next, activeId: nextActive };
}
/** 副本名：把本体截短来腾出「 N」的位置。直接 src + " 2" 再切到 DD_NAME_MAX，
    满长的名字会切回和源组一模一样的串。与桌面端 nextCopyName 同语义。 */
function ddCopyName(srcName, groups) {
  const taken = {};
  (groups || []).forEach((g) => { taken[g.name] = 1; });
  for (let n = 2; n < 100; n++) {
    const suffix = " " + n;
    const keep = Math.max(1, DD_NAME_MAX - suffix.length);
    const cand = (String(srcName || "").slice(0, keep) + suffix).slice(0, DD_NAME_MAX);
    if (!taken[cand]) return cand;
  }
  return ("轮换 " + ((groups || []).length + 1)).slice(0, DD_NAME_MAX);
}
/** 复制一套轮换：规则与名单原样带走，但组 id 和每个成员 id 全部重新生成。
    沿用旧 id 等于两组共享同一批人，副本里换人 / 移除会连着改掉原组的排班。
    连带代价：overrides 记的是成员 id，端过来全是悬空引用，所以清空；lastNotified 也清空。
    起始日保留 —— 同一宿舍的两套值日才会在同一天换人。
    返回 { groups, activeId, created }；到上限或找不到那组时返回 null。 */
function ddDuplicateGroup(groups, id, today) {
  const list = groups || [];
  if (list.length >= DD_GROUP_MAX) return null;
  const idx = list.map((g) => g.id).indexOf(id);
  if (idx < 0) return null;
  const src = list[idx];
  const reid = (arr) => (arr || []).map((m) => ({ id: ddUid("m"), name: m.name }));
  // ⚠️ 与桌面端同一条规矩：**先 ...src 全带走**，再逐个覆盖必须换掉的。
  // 曾经这里是一张手写的字段清单，结果漏了 locations / locationPeriodDays / pauseRanges ——
  // 在手机上复制一套「宿舍值日」，地点轮换和假期暂停会**静默消失**（桌面端是 ...src，不会）。
  // 手写清单还有个更隐蔽的毛病：以后桌面端加新字段，这里不会报错，只会悄悄丢。
  const created = ddNormalizeGroup({
    ...src,
    id: ddUid("g"),
    name: ddCopyName(src.name, list),
    members: reid(src.members),
    removed: reid(src.removed),
    overrides: {},      // 记的是成员 id，端过来全是悬空引用
    lastNotified: "",   // 副本没提醒过，别让它顶着源组的标记当天不提醒
    // startDate 刻意保留（不覆盖）：同一宿舍的两套值日才会在同一天换人
  }, today);
  // 紧跟源组插入，而不是甩到列表末尾
  return {
    groups: list.slice(0, idx + 1).concat([created], list.slice(idx + 1)),
    activeId: created.id,
    created: created,
  };
}
/** 从另一套轮换导入成员：按**名字**去重后追加到目标末尾，id 一律新建。
    只能按名字对 —— 两组的成员 id 各起各的。已有的人连 id 都不动。
    返回 { groups, added }；找不到组 / 自己导给自己 / 没有新人可加时 added = 0。 */
function ddImportMembers(groups, targetId, sourceId) {
  const list = groups || [];
  const ti = list.map((g) => g.id).indexOf(targetId);
  const si = list.map((g) => g.id).indexOf(sourceId);
  if (ti < 0 || si < 0 || ti === si) return { groups: list, added: 0 };
  const target = list[ti];
  const source = list[si];
  const mine = (target.members || []).slice();
  const room = DD_MEMBER_MAX - mine.length;
  if (room <= 0) return { groups: list, added: 0 };
  const have = {};
  mine.forEach((m) => { have[m.name] = 1; });
  const added = [];
  for (let i = 0; i < (source.members || []).length && added.length < room; i++) {
    const m = source.members[i];
    if (have[m.name]) continue;
    have[m.name] = 1;
    added.push({ id: ddUid("m"), name: m.name });
  }
  if (!added.length) return { groups: list, added: 0 };
  const next = list.slice();
  next[ti] = ddGroupPatch(target, { members: mine.concat(added) });
  return { groups: next, added: added.length };
}

/* ── 视图模型（纯函数，页面与测试共用） ── */
const ddRelLabel = (n) => (n === 0 ? "今天" : n === 1 ? "明天" : n > 0 ? n + " 天后" : -n + " 天前");
const ddRangeText = (start, end) => (start === end ? start : start + " → " + end);
const ddMonthDay = (s) => Number(s.slice(5, 7)) + "月" + Number(s.slice(8, 10)) + "日";

function ddSnapshot(today, group) {
  today = today || store.todayStr();
  const g = ddNormalizeGroup(group, today);
  const period = ddPeriod(g);
  const per = ddPerRound(g);
  const cycle = ddCycleStartOf(g, today);
  const started = !!cycle;
  const current = ddAssigneeFor(g, today);
  const currentAll = ddAssigneesFor(g, today);
  const paused = today >= g.startDate && ddPausedAt(g, today);
  const nextStart = paused ? ddShiftActive(g, today, 0) : cycle ? ddShiftActive(g, cycle, period) : ddActiveDate(g, 0);
  const locationCycle = ddLocationCycleStartOf(g, today);
  const nextLocationStart = g.locations.length ? (paused ? ddShiftActive(g, today, 0) : locationCycle ? ddShiftActive(g, locationCycle, g.locationPeriodDays) : ddActiveDate(g, 0)) : null;

  const rows = [];
  for (let i = 0; i < DD_UPCOMING && nextStart; i++) {
    const start = i === 0 ? nextStart : ddShiftActive(g, ddCycleStartOf(g, nextStart), i * period);
    const whoAll = ddAssigneesFor(g, start);
    const names = whoAll.map((m) => m.name).join("、");
    rows.push({
      start,
      end: ddCycleEndOf(g, start, period),
      // 周几要标出来，但别重复：单日轮次写成「9月18日（周五）」，
      // 多日轮次写成「9月14日 → 9月20日 · 周五起」。与桌面端文案一致。
      range: period > 1
        ? ddRangeText(ddMonthDay(start), ddMonthDay(ddCycleEndOf(g, start, period))) + " · " + weekday(start) + "起"
        : ddMonthDay(start) + "（" + weekday(start) + "）",
      whoId: whoAll.length ? whoAll[0].id : "",
      whoName: names || "—",
      index: ddCycleIndexAt(g, start) + 1,
      daysUntil: dayDiff(today, start),
      daysText: ddRelLabel(dayDiff(today, start)),
      swapped: ddOverrideHits(g, start).length > 0,
    });
  }
  const nextAll = nextStart ? ddAssigneesFor(g, nextStart) : [];
  const nextDiff = nextStart ? dayDiff(today, nextStart) : 0;
  // 本轮换人是否真的生效（override 指向的人还在名单里才算）
  const swapHits = cycle ? ddOverrideHits(g, cycle) : [];
  const normalAll = cycle ? ddNormalAssignees(g, cycle) : [];

  return {
    today,
    todayText: weekday(today),
    groupId: g.id,
    groupName: g.name,
    cfg: {
      name: g.name, startDate: g.startDate, periodDays: g.periodDays,
      locationPeriodDays: g.locationPeriodDays,
      remindTime: g.remindTime, remindEnabled: g.remindEnabled, sound: g.sound,
    },
    periodLabel: ddPeriodLabel(period),
    periods: DD_PERIODS.map((p) => ({ days: p.days, label: p.label, on: p.days === period })),
    perRound: per,
    perRounds: [1, 2, 3, 4].map((n) => ({ n, label: n === 1 ? "单人" : n + " 人", on: n === per })),
    hasMembers: g.members.length > 0,
    empty: g.members.length === 0,
    started,
    paused,
    pauseRanges: g.pauseRanges,
    cycle: cycle || "",
    cycleIndex: cycle ? ddCycleIndexAt(g, cycle) + 1 : 0,
    cycleText: cycle
      ? (period > 1
        ? ddMonthDay(cycle) + " — " + ddMonthDay(ddCycleEndOf(g, cycle, period)) + " · " + weekday(cycle) + " 起"
        : ddMonthDay(cycle) + "（" + weekday(cycle) + "）")
      : "还没开始",
    current: current ? { id: current.id, name: current.name } : null,
    /** 多人当班时的名字串（「、」连接）；单人时与 current.name 一致。 */
    currentNames: currentAll.map((m) => m.name).join("、"),
    currentLocation: ddLocationAt(g, today),
    nextLocationStart: nextLocationStart || "",
    nextLocationText: nextLocationStart ? ddMonthDay(nextLocationStart) + " " + weekday(nextLocationStart) : "",
    nextLocationName: nextLocationStart ? ddLocationAt(g, nextLocationStart) : "",
    locations: g.locations.map((name, i) => ({ name, index: i, no: i + 1, canUp: i > 0, canDown: i < g.locations.length - 1 })),
    canAddLocation: g.locations.length < DD_LOCATION_MAX,
    locationPeriods: DD_PERIODS.map((p) => ({ days: p.days, label: p.label, on: p.days === g.locationPeriodDays })),
    locationPeriodCustom: !DD_PERIODS.some((p) => p.days === g.locationPeriodDays),
    /** 本轮实际当班的 id 集合（换过 = 换上的名单），供「当班」标记与换人面板用。 */
    currentIds: currentAll.map((m) => m.id),
    currentIsMulti: currentAll.length > 1,
    swapped: swapHits.length > 0,
    /** 被换掉的那批人（正常轮换本该当班的），用来在界面上说明「原本是谁」。 */
    swapName: swapHits.length && normalAll.length ? normalAll.map((m) => m.name).join("、") : "",
    nextStart: nextStart || "",
    nextStartText: nextStart ? ddMonthDay(nextStart) + " " + weekday(nextStart) : "",
    nextWhoName: nextAll.map((m) => m.name).join("、") || "—",
    nextBigEm: nextDiff <= 0 ? "今天" : nextDiff === 1 ? "明天" : String(nextDiff),
    nextBigUnit: nextDiff <= 0 ? "" : nextDiff === 1 ? "" : " 天后",
    nextVerb: paused ? "恢复" : started ? "换人" : "开始",
    rows,
    members: ddMembersInDateOrder(g, today).map((m, i) => {
      const baseIndex = g.members.findIndex((item) => item.id === m.id);
      return {
        id: m.id, name: m.name, no: i + 1,
        isCurrent: currentIdsOf(currentAll, m.id),
        canUp: baseIndex > 0, canDown: baseIndex < g.members.length - 1,
      };
    }),
    removed: g.removed,
    lastNotified: g.lastNotified,
  };
}
const currentIdsOf = (list, id) => list.some((m) => m.id === id);

/** 整份视图模型：当前组的完整快照（字段与旧版一致，页面直接 dd.xxx 用）+ 顶部的轮换标签条。 */
function ddSummaryFrom(groups, activeId, today) {
  const list = groups || [];
  const active = list.filter((g) => g.id === activeId)[0] || list[0] || null;
  const snap = ddSnapshot(today, active);
  snap.groups = list.map((g) => {
    const who = ddAssigneesFor(g, today).map((m) => m.name).join("、");
    return { id: g.id, name: g.name, who: who, on: !!active && g.id === active.id };
  });
  snap.activeId = active ? active.id : "";
  snap.groupCount = list.length;
  snap.canAddGroup = list.length < DD_GROUP_MAX;
  snap.canDelGroup = list.length > 1;
  return snap;
}

/** 页面入口：读 store → 视图模型。
    ⚠️ 它有**写**副作用：旧数据迁移、以及「一组都没有」的兜底建组都要立刻落盘 ——
    不写的话「已迁移」和「未迁移」在存储上分不出来，每次进页面都会重新生成一个随机 id 的
    默认组，用户刚做的设置下一次就没了。 */
function dormDutySummary(today) {
  today = today || store.todayStr();
  const raw = store.pluginStorageGet("dorm-duty", "groups", null);
  let groups = ddGroups(raw, today);
  let needPersist = false;
  // 只有「新版数据完全不存在」时才看旧键：groups 一旦存在就说明已经迁移过，
  // 不能再被旧快照（旧版本客户端写的）盖回去。
  if (!raw) {
    const migrated = ddMigrateLegacy({
      members: store.pluginStorageGet("dorm-duty", "members", []),
      config: store.pluginStorageGet("dorm-duty", "config", null),
      overrides: store.pluginStorageGet("dorm-duty", "overrides", {}),
      removed: store.pluginStorageGet("dorm-duty", "removed", []),
      lastNotified: store.pluginStorageGet("dorm-duty", "lastNotified", ""),
    }, today);
    if (migrated.length) { groups = migrated; needPersist = true; }
  }
  if (!groups.length) { groups = [ddDefaultGroup(today, null)]; needPersist = true; }
  const storedActive = store.pluginStorageGet("dorm-duty", "activeId", "");
  const activeId = ddActiveId(groups, storedActive);
  // activeId 变了（首次落盘 / 存的指针失效）也要写回 —— 让存储里的指针**始终有效**，
  // 而不是每次进页面都靠兜底。落盘的 groups 与 activeId 必须是一对，否则指针会指空。
  if (needPersist || activeId !== storedActive) {
    store.pluginStorageSet("dorm-duty", "groups", groups);
    store.pluginStorageSet("dorm-duty", "activeId", activeId);
  }
  return ddSummaryFrom(groups, activeId, today);
}

/** 某一组到点提醒的判据（纯函数）。
    小程序**没有后台常驻**，宿主也不给定时回调 —— 这里只能做「打开页面时补提醒」：
    在每轮第一天、且已过设定时刻、且当天没提醒过 → 值得弹一次。 */
function ddReminderDue(group, today, nowMinutes) {
  const g = ddNormalizeGroup(group, today);
  if (!g.remindEnabled || !g.members.length) return null;
  if (!ddIsCycleStartDay(g, today)) return null;          // 只在每轮第一天提醒，否则天天催
  if (g.lastNotified === today) return null;              // 这一轮已经提醒过
  const parts = String(g.remindTime).split(":").map(Number);
  const now = Number.isFinite(nowMinutes) ? nowMinutes : (function () {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  })();
  if (now < parts[0] * 60 + parts[1]) return null;        // 还没到点
  const all = ddAssigneesFor(g, today);
  if (!all.length) return null;
  return { groupId: g.id, groupName: g.name, whoName: all.map((m) => m.name).join("、"), location: ddLocationAt(g, today), time: g.remindTime };
}
/** 所有到点的组（多套轮换各有各的时刻与去重，互不影响）。 */
function ddDueReminders(groups, today, nowMinutes) {
  return (groups || []).map((g) => ddReminderDue(g, today, nowMinutes)).filter(Boolean);
}
/** 把这几组标成「今天已提醒」。返回新的 groups（页面写回 storage）。 */
function ddMarkNotified(groups, ids, today) {
  const set = {};
  (ids || []).forEach((id) => { set[id] = 1; });
  return (groups || []).map((g) => (set[g.id] ? Object.assign({}, g, { lastNotified: today }) : g));
}


module.exports = { dormDutySummary, ddSummaryFrom, ddSnapshot, ddReminderDue, ddDueReminders, ddMarkNotified, ddPeriodLabel, ddDefaultConfig, ddNormalizeConfig, ddNormalizeTime, ddMembers, ddPeriod, ddDefaultGroup, ddNormalizeGroup, ddGroups, ddMigrateLegacy, ddActiveId, ddLocationAt, ddGroupAddLocation, ddGroupMoveLocation, ddGroupRemoveLocation, ddCycleStartOf, ddCycleIndexAt, ddIsCycleStartDay, ddAssigneeFor, ddNormalFor, ddOverrideHit, ddMembersInDateOrder, ddWithGroup, ddGroupPatch, ddGroupAddMember, ddGroupRenameMember, ddGroupMoveMember, ddGroupMoveMemberTo, ddGroupRemoveMember, ddGroupRestoreMember, ddGroupSetOverride, ddAddGroup, ddRemoveGroup, ddDuplicateGroup, ddImportMembers, ddCopyName, DD_PERIODS, DD_UPCOMING, DD_REMOVED_KEEP, DD_GROUP_MAX, DD_NAME_MAX };
