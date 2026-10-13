import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../src/store.js";

const memory = new Map();
globalThis.localStorage = { getItem: (k) => memory.get(k), setItem: (k, v) => memory.set(k, v) };

await S.initStore({ tasks: [], blocks: [], settings: {}, plugins: {} });
S.addBlock({ id: "late", date: "2026-09-09", start: "13:00", title: "下午" });
S.addBlock({ id: "early", date: "2026-09-09", start: "09:00", title: "上午" });

const first = S.blocksOf("2026-09-09");
assert.deepEqual(first.map((b) => b.id), ["early", "late"]);
first.pop();
assert.deepEqual(S.blocksOf("2026-09-09").map((b) => b.id), ["early", "late"], "blocksOf 返回副本，调用方不能改坏缓存");

S.updateBlock("late", { start: "08:30" });
assert.deepEqual(S.blocksOf("2026-09-09").map((b) => b.id), ["late", "early"], "更新开始时间后缓存失效并重新排序");

S.removeBlock("early");
assert.deepEqual(S.blocksOf("2026-09-09").map((b) => b.id), ["late"], "删除时间块后缓存失效");

S.replaceAll({ tasks: [], blocks: [{ id: "fresh", date: "2026-09-09", start: "10:00" }], settings: {}, plugins: {} });
assert.deepEqual(S.blocksOf("2026-09-09").map((b) => b.id), ["fresh"], "整体替换数据后缓存失效");

/* 自定义背景已在 v0.55.0 移除：settings.background 里可能压着几百 KB 的 base64 图片，
   归一化必须把它剥掉。放在归一化处而不是写一次性迁移，是因为它同时覆盖「打开本地数据」
   与「导入旧备份」两条路径 —— 这里走的是 replaceAll（导入那条）。 */
S.replaceAll({
  tasks: [], blocks: [], plugins: {},
  settings: { theme: "classic", background: { enabled: true, image: "data:image/png;base64," + "A".repeat(4096) } },
});
assert.ok(!("background" in S.getState().settings),
  "导入带 settings.background 的旧备份后，该键必须被剥掉（自定义背景已移除）");
assert.equal(S.getState().settings.theme, "classic", "剥掉 background 不能连带弄丢 settings 里的其他字段");

// 改动某一天时，只应让这一天的派生缓存失效。周视图会连续查询多天；若每次拖动一个
// 时间块都清空整张索引，其余 6 天会在同一轮渲染里重复扫描完整 blocks 数组。
let filterCalls = 0;
const trackedBlocks = new Proxy([
  { id: "day-a", date: "2026-09-10", start: "09:00" },
  { id: "day-b", date: "2026-09-11", start: "10:00" },
], {
  get(target, prop, receiver) {
    if (prop === "filter") filterCalls++;
    return Reflect.get(target, prop, receiver);
  },
});
await S.initStore({ tasks: [], blocks: [], settings: {}, plugins: {} });
S.getState().blocks = trackedBlocks;
S.blocksOf("2026-09-10");
S.blocksOf("2026-09-11");
assert.equal(filterCalls, 2, "首次查询两天时各扫描一次");
S.updateBlock("day-b", { start: "08:00" });
S.blocksOf("2026-09-10");
assert.equal(filterCalls, 2, "更新另一天后，未受影响日期应继续命中缓存");
assert.deepEqual(S.blocksOf("2026-09-11").map((b) => b.id), ["day-b"]);
assert.equal(filterCalls, 3, "受影响日期应重新扫描并排序");

/* ── 日期工具统一到 store（v0.206.0）──
   automation.js 原本自带 dateAdd / daysDiff 两份私有实现，跨月、跨年、闰年各写各的；
   统一到 store 之后这两条路径共用一份实现，边界必须在这里钉住。 */
assert.equal(S.daysBetween("2026-09-21", "2026-09-21"), 0, "同一天为 0");
assert.equal(S.daysBetween("2026-09-21", "2026-09-22"), 1, "相邻一天为 1");
assert.equal(S.daysBetween("2026-09-22", "2026-09-21"), -1, "反向为负（提醒窗口要用它判「还没到」）");
assert.equal(S.daysBetween("2026-01-31", "2026-02-01"), 1, "跨月");
assert.equal(S.daysBetween("2024-02-28", "2024-03-01"), 2, "闰年二月");
assert.equal(S.daysBetween("2025-12-31", "2026-01-01"), 1, "跨年");
assert.equal(S.daysBetween("2026-03-07", "2026-03-09"), 2, "夏令时切换日仍按整天算（本地零点构造，不受 23 小时日影响）");
assert.equal(S.addDays("2026-12-31", 1), "2027-01-01", "addDays 跨年");
assert.equal(S.addDays("2026-03-01", -1), "2026-02-28", "addDays 负数跨回二月");

const automationSrc = readFileSync(new URL("../src/automation.js", import.meta.url), "utf8");
const storeSrc = readFileSync(new URL("../src/store.js", import.meta.url), "utf8");
const mainSrc = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
assert.match(automationSrc, /S\.daysBetween\(/, "自动化的天数差要走 store 的 daysBetween");
assert.ok(!/function daysDiff\s*\(|function dateAdd\s*\(/.test(automationSrc),
  "automation.js 不许再自带 dateAdd / daysDiff（两套实现必然各自漂移）");
assert.ok(!/export const getSaveStatus/.test(storeSrc), "死代码 getSaveStatus 不许回潮（无人调用）");
// 启动路径走两次 = 两份定时器 / 两份监听。.then(f).catch(f) 在 f 抛错时会把 f 再调一次，
// 两参数形态才保证「恰好一次」（scripts 里的证据：2 次 vs 1 次）。
// 先剥注释再判：解释这条坑的注释里就会写着那个旧写法，不剥会命中自己。
const mainCode = mainSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
assert.match(mainCode, /,\s*\(\)\s*=>\s*initAutomation\(""\)/, "启动回调要用两参数 then");
assert.match(mainCode, /,\s*\(\)\s*=>\s*initLanPushGate\(""\)/, "局域网推送门也要用两参数 then");
assert.ok(!/\.catch\(\(\)\s*=>\s*init(Automation|LanPushGate)/.test(mainCode),
  "不许回到 .then(f).catch(f)：那会让初始化跑两遍");
assert.match(automationSrc, /clearInterval\(minuteTimer\)/, "重复初始化前要先清掉旧定时器");

console.log("PASS: blocksOf 按日期缓存、副本保护、精准失效/整体替换失效 + 旧数据里的 settings.background 被剥掉 + 日期工具统一与启动回调只跑一次");
