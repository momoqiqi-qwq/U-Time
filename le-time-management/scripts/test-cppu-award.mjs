import assert from "node:assert/strict";
import fs from "node:fs";
import {
  awardLevel, awardScope, cleanAwardTitle, titleLooksAward, isAwardNotice,
  parseAwardNotice, sortAwardItems, rankAwards, rankNames, rankTone, buildAwardBoard, createAwardPanel,
  awardNamesOf, awardBearer, teamMemberNames, joinPeople, isPersonName,
} from "../public/plugins/cppu-notify/award-list.js";

/* ── 迷你 DOM ──────────────────────────────────────────────────────────────
   获奖面板要用到 closest / classList / getAttribute（展开收起是就地改类名，
   不重渲染整块），所以比 card-averages 那个只有 dataset 的替身要多几个能力。
   只实现被测代码真正调用的那几个方法，不做通用 DOM。 */
const VOID_TAGS = new Set(["input", "br", "img", "hr", "meta", "link"]);
const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

class FNode {
  constructor(tag = "#root") {
    this.tag = String(tag).toLowerCase();
    this.attrs = new Map();
    this.classes = new Set();
    this.children = [];
    this.parent = null;
    this.text = "";
    this.isConnected = true;
    this._html = "";
    const self = this;
    this.dataset = new Proxy({}, {
      get: (_, key) => self.attrs.get("data-" + String(key).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())),
      set: (_, key, value) => { self.attrs.set("data-" + String(key).replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), String(value)); return true; },
    });
    this.classList = {
      add: (...cs) => cs.forEach((c) => self.classes.add(c)),
      remove: (...cs) => cs.forEach((c) => self.classes.delete(c)),
      contains: (c) => self.classes.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !self.classes.has(c) : Boolean(on);
        if (want) self.classes.add(c); else self.classes.delete(c);
        return want;
      },
    };
  }
  set innerHTML(html) { this._html = String(html); this.children = []; this.text = ""; parseInto(this, this._html); }
  get innerHTML() { return this._html; }
  set textContent(value) { this._html = ""; this.children = []; this.text = String(value); }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(""); }
  setAttribute(key, value) { this.attrs.set(String(key).toLowerCase(), String(value)); }
  getAttribute(key) { const k = String(key).toLowerCase(); return this.attrs.has(k) ? this.attrs.get(k) : null; }
  matches(selector) {
    const m = String(selector).trim().match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/);
    if (!m) throw new Error(`迷你 DOM 不认识的选择器：${selector}`);
    if (m[1] && this.tag !== m[1].toLowerCase()) return false;
    for (const tok of (m[2] || "").matchAll(/\.([\w-]+)|\[([^\]]+)\]/g)) {
      if (tok[1]) { if (!this.classes.has(tok[1])) return false; continue; }
      const eq = tok[2].indexOf("=");
      const key = (eq < 0 ? tok[2] : tok[2].slice(0, eq)).trim().toLowerCase();
      const want = eq < 0 ? null : tok[2].slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      const cur = this.attrs.get(key);
      if (want === null ? cur === undefined : cur !== want) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => { for (const child of node.children) { if (child.matches(selector)) out.push(child); walk(child); } };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { let node = this; while (node) { if (node.matches(selector)) return node; node = node.parent; } return null; }
  contains(node) { let cur = node; while (cur) { if (cur === this) return true; cur = cur.parent; } return false; }
  addEventListener() {}
}
function parseInto(root, html) {
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)(\/?)>/g;
  const stack = [root];
  const inner = [0];             // 每个栈帧的内层起点，闭合时切出原始内层 HTML
  let last = 0, m;
  while ((m = re.exec(html))) {
    const chunk = html.slice(last, m.index).trim();
    if (chunk) stack[stack.length - 1].text += chunk;
    last = re.lastIndex;
    if (m[1]) {
      if (stack.length > 1) { const node = stack.pop(); node._html = html.slice(inner.pop(), m.index); }
      continue;
    }
    const node = new FNode(m[2]);
    for (const am of (m[3] || "").matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g)) {
      const name = am[1].toLowerCase(), value = am[2] === undefined ? "" : am[2];
      if (name === "class") value.split(/\s+/).filter(Boolean).forEach((c) => node.classes.add(c));
      else node.attrs.set(name, value);
    }
    node.parent = stack[stack.length - 1];
    node.parent.children.push(node);
    if (!m[4] && !VOID_TAGS.has(node.tag)) { stack.push(node); inner.push(re.lastIndex); }
  }
  const tail = html.slice(last).trim();
  if (tail) stack[stack.length - 1].text += tail;
  while (stack.length > 1) { const node = stack.pop(); node._html = html.slice(inner.pop()); }
}

/* ── 1. 标题清洗：条目名要说清项目，不能是通知原文 ── */
assert.equal(cleanAwardTitle("关于公布2025年全国大学生数学建模竞赛获奖名单的通知"), "2025年全国大学生数学建模竞赛");
assert.equal(cleanAwardTitle("关于表彰2024年度学生先进集体和个人的通知"), "2024年度学生先进集体和个人");
assert.equal(cleanAwardTitle("喜报"), "喜报");                       // 洗没了就退回原标题，不留空
assert.doesNotMatch(cleanAwardTitle("关于公布2025年全国大学生数学建模竞赛获奖名单的通知"), /通知|关于/);

