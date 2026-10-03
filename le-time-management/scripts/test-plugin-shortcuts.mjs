// 插件快捷键（Alt + 字母直达插件视图）：分配规则真跑 + 三处界面接线静态守卫。
// 分层契约见 src/pluginShortcuts.js 头注释 —— 纯逻辑不依赖 DOM，这里直接 import 真跑；
// shell / 命令面板 / 设置页的接线用源码正则钉住。
import assert from 'node:assert/strict';
import { readProductSource as readFileSync } from './lib/read-product-source.mjs';
import {
  PLUGIN_SHORTCUT_MODIFIER,
  normalizeShortcutLetter,
  getPluginShortcutCustoms,
  setPluginShortcut,
  computePluginShortcutMap,
  autoShortcutCandidates,
  resolveShortcutActivation,
} from '../src/pluginShortcuts.js';
import { pinyinInitialOf } from '../src/pinyinInitial.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/* ── 1. 字母归一化 ── */
assert.equal(normalizeShortcutLetter('p'), 'P', '小写要归一成大写');
assert.equal(normalizeShortcutLetter(' P '), 'P', '首尾空白要去掉');
assert.equal(normalizeShortcutLetter('AB'), '', '多字符不是合法快捷键（输入框 maxlength=1 之外还要兜底）');
assert.equal(normalizeShortcutLetter('1'), '', '数字不是合法快捷键');
assert.equal(normalizeShortcutLetter(''), '', '空串 = 清除（回到自动分配）');
assert.equal(normalizeShortcutLetter(null), '', 'null 不能炸');
assert.equal(normalizeShortcutLetter('π'), '', '变音字符不能当快捷键');

/* ── 2. 拼音首字母解析（自动分配的数据源） ── */
// 内置插件的真实名字逐个钉住 —— 这些字一旦被生成器过滤掉（比如误改 GB2312 白名单），
// 侧栏徽标会悄悄退回插件 ID 首字母，不测就发现不了。
for (const [name, letter] of [
  ['番茄专注', 'F'], ['课程表', 'K'], ['学习通', 'X'], ['中国节假日', 'Z'],
  ['警大门户通知', 'J'], ['轮换值日', 'L'], ['考试日历', 'K'], ['竞赛消息雷达', 'J'],
  ['拖入消息收纳', 'T'], ['插件使用说明', 'C'], ['学校通知网站', 'X'],
  ['网页收集', 'W'], ['微信提醒推送', 'W'], ['周度报告', 'Z'], ['示例插件', 'S'],
]) {
  assert.equal(pinyinInitialOf(name), letter, `「${name}」的拼音首字母应为 ${letter}`);
}
// 前导非汉字要跳过（插件名可能带方括号、空格、emoji）
assert.equal(pinyinInitialOf('【实验】工具'), 'S', '前导标点必须跳过，不能直接判空');
assert.equal(pinyinInitialOf('🙂表情包'), 'B', 'emoji 必须跳过（代理对不能被当成 1 个「字」处理）');
assert.equal(pinyinInitialOf('AI 助手'), 'A', '首个有效字符是英文字母时直接用（"AI 助手" 不该算成 助→Z）');
assert.equal(pinyinInitialOf('  '), '', '全是空白 = 解析不出');
assert.equal(pinyinInitialOf('123'), '', '纯数字解析不出');
assert.equal(pinyinInitialOf('龘靐齉'), '', '表外生僻字解析不出（调用方要能兜底，不能返回垃圾）');
// 多音字：表里同一个字会落在多个首字母组（重 → c 组 + z 组），解析必须取**字母序靠前**的那组。
// 没有上下文就分不出「重庆(chóng)」和「重要(zhòng)」，选一个**确定性**的规则好过随机 ——
// 钉住它，免得哪天生成器改了枚举顺序、同一个插件名的字母悄悄变了。
assert.equal(pinyinInitialOf('重庆'), 'C', '多音字取字母序靠前的读音（重 → c 组）');
assert.equal(pinyinInitialOf('重量'), 'C', '同上 —— 多音字不做词义消歧，规则是「字母序靠前」而不是「更常用」');
assert.equal(pinyinInitialOf(null), '', 'null 不能炸');
assert.equal(pinyinInitialOf(''), '', '空串不能炸');

