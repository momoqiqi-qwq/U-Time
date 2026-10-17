import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AWARD_CONCURRENCY_KEY, AWARD_CONCURRENCY_DEFAULT, AWARD_CONCURRENCY_MAX, AWARD_CONCURRENCY_CHOICES,
  clampConcurrency, runPool,
} from "../public/plugins/cppu-notify/award-pool.js";

/* 警大获奖名单「取数并发」的行为测试。
   为什么单独一个文件：并发池的实现在 award-pool.js（纯函数），但**接线**在 main.js 里，
   而 main.js 是宿主 new Function("tide", …) 包出来的经典脚本，测试 import 不了它 ——
   所以这里一半是真跑池子、一半是对 main.js 做静态接线断言（与 test-cppu-award.mjs 同思路）。

   被它拦住的三类真 bug：
   ① 池子把结果按**完成顺序**放回去 → 名单顺序、进度计数、失败归类全乱（必须按下标落位）；
   ② worker 抛错把整轮打断 → 一条通知超时，剩下几十条全不读（必须记成 { ok:false } 继续跑）；
   ③ 视图卸载后 worker 还继续往门户发请求（必须靠 opts.stop 断掉）。 */

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ── 1. 并发数口径 ── */
assert.equal(AWARD_CONCURRENCY_DEFAULT, 3, "默认并发 3");
assert.equal(AWARD_CONCURRENCY_MAX, 8, "上限 8");
assert.deepEqual([...AWARD_CONCURRENCY_CHOICES], [1, 2, 3, 4, 5, 6, 8], "设置页档位");
assert.equal(clampConcurrency(1), 1);
assert.equal(clampConcurrency("4"), 4, "storage 里存的可能是字符串");
assert.equal(clampConcurrency(8), 8);
assert.equal(clampConcurrency(9), 8, "超过上限要压回 8");
assert.equal(clampConcurrency(0), AWARD_CONCURRENCY_DEFAULT, "0 会让一个 worker 都不起 —— 回默认值");
assert.equal(clampConcurrency(-3), AWARD_CONCURRENCY_DEFAULT);
assert.equal(clampConcurrency(2.7), 2, "小数向下取整");
assert.equal(clampConcurrency(undefined), AWARD_CONCURRENCY_DEFAULT, "没设置过用默认值");
assert.equal(clampConcurrency(null), AWARD_CONCURRENCY_DEFAULT);
assert.equal(clampConcurrency("abc"), AWARD_CONCURRENCY_DEFAULT);
assert.equal(clampConcurrency(NaN), AWARD_CONCURRENCY_DEFAULT);
assert.equal(clampConcurrency(5, 3), 3, "显式上限优先");

/* ── 2. 设置页与插件两侧的口径必须一致 ──
   设置页在 src/（前端 bundle），插件在 public/plugins/（插件 bundle），两边不能互相 import，
   所以键名 / 默认值 / 档位是各自写死的两份 —— 只有测试能把它们拴在一起。
   cppuAward.js 顶层就 import 了 ui.js / store.js（要 document），Node 里跑不起来，只能读源码。 */