/* ── 2. 级别 / 层级 / 像不像获奖通知 ── */
assert.equal(awardLevel("荣获全国一等奖"), "一等奖");
assert.equal(awardLevel("特等奖"), "特等奖");
assert.equal(awardLevel("获得金奖"), "金奖");
assert.equal(awardLevel("参加培训班"), "");
assert.equal(awardScope("全国大学生竞赛"), "国家级");
assert.equal(awardScope("全省高校联赛"), "省级");
assert.equal(awardScope("校级评选"), "校级");
assert.equal(titleLooksAward("关于公布2025年全国大学生数学建模竞赛获奖名单的通知"), true);
assert.equal(titleLooksAward("关于开展2026年暑期社会实践活动的通知"), true);   // 软信号：标题像，交给正文判定
assert.equal(titleLooksAward("关于组织学生参加四六级考试安排的通知"), false);   // 硬负词：正文提获奖也不收
assert.equal(titleLooksAward(""), false);
assert.equal(isAwardNotice({ title: "关于公布2025年评选结果的通知", text: "经评审，我校学生荣获佳绩。" }), true);
assert.equal(isAwardNotice({ title: "关于开展暑期社会实践的通知", text: "请各学院报送材料。" }), false);

/* ── 3. 解析：只收明确名单，正文套话不能变成人名 ── */
const NOTICE_A = {
  rid: "1001",
  title: "关于公布2025年全国大学生数学建模竞赛我校获奖名单的通知",
  date: new Date("2025-05-20T09:00:00").getTime(),
  text: [
    "各学院、各有关部门：",
    "根据竞赛组委会公布的评选结果，现将我校获奖情况公布如下。",
    "获奖名单如下：",
    "一等奖",
    "张三、李四",
    "二等奖",
    "王五",
    "团体奖：星火代表队（成员：赵六、钱七）",
    "指导教师：孙老师",
    "请获奖同学于6月1日前到教务处领取证书。",
  ].join("\n"),
};
const recA = parseAwardNotice(NOTICE_A);
assert.ok(recA, "明确的获奖名单必须解析出条目");
assert.equal(recA.project, "2025年全国大学生数学建模竞赛");
assert.deepEqual(recA.people, ["张三", "李四", "王五", "赵六", "钱七"].filter((n) => recA.people.includes(n)));
assert.deepEqual(recA.teams, ["星火代表队"]);
assert.deepEqual(recA.mentors, ["孙老师"]);                      // 指导教师只展示、不算获奖
assert.equal(recA.level, "一等奖");                               // 取首个级别行
assert.equal(recA.kind, "mixed");
const teamGroup = recA.groups.find((g) => g.kind === "team");
assert.deepEqual(teamGroup.members, ["赵六", "钱七"]);            // 括号里的成员挂到团体上
assert.ok(!recA.groups.some((g) => g.kind === "person" && /各学院|有关部门|组委会|教务处|证书/.test(g.name)),
  "正文里的机构名与套话不能变成获奖人");

// 级别与名单同一行（真实通知里很常见的写法）也要能读出来
const inline = parseAwardNotice({
  rid: "1003", title: "关于公布信息安全竞赛获奖名单的通知", date: 1,
  text: "获奖名单如下：\n一等奖：陈晓\n二等奖：星火代表队（成员：周八）",
});
assert.deepEqual(inline.people, ["陈晓"]);
assert.deepEqual(inline.teams, ["星火代表队"]);
assert.deepEqual(inline.groups.find((g) => g.kind === "team").members, ["周八"]);

// 只说「取得佳绩」、没逐字列人的通知：不出条目（宁少不滥）
assert.equal(parseAwardNotice({
  rid: "1004", title: "关于我校学生参加竞赛的情况通报", date: 1,
  text: "本次活动我校学生表现优异，荣获佳绩，充分展现了良好风貌。",
}), null);

/* ── 3b. 落款、字体名、Word 样式名都不是获奖人 ──
   真实误判（用户截图）：通知出现过一次级别行之后，后面任何孤零零的 2–4 字短行都被收进榜单 ——
   附件带出的字体名「等线 / 仿宋 / 宋体」、Word 样式名「无列表」、以及通知末尾的发布单位
   「教务处」全都上了榜。它们在形状上和人名完全一样，只能靠词表 + 名单区两道判定挡。 */
const NOISE = ["教务处", "等线", "仿宋", "宋体", "无列表", "2026年10月14日"];
const recNoise = parseAwardNotice({
  rid: "1005", title: "关于公布2026年警体技能比武获奖名单的通知", date: 1,
  text: ["获奖名单如下：", "一等奖：张三", ...NOISE].join("\n"),
});
assert.deepEqual(recNoise.people, ["张三"], "落款、字体名、样式名都不许成为获奖人");

assert.equal(isPersonName("等线"), false);
assert.equal(isPersonName("仿宋"), false);
assert.equal(isPersonName("宋体"), false);
assert.equal(isPersonName("无列表"), false);
assert.equal(isPersonName("教务处"), false);
assert.equal(isPersonName("团委"), false);
assert.equal(isPersonName("科研处"), false);
assert.equal(isPersonName("张三"), true);
assert.equal(isPersonName("周子衿"), true);

