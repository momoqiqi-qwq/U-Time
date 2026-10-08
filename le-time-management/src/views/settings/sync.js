/**
 * 「可选同步」引导卡。
 *
 * 拆成独立模块的原因和 ai.js / appearance.js 一样：设置主文件已经太长。
 * 但这一张卡另有历史包袱 —— 它原先只是三个输入框加两个按钮，默认「用户已经知道
 * WebDAV 是什么、坚果云的应用密码去哪拿」。现在改成 ①选网盘 ②填账号 ③一键配好
 * 三段引导，把小白会卡死的三处补齐：根地址长什么样、应用密码在哪生成、
 * 目录不存在时 PUT 会拿 409（这一步直接交给 MKCOL 自动建）。
 *
 * 密码只进 Rust 侧密钥库，绝不写进 data.json —— 否则密码会跟着快照一起同步到网盘上。
 */
import { api } from "../../api.js";
import * as S from "../../store.js";
import { el, toast } from "../../ui.js";
import { toggleSwitch } from "../../switchControl.js";
import { attachSelectionGlow } from "../../selectionGlow.js";
import { createAutoBackup } from "../../dataCenter.js";
import { parseLanTarget, lanInfo, lanPullSnapshot, lanPushSnapshot, describeLanInfo, DEFAULT_LAN_PORT } from "../../lanSync.js";
import { canScanQr, scanQr } from "../../qrScan.js";
import {
  WEBDAV_PRESETS, DEFAULT_SYNC_FILE_NAME, getPreset,
  buildDavUrl, migrateLegacyUrl, makeSnapshot,
  ensureWebDavFolder, testWebDavConnection,
  describeSyncError,
  saveStoredSyncPassword, loadStoredSyncPassword, clearStoredSyncPassword,
  uploadWebDav, downloadWebDav, isPotentiallyUnsafeWebDav,
} from "../../syncLayer.js";

let disclosureId = 0;

// 网盘选项与说明共用高度过渡；关闭后禁用内部焦点，但保留 DOM 完成收缩。
function syncDisclosure(content) {
  const node = el("div", { class: "sync-disclosure", id: `webdav-disclosure-${++disclosureId}`, "aria-hidden": "true" },
    el("div", { class: "sync-disclosure-inner" }, content));
  node.inert = true;
  return { node, setOpen(open) {
    node.classList.toggle("is-open", open);
    node.setAttribute("aria-hidden", String(!open));
    node.inert = !open;
  } };
}