const cardSource = read("../src/views/settings/cppuAward.js");
assert.match(cardSource, new RegExp(`export const AWARD_CONCURRENCY_KEY = "${AWARD_CONCURRENCY_KEY}"`), "设置页键名必须与插件一致");
assert.match(cardSource, new RegExp(`export const AWARD_CONCURRENCY_DEFAULT = ${AWARD_CONCURRENCY_DEFAULT};`), "设置页默认值必须与插件一致");
assert.match(cardSource, new RegExp(`export const AWARD_CONCURRENCY_MAX = ${AWARD_CONCURRENCY_MAX};`), "设置页上限必须与插件一致");
const choicesInCard = (cardSource.match(/const CONCURRENCY_CHOICES = \[([^\]]*)\];/) || [])[1];
assert.ok(choicesInCard, "设置页要有档位数组 CONCURRENCY_CHOICES");
assert.deepEqual(
  choicesInCard.split(",").map((s) => Number(s.trim())),
  [...AWARD_CONCURRENCY_CHOICES],
  "设置页下拉里的档位必须与 AWARD_CONCURRENCY_CHOICES 逐项相同",
);
assert.match(cardSource, /读取并发数/, "设置行要有中文标签");
assert.match(cardSource, /"aria-label": "读取获奖通知时的并发数"/, "下拉要有 aria-label");
assert.match(cardSource, /normalizeAwardConcurrency\(store\(\)\[AWARD_CONCURRENCY_KEY\]/, "初值要过一遍归一化");
assert.match(cardSource, /S\.persistSoon\(\)/, "改完要落盘");

/* ── 3. 池子：真的同时跑，且结果按下标落位 ── */
let inflight = 0, peak = 0;
const started = [];
const order = await runPool([...Array(9).keys()], 3, async (n) => {
  inflight += 1; peak = Math.max(peak, inflight); started.push(n);
  await sleep(4);
  inflight -= 1;
  return n * 10;
});
assert.equal(peak, 3, "9 条任务 / 并发 3 ⇒ 同时在飞的最多 3 个");
assert.equal(started.length, 9, "每条任务都要跑到");
assert.deepEqual(order.map((s) => s.value), [0, 10, 20, 30, 40, 50, 60, 70, 80],
  "结果必须按输入下标落位，不能按完成顺序");
assert.equal(order.filter((s) => s.ok).length, 9);
assert.deepEqual(started.slice(0, 3), [0, 1, 2], "前三个下标先各占一个 worker");

// 并发 1 = 严格串行（用户选「逐个读取」时不许偷偷并发）
let peak1 = 0, live1 = 0;
await runPool([...Array(6).keys()], 1, async () => {
  live1 += 1; peak1 = Math.max(peak1, live1);
  await sleep(2);
  live1 -= 1;
});
assert.equal(peak1, 1, "并发 1 必须一次只跑一个");

// 任务数少于并发数：worker 数不超过任务数，不做多余的空转
let peakFew = 0, liveFew = 0;
await runPool([1, 2], 6, async () => {
  liveFew += 1; peakFew = Math.max(peakFew, liveFew);
  await sleep(2);
  liveFew -= 1;
});
assert.equal(peakFew, 2, "只有 2 条任务时最多 2 个在飞");

// 越界 / 非法档位落到池子里也要收敛：0 与 99 分别走默认值与上限
let peakZero = 0, liveZero = 0;
await runPool([...Array(9).keys()], 0, async () => {
  liveZero += 1; peakZero = Math.max(peakZero, liveZero);
  await sleep(2);
  liveZero -= 1;
});
assert.equal(peakZero, AWARD_CONCURRENCY_DEFAULT, "limit=0 ⇒ 用默认并发，不是 0 个");
let peakBig = 0, liveBig = 0;
await runPool([...Array(20).keys()], 99, async () => {
  liveBig += 1; peakBig = Math.max(peakBig, liveBig);
  await sleep(2);
  liveBig -= 1;
});
assert.equal(peakBig, AWARD_CONCURRENCY_MAX, "limit=99 ⇒ 压到上限 8");

// 空列表：立刻返回空数组，不卡住（获奖名单一轮可能一条候选都没有）
assert.deepEqual(await runPool([], 3, async () => 1), []);
assert.deepEqual(await runPool(null, 3, async () => 1), []);

/* ── 4. 失败只落自己那一格 ── */
const mixed = await runPool([1, 2, 3, 4, 5], 2, async (n) => {
  if (n === 3) throw new Error("HTTP 302 登录可能已过期");
  return n;
});
assert.equal(mixed.filter((s) => s.ok).length, 4, "一条失败不该带走其余四条");
assert.equal(mixed[2].ok, false);
assert.equal(mixed[2].error.message, "HTTP 302 登录可能已过期", "原始错误要原样交给调用方归类（会话失效 / 网络抖动）");
assert.deepEqual(mixed.map((s) => s.ok), [true, true, false, true, true], "失败的下标不能错位");

/* ── 5. stop：视图卸载后不再派新任务（已经在飞的照旧跑完） ── */
let dispatched = 0;
const stopped = await runPool([...Array(10).keys()], 3, async (n) => {
  dispatched += 1;
  await sleep(3);
  return n;
}, { stop: () => dispatched >= 4 });
assert.equal(dispatched, 4, "stop 生效后不再派第 5 条");
assert.equal(stopped.filter(Boolean).length, 4);
assert.equal(stopped[4], undefined, "没轮到的格子是 undefined（区分「没试过」与「失败」）");

/* ── 6. 并发确实把等待叠起来了（不然这功能白做） ── */
const items = [...Array(12).keys()];
const t0 = Date.now();
await runPool(items, 1, async () => { await sleep(20); });
const serialMs = Date.now() - t0;
const t1 = Date.now();
await runPool(items, 6, async () => { await sleep(20); });
const concMs = Date.now() - t1;
assert.ok(concMs < serialMs * 0.5, `并发 6 应显著快于串行：串行 ${serialMs}ms / 并发 ${concMs}ms`);

/* ── 7. 接线：main.js 两段同步循环都改走池子，且读的是同一个设置键 ── */
const source = read("../public/plugins/cppu-notify/main.js");
// main.js 近 300 KB：断言失败时 assert 会把整份源码打进错误里（一次几十万字符），
// 所以这里统一用只抛一句话的探针，失败信息里只留正则与标签。
const has = (re, label) => { if (!re.test(source)) throw new Error(`main.js 缺少：${label || re}`); };
const hasNot = (re, label) => { if (re.test(source)) throw new Error(`main.js 不该有：${label || re}`); };
has(/import\("\/plugins\/cppu-notify\/award-pool\.js"\)/, "动态 import 并发池");
has(/function ensurePoolMod\(\) \{/);
has(/poolLoading = import\([\s\S]{0,120}?\.catch\(\(\) => \{ poolLoading = null; poolMod = null; return null; \}\)/, "池子模块读不到要退化成串行，不许抛");
has(/async function awConcurrency\(\) \{/);
has(/await tide\.storage\.get\(poolMod\.AWARD_CONCURRENCY_KEY, poolMod\.AWARD_CONCURRENCY_DEFAULT\)/, "从插件 storage 读并发数");
has(/return poolMod\.clampConcurrency\(raw\)/, "读出来还要过一遍口径");
has(/async function awRun\(items, limit, worker, stop\) \{/);
has(/return poolMod\.runPool\(items, limit, worker, \{ stop \}\)/, "awRun 转调 runPool");
// 两段循环都换掉了：源码里不该再有那条串行 for
hasNot(/for \(let i = 0; i < batch\.length; i\+\+\)/, "候选正文 / 附件两段串行 for 都要换成池子");
has(/const conc = await awConcurrency\(\);\n      const pace = conc > 1 \? ` · 并发 \$\{conc\}` : "";\n      let done = 0;\n      await awRun\(batch, conc, async \(it\) => \{/,
  "候选正文：并发读 + 进度按「已读完」计数");
has(/await awRun\(batch, conc, async \(\{ rid, att \}\) => \{/, "附件：也要并发读");
has(/awState\.progress = `正在读正文筛选获奖名单 \$\{done\}\/\$\{batch\.length\}（候选 \$\{cands\.length\} 条）\$\{pace\}`/);
has(/awState\.progress = `正在读附件里的获奖名单 \$\{done\}\/\$\{batch\.length\}（\$\{att\.name\}）\$\{pace\}`/);
assert.equal((source.match(/\}, \(\) => !el\.isConnected\);/g) || []).length, 2, "两段循环都要在视图卸载后停止派新任务");
// 「扫过」台账的读取要合流：并发进 markAffixScanned 时不能各建一个空对象把旧标记盖掉
has(/let affixScannedLoading = null;/);
// 关键在「先读完 storage 再整体赋值」：中间不许出现 `affixScanned = {};` 这种先占位的写法，
// 否则并发进来的第二个调用会拿着空对象改、再被第一个调用整份盖回去。
has(/if \(!affixScannedLoading\) \{[\s\S]{0,600}?affixScanned = box;[\s\S]{0,200}?return box;/,
  "loadAffixScanned 要先 await 到 box 再整体赋值");
hasNot(/affixScanned = \{\};/, "不许先塞空对象占位");

console.log("PASS: 获奖名单取数并发（并发数口径与设置页一致 / 池子按输入下标落位且真重叠 / 单条失败不打断整轮 / 视图卸载停止派新任务 / 两段串行循环改接池子 / 扫过台账读取合流）");
