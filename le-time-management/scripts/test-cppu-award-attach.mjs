// 获奖名单附件：从「该不该读这个附件」到「附件字节怎么变成名单文本」。
// 字节是自己造的（zlib 压出真的 zip 流、真的 PDF 流、真的 UTF-16LE 的 .doc），
// 不联网、不碰宿主 —— 这条链路的所有分支都能在这里跑一遍。
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import {
  affixNameSignal, saysListInAffix, looksLikeAwardAttachment,
  base64ToBytes, cjkCount, detectKind, decodeSmart,
  unzip, xmlToLines, colRole, rowsToNoticeText, docxToNoticeText, parseCsv, normalizeNameCell,
  extractPdfStrings, pdfToNoticeText, oleToNoticeText, attachmentToNoticeText, looksLikePersonCell,
} from "../public/plugins/cppu-notify/award-attach.js";
import { parseAwardNotice, isPersonName } from "../public/plugins/cppu-notify/award-list.js";

/* ── 1. 该不该读这个附件：两条口径各自成立，都不成立才不读 ── */
assert.equal(affixNameSignal("获奖名单.docx"), true);
assert.equal(affixNameSignal("第九届精武杯获奖情况汇总.xlsx"), true);
assert.equal(affixNameSignal("受表彰人员名单.pdf"), true);
assert.equal(affixNameSignal("2026年表彰决定.doc"), true);
assert.equal(affixNameSignal("报名表.xlsx"), false, "报名表不是名单");
assert.equal(affixNameSignal("会议日程安排.docx"), false);
assert.equal(affixNameSignal("获奖学生申报表.docx"), false, "带获奖词但其实是申报表：MISS 词要压过 HIT 词");
assert.equal(affixNameSignal("考试考场座位表.xlsx"), false);
assert.equal(affixNameSignal("获奖名单.zip"), false, "压缩包不解（自己解 zip 会踩加密/分卷）");
assert.equal(affixNameSignal(""), false);

assert.equal(saysListInAffix("具体获奖名单详见附件。"), true);
assert.equal(saysListInAffix("获奖名单见附件1，请自行下载查看"), true);
assert.equal(saysListInAffix("各代表队获奖人员名单附后。"), false, "「名单附后」= 名单就在正文里，不需要去读附件");
assert.equal(saysListInAffix("具体安排详见附件。"), false, "只说附件、没说名单：不算");
assert.equal(saysListInAffix("附件名单另行公布"), true, "「附件名单」这种倒装说法也要认");
assert.equal(saysListInAffix("详见附件2。获奖情况另行通知。"), false, "两句话不能拼在一起算（名单不在附件句里）");
assert.equal(saysListInAffix("<p>获奖名单见附件</p><p>报名表见附件</p>"), true, "HTML 正文要先剥标签再按句切");

assert.equal(looksLikeAwardAttachment("获奖名单.docx", "无关正文"), true, "只看附件名也能触发");
assert.equal(looksLikeAwardAttachment("附件1.docx", "具体获奖名单详见附件1"), true, "正文说名单在附件也触发");
assert.equal(looksLikeAwardAttachment("附件1.docx", "具体安排详见附件1"), false);
assert.equal(looksLikeAwardAttachment("正文.pdf", ""), false);