export async function createSyncCard({ appVersion = "", os = "" } = {}) {
  const settings = S.getState().settings;
  settings.sync ??= {};
  const cfg = settings.sync.webdav ??= {};
  migrateLegacyUrl(cfg);

  // 卡片是每次打开设置重建一张，preset 必须留在闭包里；提到模块级会让两张卡互相串状态。
  let preset = getPreset(cfg.presetId || "jianguoyun");
  let hasStoredPassword = Boolean(await loadStoredSyncPassword());

  const stateChip = el("span", { class: "ai-vault-state" });

  /* ── ① 选网盘 ── */
  const presetChips = el("div", { class: "sync-presets", role: "listbox", "aria-label": "网盘类型" });
  const presetPanel = syncDisclosure(presetChips);
  const presetName = el("b", {});
  const presetHint = el("small", {});
  const presetTrigger = el("button", {
    class: "sync-preset-trigger", type: "button", "data-motion": "off",
    "aria-label": "选择同步网盘", "aria-haspopup": "listbox", "aria-expanded": "false",
    "aria-controls": presetPanel.node.id,
  }, el("span", { class: "sync-preset-copy" }, presetName, presetHint),
    el("i", { class: "sync-preset-arrow", "aria-hidden": "true" }));
  const presetDropdown = el("div", { class: "sync-preset-dropdown" }, presetTrigger, presetPanel.node);
  let presetOpen = false;
  let presetGlow;
  const closeOnOutside = event => { if (!presetDropdown.contains(event.target)) setPresetOpen(false); };
  function setPresetOpen(open, { focus = false } = {}) {
    presetOpen = open;
    if (!open && presetChips.contains(document.activeElement)) presetTrigger.focus({ preventScroll: true });
    presetTrigger.setAttribute("aria-expanded", String(open));
    presetPanel.setOpen(open);
    document.removeEventListener("pointerdown", closeOnOutside, true);
    if (open) document.addEventListener("pointerdown", closeOnOutside, true);
    if (open) presetGlow?.sync(false);
    if (open && focus) presetChips.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
  }
  presetTrigger.addEventListener("click", () => setPresetOpen(!presetOpen));
  presetDropdown.addEventListener("focusout", event => {
    // blur/focusout 的微任务可能早于新元素获得焦点；优先用 relatedTarget 判断内部切换。
    if (event.relatedTarget) {
      if (!presetDropdown.contains(event.relatedTarget)) setPresetOpen(false);
      return;
    }
    setTimeout(() => {
      if (!presetDropdown.contains(document.activeElement)) setPresetOpen(false);
    }, 0);
  });
  presetDropdown.addEventListener("keydown", event => {
    if (event.key === "Escape" && presetOpen) {
      event.preventDefault(); event.stopPropagation();
      setPresetOpen(false); presetTrigger.focus({ preventScroll: true });
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (!presetOpen) {
      setPresetOpen(true, { focus: true });
      if (event.key === "ArrowDown" || event.key === "ArrowUp") return;
    }
    const options = [...presetChips.querySelectorAll(".sync-preset")];
    const current = options.indexOf(document.activeElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
      : current < 0 ? (event.key === "ArrowDown" ? 0 : options.length - 1)
        : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[index]?.focus({ preventScroll: true });
  });
  const rootInput = el("input", { type: "url", placeholder: "https://…/dav", autocomplete: "off", spellcheck: "false" });
  const folderInput = el("input", { type: "text", placeholder: "U-Time", autocomplete: "off", spellcheck: "false" });
  const userInput = el("input", { type: "text", autocomplete: "username", spellcheck: "false" });
  const passInput = el("input", { type: "password", autocomplete: "new-password", spellcheck: "false" });
  const remember = toggleSwitch({ checked: cfg.remember !== false, ariaLabel: "在本机记住应用密码" });
  const result = el("div", { class: "shortcut-status sync-result" });

  rootInput.value = cfg.root || preset.root || "";
  folderInput.value = cfg.folder ?? preset.folder;
  userInput.value = cfg.username || "";
  userInput.placeholder = preset.accountPlaceholder;
  passInput.placeholder = passwordPlaceholder();
  rootInput.readOnly = !preset.rootEditable;

  function passwordPlaceholder() {
    return hasStoredPassword ? "已加密保存，留空即沿用" : preset.passwordPlaceholder;
  }

  /* ── ② 应用密码获取指引（每个预设自带自己的文案）── */
  const howtoList = el("ol", { class: "sync-howto" });
  const howtoNote = el("p", { class: "sync-howto-note" });
  const howtoToggle = el("button", { class: "btn ghost sm", type: "button" });
  const howtoPanel = syncDisclosure(howtoList);
  howtoToggle.setAttribute("aria-controls", howtoPanel.node.id);
  let howtoOpen = false;
  howtoToggle.addEventListener("click", () => { howtoOpen = !howtoOpen; paintPresetTexts(); });

  const helpLink = el("button", {
    class: "btn ghost sm", type: "button",
    onclick: () => { api.openUrl(preset.helpUrl).catch(() => window.open(preset.helpUrl, "_blank")); },
  });
  const passRow = el("div", { class: "sync-pass-row" }, passInput, helpLink, howtoToggle);
  const accountLabel = el("span", {});
  const passwordLabel = el("span", {});

  /** 换预设要一起换掉的文案：字段名、后台入口、分步说明。分散在四处，收在一个函数里刷。 */
  function paintPresetTexts() {
    helpLink.textContent = preset.helpLinkText || "打开后台";
    helpLink.style.display = preset.helpUrl ? "" : "none";
    accountLabel.textContent = preset.accountLabel;
    passwordLabel.textContent = preset.passwordLabel;
    howtoList.replaceChildren(...(preset.howto || []).map((line) => el("li", {}, line)));
    howtoPanel.setOpen(howtoOpen);
    howtoToggle.setAttribute("aria-expanded", String(howtoOpen));
    howtoToggle.style.display = (preset.howto || []).length ? "" : "none";
    howtoToggle.textContent = howtoOpen ? "收起说明" : "怎么填这一栏？";
    howtoNote.textContent = preset.howtoNote || "";
    howtoNote.style.display = preset.howtoNote ? "" : "none";
    paintStepNote();
  }

  /* ── 三段步骤壳 ── */
  const step1 = el("div", { class: "sync-step" },
    el("div", { class: "sync-step-head" }, el("i", { class: "sync-step-badge" }, "1"), el("b", {}, "选一个网盘")),
    el("p", { class: "sync-step-note" }, "不知道选哪个就点「坚果云」：国内能直连，免费版就够用。"),
    el("div", { class: "sync-step-body" }, presetDropdown),
  );
  const step2Note = el("p", { class: "sync-step-note" });
  const paintStepNote = () => {
    step2Note.textContent = preset.id === "jianguoyun"
      ? "文件夹不用先去网盘里手动建，下一步会自动创建。密码那一栏必须你自己去坚果云网页生成 —— 程序没法代你登录。"
      : "根地址填到能列出文件的那一层，不要带文件名。";
  };
  const step2 = el("div", { class: "sync-step" },
    el("div", { class: "sync-step-head" }, el("i", { class: "sync-step-badge" }, "2"), el("b", {}, "填上账号和密码")),
    step2Note,
    el("div", { class: "sync-step-body sync-form" },
      el("label", { class: "sync-field" }, el("span", {}, "网盘根地址"), rootInput),
      el("label", { class: "sync-field" }, el("span", {}, "文件夹名"), folderInput),
      el("label", { class: "sync-field" }, accountLabel, userInput),
      el("label", { class: "sync-field" }, passwordLabel, passRow),
      el("div", { class: "sync-remember-row" },
        el("span", {}, "记住密码"),
        el("div", { class: "sync-remember-hint" }, "加密存在本机，不会跟着快照上传到网盘"), remember),
      howtoNote, howtoPanel.node,
    ),
  );
  const runBtn = el("button", { class: "btn pri sync-run", type: "button" });
  const step3 = el("div", { class: "sync-step" },
    el("div", { class: "sync-step-head" }, el("i", { class: "sync-step-badge" }, "3"), el("b", {}, "一键配好")),
    el("div", { class: "sync-step-body" },
      runBtn,
      el("p", { class: "desc sync-run-note" }, "点一下就按顺序走完：核对账号 → 在网盘里建好文件夹 → 把当前数据传成第一份快照。全程只碰这一个文件，不会动你网盘里的别的东西。"),
      result,
    ),
  );
  const steps = [step1, step2, step3];

  /* ── 配好之后的日常操作 ── */
  const dailyBtns = el("div", { class: "data-actions" });
  const dailyCard = el("div", { class: "sync-daily" },
    el("div", { class: "data-section-title" }, "配好了，以后怎么同步"),
    dailyBtns,
    el("p", { class: "desc" }, "换到另一台设备（比如手机上的 APK）：装好本程序，回到这一页选同一个网盘、填同样的账号和应用密码，点「从网盘拉回本地」。"),
  );

  const card = el("div", { class: "card set-card sync-card" },
    el("div", { class: "ai-card-title-row" }, el("div", {}, el("h2", {}, "可选同步")), stateChip),
    el("p", { class: "desc" },
      "把你的网盘当成一个远端仓库：本地数据永远本机说了算，网盘上只存一份快照。",
      el("br"),
      "不自动上传、不注册账号，不点按钮就没有任何东西离开这台设备。",
    ),
    ...steps, dailyCard, createLanSection(settings, { appVersion, os }),
  );

  const isConfigured = () => Boolean(cfg.root && cfg.lastSyncAt);

  card._dispose = () => document.removeEventListener("pointerdown", closeOnOutside, true);
  // 选项只创建一次，刷新文案与状态时保持焦点和正在进行的收放动画。
  presetChips.append(...WEBDAV_PRESETS.map((p) => el("button", {
    class: "sync-preset", type: "button", role: "option", "data-preset": p.id, "data-motion": "off",
    onclick: () => {
      cfg.presetId = p.id;
      preset = p;
      // 可编辑地址与账号草稿继续保留；坚果云使用固定根地址。
      if (!p.rootEditable) rootInput.value = p.root;
      rootInput.readOnly = !p.rootEditable;
      rootInput.placeholder = p.rootPlaceholder || "https://…/dav";
      if (!folderInput.value.trim()) folderInput.value = p.folder;
      userInput.placeholder = p.accountPlaceholder;
      passInput.placeholder = passwordPlaceholder();
      paintAll();
      setPresetOpen(false);
      presetTrigger.focus({ preventScroll: true });
      S.saveNow();
    },
  }, el("b", {}, p.label), el("small", {}, p.tagline))));
  presetGlow = attachSelectionGlow(presetChips, { selector: ".sync-preset.on" });

  function paintPresets() {
    presetName.textContent = preset.label;
    presetHint.textContent = preset.tagline;
    for (const option of presetChips.querySelectorAll(".sync-preset")) {
      const selected = option.dataset.preset === preset.id;
      option.classList.toggle("on", selected);
      option.setAttribute("aria-selected", String(selected));
    }
    presetGlow.sync();
  }

  function paintAll() {
    step1.classList.toggle("is-done", Boolean(cfg.presetId));
    step2.classList.toggle("is-done", Boolean(cfg.root && cfg.username));
    step3.classList.toggle("is-done", isConfigured());
    dailyCard.style.display = isConfigured() ? "" : "none";
    stateChip.textContent = isConfigured() ? `已配好 · ${preset.label}` : "未配置";
    stateChip.classList.toggle("ok", isConfigured());
    runBtn.textContent = isConfigured() ? "重新走一遍（会覆盖网盘上那份快照）" : "一键配好";
    paintPresetTexts();
    paintPresets();
    paintDaily();
  }

  const readForm = () => ({
    root: rootInput.value.trim(),
    folder: folderInput.value.trim(),
    fileName: cfg.fileName || DEFAULT_SYNC_FILE_NAME,
    username: userInput.value.trim(),
  });
  const persist = async (patch) => {
    const form = readForm();
    Object.assign(cfg, { presetId: preset.id, ...form, fileName: form.fileName, ...patch });
    cfg.url = buildDavUrl(form);
    await S.saveNow();
  };
  /** 留空 = 沿用密钥库里那串。和 AI 的 API Key 同一套交互，别一清空输入框就把人配好的设置废掉。 */
  async function resolvePassword() {
    const typed = passInput.value.trim();
    if (typed) return typed;
    const stored = await loadStoredSyncPassword();
    if (!stored) throw new Error("还没填密码。填一次就好，勾上「记住密码」以后不用再输");
    return stored;
  }
  /** 三种回显态：进行中（中性）、成功（is-ok）、失败（is-error）。都写在同一行里，别到处拼 className。 */
  function say(msg, tone = "") {
    result.className = `shortcut-status sync-result${tone ? ` ${tone}` : ""}`;
    result.textContent = msg;
  }
  function fail(e) {
    const msg = describeSyncError(e);
    say(msg, "is-error");
    toast(msg.length > 26 ? "同步失败，原因写在下面的提示里" : msg);
  }
  function succeed(msg) {
    say(msg, "is-ok");
  }

  runBtn.addEventListener("click", async () => {
    const form = readForm();
    if (!form.root) { fail(new Error("先填网盘根地址")); return; }
    if (!form.username) { fail(new Error("先填账号")); return; }
    runBtn.disabled = true;
    try {
      const password = await resolvePassword();
      const url = buildDavUrl(form);
      if (isPotentiallyUnsafeWebDav(url)
        && !window.confirm("这个网盘地址是明文 http://，账号密码会在网络上裸奔。只在自己家里路由器下面用可以接受，公网链接请换成 https。确定继续吗？")) return;
      say("第 1 步 · 正在核对账号…");
      await testWebDavConnection({ ...form, password });
      say("第 2 步 · 正在准备文件夹…");
      const { created } = await ensureWebDavFolder({ ...form, password });
      say(`${created.length ? `第 2 步 · 已新建 ${created.join("/")}｜` : "第 2 步 · 文件夹本来就有｜"}第 3 步 · 正在上传快照…`);
      const out = await uploadWebDav({ url, username: form.username, password, data: S.getState(), appVersion });
      hasStoredPassword = await applyPasswordPreference(password);
      passInput.value = "";
      passInput.placeholder = passwordPlaceholder();
      await persist({ lastSyncAt: out.snapshot.exportedAt });
      succeed(`全部完成 · ${new Date(out.snapshot.exportedAt).toLocaleString("zh-CN")} 的快照已在网盘上`);
      toast("网盘同步已配好");
      paintAll();
    } catch (e) {
      await persist({}).catch(() => {});
      fail(e);
      paintAll();
    } finally {
      runBtn.disabled = false;
    }
  });

  /** 「记住密码」开则入库、关则把已存的那串删掉 —— 别让开关和实际存储状态各说各话。 */
  async function applyPasswordPreference(password) {
    if (!password) return Boolean(await loadStoredSyncPassword());
    if (!remember.checked) {
      await clearStoredSyncPassword();
      return false;
    }
    try {
      await saveStoredSyncPassword(password);
      return true;
    } catch {
      toast("密码没能存进本机密钥库（浏览器调试模式没有密钥库），下次还要再输一次");
      return false;
    }
  }

  function paintDaily() {
    dailyBtns.replaceChildren(
      el("button", { class: "btn pri sm", type: "button", onclick: async () => {
        const form = readForm();
        try {
          const password = await resolvePassword();
          say("正在上传本地快照…");
          const out = await uploadWebDav({ url: buildDavUrl(form), username: form.username, password, data: S.getState(), appVersion });
          await applyPasswordPreference(password);
          passInput.value = "";
          await persist({ lastSyncAt: out.snapshot.exportedAt });
          succeed(`上传成功 · ${new Date(out.snapshot.exportedAt).toLocaleString("zh-CN")}`);
          toast("快照已上传");
          paintAll();
        } catch (e) { fail(e); }
      } }, "上传本地 → 网盘"),
      el("button", { class: "btn ghost sm", type: "button", onclick: async () => {
        const form = readForm();
        try {
          const password = await resolvePassword();
          say("正在读取网盘上的快照…");
          const snap = await downloadWebDav({ url: buildDavUrl(form), username: form.username, password });
          const when = snap.exportedAt ? new Date(snap.exportedAt).toLocaleString("zh-CN") : "时间未知";
          if (!window.confirm(`网盘上的快照：${when}${snap.appVersion ? ` · v${snap.appVersion}` : ""}\n\n拉回来会把这台设备现在的数据整份换掉。本机这份会先自动存一个恢复点，拉错了能退回去。确定继续？`)) {
            say("已取消，本机数据没动");
            return;
          }
          // 与局域网那条同一个口径：覆盖本机之前一定先留一个可回退的恢复点。
          createAutoBackup("从网盘拉回前", appVersion);
          S.replaceAll(snap.data);
          await S.saveNow();
          await applyPasswordPreference(password);
          passInput.value = "";
          await persist({ lastSyncAt: new Date().toISOString() });
          succeed(`已从网盘拉回本地 · ${when}`);
          toast("远端快照已恢复到本机");
        } catch (e) { fail(e); }
      } }, "从网盘拉回本地"),
      el("button", { class: "btn ghost sm", type: "button", onclick: async () => {
        const form = readForm();
        try {
          const password = await resolvePassword();
          say("正在核对账号…");
          await testWebDavConnection({ ...form, password });
          succeed("账号能登录，这串密码仍然有效");
        } catch (e) { fail(e); }
      } }, "只测连接"),
      hasStoredPassword ? el("button", { class: "btn ghost sm", type: "button", onclick: async () => {
        if (!window.confirm("忘掉本机记住的密码？网盘上的快照不会被删。")) return;
        await clearStoredSyncPassword();
        hasStoredPassword = false;
        toast("已清除本机保存的密码");
        paintAll();
      } }, "忘掉密码") : null,
    );
  }

  paintAll();
  return card;
}


/**
 * 「不用网盘：跟电脑直接传」—— 局域网双向。
 *
 * 拉（手机 ← 电脑）：先探后拉。「拉回本机」在「连接看看」成功之前一直是锁着的，
 * 让人先看清电脑上躺着多少条数据，再决定要不要覆盖自己手上这份。
 * 推（手机 → 电脑）：多一道门。电脑端「允许手机推回本机」默认关，开着也只是把快照
 * 放进电脑内存里等着，必须有人在那台电脑上点「接收」才算数（三道门的理由见
 * src-tauri/src/lan.rs 顶部）。所以这里的按钮文案一律写「等电脑上确认」，
 * 不写「已同步」—— 发出去不等于对方接受了。
 *
 * 配对码不落盘（它跟着链接走，粘一次用一次）—— 存进 settings 就等于存进 data.json，
 * 而 data.json 会被 WebDAV 原样传到网盘上去。
 */
function createLanSection(settings, { appVersion = "", os = "" } = {}) {
  const lanCfg = settings.sync.lan ??= {};
  const isDesktop = ["windows", "macos", "linux"].includes(String(os));
  const linkInput = el("input", {
    type: "text", value: lanCfg.host || "",
    placeholder: `电脑上「复制链接」或「扫码」得来的配对链接，或 192.168.1.5:${DEFAULT_LAN_PORT}`,
    autocomplete: "off", spellcheck: "false",
  });
  const tokenInput = el("input", {
    type: "text", value: "", placeholder: "配对码（链接里带了就不用填）", autocomplete: "off", spellcheck: "false",
  });
  const result = el("div", { class: "shortcut-status sync-result" });
  const pullBtn = el("button", { class: "btn pri sm", type: "button", disabled: true }, "拉回本机（覆盖本机现在的数据）");
  const pushBtn = el("button", { class: "btn ghost sm", type: "button", disabled: true }, "推到电脑（等电脑上点接收）");
  const howto = el("ol", { class: "sync-howto" },
    el("li", {}, "在电脑上打开 U-Time，两边连同一个 Wi-Fi（手机用流量连不上）"),
    el("li", {}, "电脑上进 设置 → 局域网联动 → 点「启动服务」，屏幕上会出现一张二维码"),
    el("li", {}, "要往电脑推的，顺手在电脑那张卡里打开「允许手机把数据推回本机」（默认关着）"),
    el("li", {}, "回到手机这边点「扫码并同步」，对准电脑上那张码 —— 空白手机会直接拉取，已有数据时确认后自动备份再覆盖"),
    el("li", {}, "不方便扫码就走老路：电脑上「复制链接」发到手机，粘进上面那栏再点「连接看看电脑上有什么」"),
  );
  const howtoToggle = el("button", { class: "btn ghost sm", type: "button" }, "电脑上要怎么准备？");
  const howtoPanel = syncDisclosure(howto);
  howtoToggle.setAttribute("aria-controls", howtoPanel.node.id);
  let howtoOpen = false;
  const paintHowto = () => {
    howtoPanel.setOpen(howtoOpen);
    howtoToggle.setAttribute("aria-expanded", String(howtoOpen));
    howtoToggle.textContent = howtoOpen ? "收起说明" : "电脑上要怎么准备？";
  };
  howtoToggle.addEventListener("click", () => { howtoOpen = !howtoOpen; paintHowto(); });

  const say = (msg, tone = "") => {
    result.className = `shortcut-status sync-result${tone ? ` ${tone}` : ""}`;
    result.textContent = msg;
  };

  let target = null;
  /** 连上之后才有的两件事：电脑上的概况（含肯不肯收回传），以及本机这边现在的条数。 */
  let seen = null;

  /**
   * 连一次电脑，顺手把两个按钮的可用性刷对。
   * 粘贴那条和扫码那条共用这一个入口 —— 「扫完还要再点一下连接」不算一键。
   */
  async function connectTo(next) {
    say("正在连电脑…");
    seen = await lanInfo(next);
    // 只记地址，不记配对码
    lanCfg.host = next.base.replace(/^https?:\/\//, "");
    await S.saveNow();
    target = next;
    say(`${describeLanInfo(seen)}。确认是你要的那份，再点「拉回本机」`, "is-ok");
    pullBtn.disabled = false;
    paintPushState();
  }

  /**
   * 把电脑快照落到本机。扫码和手动按钮共用这一条，确保确认、恢复点与错误提示完全一致。
   * 空白手机扫码属于无损初始化，可以直接完成；本机已有任务或时间块时仍要明确确认。
   */
  async function pullToLocal({ fromScan = false } = {}) {
    if (!target) return false;
    const snap = await lanPullSnapshot(target);
    const n = snap.data?.tasks?.length ?? 0;
    const m = snap.data?.blocks?.length ?? 0;
    const mine = S.getState();
    const localTasks = mine.tasks?.length ?? 0;
    const localBlocks = mine.blocks?.length ?? 0;
    const isBlank = localTasks === 0 && localBlocks === 0;
    if (!isBlank && !window.confirm(`电脑上有 ${n} 条任务、${m} 个时间块，本机现在有 ${localTasks} 条任务、${localBlocks} 个时间块。\n\n继续会用电脑数据覆盖本机；覆盖前会自动建立恢复点。确定同步？`)) {
      say(fromScan ? "已连接电脑，但取消了自动同步；仍可稍后手动拉取" : "已取消，本机数据没动");
      return false;
    }
    say(fromScan ? "已连接，正在自动同步电脑数据…" : "正在拉取电脑数据…");
    if (fromScan) createAutoBackup("扫码自动同步前", appVersion);
    else createAutoBackup("局域网拉回前", appVersion);
    S.replaceAll(snap.data);
    await S.saveNow();
    say(`同步完成 · ${n} 条任务、${m} 个时间块`, "is-ok");
    toast(fromScan ? "扫码同步完成" : "已从电脑拉回本机");
    return true;
  }

  const fail = (e) => {
    target = null;
    seen = null;
    pullBtn.disabled = true;
    pushBtn.disabled = true;
    say(e?.message || String(e), "is-error");
  };

  const connectBtn = el("button", {
    class: "btn ghost sm", type: "button", onclick: async () => {
      try { await connectTo(parseLanTarget(linkInput.value, tokenInput.value)); }
      catch (e) { fail(e); }
    },
  }, "连接看看电脑上有什么");

  /* 扫码：省掉「电脑上复制链接 → 微信发给自己 → 长按复制 → 粘进来」这四步。
     只在真有相机的地方出现：桌面端 WebView 不是安全上下文，mediaDevices 直接就是 undefined。 */
  const scanBtn = !isDesktop && canScanQr() ? el("button", {
    class: "btn ghost sm", type: "button", onclick: async () => {
      let text = null;
      try { text = await scanQr(); } catch (e) { fail(e); return; }
      if (!text) return;   // 用户自己按的取消，不是错误，别报红
      try {
        await connectTo(parseLanTarget(text));
        linkInput.value = text;
        tokenInput.value = "";
      } catch (e) {
        // 相机里能扫到的东西多了去了（付款码、网址），要说清是「这不是配对码」而不是「连不上」。
        say(`扫到了，但那不是本程序的配对二维码：${e?.message || e}`, "is-error");
        target = null; seen = null; pullBtn.disabled = true; pushBtn.disabled = true;
        return;
      }
      try { await pullToLocal({ fromScan: true }); }
      catch (e) { say(`已连接电脑，但自动同步失败：${e?.message || e}`, "is-error"); }
    },
  }, "扫码并同步电脑数据") : null;

  /** 推这条的可用性只能探出来，不能猜：老版本电脑根本没有 /api/push。 */
  function paintPushState() {
    if (!seen) { pushBtn.disabled = true; return; }
    pushBtn.disabled = false;
    if (!seen.allowPush) {
      pushBtn.disabled = true;
      say("这条路径只能拉：那台电脑上没开「允许手机把数据推回本机」（设置 → 局域网联动 里那个开关）", "is-error");
    }
  }

  pullBtn.addEventListener("click", async () => {
    if (!target) return;
    try { await pullToLocal(); }
    catch (e) { say(e?.message || String(e), "is-error"); }
  });

  pushBtn.addEventListener("click", async () => {
    if (!target || !seen) return;
    const mine = S.getState();
    const n = mine.tasks?.length ?? 0;
    const m = mine.blocks?.length ?? 0;
    if (!window.confirm(`要把本机这份 ${n} 条任务、${m} 个时间块推到电脑上，覆盖电脑上现在那份（那边是 ${seen.tasks} 条任务、${seen.blocks} 个时间块）。\n\n电脑上会先弹一个确认框，要有人点「接收」才真的生效；点接收前那边会自动存一个恢复点。继续？`)) {
      say("已取消，两边都没动");
      return;
    }
    try {
      const out = await lanPushSnapshot(target, makeSnapshot(mine, appVersion), { onStage: (s) => say(s) });
      say(out.status === "accepted" ? `电脑已接收 · 本机 ${n} 条任务、${m} 个时间块` : "电脑端没接收", out.status === "accepted" ? "is-ok" : "is-error");
      toast(out.status === "accepted" ? "电脑上已接收这份数据" : "电脑没接收");
    } catch (e) { say(e?.message || String(e), "is-error"); }
  });

  paintHowto();
  paintPushState();
  return el("div", { class: "sync-lan" },
    el("div", { class: "data-section-title" }, "不用网盘：跟电脑直接传（局域网）"),
    el("p", { class: "desc" },
      "手机和电脑在同一个 Wi-Fi 时，跳过网盘直接互传整份数据：扫描电脑二维码后会自动拉取；本机已有数据时会先确认。",
      el("br"),
      "拉：直接把电脑上的拿过来。推：要在那台电脑上点「接收」才算数，而且电脑端的「允许手机推回本机」默认是关的。",
      el("br"),
      "两个方向都是整份覆盖：拉回来的是电脑上的整份状态，连电脑那台的「同步设置」（网盘地址、账号）也会一起过来；本机原来那份可以用恢复点退回（设置 → 数据中心）。",
    ),
    el("div", { class: "sync-form" },
      el("label", { class: "sync-field" }, el("span", {}, "电脑地址或配对链接"), linkInput),
      el("label", { class: "sync-field" }, el("span", {}, "配对码"), tokenInput),
    ),
    el("div", { class: "data-actions", style: "margin-top:10px" },
      scanBtn, connectBtn, pullBtn, pushBtn, howtoToggle,
      isDesktop ? el("button", {
        class: "btn ghost sm", type: "button",
        onclick: () => window.dispatchEvent(new CustomEvent("tide:open-settings", { detail: { section: "lan" } })),
      }, "本机就是电脑 · 去启动服务") : null,
    ),
    result, howtoPanel.node,
  );
}
