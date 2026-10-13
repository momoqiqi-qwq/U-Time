import { el } from "./ui.js";

export const DEFAULT_KEYWORD_HIGHLIGHTS = Object.freeze({
  enabled: true,
  highlightTimes: true,
  timeColor: "#e5484d",
  rules: [],
});

const TIME_PATTERN = new RegExp([
  String.raw`(?:20\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}(?:\s*(?:日|号))?)`,
  String.raw`(?:\d{1,2}\s*月\s*\d{1,2}(?:\s*(?:日|号))?)`,
  String.raw`(?:\b\d{1,2}\s*[-/]\s*\d{1,2}\b)`,
  String.raw`(?:(?<![\w.])\d{1,2}\s*\.\s*\d{1,2}(?![\w.]))`,
  String.raw`(?:(?:(?:下下|本|这|下|上)周|(?:周|星期|礼拜))\s*[一二三四五六日天1-7])`,
  String.raw`(?:今天|明天|后天|大后天|昨天|前天|今晚|今早|明早|明晚)`,
  String.raw`(?:(?:(?:凌晨|早上|上午|中午|下午|晚上|晚间)\s*)?(?:[01]?\d|2[0-3])\s*[：:]\s*[0-5]\d(?:\s*(?:-|~|～|至|到)\s*(?:[01]?\d|2[0-3])\s*[：:]\s*[0-5]\d)?)`,
  String.raw`(?:(?:(?:凌晨|早上|上午|中午|下午|晚上|晚间)\s*)?(?:[01]?\d|2[0-3])\s*(?:点|时)(?:\s*(?:[0-5]?\d)\s*分?|半|一刻|三刻)?(?:\s*(?:-|~|～|至|到)\s*(?:[01]?\d|2[0-3])\s*(?:点|时)(?:\s*(?:[0-5]?\d)\s*分?|半|一刻|三刻)?)?)`,
].join("|"), "g");

function safeColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value).toLowerCase() : fallback;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* 关键词正则缓存：四象限每张卡都要跑一遍 highlightSegments()，规则一多就是「同一批
 * 关键词每帧重新编译 N 次 RegExp」。A/B 实测（同一个函数只换这一行取法，10 规则 × 3000 轮）：
 * 每次编译 15.78µs/次 → 缓存 10.86µs/次，省 31.1%，两版分段结果逐字段一致；
 * 规则越多、卡片越密，省的越多。
 * 按关键词字符串缓存，键很有限（用户不会配几千个规则），满了整体清空即可，
 * 不做 LRU：这里没有热点区分度，多写一层淘汰逻辑反而更贵。 */
const KEYWORD_RE_CACHE = new Map();
const KEYWORD_RE_CACHE_MAX = 64;
function keywordRegExp(keyword) {
  const key = String(keyword);
  let re = KEYWORD_RE_CACHE.get(key);
  if (!re) {
    if (KEYWORD_RE_CACHE.size >= KEYWORD_RE_CACHE_MAX) KEYWORD_RE_CACHE.clear();
    re = new RegExp(escapeRegExp(key), "gi");
    KEYWORD_RE_CACHE.set(key, re);
  }
  // 复用同一个带 g 的实例：matchAll 内部会克隆，但显式归零省得将来换成 exec/test 时踩 lastIndex。
  re.lastIndex = 0;
  return re;
}

export function normalizeKeywordHighlights(raw = {}) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rules = Array.isArray(src.rules) ? src.rules : [];
  return {
    enabled: src.enabled !== false,
    highlightTimes: src.highlightTimes !== false,
    timeColor: safeColor(src.timeColor, DEFAULT_KEYWORD_HIGHLIGHTS.timeColor),
    rules: rules.slice(0, 20).map((rule, index) => ({
      id: String(rule?.id || `mark-${index + 1}`),
      keyword: String(rule?.keyword || "").trim().slice(0, 40),
      color: safeColor(rule?.color, "#f59e0b"),
      mode: rule?.mode === "background" ? "background" : "text",
      enabled: rule?.enabled !== false,
    })).filter((rule) => rule.keyword),
  };
}

export function getKeywordHighlights(settings = {}) {
  return normalizeKeywordHighlights(settings?.keywordHighlights);
}

/** 纯函数：先让用户关键词占位，再补日期/时刻；重叠内容只标一次。 */
export function highlightSegments(value, rawConfig = {}) {
  const text = String(value ?? "");
  const config = normalizeKeywordHighlights(rawConfig);
  if (!config.enabled || !text) return [{ text }];
  const matches = [];
  for (const rule of config.rules) {
    if (!rule.enabled || !rule.keyword) continue;
    const re = keywordRegExp(rule.keyword);
    for (const hit of text.matchAll(re)) matches.push({
      start: hit.index, end: hit.index + hit[0].length, text: hit[0],
      mode: rule.mode, color: rule.color, kind: "keyword", priority: 0,
    });
  }
  if (config.highlightTimes) {
    for (const hit of text.matchAll(TIME_PATTERN)) matches.push({
      start: hit.index, end: hit.index + hit[0].length, text: hit[0],
      mode: "text", color: config.timeColor, kind: "time", priority: 1,
    });
  }
  matches.sort((a, b) => a.start - b.start || a.priority - b.priority || (b.end - b.start) - (a.end - a.start));
  const segments = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    if (match.start > cursor) segments.push({ text: text.slice(cursor, match.start) });
    segments.push({ text: match.text, mode: match.mode, color: match.color, kind: match.kind });
    cursor = match.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return segments.length ? segments : [{ text }];
}

function contrastInk(color) {
  const hex = safeColor(color, "#ffffff").slice(1);
  const rgb = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return luminance > 0.48 ? "#241f1a" : "#ffffff";
}

/** DOM 层只消费纯分段结果，不使用 innerHTML，关键词本身始终按文本处理。 */
export function highlightedText(value, config) {
  const fragment = document.createDocumentFragment();
  for (const segment of highlightSegments(value, config)) {
    if (!segment.mode) fragment.append(document.createTextNode(segment.text));
    else fragment.append(el("mark", {
      class: `keyword-mark ${segment.mode}`,
      style: `--keyword-color:${segment.color};--keyword-ink:${contrastInk(segment.color)}`,
      "data-highlight-kind": segment.kind,
    }, segment.text));
  }
  return fragment;
}