// 名单区不能被修得过头：级别行 + 纯姓名行（真实通知最常见的写法）仍要读到
const plainZ = parseAwardNotice({
  rid: "1006", title: "关于公布2026年数学建模竞赛获奖名单的通知", date: 1,
  text: ["获奖名单如下：", "一等奖", "周子衿", "肖亦嫣", "二等奖", "李果"].join("\n"),
});
assert.deepEqual(plainZ.people, ["周子衿", "肖亦嫣", "李果"], "名单区里的纯姓名行仍要收");

// 脱离名单区（空行 / 说明句之后）的孤立短行不算获奖人 —— 宁少不滥
const strayZ = parseAwardNotice({
  rid: "1007", title: "关于公布2026年英语演讲比赛获奖名单的通知", date: 1,
  text: ["获奖名单如下：", "一等奖：张三", "", "教务处", "王五"].join("\n"),
});
assert.deepEqual(strayZ.people, ["张三"], "空行之后的孤立短行没有获奖证据");

/* ── 4. 汇总与排名 ── */
const NOTICE_B = {
  rid: "1002",
  title: "关于公布我校学生参加第十八届全国大学生信息安全竞赛获奖结果的通知",
  date: new Date("2025-09-10T09:00:00").getTime(),
  text: ["获奖名单如下：", "一等奖：张三", "二等奖：陈晓", "优秀组织奖：侦查学院代表队"].join("\n"),
};
const recB = parseAwardNotice(NOTICE_B);
const board = buildAwardBoard([recA, recB]);
assert.equal(board.items.length, 2);
assert.equal(board.items[0].rid, "1002", "默认时间倒序：最新的项目在前");
assert.deepEqual(board.items.map((i) => i.rid), sortAwardItems(board.items, "asc").map((i) => i.rid).reverse());
assert.equal(board.stats.notices, 2);
assert.equal(board.stats.people, 4);                             // 张三 / 李四 / 王五 / 陈晓
assert.equal(board.stats.teams, 2);
const people = board.people;
assert.equal(people[0].name, "张三");
assert.equal(people[0].count, 2);
assert.equal(people[0].rank, 1);
assert.equal(people[0].hits.length, 2);
assert.equal(people[1].count, 1);
assert.equal(people[1].rank, 2, "同数量并列，名次不跳号");
assert.equal(people.filter((p) => p.rank === 2).length, 3);
assert.equal(people[3].rank, 2, "命中次数相同的人共享同一名次");
const teams = board.teams;
assert.equal(teams.filter((t) => t.name === "星火代表队").length, 1);
// 团体档只收「按人列过成员」的队：只写队名、没列成员的队不进榜（口径：不用队名署名）。
assert.ok(!teams.some((t) => t.name === "侦查学院代表队"), "没列成员的队不进团体榜");
assert.equal(board.stats.unlisted, 1, "未列成员的团体只报个数");
assert.deepEqual(teams[0].members, ["赵六", "钱七"], "团体榜行名靠成员姓名");
assert.deepEqual(rankAwards([], "person"), []);
assert.equal(buildAwardBoard([]).stats.notices, 0);

/* ── 4b. 人名榜：团体成员也算到本人头上 ── */
assert.equal(board.stats.names, 6, "张三/李四/王五/赵六/钱七/陈晓");
const names = board.names;
assert.equal(names[0].name, "张三");
assert.equal(names[0].count, 2, "个人身份 1 次 + 通知 B 里 1 次");
assert.equal(names[0].rank, 1);
assert.equal(names[0].fromTeams, 0);
const zhao = names.find((n) => n.name === "赵六");
assert.ok(zhao, "只出现在团体成员名单里的人也要进人名榜");
assert.equal(zhao.count, 1);
assert.equal(zhao.fromTeams, 1, "要能看出这 1 次来自团体成员名单");
const lisi = names.find((n) => n.name === "李四");
assert.equal(lisi.fromTeams, 0);
assert.equal(names.filter((n) => n.rank === 2).length, 5, "同数量并列，名次不跳号");
assert.ok(!names.some((n) => n.name === "孙老师"), "指导教师不进人名榜");
assert.deepEqual(rankNames([]), []);
assert.equal(rankTone(1), "good");
assert.equal(rankTone(10), "good");
assert.equal(rankTone(11), "warn");
assert.equal(rankTone(20), "warn");
assert.equal(rankTone(21), "bad");
assert.equal(rankTone(99), "bad");

