// 警大门户通知 · 获奖名单附件：名单经常不在正文里，而是挂在 .docx / .xlsx / .pdf 附件上。
//
// 两条硬口径（都是使用者的要求，不是实现细节）：
//   1. **只读该读的附件** —— 附件名像名单，或正文里明确写着「名单见附件」，才去下载解析。
//      其余附件（报名表、日程、考场安排…）连请求都不发。
//   2. **扫过就不再扫** —— 解析成功的附件在宿主的 awardAffixScanned 里留一个标记；
//      附件文本只在本次同步的内存里存在，导出名单后即弃（不留附件缓存），
//      落盘的只有抽出来的名单本身。
//
// 本文件只做「字节 → 可送进 parseAwardNotice 的文本行」这一段，纯函数 + 两个 Web 标准 API
// （DecompressionStream 解 zip/deflate，TextDecoder 解码），不碰网络、不碰宿主 state，可单测。

/* ── 该不该读这个附件 ── */
// 附件名信号：出现「名单 / 获奖 / 表彰」这类词才算，且要排除报名表、日程表这类同名字段的干扰。
const AFFIX_NAME_HIT = /获奖|获评|荣获|表彰|嘉奖|受奖|评奖|奖项|奖励|荣誉|名单|名次/;
const AFFIX_NAME_MISS = /报名|申报|申请|承诺|授权|委托|合同|协议|方案|日程|议程|考场|座位|课表|课程表|模板|样表|空白|登记表|签到|问卷|统计表|预算|经费/;
// 「真名单」的强信号：出现它就不管别的词。只收「一看就是名册」的说法 ——
// 「获奖学生」「获奖者」这类词会出现在申报表/推荐表的名字里，不能算强信号，
// 否则「获奖学生申报表」会被当成名单去下载。
const AFFIX_NAME_STRONG = /获奖名单|获奖情况|获奖结果|受表彰|表彰名单|名单汇总|获奖汇总|荣誉册/;
const AFFIX_BAD_EXT = /\.(?:zip|rar|7z|tar|gz|jpe?g|png|gif|bmp|webp|mp4|mp3|wav|avi|exe|apk)$/i;

export function affixNameSignal(name = "") {
  const t = String(name || "").trim();
  if (!t || AFFIX_BAD_EXT.test(t)) return false;
  if (!AFFIX_NAME_HIT.test(t)) return false;
  if (AFFIX_NAME_MISS.test(t) && !AFFIX_NAME_STRONG.test(t)) return false;
  return true;
}

// 正文信号：句子级判断 —— 同一句里既提到「附件」又提到「名单」，才算「通告里说了名单在附件」。
// 只按词共现会误伤（「具体安排详见附件」不含名单词，本来也不会命中）。
export function saysListInAffix(text = "") {
  const t = String(text || "").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ");
  if (!t.includes("附件")) return false;
  for (const raw of t.split(/[。；;！!？?\n\r]/)) {
    const line = raw.trim();
    if (!line.includes("附件")) continue;
    if (/名单|名册|获奖|表彰|受奖|奖项|获奖人员|获奖学生|获奖集体/.test(line)) return true;
  }
  return false;
}

// 下载之前先过这两关：附件名像名单，或正文说了名单在附件。
export function looksLikeAwardAttachment(name, noticeText = "") {
  return affixNameSignal(name) || saysListInAffix(noticeText);
}

/* ── 字节工具 ── */
export function base64ToBytes(base64) {
  const s = String(base64 || "").replace(/\s+/g, "");
  const bin = typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}