/* ── 3. 分配规则真跑 ── */
// 3a. 候选顺序：中文名首字母 → 插件 ID 首字母（去重）
assert.deepEqual(
  autoShortcutCandidates({ pluginId: 'pomodoro', name: '番茄专注' }),
  ['F', 'P'],
  '候选必须是「中文名首字母, 插件 ID 首字母」',
);
assert.deepEqual(
  autoShortcutCandidates({ pluginId: 'weekly-report', name: '周度报告' }),
  ['Z', 'W'],
  '中文名首字母与 ID 首字母不同时两档都要在',
);
assert.deepEqual(
  autoShortcutCandidates({ pluginId: 'web-collector', name: '网页收集' }),
  ['W'],
  '两档撞成同一个字母时要去重，不能重复登记同一个候选',
);
assert.deepEqual(
  autoShortcutCandidates({ pluginId: 'pomodoro' }),
  ['P'],
  '没有 name（老调用点）只剩 ID 这一档 —— 与改规则前的行为完全一致',
);
assert.deepEqual(
  autoShortcutCandidates({ pluginId: '123-tool', name: '番茄' }),
  ['F'],
  'ID 不以字母开头时只剩中文名这一档',
);
assert.deepEqual(autoShortcutCandidates({}), [], '什么都没有 = 空候选（不能返回 [undefined]）');

// 3b. 自动分配 = 中文名首字母（改规则的核心：不再用英文插件 ID）
const only = computePluginShortcutMap([{ pluginId: 'pomodoro', viewId: 'pomodoro', name: '番茄专注' }], {});
assert.equal(only.get('pomodoro').letter, 'F', '番茄专注必须拿到 F，而不是 pomodoro 的 P');
assert.equal(only.get('pomodoro').viewId, 'pomodoro', 'viewId 必须原样带回（导航要用它拼 plug: 前缀）');

// 3c. 没有 name 时退回旧行为（插件 ID 首字母）—— 老调用点 / 外部插件不能因此没有快捷键
const noName = computePluginShortcutMap([{ pluginId: 'pomodoro', viewId: 'pomodoro' }], {});
assert.equal(noName.get('pomodoro').letter, 'P', '缺 name 时退回插件 ID 首字母');

// 3d. viewId 与 pluginId 可以不同（registerView 的 id 不必等于插件 id）
const renamed = computePluginShortcutMap([{ pluginId: 'p1', viewId: 'p1-view' }], {});
assert.equal(renamed.get('p1').viewId, 'p1-view');

// 3e. 显式指定优先 —— 而且与插件在列表里的先后无关（先登记全部 customs，再分自动）
const entries2 = [
  { pluginId: 'web-collector', viewId: 'a', name: '网页收集' },
  { pluginId: 'pomodoro', viewId: 'b', name: '番茄专注' },
];
const customBeatsAuto = computePluginShortcutMap(entries2, { pomodoro: 'W' });
assert.equal(customBeatsAuto.get('pomodoro').letter, 'W', '显式指定必须生效（压过中文名首字母 F）');
assert.equal(customBeatsAuto.get('web-collector').letter, '', '网页收集只剩 W 一档候选（名与 ID 同字母），被显式指定占掉 → 空手');
const customBeatsAutoRev = computePluginShortcutMap([...entries2].reverse(), { pomodoro: 'W' });
assert.equal(customBeatsAutoRev.get('pomodoro').letter, 'W', '调换顺序后显式指定依然生效（customs 先于自动分配登记）');
assert.equal(customBeatsAutoRev.get('web-collector').letter, '');