/* ── 5. 面板：分段、下拉、来源回跳、偏好落盘 ── */
const styles = new Map();
globalThis.document = {
  getElementById: (id) => styles.get(id),
  createElement: () => ({ id: "", textContent: "" }),
  head: { append(node) { styles.set(node.id, node); } },
};
const store = new Map();
const saved = [];
const storage = {
  get: async (key, fallback) => (store.has(key) ? store.get(key) : fallback),
  set: async (key, value) => { store.set(key, value); saved.push({ key, value }); },
};
const opened = [];
const glowCalls = [];
const panel = await createAwardPanel(storage, {
  // 宿主把 src/selectionGlow.js 的实现开给插件（tide.ui.selectionGlow）；这里只记它被叫了几次、给了哪个容器
  selectionGlow: (box, opts) => {
    const handle = { synced: 0, sync() { handle.synced++; }, dispose() { handle.disposed = true; } };
    glowCalls.push({ box, opts, handle });
    return handle;
  },
});
const root = new FNode();
panel.render(root, board, { syncedAt: Date.now(), onOpenSource: (rid) => opened.push(rid) });
const bodyHtml = () => root.querySelector("[data-aw-body]").innerHTML;
const metaHtml = () => root.querySelector("[data-aw-meta]").innerHTML;
const toggleOf = (key) => root.querySelectorAll("[data-aw-toggle]").find((b) => b.dataset.awToggle === key);
const listEl = () => root.querySelector("[data-aw-list]");
const fire = (node) => listEl().onclick({ target: node });
assert.match(root.innerHTML, /获奖人员一览/);
assert.deepEqual(root.querySelectorAll(".aw-seg").map((b) => b.dataset.awSeg), ["mode", "order", "kind"], "三组单选常驻壳里");
assert.equal(glowCalls.length, 3, "三组单选各接一次宿主的滑动选中光（铁律六）");
assert.deepEqual(glowCalls[0].opts, { selector: 'button[aria-pressed="true"]' });
assert.match(metaHtml(), /署名到人 <b>6<\/b> 位/);
assert.ok(root.querySelector("[data-aw-list]"), "奖项列表已渲染");
assert.ok(styles.get("award-list-style"), "面板样式注入一次（带 id，可去重）");

// 奖项项目：按时间排列 + 日期/级别/个人团体标签
assert.ok(bodyHtml().indexOf("第十八届全国大学生信息安全竞赛") < bodyHtml().indexOf("2025年全国大学生数学建模竞赛"));
const orderAsc = root.querySelectorAll("[data-aw-order]").find((b) => b.dataset.awOrder === "asc");
orderAsc.onclick();
assert.ok(bodyHtml().indexOf("2025年全国大学生数学建模竞赛") < bodyHtml().indexOf("第十八届全国大学生信息安全竞赛"),
  "「最早在前」要真的把顺序倒过来");
assert.equal(orderAsc.getAttribute("aria-pressed"), "true", "切换只动 aria-pressed，按钮节点不重建");
assert.ok(glowCalls.every((c) => c.handle.synced > 0), "切换后要通知光块重新落位");

// 点开下拉栏：看到谁获奖（双向动画靠 .aw-shell 的 grid-template-rows，类名就地切换）
const toggle = toggleOf("n:1001");
assert.ok(toggle, "奖项项目应可展开");
assert.equal(toggle.getAttribute("aria-expanded"), "false");
fire(toggle);
assert.equal(toggle.getAttribute("aria-expanded"), "true");
const itemNode = toggle.closest(".aw-item");
assert.equal(itemNode.classList.contains("open"), true, "展开靠 .open（CSS 负责 0fr→1fr 动画）");
assert.equal(itemNode.querySelector(".aw-shell").getAttribute("aria-hidden"), "false");
fire(toggle);
assert.equal(toggle.getAttribute("aria-expanded"), "false");
assert.equal(itemNode.classList.contains("open"), false, "再点一下收起，且不留残留类名");
assert.equal(itemNode.querySelector(".aw-shell").getAttribute("aria-hidden"), "true");

// 来源通知：从名单回到原通知核对
const srcBtn = itemNode.querySelector("[data-aw-source]");
fire(srcBtn);
assert.deepEqual(opened, ["1001"]);

// 排名视图：个人 / 团体切换
fire(toggle);                                                              // 展开着换视图
assert.equal(toggleOf("n:1001").getAttribute("aria-expanded"), "true");
root.querySelectorAll("[data-aw-mode]").find((b) => b.dataset.awMode === "rank").onclick();
assert.equal(root.querySelector('[data-aw-seg="order"]').hidden, true, "排名模式收起「时间」组");
assert.equal(root.querySelector('[data-aw-seg="kind"]').hidden, false, "排名模式露出「类别」组");
assert.match(bodyHtml(), /张三位|张三[\s\S]*2 项/);
root.querySelectorAll("[data-aw-kind]").find((b) => b.dataset.awKind === "team").onclick();
assert.match(bodyHtml(), /赵六、钱七/, "团体排名档的行名 = 成员姓名");
assert.doesNotMatch(bodyHtml(), /星火代表队/, "团体排名档不出现队名（标题位、悬停气泡都不出现）");
assert.doesNotMatch(bodyHtml(), /侦查学院代表队/, "没列成员的队整条不进榜");
assert.match(root.querySelector("[data-aw-total]").textContent, /1 组（按成员署名）/, "总数不再按「个团体」说");
// 切回奖项项目：列表要重画，但展开态按 key 复现（不打断阅读）
root.querySelectorAll("[data-aw-mode]").find((b) => b.dataset.awMode === "items").onclick();
assert.equal(root.querySelector('[data-aw-seg="kind"]').hidden, true, "奖项项目模式收起「类别」组");
assert.equal(toggleOf("n:1001").getAttribute("aria-expanded"), "true", "重画后展开态要复现");
// 连点多次后最终落盘的必须是最后那次选择（写盘节流也不能把变更吃掉）
await new Promise((resolve) => setTimeout(resolve, 120));
assert.deepEqual(saved.at(-1).value, { mode: "items", kind: "team", order: "asc" });
assert.ok(saved.length >= 2, "被节流合并的中间变更要在写完后补写一次");