/* ── 2. 认文件类型：魔数优先，扩展名兜底 ── */
const pk = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
assert.equal(detectKind("获奖名单.docx", pk), "zip");
assert.equal(detectKind("获奖名单.xlsx", pk), "zip");
assert.equal(detectKind("名单.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])), "pdf");
const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
assert.equal(detectKind("名单.doc", ole), "doc-ole");
assert.equal(detectKind("名单.xls", ole), "xls-ole");
assert.equal(detectKind("名单.txt", new TextEncoder().encode("获奖名单：张三")), "text");
assert.equal(detectKind("名单", new Uint8Array([1, 2, 3, 4])), "unknown");
assert.equal(detectKind("名单.htm", new TextEncoder().encode("<p>获奖名单</p>")), "text");

/* ── 3. 造一个真 zip（docx 就是 zip）── */
function zipBytes(entries) {
  const chunks = [], dir = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    const raw = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 14);                                  // crc：unzip 只走目录，不校验
    local.writeUInt32LE(raw.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, raw);
    dir.push({ nameBuf, raw, size: data.length, offset });
    offset += local.length + nameBuf.length + raw.length;
  }
  const dirStart = offset;
  for (const e of dir) {
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0, 8); head.writeUInt16LE(8, 10);
    head.writeUInt32LE(0, 16);
    head.writeUInt32LE(e.raw.length, 20); head.writeUInt32LE(e.size, 24);
    head.writeUInt16LE(e.nameBuf.length, 28);
    head.writeUInt32LE(e.offset, 42);
    chunks.push(head, e.nameBuf);
    offset += head.length + e.nameBuf.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(dir.length, 8); eocd.writeUInt16LE(dir.length, 10);
  eocd.writeUInt32LE(offset - dirStart, 12); eocd.writeUInt32LE(dirStart, 16);
  chunks.push(eocd);
  return new Uint8Array(Buffer.concat(chunks));
}

