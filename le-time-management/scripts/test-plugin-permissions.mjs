// 插件 manifest 声明的权限，必须覆盖它真正调用的 tide API。
//
// 背景：宿主 src/pluginHost.js 的 requirePermission 是**抛错**，不是静默降级。
// 插件一旦调用 manifest 没声明的能力，那次调用就抛异常 —— 而插件普遍把「报错」
// 也交给 tide.notify，于是错误提示自己又抛一次，**动作与提示一起消失**，
// 界面看着像按钮坏了。school-notice v1.3.0 的「登录配置」就是这么失效的：
// manifest 少了 notify，而 submitLogin 里 `tide.notify(...)` 正好写在
// `await refresh(false)` 前一行 —— 登录成功后永远读不到公告，界面上毫无变化。
//
// 这个测试按 API 路径反查所需权限，扫 public/plugins/*/main.js 与 manifest 对账。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginsDir = path.join(root, 'public', 'plugins');

/* ── 权限表从宿主源码里取，避免两处各写一份 ── */
const hostSrc = fs.readFileSync(path.join(root, 'src', 'pluginHost.js'), 'utf8');
const labelsBlock = hostSrc.match(/export const PLUGIN_PERMISSION_LABELS = \{([\s\S]*?)\n\};/);
assert.ok(labelsBlock, '没能从 src/pluginHost.js 抽出 PLUGIN_PERMISSION_LABELS');
const KNOWN_PERMISSIONS = new Set(
  [...labelsBlock[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]),
);
assert.ok(KNOWN_PERMISSIONS.has('notify') && KNOWN_PERMISSIONS.has('http'), '权限标签表解析结果不对');

/* ── tide.<ns> → 权限 ── */
const NS_PERMISSION = {
  storage: 'storage',
  tasks: 'tasks',
  inbox: 'tasks',
  blocks: 'blocks',
  ui: 'ui',
  assets: 'ui',
  notify: 'notify',
  sound: 'sound',
  events: 'events',
  http: 'http',
  schoolImporter: 'schoolImport',
  vault: 'vault',
  ai: 'ai',
  messages: 'messages',
};
// tide.util 要再看第二段：同一个 util 下不同函数归不同能力
const UTIL_PERMISSION = {
  openUrl: 'openUrl',
  openCampusSite: 'openUrl',
  openCardPage: 'openUrl',
  openUrlWithSession: ['openUrl', 'http'],
  parseWhen: 'timeParse',
  guessQuad: 'timeParse',
  guessCategory: 'timeParse',
  navigate: 'ui',
  desEncryptHex: 'http',
  web: 'http',
};
// 不需要权限：tide.app / tide.plugins / tide.id / tide.manifest，以及 util 里的纯函数
const NO_PERMISSION_NS = new Set(['app', 'plugins', 'id', 'manifest']);
const UTIL_FREE = new Set(['today', 'addDays', 'mmOf', 'hhmmOf', 'durLabel']);

/** 扫描源码里真正被**调用**的 tide.* API（要求后面跟左括号，避免把注释/文档字符串算进来）。 */
function tideCalls(source) {
  const calls = new Set();
  for (const m of source.matchAll(/\btide\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?\s*\(/g)) {
    calls.add(m[2] ? `${m[1]}.${m[2]}` : m[1]);
  }
  return calls;
}

function requiredPermissions(calls, pluginId) {
  const need = new Set();
  for (const call of calls) {
    const [ns, second] = call.split('.');
    if (NO_PERMISSION_NS.has(ns)) continue;
    if (ns === 'util') {
      if (UTIL_FREE.has(second)) continue;
      const perm = UTIL_PERMISSION[second];
      assert.ok(perm, `${pluginId}: tide.util.${second}() 不在权限映射表里 —— 新增 API 时请同步本测试`);
      for (const required of Array.isArray(perm) ? perm : [perm]) need.add(required);
      continue;
    }
    const perm = NS_PERMISSION[ns];
    assert.ok(perm, `${pluginId}: tide.${ns}.* 不在权限映射表里 —— 新增命名空间时请同步本测试`);
    need.add(perm);
  }
  return need;
}

const plugins = fs.readdirSync(pluginsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((id) => fs.existsSync(path.join(pluginsDir, id, 'manifest.json')))
  .sort();
assert.ok(plugins.length >= 10, `内置插件数量异常：${plugins.length}`);

const missing = [];
let checked = 0;
for (const id of plugins) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginsDir, id, 'manifest.json'), 'utf8'));
  const declared = new Set(manifest.permissions || []);

  for (const perm of declared) {
    assert.ok(KNOWN_PERMISSIONS.has(perm), `${id}: manifest 声明了未知权限「${perm}」`);
  }

  const entry = path.join(pluginsDir, id, manifest.entry || 'main.js');
  if (!fs.existsSync(entry)) continue;
  const need = requiredPermissions(tideCalls(fs.readFileSync(entry, 'utf8')), id);
  checked += 1;

  const lack = [...need].filter((p) => !declared.has(p)).sort();
  if (lack.length) missing.push(`${id}（v${manifest.version}）缺少：${lack.join('、')}`);
}

assert.deepEqual(
  missing, [],
  '以下插件的 manifest 权限没覆盖它调用的 tide API，运行时会抛错并静默吞掉动作：\n  '
  + missing.join('\n  ')
  + '\n  修法：把这些权限补进 public/plugins/<id>/manifest.json 的 permissions 并升插件版本。',
);

/* ── 定点回归：school-notice 的登录链路必须能发通知 ── */
const snManifest = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'school-notice', 'manifest.json'), 'utf8'));
assert.ok(snManifest.permissions.includes('notify'), 'school-notice 必须声明 notify：登录成功/失败全靠它反馈');
const snSrc = fs.readFileSync(path.join(pluginsDir, 'school-notice', 'main.js'), 'utf8');
const notifyLines = snSrc.split('\n').filter((l) => /(?<![.\w])tide\.notify\s*\(/.test(l));
assert.ok(notifyLines.length > 0, 'school-notice 的 toast() 包装丢了：提示仍必须能发出去');
assert.deepEqual(
  notifyLines.filter((l) => !l.includes('const toast =')), [],
  'school-notice 只允许在 toast() 包装里直接调用 tide.notify，其余一律走 toast()（否则权限异常会连动作一起吞掉）',
);

console.log(`PASS: 插件权限声明一致（检查 ${checked} 个插件，共 ${plugins.length} 个）`);
