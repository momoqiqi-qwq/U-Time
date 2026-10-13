/**
 * 渲染层：一份归一化记录 → json / csv / md / ics / 终端表格。
 * 和适配器解耦，所以任何适配器抓到的数据都能出这五种格式。
 */

const pad = (n) => String(n).padStart(2, '0');

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function mdCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function icsEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545：每行不超过 75 个八位组，续行以空格开头。 */
function foldIcsLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let current = '';
  let currentBytes = 0;
  let limit = 75;
  for (const char of line) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (currentBytes + charBytes > limit) {
      out.push(current);
      current = ' ';
      currentBytes = 1;
      limit = 75;
    }
    current += char;
    currentBytes += charBytes;
  }
  out.push(current);
  return out.join('\r\n');
}

/**
 * 日历时间戳。
 * tz='local' 输出**浮动本地时间**（不带 Z），固定按东八区取字段。
 *   这是给「时间管理软件 / 国产日历」用的：它们把无时区的时间当本地时间处理，
 *   带 Z 反而会被算成 UTC，导进去差 8 小时。
 * tz='utc' 输出标准 UTC（带 Z），给 Google / Apple Calendar 这类会做时区换算的客户端。
 */
const CAL_TZ = 'Asia/Shanghai';

const zoneFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: CAL_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function zonedParts(d) {
  const parts = {};
  for (const { type, value } of zoneFmt.formatToParts(d)) parts[type] = value;
  // en-CA 下 hour 可能是 "24"（午夜），归一到 00
  if (parts.hour === '24') parts.hour = '00';
  return parts;
}

function icsStamp(d, tz = 'local') {
  if (tz === 'utc') {
    return (
      `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
      `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
    );
  }
  const p = zonedParts(d);
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}

/** 东八区的某一天 00:00 / 23:59:59，用 UTC 时间戳表示。 */
function dayBoundsUtc(ts) {
  const p = zonedParts(new Date(ts));
  const dayKey = `${p.year}-${p.month}-${p.day}`;
  const start = Date.parse(`${dayKey}T00:00:00+08:00`);
  return { dayKey, start, end: start + 24 * 3600 * 1000 - 1000 };
}

export function renderJson(rows, { pretty = true } = {}) {
  return JSON.stringify(rows, null, pretty ? 2 : 0);
}

export function renderTable(rows, columns) {
  if (!rows.length) return '（无数据）';
  const cols = columns || [
    ['id', 'ID'],
    ['title', '标题'],
    ['category', '类别'],
    ['level', '级别'],
    ['feeType', '费用'],
    ['status', '状态'],
    ['signupEndCn', '报名截止'],
  ];
  const widths = cols.map(([key, label]) =>
    Math.max(
      label.length * 2,
      ...rows.map((r) => String(r[key] ?? '').length)
    )
  );
  const line = (cells) =>
    cells.map((c, i) => String(c ?? '').padEnd(widths[i], ' ')).join('  ');
  const sep = widths.map((w) => '─'.repeat(w)).join('──');
  return [
    line(cols.map(([, label]) => label)),
    sep,
    ...rows.map((r) => line(cols.map(([key]) => r[key]))),
  ].join('\n');
}

export function renderMarkdown(rows, { title = '抓取结果', source = '' } = {}) {
  if (!rows.length) return `# ${title}\n\n（无数据）\n`;
  const cols = [
    ['id', 'ID'],
    ['title', '名称'],
    ['category', '类别'],
    ['level', '级别'],
    ['method', '方式'],
    ['feeType', '费用'],
    ['status', '状态'],
    ['signupStartCn', '报名开始'],
    ['signupEndCn', '报名截止'],
    ['runStartCn', '比赛开始'],
    ['runEndCn', '比赛结束'],
    ['pageUrl', '详情页'],
  ];
  const head = `| ${cols.map(([, l]) => l).join(' | ')} |`;
  const sep = `| ${cols.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${cols.map(([k]) => mdCell(r[k])).join(' | ')} |`);
  const lines = [`# ${title}`, ''];
  if (source) lines.push(`- 来源：${source}`);
  lines.push(`- 条数：${rows.length}`, `- 导出时间：${new Date().toISOString()}`, '', head, sep, ...body, '');
  return lines.join('\n');
}

export function renderCsv(rows) {
  const cols = [
    ['id', 'ID'],
    ['kind', '类型'],
    ['title', '名称'],
    ['subtitle', '简称'],
    ['category', '类别'],
    ['level', '级别'],
    ['method', '参赛方式'],
    ['organizer', '主办单位'],
    ['publisher', '发布方'],
    ['feeType', '费用类型'],
    ['feeAmount', '费用金额'],
    ['status', '状态'],
    ['stageLabel', '站点阶段码文案'],
    ['statusCode', '站点阶段码'],
    ['signupStartCn', '报名开始'],
    ['signupEndCn', '报名截止'],
    ['runStartCn', '比赛开始'],
    ['runEndCn', '比赛结束'],
    ['isHot', '热门'],
    ['isRecommended', '推荐'],
    ['signupMode', '报名方式'],
    ['externalSignupUrl', '外部报名地址'],
    ['pageUrl', '详情页'],
    ['updatedAt', '数据更新时间'],
  ];
  const head = cols.map(([, l]) => csvCell(l)).join(',');
  const body = rows.map((r) => cols.map(([k]) => csvCell(r[k])).join(','));
  return '\uFEFF' + [head, ...body].join('\r\n') + '\r\n';
}

