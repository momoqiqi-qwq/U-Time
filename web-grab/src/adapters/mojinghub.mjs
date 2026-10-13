/**
 * 站点适配器：模竞 mojinghub.com
 *
 * 关键事实（2026-10-11 实测，全部可复现）：
 *   - www.mojinghub.com 是 Vite + React 纯前端渲染，HTML 只有 9 KB 骨架，
 *     任何 curl / WebFetch 只能拿到 <div id="root"> 空壳 + 骨架屏 —— 这就是「抓不到」。
 *   - 真正的数据在 https://admin.mojinghub.com 上，接口是 POST + JSON，
 *     且站点自己在 /platform-patch.js 里用 atob('aHR0cHM6Ly9hZG1pbi5tb2ppbmdodWIuY29t') 藏了这个域。
 *   - 列表 / 详情 / 分类接口全部 **免登录**，只需 Content-Type: application/json。
 *
 * 适配器把「页面」映射成「接口调用 + 归一化字段」，输出与渲染层解耦。
 */

import { postJson, getText } from '../core/http.mjs';

export const ADMIN_ORIGIN = 'https://admin.mojinghub.com';
export const SITE_ORIGIN = 'https://www.mojinghub.com';

const H = {
  Origin: SITE_ORIGIN,
  Referer: `${SITE_ORIGIN}/competitions`,
};

/**
 * stage 数字 → 文案。
 * ⚠️ 站点首屏用枚举 PREPARING / REGISTERING / PENDING / RUNNING / ENDED / CANCELLED 渲染，
 * 枚举定义被激进混淆、未在 bundle 里找到字面量，所以这里是**按实测样本 + 时间戳反推**的映射：
 *   stage=1 的样本报名未截止（应为「报名进行中」），stage=4 的样本比赛已结束（「已结束」）。
 * 因此 statusCode 只作参考，status 字段一律由时间戳现算（见 computeStatus）。
 */
const STAGE_LABELS = {
  0: '报名未开始',
  1: '报名进行中',
  2: '报名已截止',
  3: '比赛进行中',
  4: '已结束',
  5: '已取消',
};

const KINDS = {
  competitions: {
    label: '竞赛',
    indexPath: '/api/Competition.Competition/index',
    detailPath: '/api/Competition.Competition/detail',
    catePath: '/api/Competition.CompetitionCate/index',
    idField: 'competition_id',
    listPath: '/competitions',
    detailRoute: (row) =>
      `${SITE_ORIGIN}/competitions/${row.title_sub || ''}/${row.created_time || ''}`,
  },
  events: {
    label: '活动',
    indexPath: '/api/Events.Events/index',
    detailPath: '/api/Events.Events/detail',
    catePath: '/api/Events.EventsCate/index',
    idField: 'events_id',
    listPath: '/events',
    // 路由表实测（scripts/routes.mjs 从入口 bundle 扒出）：
    //   /events/:events_name/:created_time  ← 规范形态
    //   /events/:id                         ← 老链接，仍可访问，作为兜底
    detailRoute: (row) =>
      row.title_sub && row.created_time
        ? `${SITE_ORIGIN}/events/${row.title_sub}/${row.created_time}`
        : `${SITE_ORIGIN}/events/${row.events_id || ''}`,
  },
};

function ts(seconds) {
  return seconds ? new Date(Number(seconds) * 1000) : null;
}

function iso(d) {
  return d ? d.toISOString() : null;
}

