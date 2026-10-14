// 警大门户通知 · 获奖名单：把通知正文里的获奖段落筛出来，抽成「奖项项目 → 获奖人」，
// 再按获奖数量排名。只做解析与渲染，不碰宿主 state，可单独测试。
// 口径：只认通知里明确的获奖段落（级别行、名单标签行、纯姓名行）；说到「获奖」但没逐字
// 列人的通知不出条目 —— 宁少不滥，界面上的名次永远能回到某条通知的某句话。

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ── 奖项级别 / 层级 ── */
const LEVEL_RULES = [
  ["特等奖", /特等奖|特等|最高奖|特别奖/],
  ["金奖", /金奖|金杯|第一名|冠军/],
  ["一等奖", /一等奖|一等|第1名|第 ?一 ?名/],
  ["银奖", /银奖|银杯|第二名|亚军/],
  ["二等奖", /二等奖|二等|第2名|第 ?二 ?名/],
  ["铜奖", /铜奖|铜奖|第三名|季军/],
  ["三等奖", /三等奖|三等|第3名|第 ?三 ?名/],
  ["优秀奖", /优秀奖|优胜奖|优秀作品|佳作奖|优秀/],
  ["入围奖", /入围|晋级|提名/],
];
const SCOPE_RULES = [
  ["国际级", /国际|世界|全球|亚洲|亚太|海外/],
  ["国家级", /全国|国家|中国|教育部|部级|中央/],
  ["省级", /全省|省级|自治区|直辖市|省/],
  ["市级", /全市|市级|市/],
  ["校级", /校级|全校|学校/],
  ["院级", /院级|学院|系内/],
];

export function awardLevel(text) {
  const t = String(text || "");
  for (const [label, re] of LEVEL_RULES) if (re.test(t)) return label;
  return "";
}
export function awardScope(text) {
  const t = String(text || "");
  for (const [label, re] of SCOPE_RULES) if (re.test(t)) return label;
  return "";
}

/* ── 标题清洗：把「关于公布…获奖名单的通知」压成项目名 ── */
const TRIM_HEAD = /^(?:关于|有关|公布|印发|发布|转发|公示|关于表彰|关于公布|关于通报表彰|关于通报表扬|关于表彰和|关于组织开展|关于举办|关于做好|关于对|关于开展|决定|表彰|通报表彰|通报表扬|喜报|喜讯|祝贺|热烈祝贺|我校|警大|中国人民警察大学|学生|在|于)+/;
// 尾部只剥「外壳」：通知文体词 + 名册词 + 夹在名册词前的主语（「…竞赛我校获奖名单的通知」），
// 不剥项目本体（「…竞赛」必须留下）。
const TRIM_TAIL = /(?:(?:我校|警大|中国人民警察大学|学校|学院|我单位)?(?:的)?(?:通知|公告|公示|决定|通报|函|批复)|(?:我校|警大|中国人民警察大学|学校|我单位)?获奖名单(?:的通知)?|获奖情况|获奖结果|获奖项目|获奖集体和个人|受表彰名单|名单(?:的通知)?|结果(?:的通知)?|公布|公示|公告|通知|决定)$/;

