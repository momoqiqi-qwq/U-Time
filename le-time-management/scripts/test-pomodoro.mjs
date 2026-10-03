import { readProductSource } from "./lib/read-product-source.mjs";
// 番茄专注的提醒设置：音效目录、开关分支、以及插件界面的构建。
// 插件源码是 IIFE，这里在 vm 里注入一个 fixture 把它内部的 finish / render / reminder 暴露出来，
// 再用一套极简 DOM 驱动真源码 —— 比读源码猜行为可靠。
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { BUILTIN_SOUNDS, CUSTOM_SOUND_ID, DEFAULT_SOUND_ID, resolveSound, soundLabel, playSound } from '../src/sound.js';

/* ── 一、音效目录 ── */
assert.ok(BUILTIN_SOUNDS.length >= 5, `内置音效太少：${BUILTIN_SOUNDS.length}`);
assert.equal(BUILTIN_SOUNDS[0].id, DEFAULT_SOUND_ID, '默认音必须排在首位');
assert.equal(DEFAULT_SOUND_ID, 'beep', '默认音 id 必须保持 beep —— 老用户的设置里存的就是它');
assert.equal(new Set(BUILTIN_SOUNDS.map((s) => s.id)).size, BUILTIN_SOUNDS.length, '音效 id 不能重复');
for (const preset of BUILTIN_SOUNDS) {
  assert.ok(preset.label && preset.note, `音效 ${preset.id} 缺少 label / note`);
  // v0.73.0 起预设有两种形状：一次性（tones）与可循环长鸣（loop.tones）。两者必须有一个。
  const tones = preset.tones || preset.loop?.tones;
  assert.ok(Array.isArray(tones) && tones.length, `音效 ${preset.id} 没有音调`);
  if (preset.loop) {
    assert.ok(Number(preset.loop.period) > 0, `长鸣音效 ${preset.id} 缺 period`);
    const end = tones.reduce((acc, t) => Math.max(acc, (Number(t.t) || 0) + (Number(t.d) || 0.18)), 0);
    assert.ok(end < preset.loop.period, `长鸣音效 ${preset.id} 的最后一个音压到 period 末尾，循环接缝会咔哒`);
  }
  for (const tone of tones) {
    assert.ok(Number(tone.f) > 0, `音效 ${preset.id} 的频率非法：${tone.f}`);
    assert.ok(Number(tone.d) > 0, `音效 ${preset.id} 的时长非法：${tone.d}`);
    assert.ok(tone.t === undefined || Number(tone.t) >= 0, `音效 ${preset.id} 的起始偏移非法：${tone.t}`);
  }
}
assert.equal(resolveSound('不存在的音效'), DEFAULT_SOUND_ID, '未知音效必须退回默认音，否则到点会一声不响');
assert.equal(resolveSound(CUSTOM_SOUND_ID), CUSTOM_SOUND_ID);
assert.equal(soundLabel(CUSTOM_SOUND_ID), '自定义音频');

// Node 里没有 AudioContext / Audio，playSound 必须自己吞掉异常并如实返回 silent，绝不抛给调用方。
assert.equal(await playSound({}), 'silent');
assert.equal(await playSound({ volume: 0 }), 'silent');
assert.equal(await playSound({ sound: 'custom', customAudio: 'data:audio/mpeg;base64,AA' }), 'silent');
assert.equal(await playSound({ sound: 'chime', volume: 2 }), 'silent');

/* ── 二、应用侧接线 ── */
const read = (rel) => readProductSource(new URL(rel, import.meta.url), 'utf8');
const taskReminder = read('../src/taskReminder.js');
assert.match(taskReminder, /import \{[^}]*\bplaySound\b[^}]*\} from "\.\/sound\.js"/, '任务提醒必须复用共享音效模块');
assert.ok(!/AudioContext/.test(taskReminder), '任务提醒不该再自己维护一份 AudioContext');
assert.match(taskReminder, /return playSound\(\{ sound: c\.sound, volume: level, customAudio: c\.customAudio \}\)/);

const pluginHost = read('../src/pluginHost.js');
assert.match(pluginHost, /import \{ BUILTIN_SOUNDS, playSound, resolveSound \} from "\.\/sound\.js"/);
assert.equal((pluginHost.match(/requirePermission\(man, pid, "sound"\)/g) || []).length, 2, 'tide.sound 的 presets / play 都要校验 sound 权限');
assert.match(pluginHost, /sound: "播放提醒音"/, '新权限缺少中文标签');

const settingsView = read('../src/views/settings.js');
assert.match(settingsView, /for \(const preset of BUILTIN_SOUNDS\)/, '设置页的提示音下拉应来自同一份音效目录');

