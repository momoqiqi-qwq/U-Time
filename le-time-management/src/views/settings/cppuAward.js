import { el, toast } from "../../ui.js";
import * as S from "../../store.js";

// 「警大获奖名单」设置卡：只放一个人名榜开关（默认关闭）。
// 开关写在插件 storage 上（与插件侧 tide.storage 同一份），插件视图每次进入时重读。
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
  return el("div", { class: "card set-card" },
    el("h2", {}, "警大获奖名单"),
    el("div", { class: "setting-row" }, el("b", {}, "人名榜"), label, sw),
    el("p", { class: "set-hint" }, "默认关闭。开启后「警大获奖名单」视图多出一档「人名榜」：把个人获奖者与团体成员一并算到人头上，按获奖数量排名；名次数字前 10 名绿色、11–20 名黄色、其余红色。"),
    el("p", { class: "set-hint" }, "关掉时这一档不出现，不影响「奖项项目」与「获奖排名」。名单仍来自通知正文里明确的获奖段落，团体成员只在通知列了成员时才计入。"));
}