export function cleanAwardTitle(title) {
  let t = String(title || "").replace(/&[a-z#0-9]+;/gi, " ").replace(/[\s\u3000]+/g, " ").trim();
  t = t.replace(/^[\s·\-—－:：于【\[（(]+/, "").replace(/[\s·\-—－:：]+$/, "");
  let prev = "";
  for (let i = 0; i < 6 && t !== prev; i++) {
    prev = t;
    t = t.replace(TRIM_HEAD, "").trim();
    t = t.replace(TRIM_TAIL, "").trim();
  }
  t = t.replace(/^[\s、，,·\-—－:：]+/, "").replace(/[\s、，,·\-—－:：]+$/, "").trim();
  if (t.length < 4) return String(title || "").trim();
  return t;
}

/* ── 像不像「获奖类」通知 ── */
const TITLE_STRONG = /获奖|荣获|斩获|摘得|喜报|喜讯|表彰|颁奖|评奖|得奖|夺冠|夺魁|获奖名单|获奖情况|获奖结果|获奖项目|获奖集体|受表彰|获评|奖项|金银铜奖|一等奖|二等奖|三等奖|特等奖|优秀奖|冠军|亚军|季军/;
const TITLE_SOFT = /通知|公告|结果|名单|公示|通报|揭晓|公布|评比|竞赛|比赛|大赛|作品展/;
const TITLE_NEGATIVE = /报名|征稿|征集|招募|选拔|申报通知|截止|培训通知|工作会议|答辩安排|缴费|选课|调课|停课|考试安排|讲座|招聘|预告|邀请函|开始报名|参赛通知/;
const BODY_STRONG = /获奖名单|获奖情况|获奖名单如下|名单如下|获奖人员|获奖学生|获奖者|获奖单位|获奖集体|受表彰|荣获|斩获|获得(?:特等|一|二|三|优秀|金|银|铜)等?奖|(?:特等|一|二|三)等奖|优秀奖|冠(?:军|亚)|季军|入围奖|名次|赛区|指导教师/;

export function titleLooksAward(title) {
  const t = String(title || "");
  if (!t) return false;
  if (TITLE_STRONG.test(t)) return true;                 // 「获奖」「表彰」这类硬信号，负词不挡
  if (TITLE_NEGATIVE.test(t)) return false;              // 报名 / 征集 / 考试安排：正文提获奖不算
  return TITLE_SOFT.test(t);
}
export function isAwardNotice({ title = "", text = "" } = {}) {
  const t = String(title || ""), body = String(text || "").slice(0, 2000);
  if (TITLE_STRONG.test(t)) return true;
  if (BODY_STRONG.test(body)) return true;
  return titleLooksAward(t) && BODY_STRONG.test(body);
}

/* ── 行级判定 ── */
// 说明性文字：名单行里几乎不会出现这些词。命中的行整行作废（宁可漏一个，不要造出假名字）。
const EXPLAIN_LINE = /的|了|是|和|与|及|并|且|将被|已|请|根据|按照|经|由|希望|要求|相关|各位|全校|届时|特此|另行|注意|安排|附件|地点|时间|方式|联系|电话|邮箱|截止|报名|提交|材料|流程|说明|决定|现将|予以|颁发|公示期|异议|反映|如有|报送|工作日|上午|下午|会议|参加|欢迎|须知|代表学校|组织|开展|总结|通知|公告|名单见|详见|如下表|详见附件/;
const NOT_NAME = /^(?:学院|大学|学校|大队|中队|支队|班级|专业|年级|系|部|处|室|中心|委员会|办公室|教研室|实验室|协会|社团|小组|团队|团体|队伍|代表队|名单|通知|公告|公示|教师|老师|同学|学生|学员|干部|教官|单位|集体|个人|优秀|先进|组织|工作|活动|竞赛|大赛|比赛|项目|成果|论文|作品|奖项|奖励|荣誉|表彰|决定|附件|相关|全体|下列|以上|其中|荣获|获得|斩获|共计|合计|人数|名次|一等奖|二等奖|三等奖|特等奖|优秀奖|金奖|银奖|铜奖|冠军|亚军|季军|入围|晋级|国家级|省级|校级|全国|全省|全校|研究生|本科生|为了|按照)$/;
const ROSTER_OPEN = /获奖名单(?:如下|公布|见附件)?[：:]?|名单如下|获奖(?:情况|人员|学生|集体)?如下|现将.{0,12}名单/;

// 字体名与 Word 样式名：全是 2–4 字纯汉字，形状上和人名没区别，却比真人名还勤 ——
// 每份附件都带一份字体表 / 样式表，而 .doc（OLE）是二进制粗扫，字体名与样式名会跟着正文
// 一起被扫出来（「等线」「仿宋」「宋体」是字体，「无列表」是样式）。它们曾经直接上榜。
const NOT_NAME_FONT = /^(?:等线|仿宋|宋体|黑体|楷体|行书|隶书|草书|幼圆|魏碑|雅黑|微软雅黑|苹方|华文|方正|标宋|小标宋|书宋|新宋|思源|汉仪|冬青|无列表|无间隔|列表段落|项目符号|正文|标题|副标题|小标题|题注|页眉|页脚|目录|摘要|附录|参考文献|致谢|超链接|批注|脚注|尾注|空白|未命名|新建|模板|网格|页码|缩进|居中|加粗|斜体|下划线|字号|行距|段落|编号|样式|字体)$/;
// 机构简称与落款：通知末尾的发布单位、正文里提到的部门，去掉「学院 / 处室」这类尾字后就剩 2 个字。
const NOT_NAME_ORG = /^(?:团委|党委|工会|教务|学工|后勤|财务|保卫|宣传|组织|人事|科研|办公|机关|教工|教务员|学生会)$/;
// 机构尾字：3 字以上且以这些字收尾，基本是部门名（「教务处」「科研处」「训练部」）。
// 2 字名不参与这条判定，所以「李科」这类短名不受影响。
const ORG_TAIL = /[处务科所站馆局厅委办署司厂社部室系院校队组班级]$/;

// 导出只为让测试与 award-attach.js 的人名判定对齐（attachment 的表格单元格也要走同一套口径）。
export function isPersonName(s) {
  if (!/^[\u4e00-\u9fa5]{2,4}$/.test(s)) return false;
  if (NOT_NAME.test(s) || NOT_NAME_FONT.test(s) || NOT_NAME_ORG.test(s)) return false;
  // 含机构类字的 3–4 字串基本不是人名，例如「刑事科学」「侦查学院」。
  if (s.length > 2 && /[学院校系室部中心队伍组队班级年级]/.test(s)) return false;
  // 以机构尾字收尾的 3–4 字串同理：「教务处」「科研处」「学生会」。
  if (s.length > 2 && ORG_TAIL.test(s)) return false;
  return true;
}
function isTeamName(s) {
  if (s.length < 4 || s.length > 30) return false;
  if (EXPLAIN_LINE.test(s)) return false;
  return /(?:代表队|团队|小组|队伍|支队|大队|中队|学院|学部|班级|团支部|党支部|社团|协会|教研室|实验室|中心|委员会|队|组)$/.test(s);
}
function splitMember(part) {
  let s = String(part).replace(/^[\s\d.、）)】\]（(]+/, "").trim();
  s = s.replace(/(?:等|等等)\s*(?:\d+\s*[名人位])?\s*$/, "").trim();
  const mm = s.match(/^([^（(【\[]+?)\s*[（(【\[]\s*([^）)】\]]*?)\s*[）)】\]]\s*$/);
  const body = (mm ? mm[1] : s).replace(/[\s。；;]+$/, "").trim();
  const note = mm ? mm[2].replace(/\s+/g, "").trim() : "";
  if (!body) return [];
  const words = body.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => /^[\u4e00-\u9fa5]{2,4}$/.test(w))) return words.map((w) => ({ body: w, note }));
  return [{ body, note }];
}
// 外层按标点切分，但要跳过括号里的顿号/逗号：「星火代表队（成员：赵六、钱七）」是一个整体，
// 按顿号切会把括号切坏 → 整行判废 → 团体名单整条丢失。
function splitTop(segment) {
  const parts = [];
  let depth = 0, buf = "";
  for (const ch of String(segment)) {
    if ("（(【[".includes(ch)) depth += 1;
    else if ("）)】]".includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && /[、，,；;/]/.test(ch)) { parts.push(buf); buf = ""; continue; }
    buf += ch;
  }
  parts.push(buf);
  return parts.map((s) => s.trim()).filter(Boolean);
}
// 整行当名单读：只要有一个片段不像名字/队名，整行作废。
function readRoster(segment, { team = false } = {}) {
  const parts = splitTop(segment);
  if (!parts.length) return [];
  const out = [];
  for (const part of parts) {
    for (const one of splitMember(part)) {
      if (team) {
        if (!isTeamName(one.body)) return [];
        out.push({ kind: "team", name: one.body, note: one.note, members: [] });
      } else if (isPersonName(one.body)) {
        out.push({ kind: "person", name: one.body, note: one.note, members: [] });
      } else if (isTeamName(one.body)) {
        out.push({ kind: "team", name: one.body, note: one.note, members: [] });
      } else return [];
    }
  }
  return out;
}
function labelKind(label) {
  const t = String(label || "");
  if (/指导|领队|教练|带队|辅导员/.test(t)) return "mentor";
  if (/单位|集体|团队|团体|队伍|代表队|支部|班级|学院|大队|小组/.test(t)) return "team";
  if (/人员|学生|选手|个人|作者|获奖者|获奖人|姓名|名单|同学|学员/.test(t)) return "person";
  return "";
}
function isLevelLine(line) {
  const t = String(line);
  if (t.length > 26) return false;
  if (!/特等奖|一等奖|二等奖|三等奖|优秀奖|金奖|银奖|铜奖|冠军|亚军|季军|入围奖|单项奖|名次/.test(t)) return false;
  return !EXPLAIN_LINE.test(t.replace(/获奖|荣获|获得|斩获|名单|如下|情况|学生|人员|单位|集体|个人|项目|名单如下/g, ""));
}
function rosterCandidate(value) {
  const t = String(value || "").trim();
  if (!t || t.length > 90) return false;
  if (!/[\u4e00-\u9fa5]/.test(t)) return false;
  if (/[0-9a-zA-Z@]/.test(t)) return false;                 // 学号、邮箱、编号行不是名单
  if (EXPLAIN_LINE.test(t)) return false;
  return true;
}

/* ── 解析一条通知 ── */
export function parseAwardNotice(notice = {}) {
  const rid = String(notice.rid || "");
  const title = String(notice.title || "");
  const date = Number(notice.date || 0);
  const seen = new Set();
  const groups = [];
  const mentors = [];
  const ctx = { level: awardLevel(title), scope: awardScope(title) };

  const add = (item) => {
    const key = `${item.kind}|${ctx.level}|${item.name}|${item.note}`;
    if (seen.has(key)) return;
    seen.add(key);
    groups.push({ kind: item.kind, name: item.name, note: item.note, members: item.members || [], level: ctx.level, scope: ctx.scope });
  };

  // 名单区：级别行或「获奖名单如下：」这类标签行开启，空行或明显的说明性长句关闭。
  // 为什么要有它：原来「单行单名」只问 ctx.level 有没有被设过，而级别一旦设上就再不过期 ——
  // 正文里出现过一次「一等奖」之后，任何 2–4 字短行（落款「教务处」、附件粗扫带出的字体名
  // 「等线」、Word 样式名「无列表」）都被当成了获奖人。脱离名单区就没有证据说一个孤零零的
  // 短行是获奖者，所以宁可漏。空行是通知里名单与正文之间最可靠的边界。
  let rosterZone = false;
  for (const raw of String(notice.text || "").split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) { rosterZone = false; continue; }
    // 整句说明文字（「请获奖同学于6月1日前到教务处领取证书。」）后面不再是名单区。
    // 只认「长句 + 句号 / 分号收尾」：名单行以顿号收尾，不会误伤一串名字。
    if (line.length >= 12 && /[。；;]$/.test(line)) { rosterZone = false; continue; }
    if (isLevelLine(line)) {
      const lv = awardLevel(line), sc = awardScope(line);
      rosterZone = true;
      // 「二等奖：星火代表队（成员：…）」「一等奖：张三、李四」这种级别与名单写在同一行的
      // 很常见（真实通知里比分行还多）。整行当级别吃掉会把人名一起丢掉，所以冒号后若是
      // 认得出的名单，就先把级别记下，再用同一套判定把名单读出来。
      const seg = line.match(/^(.{2,16}?)\s*[:：]\s*(\S.*)$/);
      if (seg) {
        const teamLabel = labelKind(seg[1]) === "team";
        const lineItems = rosterCandidate(seg[2]) ? readRoster(seg[2], { team: teamLabel }) : [];
        if (lineItems.length) {
          if (lv) ctx.level = lv;
          if (sc) ctx.scope = sc;
          for (const item of lineItems) add(item);
          continue;
        }
      }
      if (lv) ctx.level = lv;
      if (sc) ctx.scope = sc;
      continue;
    }
    if (ROSTER_OPEN.test(line) && line.length < 40) rosterZone = true;   // 名单区开始：下面继续按行读
    const colon = line.match(/^(.{2,14}?)\s*[:：]\s*(.+)$/);
    const label = colon ? colon[1] : "";
    const value = colon ? colon[2] : line;
    const kind = label ? labelKind(label) : "";
    if (kind === "mentor") {
      for (const one of readRoster(value)) if (one.kind === "person") mentors.push(one.name);
      continue;
    }
    if (label && !kind && !rosterCandidate(value)) continue;
    if (!rosterCandidate(value)) continue;
    const items = readRoster(value, { team: kind === "team" });
    if (!items.length) continue;
    if (value.length <= 8 && !label && items.length === 1 && items[0].kind === "person") {
      // 单行单名（"张三"）只有在名单区里才算获奖人：正文里的人名、末尾的落款「教务处」、
      // 附件粗扫带出来的字体名都长这个样子，脱离名单区就没证据说它是获奖者。
      if (!rosterZone) continue;
    }
    for (const item of items) add(item);
  }

  // 正文里的「团体名（成员：…）」：把括号内成员挂到团体上
  const text = String(notice.text || "");
  for (const g of groups) {
    if (g.kind !== "team") continue;
    const re = new RegExp(`${g.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[（(]([^）)]{2,40})[）)]`);
    const mm = text.match(re);
    if (mm) {
      const inner = mm[1].replace(/^(?:成员|队员|组员|团队|参赛选手)\s*[:：]?/, "").trim();
      const members = [];
      for (const one of readRoster(inner)) if (one.kind === "person") members.push(one.name);
      if (members.length) g.members = members;
    }
  }

  if (!groups.length) return null;
  const people = [...new Set(groups.filter((g) => g.kind === "person").map((g) => g.name))];
  const teams = [...new Set(groups.filter((g) => g.kind === "team").map((g) => g.name))];
  return {
    rid, title, project: cleanAwardTitle(title), date,
    level: awardLevel(groups.map((g) => g.level).filter(Boolean).join(" ") || title),
    scope: groups.map((g) => g.scope).filter(Boolean)[0] || awardScope(title),
    groups, people, teams, mentors: [...new Set(mentors)],
    kind: people.length && teams.length ? "mixed" : teams.length ? "team" : "person",
  };
}