const toBytes = (v) => {
  if (v == null) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(v)) return new Uint8Array(v);
  return base64ToBytes(String(v));
};
const latin1 = (bytes) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return s;
};
export function cjkCount(text = "") {
  const m = String(text).match(/[\u4e00-\u9fa5]/g);
  return m ? m.length : 0;
}
// 二进制被当文本解出来是一串控制字符 / 替换字符。这种宁可当没读到 ——
// 乱码送进名单解析会凭空造出人名（比读不到更糟）。
export function looksTextual(text = "") {
  const t = String(text || "").slice(0, 4000);
  if (!t.trim()) return false;
  const bad = (t.match(/[\uFFFD\u0000-\u0008\u000b-\u001f]/g) || []).length;
  return bad <= Math.max(2, Math.floor(t.length / 100));
}
export function detectKind(name = "", bytes = new Uint8Array(0)) {
  const ext = (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  const b = bytes;
  const magic = b.length >= 4 ? `${b[0]},${b[1]},${b[2]},${b[3]}` : "";
  if (magic === "80,75,3,4" || magic === "80,75,5,6") return "zip";           // PK…（docx/xlsx/pptx）
  if (magic === "37,80,68,70") return "pdf";                                  // %PDF
  if (magic === "208,207,17,224") return /^xls/i.test(ext) || !ext ? "xls-ole" : "doc-ole"; // D0CF11E0
  if (/^xlsx?$/i.test(ext)) return "xls-ole";
  if (/^docx?$/i.test(ext)) return "doc-ole";
  if (/^(?:txt|csv|htm|html|xml|json|md|rtf)$/i.test(ext)) return "text";
  if (!ext) return "unknown";      // 魔数认不出、又没有扩展名：不当文本硬解
  return "text";
}

/* ── 文本解码：UTF-8 优先，坏字节多就退 GBK ── */
export function decodeBytes(bytes, hint = "") {
  try { return new TextDecoder(hint || "utf-8").decode(bytes); } catch { /* 走下面的兜底 */ }
  return latin1(bytes);
}
export function decodeSmart(bytes) {
  const utf8 = decodeBytes(bytes, "utf-8");
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (!bad) return utf8.replace(/^\uFEFF/, "");
  if (bad >= Math.max(4, Math.floor(utf8.length / 200))) {
    try { return decodeBytes(bytes, "gbk"); } catch { /* 没有 gbk 表就退回 utf-8 */ }
  }
  return utf8.replace(/\uFEFF/g, "");
}

/* ── zip（docx / xlsx 都是 zip）── */
async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== "function") throw new Error("当前环境不支持解压");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function unzip(bytes) {
  const u8 = toBytes(bytes);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是 zip 结构");
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const out = new Map();
  for (let i = 0; i < count && off + 46 <= u8.length; i++) {
    if (view.getUint32(off, true) !== 0x02014b50) break;
    const method = view.getUint16(off + 10, true);
    const csize = view.getUint32(off + 20, true);
    const usize = view.getUint32(off + 24, true);
    const nlen = view.getUint16(off + 28, true);
    const elen = view.getUint16(off + 30, true);
    const clen = view.getUint16(off + 32, true);
    const lho = view.getUint32(off + 42, true);
    const name = decodeBytes(u8.subarray(off + 46, off + 46 + nlen));
    off += 46 + nlen + elen + clen;
    if (/\/$/.test(name) || lho + 30 > u8.length) continue;
    if (view.getUint32(lho, true) !== 0x04034b50) continue;
    const ln = view.getUint16(lho + 26, true), le = view.getUint16(lho + 28, true);
    const start = lho + 30 + ln + le;
    const data = u8.subarray(start, start + (csize || usize));
    try { out.set(name, method === 0 ? data : await inflateRaw(data)); } catch { /* 单条坏不影响其它条目 */ }
  }
  return out;
}

/* ── XML → 行 ── */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function unescapeEntities(s = "") {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, g) => {
    if (g[0] === "#") {
      const code = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENT[g.toLowerCase()] ?? m;
  });
}
// 段内结构：单元格 → \t，行/段 → \n；标签全剥。
// 表格的换行/制表符顺序有讲究（`</w:p></w:tc>` 会连出「换行 + 制表符」）：
//   ① 先把「换行 + 制表符」并成一个制表符 —— 同一个单元格里的段落换行不该把一行表格拆成两行；
//   ② 再去掉行尾制表符（`</w:tc></w:tr>` 留下的）—— 相邻两行不能粘成一行。
// 反过来做就会把整张表压成一行。
export function xmlToLines(xml = "") {
  // 容错：直接丢字节进来也能读（String(bytes) 会退化成「60,63,120,…」这种假文本，很难发现）
  const source = typeof xml === "string" ? xml : decodeBytes(xml);
  return unescapeEntities(String(source)
    .replace(/<w:tab\b[^>]*\/?>/gi, "\t")
    .replace(/<\/w:tc>/gi, "\t")
    .replace(/<\/w:tr>|<\/w:p>|<w:br\b[^>]*\/?>/gi, "\n")
    .replace(/\n[ \t]*\t/g, "\t")
    .replace(/[ \t]*\t[ \t]*\n/g, "\n")
    .replace(/<[^>]+>/g, ""));
}

