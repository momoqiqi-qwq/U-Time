// 「设置 › 关于 › 软件更新」面板。
//
// 逻辑全在 src/updateChecker.js，这里只负责把状态画成人能看的东西：
// 两个开关 → 状态回显 → 进度条 → 按钮组。
//
// 位置说明：v0.38.0 起本面板**嵌在「关于」卡片里**（最初设计成独立的「更新与维护」分区，
// 实现时改了）。关于页本来就写着当前版本号，更新入口放这儿最顺手；也避免「自动检查」与
// 「弹窗提示」两个开关被拆到两个分区里去。挂载点是 src/views/aboutCard.js。
//
// 每个按钮的可点 / 禁用都由状态机（idle/checking/uptodate/available/downloading/ready/
// installing/error）决定，不给用户「点了没反应」的按钮。
import { el, toast } from "../../ui.js";
import { toggleSwitch } from "../../switchControl.js";
import {
  getUpdateSettings, setUpdateSettings, getUpdateState, subscribeUpdateState,
  describeUpdateState, isUpdaterSupported, checkForUpdates, startUpdate,
  installUpdate, openInstallPermission, clearSkippedVersion, withCheckStamp,
} from "../../updateChecker.js";

/**
 * @param {{ currentVersion?: string }} opts
 * @returns {HTMLElement}
 */
