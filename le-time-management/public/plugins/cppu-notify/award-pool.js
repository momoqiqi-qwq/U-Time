// 警大获奖名单「取数并发」的纯逻辑：并发数口径 + 一个有界 worker 池。
//
// 单独成模块有两个理由：
//  ① main.js 是宿主用 new Function("tide", …) 包出来的经典脚本，里面不能写顶层
//     import/export，只能运行时动态 import —— 于是池子得是一个真的 ES 模块；
//  ② 这里全是纯函数，scripts/test-cppu-award-pool.mjs 能把它们真跑起来
//     （main.js 里的两段循环测试碰不到，只能靠读源码断言接线）。
//
// 为什么需要池：获奖名单一轮要读几十条通知正文（每条一次详情请求）、还要下载解析附件，
// 过去是彻头彻尾的串行 for await —— AWARD_NOTICE_MAX 条正文按门户单次 300~600ms 算，
// 就是 20~40 秒，状态行一直卡在同一格上，用户以为卡死了。门户没有并发上限的公告，
// 所以这里用「有界池 + 默认 3」在「快」与「对学校服务器礼貌」之间取平衡。

// 设置项键名。与 src/views/settings/cppuAward.js 共用一份插件 storage
// （桌面端写 S.pluginState("cppu-notify").storage，插件侧读 tide.storage）。
export const AWARD_CONCURRENCY_KEY = "awardConcurrency";
export const AWARD_CONCURRENCY_DEFAULT = 3;
// 上限 8：再多，门户侧排队 + tp_up 票据 + 宿主 http 会话都更容易抖，
// 本地也压不出更多吞吐（瓶颈是门户的响应时间，不是本机 CPU）。
export const AWARD_CONCURRENCY_MAX = 8;
// 设置页下拉里的档位：与 src/views/settings/cppuAward.js 的 CONCURRENCY_CHOICES 必须一致
// （scripts/test-cppu-award-pool.mjs 会从那份源码里把数组抠出来对一遍）。
export const AWARD_CONCURRENCY_CHOICES = [1, 2, 3, 4, 5, 6, 8];

// 口径：非数字 / 小于 1 / 越界一律回默认值 3。
// 写盘的是设置页、读盘的是插件，两边都过这一道 —— 手改过的 storage 不会把池开成 0
// （0 会让所有 worker 立刻退出，一条正文都不读，榜单变成空的）。
export function clampConcurrency(value, max = AWARD_CONCURRENCY_MAX) {
  const n = Number(value);
  if (!Number.isFinite(n)) return AWARD_CONCURRENCY_DEFAULT;
  const i = Math.floor(n);
  if (i < 1) return AWARD_CONCURRENCY_DEFAULT;
  const cap = Math.floor(Number(max));
  return Math.min(i, Number.isFinite(cap) && cap >= 1 ? cap : AWARD_CONCURRENCY_MAX);
}

// 有界 worker 池：limit 个 worker 抢同一个游标，结果按**输入顺序**放回数组。
// worker 抛错不打断整轮（该格记成 { ok: false, error }），由调用方决定怎么归类 ——
// 名单同步里「会话失效」与「网络抖动」要分开处理，池子不替它下结论。
// opts.stop() 为真时立刻停止**取新任务**（已经在飞的请求照旧跑完）：视图卸载后不再往门户发请求。
// 返回值里 undefined 表示「这一格没轮到就跑完了」，调用方据此区分「失败」与「没试过」。
export async function runPool(items, limit, worker, opts = {}) {
  const list = Array.from(items || []);
  const out = new Array(list.length);
  if (!list.length) return out;
  const lanes = Math.min(clampConcurrency(limit), list.length);
  let cursor = 0;
  const runners = [];
  for (let i = 0; i < lanes; i++) {
    runners.push((async () => {
      for (;;) {
        if (typeof opts.stop === "function" && opts.stop()) return;
        const index = cursor++;
        if (index >= list.length) return;
        try { out[index] = { ok: true, value: await worker(list[index], index) }; }
        catch (error) { out[index] = { ok: false, error }; }
      }
    })());
  }
  await Promise.all(runners);
  return out;
}