// 空态与失败态都要说人话
const emptyRoot = new FNode();
panel.render(emptyRoot, null, { progress: "正在读正文筛选获奖名单 3/12（已命中 1 条）" });
assert.match(emptyRoot.querySelector("[data-aw-body]").innerHTML, /正在读正文筛选获奖名单/);
panel.render(emptyRoot, buildAwardBoard([]), { error: "列表接口 HTTP 500" });
assert.match(emptyRoot.querySelector("[data-aw-body]").innerHTML, /同步失败/);

/* ── 5b. 人名榜：设置里开启后才出现，名次数字按区间着色 ── */
const namesBtn = () => root.querySelectorAll("[data-aw-mode]").find((b) => b.dataset.awMode === "names");
assert.ok(namesBtn(), "人名榜档位常驻壳里（显隐由设置开关决定）");
assert.equal(namesBtn().hidden, true, "默认关闭：这一档藏起来");
store.set("namesBoard", true);
panel.render(root, board, { syncedAt: Date.now(), onOpenSource: (rid) => opened.push(rid) });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(namesBtn().hidden, false, "设置里开启后这一档出现");
namesBtn().onclick();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(namesBtn().getAttribute("aria-pressed"), "true");
assert.match(bodyHtml(), /张三/);
assert.match(bodyHtml(), /其中 1 次来自团体获奖成员/, "只从团体名单里出现的人要标出来源");
assert.match(bodyHtml(), /aw-no good/, "第 1 名用绿色");

/* ── 5b2. 团体获奖只用成员姓名署名：队名在整页任何位置都不出现 ──
   口径：获奖的是人不是队。团体列了成员 → 按成员姓名署名；只写队名、没列成员 → 没有姓名可署名，
   该条目不进人员清单、不进排名，只在条目里报一个「未列成员」的个数。 */
assert.deepEqual(awardNamesOf({ kind: "team", name: "星火代表队", members: ["赵六", "钱七"] }), ["赵六", "钱七"]);
assert.equal(awardBearer({ kind: "team", name: "星火代表队", members: ["赵六"] }), "赵六");
assert.equal(awardBearer({ kind: "team", name: "无成员代表队", members: [] }), "", "没列成员时不许拿队名顶替");
assert.equal(awardBearer({ kind: "person", name: "张三" }), "张三");
assert.equal(board.stats.awarded, 6, "署名到人 = 个人获奖者 ∪ 团体成员");
assert.equal(teamMemberNames(board.items[1].groups.filter((g) => g.kind === "team")).join("、"), "赵六、钱七");

const teamRoot = new FNode();
const teamPanel = await createAwardPanel(storage, {});
const teamBoard = buildAwardBoard([
  { rid: "2001", title: "关于公布建模竞赛获奖名单的通知", project: "建模竞赛", date: 100,
    level: "一等奖", scope: "国家级", people: [], teams: [], mentors: [], kind: "team", affix: [],
    groups: [{ kind: "team", name: "星火代表队", members: ["赵六", "钱七"], level: "一等奖", scope: "国家级" }] },
  { rid: "2002", title: "关于公布队列会操获奖名单的通知", project: "队列会操", date: 200,
    level: "二等奖", scope: "校级", people: [], teams: [], mentors: [], kind: "team", affix: [],
    groups: [{ kind: "team", name: "无成员代表队", members: [], level: "二等奖", scope: "校级" }] },
]);
teamPanel.render(teamRoot, teamBoard, { syncedAt: Date.now() });
const teamBody = () => teamRoot.querySelector("[data-aw-body]").innerHTML;
const teamList = () => teamRoot.querySelector("[data-aw-list]");
const teamToggle = (key) => teamRoot.querySelectorAll("[data-aw-toggle]").find((b) => b.dataset.awToggle === key);
assert.match(teamRoot.querySelector("[data-aw-meta]").innerHTML, /署名到人 <b>2<\/b> 位/);
assert.match(teamRoot.querySelector("[data-aw-meta]").innerHTML, /另有 <b>1<\/b> 个团体获奖未列成员姓名/,
  "未列成员的团体只报个数，不报队名");