/** 东八区人读时间，避免导出后被时区绕晕。 */
export function fmtCn(d) {
  if (!d) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(d)
    .replace(/\//g, '-');
}

/**
 * 用时间戳现算状态 —— 比站点那个混淆过的 stage 码可靠。
 */
export function computeStatus(row, now = new Date()) {
  const t = now.getTime();
  const ss = ts(row.signup_start)?.getTime() ?? 0;
  const se = ts(row.signup_end)?.getTime() ?? 0;
  const rs = ts(row.start_time)?.getTime() ?? 0;
  const re = ts(row.end_time)?.getTime() ?? 0;
  if (re && t > re) return '已结束';
  if (rs && t >= rs && (!re || t <= re)) return '比赛进行中';
  if (se && t > se && rs && t < rs) return '报名已截止';
  if (ss && t < ss) return '报名未开始';
  if (ss && se && t >= ss && t <= se) return '报名进行中';
  if (se && t > se) return '报名已截止';
  return '状态未知';
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseFiles(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // 有的记录是 "name|url" 的行文本
    return String(raw)
      .split(/\n+/)
      .map((line) => {
        const [name, url] = line.split('|');
        return url ? { name: name.trim(), url: url.trim() } : null;
      })
      .filter(Boolean);
  }
}

/** 列表行 → 统一记录（渲染层只认这个结构）。 */
export function toRecord(row, kind = 'competitions') {
  const cfg = KINDS[kind];
  const id = row[cfg.idField];
  const signupStart = ts(row.signup_start);
  const signupEnd = ts(row.signup_end);
  const runStart = ts(row.start_time);
  const runEnd = ts(row.end_time);
  return {
    kind,
    id,
    title: row.title || '',
    subtitle: row.title_sub || '',
    category: row.wcompetitioncate?.cate_name || row.wEventscate?.cate_name || '',
    level: row.wcompetitionlevel?.level_name || row.wEventslevel?.level_name || '',
    method: row.wcompetitionmethod?.method_name || row.wEventsmethod?.method_name || '',
    organizer: row.organizational_unit || '',
    undertaker: row.undertaker_unit || '',
    publisher: row.publisher || '',
    feeType: Number(row.fee_type) === 2 ? '收费' : '免费',
    feeAmount: row.fee_amount != null ? Number(row.fee_amount) : 0,
    statusCode: row.stage ?? null,
    stageLabel: STAGE_LABELS[row.stage] ?? '未知',
    status: computeStatus(row),
    signupStart: iso(signupStart),
    signupEnd: iso(signupEnd),
    runStart: iso(runStart),
    runEnd: iso(runEnd),
    signupStartCn: fmtCn(signupStart),
    signupEndCn: fmtCn(signupEnd),
    runStartCn: fmtCn(runStart),
    runEndCn: fmtCn(runEnd),
    isHot: Number(row.is_hot) === 1,
    isRecommended: Number(row.is_rec) === 1,
    signupMode: Number(row.signup_mode) === 1 ? '官网报名' : '站内报名',
    externalSignupUrl: row.external_signup_url || '',
    externalSignupLabel: row.external_signup_label || '',
    cover: row.cover_image
      ? /^https?:/i.test(row.cover_image)
        ? row.cover_image
        : `${ADMIN_ORIGIN}${row.cover_image}`
      : '',
    pageUrl: cfg.detailRoute(row),
    updatedAt: iso(ts(row.update_time)),
  };
}

/** 详情 → 统一记录（在列表记录上补正文、附件、队伍信息）。 */
export function toDetailRecord(data, kind = 'competitions') {
  const base = toRecord(data, kind);
  return {
    ...base,
    description: data.description || '',
    overviewText: stripHtml(data.overview || ''),
    files: parseFiles(data.file_download),
    trophyRewards: data.trophy_rewards || '',
    maxParticipants: data.max_participants ?? null,
    hasTeam: Number(data.has_team) === 1,
    pageView: data.page_view ?? null,
    followView: data.follow_view ?? null,
  };
}

export default {
  id: 'mojinghub',
  label: '模竞 - 数据科学与人工智能竞赛实践平台',

  /** 命中判断：域名 + 路径。 */
  match(url) {
    try {
      const u = new URL(url);
      return /(^|\.)mojinghub\.com$/i.test(u.hostname);
    } catch {
      return false;
    }
  },

  /** URL → 调用意图。explicitKind 用于 CLI 直接指定。 */
  resolve(url, explicitKind) {
    if (explicitKind) return { kind: explicitKind };
    try {
      const path = new URL(url).pathname;
      if (/^\/events/.test(path)) return { kind: 'events' };
      return { kind: 'competitions' };
    } catch {
      return { kind: 'competitions' };
    }
  },

  kinds: Object.keys(KINDS),

  /**
   * 列表。
   * 实测可用过滤参数：title(按标题搜) / cate_id / level_id / stage / is_hot / page / limit；
   * lite=1 保留关联对象（级别、类别、方式）但去掉正文，体积小。
   */
  async list(kind, params = {}) {
    const cfg = KINDS[kind];
    if (!cfg) throw new Error(`未知类型：${kind}（支持 ${Object.keys(KINDS).join(', ')}）`);
    const { page = 1, limit = 20, lite = 1, ...filters } = params;
    const body = { lite, page, limit };
    for (const key of ['title', 'cate_id', 'level_id', 'stage', 'is_hot', 'is_rec']) {
      if (filters[key] !== undefined && filters[key] !== '' && filters[key] !== null) {
        body[key] = key === 'is_hot' || key === 'is_rec' ? Number(filters[key]) : filters[key];
      }
    }
    const json = await postJson(`${ADMIN_ORIGIN}${cfg.indexPath}`, body, {
      headers: H,
      label: '模竞列表',
    });
    if (json.status !== 200) throw new Error(`接口返回 status=${json.status} msg=${json.msg || ''}`);
    const data = json.data || {};
    return {
      kind,
      total: data.total ?? 0,
      page: data.current_page ?? page,
      limit: data.per_page ?? limit,
      lastPage: data.last_page ?? 1,
      rows: (data.data || []).map((row) => toRecord(row, kind)),
      raw: data.data || [],
      request: { url: `${ADMIN_ORIGIN}${cfg.indexPath}`, body },
    };
  },

  /** 翻页抓全量（带上限，避免失控）。 */
  async all(kind, params = {}) {
    const limit = Math.min(Number(params.limit) || 100, 100);
    const maxPages = Number(params.maxPages) || 50;
    const collected = [];
    let page = 1;
    let total = 0;
    let lastPage = 1;
    let raw = [];
    do {
      const res = await this.list(kind, { ...params, page, limit });
      collected.push(...res.rows);
      raw.push(...res.raw);
      total = res.total;
      lastPage = res.lastPage;
      page += 1;
      if (page <= lastPage && page <= maxPages) {
        await new Promise((r) => setTimeout(r, 300));
      }
    } while (page <= lastPage && page <= maxPages);
    return { kind, total, rows: collected, raw, pages: Math.min(lastPage, maxPages) };
  },

  /** 详情（含正文、附件、奖项）。 */
  async detail(kind, id) {
    const cfg = KINDS[kind];
    if (!cfg) throw new Error(`未知类型：${kind}`);
    const json = await postJson(
      `${ADMIN_ORIGIN}${cfg.detailPath}`,
      { [cfg.idField]: Number(id) },
      { headers: H, label: '模竞详情' }
    );
    if (json.status !== 200) throw new Error(`接口返回 status=${json.status} msg=${json.msg || ''}`);
    return toDetailRecord(json.data || {}, kind);
  },

  /** 分类 / 级别 / 参赛方式 / 费用类型 —— 用来把界面上的筛选器复刻出来。 */
  async catalog(kind = 'competitions') {
    const cfg = KINDS[kind];
    const json = await postJson(`${ADMIN_ORIGIN}${cfg.catePath}`, {}, { headers: H, label: '模竞分类' });
    if (json.status !== 200) throw new Error(`接口返回 status=${json.status}`);
    return json.data || {};
  },

  /** 站点自己的「平台配置」接口（首页文案、统计数字）。 */
  async siteConfig() {
    const res = await getText(`${ADMIN_ORIGIN}/api/SiteConfig/getFullConfig`, {
      headers: { Accept: 'application/json', ...H },
    });
    return JSON.parse(res);
  },
};