// 3f. 中文名首字母撞车 → 退回插件 ID 首字母（而不是直接空手）
const fallbackToId = computePluginShortcutMap(
  [
    { pluginId: 'school-notice', viewId: 'a', name: '学校通知网站' },
    { pluginId: 'chaoxing-notify', viewId: 'b', name: '学习通' },
  ],
  {},
);
assert.equal(fallbackToId.get('school-notice').letter, 'X', '先注册的拿走 X');
assert.equal(
  fallbackToId.get('chaoxing-notify').letter,
  'C',
  '学习通的中文名首字母 X 被占，必须退回插件 ID 首字母 C —— 不是空手',
);

// 3g. 两档候选都被占 → 空手（先到先得，不许抢）
const clash = computePluginShortcutMap(
  [
    { pluginId: 'shiguang-schedule', viewId: 'a', name: '课程表' },
    { pluginId: 'kaoshi-tool', viewId: 'b', name: '课程表' },
  ],
  {},
);
assert.equal(clash.get('shiguang-schedule').letter, 'K', '第一个「课程表」拿走 K');
assert.equal(
  clash.get('kaoshi-tool').letter,
  '',
  '第二个「课程表」两档候选都是 K（名与 ID 同字母、去重后只剩一档）且已被占 → 空手',
);

// 3h. 显式之间也先到先得；输家退回自动分配
const dupCustom = computePluginShortcutMap(
  [{ pluginId: 'aaa-tool', viewId: 'a' }, { pluginId: 'bbb-tool', viewId: 'b' }],
  { 'aaa-tool': 'X', 'bbb-tool': 'X' },
);
assert.equal(dupCustom.get('aaa-tool').letter, 'X', '先设置的显式字母生效');
assert.equal(dupCustom.get('bbb-tool').letter, 'B', '重复的显式字母退回自动分配，而不是空手');

// 3i. 非 A–Z 开头且无中文名的插件 ID 没有自动分配
const weird = computePluginShortcutMap([{ pluginId: '123-tool', viewId: 'a' }], {});
assert.equal(weird.get('123-tool').letter, '');

/* ── 4. 按键事件 → 目标视图（纯函数，喂假事件） ── */
const entries = [{ pluginId: 'pomodoro', viewId: 'pomodoro' }, { pluginId: 'weekly-report', viewId: 'weekly' }];
const customs = {};
const hit = (event) => resolveShortcutActivation(event, entries, customs);

assert.equal(hit({ altKey: true, key: 'p', target: { tagName: 'DIV' } }), 'pomodoro', 'Alt+P 应命中番茄专注');
assert.equal(hit({ altKey: true, key: 'P', target: { tagName: 'DIV' } }), 'pomodoro', '大写同样命中');
assert.equal(hit({ altKey: true, key: 'w', target: { tagName: 'DIV' } }), 'weekly', 'Alt+W 命中周度报告');
assert.equal(hit({ altKey: true, key: 'z', target: { tagName: 'DIV' } }), null, '没分配的字母不触发');
assert.equal(hit({ altKey: true, key: 'p', target: { tagName: 'INPUT' } }), null, '焦点在输入框不许跳视图');
assert.equal(hit({ altKey: true, key: 'p', target: { tagName: 'TEXTAREA' } }), null, '焦点在文本域不许跳视图');
assert.equal(hit({ altKey: true, key: 'p', target: { tagName: 'SELECT' } }), null, '焦点在下拉不许跳视图');
assert.equal(hit({ altKey: true, key: 'p', target: { isContentEditable: true } }), null, '可编辑元素不许跳视图');
assert.equal(hit({ altKey: true, ctrlKey: true, key: 'p', target: { tagName: 'DIV' } }), null, 'Ctrl 组合放行给系统');
assert.equal(hit({ altKey: true, metaKey: true, key: 'p', target: { tagName: 'DIV' } }), null, 'Meta 组合放行给系统');
assert.equal(hit({ key: 'p', target: { tagName: 'DIV' } }), null, '没按 Alt 不触发');
assert.equal(
  hit({ altKey: true, key: 'π', code: 'KeyP', target: { tagName: 'DIV' } }),
  'pomodoro',
  'macOS 上 Option 会把 e.key 变成变音字符，必须退回 e.code 还原物理键',
);