/* ── 三、插件行为 ── */
const PLUGIN = new URL('../public/plugins/pomodoro/main.js', import.meta.url);
const manifest = JSON.parse(read('../public/plugins/pomodoro/manifest.json'));
assert.ok(manifest.permissions.includes('sound'), '番茄专注的 manifest 必须声明 sound 权限，否则 tide.sound 会被宿主拒绝');
// 版本号只钉「不低于」的下限，不钉字面量：这条断言的本意是「改过插件行为就得升版本」，
// 写死字面量会在每次**有意**升版时假红一次（实测：0.5.0 → 0.5.1 就红了，而那次升版正是为了这条改动）。
const [vmaj, vmin, vpat] = manifest.version.split('.').map(Number);
const atLeast = (maj, min, pat) => vmaj > maj || (vmaj === maj && (vmin > min || (vmin === min && vpat >= pat)));
assert.ok(atLeast(0, 5, 1),
  `改过插件行为就必须升版本（试听按钮提到提醒面板头部 / 卡片底色不再依赖已删的 --custom-panel-mix）：当前 ${manifest.version}，要求 ≥ 0.5.1`);

const source = readProductSource(PLUGIN, 'utf8');
for (const marker of ['tide.sound.play', 'tide.sound.presets', 'focusNotify', 'focusSound', 'breakNotify', 'breakSound', 'AUDIO_MAX_BYTES', 'readAsDataURL']) {
  assert.ok(source.includes(marker), `番茄专注缺少提醒能力：${marker}`);
}
assert.ok(!/["']#fff["']/.test(source), '按钮文字不能硬编码 #fff —— 深色主题下主色被提亮，白字会糊在亮底上');
assert.match(source, /var\(--on-deep,#fff\)/);
/* 内置音效必须是可见按钮组（不再藏在 <select> 下拉里），选中态走主题变量。
   注意「关联任务」的任务下拉仍是合法的 <select>，只禁提示音自己的 soundSel。 */
assert.ok(!/soundSel/.test(source), '提示音不许退回 <select> 下拉 —— 手机上不展开看不到内置音效');
assert.match(source, /syncSoundChips/, '音效按钮组缺少选中态同步');
assert.match(source, /soundChips\.style\.cssText = "display:flex;flex-wrap:wrap;gap:6px"/, '音效按钮组要可换行（390px 手机视口）');
/* 提醒面板默认收起：body 初始 display:none，展开走 toggle 的 grid */
assert.match(source, /margin-top:11px;display:none;gap:9px/, '提醒面板必须默认收起 —— 平常不该占一大屏');
assert.ok(!/margin-top:11px;display:grid/.test(source), '提醒面板不许默认展开');
/* v0.50.0：试听按钮必须挂在面板头部（head.append(toggle, previewBtn)），
   收起状态也能直接试听；面板内部不许再留第二个试听行。 */
assert.match(source, /head\.append\(toggle, previewBtn\)/, '试听按钮必须与「提醒设置」开关同行挂在面板头部');
assert.ok(!/row\("提示音", chip\("试听"/.test(source), '面板内部不许再有第二个试听按钮 —— 头部那个收起状态也能用');

/* 自定义背景已在 v0.55.0 移除：卡片底色改回 var(--panel)，与宿主 .card 一致。
   这里同时钉住反面 —— 不许再引用那个功能注入的变量。宿主已经不再注入它们，
   留着 var() 靠 fallback 虽然能跑，但那是指向「不存在的功能」的死引用，会误导后来读代码的人。 */
assert.match(source, /background:var\(--panel,#fff\)/,
  '番茄卡片底色要用 var(--panel)，与宿主 .card 一致');
// 这条是**全文件**扫描（注释也算）—— 故意这么严：实测第一版把变量名留在注释里，
// 只扫 cssText 的话放过了，而注释里的令牌名正是最容易被人复制回代码的地方。
assert.doesNotMatch(source, /--custom-panel-mix|--custom-panel-glass/,
  '自定义背景已移除，插件不许再引用它注入的 --custom-panel-mix / --custom-panel-glass（注释里也别写）');
assert.ok(!fs.existsSync(new URL('../src/background.js', import.meta.url)),
  'src/background.js（自定义背景模块）必须已删除');

/* 极简 DOM：够 render() 跑起来即可 */
function fakeEl(tag = 'div') {
  const node = {
    tagName: String(tag).toUpperCase(),
    style: { cssText: '', display: '' },
    dataset: {}, children: [], options: [],
    value: '', checked: false, textContent: '', innerHTML: '', title: '',
    files: null, type: '', accept: '', min: '', max: '', step: '', placeholder: '',
    addEventListener: () => {}, click: () => {}, remove: () => {},
    setAttribute: (name, val) => { node[name === 'class' ? 'className' : name] = val; },
    append: (...n) => { node.children.push(...n); },
    appendChild: (n) => { node.children.push(n); return n; },
    replaceChildren: (...n) => { node.children = [...n]; },
    querySelector: () => fakeEl(),
    querySelectorAll: () => [],
    closest: () => null,
  };
  return node;
}

const notified = [];
const played = [];
const storage = new Map();
const uiCtx = vm.createContext({
  console,
  clearInterval: () => {}, setInterval: () => 1,
  document: { createElement: fakeEl, createTextNode: (text) => ({ textContent: text }) },
  tide: {
    storage: {
      async get(key, fallback) { return storage.has(key) ? storage.get(key) : fallback; },
      async set(key, value) { storage.set(key, value); },
    },
    tasks: { list: () => [{ id: 't1', title: '写测试', done: false }], create: (patch) => ({ id: 't1', ...patch }) },
    notify: (msg) => notified.push(msg),
    sound: {
      presets: async () => BUILTIN_SOUNDS.map(({ id, label, note }) => ({ id, label, note })),
      play: (opts) => { played.push(opts); return Promise.resolve('builtin'); },
    },
    events: { emit: () => {}, on: () => {} },
    ui: { registerView: () => {} },
  },
});

vm.runInContext(
  source.replace('  tide.ui.registerView({',
    '  globalThis.__fx = { render, finish, tick, normalizeReminder, MODES, clampCustomSec, fmtMin, modeSeconds, CUSTOM_MAX_SEC,\n'
    + '    get reminder() { return reminder; }, set reminder(v) { reminder = v; },\n'
    + '    get customSec() { return customSec; }, set customSec(v) { customSec = v; },\n'
    + '    setLeft(v) { left = v; }, resetStages() { firedStages = new Set(); },\n'
    + '    get dotsBox() { return dotsBox; },\n'
    + '    setMode(id) { if (id === "custom") { mode = { id: "custom", label: "自定义", min: customSec / 60 }; return; } mode = MODES.find((m) => m.id === id); },\n'
    + '    setTaskId(id) { currentTaskId = id; } };\n'
    + '  tide.ui.registerView({'),
  uiCtx,
);
const fx = uiCtx.__fx;
const tick = () => new Promise((r) => setTimeout(r, 0));

// 界面构建本身：提醒面板里的 TDZ / 变量顺序问题会在这里直接抛出来。
fx.render(fakeEl('div'));
await tick();

const base = { focusNotify: true, focusSound: true, breakNotify: true, breakSound: true, sound: 'chime', volume: 0.6, customAudio: null, customAudioName: '' };
const reset = () => { notified.length = 0; played.length = 0; };

/* 多段提醒只在命中的剩余时间触发，且短番茄不会提前触发超过总时长的时间点。 */
reset();
fx.setMode('focus');
fx.reminder = { ...base, focusStages: [300, 60] };
fx.resetStages();
fx.setLeft(301);
fx.tick();
assert.equal(notified[0], '专注还剩 05:00');
assert.equal(played.length, 1);
fx.setLeft(61);
fx.tick();
assert.equal(notified[1], '专注还剩 01:00');
assert.equal(played.length, 2);
fx.setMode('custom'); fx.customSec = 30; fx.setLeft(30); fx.resetStages();
fx.tick();
assert.equal(notified.length, 2, '不足一分钟的番茄不应误触发 1 / 5 分钟提醒');

/* 专注结束：通知 + 声音都开 */
reset();
fx.reminder = { ...base };
fx.setMode('focus');
await fx.finish();
assert.equal(notified.length, 1, `专注结束应弹 1 条完成通知，实际 ${notified.length}`);
assert.ok(notified[0].includes('完成 1 个番茄'), notified[0]);
// 逐字段比对：对象来自 vm 的另一个 realm，原型不同会让 deepStrictEqual 误判。
assert.equal(played.length, 1, '专注结束应播放一次提示音');
assert.equal(played[0].sound, 'chime', '提示音 id 必须原样传给宿主');
assert.equal(played[0].volume, 0.6, '音量必须原样传给宿主');
assert.equal(played[0].customAudio, null);

/* 关联了任务时，完成后再补一条「下一个番茄继续」 */
reset();
fx.setTaskId('t1');
await fx.finish();
assert.equal(notified.length, 2, `关联任务时应再补 1 条续接提示，实际 ${notified.length}`);
assert.ok(notified[1].includes('写测试'), notified[1]);
fx.setTaskId('');

/* 专注结束：关掉声音，通知照旧 */
reset();
fx.reminder = { ...base, focusSound: false };
await fx.finish();
assert.equal(played.length, 0, '关掉「声音」后不该播放');
assert.equal(notified.length, 1);

/* 专注结束：关掉通知 —— 续接提示也不能漏出来 */
reset();
fx.reminder = { ...base, focusNotify: false };
fx.setTaskId('t1');
await fx.finish();
assert.equal(notified.length, 0, '关掉「通知」后不该弹任何提示');
assert.equal(played.length, 1);
fx.setTaskId('');

/* 休息结束走的是另一组开关 */
reset();
const focusDone = storage.get('doneCount');
fx.reminder = { ...base, breakSound: false, breakNotify: false };
fx.setMode('break');
await fx.finish();
assert.equal(notified.length, 0, '休息结束的通知开关应独立于专注');
assert.equal(played.length, 0);
reset();
fx.reminder = { ...base, breakSound: true, breakNotify: true };
await fx.finish();
assert.equal(played.length, 1);
assert.ok(notified[0].includes('休息结束'), notified[0]);
assert.equal(storage.get('doneCount'), focusDone, '休息不该计入番茄数');

/* 配置损坏的自愈：选了「自定义」但音频没了 → 退回默认音，不能一声不响 */
const healed = fx.normalizeReminder({ ...base, sound: 'custom', customAudio: null, volume: 'x' });
assert.equal(healed.sound, DEFAULT_SOUND_ID);
assert.equal(healed.volume, 0.75);
assert.equal(fx.normalizeReminder({ ...base, focusSound: false, breakNotify: false }).focusSound, false, '关闭状态必须被保留');

/* ── 四、自定义时长精确到秒 ── */
// 唯一事实源是秒（storage 键 customSec）。分 / 秒两个输入框只是它的两种视图，
// 所以这里直接压 clampCustomSec / modeSeconds，而不是去戳 DOM。
assert.equal(fx.clampCustomSec(1, 30), 90, '1 分 30 秒就是 90 秒 —— 这正是这次改动的目的');
assert.equal(fx.clampCustomSec('1', '30'), 90, '输入框给的是字符串，必须照样算对');
assert.equal(fx.clampCustomSec(0, 30), 30, '0 分 30 秒必须合法，否则「自定义秒」等于没做');
assert.equal(fx.clampCustomSec(1, 90), 150, '秒填 90 要进位成 2 分 30 秒');
assert.equal(fx.clampCustomSec(999, 0), fx.CUSTOM_MAX_SEC, '上限仍是 240 分');
assert.equal(fx.clampCustomSec('', ''), 1, '空输入夹到 1 秒，不能变成 0 把计时卡死');
assert.equal(fx.clampCustomSec(-5, -5), 1, '负数同样夹到下限');
assert.equal(fx.clampCustomSec('x', 'y'), 1, '脏输入不能算出 NaN');
assert.ok(Number.isInteger(fx.clampCustomSec(1.4, 0.6)), '结果必须是整数秒');

fx.setMode('custom');
fx.customSec = 90;
assert.equal(fx.modeSeconds(fx.MODES[0]), 25 * 60, '预设模式仍按分钟换算');
assert.equal(fx.modeSeconds({ id: 'custom', label: '自定义', min: 999 }), 90,
  '自定义模式必须读 customSec，不能被 mode.min 带偏');

assert.equal(fx.fmtMin(25), '25');
assert.equal(fx.fmtMin(1.5), '1.5');
assert.equal(fx.fmtMin(0.5), '0.5');
assert.equal(fx.fmtMin(2), '2', '整数分钟不带多余的 .0');

/* 90 秒的番茄记 1.5 分钟，通知文案也要跟着 */
reset();
fx.setTaskId('');
fx.reminder = { ...base };
storage.delete('focusMin');
fx.customSec = 90;
fx.setMode('custom');
await fx.finish();
assert.equal(storage.get('focusMin'), 1.5, `90 秒应记 1.5 分钟，实际 ${storage.get('focusMin')}`);
assert.ok(notified[0] && notified[0].includes('1.5 分钟'), `完成通知要报真实分钟，实际「${notified[0]}」`);

/* 浮点噪声要收掉：0.1 + 0.2 不能写成 0.30000000000000004 */
storage.set('focusMin', 0.1);
fx.customSec = 12;
fx.setMode('custom');
await fx.finish();
assert.equal(storage.get('focusMin'), 0.3, `累计分钟必须收敛到 1 位小数，实际 ${storage.get('focusMin')}`);

/* 「累计」那行用真实累计分钟，不许再拿番茄数 × 25 估 */
fx.render(fakeEl('div'));
await tick();
await tick();
const dotsLabel = fx.dotsBox.children.find((c) => typeof c.textContent === 'string' && c.textContent.includes('累计'));
assert.ok(dotsLabel, '统计行应该被渲染出来');
assert.ok(dotsLabel.textContent.includes('0.3 分钟'),
  `统计行必须用真实累计分钟，实际「${dotsLabel.textContent}」`);
assert.ok(!/· 25 分钟/.test(dotsLabel.textContent), '不能再用番茄数 × 25 估算');

console.log('PASS: 番茄专注的提醒开关（专注 / 休息 × 通知 / 声音）、提示音参数、自定义时长精确到秒、配置自愈与界面构建');
