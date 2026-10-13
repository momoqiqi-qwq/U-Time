/**
 * 适配器注册表 —— 这就是「可插拔」的那一层。
 *
 * 新增一个站点 = 新增一个 src/adapters/<id>.mjs，实现下面的契约，然后在
 * ADAPTERS 数组里追加一行。CLI / 渲染层 / 油猴插件都不用改。
 *
 * 适配器契约（都要求实现 match/resolve/list/detail）：
 *   id: string
 *   label: string
 *   match(url: string): boolean             // 这个适配器管不管这个 URL
 *   resolve(url, explicitKind?): {kind}     // URL → 列表类型
 *   kinds: string[]                         // 支持的列表类型
 *   list(kind, params): Promise<{total,page,limit,lastPage,rows,raw,request}>
 *   all?(kind, params): Promise<{total,rows,raw,pages}>
 *   detail(kind, id): Promise<object>
 *   catalog?(kind): Promise<object>
 */

import mojinghub from './mojinghub.mjs';

export const ADAPTERS = [mojinghub];

export function listAdapters() {
  return ADAPTERS.map((a) => ({ id: a.id, label: a.label, kinds: a.kinds || [] }));
}

export function matchAdapter(url) {
  return ADAPTERS.find((a) => {
    try {
      return a.match(url);
    } catch {
      return false;
    }
  }) || null;
}

export function requireAdapter(url) {
  const adapter = matchAdapter(url);
  if (adapter) return adapter;
  const err = new Error(
    `没有匹配的适配器：${url}\n` +
      `已装适配器：${ADAPTERS.map((a) => a.id).join(', ') || '(无)'}\n` +
      `先跑 \`node src/cli.mjs probe ${url}\` 拿接口候选，再照 src/adapters/_template.mjs 补一个适配器。`
  );
  err.code = 'NO_ADAPTER';
  return err;
}
