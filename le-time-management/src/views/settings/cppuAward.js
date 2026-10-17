import { el, toast } from "../../ui.js";
import * as S from "../../store.js";

// 「警大获奖名单」设置卡：人名榜开关 + 读取并发数。
// 两项都写在插件 storage 上（与插件侧 tide.storage 同一份），插件视图每次进入 / 刷新时重读。
export const AWARD_CONCURRENCY_KEY = "awardConcurrency";
export const AWARD_CONCURRENCY_DEFAULT = 3;
export const AWARD_CONCURRENCY_MAX = 8;
// 与 public/plugins/cppu-notify/award-pool.js 的 clampConcurrency 同一口径：
// 非数字、小于 1、越界一律回默认值 3（0 会让并发池一个 worker 都起不来，榜单直接空掉）。
export const normalizeAwardConcurrency = value => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, AWARD_CONCURRENCY_MAX) : AWARD_CONCURRENCY_DEFAULT;
};
// 下拉档位。与 award-pool.js 的 AWARD_CONCURRENCY_CHOICES 必须一致 ——
// scripts/test-cppu-award-pool.mjs 会把这份源码里的数组抠出来逐项对一遍。
const CONCURRENCY_CHOICES = [1, 2, 3, 4, 5, 6, 8];

export function createCppuAwardCard() {
  const store = () => S.pluginState("cppu-notify").storage;
  const on0 = store().namesBoard === true;
  const label = el("span", { class: "plugin-switch-label" }, on0 ? "已开启" : "已关闭");
  const sw = el("button", {
    class: `switch${on0 ? " on" : ""}`,
    role: "switch",
    "aria-checked": String(on0),
    "aria-label": `${on0 ? "关闭" : "开启"}人名榜`,
    onclick: (e) => {
      const on = !e.currentTarget.classList.contains("on");
      e.currentTarget.classList.toggle("on", on);
      e.currentTarget.setAttribute("aria-checked", String(on));
      e.currentTarget.setAttribute("aria-label", `${on ? "关闭" : "开启"}人名榜`);
      label.textContent = on ? "已开启" : "已关闭";
      store().namesBoard = on;
      S.persistSoon();
      toast(on ? "已开启人名榜，重新打开「警大获奖名单」即可看到" : "已关闭人名榜");
    },
  });
  const conc = el("select", { "aria-label": "读取获奖通知时的并发数" },
    ...CONCURRENCY_CHOICES.map(n => el("option", { value: String(n) }, n === 1 ? "1（逐个读取）" : `${n} 条同时读`)));
  conc.value = String(normalizeAwardConcurrency(store()[AWARD_CONCURRENCY_KEY] ?? AWARD_CONCURRENCY_DEFAULT));
  conc.addEventListener("change", () => {
    const value = normalizeAwardConcurrency(conc.value);
    store()[AWARD_CONCURRENCY_KEY] = value;
    S.persistSoon();
    conc.value = String(value);
    toast("已保存，下次刷新获奖名单生效");
  });
  return el("div", { class: "card set-card" },
    el("h2", {}, "警大获奖名单"),
    el("div", { class: "setting-row" }, el("b", {}, "人名榜"), label, sw),
    el("p", { class: "set-hint" }, "默认关闭。开启后「警大获奖名单」视图多出一档「人名榜」：把个人获奖者与团体成员一并算到人头上，按获奖数量排名；名次数字前 10 名绿色、11–20 名黄色、其余红色。"),
    el("p", { class: "set-hint" }, "关掉时这一档不出现，不影响「奖项项目」与「获奖排名」。名单仍来自通知正文里明确的获奖段落，团体成员只在通知列了成员时才计入。"),
    el("div", { class: "setting-row" }, el("b", {}, "读取并发数"), conc),
    el("p", { class: "set-hint" }, "默认 3 条同时读，可选 1–8。获奖名单一轮要读几十条通知正文、还可能下载若干附件台账，过去是一条读完再读下一条；并发读把这段等待叠起来，同步明显更快。"),
    el("p", { class: "set-hint" }, "数字越大越快，但同时打到学校的请求也越多 —— 门户偶有超时或限流时调回 1–3 更稳。改完点「刷新」（或重新打开）生效，不影响已保存的名单与登录状态。"));
}
