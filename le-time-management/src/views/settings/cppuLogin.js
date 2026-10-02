import { el, toast } from "../../ui.js";
import * as S from "../../store.js";

export const normalizeLoginRetries = value => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 5 ? Number(value) : 2;

export function createCppuLoginCard() {
  const storage = S.getState().plugins?.["cppu-notify"]?.storage || {};
  const retries = el("select", { "aria-label": "警大登录失败后自动重试次数" },
    ...[0, 1, 2, 3, 4, 5].map(n => el("option", { value: String(n) }, n === 0 ? "0 次（关闭重试）" : n + " 次")));
  retries.value = String(normalizeLoginRetries(storage.loginRetries ?? 2));
  retries.addEventListener("change", () => {
    const value = normalizeLoginRetries(retries.value);
    S.pluginState("cppu-notify").storage.loginRetries = value;
    S.persistSoon();
    retries.value = String(value);
    toast("已保存，下次登录生效");
  });
  return el("div", { class: "card set-card" },
    el("h2", {}, "警大登录设置"),
    el("div", { class: "setting-row" }, el("b", {}, "失败后自动重试次数"), retries),
    el("p", { class: "set-hint" }, "默认重试 2 次，加上首次最多尝试 3 次。适用于警大门户手动及自动登录；密码错误、账号锁定、请求过频不重试。"),
    el("p", { class: "set-hint" }, "账号、记住密码和自动登录开关在警大门户登录页管理。此设置沿用已保存的重试次数，不影响账号和登录票据。"));
}
