#!/usr/bin/env node
/**
 * web-grab CLI
 *
 *   node src/cli.mjs adapters
 *   node src/cli.mjs inspect <url>                 空壳诊断：这页为什么抓不到
 *   node src/cli.mjs probe   <url>                 接口探测：把候选数据接口挖出来
 *   node src/cli.mjs fetch   <url> [选项]           走适配器抓列表
 *   node src/cli.mjs detail  <url> --id 40         走适配器抓详情
 *   node src/cli.mjs cates   <url>                 抓筛选器目录（类别/级别/方式）
 *
 * 选项：
 *   --kind competitions|events   指定列表类型（默认由 URL 推断）
 *   --all                        自动翻页抓全量
 *   --page N --limit N           手工分页
 *   --title 关键词 --cate ID --level ID --stage N --hot 1   列表过滤
 *   --format json|csv|md|ics|table
 *   --out <文件>                 写文件（不给 --format 时按扩展名推断）
 *   --ics-window run|signup|both 导日历用哪段时间窗（默认 run）
 *   --quiet                      只输出结果/摘要
 */

import fs from 'node:fs';
import path from 'node:path';
import { inspectUrl } from './core/shell.mjs';
import { probe } from './core/probe.mjs';
import { listAdapters, requireAdapter } from './adapters/index.mjs';
import { render, formatFromPath, FORMATS } from './render.mjs';

