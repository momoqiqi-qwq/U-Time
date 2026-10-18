import { api } from "../../api.js";
import { el, toast } from "../../ui.js";
import { createDisclosure } from "../../disclosure.js";

/* 「赞助支持」设置卡（设置 → 赞助支持）。
 *
 * 收款码是**静态资源**：public/support/sponsor-qr.png（微信 + 支付宝聚合码）。
 * 换图只替换这个文件，命名与路径固定，不必回来改代码。改动本目录下任何东西
 * 都必须升版本号（AGENTS.md 铁律一：public/ 也算产品代码）。
 *
 * 为什么单独占一个设置分类而不是塞进「关于」：收款码是用户主动去找的东西，
 * 「关于」里已经有更新、卸载、免责声明、开源清单四段，再加一张图会被埋掉。
 */
export const SPONSOR_QR_SRC = "/support/sponsor-qr.png";
export const SPONSOR_QR_FILENAME = "U-Time-赞助收款码.png";

export function createSupportCard() {
  const card = el("div", { class: "card set-card support-card" }, el("h2", {}, "赞助支持"));

  /* ── 收款码：点一下在卡内放大 ─────────────────────────────────────────────
     不做全屏浮层：浮层要自己处理 Android 返回键（backNav.js）与焦点陷阱，
     而收款码只需要「大到能被另一台手机扫到」。卡内放大到 420px 已经够，
     且布局连续、窄屏不会溢出。 */
  const img = el("img", {
    class: "support-qr-img",
    src: SPONSOR_QR_SRC,
    alt: "微信与支付宝赞助收款码",
    loading: "lazy",
    decoding: "async",
    draggable: "false",
  });
  const qrHint = el("span", { class: "support-qr-hint" }, "点一下放大");
  const qrFrame = el("button", {
    class: "support-qr",
    type: "button",
    "aria-label": "放大赞助收款码",
    "aria-pressed": "false",
    title: "点一下放大 / 缩小收款码",
    onclick: () => {
      const zoom = !qrFrame.classList.contains("is-zoom");
      qrFrame.classList.toggle("is-zoom", zoom);
      qrFrame.setAttribute("aria-pressed", String(zoom));
      qrFrame.setAttribute("aria-label", `${zoom ? "缩小" : "放大"}赞助收款码`);
      qrHint.textContent = zoom ? "点一下缩小" : "点一下放大";
    },
  }, img);
  // 图片缺位（换图时文件名写错、打包漏带）要说话，不能留一个空框。
  img.addEventListener("error", () => {
    qrFrame.replaceChildren(el("span", { class: "support-qr-missing" }, "收款码图片没能加载，请重新安装或联系作者。"));
    qrFrame.disabled = true;
  });

  // 保留最近一次落盘的路径：「打开所在文件夹」用得上，Rust 侧只认它自己给过的路径。
  let savedPath = "";
  const reveal = el("button", { class: "btn ghost sm", type: "button", disabled: true }, "打开所在文件夹");
  const save = el("button", { class: "btn ghost sm", type: "button" }, "保存收款码");
  const setBusy = (busy) => { save.disabled = busy; save.textContent = busy ? "正在保存…" : "保存收款码"; };

  async function saveQr() {
    setBusy(true);
    try {
      const response = await fetch(SPONSOR_QR_SRC, { cache: "no-store" });
      if (!response.ok) throw new Error(`读取收款码失败（HTTP ${response.status}）`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      savedPath = await api.saveDownloadBase64(SPONSOR_QR_FILENAME, btoa(binary));
      reveal.disabled = false;
      toast(`已保存到下载目录：${savedPath}`);
    } catch (error) {
      toast(`保存收款码失败：${error.message || error}`);
    } finally {
      setBusy(false);
    }
  }
  save.addEventListener("click", saveQr);
  reveal.addEventListener("click", async () => {
    try { await api.revealSavedFile(savedPath); }
    catch (error) { toast(`打开文件夹失败：${error.message || error}`); }
  });

  card.append(
    el("p", { class: "desc" }, "U-Time 全部功能免费、无广告、无账号，数据只留在本机。如果它确实帮你省下了时间，可以自愿扫码支持，金额随意。"),
    qrFrame,
    el("div", { class: "support-qr-foot" }, qrHint, el("span", { class: "support-qr-pay" }, "微信 / 支付宝均可扫")),
    el("div", { class: "support-actions" }, save, reveal),
  );

  card.append(createDisclosure({
    title: "赞助说明",
    description: "自愿、不影响功能、不收集付款信息。",
    open: false,
    content: el("div", { class: "support-note" },
      el("p", {}, "赞助不构成购买：不解锁任何功能、不改变更新节奏，所有人的功能完全一致。"),
      el("p", {}, "金额随意，扫码付款后不支持退款；收不收得到、收多少都不影响你继续使用。"),
      el("p", {}, "收款码只用于扫码付款。应用不读取支付信息，也不上报任何付款数据 —— 它没有服务器，连账号都没有。"),
      el("p", {}, "不方便付款也没关系：反馈问题、提需求、把 U-Time 推荐给同学，同样是支持。"),
    ),
  }).node);

  return card;
}
