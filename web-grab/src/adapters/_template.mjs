/**
 * 新站点适配器模板（复制成 <id>.mjs 后改四处：id / match / 接口常量 / 归一化）。
 *
 * 用法：
 *   1) node src/cli.mjs probe https://目标站/某个抓不到的页面
 *      → 它会列出候选接口、接口域、以及可直接 curl 的一条命令
 *   2) 用 curl 确认哪个是列表接口、字段长什么样、要不要带 token
 *   3) 复制本文件 → src/adapters/<id>.mjs，填下面的 TODO 区
 *   4) 在 src/adapters/index.mjs 的 ADAPTERS 里加一行
 *   5) node src/cli.mjs fetch <那个页面地址> --all --format json --out out/<id>.json 验收
 */

import { postJson } from '../core/http.mjs';

const API_ORIGIN = 'https://api.example.com'; // TODO 换成真实接口域
const SITE_ORIGIN = 'https://www.example.com'; // TODO 页面域（Origin/Referer 常被后端校验）

const H = {
  Origin: SITE_ORIGIN,
  Referer: `${SITE_ORIGIN}/`,
  // 需要登录态的接口：Authorization 从环境变量取，绝不硬编码
  ...(process.env.GRAB_TOKEN ? { Authorization: process.env.GRAB_TOKEN } : {}),
};

function toRecord(row) {
  // TODO 把接口字段翻译成统一记录：id/title/status/时间/链接…… 参考 mojinghub.mjs
  return {
    kind: 'items',
    id: row.id,
    title: row.title || '',
    status: '',
    signupStart: null,
    signupEnd: null,
    runStart: null,
    runEnd: null,
    pageUrl: '',
  };
}

export default {
  id: 'example',
  label: '示例站点',

  match(url) {
    try {
      return /(^|\.)example\.com$/i.test(new URL(url).hostname);
    } catch {
      return false;
    }
  },

  resolve() {
    return { kind: 'items' };
  },

  kinds: ['items'],

  async list(kind, params = {}) {
    const { page = 1, limit = 20, ...filters } = params;
    // TODO 换成真实接口路径与参数名；GET 的话改用 core/http.mjs 的 getText
    const json = await postJson(
      `${API_ORIGIN}/api/Item/Item/index`,
      { page, limit, ...filters },
      { headers: H, label: '示例列表' }
    );
    const data = json.data || {};
    return {
      kind,
      total: data.total ?? 0,
      page: data.current_page ?? page,
      limit: data.per_page ?? limit,
      lastPage: data.last_page ?? 1,
      rows: (data.list || data.data || []).map(toRecord),
      raw: data.list || data.data || [],
      request: { url: `${API_ORIGIN}/api/Item/Item/index`, body: { page, limit, ...filters } },
    };
  },

  async all(kind, params = {}) {
    const limit = Math.min(Number(params.limit) || 100, 100);
    const rows = [];
    let page = 1;
    let lastPage = 1;
    let total = 0;
    let raw = [];
    do {
      const res = await this.list(kind, { ...params, page, limit });
      rows.push(...res.rows);
      raw = raw.concat(res.raw);
      total = res.total;
      lastPage = res.lastPage;
      page += 1;
      if (page <= lastPage) await new Promise((r) => setTimeout(r, 300));
    } while (page <= lastPage && page <= 50);
    return { kind, total, rows, raw, pages: lastPage };
  },

  async detail(kind, id) {
    const json = await postJson(
      `${API_ORIGIN}/api/Item/Item/detail`,
      { id: Number(id) },
      { headers: H }
    );
    return toRecord(json.data || {});
  },
};