/* ── 表格 → 通知文本 ── */
// 列名 → 语义。名单表的列名就那么几种，认得出的按语义读，认不出的列才走松判。
export function colRole(header = "") {
  const t = String(header || "").replace(/[\s\u3000]+/g, "").replace(/[（(].*?[）)]/g, "");
  if (!t || t.length > 12) return "";
  if (/^(?:序号|编号|序|no\.?|#|排名号|名次号)$/i.test(t)) return "skip";
  if (/学号|工号|教工号|身份证|证件|手机|电话|邮箱|备注|说明|日期|时间|地点|校区|学院|学部|系|专业|年级|班级|区队|大队|中队|辅导员|联系|签[名字]|盖章|地址|邮编|卡号|账号|指导老师名单/.test(t)) return "skip";
  if (/指导|领队|教练|带队/.test(t)) return "mentor";
  if (/队名|代表队|参赛队|团队|团体|集体|获奖单位|单位名称|获奖部门/.test(t)) return "team";
  if (/姓名|名单|人员|学生|选手|作者|获奖者|获奖人|成员|队员|个人|获得者|名字|同学/.test(t)) return "name";
  if (/奖项|等级|级别|奖次|等次|名次|获奖情况|获奖等级|奖项名称|奖别/.test(t)) return "level";
  if (/项目|作品|题目|课题|成果|内容|赛事|竞赛|大赛|比赛|活动|科目|名称/.test(t)) return "skip";
  return "";
}
const LEVELISH = /特等奖|一等奖|二等奖|三等奖|优秀奖|优胜奖|金奖|银奖|铜奖|冠军|亚军|季军|入围奖|单项奖|第[一二三1-3]名/;
// 表头词：名单表的列名长得太像人名（「姓名」是 2 个汉字，形状上和「张三」没区别），
// 单独列出来，既用于「这一行是表头」的判断，也用来拦住「把列名当成人名」这个误判。
const HEADER_CELL = /^(?:序号|编号|序|姓名|名单|名册|人员|学生|学员|选手|作者|获奖者|获奖人|获奖人员|获奖学生|获得者|成员|队员|名字|同学|学号|工号|教工号|身份证|证件|院系|学院|学部|专业|年级|班级|区队|大队|中队|支队|奖项|奖项名称|等级|级别|奖次|等次|奖别|名次|项目|作品|题目|课题|成果|赛事|竞赛|大赛|比赛|活动|科目|名称|单位|获奖单位|部门|队名|代表队|参赛队|团队|团体|集体|小组|指导教师|指导老师|领队|教练|带队|辅导员|备注|说明|日期|时间|地点|校区|电话|手机|邮箱|排名|签[名字]|盖章)$/;
const NOT_PERSON = /^(?:学院|大学|学校|大队|中队|支队|班级|专业|年级|系|部|处|室|中心|委员会|办公室|教研室|实验室|协会|社团|小组|团队|团体|队伍|代表队|名单|名册|通知|公告|公示|教师|老师|同学|学生|学员|干部|教官|单位|集体|个人|优秀|先进|组织|工作|活动|竞赛|大赛|比赛|项目|成果|论文|作品|奖项|奖励|荣誉|表彰|决定|附件|相关|全体|下列|以上|其中|荣获|获得|斩获|共计|合计|人数|名次|获奖人员|获奖学生|获奖者|指导教师|领队|姓名|学号|工号|教工号|序号|编号|等级|级别|奖次|等次|队名|成员|队员|名字|选手|作者|获得者|备注|日期|时间|地点|电话|手机|邮箱)$/;
const ORG_TAIL = /(?:代表队|团队|团体|小组|队伍|支队|大队|中队|学院|学部|班级|团支部|党支部|社团|协会|教研室|实验室|中心|委员会|队|组)$/;
const NOT_SUBJECT_TAIL = /(?:比赛|竞赛|大赛|项目|作品|活动|论坛|会议|讲座|训练|演习|方案|计划|安排)$/;
// 下面三条与 award-list.js 的 NOT_NAME_FONT / NOT_NAME_ORG / ORG_TAIL 是同一套口径，
// 改一处必须改另一处（test-cppu-award-attach.mjs 里有一致性断言守着）。
// 起因：.doc（OLE）只能按 UTF-16LE 粗扫，字体表与样式表会跟正文一起被扫出来 ——
// 「等线」「仿宋」「宋体」是字体，「无列表」是 Word 样式，「教务处」是落款，它们全是纯汉字短串。
const NOT_NAME_FONT = /^(?:等线|仿宋|宋体|黑体|楷体|行书|隶书|草书|幼圆|魏碑|雅黑|微软雅黑|苹方|华文|方正|标宋|小标宋|书宋|新宋|思源|汉仪|冬青|无列表|无间隔|列表段落|项目符号|正文|标题|副标题|小标题|题注|页眉|页脚|目录|摘要|附录|参考文献|致谢|超链接|批注|脚注|尾注|空白|未命名|新建|模板|网格|页码|缩进|居中|加粗|斜体|下划线|字号|行距|段落|编号|样式|字体)$/;
const NOT_NAME_ORG = /^(?:团委|党委|工会|教务|学工|后勤|财务|保卫|宣传|组织|人事|科研|办公|机关|教工|教务员|学生会)$/;
const ORG_TAIL_CHAR = /[处务科所站馆局厅委办署司厂社部室系院校队组班级]$/;

export function looksLikePersonCell(v = "") {
  const t = String(v || "").trim();
  if (!/^[\u4e00-\u9fa5]{2,4}$/.test(t)) return false;
  if (NOT_PERSON.test(t) || LEVELISH.test(t) || NOT_NAME_FONT.test(t) || NOT_NAME_ORG.test(t)) return false;
  if (t.length > 2 && /[学院校系室部中心队伍组队班级年级]/.test(t)) return false;
  if (t.length > 2 && ORG_TAIL_CHAR.test(t)) return false;
  return true;
}
export function looksLikeTeamCell(v = "") {
  const t = String(v || "").trim();
  if (t.length < 4 || t.length > 30) return false;
  if (NOT_SUBJECT_TAIL.test(t)) return false;
  return ORG_TAIL.test(t);
}
// 一个单元格里的多个名字：去掉序号前缀，统一用「、」连起来交给 award-list.js 的名单读取器。
export function normalizeNameCell(v = "") {
  return String(v || "")
    .split(/[\s\u3000、，,;；/\\|]+/)
    .map((s) => s.replace(/^\d{1,3}\s*[.、）)．]?\s*/, "").replace(/[（(]\s*[）)]/g, "").trim())
    .filter((s) => s && !/^\d+$/.test(s))
    .join("、");
}
function pushLoose(lines, cell) {
  const v = String(cell || "").trim();
  if (!v || v.length > 60) return;
  if (HEADER_CELL.test(v)) return;                        // 列名不是人，也没有奖级
  if (/^[\d\s.、)#-]+$/.test(v)) return;
  if (/[0-9a-zA-Z@]/.test(v)) return;                     // 学号 / 邮箱 / 编号行不是名字
  if (LEVELISH.test(v) && v.length <= 12) { lines.push(v); return; }
  const names = normalizeNameCell(v);
  const parts = names.split("、").filter(Boolean);
  if (parts.length && parts.every(looksLikePersonCell)) { lines.push(`获奖人员：${names}`); return; }
  if (parts.length === 1 && looksLikeTeamCell(v)) lines.push(`获奖单位：${v}`);
}
export function rowsToNoticeText(rows = []) {
  const lines = [];
  let roles = null;
  for (const raw of Array.isArray(rows) ? rows : []) {
    const cells = (Array.isArray(raw) ? raw : [raw]).map((c) => String(c ?? "").trim());
    if (!cells.some(Boolean)) continue;
    const asHeader = cells.map(colRole);
    const hits = asHeader.filter(Boolean).length;
    // 表头行：至少两个认得出的列名，且这一行里没有人名（否则它是数据行，只是列名恰好写成了人名）
    if (hits >= 2 && !cells.some(looksLikePersonCell)) { roles = asHeader; continue; }
    if (roles) {
      cells.forEach((cell, i) => {
        if (!cell) return;
        const role = roles[i] || "";
        if (role === "skip") return;
        if (role === "name") { const v = normalizeNameCell(cell); if (v) lines.push(`获奖人员：${v}`); return; }
        if (role === "mentor") { const v = normalizeNameCell(cell); if (v) lines.push(`指导教师：${v}`); return; }
        if (role === "team") { lines.push(`获奖单位：${cell}`); return; }
        if (role === "level") { lines.push(cell); return; }
        pushLoose(lines, cell);
      });
      continue;
    }
    cells.forEach((cell) => pushLoose(lines, cell));
  }
  return lines.join("\n");
}
// docx 的正文：段落各占一行，连续的「带 \t 的行」凑成一张表按表格读。
export function docxToNoticeText(value = "") {
  const out = [];
  let block = [];
  const flush = () => { if (block.length) { const t = rowsToNoticeText(block); if (t) out.push(t); block = []; } };
  for (const raw of xmlToLines(value).split("\n")) {
    const line = raw.replace(/[\u00a0\u2002\u2003\u3000]/g, " ").replace(/[ ]+/g, " ").trim();
    if (!line) { flush(); continue; }
    if (line.includes("\t")) { block.push(line.split("\t").map((s) => s.trim())); continue; }
    flush();
    out.push(line);
  }
  flush();
  return out.join("\n");
}

/* ── HTML 附件：块级标签换成换行/制表符后走同一套表格识别 ── */
export function htmlToNoticeText(html = "") {
  const t = String(html || "")
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, " ")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<br\b[^>]*>|<\/tr>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return docxToNoticeText(unescapeEntities(t));
}

/* ── CSV（宿主 tide.assets.spreadsheetText 的输出）→ 行 ── */
export function parseCsv(text = "") {
  const rows = [];
  let row = [], cell = "", quoted = false;
  const s = String(text || "").replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false; }
      else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === "," || ch === ";") { row.push(cell); cell = ""; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* ── PDF：只能尽力而为（取流里的 Tj / TJ 字符串）── */
async function tryInflate(bytes) {
  for (const fmt of ["deflate-raw", "deflate"]) {
    try {
      if (typeof DecompressionStream !== "function") return null;
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(fmt));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch { /* 换下一种 */ }
  }
  return null;
}
function unescapePdf(s = "") {
  return String(s).replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, g) => {
    if (/^[0-7]+$/.test(g)) return String.fromCharCode(parseInt(g, 8));
    return { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[g] ?? g;
  });
}
function hexToText(hex = "") {
  const clean = String(hex).replace(/[^0-9a-f]/gi, "");
  if (clean.length < 4) return "";
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  const utf16 = decodeBytes(bytes, "utf-16be");
  if (cjkCount(utf16) >= Math.max(2, bytes.length / 8)) return utf16;
  const latin = decodeBytes(bytes, "utf-8");
  return cjkCount(latin) >= 2 ? latin : "";
}
export function extractPdfStrings(s = "") {
  const out = [];
  const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]{4,}>/g;
  let m;
  while ((m = re.exec(s))) {
    const tok = m[0];
    const after = s.slice(m.index + tok.length, m.index + tok.length + 10);
    if (!/^\s*(?:Tj|TJ|'|")/.test(after) && !/^\s*\]\s*TJ/.test(after)) continue;
    const txt = tok[0] === "(" ? unescapePdf(tok.slice(1, -1)) : hexToText(tok.slice(1, -1));
    if (txt) out.push(txt);
  }
  return out.join("");
}
export async function pdfToNoticeText(bytes) {
  const u8 = toBytes(bytes);
  const latin = latin1(u8);
  const pieces = [];
  const direct = extractPdfStrings(latin);
  if (direct) pieces.push(direct);
  for (const m of latin.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) continue;
    // 流尾通常还留着 endstream 前的换行 —— 现代解压器会判「压缩流结束后有多余数据」
    // 而整段失败，所以先把结尾的 EOL 削掉再解。
    let tail = end;
    while (tail > start && (u8[tail - 1] === 0x0a || u8[tail - 1] === 0x0d)) tail -= 1;
    const raw = u8.subarray(start, tail);
    const inflated = raw[0] === 0x78 ? await tryInflate(raw) : null;
    if (!inflated) continue;
    const t = extractPdfStrings(latin1(inflated));
    if (t) pieces.push(t);
    if (pieces.join("").length > 60000) break;
  }
  const text = pieces.join("\n").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  // 中文 PDF 常把字打成子集字体的 CID：解出来是乱码。认不出「获奖 / 名单」这类词就当作没读到，
  // 宁可不读，也不要把乱码送进名单解析。
  if (!/获奖|名单|姓名|特等奖|一等奖|二等奖|三等奖|优秀奖|名次|表彰/.test(text)) return "";
  return cjkCount(text) >= 8 ? text : "";
}

