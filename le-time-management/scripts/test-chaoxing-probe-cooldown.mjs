/* 作业探测的 40 秒按记录冷却（v0.242.2）：
   过去 40 秒内已获取过消息的记录不再重复拉取，40 秒之后才能再拉取。

   为什么值得单独立一个脚本：三条刷新入口（打开插件自动刷新、手点「刷新」、
   任务栏角标每 5 分钟后台刷新）都汇到 probePendingWorks()，冷却是它们共用的
   那道闸门 —— 这里用可控时钟把「40 秒」这条时间边界钉死，不靠 sleep 赌时序。

   harness 与 test-chaoxing-taskbar-badge.mjs 同族：vm 里跑插件源码，
   注入 mock tide；Date 换成可推演的 FakeDate，冷却窗口才能精确走到 39s / 40s。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../public/plugins/chaoxing-notify/main.js', import.meta.url), 'utf8');

const workRef = (workId) => Buffer.from(encodeURIComponent(JSON.stringify({
  att_web: { examOrWorkId: workId, url: `https://mooc1.chaoxing.com/work?id=${workId}` },
}))).toString('base64');
const fixture = (id, workId, body = '结束时间：2099-01-01 09:00') => ({
  id, title: '作业：测试', body, insertTime: Date.now(),
  raw: { rtf_content: `<iframe name="${workRef(workId)}">` },
});

/* 可控时钟：插件内的 Date.now() / new Date() 全部走它。
   基址取真实当前时间 —— 夹具的 insertTime 是真实毫秒戳，recentNoDueWorks()
   的「近 60 天」判断要与它在同一时间轴上，否则无截止作业会被静默丢出候选。 */
const RealDate = Date;
let clock = RealDate.now();
class FakeDate extends RealDate {
  constructor(...args) { if (!args.length) super(clock); else super(...args); }
  static now() { return clock; }
}
const advance = (ms) => { clock += ms; };

async function harness() {
  const rows = [
    fixture('open', 1),                                  // 未截止未提交 → todos()
    fixture('late', 2, '结束时间：2001-01-01 09:00'),      // 已逾期未提交 → lateAll()
    fixture('nodue', 4, ''),                             // 无截止近期作业 → recentNoDueWorks()
  ];
  const storage = { inboxCache: rows, workStatus: {} };
  const calls = [];
  const tide = {
    ui: { registerView() {} },
    storage: { get: async (k, f) => storage[k] ?? f, set: async (k, v) => { storage[k] = v; } },
    http: {
      session: async () => 'sid',
      // 落地页标题「作业作答」⇒ 记 unsent：它**不退出**候选池，正是「连着刷新会重复拉」的那批
      fetch: async (sid, method, url) => { calls.push(url); return { body: '<title>作业作答</title>', cookies: [] }; },
    },
  };
  const ctx = vm.createContext({ tide, console, URL, atob, Date: FakeDate, setInterval: () => 1, clearInterval: () => {} });
  vm.runInContext(source.replace('  tide.ui.registerView({',
    '  globalThis.test = { state, probePendingWorks, probeTimes, ensurePrefs };\n  tide.ui.registerView({'), ctx);
  await new Promise(resolve => setImmediate(resolve));
  return { storage, calls, tide, ...ctx.test };
}

const h = await harness();
await h.ensurePrefs();
h.state.loggedIn = true;
assert.equal(h.probeTimes.size, 0, '首轮之前没有任何探测记录');

/* ── 首轮：三类候选各探一次（未截止 ≤6 / 逾期 ≤4 / 无截止近期 ≤4 的编排不变）── */
await h.probePendingWorks();
assert.equal(h.calls.length, 3, '首轮把三类候选各拉一次');
assert.equal(h.probeTimes.size, 3, '每条记录都记下获取时间戳');
const firstRound = [...h.calls];
assert.ok(firstRound.every((u) => /id=[124]$/.test(u)), '候选就是夹具里的三条作业');

/* ── 核心：40 秒内不重复拉取 ──
   模拟「打开插件自动刷新刚跑完，用户马上又点一下刷新」：一条请求都不该再发。 */
await h.probePendingWorks();
assert.equal(h.calls.length, 3, '40 秒内已获取过消息的记录不再重复拉取');

/* 39 秒仍在窗口内（边界内侧） */
advance(39000);
await h.probePendingWorks();
assert.equal(h.calls.length, 3, '39 秒仍在冷却窗口内');

/* 满 40 秒解禁（边界外侧：elapsed >= 40000 即放行），按相同顺序重探 */
advance(1000);
await h.probePendingWorks();
assert.equal(h.calls.length, 6, '四十秒之后才能再拉取');
assert.deepEqual(h.calls.slice(3), firstRound, '解禁后按相同顺序重探，排序口径未变');

/* ── 冷却不阻塞新记录：刚同步进来、从没探过的作业照样排进本轮 ── */
h.state.inbox.push(fixture('fresh', 9));
await h.probePendingWorks();
assert.equal(h.calls.length, 7, '冷却只挡已获取过的记录，新记录照常拉取');
assert.ok(h.calls[6].includes('id=9'), '新记录这一轮就探到');

/* ── 与冷却无关的既有口径：探到已提交的永远跳过 ── */
h.state.workStatus[1] = 'grading';
advance(40000);
await h.probePendingWorks();
assert.equal(h.calls.length, 10, '解禁后重探：grading 那条不再拉，其余三条再拉');
assert.ok(!h.calls.slice(7).some((u) => u.includes('id=1')), '已提交（grading）永远不再拉取');

/* ── 失败也记时间戳：请求已经打出去，冷却同样生效，不会趁着失败连续重打 ── */
let failed = 0;
h.tide.http.fetch = async () => { failed += 1; throw new Error('网络抖动'); };
h.state.workStatus[2] = 'unsent';
advance(40000);
await h.probePendingWorks();
assert.equal(failed, 3, '解禁后三个未提交候选各试一次（含一次失败）');
await h.probePendingWorks();
assert.equal(failed, 3, '失败后同样进入 40 秒冷却，不连续重打');

console.log('PASS: 作业探测 40 秒按记录冷却 —— 首轮全探、窗口内零重复、39/40 秒边界、新记录不挡、grading 跳过、失败也冷却');
