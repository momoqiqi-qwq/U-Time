import assert from "node:assert/strict";
import fs from "node:fs";
import {
  awardLevel, awardScope, cleanAwardTitle, titleLooksAward, isAwardNotice,
  parseAwardNotice, sortAwardItems, rankAwards, rankNames, rankTone, buildAwardBoard, createAwardPanel,
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
  let last = 0, m;
  while ((m = re.exec(html))) {
    const chunk = html.slice(last, m.index).trim();
    if (chunk) stack[stack.length - 1].text += chunk;
    last = re.lastIndex;
    if (m[1]) { if (stack.length > 1) stack.pop(); continue; }
    const node = new FNode(m[2]);
    for (const am of (m[3] || "").matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g)) {
      const name = am[1].toLowerCase(), value = am[2] === undefined ? "" : am[2];
      if (name === "class") value.split(/\s+/).filter(Boolean).forEach((c) => node.classes.add(c));
      else node.attrs.set(name, value);
    }
    node.parent = stack[stack.length - 1];
    node.parent.children.push(node);
    if (!m[4] && !VOID_TAGS.has(node.tag)) stack.push(node);
  }
  const tail = html.slice(last).trim();
  if (tail) stack[stack.length - 1].text += tail;
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
assert.match(metaHtml(), /个人 <b>4<\/b> 位/);
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
assert.match(bodyHtml(), /星火代表队/);
assert.match(bodyHtml(), /已知成员/);
assert.match(bodyHtml(), /赵六/);
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
panel.render(root, board, { syncedAt: Date.now() });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(namesBtn().hidden, false, "设置里开启后这一档出现");
namesBtn().onclick();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(namesBtn().getAttribute("aria-pressed"), "true");
assert.match(bodyHtml(), /张三/);
assert.match(bodyHtml(), /其中 1 次来自团体成员名单/, "只从团体名单里出现的人要标出来源");
assert.match(bodyHtml(), /aw-no good/, "第 1 名用绿色");

// 前 10 名绿、11–20 名黄、其余红（并列同名次同色）
const toneBoard = {
  items: [], people: [], teams: [],
  stats: { notices: 25, people: 25, teams: 0, awards: 25, names: 25, latest: 0 },
  names: Array.from({ length: 25 }, (_, i) => ({ name: `人${i + 1}`, count: 25 - i, rank: i + 1, fromTeams: 0, hits: [] })),
};
panel.render(root, toneBoard, { syncedAt: Date.now() });
await new Promise((resolve) => setTimeout(resolve, 0));
const toneCount = (tone) => (bodyHtml().match(new RegExp(`aw-no ${tone}`, "g")) || []).length;
assert.equal(toneCount("good"), 10, "前 10 名绿色");
assert.equal(toneCount("warn"), 10, "11–20 名黄色");
assert.equal(toneCount("bad"), 5, "21 名以后红色");

// 关掉开关：档位消失，且不能停在一个已经隐藏的档位上
store.set("namesBoard", false);
panel.render(root, board, { syncedAt: Date.now() });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(namesBtn().hidden, true);
assert.equal(root.querySelectorAll("[data-aw-mode]").find((b) => b.dataset.awMode === "items").getAttribute("aria-pressed"), "true",
  "关掉开关后要退回「奖项项目」");

/* ── 6. 静态接线：视图注册 / 入口 / 共用登录与正文缓存 ── */
const source = fs.readFileSync(new URL("../public/plugins/cppu-notify/main.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.match(source, /import\("\/plugins\/cppu-notify\/award-list\.js"\)/);
assert.match(source, /registerView\(\{ id: "cppu-award", title: "警大获奖名单", icon: "trophy", render: mountAwardView \}\)/);
assert.match(source, /\{ view: "cppu-award", label: "获奖名单", icon: "trophy" \}/);
assert.match(source, /data-award>获奖名单<\/button>/);
assert.match(source, /navigate\("plug:cppu-award"\)/);
assert.match(source, /async function fetchNoticeContent\(rid\)/);
assert.match(source, /const got = await fetchNoticeContent\(rid\)/);        // 通知视图改走同一取数函数
assert.match(source, /titleLooksAward\(titleOf\(it\)\)/);
assert.match(source, /mod\.parseAwardNotice\(\{ rid: itemKey\(it\), title: titleOf\(it\)/);
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
const module = fs.readFileSync(new URL("../public/plugins/cppu-notify/award-list.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
assert.match(module, /\.aw-shell\{display:grid;grid-template-rows:0fr;opacity:0;transition:grid-template-rows/);
assert.match(module, /\.aw-item\.open \.aw-shell\{grid-template-rows:1fr;opacity:1\}/);
assert.match(module, /\.aw-clip\{min-height:0;overflow:hidden\}/);
assert.match(module, /@media\(prefers-reduced-motion:reduce\)\{\.aw-arrow,\.aw-shell,\.aw-row\{transition-duration:\.01ms!important\}\}/);
assert.match(module, /role="status" aria-live="polite"/);
assert.match(module, /data-aw-source/);
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

console.log("PASS: 获奖名单解析（标题清洗/级别层级/名单行/团体成员）· 个人团体排名并列 · 人名榜（团体成员计入本人）与名次配色 · 时间正倒序 · 下拉展开收起 · 来源回跳 · 偏好落盘 · 单选走宿主滑动选中光 · 设置开关接线 · 视图接线");