// 一张真表格：列序 姓名 / 学号 / 奖项，两行数据（学号必须被丢掉，它是「不是名字」的典型）
const row = (cells) => `<w:tr>${cells.map((c) => `<w:tc><w:p><w:r><w:t>${c}</w:t></w:r></w:p></w:tc>`).join("")}</w:tr>`;
const docxBytes = zipBytes([
  ["[Content_Types].xml", "<Types/>"],
  ["word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>关于公布第九届「精武杯」获奖名单的通知</w:t></w:r></w:p>
<w:tbl>${row(["姓名", "学号", "奖项"])}${row(["张三", "20230001", "一等奖"])}${row(["李四", "20230002", "二等奖"])}</w:tbl>
<w:p><w:r><w:t>特此通知。</w:t></w:r></w:p>
</w:body></w:document>`],
]);

/* ── 4. zip 解出条目 → 表格还原成「一行一格」的文本 ── */
const zip = await unzip(docxBytes);
assert.ok(zip.get("word/document.xml"), "能从 zip 里拿到 document.xml");
const bodyText = xmlToLines(zip.get("word/document.xml"));
assert.match(bodyText, /姓名\t学号\t奖项/, "同一行的单元格要用制表符连起来，不能因为单元格里的段落换行被拆成三行");
assert.equal((bodyText.match(/\t\n/g) || []).length, 0, "行尾制表符要清掉（否则两行会粘成一行）");
assert.equal(bodyText.split("\n").filter((l) => l.includes("张三")).length, 1);

assert.equal(colRole("姓名"), "name");
assert.equal(colRole("学号"), "skip");
assert.equal(colRole("奖项级别"), "level");
assert.equal(colRole("队名"), "team");
assert.equal(colRole("指导教师"), "mentor");
assert.equal(colRole("序号"), "skip");
assert.equal(colRole("（盖章）"), "");
assert.equal(colRole("项目名称"), "skip", "项目列不是名字列");

const tableText = rowsToNoticeText([["姓名", "学号", "奖项"], ["张三", "20230001", "一等奖"], ["李四", "20230002", "二等奖"]]);
assert.match(tableText, /获奖人员：张三/);
assert.match(tableText, /获奖人员：李四/);
assert.match(tableText, /一等奖/);
assert.doesNotMatch(tableText, /20230001/, "学号不许当成人名");
assert.doesNotMatch(tableText, /姓名/, "列名不许当成人名");

const docText = docxToNoticeText(zip.get("word/document.xml"));
assert.match(docText, /关于公布第九届「精武杯」获奖名单的通知/, "正常段落要保留");
assert.match(docText, /获奖人员：张三/);
assert.doesNotMatch(docText, /学号/);

/* ── 5. 总入口：docx 字节 → 可送进名单解析的文本 ── */
const got = await attachmentToNoticeText({ name: "获奖名单.docx", bytes: docxBytes });
assert.equal(got.kind, "docx");
assert.match(got.text, /获奖人员：张三/);
assert.doesNotMatch(got.text, /姓名/, "列名不进正文");
const rec = parseAwardNotice({ rid: "1", title: "关于公布第九届「精武杯」获奖名单的通知", text: got.text, date: Date.UTC(2026, 9, 13) });
assert.ok(rec, "附件文本要能直接过获奖名单解析");
assert.deepEqual(rec.people.slice().sort(), ["张三", "李四"]);
assert.equal(rec.level, "一等奖");

// base64 走同一条路（宿主 tide.http.fetch(binary) 给的就是 base64）
const viaBase64 = await attachmentToNoticeText({ name: "获奖名单.docx", base64: Buffer.from(docxBytes).toString("base64") });
assert.deepEqual(viaBase64.text, got.text);
assert.deepEqual(Array.from(base64ToBytes("5LiA")), [0xe4, 0xb8, 0x80]);

/* ── 6. xlsx：有宿主 xlsx 库就用它（和导入课表同一条链路），没有也有退路 ── */
const xlsxBytes = zipBytes([
  ["xl/sharedStrings.xml", `<sst>${["姓名", "张三", "奖项", "一等奖"].map((t) => `<si><t>${t}</t></si>`).join("")}</sst>`],
  ["xl/worksheets/sheet1.xml", `<worksheet><sheetData><row r="1"><c t="s"><v>0</v></c></row><row r="2"><c t="s"><v>1</v></c></row><row r="3"><c t="s"><v>2</v></c></row><row r="4"><c t="s"><v>3</v></c></row></sheetData></worksheet>`],
]);
let calledFile = null;
const withLib = await attachmentToNoticeText({
  name: "获奖名单.xlsx", bytes: xlsxBytes,
  spreadsheetText: async (file) => { calledFile = file; return "姓名,张三,奖项\n,,一等奖\n"; },
});
assert.equal(withLib.kind, "xlsx");
assert.equal(calledFile?.name, "获奖名单.xlsx", "要把原文件交给宿主的 xlsx 库");
assert.match(withLib.text, /获奖人员：张三/);
assert.match(withLib.text, /一等奖/);
const withoutLib = await attachmentToNoticeText({ name: "获奖名单.xlsx", bytes: xlsxBytes });
assert.match(withoutLib.text, /获奖人员：张三/, "没有宿主库时退路也要读得出姓名");
assert.doesNotMatch(withoutLib.text, /姓名/);

assert.deepEqual(parseCsv('姓名,奖项\n"张,三",一等奖\n'), [["姓名", "奖项"], ["张,三", "一等奖"]]);
assert.deepEqual(parseCsv("a;b\nc;d"), [["a", "b"], ["c", "d"]]);
assert.equal(normalizeNameCell("1. 张三、李四"), "张三、李四");
assert.equal(normalizeNameCell("王五"), "王五");
assert.equal(rowsToNoticeText([["获奖单位"], ["星火代表队"]]), "获奖单位：星火代表队");
assert.equal(rowsToNoticeText([["张三"], ["20230001"]]), "获奖人员：张三", "没有表头时也要靠松判读出人名");

/* ── 7. PDF：解压内容流 + 十六进制（UTF-16BE）文本 ── */
const pdfLine = "获奖名单：张三 一等奖 李四 二等奖";
const pdfHex = Buffer.from(pdfLine, "utf16le").swap16().toString("hex");
assert.match(extractPdfStrings(`BT /F1 12 Tf (张三) Tj (李四) Tj ET`), /张三李四/);
assert.match(extractPdfStrings(`BT <${pdfHex}> Tj ET`), /获奖名单：张三/, "十六进制串要按 UTF-16BE 解");
assert.equal(extractPdfStrings("BT /F1 12 Tf 1 0 0 1 10 10 Tm ET"), "", "没有文本操作符的括号不当文本");
const streamText = `BT /F1 12 Tf <${pdfHex}> Tj ET`;
const pdfRaw = Buffer.concat([
  Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n"),
  Buffer.from(`2 0 obj<</Filter/FlateDecode>>stream\n`),
  zlib.deflateSync(Buffer.from(streamText, "latin1")),
  Buffer.from("\nendstream\nendobj\ntrailer<</Root 1 0 R>>\n%%EOF"),
]);
const pdfText = await pdfToNoticeText(new Uint8Array(pdfRaw));
assert.match(pdfText, /获奖名单：张三/);
assert.match(pdfText, /李四/, "压缩流里的文本也要读到");
// 认不出「获奖 / 名单」的 PDF 当作没读到：宁可不读，也不把乱码送进名单解析
assert.equal(await pdfToNoticeText(new Uint8Array(Buffer.from("%PDF-1.4\nBT (\xff\xfe\x00\x01) Tj ET\n%%EOF", "latin1"))), "");

/* ── 8. .doc（OLE）：粗扫 UTF-16LE 中文串 ── */
const docText2 = oleToNoticeText(new Uint8Array(Buffer.from("获奖名单 姓名 张三 一等奖 李四 二等奖 特此通知", "utf16le")));
assert.match(docText2, /张三/);
assert.match(docText2, /一等奖/);
assert.equal(oleToNoticeText(new Uint8Array(Buffer.from("这是一份普通的课程安排", "utf16le"))), "",
  "没有获奖字样就当没读到，不硬凑");

/* ── 9. 解码与边界 ── */
assert.equal(decodeSmart(new TextEncoder().encode("获奖名单：张三")), "获奖名单：张三");
assert.ok(typeof decodeSmart(new Uint8Array([0xff, 0xfe, 0x41, 0x42, 0x43])) === "string", "坏字节不抛错");
assert.equal(cjkCount("获奖名单abc"), 4);
assert.equal((await attachmentToNoticeText({ name: "获奖名单.docx", base64: "" })).kind, "empty");
const unknown = await attachmentToNoticeText({ name: "名单.bin", bytes: new Uint8Array([1, 2, 3, 4]) });
assert.deepEqual([unknown.text, unknown.kind], ["", "text"], "解出来是乱码就不当正文（否则会凭空造出人名）");
const noExt = await attachmentToNoticeText({ name: "名单", bytes: new Uint8Array([1, 2, 3, 4]) });
assert.deepEqual([noExt.text, noExt.kind], ["", "unknown"]);
const html = await attachmentToNoticeText({ name: "获奖名单.html", bytes: new TextEncoder().encode("<table><tr><td>张三</td><td>一等奖</td></tr></table>") });
assert.match(html.text, /获奖人员：张三/);
assert.equal((await attachmentToNoticeText({ name: "获奖名单.zip", bytes: zipBytes([["a.txt", "x"]]) })).reason, "压缩包里没有可读的文档");

/* ── 10. 人名判定：字体名 / Word 样式名 / 发布单位不是名字 ──
   附件是 .doc 时只能按 UTF-16LE 粗扫，字体表与样式表会跟着正文一起被扫出来；
   表格层的人名判定必须与 award-list.js 同一套口径，否则同一份名单两条路会走出两样结果
   （用户截图里的「等线 / 仿宋 / 宋体 / 无列表 / 教务处」正是从这里漏进榜单的）。 */
const NOT_NAMES = ["等线", "仿宋", "宋体", "无列表", "教务处", "团委", "科研处", "学生处"];
const REAL_NAMES = ["张三", "周子衿"];
for (const noise of NOT_NAMES) {
  assert.equal(looksLikePersonCell(noise), false, `「${noise}」不是人名`);
  assert.equal(isPersonName(noise), false, `两层口径要一致：「${noise}」`);
}
for (const name of REAL_NAMES) {
  assert.equal(looksLikePersonCell(name), true, `「${name}」是人名`);
  assert.equal(isPersonName(name), true, `两层口径要一致：「${name}」`);
}

/* ── 11. 这一层不许有副作用：下载与落盘都在 main.js，解析只做纯变换 ── */
const src = fs.readFileSync(new URL("../public/plugins/cppu-notify/award-attach.js", import.meta.url), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");   // 注释里提到宿主 API 不算
assert.doesNotMatch(code, /\btide\./, "解析层不能碰宿主 API（否则「不留附件缓存」就没法保证）");
assert.doesNotMatch(code, /\bfetch\s*\(|localStorage/);

console.log("PASS: 获奖名单附件（该不该读：附件名/正文两条口径 · 扫过的跳过 · docx 表格还原 · xlsx 走宿主库+退路 · PDF 压缩流与十六进制 · .doc 粗扫 · 列名/字体名/样式名/单位名不当人名（与 award-list 同口径）· 解析层零副作用）");
