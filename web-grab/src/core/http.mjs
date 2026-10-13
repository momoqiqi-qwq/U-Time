/**
 * 抓取内核：带超时、重试、Cookie 复用与会话头的最小 HTTP 客户端。
 * 只用 Node 原生 fetch（Node >= 20），不引入任何第三方依赖。
 */

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** origin -> "name=value; name2=value2" */
const cookieJar = new Map();

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function absorbCookies(res, url) {
  const origin = new URL(url).origin;
  const setCookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  if (!setCookies.length) return;
  const jar = new Map(
    (cookieJar.get(origin) || '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const i = pair.indexOf('=');
        return [pair.slice(0, i), pair.slice(i + 1)];
      })
  );
  for (const raw of setCookies) {
    const first = String(raw).split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
  }
  cookieJar.set(
    origin,
    [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  );
}

/**
 * 发一个请求。失败（网络错误 / 5xx / 429）按 retries 重试，指数退避。
 * @param {string} url
 * @param {RequestInit & {timeoutMs?: number, retries?: number, label?: string}} [opts]
 * @returns {Promise<{status:number, ok:boolean, headers:Headers, text:string, json:any, url:string}>}
 */
export async function request(url, opts = {}) {
  const {
    timeoutMs = 30000,
    retries = 2,
    label = '',
    ...init
  } = opts;

  const headers = new Headers(init.headers || {});
  if (!headers.has('User-Agent')) headers.set('User-Agent', DEFAULT_UA);
  if (!headers.has('Accept-Language')) headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8');
  const jar = cookieJar.get(new URL(url).origin);
  if (jar && !headers.has('Cookie')) headers.set('Cookie', jar);

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        ...init,
        headers,
        redirect: init.redirect || 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      absorbCookies(res, url);
      const text = await res.text();
      if (!res.ok && res.status >= 500 && attempt < retries) {
        lastError = new Error(`HTTP ${res.status}`);
        await sleep(400 * Math.pow(2, attempt));
        continue;
      }
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, ok: res.ok, headers: res.headers, text, json, url };
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(400 * Math.pow(2, attempt));
        continue;
      }
    }
  }
  const hint = label ? `（${label}）` : '';
  throw new Error(`请求失败${hint} ${url}: ${lastError && lastError.message}`);
}

/** POST JSON，返回解析后的对象；非 2xx 抛错。 */
export async function postJson(url, body = {}, opts = {}) {
  const { headers = {}, ...rest } = opts;
  const res = await request(url, {
    ...rest,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json ?? JSON.parse(res.text);
}

/** 拉文本（HTML / JS bundle）。limitBytes 用于避免把巨型 bundle 全读进内存。 */
export async function getText(url, opts = {}) {
  const res = await request(url, { ...opts, headers: { Accept: '*/*', ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  const limit = opts.limitBytes || 0;
  return limit > 0 ? res.text.slice(0, limit) : res.text;
}

export function clearCookies() {
  cookieJar.clear();
}
