import { api } from "../../api.js";
import * as S from "../../store.js";
import { el, toast } from "../../ui.js";
import { toggleSwitch } from "../../switchControl.js";

export async function createLanCard({ settings, info, render }) {
    /* 局域网联动 */
    const st = S.getState().settings;
    st.lanPort ??= 27123;
    st.lanToken ??= Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 8);
    let lanStatus = { running: false, url: "" };
    try { lanStatus = await api.lanStatus(); } catch {}

    const lanCard = el("div", { class: "card set-card" },
      el("h2", {}, "局域网联动"),
    );
    const lanBody = el("div", { style: "margin-top:10px" });
    lanCard.append(lanBody);

    const renderLan = () => {
      lanBody.replaceChildren();
      // 回传开关：allow_push 是启动时烘进服务线程的，改完必须重启一次服务才真的生效，
      // 不然界面上开着、网络上其实还是关的 —— 那种「开关是装饰」的 bug 最难查。
      const pushSwitch = toggleSwitch({ checked: Boolean(st.lanPush), ariaLabel: "允许手机推回本机" });
      pushSwitch.addEventListener("change", async () => {
        st.lanPush = pushSwitch.checked;
        await S.saveNow();
        if (!lanStatus.running) {
          toast(st.lanPush ? "已允许回传（下次启动服务生效）" : "已关闭回传");
          return;
        }
        try {
          await api.lanStop();
          lanStatus = { running: true, url: await api.lanStart(st.lanPort, st.lanToken, st.lanPush) };
          toast(st.lanPush ? "已允许回传：手机每次推都要在这台电脑上点「接收」" : "已关闭回传");
          renderLan();
        } catch (e) {
          lanStatus = { running: false };
          renderLan();
          toast(`联动服务重启失败：${e.message || e}`);
        }
      });
      const pushRow = el("div", { class: "lan-push-row" },
        el("label", { class: "lan-push-label" },
          pushSwitch,
          el("span", {}, "允许手机把数据推回本机")),
        el("p", { class: "desc" },
          "关着的时候，网络上不存在任何能改掉这台电脑数据的路径 —— 手机只能读、只能勾选任务和加一条待办。",
          el("br"),
          "开着也不是直接覆盖：手机推过来的数据先进内存等着，必须在电脑上弹出确认、点「接收」才算数，且覆盖前先存一个恢复点。人不在电脑前就没接收，手机上那份会自己作废。",
        ),
      );
      // 状态行：两种状态下都展示，填满卡片下方空间
      const statusRow = (running, port, host) =>
        el("div", { style: "margin-top:14px;padding-top:12px;border-top:1px dashed var(--line)" },
          el("div", { style: "display:flex;flex-wrap:wrap;gap:6px 26px;font-size:calc(12.5px * var(--ui-text-scale));color:var(--ink-2)" },
            el("span", {}, "状态 ", running
              ? el("span", { style: "font-weight:600;color:var(--mint)" }, "● 运行中")
              : el("span", { style: "font-weight:600;color:var(--ink-3)" }, "○ 已停止")),
            port ? el("span", {}, "端口 ", el("b", {}, port)) : null,
            host ? el("span", {}, "本机地址 ", el("b", {}, host)) : null,
          ),
          running
            ? el("div", { style: "margin-top:6px;font-size:calc(12px * var(--ui-text-scale));color:var(--ink-3)" }, "手机需与电脑处于同一 Wi-Fi / 局域网，扫码或打开链接即可配对联动。")
            : el("div", { style: "margin-top:6px;font-size:calc(12px * var(--ui-text-scale));color:var(--ink-3)" }, "启动后手机浏览器 / 小程序可通过二维码或链接远程操作本机任务。"),
        );
      if (lanStatus.running) {
        const lanPort = (lanStatus.url.match(/:(\d+)/) || [])[1] || st.lanPort;
        const lanHost = (lanStatus.url.match(/^http:\/\/([^:/]+)/) || [])[1] || "";
        lanBody.append(
          el("div", { class: "path-code" }, lanStatus.url),
          el("div", { style: "display:flex;gap:14px;margin-top:12px;align-items:center" },
            el("img", { src: `${lanStatus.url.replace("/m?", "/qr.svg?")}`, style: "width:132px;height:132px;border-radius:10px;border:1px solid var(--line);background:#fff" }),
            el("div", { style: "flex:1" },
              el("div", { style: "display:flex;gap:8px;margin-top:10px;flex-wrap:wrap" },
                el("button", { class: "btn ghost sm", onclick: () => { navigator.clipboard?.writeText(lanStatus.url); toast("链接已复制"); } }, "复制链接"),
                el("button", {
                  class: "btn ghost sm",
                  onclick: async () => {
                    try { await api.openUrl(lanStatus.url); }
                    catch { window.open(lanStatus.url, "_blank"); }
                  },
                }, "从浏览器打开"),
                el("button", {
                  class: "btn danger sm",
                  onclick: async () => {
                    try { await api.lanStop(); }
                    catch (e) { toast(`停止失败：${e.message || e}`); return; }
                    // 关键：lanStop 成功后必须更新本地状态再重渲染，
                    // 否则 lanStatus 仍是 running，界面看起来「按了没反应」。
                    lanStatus = { running: false };
                    st.lanAuto = false;
                    S.saveNow();
                    toast("联动服务已停止");
                    renderLan();
                  },
                }, "停止服务"),
              ),
            ),
          ),
          pushRow,
          statusRow(true, lanPort, lanHost),
        );
      } else {
        const portIn = el("input", { type: "number", value: st.lanPort, style: "width:110px;height:34px;border:1px solid var(--line);border-radius:8px;padding:0 10px;background:#fff" });
        lanBody.append(
          el("div", { style: "display:flex;gap:8px;align-items:center;margin-top:4px" },
            el("span", { style: "font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2)" }, "端口"),
            portIn,
            el("button", {
              class: "btn pri sm",
              onclick: async () => {
                st.lanPort = Number(portIn.value) || 27123;
                st.lanAuto = true;
                S.saveNow();
                try {
                  lanStatus = { running: true, url: await api.lanStart(st.lanPort, st.lanToken) };
                  toast("联动服务已启动");
                  renderLan();
                } catch (e) { toast(`启动失败：${e.message || e}`); }
              },
            }, "启动服务"),
          ),
          statusRow(false, st.lanPort, ""),
        );
      }
    };
    renderLan();

  return lanCard;
}
