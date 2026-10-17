import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/plugins/cn-holiday/main.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../public/plugins/cn-holiday/manifest.json', import.meta.url), 'utf8'));

/* 全年安排：已经结束的假期整行置灰并打「已过」标签；查某一天用自定义大日历（v0.3.0） */
/* v0.233.0：读取 / 联网更新期间接上宿主等待蒙版（tide.ui.waitMask）→ 0.3.1 */
assert.equal(manifest.version, '0.3.1');

const catalog = fs.readFileSync(new URL('../src/pluginCatalog.js', import.meta.url), 'utf8');
const entry = catalog.slice(catalog.indexOf('"id": "cn-holiday"'));
const block = entry.slice(0, entry.indexOf('},\n  {'));

assert.match(block, /"0\.3\.1"/, 'pluginCatalog 必须同步插件新版本号');
assert.doesNotMatch(source, /type="date"/, '原生 date input 必须移除（其弹层小且没法定制）');
assert.match(source, /ch-datebtn" data-datebtn/, '必须用自定义日期按钮触发日历');
assert.match(source, /grid-template-rows:0fr/, '日历展开收起必须用 0fr→1fr 高度过渡（平滑不跳变）');
assert.match(source, /grid-template-rows:1fr/, '日历展开态必须恢复 1fr 高度');
assert.match(source, /ch-cal-day\$\{mark\(d\)\}/, '日历每一天必须带假日标记类');
assert.match(source, /k\.kind === "holiday" \? " off" : k\.kind === "makeup" \? " makeup" : ""/, '法定假休日标红、调休上班日带班标记');
assert.match(source, /<i>班<\/i>/, '调休上班日必须显示「班」角标');
assert.match(source, /data-cal-today/, '日历必须有「今天」快捷键');
assert.match(source, /data-cal-clear/, '日历必须有「清除」按钮');
assert.match(source, /try \{ idx = buildIndex\(\[\(await loadYear\(calYear, false, true\)\)\.doc\]\); \} catch \{\}/, '假日标记取数失败必须静默降级为无标记日历，不能白屏');
assert.match(source, /const past = diffDays\(b\.end, today\) > 0/, '必须用假期结束日期与今天比较判断「已过」');
assert.match(source, /ch-row\$\{past \? " past" : ""\}/, '已过假期必须给行加 past 类（置灰由 CSS 承担）');
assert.match(source, /ch-past-tag">已过/, '已过假期必须在名称旁打「已过」标签');
assert.match(source, /\.ch-row\.past b,\.ch-row\.past \.ch-range\{color:var\(--ink-3/, 'past 行的名称与日期必须置灰');
assert.match(source, /\.ch-row\.past \.ch-days\{background:var\(--paper/, 'past 行的天数徽标必须置灰');
assert.match(source, /x\.past \? `<span style="color:var\(--ink-3,#A9B2BA\)">\$\{esc\(x\.txt\)\}（已过）<\/span>` : esc\(x\.txt\)/, '已过的调休上班日也要置灰并标注（已过）');
assert.match(source, /makeup\.innerHTML = ms\.length \? `调休上班：/, '调休行改 innerHTML 后必须保留「调休上班：」前缀且内容经 esc 转义');

console.log('PASS: cn-holiday 已过假期置灰+标签、自定义大日历（假日标红/班角标/今天/清除/平滑展开收起动画）、catalog 版本同步');