/* ── 汇总与排名 ── */
export function sortAwardItems(items = [], order = "desc") {
  const dir = order === "asc" ? 1 : -1;
  return [...items].sort((a, b) => (a.date - b.date) * dir || String(a.project || "").localeCompare(String(b.project || ""), "zh"));
}
export function rankAwards(items = [], kind = "person") {
  const map = new Map();
  for (const item of items) {
    // 团体档只收「通知里按人列过成员」的队：只有这类条目才有人名可署名。
    // 只写了队名、没列成员的队整条不进榜（口径：不用队名署名，没姓名就不署名）。
    // 同一条通知里同名队合并成一行，成员取并集。
    let picks;
    if (kind === "team") {
      const merged = new Map();
      for (const t of item.teamMembers || []) {
        if (!(t?.members || []).length) continue;
        const cur = merged.get(t.name) || { name: t.name, members: new Set() };
        for (const m of t.members) cur.members.add(m);
        merged.set(t.name, cur);
      }
      picks = [...merged.values()].map((t) => ({ name: t.name, members: [...t.members] }));
    } else {
      picks = [...new Set(item.people || [])].map((name) => ({ name }));
    }
    for (const pick of picks) {
      const row = map.get(pick.name) || { name: pick.name, count: 0, hits: [], members: [] };
      row.count += 1;
      row.hits.push({
        project: item.project, title: item.title, level: item.level, scope: item.scope,
        date: Number(item.date || 0), rid: item.rid,
        attach: !!(item.affix && item.affix.length),
      });
      if (pick.members) row.members = [...new Set([...row.members, ...pick.members])];
      map.set(pick.name, row);
    }
  }
  const rows = [...map.values()].sort((a, b) => b.count - a.count
    || (Math.max(...b.hits.map((h) => h.date)) - Math.max(...a.hits.map((h) => h.date)))
    || a.name.localeCompare(b.name, "zh"));
  let rank = 0, prev = null;
  return rows.map((row, i) => {
    if (row.count !== prev) { rank = i + 1; prev = row.count; }
    return { ...row, rank, max: rows[0]?.count || 1, hits: [...row.hits].sort((a, b) => b.date - a.date) };
  });
}
// 「人名榜」：把个人获奖者与团体成员一并算到人头上 —— 一个人既以个人身份获奖、
// 又是代表队成员时，两次都记在他名下（展开里能看出哪几次来自团体）。
export function rankNames(items = []) {
  const map = new Map();
  for (const item of items) {
    for (const g of item.groups || []) {
      const names = g.kind === "team" ? g.members || [] : [g.name];
      for (const name of new Set(names)) {
        if (!name) continue;
        const row = map.get(name) || { name, count: 0, fromTeams: 0, hits: [] };
        row.count += 1;
        if (g.kind === "team") row.fromTeams += 1;
        row.hits.push({
          project: item.project, title: item.title, level: item.level, scope: item.scope,
          date: Number(item.date || 0), rid: item.rid, fromTeam: g.kind === "team",
          attach: !!(item.affix && item.affix.length),
        });
        map.set(name, row);
      }
    }
  }
  const rows = [...map.values()].sort((a, b) => b.count - a.count
    || (Math.max(...b.hits.map((h) => h.date)) - Math.max(...a.hits.map((h) => h.date)))
    || a.name.localeCompare(b.name, "zh"));
  let rank = 0, prev = null;
  return rows.map((row, i) => {
    if (row.count !== prev) { rank = i + 1; prev = row.count; }
    return { ...row, rank, max: rows[0]?.count || 1, hits: [...row.hits].sort((a, b) => b.date - a.date) };
  });
}

