// 番茄专注插件 —— registerView / storage / notify / sound / events / tasks
(function () {
  const MODES = [
    { id: "focus", label: "专注 25", min: 25 },
    { id: "break", label: "短休 5", min: 5 },
    { id: "long", label: "长休 15", min: 15 },
  ];
  const R = 86, CIRC = 2 * Math.PI * R;

  // 自定义时长以「秒」为唯一事实源（storage 键 customSec）。分 / 秒两个输入框只是它的两种视图，
  // 这样 1 分 30 秒就是 90，不必再靠 1.5 这种小数分钟去凑。
  const CUSTOM_MAX_SEC = 240 * 60;
  function clampCustomSec(min, sec) {
    const total = Math.round((Number(min) || 0) * 60 + (Number(sec) || 0));
    return Math.max(1, Math.min(CUSTOM_MAX_SEC, total));
  }

  // 提醒设置：专注 / 休息各自控制「通知」与「声音」。提示音走宿主的 tide.sound，
  // 与应用设置里的「任务提醒」共用同一份音效目录（内置音效 + 自定义音频）。
  const REMINDER_DEFAULT = {
    focusNotify: true, focusSound: true,
    breakNotify: true, breakSound: true,
    sound: "beep", volume: 0.75,
    customAudio: null, customAudioName: "",
    focusStages: [],
  };
  // 自定义音频以 data URL 存进插件设置，会跟着应用数据一起备份，所以卡在 4 MB。
  const AUDIO_MAX_BYTES = 4 * 1024 * 1024;

  let mode = MODES[0], left = 25 * 60, timer = null, currentTaskId = "", customSec = 25 * 60, firedStages = new Set();
  let box, timeText, ring, taskSel, dotsBox;

  let reminder = { ...REMINDER_DEFAULT };
  const reminderReady = (async () => {
    try {
      const saved = await tide.storage.get("reminder", null);
      if (saved && typeof saved === "object") reminder = normalizeReminder(saved);
    } catch (e) { console.warn("番茄专注：提醒设置读取失败", e); }
    return reminder;
  })();

  // 老版本只存了 customMin（分钟，可能是 1.5 这种小数）。读不到 customSec 时按分钟换算过来，
  // 用户原来设的 1 分 30 秒不会丢。
  const customReady = (async () => {
    try {
      const savedSec = await tide.storage.get("customSec", null);
      if (savedSec !== null && savedSec !== undefined && Number.isFinite(Number(savedSec))) {
        customSec = Math.max(1, Math.min(CUSTOM_MAX_SEC, Math.round(Number(savedSec))));
      } else {
        customSec = clampCustomSec(Number(await tide.storage.get("customMin", 25)) || 25, 0);
      }
    } catch (e) { console.warn("番茄专注：自定义时长读取失败", e); }
    return customSec;
  })();

  function normalizeReminder(raw) {
    const out = { ...REMINDER_DEFAULT, ...raw };
    for (const key of ["focusNotify", "focusSound", "breakNotify", "breakSound"]) out[key] = out[key] !== false;
    out.volume = Math.min(1, Math.max(0, Number(out.volume) || REMINDER_DEFAULT.volume));
    out.sound = typeof out.sound === "string" && out.sound ? out.sound : REMINDER_DEFAULT.sound;
    out.customAudio = typeof out.customAudio === "string" && out.customAudio ? out.customAudio : null;
    out.customAudioName = String(out.customAudioName || "");
    out.focusStages = Array.isArray(out.focusStages) ? [...new Set(out.focusStages.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= CUSTOM_MAX_SEC))].sort((a, b) => b - a).slice(0, 8) : [...REMINDER_DEFAULT.focusStages];
    // 音频丢了就别停在「自定义」上，否则到点会一声不响。
    if (out.sound === "custom" && !out.customAudio) out.sound = REMINDER_DEFAULT.sound;
    return out;
  }

  function saveReminder() {
    return Promise.resolve(tide.storage.set("reminder", reminder)).catch((e) => console.warn("番茄专注：提醒设置保存失败", e));
  }

  /** preview = 试听：无视提醒开关，音量给一个听得见的下限。 */
  function playReminderSound(preview = false) {
    try {
      return Promise.resolve(tide.sound.play({
        sound: reminder.sound,
        volume: preview ? Math.max(reminder.volume, 0.3) : reminder.volume,
        customAudio: reminder.customAudio,
      })).catch(() => {});
    } catch (e) {
      console.warn("番茄专注：提示音播放失败", e);
      return Promise.resolve();
    }
  }

  function fmt(s) {
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  /** 当前模式的秒数。自定义走 customSec，预设按分钟换算。 */
  function modeSeconds(m) {
    return m.id === "custom" ? customSec : m.min * 60;
  }

  /** 累计分钟会带小数（30 秒的番茄就是 0.5 分），去掉无意义的 .0。 */
  function fmtMin(m) {
    return String(Math.round((Number(m) || 0) * 10) / 10);
  }

  function paint() {
    timeText.textContent = fmt(left);
    const done = 1 - left / Math.max(1, modeSeconds(mode));
    ring.style.strokeDashoffset = String(CIRC * (1 - done));
  }

  function stop() { clearInterval(timer); timer = null; }

  function tick() {
    left -= 1;
    if (left <= 0) {
      stop();
      left = 0; paint();
      finish();
      return;
    }
    if (mode.id === "focus" || mode.id === "custom") {
      for (const seconds of reminder.focusStages || []) {
        if (left !== seconds || firedStages.has(seconds) || seconds >= modeSeconds(mode)) continue;
        firedStages.add(seconds);
        if (reminder.focusNotify) tide.notify(`专注还剩 ${fmt(seconds)}`);
        if (reminder.focusSound) playReminderSound();
      }
    }
    paint();
  }

  async function finish() {
    await reminderReady;
    await customReady;
    const isFocus = mode.id === "focus" || mode.id === "custom";
    const n = ((await tide.storage.get("doneCount", 0)) || 0) + (isFocus ? 1 : 0);
    const sessionMin = modeSeconds(mode) / 60;
    // 允许小数分钟（30 秒的番茄记 0.5 分），但要把浮点噪声收掉，
    // 否则累加几次就会出现 0.30000000000000004 这种数字。
    const mins = Math.round((((await tide.storage.get("focusMin", 0)) || 0) + (isFocus ? sessionMin : 0)) * 10) / 10;
    await tide.storage.set("doneCount", n);
    await tide.storage.set("focusMin", mins);

    const notifyOn = isFocus ? reminder.focusNotify : reminder.breakNotify;
    const soundOn = isFocus ? reminder.focusSound : reminder.breakSound;
    if (notifyOn) tide.notify(isFocus ? `完成 1 个番茄！今日累计 ${n} 个 / ${fmtMin(mins)} 分钟` : "休息结束，回来继续吧 🍃");
    if (soundOn) playReminderSound();

    tide.events.emit("pomodoro:finished", { mode: mode.id, taskId: currentTaskId || null });
    renderDots();
    if (isFocus && currentTaskId && notifyOn) {
      const t = tide.tasks.list().find((x) => x.id === currentTaskId);
      if (t) tide.notify(`下一个番茄继续：「${t.title}」`);
    }
  }

  function renderDots() {
    Promise.all([
      tide.storage.get("doneCount", 0),
      tide.storage.get("focusMin", 0),
    ]).then(([n, mins]) => {
      dotsBox.replaceChildren();
      for (let i = 0; i < Math.min(8, Number(n) || 0); i++) {
        const d = document.createElement("span");
        d.style.cssText = "width:11px;height:11px;border-radius:50%;display:inline-block;background:var(--mint,#2EC4B6);";
        dotsBox.append(d);
      }
      const lab = document.createElement("span");
      lab.style.cssText = "font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);margin-left:8px";
      // 用真实累计分钟，别拿「番茄数 × 25」估 —— 自定义时长（尤其几十秒的短番茄）会估得离谱。
      lab.textContent = `累计 ${Number(n) || 0} 个番茄 · ${fmtMin(mins)} 分钟`;
      dotsBox.append(lab);
    });
  }

  function chip(text, onClick, primary = false) {
    const b = document.createElement("button");
    b.textContent = text;
    b.style.cssText = `height:28px;padding:0 11px;border-radius:14px;font-size:calc(12px * var(--ui-text-scale));font-weight:600;cursor:pointer;white-space:nowrap;`
      + `background:${primary ? "var(--deep,#0F4C5C)" : "var(--panel,#fff)"};`
      + `color:${primary ? "var(--on-deep,#fff)" : "var(--ink-2,#7E8B94)"};`
      + `border:1px solid ${primary ? "var(--deep,#0F4C5C)" : "var(--line,#E4DFD6)"}`;
    b.addEventListener("click", onClick);
    return b;
  }

  /**
   * 提醒设置面板。返回 { node, sync }：sync 在 storage 读完后再对齐一次控件，
   * 因为 render() 是同步的、设置是异步读的。
   */
  function reminderPanel() {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-top:20px;border-top:1px solid var(--line,#E4DFD6);padding-top:13px;text-align:left";

    const toggle = document.createElement("button");
    toggle.type = "button";
    // 面板头一行 = 「提醒设置」开关(flex:1) + 常驻「试听」按钮：收起状态也能直接试听，
    // 不必先展开面板（试听按钮在 head 里、toggle 外面，点它不会触发展开/收起）。
    toggle.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;flex:1;min-width:0;background:transparent;border:0;padding:2px 0;cursor:pointer;color:var(--ink,#22303A);font:inherit;font-size:calc(13px * var(--ui-text-scale));font-weight:650";
    const toggleText = document.createElement("span");
    toggleText.textContent = "提醒设置";
    const summary = document.createElement("span");
    summary.style.cssText = "font-size:calc(11px * var(--ui-text-scale));font-weight:500;color:var(--ink-3,#8FA2A8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    toggle.append(toggleText, summary);

    const body = document.createElement("div");
    // 默认收起：面板占位太大，收起时 toggle 右侧的摘要就是当前配置的一行速览
    body.style.cssText = "margin-top:11px;display:none;gap:9px";

    const controls = {};
    const presetLabels = { custom: "自定义音频" };
    const presetNotes = {};

    const row = (label, ...nodes) => {
      const line = document.createElement("div");
      line.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:30px";
      const name = document.createElement("span");
      name.style.cssText = "flex:0 0 auto;font-size:calc(12.5px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)";
      name.textContent = label;
      const right = document.createElement("span");
      right.style.cssText = "flex:1;min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap";
      right.append(...nodes);
      line.append(name, right);
      return line;
    };

    const check = (key, text) => {
      const label = document.createElement("label");
      label.style.cssText = "display:inline-flex;align-items:center;gap:8px;font-size:calc(12.5px * var(--ui-text-scale));color:var(--ink,#22303A);cursor:pointer";
      const input = document.createElement("input");
      input.type = "checkbox";
      // v0.40.0：勾选框改滑块开关（与应用层 .switch 同一套外观，appearance:none 自绘轨道与滑块）
      input.className = "switch";
      input.setAttribute("role", "switch");
      input.checked = reminder[key] !== false;
      input.style.cssText = "margin:0";
      input.addEventListener("change", () => { reminder[key] = input.checked; saveReminder(); updateSummary(); });
      label.append(input, document.createTextNode(text));
      controls[key] = input;
      return label;
    };

    // 内置音效做成可见的胶囊按钮组（手机上不展开下拉也能看到全部常见提醒音），
    // 点一下＝选中并试听；自定义音频仍走下面单独一行。
    const soundChips = document.createElement("div");
    soundChips.style.cssText = "display:flex;flex-wrap:wrap;gap:6px";
    const soundNote = document.createElement("div");
    soundNote.style.cssText = "font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#8FA2A8);margin-top:-2px";
    const soundChipEls = new Map();
    function syncSoundChips() {
      for (const [id, b] of soundChipEls) {
        const active = reminder.sound === id;
        b.style.background = active ? "var(--deep,#0F4C5C)" : "var(--panel,#fff)";
        b.style.color = active ? "var(--on-deep,#fff)" : "var(--ink-2,#7E8B94)";
        b.style.borderColor = active ? "var(--deep,#0F4C5C)" : "var(--line,#E4DFD6)";
      }
    }
    // 宿主没回话时的最小兜底：至少保住默认那一项。
    const fillSounds = (presets) => {
      soundChips.replaceChildren();
      soundChipEls.clear();
      for (const p of presets) {
        const b = chip(p.label, () => {
          if (reminder.sound === p.id) { playReminderSound(true); return; }
          reminder.sound = p.id;
          saveReminder();
          updateSummary();
          updateNote();
          syncSoundChips();
          playReminderSound(true);
        });
        b.type = "button";
        b.title = p.note || p.label;
        soundChipEls.set(p.id, b);
        soundChips.append(b);
        presetLabels[p.id] = p.label;
        if (p.note) presetNotes[p.id] = p.note;
      }
      updateSummary();
      updateNote();
      syncSoundChips();
    };
    fillSounds([{ id: REMINDER_DEFAULT.sound, label: "清脆提示" }]);
    try {
      Promise.resolve(tide.sound.presets()).then(fillSounds).catch(() => {});
    } catch (e) { console.warn("番茄专注：音效目录读取失败", e); }

    const vol = document.createElement("input");
    vol.type = "range"; vol.min = "0"; vol.max = "100"; vol.step = "1";
    vol.value = String(Math.round(reminder.volume * 100));
    vol.style.cssText = "width:128px;accent-color:var(--deep,#0F4C5C)";
    const volText = document.createElement("b");
    volText.style.cssText = "min-width:36px;text-align:right;font-size:calc(12px * var(--ui-text-scale));color:var(--ink,#22303A)";
    volText.textContent = `${vol.value}%`;
    vol.addEventListener("input", () => { volText.textContent = `${vol.value}%`; reminder.volume = Number(vol.value) / 100; saveReminder(); });
    vol.addEventListener("change", () => playReminderSound(true));

    const audioInput = document.createElement("input");
    audioInput.type = "file";
    audioInput.accept = "audio/*,.mp3,.wav,.m4a,.aac,.ogg";
    audioInput.style.display = "none";
    const audioName = document.createElement("span");
    audioName.style.cssText = "max-width:132px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-3,#8FA2A8)";
    const clearAudio = chip("清除", () => {
      reminder.customAudio = null;
      reminder.customAudioName = "";
      if (reminder.sound === "custom") reminder.sound = REMINDER_DEFAULT.sound;
      saveReminder();
      sync();
    });
    audioInput.addEventListener("change", () => {
      const file = audioInput.files && audioInput.files[0];
      audioInput.value = "";
      if (!file) return;
      if (file.size > AUDIO_MAX_BYTES) {
        tide.notify(`音频请控制在 ${AUDIO_MAX_BYTES / 1024 / 1024} MB 以内（当前 ${(file.size / 1048576).toFixed(1)} MB）`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        reminder.customAudio = String(reader.result || "");
        reminder.customAudioName = file.name;
        reminder.sound = "custom";
        saveReminder();
        sync();
        playReminderSound(true);
        tide.notify(`已导入自定义提示音：${file.name}`);
      };
      reader.onerror = () => tide.notify("音频读取失败，请换一个文件试试");
      reader.readAsDataURL(file);
    });

    const stages = document.createElement("input");
    stages.type = "text";
    stages.placeholder = "例如 5, 1";
    stages.setAttribute("aria-label", "专注结束前提醒时间，以分钟为单位，逗号分隔");
    stages.style.cssText = "width:min(100%,190px);height:32px;padding:0 9px;border:1px solid var(--line,#E4DFD6);border-radius:7px;background:var(--paper,#fff);color:var(--ink,#22303A)";
    const stageHint = document.createElement("div");
    stageHint.style.cssText = "font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#8FA2A8)";
    stageHint.textContent = "分钟，逗号分隔；留空仅在结束时提醒，最多 8 段";
    body.append(
      row("专注结束", check("focusNotify", "通知"), check("focusSound", "声音")),
      row("结束前提醒", stages), stageHint,
      row("休息结束", check("breakNotify", "通知"), check("breakSound", "声音")),
      soundChips,
      soundNote,
      row("音量", vol, volText),
      row("自定义音频", audioName, chip("导入", () => audioInput.click()), clearAudio),
      audioInput,
    );
    stages.addEventListener("change", () => {
      const raw = stages.value.trim();
      const parts = raw ? raw.split(/[,，、\s]+/).filter(Boolean) : [];
      const minutes = parts.map(Number);
      if (parts.length > 8 || minutes.some((n) => !Number.isFinite(n) || Math.round(n * 60) < 1 || n * 60 > CUSTOM_MAX_SEC)) {
        tide.notify("请输入 0 到 240 分钟内的时间点，最多 8 段");
        stages.value = (reminder.focusStages || []).map((n) => n / 60).join(", ");
        return;
      }
      reminder.focusStages = [...new Set(minutes.map((n) => Math.round(n * 60)))].sort((a, b) => b - a);
      saveReminder(); updateSummary();
    });

    function updateSummary() {
      const on = (key) => reminder[key] !== false;
      const both = (a, b) => (on(a) || on(b) ? "开" : "关");
      const name = reminder.sound === "custom" ? (reminder.customAudioName || "自定义音频") : (presetLabels[reminder.sound] || reminder.sound);
      summary.textContent = `专注 ${both("focusNotify", "focusSound")}${reminder.focusStages?.length ? ` · 提前 ${reminder.focusStages.length} 段` : ""} · 休息 ${both("breakNotify", "breakSound")} · ${name} ${Math.round(reminder.volume * 100)}%`;
    }

    function updateNote() {
      soundNote.textContent = reminder.sound !== "custom" ? (presetNotes[reminder.sound] || "")
        : (reminder.customAudio ? "使用你导入的音频文件" : "还没导入音频，到点会退回内置提示音");
    }

    /** 把当前 reminder 值灌回控件（storage 读完之后、以及导入 / 清除音频之后）。 */
    function sync() {
      for (const key of ["focusNotify", "focusSound", "breakNotify", "breakSound"]) if (controls[key]) controls[key].checked = reminder[key] !== false;
      syncSoundChips();
      vol.value = String(Math.round(reminder.volume * 100));
      volText.textContent = `${vol.value}%`;
      audioName.textContent = reminder.customAudio ? (reminder.customAudioName || "已导入音频") : "未导入";
      audioName.title = reminder.customAudio ? (reminder.customAudioName || "已导入音频") : "可选：导入一段本地音频作为到点提示音";
      clearAudio.style.display = reminder.customAudio ? "" : "none";
      stages.value = (reminder.focusStages || []).map((n) => n / 60).join(", ");
      updateSummary();
      updateNote();
    }

    toggle.addEventListener("click", () => {
      // 摘要两种状态都留着：收起时它就是「当前提醒配置」的一行速览。
      body.style.display = body.style.display === "none" ? "grid" : "none";
    });

    // 常驻试听按钮：挂在面板头部、开关旁边，收起状态也看得到、点得到
    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:8px;width:100%";
    const previewBtn = chip("试听", () => playReminderSound(true));
    previewBtn.type = "button";
    previewBtn.title = "试听当前提示音（无视提醒开关；音量过低时按可听下限播放）";
    head.append(toggle, previewBtn);

    sync();
    wrap.append(head, body);
    return { node: wrap, sync };
  }

  function render(el2) {
    box = el2;
    el2.innerHTML = "";

    const card = document.createElement("div");
    // 卡片底色直接取宿主面板色，与应用自己的 .card 一致。v0.55.0 之前这里读的是宿主注入的两个
    // 复合变量（「自定义背景」的「卡片不透明度 / 卡片毛玻璃」靠它们生效），那套功能已经删除、
    // 变量不再注入 —— 留着 var() 只会变成指向不存在功能的死引用。变量名见 git 历史。
    card.style.cssText = "max-width:520px;margin:30px auto;text-align:center;background:var(--panel,#fff);color:var(--ink,#22303A);border:1px solid var(--line,#E4DFD6);border-radius:18px;padding:34px 30px;box-shadow:var(--shadow,0 2px 10px rgba(34,48,58,.07))";

    const title = document.createElement("div");
    title.style.cssText = "font-size:calc(11px * var(--ui-text-scale));letter-spacing:.3em;color:var(--ink-2,#7E8B94);margin-bottom:14px";
    title.textContent = "番 茄 专 注 · 内 置 插 件";

    // 模式切换
    const modes = document.createElement("div");
    modes.style.cssText = "display:flex;justify-content:center;gap:8px;margin-bottom:22px";
    [...MODES, { id: "custom", label: "自定义", min: customSec / 60 }].forEach((m) => {
      const b = document.createElement("button");
      b.textContent = m.label;
      b.dataset.m = m.id;
      b.style.cssText = "font-size:calc(12px * var(--ui-text-scale));border-radius:16px;padding:7px 16px;border:1px solid var(--line,#E4DFD6);color:var(--ink-2,#7E8B94);background:var(--panel,#fff);cursor:pointer";
      b.addEventListener("click", () => {
        stop(); mode = m; left = modeSeconds(m); firedStages = new Set();
        modes.querySelectorAll("button").forEach((x) => {
          const on = x.dataset.m === m.id;
          x.style.background = on ? "var(--deep,#0F4C5C)" : "var(--panel,#fff)";
          x.style.color = on ? "var(--on-deep,#fff)" : "var(--ink-2,#7E8B94)";
          x.style.borderColor = on ? "var(--deep,#0F4C5C)" : "var(--line,#E4DFD6)";
        });
        paint();
      });
      modes.append(b);
    });

    const customRow = document.createElement("div");
    customRow.style.cssText = "display:flex;justify-content:center;align-items:center;gap:6px;margin:-10px 0 18px;flex-wrap:wrap";
    const numInput = (max, value) => {
      const el = document.createElement("input");
      el.type = "number"; el.min = "0"; el.max = String(max); el.step = "1"; el.value = String(value);
      el.style.cssText = "width:68px;height:34px;border:1px solid var(--line,#E4DFD6);border-radius:9px;padding:0 9px;background:var(--paper,#fff);color:var(--ink,#22303A)";
      return el;
    };
    const unitText = (text) => {
      const s = document.createElement("span");
      s.textContent = text;
      s.style.cssText = "font-size:calc(12px * var(--ui-text-scale));color:var(--ink-3,#8FA2A8)";
      return s;
    };
    const minInput = numInput(240, Math.floor(customSec / 60));
    const secInput = numInput(59, customSec % 60);
    const customBtn = mkBtn("设置倒计时", "var(--panel,#fff)", "var(--ink-2,#7E8B94)", true); customBtn.style.height="34px"; customBtn.style.minWidth="96px";
    // 分 / 秒 只是 customSec 的两个视图，任何一处改了都要回来对齐，免得显示和真实倒计时对不上。
    const syncCustomInputs = () => {
      minInput.value = String(Math.floor(customSec / 60));
      secInput.value = String(customSec % 60);
    };
    const applyCustom = async () => {
      customSec = clampCustomSec(minInput.value, secInput.value);
      syncCustomInputs();
      try { await tide.storage.set("customSec", customSec); }
      catch (e) { console.warn("番茄专注：自定义时长保存失败", e); }
      stop();
      mode = { id: "custom", label: "自定义", min: customSec / 60 };
      left = customSec;
      firedStages = new Set();
      paint();
    };
    customBtn.addEventListener("click", applyCustom);
    for (const el of [minInput, secInput]) el.addEventListener("keydown", (e) => { if (e.key === "Enter") applyCustom(); });
    customRow.append(unitText("自定义"), minInput, unitText("分"), secInput, unitText("秒"), customBtn);

    // 环
    const ringWrap = document.createElement("div");
    ringWrap.style.cssText = "position:relative;width:220px;height:220px;margin:0 auto 18px";
    ringWrap.innerHTML = `
      <svg width="220" height="220" viewBox="0 0 220 220" style="transform:rotate(-90deg)">
        <circle cx="110" cy="110" r="${R}" fill="none" style="stroke:var(--line-soft,#EFEAE1)" stroke-width="9"></circle>
        <circle class="ring" cx="110" cy="110" r="${R}" fill="none" style="stroke:var(--mint,#2EC4B6)" stroke-width="9"
          stroke-linecap="round" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}"></circle>
      </svg>`;
    ring = ringWrap.querySelector(".ring");
    timeText = document.createElement("div");
    timeText.style.cssText = "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:calc(44px * var(--ui-text-scale));font-weight:300;font-variant-numeric:tabular-nums";
    timeText.textContent = fmt(left);
    ringWrap.append(timeText);

    // 任务选择
    taskSel = document.createElement("select");
    taskSel.style.cssText = "width:100%;max-width:340px;height:36px;border:1px solid var(--line,#E4DFD6);border-radius:9px;padding:0 10px;background:var(--paper,#fff);color:var(--ink,#22303A);margin-bottom:18px";
    fillTasks();
    const selLab = document.createElement("div");
    selLab.style.cssText = "font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);margin-bottom:6px";
    selLab.textContent = "专注哪个任务（可选）";

    const newTaskRow=document.createElement("div"); newTaskRow.style.cssText="display:flex;gap:8px;max-width:340px;margin:-8px auto 18px";
    const newTaskInput=document.createElement("input"); newTaskInput.placeholder="直接新建本次专注任务"; newTaskInput.style.cssText="flex:1;min-width:0;height:36px;border:1px solid var(--line,#E4DFD6);border-radius:9px;padding:0 10px;background:var(--paper,#fff);color:var(--ink,#22303A)";
    const addTaskBtn=mkBtn("+ 新建任务","var(--panel,#fff)","var(--deep,#0F4C5C)",true); addTaskBtn.style.cssText += ";min-width:92px;height:36px";
    addTaskBtn.addEventListener("click",()=>{ const title=newTaskInput.value.trim(); if(!title) return tide.notify("请先输入任务名称"); const t=tide.tasks.create({title,quad:2,estMin:modeSeconds(mode)/60,tags:["番茄专注"]}); newTaskInput.value=""; fillTasks(t.id); tide.notify(`已新建任务「${title}」`); });
    newTaskInput.addEventListener("keydown",e=>{if(e.key==="Enter") addTaskBtn.click();}); newTaskRow.append(newTaskInput,addTaskBtn);

    // 控制
    const ctrl = document.createElement("div");
    ctrl.style.cssText = "display:flex;justify-content:center;gap:10px";
    const startBtn = mkBtn("▶ 开始", "var(--deep,#0F4C5C)", "var(--on-deep,#fff)");
    startBtn.addEventListener("click", () => {
      if (timer) { stop(); startBtn.textContent = "▶ 继续"; }
      else { if (left <= 0) { left = modeSeconds(mode); firedStages = new Set(); paint(); } timer = setInterval(tick, 1000); startBtn.textContent = "⏸ 暂停"; }
    });
    const resetBtn = mkBtn("↺ 重置", "var(--panel,#fff)", "var(--ink-2,#7E8B94)", true);
    resetBtn.addEventListener("click", () => { stop(); left = modeSeconds(mode); firedStages = new Set(); paint(); startBtn.textContent = "▶ 开始"; });
    ctrl.append(startBtn, resetBtn);

    dotsBox = document.createElement("div");
    dotsBox.style.cssText = "display:flex;justify-content:center;align-items:center;gap:6px;margin-top:22px";
    renderDots();

    const panel = reminderPanel();

    card.append(title, modes, customRow, ringWrap, selLab, taskSel, newTaskRow, ctrl, dotsBox, panel.node);
    el2.append(card);
    paint();
    // 同步的 render 先按默认值画，设置读完后再对齐一次。
    reminderReady.then(() => panel.sync());
    customReady.then(() => {
      syncCustomInputs();
      // 设置读完之前画出来的是默认 25 分。只有当前正好是自定义模式、且计时没在跑时才改写倒计时，
      // 免得把用户已经开始的这一轮冲掉。
      if (mode.id === "custom" && !timer) { left = customSec; paint(); }
    });
  }

  function fillTasks(selectId = currentTaskId) {
    taskSel.innerHTML = "";
    taskSel.append(Object.assign(document.createElement("option"), { value: "", textContent: "（不关联任务）" }));
    for (const t of tide.tasks.list().filter((x) => !x.done)) {
      const o = document.createElement("option");
      o.value = t.id; o.textContent = t.title;
      taskSel.append(o);
    }
    if (selectId && [...taskSel.options].some(o => o.value === selectId)) taskSel.value = selectId;
    currentTaskId = taskSel.value;
    taskSel.onchange = () => { currentTaskId = taskSel.value; };
  }

  function mkBtn(text, bg, fg, ghost) {
    const b = document.createElement("button");
    b.textContent = text;
    b.style.cssText = `min-width:110px;height:40px;border-radius:20px;font-size:calc(13.5px * var(--ui-text-scale));font-weight:600;cursor:pointer;background:${bg};color:${fg};border:${ghost ? "1px solid var(--line,#E4DFD6)" : "none"}`;
    return b;
  }

  tide.ui.registerView({ id: "pomodoro", title: "番茄专注", icon: 'hourglass-half', render });
  tide.events.on("tasks:changed", () => { if (taskSel) fillTasks(); });
})();