/**
 * 导出日历。竞赛天然是「有开始有结束的日程」，可以直接导进时间管理软件。
 *
 * @param {object[]} rows
 * @param {{
 *   window?: 'run'|'signup'|'both',
 *   calendarName?: string,
 *   includeUrl?: boolean,
 *   alarmMinutes?: number,
 *   tz?: 'local'|'utc',
 *   days?: 'first'|'all',
 * }} [opts]
 *  - tz   : local(默认，浮动东八区时间，给时间管理软件/国产日历) | utc(带 Z，给 Google/Apple)
 *  - days : first(默认，跨天窗口只出开始那天) | all(跨天窗口按天各出一条，适合"比赛期间每天提醒")
 */
export function renderIcs(rows, opts = {}) {
  const {
    window: win = 'run',
    calendarName = '抓取日历',
    includeUrl = true,
    alarmMinutes = 0,
    tz = 'local',
    days = 'first',
  } = opts;

  const stamp = icsStamp(new Date(), tz);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//web-grab//adapter export//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(calendarName)}`,
  ];

  const addEvent = (row, uidSuffix, start, endTime, prefix) => {
    if (!start) return;
    const end = endTime && endTime > start ? endTime : new Date(start.getTime() + 3600 * 1000);
    const alarmLines =
      alarmMinutes > 0
        ? [
            'BEGIN:VALARM',
            'ACTION:DISPLAY',
            `DESCRIPTION:${icsEscape(row.title)}`,
            `TRIGGER:-PT${alarmMinutes}M`,
            'END:VALARM',
          ]
        : [];
    lines.push(
      'BEGIN:VEVENT',
      `UID:${icsEscape(`grab-${row.kind}-${row.id}-${uidSuffix}@mojinghub.web-grab`)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsStamp(start, tz)}`,
      `DTEND:${icsStamp(end, tz)}`,
      `SUMMARY:${icsEscape(`${prefix}${row.title}${row.category ? `（${row.category}）` : ''}`)}`,
      `DESCRIPTION:${icsEscape(
        [
          row.organizer && `主办：${row.organizer}`,
          row.level && `级别：${row.level}`,
          row.method && `方式：${row.method}`,
          `费用：${row.feeType}${row.feeAmount ? ` ${row.feeAmount}` : ''}`,
          `状态：${row.status}`,
          includeUrl && row.pageUrl ? `详情：${row.pageUrl}` : '',
          includeUrl && row.externalSignupUrl ? `报名：${row.externalSignupUrl}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      )}`,
      `STATUS:${row.status === '已结束' ? 'CANCELLED' : 'CONFIRMED'}`,
      includeUrl && row.pageUrl ? `URL:${row.pageUrl}` : '',
      row.category ? `CATEGORIES:${icsEscape(row.category)}` : '',
      ...alarmLines,
      'END:VEVENT'
    );
  };

  /**
   * 时间窗 → 事件。
   * days='first'：整段窗口一条（客户端自己按开始时间落格）
   * days='all'  ：
   *   - 窗口 ≤ 21 天（如 5 天的比赛期）→ 按天各出一条，比赛期间每天都能看到
   *   - 窗口 > 21 天（如 3 个月的报名期）→ **不铺满日历**，只在窗口末尾出一条「截止」事件，
   *     因为这种长窗口真正要记的是截止那一刻
   */
  const SPLIT_MAX_DAYS = 21;

  const addWindow = (row, uidBase, start, endTime, prefix) => {
    if (!start) return;
    const end = endTime && endTime > start ? endTime : new Date(start.getTime() + 3600 * 1000);
    const spanDays = (end - start) / (24 * 3600 * 1000);

    if (days !== 'all' || spanDays < 1) {
      addEvent(row, uidBase, start, end, prefix);
      return;
    }
    if (spanDays > SPLIT_MAX_DAYS) {
      addEvent(
        row,
        `${uidBase}-deadline`,
        new Date(end.getTime() - 3600 * 1000),
        end,
        `${prefix}（截止）`
      );
      return;
    }
    let cursor = start.getTime();
    let count = 0;
    while (cursor <= end.getTime() && count < SPLIT_MAX_DAYS + 1) {
      const { dayKey, start: dayStart, end: dayEnd } = dayBoundsUtc(cursor);
      const s = new Date(Math.max(dayStart, start.getTime()));
      const e = new Date(Math.min(dayEnd, end.getTime()));
      addEvent(row, `${uidBase}-${dayKey.replace(/-/g, '')}`, s, e, prefix);
      cursor = dayEnd + 1000;
      count += 1;
    }
  };

  for (const row of rows) {
    if (win === 'run' || win === 'both') {
      addWindow(
        row,
        'run',
        row.runStart ? new Date(row.runStart) : null,
        row.runEnd ? new Date(row.runEnd) : null,
        ''
      );
    }
    if (win === 'signup' || win === 'both') {
      addWindow(
        row,
        'signup',
        row.signupStart ? new Date(row.signupStart) : null,
        row.signupEnd ? new Date(row.signupEnd) : null,
        '[报名] '
      );
    }
  }

  lines.push('END:VCALENDAR');
  return lines.filter((l) => l !== '').map(foldIcsLine).join('\r\n') + '\r\n';
}

export const FORMATS = ['json', 'csv', 'md', 'ics', 'table'];

/** 按扩展名猜格式（--out 时用）。 */
export function formatFromPath(file) {
  const m = String(file || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return null;
  const ext = m[1];
  if (ext === 'json') return 'json';
  if (ext === 'csv') return 'csv';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'ics' || ext === 'ical') return 'ics';
  if (ext === 'txt') return 'table';
  return null;
}

export function render(rows, format, opts = {}) {
  switch (format) {
    case 'json':
      return renderJson(rows);
    case 'csv':
      return renderCsv(rows);
    case 'md':
      return renderMarkdown(rows, opts);
    case 'ics':
      return renderIcs(rows, opts);
    case 'table':
    default:
      return renderTable(rows);
  }
}
