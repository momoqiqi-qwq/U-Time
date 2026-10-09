// 搜索打分：中文标题 / 关键词的**拼音首字母缩写**匹配。
//
// 为什么单开一个模块：设置页左栏搜索与全局命令面板（Ctrl+K）必须同一套口径 ——
// 两处各写一份「先标题、再拼音、最后关键词」的打分，改一处必然飘一处。
//
// 为什么按「词段」而不是整串（v0.172.0 改）：
//   旧写法把 `title + " " + keywords` 拼成一整串再 `includes`，于是「zt」会命中
//   「顶部任务统计居中」（首字母串 dbrwtjjz 里恰好有 zt）、「界面缩放」（关键词
//   「整体缩放」→ ztsf）、「记住密码」（关键词「本机保存」→ bjbcjm 里有 bj）……
//   用户真正要找的「字体模式 / 文字大小」反被挤到第八位。
//   缩写匹配只认**词的开头**才符合直觉：字体 → zt（全等）、字体着色 → ztzs（前缀）。
//
// 分层（分数从高到低，都是「越大越靠前」）：
//   1000 标题全等 → 800 标题前缀 → 780/740 标题词段缩写全等/前缀
//   → 700 标题整串缩写前缀 → 640 关键词词段缩写全等 → 600 标题包含
//   → 350 副标题包含 → 250 关键词包含 → -1 不匹配
// 标题类一律压过关键词类：用户在界面上看到的是标题，命中的也应该是它。
import { pinyinInitialsOf } from "./pinyinInitial.js";

export const normalizeSearchText = (text) => String(text ?? "").trim().replace(/\s+/g, " ").toLowerCase();

// 词段分隔：空白与中英标点（括号、斜杠、破折号都算边界）。
// 「通知叠成一张（鼠标悬停展开）」切成「通知叠成一张」「鼠标悬停展开」两段，
// 于是缩写 zt 只匹配前一段、sbxtzk 只匹配后一段，不会互相串味。
const SEGMENT_SPLIT = /[\s\u3000·・,，.。、;；:：!！?？/\\|()（）\[\]【】{}<>《》""''‘’“”+＋&＆_~～^*#@$%—–\-]+/;

/** 把一段文本切成词段（空白 / 标点分隔，已去掉空段）。 */
export function searchSegments(text) {
  return String(text ?? "").split(SEGMENT_SPLIT).filter(Boolean);
}

/** 一段文本里每个词段的拼音首字母缩写，去重后返回。 */
export function abbreviationSegments(text) {
  const out = new Set();
  for (const segment of searchSegments(text)) {
    const abbr = pinyinInitialsOf(segment);
    if (abbr) out.add(abbr);
  }
  return [...out];
}

const SCORE = {
  TITLE_EXACT: 1000,
  TITLE_PREFIX: 800,
  TITLE_ABBR_EXACT: 780,
  TITLE_ABBR_PREFIX: 740,
  TITLE_FULL_ABBR_PREFIX: 700,
  KEYWORD_ABBR_EXACT: 640,
  TITLE_CONTAINS: 600,
  SUB_CONTAINS: 350,
  KEYWORD_CONTAINS: 250,
};

/**
 * 单个条目对查询词打分；返回负数表示不匹配。
 * entry = { title, sub?, keywords? }，字段缺省都当空串处理。
 */
export function scoreSearchEntry(entry, query) {
  const q = normalizeSearchText(query);
  if (!q) return 0;
  const title = normalizeSearchText(entry.title);
  const sub = normalizeSearchText(entry.sub);
  const keys = normalizeSearchText(entry.keywords);
  if (title && title === q) return SCORE.TITLE_EXACT;
  if (title && title.startsWith(q)) return SCORE.TITLE_PREFIX;
  // 标题的词段缩写：只认「词的开头」，不认长串中间偶然出现的字母组合。
  const titleAbbrs = abbreviationSegments(entry.title);
  if (titleAbbrs.includes(q)) return SCORE.TITLE_ABBR_EXACT;
  if (titleAbbrs.some((abbr) => abbr.startsWith(q))) return SCORE.TITLE_ABBR_PREFIX;
  // 标题整体缩写（跨词段连打，如「完整备份 / 恢复」→ wzbfh）
  if (pinyinInitialsOf(entry.title).startsWith(q)) return SCORE.TITLE_FULL_ABBR_PREFIX;
  // 关键词只收**词段全等**：关键词是一长串同义词，允许前缀匹配的话
  // 「整体缩放 → ztsf」这类会到处误命中，「zt」就再也搜不准了。
  if (abbreviationSegments(entry.keywords).includes(q)) return SCORE.KEYWORD_ABBR_EXACT;
  if (title && title.includes(q)) return SCORE.TITLE_CONTAINS;
  if (sub && sub.includes(q)) return SCORE.SUB_CONTAINS;
  if (keys && keys.includes(q)) return SCORE.KEYWORD_CONTAINS;
  return -1;
}

/** 只要「匹配 / 不匹配」时用这个（分类筛选那种不需要排序的场景）。 */
export function matchesSearchEntry(entry, query) {
  return scoreSearchEntry(entry, query) >= 0;
}