/* ── 5. settings 存储访问器（真跑，共享 store 模块状态） ── */
// store 是模块级单例：Node 侧先喂 localStorage 垫片并初始化（与 test-interactions.mjs 同款）
import * as S from '../src/store.js';
const memory = new Map();
globalThis.localStorage = { getItem: (k) => memory.get(k), setItem: (k, v) => memory.set(k, v) };
await S.initStore({ tasks: [], blocks: [], settings: {}, plugins: {} });

const letter = setPluginShortcut('test-plugin-x', ' q ');
assert.equal(letter, 'Q', 'setPluginShortcut 返回归一化结果');
assert.equal(getPluginShortcutCustoms()['test-plugin-x'], 'Q');
setPluginShortcut('test-plugin-x', '');
assert.ok(!('test-plugin-x' in getPluginShortcutCustoms()), '传空 = 删除显式值（回到自动分配）');
setPluginShortcut('test-plugin-x', '!!!');
assert.ok(!('test-plugin-x' in getPluginShortcutCustoms()), '非法输入同样视为清除');

/* ── 6. 三处界面接线（静态守卫） ── */
const shell = read('../src/shell.js');
assert.match(shell, /import \{[^}]*attachPluginShortcutKeys[^}]*\} from "\.\/pluginShortcuts\.js"/, 'shell 必须引入快捷键挂载器');
assert.match(shell, /attachPluginShortcutKeys\(\{/, 'shell 必须真正挂上 keydown 监听');
assert.match(shell, /navigate: \(viewId\) => switchTo\(`plug:\$\{viewId\}`\)/, '命中后必须以 plug: 前缀交给 switchTo');
assert.match(shell, /const sc = isPlug && def\.pluginView\?\.pluginId \? effectiveShortcutLetter\(def\.pluginView\.pluginId\) : "";/, 'navBtn 必须先算出生效字母');
assert.match(shell, /sc \? el\("kbd", \{ class: "nav-kbd"/, '侧栏插件入口必须带快捷键徽标（条件成立才渲染，而不是把字样留在死代码里）');
assert.match(shell, /contextMenuItem\(`快捷键 · /, '插件右键菜单必须提供「快捷键」设置项');
assert.match(shell, /setPluginShortcut\(pluginId, value\)/, '右键菜单必须真正落盘显式字母');

const palette = read('../src/commandPalette.js');
assert.match(palette, /打开插件 · Alt\+\$\{sc\}/, '命令面板的插件条目必须亮出 Alt 快捷键');

const settings = read('../src/views/settings.js');
assert.match(settings, /paintPluginShortcuts/, '设置页必须有插件快捷键编辑区');
assert.match(settings, /computePluginShortcutMap\(entries, getPluginShortcutCustoms\(\)\)/, '设置页必须用同一套分配规则回显');
assert.match(settings, /class: "shortcut-kbd"/, '设置页每行必须展示生效字母');

/* ── 7. 取数口径唯一（三处必须同源，否则同一个插件会算出不同字母） ──
   改规则时这里曾经是「settings 必须从 pluginHost 导入 getRegistry」—— 那条断言
   钉的是实现细节（设置页自己查显示名），现在设置页改从 entries 里取名字，
   旧断言只会拦住正确重构。换成真正要守的契约：三处都用 pluginShortcutEntries()，
   且没人再各自拼 { pluginId, viewId } 的裸 entries（裸 entries 没有 name，
   会静默退回插件 ID 首字母 —— 正是这次要改掉的行为）。 */
const entriesModule = read('../src/pluginShortcutEntries.js');
assert.match(entriesModule, /pluginViews\.map\(/, '取数模块必须从 pluginViews 现取（插件是异步注册的）');
assert.match(entriesModule, /name: pluginDisplayName\(pv\.pluginId, pv\.title\)/, 'entries 必须带上显示名（自动分配字母的数据源）');

for (const [file, src] of [['shell.js', shell], ['settings.js', settings], ['commandPalette.js', palette]]) {
  assert.match(src, /pluginShortcutEntries\(\)/, `${file} 必须用统一取数口径 pluginShortcutEntries()`);
  assert.doesNotMatch(
    src,
    /pluginViews\.map\(\((?:v|pv)\) => \(\{ pluginId: \1\.pluginId, viewId: \1\.id \}\)/,
    `${file} 不许再各自拼裸 entries —— 没有 name 就会静默退回插件 ID 首字母`,
  );
}
// settings 改从 entries 取名字后，不该再自己查一遍显示名（两处取数不同源就会显示不一致）
assert.doesNotMatch(settings, /pluginDisplayName\(/, '设置页的名字必须取自 entries，不要自己再查一遍显示名');

const styles = read('../src/styles.css');
// v0.52.2 回归守卫：徽标此前 opacity:0 却仍占 ~45px 布局宽度，把分到字母的插件行
// 挤到「标签逐字断行 + 插件徽标竖排」。现在必须是绝对定位悬浮（不参与 flex 布局）、
// 不可命中鼠标；标签单行省略；徽标禁止折行 —— 三条缺一不可。
assert.match(styles, /\.nav \.nav-kbd \{ position: absolute;/, '侧栏快捷键徽标必须绝对定位悬浮（in-flow 会挤折标签与插件徽标）');
assert.match(styles, /\.nav \.nav-kbd \{ position: absolute;[^}]*pointer-events: none;/, '悬浮徽标不能拦截行内点击');
assert.doesNotMatch(styles, /\.nav \.nav-kbd \{[^}]*margin-left/, '徽标回到文档流 = 回到「隐形占位挤折行」的 bug');
assert.match(styles, /\.nav button \.lb \{ min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; \}/, '侧栏标签必须单行省略（CJK 的 min-content 只有 1 个字宽，允许折行就会逐字断行）');
assert.match(styles, /\.nav \.pv-count \{ margin-left: auto; flex: none; white-space: nowrap;/, '「插件」徽标必须禁止被 flex 压缩折行（竖排徽标）');
assert.match(styles, /\.nav button:hover \.nav-kbd, \.nav button\.on \.nav-kbd, \.nav button:focus-visible \.nav-kbd \{ opacity: 1; \}/, '徽标必须在悬停 / 选中 / 聚焦时现形');
assert.match(styles, /\.nav \.nav-kbd \{ color: var\(--ink-3\); background: var\(--paper\); border: 1px solid var\(--line\); \}/, '≥901px 浅色侧栏必须覆盖徽标配色（不透明底才能盖住底下叠着的插件徽标）');
assert.match(styles, /\.shortcut-hint\{/, '设置页提示行必须有样式');
assert.match(styles, /\.plugin-shortcut-block\{/, '设置页插件快捷键块必须有样式');

/* ── 8. 番茄专注的常驻试听按钮也在本批次（版本断言在 test-pomodoro.mjs）── */
const pomodoro = read('../public/plugins/pomodoro/main.js');
assert.match(pomodoro, /head\.append\(toggle, previewBtn\)/, '番茄专注：试听按钮必须挂在提醒面板头部');

console.log('PASS: 插件快捷键（中文名拼音首字母自动分配 / 显式优先 / 撞车退回插件 ID / 输入安全）与侧栏徽标、右键菜单、命令面板、设置页接线');