// 名次配色：前 10 名绿、11–20 名黄、其余红（并列同名次同色）。
export function rankTone(rank) {
  const n = Number(rank) || 0;
  if (n <= 10) return "good";
  if (n <= 20) return "warn";
  return "bad";
}

// 团体获奖不用队名署名（口径：获奖的是人，不是队）：把团体条目的成员摊成姓名。
// 通知只写了队名、没列成员时返回空 —— 这种条目没有姓名可署名，榜单里整条略过，绝不用队名顶替。
export function awardNamesOf(g = {}) {
  return (g.members || []).filter(Boolean);
}
export function teamMemberNames(groups = []) {
  return [...new Set((Array.isArray(groups) ? groups : []).flatMap((g) => awardNamesOf(g)))];
}
// 「张三、李四」——中文顿号分隔，不是空串时用。
export function joinPeople(names = []) {
  return (names || []).filter(Boolean).join("、");
}
// 一条获奖记录挂到谁名下：团体条目挂成员；没列成员时返回空串（不用队名顶替）。
export function awardBearer(g = {}) {
  if (g.kind !== "team") return g.name || "";
  return joinPeople(awardNamesOf(g));
}

export function buildAwardBoard(records = []) {
  const items = [];
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || !Array.isArray(rec.groups) || !rec.groups.length) continue;
    const people = [...new Set(rec.groups.filter((g) => g.kind === "person").map((g) => g.name))];
    const teamMap = new Map();
    for (const g of rec.groups.filter((g) => g.kind === "team")) {
      const cur = teamMap.get(g.name) || { name: g.name, members: new Set() };
      for (const m of g.members || []) cur.members.add(m);
      teamMap.set(g.name, cur);
    }
    const teamMembers = [...teamMap.values()].map((t) => ({ name: t.name, members: [...t.members] }));
    const teams = teamMembers.map((t) => t.name);
    if (!people.length && !teams.length) continue;
    items.push({
      rid: rec.rid, title: rec.title, project: rec.project, date: Number(rec.date || 0),
      level: rec.level, scope: rec.scope, groups: rec.groups, mentors: rec.mentors || [],
      // 名单是从这条通知的哪个附件里读出来的（没有附件来源就是空数组）。
      // 只存附件名，不存附件内容 —— 附件文本在同步那一轮用完即弃（见 main.js 的 awAffixText）。
      affix: Array.isArray(rec.affix) ? rec.affix.filter(Boolean).slice(0, 4) : [],
      people, teams, teamMembers,
      kind: people.length && teams.length ? "mixed" : teams.length ? "team" : "person",
    });
  }
  const sorted = sortAwardItems(items, "desc");
  const names = rankNames(sorted);
  return {
    items: sorted,
    people: rankAwards(sorted, "person"),
    teams: rankAwards(sorted, "team"),
    names,
    stats: {
      notices: sorted.length,
      people: new Set(sorted.flatMap((i) => i.people)).size,
      teams: new Set(sorted.flatMap((i) => i.teams)).size,
      names: names.length,
       awards: sorted.reduce((sum, i) => sum + i.people.length + i.teams.length, 0),
      // 通知只写了队名、没按人列成员的团体：没有姓名可署名，因此不进任何清单与排名。
      // 这里只报个数（不报名字），免得用户以为人漏了。
      unlisted: new Set(sorted.flatMap((i) => (i.teamMembers || [])
        .filter((t) => !(t?.members || []).length).map((t) => t.name))).size,
      // 团体条目按成员署名（口径见 awardNamesOf）：这一列是「能点到人头上」的人数，
      // 所以团体成员与个人获奖者一起算，队名本身不进这个集合。
      awarded: new Set([
        ...sorted.flatMap((i) => i.people),
        ...sorted.flatMap((i) => i.groups.filter((g) => g.kind === "team").flatMap((g) => awardNamesOf(g))),
      ]).size,
      latest: sorted[0]?.date || 0,
    },
  };
}