export function createUpdateSettingsPanel({ currentVersion = "" } = {}) {
  const panel = el("div", { class: "update-panel" });

  if (!isUpdaterSupported()) {
    // 浏览器调试模式：说清楚为什么这里没有可点的东西，而不是留一片空白。
    panel.append(el("p", { class: "update-status" }, "应用内更新仅在桌面客户端与 Android 版可用；当前环境不检查更新。"));
    return panel;
  }

  const cfg = getUpdateSettings();

  const autoSwitch = toggleSwitch({ checked: cfg.autoCheck !== false });
  autoSwitch.addEventListener("change", () => {
    setUpdateSettings({ autoCheck: autoSwitch.checked });
    if (autoSwitch.checked) toast("已开启启动时自动检查更新");
    else toast("已关闭自动检查（仍可在这里手动检查）");
  });

  // 这就是用户要的那个开关：「是否弹出提示」。关掉后仍会照常检查、状态仍显示在下面，
  // 只是不再在左下角弹升级通知。
  const notifySwitch = toggleSwitch({ checked: cfg.notify !== false });
  notifySwitch.addEventListener("change", () => {
    setUpdateSettings({ notify: notifySwitch.checked });
    if (notifySwitch.checked) toast("发现新版本时会弹窗提示");
    else toast("已关闭新版本弹窗通知，仍可在这里查看与升级");
  });

  const statusLine = el("div", { class: "update-status" });
  const progressWrap = el("div", { class: "update-progress", hidden: true },
    el("div", { class: "update-progress-track" }, el("div", { class: "update-progress-fill" })),
    el("span", { class: "update-progress-text" }),
  );
  const fill = progressWrap.querySelector(".update-progress-fill");
  const progressText = progressWrap.querySelector(".update-progress-text");

  const notesBox = el("details", { class: "update-notes", hidden: true },
    el("summary", {}, "本次更新内容"),
    el("pre", { class: "update-notes-body" }),
  );

  const actions = el("div", { class: "update-actions" });
  const skipRow = el("div", { class: "setting-row", hidden: true },
    el("span", {}, "已忽略的版本"), el("span", { class: "update-skip" }),
  );

  // 只在真存在「忽略记录」时才显示这一行，并提供恢复入口 ——
  // 否则用户点了「忽略此版本」以后，再也找不到怎么让它回来。
  const paintSkip = () => {
    const skip = getUpdateSettings().skipVersion;
    skipRow.hidden = !skip;
    const holder = skipRow.querySelector(".update-skip");
    holder.replaceChildren();
    if (!skip) return;
    holder.append(
      el("b", {}, `v${skip}`),
      el("button", { class: "btn ghost sm", type: "button", onclick: () => { clearSkippedVersion(); paintSkip(); paint(); } }, "恢复提示"),
    );
  };

  function paint() {
    const st = getUpdateState();
    // 「尚未检查」也要给出上一次自动检查的时刻：面板上只写「已是最新版本」而不写时刻时，
    // 用户无法分辨这条结果是刚查的还是几十分钟前查的（发版瞬间特别容易误会成「检测不到」）。
    // 拼接走 updateChecker 的 withCheckStamp —— 与状态回显的「· HH:MM 检查」同一套规则。
    statusLine.textContent = st.phase === "idle"
      ? withCheckStamp(
          `尚未检查（当前 v${currentVersion || "?"}）`,
          getUpdateSettings().lastCheckAt,
          { prefix: "上次自动检查 ", suffix: "" },
        )
      : describeUpdateState(st);
    statusLine.classList.toggle("is-error", st.phase === "error");

    // 进度条只在下载阶段出现；其余时候整块藏掉，避免一段静止的 0% 长条挂在那里。
    const downloading = st.phase === "downloading";
    progressWrap.hidden = !downloading;
    if (downloading) {
      const { received, total } = st.progress;
      const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;
      fill.style.width = `${pct}%`;
      progressText.textContent = total > 0 ? `${pct}%` : "…";
    }

    const notes = st.info?.notes || "";
    notesBox.hidden = !notes;
    if (notes) notesBox.querySelector(".update-notes-body").textContent = notes;

    actions.replaceChildren();
    const busy = st.phase === "checking" || st.phase === "downloading" || st.phase === "installing";

    // 不用 el({disabled: busy})：el() 走 setAttribute，`disabled: false` 会变成
    // disabled="false"（属性在 = 仍然禁用）。布尔属性必须用 property 赋值。
    const checkBtn = el("button", {
      class: "btn ghost sm", type: "button",
      onclick: async () => { await checkForUpdates({ manual: true }); paintSkip(); },
    }, st.phase === "checking" ? "正在检查…" : "检查更新");
    checkBtn.disabled = busy;
    actions.append(checkBtn);

    if (st.phase === "available" && st.info?.has_update) {
      if (st.info.supported) {
        actions.append(el("button", { class: "btn pri sm", type: "button", onclick: () => startUpdate() }, `升级到 v${st.info.latest}`));
      } else {
        // 有新版但本平台没有可自动安装的产物：给一个「去仓库下载」的出口，
        // 而不是留一个点不动的灰色按钮。
        actions.append(el("button", {
          class: "btn pri sm", type: "button",
          onclick: () => import("../../api.js").then(({ api }) => api.openUrl(st.info.release_url)).catch(() => toast("打不开网页")),
        }, "到项目仓库下载"));
      }
    }

    if (st.phase === "ready") {
      const needPermission = st.installReady && st.installReady.ready === false;
      actions.append(el("button", {
        class: "btn pri sm", type: "button",
        onclick: () => (needPermission ? openInstallPermission() : installUpdate()),
      }, needPermission ? "去开启安装权限" : "关闭并安装"));
    }

    if (st.phase === "error") {
      actions.append(el("button", { class: "btn ghost sm", type: "button", onclick: () => checkForUpdates({ manual: true }) }, "重试"));
    }
  }

  // 设置页每次重渲染都会重建这个面板：订阅必须在节点被换掉后自动退订，
  // 否则反复开关设置会累积一堆回调（每个都还持有已脱离文档的节点）。
  //
  // ⚠️ `subscribeUpdateState()` 会**同步**先回调一次（立刻把当前状态交出去），而那一刻
  // panel 还没被 append 进文档 —— `panel.isConnected` 恒为 false。所以那次回调必须直接跳过，
  // 否则踩两个坑：
  //   ① `const unsubscribe = …` 还在暂时性死区里，回调里读它 → ReferenceError，
  //      异常会顺着 createAboutCard → renderSettings 冒出去，**整个设置页渲染中断**
  //      （只剩一个标题为「设置」的空弹窗）；
  //   ② 就算不报错也会当场退订，面板从此再也不随状态更新。
  // 用 `firstCallback` 标记 + 先给 `unsubscribe` 一个空实现，两个坑一起绕开。
  let firstCallback = true;
  let unsubscribe = () => {};
  unsubscribe = subscribeUpdateState(() => {
    if (firstCallback) { firstCallback = false; return; }
    if (!panel.isConnected) { unsubscribe(); return; }
    paint();
  });
  panel._dispose = () => unsubscribe();

  panel.append(
    el("div", { class: "setting-row" }, el("span", {}, "启动时自动检查更新"), autoSwitch),
    el("div", { class: "setting-row" }, el("span", {}, "有新版本时弹窗提示"), notifySwitch),
    statusLine,
    progressWrap,
    actions,
    notesBox,
    skipRow,
  );
  paintSkip();
  paint();
  return panel;
}