const HELP = `web-grab —— SPA 抓取适配器 + 接口探测

把「JS 渲染、静态层只返回空壳」的页面，变成「直连它自己的数据接口」。
适配器是插件化的：新增站点只要在 src/adapters/ 下加一个文件。

命令：
  adapters                              列出已装适配器
  inspect  <url>                        空壳诊断（为什么抓不到 + 下一步）
  probe    <url>                        接口探测（挖出候选数据接口与接口域）
  fetch    <url> [选项]                 走适配器抓列表数据
  detail   <url> --id <N>               走适配器抓详情（含正文/附件）
  cates    <url>                        抓筛选器目录

抓取选项：
  --kind competitions|events   --all   --page N   --limit N
  --title 关键词   --cate ID   --level ID   --stage N   --hot 1

输出选项：
  --format ${FORMATS.join('|')}
  --out <文件>          （.json/.csv/.md/.ics 自动识别）
  --ics-window run|signup|both   导日历用哪段时间窗（默认 run = 比赛时间）
  --ics-tz local|utc   local(默认)=浮动东八区时间，直接导进时间管理软件；
                       utc=带 Z，给 Google/Apple 日历
  --ics-days first|all all=跨天的比赛窗口按天各出一条（比赛期间每天都能看到）；
                       超过 21 天的长窗口只在末尾出一条「（截止）」事件，不铺满日历
  --alarm <分钟>       提前提醒（写进 ICS 的 VALARM）
  --quiet

例子：
  node src/cli.mjs inspect https://www.mojinghub.com/competitions
  node src/cli.mjs probe   https://www.mojinghub.com/competitions
  node src/cli.mjs fetch   https://www.mojinghub.com/competitions --all --format json --out out/competitions.json
  node src/cli.mjs fetch   https://www.mojinghub.com/competitions --all --format ics --ics-window both --ics-days all --out out/competitions.ics
  node src/cli.mjs fetch   https://www.mojinghub.com/events --all --format md
  node src/cli.mjs detail  https://www.mojinghub.com/competitions --id 40
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function filterParams(flags) {
  return {
    title: flags.title,
    cate_id: flags.cate,
    level_id: flags.level,
    stage: flags.stage,
    is_hot: flags.hot,
  };
}

function writeOut(file, content) {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function out(flags, text) {
  if (!flags.quiet) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

async function cmdAdapters() {
  const rows = listAdapters();
  console.log('已装适配器：');
  for (const a of rows) {
    console.log(`  ${a.id.padEnd(12)} ${a.label}  [kinds: ${a.kinds.join(', ')}]`);
  }
  console.log('\n新增站点：复制 src/adapters/_template.mjs → src/adapters/<id>.mjs，然后在 src/adapters/index.mjs 的 ADAPTERS 里加一行。');
}

async function cmdInspect(url) {
  if (!url) throw new Error('用法：inspect <url>');
  const report = await inspectUrl(url);
  console.log(`URL          ${report.url}`);
  console.log(`HTML 体积    ${report.htmlBytes} 字节`);
  console.log(`可见文本     ${report.textLength} 字`);
  console.log(`挂载点       ${report.mountPoints.join(', ') || '(无)'}`);
  console.log(`module 脚本  ${report.moduleScripts.length} 个，modulepreload ${report.preloads.length} 个`);
  console.log(`内联配置     ${report.inlineConfig.join(', ') || '(无)'}`);
  console.log(`判定         ${report.verdict}`);
  for (const r of report.reasons) console.log(`  · ${r}`);
  if (report.verdict === 'spa-shell') {
    console.log('\n结论：这是个纯前端渲染的页面，抓 HTML 只会拿到空壳 —— 数据在它的接口里。');
    console.log('下一步：node src/cli.mjs probe ' + url);
  }
  console.log('\nbundle 清单：');
  report.bundles.slice(0, 20).forEach((b) => console.log(`  ${b}`));
  if (report.bundles.length > 20) console.log(`  … 还有 ${report.bundles.length - 20} 个`);
}

async function cmdProbe(url, flags) {
  if (!url) throw new Error('用法：probe <url>');
  const res = await probe(url, {
    maxBundles: Number(flags['max-bundles']) || 30,
    depth: Number(flags.depth) || 1,
    log: flags.quiet ? () => {} : (m) => process.stderr.write(`${m}\n`),
  });

  console.log(`页面判定     ${res.shell.verdict}（可见文本 ${res.shell.textLength} 字）`);
  console.log(`接口域       ${res.apiOrigin}`);
  if (res.origins.length > 1) {
    console.log(`其它候选域   ${res.origins.slice(1, 6).map((o) => o.origin).join(' , ')}`);
  }
  console.log(`端点候选     ${res.endpoints.length} 个（下载 bundle ${res.fetchedBundles.length} 个）`);
  if (res.endpoints.length) {
    console.log('\n按出现次数排序：');
    for (const e of res.endpoints.slice(0, 40)) {
      console.log(`  [${e.kind.padEnd(7)}] ${e.path}  (命中 ${e.hits} 处)`);
    }
  }
  if (res.failures.length) {
    console.log(`\n下载失败 ${res.failures.length} 个（忽略）：`);
    res.failures.slice(0, 5).forEach((f) => console.log(`  ${f.url} → ${f.error}`));
  }
  console.log('\n下一步：');
  res.nextSteps.forEach((s) => console.log(`  · ${s}`));
}

async function cmdFetch(url, flags) {
  if (!url) throw new Error('用法：fetch <url> [--all] [--format json]');
  const adapter = requireAdapter(url);
  const kind = adapter.resolve(url, flags.kind).kind;
  const params = {
    limit: Number(flags.limit) || (flags.all ? 100 : 20),
    ...filterParams(flags),
  };
  const started = Date.now();
  const result = flags.all
    ? await (adapter.all ? adapter.all.call(adapter, kind, params) : adapter.list(kind, params))
    : await adapter.list(kind, { ...params, page: Number(flags.page) || 1 });

  const format = flags.format || (flags.out ? formatFromPath(flags.out) : null) || 'table';
  if (!FORMATS.includes(format)) throw new Error(`--format 只能是 ${FORMATS.join(' / ')}`);

  const content = render(
    result.rows,
    format,
    {
      title: `${adapter.label} · ${kind}`,
      source: url,
      window: flags['ics-window'] || 'run',
      tz: flags['ics-tz'] || 'local',
      days: flags['ics-days'] || 'first',
      calendarName: `${kind} - ${adapter.id}`,
      alarmMinutes: Number(flags.alarm) || 0,
    }
  );

  const meta = `${result.rows.length} / ${result.total} 条，${flags.all ? `${result.pages ?? 1} 页` : `第 ${result.page ?? 1} 页`}，耗时 ${Date.now() - started}ms`;

  if (flags.out) {
    const abs = writeOut(flags.out, content);
    console.log(`已写入 ${abs}  （${meta}，格式 ${format}）`);
  } else {
    process.stdout.write(content.endsWith('\n') ? content : `${content}\n`);
    out(flags, `\n(${meta})`);
  }
}

async function cmdDetail(url, flags) {
  if (!url) throw new Error('用法：detail <url> --id <N>');
  const adapter = requireAdapter(url);
  const kind = adapter.resolve(url, flags.kind).kind;
  const idMatch = String(url).match(/\/(\d{2,})(?:\/|$)/);
  const id = flags.id || (idMatch ? idMatch[1] : null);
  if (!id) throw new Error('缺少 --id（或让 URL 自身带 id）');
  const record = await adapter.detail(kind, id);
  const format = flags.format || (flags.out ? formatFromPath(flags.out) : null) || 'json';
  const content =
    format === 'md'
      ? [
          `# ${record.title}`,
          '',
          `- 类别：${record.category} / ${record.level} / ${record.method}`,
          `- 状态：${record.status}（站点码 ${record.statusCode} → ${record.stageLabel}）`,
          `- 报名窗口：${record.signupStartCn} ~ ${record.signupEndCn}`,
          `- 比赛窗口：${record.runStartCn} ~ ${record.runEndCn}`,
          `- 费用：${record.feeType}${record.feeAmount ? ` ${record.feeAmount}` : ''}`,
          `- 主办：${record.organizer}`,
          `- 详情页：${record.pageUrl}`,
          record.externalSignupUrl ? `- 报名地址：${record.externalSignupUrl}` : false,
          '',
          '## 简介',
          '',
          record.description || '(无)',
          '',
          '## 正文',
          '',
          record.overviewText || '(无)',
          '',
          '## 附件',
          '',
          ...(record.files.length ? record.files.map((f) => `- [${f.name}](${f.url})`) : ['(无)']),
          '',
        ]
          .filter((l) => l !== false)
          .join('\n')
      : format === 'ics'
        ? render([record], 'ics', {
            window: flags['ics-window'] || 'run',
            tz: flags['ics-tz'] || 'local',
            days: flags['ics-days'] || 'first',
          })
        : JSON.stringify(record, null, 2);

  if (flags.out) {
    console.log(`已写入 ${writeOut(flags.out, content)}`);
  } else {
    process.stdout.write(content.endsWith('\n') ? content : `${content}\n`);
  }
}

async function cmdCates(url, flags) {
  if (!url) throw new Error('用法：cates <url>');
  const adapter = requireAdapter(url);
  if (!adapter.catalog) throw new Error(`适配器 ${adapter.id} 未实现 catalog()`);
  const kind = adapter.resolve(url, flags.kind).kind;
  const data = await adapter.catalog(kind);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, url] = positional;

  if (!command || flags.help || command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  switch (command) {
    case 'adapters':
      return cmdAdapters();
    case 'inspect':
      return cmdInspect(url);
    case 'probe':
      return cmdProbe(url, flags);
    case 'fetch':
      return cmdFetch(url, flags);
    case 'detail':
      return cmdDetail(url, flags);
    case 'cates':
      return cmdCates(url, flags);
    default:
      process.stderr.write(`未知命令：${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`✗ ${err.message}\n`);
  process.exitCode = 1;
});