/* ── 展示 ── */
const fmtDate = (t) => {
  const n = Number(t || 0);
  if (!n) return "时间未知";
  const d = new Date(n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const KIND_LABEL = { person: "个人", team: "团体", mixed: "个人+团体" };
const KEY = "awardViewPreferences";
const KEY_KINDS = { person: 1, team: 1 };

function styles() {
  if (typeof document === "undefined" || document.getElementById("award-list-style")) return;
  const node = document.createElement("style");
  node.id = "award-list-style";
  node.textContent = `.aw-panel{border:1px solid var(--line);border-radius:16px;padding:16px;margin:14px 0;background:var(--panel);color:var(--ink)}
.aw-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap}
.aw-kicker{font-size:calc(11px * var(--ui-text-scale));letter-spacing:.28em;color:var(--ink-3,#7E8B94);margin-bottom:4px}
.aw-panel h3{margin:0;font-size:calc(19px * var(--ui-text-scale))}
.aw-meta{margin:9px 0 0;font-size:calc(12px * var(--ui-text-scale));line-height:1.8;color:var(--ink-2,#4A5A66)}
.aw-seg{display:inline-flex;position:relative;isolation:isolate;border:1px solid var(--line);border-radius:11px;overflow:hidden;background:var(--panel)}
/* 铁律六：单选组的高亮 = 一块随选择滑动的光（位置 500ms / 尺寸 400ms 过冲缓动，宿主 selectionGlow.js 画），
   所以选中的那个按钮自己不再画静态底色；开关 / 多选不使用这一效果。 */
.aw-seg .selection-glow{position:absolute;left:0;top:0;width:0;height:0;opacity:0;pointer-events:none;z-index:0;transition:opacity .2s linear;border-radius:10px;background:var(--deep)}
.aw-seg .selection-glow.on{opacity:1}
.aw-seg.has-selection-glow button{position:relative;z-index:1}
.aw-seg.has-selection-glow button[aria-pressed=true]{background:transparent}
.aw-seg[hidden],.aw-lab[hidden]{display:none}
.aw-seg button[hidden]{display:none}
.aw-seg button{font:inherit;font-size:calc(12px * var(--ui-text-scale));color:inherit;background:transparent;border:0;padding:8px 12px;min-height:36px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .18s ease,color .18s ease}
.aw-seg button+button{border-left:1px solid var(--line)}
.aw-seg button[aria-pressed=true]{background:var(--deep);color:var(--on-accent,#fff)}
.aw-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:13px 0 9px}
.aw-lab{font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94)}
.aw-total{font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);white-space:nowrap}
.aw-list{display:grid;gap:8px;margin:0;padding:0;list-style:none}
.aw-item{border:1px solid var(--line);border-radius:13px;background:color-mix(in srgb,var(--deep) 4%,var(--panel));overflow:hidden}
.aw-row{display:flex;align-items:center;gap:9px;width:100%;box-sizing:border-box;font:inherit;text-align:left;color:inherit;background:transparent;border:0;padding:11px 13px;min-height:46px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:background .16s ease}
.aw-row:hover,.aw-row:focus-visible{background:color-mix(in srgb,var(--deep) 10%,var(--panel))}
.aw-row:focus-visible{outline:2px solid color-mix(in srgb,var(--deep) 55%,transparent);outline-offset:-2px}
.aw-date{flex:none;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);font-variant-numeric:tabular-nums}
.aw-no{flex:none;min-width:26px;font-weight:700;color:var(--deep);font-variant-numeric:tabular-nums}
/* 名次配色：前 10 绿、11–20 黄、其余红（用户可读的一眼判据，不依赖颜色时名次数字本身也在） */
.aw-no.good{color:color-mix(in srgb,var(--mint,#3E9C7A) 74%,var(--ink))}
.aw-no.warn{color:color-mix(in srgb,var(--sun,#D9A22B) 86%,var(--ink))}
.aw-no.bad{color:color-mix(in srgb,var(--danger,#C0492F) 86%,var(--ink))}
.aw-name{flex:1 1 auto;min-width:0;font-size:calc(13px * var(--ui-text-scale));font-weight:600;overflow-wrap:anywhere}
.aw-tag{flex:none;font-size:calc(10.5px * var(--ui-text-scale));padding:3px 8px;border-radius:999px;border:1px solid var(--line);background:color-mix(in srgb,var(--deep) 8%,var(--panel));color:var(--ink-2,#4A5A66);white-space:nowrap}
.aw-tag.lvl{border-color:color-mix(in srgb,var(--sun,#D9A22B) 45%,var(--line));background:color-mix(in srgb,var(--sun,#D9A22B) 16%,var(--panel));color:var(--ink)}
.aw-tag.grp{border-color:color-mix(in srgb,var(--mint,#3E9C7A) 45%,var(--line));background:color-mix(in srgb,var(--mint,#3E9C7A) 15%,var(--panel));color:var(--ink)}
.aw-tag.affix{border-color:color-mix(in srgb,var(--deep) 45%,var(--line));background:color-mix(in srgb,var(--deep) 12%,var(--panel));color:var(--ink)}
.aw-arrow{flex:none;color:var(--deep);font-size:calc(11px * var(--ui-text-scale));transition:transform .3s cubic-bezier(.2,.78,.2,1)}
.aw-item.open .aw-arrow{transform:rotate(90deg)}
.aw-shell{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows .34s cubic-bezier(.2,.8,.2,1),opacity .22s ease}
.aw-item.open .aw-shell{grid-template-rows:1fr;opacity:1}
.aw-clip{min-height:0;overflow:hidden}
.aw-detail{padding:2px 13px 13px;font-size:calc(12px * var(--ui-text-scale));line-height:1.85;color:var(--ink-2,#4A5A66)}
.aw-group{margin-top:9px}
.aw-group>b{display:block;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94);font-weight:600;margin-bottom:5px}
.aw-pills{display:flex;flex-wrap:wrap;gap:6px}
.aw-pill{border:1px solid var(--line);border-radius:9px;padding:4px 9px;background:var(--panel);color:var(--ink)}
.aw-pill span{color:var(--ink-3,#7E8B94);font-size:calc(10.5px * var(--ui-text-scale));margin-left:5px}
.aw-hits{margin:0;padding:0;list-style:none;display:grid;gap:6px}
.aw-hits li{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px dashed var(--line);padding-top:6px}
.aw-hits li:first-child{border-top:0;padding-top:0}
/* 每一条获奖项目本身就是「回原通知」的入口（与「奖项项目」页的来源按钮同一条通路）：
   点名字回通知核对原句，展开态不会因此丢掉。 */
.aw-hits>.aw-hit{display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%;box-sizing:border-box;font:inherit;text-align:left;color:inherit;background:transparent;border:0;padding:2px 0;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;border-radius:8px}
.aw-hits>.aw-hit:hover .aw-name,.aw-hits>.aw-hit:focus-visible .aw-name{text-decoration:underline}
.aw-hits>.aw-hit:focus-visible{outline:2px solid color-mix(in srgb,var(--deep) 55%,transparent);outline-offset:2px}
.aw-src{margin-top:11px;padding-top:9px;border-top:1px dashed var(--line);font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#7E8B94)}
.aw-src button{font:inherit;font-size:inherit;color:var(--deep);background:transparent;border:0;padding:0;text-align:left;cursor:pointer;text-decoration:underline}
.aw-empty{border:1px dashed var(--line);border-radius:13px;padding:16px;text-align:center;color:var(--ink-3,#7E8B94);font-size:calc(12px * var(--ui-text-scale));line-height:1.9}
.aw-bar{flex:0 1 150px;height:7px;border-radius:999px;background:color-mix(in srgb,var(--deep) 12%,var(--panel));overflow:hidden}
.aw-bar i{display:block;height:100%;border-radius:999px;background:var(--deep)}
.aw-note{margin:12px 0 0;font-size:calc(11.5px * var(--ui-text-scale));line-height:1.9;color:var(--ink-3,#7E8B94)}
.aw-status{margin:9px 0 0;font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#4A5A66)}
[data-theme-mode=dark] .aw-item{background:color-mix(in srgb,var(--deep) 12%,var(--panel))}
[data-theme-mode=dark] .aw-no.good{color:color-mix(in srgb,var(--mint,#3E9C7A) 74%,#fff)}
[data-theme-mode=dark] .aw-no.warn{color:color-mix(in srgb,var(--sun,#D9A22B) 84%,#fff)}
[data-theme-mode=dark] .aw-no.bad{color:color-mix(in srgb,var(--danger,#C0492F) 78%,#fff)}
[data-theme-mode=dark] .aw-tag{background:color-mix(in srgb,var(--deep) 18%,var(--panel));color:color-mix(in srgb,var(--ink) 88%,var(--panel))}
[data-theme-mode=dark] .aw-tag.lvl{background:color-mix(in srgb,var(--sun,#D9A22B) 22%,var(--panel));color:color-mix(in srgb,var(--sun,#D9A22B) 60%,var(--ink))}
[data-theme-mode=dark] .aw-tag.grp{background:color-mix(in srgb,var(--mint,#3E9C7A) 22%,var(--panel));color:color-mix(in srgb,var(--mint,#3E9C7A) 60%,var(--ink))}
[data-theme-mode=dark] .aw-tag.affix{background:color-mix(in srgb,var(--deep) 22%,var(--panel));color:color-mix(in srgb,var(--ink) 88%,var(--panel))}
.aw-affix{color:inherit}
@media(max-width:620px){.aw-panel{padding:12px}.aw-row{gap:7px;padding:10px}.aw-date{display:none}.aw-bar{flex-basis:80px}.aw-seg button{padding:8px 10px}}
@media(prefers-reduced-motion:reduce){.aw-arrow,.aw-shell,.aw-row{transition-duration:.01ms!important}}`;
  document.head.append(node);
}

// 一行获奖项目：有 rid 就整行做成按钮（点回原通知核对），没有 rid 时退化成纯展示行。
function hitHtml(h, kind) {
  // 团体来源只标「团体」两个字，**不写队名**（口径见 awardNamesOf）。
  const inner = `<span class="aw-name">${esc(h.project || h.title)}</span>${h.level ? `<span class="aw-tag lvl">${esc(h.level)}</span>` : ""}${kind === "names" && h.fromTeam ? `<span class="aw-tag grp">团体</span>` : ""}${h.attach ? `<span class="aw-tag affix">附件名单</span>` : ""}<span class="aw-date">${esc(fmtDate(h.date))}</span>`;
  return h.rid
    ? `<li><button type="button" class="aw-hit" data-aw-source="${esc(h.rid)}" title="查看来源通知">${inner}</button></li>`
    : `<li>${inner}</li>`;
}

function rowsHtml(rows, kind) {
  return rows.map((row) => {
    // 团体档的行名就是成员姓名（rankAwards 已滤掉没列成员的队），不出现任何队名。
    const label = kind === "team" ? joinPeople(row.members) : row.name;
    return `<li class="aw-item" data-aw-item="${esc(row.key)}">
  <button type="button" class="aw-row" data-aw-toggle="${esc(row.key)}" aria-expanded="false" aria-controls="aw-body-${esc(row.id)}">
    <span class="aw-no ${rankTone(row.rank)}">${row.rank}</span><span class="aw-name">${esc(label)}</span>
    <span class="aw-bar" aria-hidden="true"><i style="width:${Math.max(6, Math.round(row.count / row.max * 100))}%"></i></span>
    <span class="aw-total">${row.count} 项</span><span class="aw-arrow" aria-hidden="true">▸</span>
  </button>
  <div class="aw-shell" id="aw-body-${esc(row.id)}" aria-hidden="true"><div class="aw-clip"><div class="aw-detail">
    <ul class="aw-hits">${(row.hits || []).map((h) => hitHtml(h, kind)).join("")}</ul>
    ${kind === "names" && row.fromTeams ? `<div class="aw-group"><b>其中 ${row.fromTeams} 次来自团体获奖成员</b></div>` : ""}
    <div class="aw-src">统计口径：同一奖项记 1 项，同名并列同一次数${kind === "names" ? "；团体成员计入本人" : ""}${kind === "names" ? "；带「附件名单」标的条目，名单读自该通知的附件" : ""}</div>
  </div></div></div>
</li>`;
  }).join("");
}

function itemsHtml(items) {
  return items.map((item) => {
    const people = item.groups.filter((g) => g.kind === "person");
    const teams = item.groups.filter((g) => g.kind === "team");
    // 团体获奖不署队名（口径）：成员摊进同一份人员清单。通知只写队名、没列成员的团体
    // 没有姓名可署名，因此不出现任何名字（只在尾部提示一句「未列成员姓名」）。
    const memberNames = teamMemberNames(teams);
    const shown = [...new Set([...people.map((g) => g.name), ...memberNames])];
    const unlisted = teams.filter((g) => !awardNamesOf(g).length).length;
    const key = `n:${item.rid}`;
    return `<li class="aw-item" data-aw-item="${esc(key)}">
  <button type="button" class="aw-row" data-aw-toggle="${esc(key)}" aria-expanded="false" aria-controls="aw-body-${esc(item.rid)}">
    <span class="aw-date">${esc(fmtDate(item.date))}</span>
    <span class="aw-name">${esc(item.project)}</span>
    ${item.level ? `<span class="aw-tag lvl">${esc(item.level)}</span>` : ""}
    ${item.scope ? `<span class="aw-tag">${esc(item.scope)}</span>` : ""}
    <span class="aw-tag${item.teams.length ? " grp" : ""}">${esc(KIND_LABEL[item.kind] || "个人")}${item.people.length + item.teams.length ? ` ${item.people.length + item.teams.length}` : ""}</span>
    <span class="aw-arrow" aria-hidden="true">▸</span>
  </button>
  <div class="aw-shell" id="aw-body-${esc(item.rid)}" aria-hidden="true"><div class="aw-clip"><div class="aw-detail">
    ${shown.length ? `<div class="aw-group"><b>获奖人员 / 团体成员 ${shown.length}</b><div class="aw-pills">${shown.map((n) => {
      const note = people.find((g) => g.name === n)?.note || "";
      const inTeam = memberNames.includes(n);
      return `<span class="aw-pill"${inTeam ? ` title="团体获奖成员（团体获奖按人署名）"` : ""}>${esc(n)}${note ? `<span>${esc(note)}</span>` : ""}${inTeam ? `<span>团体</span>` : ""}</span>`;
    }).join("")}</div></div>` : ""}
    ${unlisted ? `<div class="aw-group"><b>${unlisted} 个团体获奖未列出成员姓名（无姓名可署名，不计入本页）</b></div>` : ""}
    ${item.mentors.length ? `<div class="aw-group"><b>指导教师 / 领队（不计入排名）</b><div class="aw-pills">${item.mentors.map((m) => `<span class="aw-pill">${esc(m)}</span>`).join("")}</div></div>` : ""}
    <div class="aw-src">来源通知：<button type="button" data-aw-source="${esc(item.rid)}">${esc(item.title)}</button>${item.affix?.length ? `<span class="aw-affix">（获奖名单来自附件：${esc(item.affix.join("、"))}）</span>` : ""}</div>
  </div></div></div>
</li>`;
  }).join("");
}

export async function createAwardPanel(storage, options = {}) {
  // 分组按钮的滑动选中光由宿主开给插件（tide.ui.selectionGlow，见 pluginHost.js），
  // 老宿主没有这一口时退回「只切选中态」的瞬变，不抛错。
  const glowFor = typeof options.selectionGlow === "function" ? options.selectionGlow : null;
  let mode = "items", kind = "person", order = "desc", status = "", last = null, saving = false, dirty = false;
  // 人名榜默认关闭（开关在设置页「警大获奖名单」），关着时连分段按钮都不出现。
  let namesBoard = false;
  try {
    const saved = await storage?.get?.(KEY, null);
    if (saved && typeof saved === "object") {
      if (saved.mode === "items" || saved.mode === "rank" || saved.mode === "names") mode = saved.mode;
      if (KEY_KINDS[saved.kind]) kind = saved.kind;
      if (saved.order === "asc" || saved.order === "desc") order = saved.order;
    }
  } catch { status = "视图偏好读取失败，暂用默认值"; }
  // 连点几下（最新在前 → 个人 → 团体）时，后一次不能因为前一次还在写就被丢掉：
  // 正在写就把变更记成待写，写完再补一次 —— 最终落盘的一定是最后那次选择。
  const persist = () => {
    if (saving) { dirty = true; return; }
    saving = true;
    const snapshot = { mode, kind, order };
    Promise.resolve(storage?.set?.(KEY, snapshot)).catch(() => {}).finally(() => {
      saving = false;
      if (dirty) { dirty = false; persist(); }
    });
  };

  const SEGS = {
    mode: [["items", "奖项项目"], ["rank", "获奖排名"], ["names", "人名榜"]],
    order: [["desc", "最新在前"], ["asc", "最早在前"]],
    kind: [["person", "个人"], ["team", "团体"]],
  };
  const SEG_DATA = { mode: "awMode", order: "awOrder", kind: "awKind" };
  let mounted = null, bodySig = "", glows = [];
  // 展开态记在这里而不是从 DOM 读：换模式 / 换类别会重画列表，那时 DOM 里
  // 已经没有原来的条目了，从 DOM 读等于把用户折开的条目又收回去。
  const openKeys = new Set();

  const segHtml = (name) => `<div class="aw-seg" data-aw-seg="${name}">${SEGS[name]
    .map(([id, label]) => `<button type="button" data-aw-${name}="${id}" aria-pressed="false">${label}</button>`).join("")}</div>`;

  const shellHtml = () => `<section class="aw-panel">
  <div class="aw-head"><div><div class="aw-kicker">警 大 门 户 通 知 · 获 奖 名 单</div><h3>获奖人员一览</h3></div>${segHtml("mode")}</div>
  <p class="aw-meta" data-aw-meta></p>
  <div class="aw-tools"><span class="aw-lab" data-aw-lab="order">时间</span>${segHtml("order")}<span class="aw-lab" data-aw-lab="kind">类别</span>${segHtml("kind")}<span style="flex:1"></span><span class="aw-total" data-aw-total></span></div>
  <div data-aw-body></div>
  <p class="aw-note">名单来自通知正文里明确的获奖段落（「获奖名单如下」「获奖人员：」这类标签行，或整行只有姓名的名单行）；奖项项目名、级别与层级由通知文字归类，指导教师与领队只展示、不计入排名。团体获奖一律按获奖人姓名署名，队名不出现在本页任何位置；通知只写了队名、没按人列成员的团体因为没有姓名可署名，不进人员清单也不进排名（会在条目里标出个数）。通知只说「取得佳绩」却没有逐字列人时不会有条目，也不代表无人获奖。</p>
  <p class="aw-status" role="status" aria-live="polite"></p>
</section>`;

  // 壳只建一次：三组单选按钮（模式 / 顺序 / 类别）换选项时只切 aria-pressed，
  // 让宿主的光块自己从上一个选项滑过来 —— 一旦重建 innerHTML，光块和它的观察者
  // 就成了孤儿，500ms 的位移动画会被截断（铁律六）。
  function attachGlows(root) {
    for (const glow of glows) glow?.dispose?.();
    glows = [];
    for (const box of root.querySelectorAll?.(".aw-seg") || []) {
      let handle = null;
      try { handle = glowFor?.(box, { selector: 'button[aria-pressed="true"]' }) || null; } catch { handle = null; }
      glows.push(handle);
    }
  }

  function mount(root) {
    root.innerHTML = shellHtml();
    mounted = root;
    bodySig = "";
    for (const name of ["mode", "order", "kind"]) {
      for (const btn of root.querySelectorAll(`[data-aw-${name}]`)) {
        btn.onclick = () => choose(name, btn.dataset[SEG_DATA[name]]);
      }
    }
    attachGlows(root);
  }

  function choose(group, value) {
    if (!value) return;
    if (group === "mode") { if (mode === value) return; mode = value; }
    else if (group === "order") { if (order === value) return; order = value; }
    else { if (kind === value) return; kind = value; }
    status = "";
    persist();
    paint();
  }

  // 选中态就地切换；顺序 / 类别两组按当前模式显隐（同一个位置，不重建）。
  function markGroup(root, name, value, visible = true) {
    for (const btn of root.querySelectorAll(`[data-aw-${name}]`)) {
      btn.setAttribute("aria-pressed", String(btn.dataset[SEG_DATA[name]] === value));
    }
    const box = root.querySelector(`[data-aw-seg="${name}"]`);
    const lab = root.querySelector(`[data-aw-lab="${name}"]`);
    if (box) box.hidden = !visible;
    if (lab) lab.hidden = !visible;
  }

  function paint() {
    // 展开/收起走就地改类名（见下面的委托），重渲染只换内容 ——
    // 状态存在 DOM 上而不是这里，所以重渲染不会把用户折起来的条目又摊开。
    if (!last || last.root?.isConnected === false) return;
    const { root, board, meta = {} } = last;
    styles();
    if (mounted !== root || !root.querySelector?.("[data-aw-body]")) mount(root);
    const stats = board?.stats || { notices: 0, people: 0, teams: 0, awards: 0 };
    // 人名榜按钮只在设置里开启后出现；关掉时若正停在这一档，退回「奖项项目」。
    if (!namesBoard && mode === "names") mode = "items";
    const namesBtn = root.querySelector('[data-aw-mode="names"]');
    if (namesBtn) namesBtn.hidden = !namesBoard;
    markGroup(root, "mode", mode);
    markGroup(root, "order", order, mode === "items");
    markGroup(root, "kind", kind, mode === "rank");
    root.querySelector("[data-aw-meta]").innerHTML = `已识别 <b>${stats.notices}</b> 条获奖通知 · 奖项 <b>${stats.awards}</b> 人次 · 署名到人 <b>${stats.awarded ?? stats.people}</b> 位${stats.unlisted ? ` · 另有 <b>${stats.unlisted}</b> 个团体获奖未列成员姓名` : ""}${stats.latest ? ` · 最近一条 ${esc(fmtDate(stats.latest))}` : ""}${meta.syncedAt ? ` · 同步于 ${esc(new Date(meta.syncedAt).toLocaleString("zh-CN", { hour12: false }))}` : ""}`;

    let list = [], rows = [], total = "", body;
    if (!stats.notices) {
      body = `<div class="aw-empty">${meta.progress ? esc(meta.progress) : meta.error ? "同步失败" : "还没有可展示的获奖记录"}<br>${meta.error ? esc(meta.error) : "读到的通知里还没有明确的获奖名单段落——点上方「刷新」重试，或去通知视图确认是否已加载更早的通知。"}</div>`;
    } else if (mode === "items") {
      list = order === "asc" ? [...board.items].reverse() : board.items;
      total = `${list.length} 个奖项项目`;
      body = `<ul class="aw-list" data-aw-list>${itemsHtml(list)}</ul>`;
    } else if (mode === "names") {
      rows = (board.names || []).map((row, i) => ({ ...row, id: `nm${i}`, key: `nm:${row.name}` }));
      total = `${rows.length} 位（含团体成员）${rows.length ? ` · 最高 ${rows[0].count} 项` : ""}`;
      body = rows.length ? `<ul class="aw-list" data-aw-list>${rowsHtml(rows, "names")}</ul>`
        : `<div class="aw-empty">还没有出现过人名：通知正文里没有明确的获奖人姓名，或团体没有按人列出成员。</div>`;
    } else {
      // 团体档的 key 也只用成员姓名拼：队名不许以任何形式落到 HTML 源码里（连 data-* 都不行），
      // 免得有人翻 DOM 又看见队名；同一组成员 → 同一个 key，展开态照样能复现。
      rows = (kind === "team" ? board.teams : board.people).map((row, i) => ({
        ...row, rank: row.rank, id: `r${i}`,
        key: kind === "team" ? `t:${joinPeople(row.members)}` : `p:${row.name}`,
      }));
      total = `${rows.length} ${kind === "team" ? "组（按成员署名）" : "位个人"}${rows.length ? ` · 最高 ${rows[0].count} 项` : ""}`;
      body = rows.length ? `<ul class="aw-list" data-aw-list>${rowsHtml(rows, kind)}</ul>`
        : `<div class="aw-empty">这类记录还没有：${kind === "team" ? "通知里的团体获奖都还没按人列出成员姓名（没有姓名可署名）" : "通知里没有出现个人获奖名单"}</div>`;
    }
    const totalEl = root.querySelector("[data-aw-total]");
    if (totalEl) totalEl.textContent = total;
    root.querySelector(".aw-status").textContent = meta.progress || meta.error || status || "";
    for (const glow of glows) glow?.sync?.();

    // 列表 DOM 只在内容真变时重建（换模式 / 换类别 / 数据或进度变了），
    // 连点分组按钮不会把已经展开的条目推倒重来。
    const sig = [mode, kind, order, stats.notices, stats.people, stats.teams, stats.awards,
      meta.progress || "", meta.error || "",
      mode === "items" ? list.map((i) => i.rid).join(",") : rows.map((r) => r.key).join(",")].join("|");
    const bodyEl = root.querySelector("[data-aw-body]");
    if (!bodyEl || sig === bodySig) return;
    bodyEl.innerHTML = body;
    bodySig = sig;

    // 复现上次的展开态（列表重建不打断阅读）
    root.querySelectorAll("[data-aw-toggle]").forEach((btn) => {
      const key = btn.dataset.awToggle;
      if (key && openKeys.has(key)) setOpen(root, key, true);
    });
    const listNode = root.querySelector("[data-aw-list]");
    if (listNode) {
      listNode.onclick = (event) => {
        const target = event?.target;
        const toggle = target?.closest?.("[data-aw-toggle]");
        if (toggle && listNode.contains?.(toggle)) {
          const key = toggle.dataset.awToggle;
          setOpen(root, key, toggle.getAttribute("aria-expanded") !== "true");
          return;
        }
        const src = target?.closest?.("[data-aw-source]");
        if (src) last.onOpenSource?.(src.dataset.awSource);
      };
    }
  }

  function setOpen(root, key, open) {
    const toggle = [...root.querySelectorAll("[data-aw-toggle]")].find((b) => b.dataset.awToggle === key);
    if (!toggle) return;
    if (open) openKeys.add(key); else openKeys.delete(key);
    toggle.setAttribute("aria-expanded", String(open));
    const item = toggle.closest(".aw-item");
    if (item) {
      item.classList.toggle("open", open);
      item.querySelector(".aw-shell")?.setAttribute("aria-hidden", String(!open));
    }
  }

  return {
    render(root, board, meta = {}) {
      if (!root) return;
      last = { root, board, meta, onOpenSource: meta.onOpenSource };
      paint();
      // 设置页的开关每次进视图都重读一次：改完设置回来就是新状态，不必重启应用。
      Promise.resolve(storage?.get?.("namesBoard", false)).then((on) => {
        const next = on === true;
        if (next === namesBoard) return;
        namesBoard = next;
        if (!namesBoard && mode === "names") mode = "items";
        paint();
      }).catch(() => {});
    },
  };
}