teamList().onclick({ target: teamToggle("n:2001") });                       // 团体列了成员：整页连队名都不出现
assert.match(teamBody(), /获奖人员 \/ 团体成员 2/);
assert.match(teamBody(), /赵六/);
assert.match(teamBody(), /钱七/);
assert.doesNotMatch(teamBody(), /星火代表队/, "奖项项目里也不出现队名");
teamList().onclick({ target: teamToggle("n:2002") });
assert.doesNotMatch(teamBody(), /无成员代表队/, "没列成员的团体不署名（队名一个都不出现）");
assert.doesNotMatch(teamBody(), /署名仍用队名/, "已经没有「退回队名」这种兜底了");
assert.match(teamBody(), /1 个团体获奖未列出成员姓名（无姓名可署名，不计入本页）/, "只报个数，让人知道没漏");
teamRoot.querySelectorAll("[data-aw-mode]").find((b) => b.dataset.awMode === "rank").onclick();
teamRoot.querySelectorAll("[data-aw-kind]").find((b) => b.dataset.awKind === "team").onclick();
assert.match(teamBody(), /赵六、钱七/, "团体排名档按成员署名");
assert.doesNotMatch(teamBody(), /星火代表队/, "团体排名档不出现队名");
assert.doesNotMatch(teamBody(), /无成员代表队/, "没列成员的队整条不进榜");
assert.doesNotMatch(teamBody(), /原队名/, "队名不再进悬停气泡");
assert.match(teamRoot.querySelector(".aw-note").textContent, /团体获奖一律按获奖人姓名署名，队名不出现在本页任何位置/);
const namesRow = rankNames(teamBoard.items).find((r) => r.name === "赵六");
assert.ok(namesRow, "团体成员进人名榜，来源仍记着是团体");
assert.equal(joinPeople(teamMemberNames([{ kind: "team", members: ["赵六", "钱七"] }])), "赵六、钱七");
teamPanel.render(teamRoot, teamBoard, { syncedAt: Date.now() });
await new Promise((resolve) => setTimeout(resolve, 0));
teamRoot.querySelectorAll("[data-aw-mode]").find((b) => b.dataset.awMode === "names").onclick();
teamRoot.querySelector("[data-aw-list]").onclick({ target: teamRoot.querySelector('[data-aw-toggle="nm:赵六"]') });
assert.match(teamRoot.querySelector(".aw-hits").innerHTML, /aw-tag grp">团体</, "人名榜里的团体来源只标「团体」，不写队名");
assert.doesNotMatch(teamRoot.querySelector(".aw-hits").innerHTML, /星火代表队/);

/* ── 5c. 个人榜里的每一条记录也要能回原通知 ──
   「个人项目里面的通知」过去只有奖项项目那一档有入口，排名档里每条记录只是一行字；
   现在每条记录本身就是通往来源通知的按钮。 */
const personToggle = toggleOf("nm:张三");
assert.ok(personToggle, "个人榜每行可展开");
fire(personToggle);
const zhangHits = rankNames(board.items).find((r) => r.name === "张三").hits;   // 已按日期倒序
const hitBtns = listEl().querySelector('[data-aw-item="nm:张三"]').querySelectorAll(".aw-hit");
assert.equal(hitBtns.length, zhangHits.length, "展开后每条获奖记录都是可点的按钮，不是死文本");
assert.equal(hitBtns[0].dataset.awSource, zhangHits[0].rid, "点它要带着那条记录的来源通知 rid");
assert.equal(hitBtns[0].getAttribute("title"), "查看来源通知");
const openedBefore = opened.length;
fire(hitBtns[0]);
assert.deepEqual(opened.slice(openedBefore), [zhangHits[0].rid], "点它要真的跳到那条通知");

/* ── 5d. 名单读自附件时要说清是哪份附件 ── */
const affixBoard = buildAwardBoard([{
  rid: "77", title: "关于公布第九届「精武杯」获奖名单的通知", project: "负重接力",
  date: Date.UTC(2026, 9, 13), level: "一等奖", scope: "个人",
  groups: [{ kind: "person", name: "张一", members: [] }], people: ["张一"], teams: [], mentors: [], kind: "person",
  affix: ["获奖名单.docx"],
}]);
const affixRoot = new FNode();
panel.render(affixRoot, affixBoard, { syncedAt: Date.now() });
await new Promise((resolve) => setTimeout(resolve, 0));
const affixList = () => affixRoot.querySelector("[data-aw-list]");
affixList().onclick({ target: affixRoot.querySelector('[data-aw-toggle="nm:张一"]') });   // 仍在个人榜档
assert.equal(affixRoot.querySelectorAll(".aw-tag.affix").length, 1, "读自附件的条目挂「附件名单」标");
assert.match(affixRoot.querySelector(".aw-hits").innerHTML, /附件名单/);
affixRoot.querySelectorAll("[data-aw-mode]").find((b) => b.dataset.awMode === "items").onclick();
affixList().onclick({ target: affixRoot.querySelector('[data-aw-toggle="n:77"]') });
assert.match(affixRoot.querySelector(".aw-src").innerHTML, /获奖名单来自附件：获奖名单\.docx/,
  "来源行要写清名单读自哪份附件（可核对）");
assert.match(affixRoot.querySelector(".aw-src").innerHTML, /data-aw-source="77"/);
assert.equal(rankNames(affixBoard.items)[0].hits[0].attach, true, "附件来源要跟着记录走到排名里");

// 前 10 名绿、11–20 名黄、其余红（并列同名次同色）
const toneBoard = {
  items: [], people: [], teams: [],
  stats: { notices: 25, people: 25, teams: 0, awards: 25, names: 25, latest: 0 },
  names: Array.from({ length: 25 }, (_, i) => ({ name: `人${i + 1}`, count: 25 - i, rank: i + 1, fromTeams: 0, hits: [] })),
};
panel.render(root, toneBoard, { syncedAt: Date.now(), onOpenSource: (rid) => opened.push(rid) });
await new Promise((resolve) => setTimeout(resolve, 0));
root.querySelectorAll("[data-aw-mode]").find((b) => b.dataset.awMode === "names").onclick();   // 5d 停在项目档，切回人名榜
const toneCount = (tone) => (bodyHtml().match(new RegExp(`aw-no ${tone}`, "g")) || []).length;
assert.equal(toneCount("good"), 10, "前 10 名绿色");
assert.equal(toneCount("warn"), 10, "11–20 名黄色");
assert.equal(toneCount("bad"), 5, "21 名以后红色");

// 关掉开关：档位消失，且不能停在一个已经隐藏的档位上
store.set("namesBoard", false);
panel.render(root, board, { syncedAt: Date.now(), onOpenSource: (rid) => opened.push(rid) });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(namesBtn().hidden, true);
assert.equal(root.querySelectorAll("[data-aw-mode]").find((b) => b.dataset.awMode === "items").getAttribute("aria-pressed"), "true",
  "关掉开关后要退回「奖项项目」");

/* ── 6. 静态接线：视图注册 / 入口 / 共用登录与正文缓存 ── */
const source = fs.readFileSync(new URL("../public/plugins/cppu-notify/main.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.match(source, /import\("\/plugins\/cppu-notify\/award-list\.js"\)/);
assert.match(source, /registerView\(\{ id: "cppu-award", title: "警大获奖名单", icon: "award", render: mountAwardView \}\)/);
assert.match(source, /\{ view: "cppu-award", label: "获奖名单", icon: "trophy" \}/);
assert.match(source, /data-award>获奖名单<\/button>/);
assert.match(source, /navigate\("plug:cppu-award"\)/);
assert.match(source, /async function fetchNoticeContent\(rid\)/);
assert.match(source, /const got = await fetchNoticeContent\(rid\)/);        // 通知视图改走同一取数函数
assert.match(source, /titleLooksAward\(titleOf\(it\)\)/);
assert.match(source, /mod\.parseAwardNotice\(\{ rid, title: titleOf\(it\), text, date: Number\(it\.CREATE_TIME \|\| 0\) \}\)/);
// 只扫最新 4 页会把名单限制在今年 ⇒ 改成按年份回溯，并给状态行报出真实覆盖范围
assert.match(source, /const AWARD_YEARS = \d+;/);
assert.match(source, /const AWARD_PAGES_MAX = \d+;/);
assert.match(source, /awState\.pages = Math\.min\(AWARD_PAGES_MAX, awState\.pages \+ AWARD_PAGES_STEP\)/);
assert.match(source, /awCoverage\(\)/);
assert.match(source, /data-aw-deeper/);
assert.match(source, /await awSync\(el, true\)/);
assert.match(source, /const unread = cands\.filter\(\(it\) => !state\.details\[itemKey\(it\)\]\?\.content\)/);
assert.match(source, /AWARD_CACHE_KEY/);
assert.match(source, /data-aw-banner-refresh/);                             // 失败横幅可点重试
assert.match(source, /pageNum: page, pageSize: PAGE_SIZE/);                 // 与通知列表同一接口
// 获奖名单附件：只读「该读的」附件；扫过的跳过；名单抽出来后附件文本即弃，不留缓存
assert.match(source, /import\("\/plugins\/cppu-notify\/award-attach\.js"\)/);
assert.match(source, /const AWARD_AFFIX_MAX = \d+;/);
assert.match(source, /attachMod\.looksLikeAwardAttachment\(att\.name, body\)/);
assert.match(source, /if \(affixScanned\[affixKey\(rid, att\.name\)\]\) continue;/);
assert.match(source, /await markAffixScanned\(rid, att\.name\)/);
assert.match(source, /const text = \[det\?\.content, affix\?\.text\]\.filter\(Boolean\)\.join\("\\n"\)/);
assert.match(source, /rec\.affix = affix\.names\.slice\(0, 4\)/);          // 记录里只带附件名
assert.match(source, /affixScanned\[affixKey\(rid, name\)\] = Date\.now\(\)/);  // 「扫过」标记里只记时间，不存内容
assert.match(source, /records: awState\.records\.slice\(0, AWARD_CACHE_MAX\)/);  // 落盘的只有名单本身
// 缓存存的是「解析结果」，解析口径一变旧结果就不能再看：改口径必须升 AWARD_CACHE_VER，
// 否则升级后旧榜（混着等线 / 仿宋 / 无列表 / 教务处）会继续被读出来渲染。
assert.match(source, /const AWARD_CACHE_VER = \d+;/);
assert.match(source, /ver: AWARD_CACHE_VER,/);
assert.match(source, /if \(Number\(cache\.ver\) !== AWARD_CACHE_VER\) return false;/);
assert.match(source, /tide\.notify\("这条来源通知还没在列表里/);
const module = fs.readFileSync(new URL("../public/plugins/cppu-notify/award-list.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.match(module, /\.aw-shell\{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows/);
assert.match(module, /\.aw-item\.open \.aw-shell\{grid-template-rows:1fr;opacity:1\}/);
assert.match(module, /\.aw-clip\{min-height:0;overflow:hidden\}/);
assert.match(module, /@media\(prefers-reduced-motion:reduce\)\{\.aw-arrow,\.aw-shell,\.aw-row\{transition-duration:\.01ms!important\}\}/);
assert.match(module, /role="status" aria-live="polite"/);
assert.match(module, /data-aw-source/);
// 诉求①：个人/团体排名档里，每一条获奖记录本身就是回原通知的按钮（过去只有项目档有入口）
assert.match(module, /function hitHtml\(h, kind\)/);
assert.match(module, /class="aw-hit" data-aw-source="\$\{esc\(h\.rid\)\}" title="查看来源通知"/);
assert.match(module, /\.aw-hits>\.aw-hit:hover \.aw-name/);
assert.match(module, /\.aw-hits>\.aw-hit:focus-visible\{outline/);
// 诉求②：名单读自附件时挂「附件名单」标；项目档的来源行写清是哪份附件
assert.match(module, /h\.attach \? `<span class="aw-tag affix">附件名单<\/span>`/);
assert.match(module, /\.aw-tag\.affix\{border-color/);
assert.match(module, /获奖名单来自附件：\$\{esc\(item\.affix\.join\("、"\)\)\}/);
// 铁律六：三组单选让宿主的滑动选中光来画（插件拿不到 src/selectionGlow.js，宿主用 tide.ui.selectionGlow 开给它）
assert.match(module, /\.aw-seg \.selection-glow\{/);
assert.match(module, /\.aw-seg\.has-selection-glow button\[aria-pressed=true\]\{background:transparent\}/);
assert.match(module, /\.aw-seg\[hidden\],\.aw-lab\[hidden\]\{display:none\}/);
assert.match(module, /glowFor\?\.\(box, \{ selector: 'button\[aria-pressed="true"\]' \}\)/);
assert.match(source, /selectionGlow: \(box, opts\) => tide\.ui\.selectionGlow\?\.\(box, opts\)/);
assert.match(source, /await mod\.createAwardPanel\(tide\.storage/);
// 人名榜：默认关闭（开关在设置页），名次数字按区间着色
assert.match(module, /export function rankNames\(items = \[\]\)/);
assert.match(module, /export function rankTone\(rank\)/);
assert.match(module, /\.aw-no\.good\{color:color-mix/);
assert.match(module, /\.aw-no\.warn\{color:color-mix/);
assert.match(module, /\.aw-no\.bad\{color:color-mix/);
assert.match(module, /\[data-theme-mode=dark\] \.aw-no\.good\{/);
assert.match(module, /storage\?\.get\?\.\("namesBoard", false\)/);
assert.match(module, /if \(!namesBoard && mode === "names"\) mode = "items"/);
assert.match(module, /\["names", "人名榜"\]/);
const settingsSource = fs.readFileSync(new URL("../src/views/settings.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.match(settingsSource, /import \{ createCppuAwardCard \} from "\.\/settings\/cppuAward\.js"/);
assert.match(settingsSource, /id: "cppu-award", create: \(\{ render \}\) => createCppuAwardCard\(\)/);
const cardSource = fs.readFileSync(new URL("../src/views/settings/cppuAward.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.match(cardSource, /S\.pluginState\("cppu-notify"\)\.storage/);
assert.match(cardSource, /role: "switch"/);
assert.match(cardSource, /namesBoard/);

/* ── 6b. 自动登录：恢复出来的票据必须先真验证一次，再谈续期与密码兜底 ──
   回归的是「获奖名单从来不自动登录」：restoreCookies 恢复的 tp_up 可能早已过期，
   旧写法 `if (state.token) return true;` 一道短路就把整条链路废了，用户看到 302 横幅后
   只能手点「重新登录」再手填一次验证码 —— 通知视图有 autoLogin() 真验证，这里之前没有。 */
assert.match(source, /function awSessionError\(e\) \{/);
assert.match(source, /HTTP\\s\*\(\?:30\[0-9\]\|40\[13\]\)\|会话已过期\|登录可能已过期\|重新登录\|未建立/);
assert.match(source, /async function awProbeSession\(\) \{\n    try \{ await awFetchList\(1\); return true; \}/);
assert.match(source, /async function awEnsureSession\(force = false\) \{/);
assert.doesNotMatch(source, /if \(state\.token\) return true;/);                    // 旧短路不许回来
assert.match(source, /if \(force\) \{ awState\.sessionOk = false; state\.token = ""; \}/);
assert.match(source, /if \(state\.token && await awProbeSession\(\)\) \{ awState\.sessionOk = true; return true; \}/);
assert.match(source, /if \(await silentRenew\(\)\) \{[\s\S]{0,160}?if \(await awProbeSession\(\)\) \{ awState\.sessionOk = true; return true; \}/);
assert.match(source, /if \(await passwordAutoLogin\(\)\) \{ awState\.sessionOk = true; return true; \}/);
assert.match(source, /sessionOk: false \};/);
// 长同步中途会话失效：续一次期 / 走一次密码兜底再重跑，成不了才把错误摆出来
assert.match(source, /if \(!awSessionError\(e\) \|\| !await awEnsureSession\(true\)\) throw e;/);
assert.match(source, /if \(awSessionError\(e\)\) awState\.sessionOk = false;/);
assert.match(source, /if \(sessionLost\) awState\.sessionOk = false;/);
// 传输抖动（断网 / DNS）不是登录态问题：显示缓存 + 真实原因，别把用户甩到人工登录表单
assert.match(source, /awState\.error = explainHttpError\(e\);/);
// 用户点「重新登录」时，缓存里的「会话已核验」也必须作废
assert.match(source, /awState\.sessionOk = false;   \/\/ 用户明确要求重新登录/);

console.log("PASS: 获奖名单解析（标题清洗/级别层级/名单行/团体成员）· 个人团体排名并列 · 人名榜（团体成员计入本人）与名次配色 · 时间正倒序 · 下拉展开收起 · 每条记录回原通知 · 附件名单标与来源附件名 · 偏好落盘 · 单选走宿主滑动选中光 · 设置开关接线 · 视图接线 · 自动登录（票据先验证 再续期 再密码兜底）");