/* ── .doc（OLE 复合文档）：粗扫 UTF-16LE 中文串 ── */
export function oleToNoticeText(bytes) {
  const u8 = toBytes(bytes);
  const text = decodeBytes(u8, "utf-16le").replace(/[\u0000-\u0008\u000b-\u001f]/g, "\n");
  const lines = text.split("\n").map((s) => s.trim()).filter((s) => cjkCount(s) >= 2 && s.length <= 60);
  const joined = [...new Set(lines)].join("\n");
  if (!/获奖|名单|姓名|一等奖|二等奖|三等奖|优秀奖|特等奖|表彰/.test(joined)) return "";
  return cjkCount(joined) >= 8 ? joined : "";
}
// Word 97 的正文与二进制混排：给出「像名单的行」就够解析器用。
export function oleRowsToNoticeText(bytes) {
  return rowsToNoticeText(oleToNoticeText(bytes).split("\n").map((s) => [s]));
}

/* ── 总入口：附件字节 → 可解析文本 ── */
// helpers.spreadsheetText(file) 由 main.js 传进来（宿主 xlsx 库，见 src/spreadsheet.js）——
// 插件自己不去实现 xlsx 解析，复用它才和「导入课表」那条链路读到同样的东西。
export async function attachmentToNoticeText({ name = "", bytes = null, base64 = "", mime = "", spreadsheetText = null } = {}) {
  const u8 = bytes ? toBytes(bytes) : base64ToBytes(base64);
  if (!u8.length) return { text: "", kind: "empty", reason: "空文件" };
  const kind = detectKind(name, u8);
  const limit = (t) => String(t || "").slice(0, 200000);
  try {
    if (kind === "zip") {
      const zip = await unzip(u8);
      const docXml = zip.get("word/document.xml");
      if (docXml) return { text: limit(docxToNoticeText(decodeBytes(docXml))), kind: "docx", reason: "" };
      const sheet = [...zip.keys()].find((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k));
      if (sheet && typeof spreadsheetText === "function") {
        const csv = await spreadsheetText(new File([u8], name || "book.xlsx"));
        return { text: limit(rowsToNoticeText(parseCsv(csv))), kind: "xlsx", reason: "" };
      }
      if (sheet) {
        // 没拿到宿主 xlsx 库时的退路：自己把 sharedStrings + 首表读成「一格一行」，
        // 走列名识别之外的松判 —— 姓名列照样读得出来，只是丢掉了「列」的语义。
        const shared = zip.get("xl/sharedStrings.xml");
        const strings = shared ? (unescapeEntities(decodeBytes(shared)).match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((s) => s.replace(/<[^>]+>/g, "")) : [];
        const cells = unescapeEntities(decodeBytes(zip.get(sheet))).match(/<c\b[^>]*>[\s\S]*?<\/c>/g) || [];
        const loose = cells.map((c) => {
          const isShared = /t="s"/.test(c);
          const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1] ?? "";
          const inline = (c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] ?? "";
          return [isShared ? strings[Number(v)] ?? "" : unescapeEntities(inline || v)];
        });
        return { text: limit(rowsToNoticeText(loose)), kind: "xlsx", reason: "" };
      }
      const ppt = [...zip.keys()].find((k) => /^ppt\/slides\/slide\d+\.xml$/i.test(k));
      if (ppt) return { text: limit(docxToNoticeText(decodeBytes(zip.get(ppt)))), kind: "pptx", reason: "" };
      return { text: "", kind: "zip", reason: "压缩包里没有可读的文档" };
    }
    if (kind === "pdf") return { text: limit(await pdfToNoticeText(u8)), kind: "pdf", reason: "" };
    if (kind === "doc-ole") return { text: limit(oleRowsToNoticeText(u8)), kind: "doc", reason: "" };
    if (kind === "xls-ole" && typeof spreadsheetText === "function") {
      const csv = await spreadsheetText(new File([u8], name || "book.xls"));
      return { text: limit(rowsToNoticeText(parseCsv(csv))), kind: "xls", reason: "" };
    }
    if (kind === "xls-ole") return { text: limit(oleRowsToNoticeText(u8)), kind: "xls", reason: "" };
    if (kind === "unknown") return { text: "", kind, reason: "认不出文件类型" };
    const text = decodeSmart(u8);
    if (!looksTextual(text)) return { text: "", kind, reason: "不是文本文件（当二进制处理）" };
    if (/<\/?[a-z][\s\S]*>/i.test(text.slice(0, 4000))) {
      return { text: limit(htmlToNoticeText(text)), kind: "html", reason: "" };
    }
    return { text: limit(text), kind: "text", reason: "" };
  } catch (e) {
    return { text: "", kind, reason: String(e?.message || e) };
  }
}
