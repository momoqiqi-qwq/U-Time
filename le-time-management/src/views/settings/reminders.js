import { api } from "../../api.js";
import * as S from "../../store.js";
import { el, toast } from "../../ui.js";
import { DEFAULT_REMINDER_SETTINGS, PRESET_OFFSETS, RING_MAX_OPTIONS, normalizeOffsets, playReminderSound, previewRingSound, reminderLabel, testTaskReminder } from "../../taskReminder.js";
import { BUILTIN_SOUNDS, CUSTOM_SOUND_ID, DEFAULT_LOOP_SOUND_ID, DEFAULT_SOUND_ID, isLoopableSound, resolveSound } from "../../sound.js";
import { isAndroidRuntime, notifyStatus, askNotifyPermission, openNotifySettings, openExactAlarmSettings } from "../../androidNotify.js";
import { toggleSwitch } from "../../switchControl.js";

export async function createReminderCard({ settings, info, render }) {
    /* 任务提醒 */
    settings.taskReminder ??= structuredClone(DEFAULT_REMINDER_SETTINGS);
    const rc = settings.taskReminder;
    rc.defaultOffsets = normalizeOffsets(rc.defaultOffsets || DEFAULT_REMINDER_SETTINGS.defaultOffsets);
    const reminderCard = el("div", { class: "card set-card" },
      el("h2", {}, "任务提醒"),
    );
    const enabled = toggleSwitch({ checked: rc.enabled !== false });
    enabled.addEventListener("change", () => { rc.enabled = enabled.checked; S.saveNow(); });
    const vol = el("input", { type: "range", min: "0", max: "100", step: "1", value: Math.round((Number(rc.volume) || 0) * 100) });
    const volText = el("b", {}, `${vol.value}%`);
    vol.addEventListener("input", () => { volText.textContent = `${vol.value}%`; rc.volume = Number(vol.value) / 100; S.persistSoon(); });
    const sound = el("select", {});
    for (const preset of BUILTIN_SOUNDS) sound.append(el("option", { value: preset.id }, preset.label));
    sound.append(el("option", { value: CUSTOM_SOUND_ID }, "自定义音频"));
    sound.value = resolveSound(rc.sound || DEFAULT_SOUND_ID);
    sound.addEventListener("change", () => { rc.sound = sound.value; S.saveNow(); });
    const audioInput = el("input", { type: "file", accept: "audio/*,.mp3,.wav,.m4a,.aac,.ogg", style: "display:none" });
    const audioName = el("span", { class: "audio-name" }, rc.customAudioName || "尚未导入音频");
    audioInput.addEventListener("change", async () => {
      const f = audioInput.files?.[0]; if (!f) return;
      if (f.size > 8 * 1024 * 1024) { toast("音频文件请控制在 8MB 以内"); audioInput.value = ""; return; }
      const reader = new FileReader();
      reader.onload = async () => { rc.customAudio = String(reader.result || ""); rc.customAudioName = f.name; rc.sound = "custom"; sound.value = "custom"; await S.saveNow(); audioName.textContent = f.name; toast("自定义提醒音已导入"); };
      reader.onerror = () => toast("音频读取失败");
      reader.readAsDataURL(f);
    });
    const defaultBox = el("div", { class: "reminder-picks settings-reminder-picks" });
    const customDefault = el("input", { type: "number", min: "0", max: "43200", placeholder: "自定义分钟", class: "reminder-custom" });
    const renderDefaults = () => {
      defaultBox.replaceChildren();
      const cur = normalizeOffsets(rc.defaultOffsets);
      for (const off of PRESET_OFFSETS) {
        const on = cur.includes(off);
        defaultBox.append(el("button", { type: "button", class: `reminder-chip${on ? " on" : ""}`, onclick: () => { rc.defaultOffsets = on ? cur.filter(x => x !== off) : normalizeOffsets([...cur, off]); S.saveNow(); renderDefaults(); } }, off === 0 ? "到点" : reminderLabel(off).replace("截止", "")));
      }
      for (const off of cur.filter(x => !PRESET_OFFSETS.includes(x))) defaultBox.append(el("button", { type: "button", class: "reminder-chip on", onclick: () => { rc.defaultOffsets = cur.filter(x => x !== off); S.saveNow(); renderDefaults(); } }, `${off} 分钟 ×`));
      defaultBox.append(customDefault, el("button", { type: "button", class: "btn ghost sm", onclick: () => { const n = Math.round(Number(customDefault.value)); if (!Number.isFinite(n) || n < 0 || n > 43200) return toast("请输入 0～43200 分钟"); rc.defaultOffsets = normalizeOffsets([...cur, n]); customDefault.value = ""; S.saveNow(); renderDefaults(); } }, "添加"));
    };
    renderDefaults();

    /* 持续长鸣：到点这一档一声短提示音催不动人，要响到用户来处理（或到最长响铃自动停） */
    const ringOn = toggleSwitch({ checked: rc.ringEnabled !== false });
    ringOn.addEventListener("change", () => { rc.ringEnabled = ringOn.checked; S.saveNow(); });
    const ringSound = el("select", {});
    for (const preset of BUILTIN_SOUNDS.filter((p) => p.loop)) ringSound.append(el("option", { value: preset.id }, preset.label));
    ringSound.append(el("option", { value: CUSTOM_SOUND_ID }, "自定义音频循环"));
    ringSound.value = isLoopableSound(rc.ringSound) ? resolveSound(rc.ringSound) : DEFAULT_LOOP_SOUND_ID;
    ringSound.addEventListener("change", () => { rc.ringSound = ringSound.value; S.saveNow(); });
    const ringMax = el("select", {});
    for (const opt of RING_MAX_OPTIONS) ringMax.append(el("option", { value: String(opt.ms) }, opt.label));
    ringMax.value = String(rc.ringMaxMs);
    ringMax.addEventListener("change", () => { rc.ringMaxMs = Number(ringMax.value); S.saveNow(); });

    /* Android 系统通知与后台闹钟：这一节只在 APK 上出现（桌面与浏览器调试没有原生桥） */
    const nativeRows = [];
    if (isAndroidRuntime()) {
      const permState = el("b", { class: "notify-state" }, "检查中…");
      const askBtn = el("button", { class: "btn ghost sm", onclick: async () => { const r = await askNotifyPermission(); await paintNotifyState(); toast(r.granted ? "已允许通知" : "仍未授权：请到系统通知设置里手动打开"); } }, "授权");
      const openBtn = el("button", { class: "btn ghost sm", onclick: () => openNotifySettings() }, "通知设置");
      const exactState = el("b", { class: "notify-state" }, "");
      const exactBtn = el("button", { class: "btn ghost sm", onclick: () => openExactAlarmSettings() }, "去开启");
      const alarmOn = toggleSwitch({ checked: rc.nativeAlarm !== false });
      alarmOn.addEventListener("change", () => {
        rc.nativeAlarm = alarmOn.checked;
        S.saveNow();
        toast(alarmOn.checked ? "已开启后台闹钟：应用被划掉也能到点弹通知" : "已关闭后台闹钟：只剩应用内提醒");
      });
      async function paintNotifyState() {
        const st = await notifyStatus();
        permState.textContent = !st.supported ? "原生桥不可用（请更新 APK）" : st.granted ? "已授权" : "未授权";
        permState.dataset.on = st.granted ? "1" : "0";
        exactState.textContent = st.exact ? "已授权（准点）" : "未授权：深睡时最坏晚几分钟";
        exactState.dataset.on = st.exact ? "1" : "0";
        askBtn.style.display = st.granted ? "none" : "";
        exactBtn.style.display = st.exact ? "none" : "";
      }
      nativeRows.push(
        el("div", { class: "setting-row" }, el("span", {}, "系统通知"),
          el("span", { class: "notify-row" }, permState, askBtn, openBtn)),
        el("div", { class: "setting-row" }, el("span", {}, "精确闹钟"),
          el("span", { class: "notify-row" }, exactState, exactBtn)),
        el("div", { class: "setting-row" }, el("span", {}, "后台闹钟"), alarmOn),
        el("p", { class: "set-hint" }, "关掉后台闹钟就只剩应用内提醒：应用被系统划掉后到点不会有任何动静。国产 ROM（MIUI / 华为 / OPPO）还需在系统里允许本应用「自启动 / 后台运行」，否则闹钟会被省电策略清掉。"),
      );
      paintNotifyState();
    }

    reminderCard.append(
      el("div", { class: "setting-row" }, el("span", {}, "启用任务提醒"), enabled),
      el("div", { class: "setting-row" },
        el("span", {}, "系统弹窗测试"),
        el("button", {
          class: "btn ghost sm", type: "button",
          onclick: async () => {
            const result = await testTaskReminder();
            if (!api.isTauri) return;
            if (result?.applied === false) toast(`系统弹窗发送失败：${result.error || result.reason || "未知原因"}`);
            else toast("系统弹窗命令已发送，请查看 Windows 右下角或通知中心");
          },
        }, "测试提醒")),
      el("div", { class: "setting-row" }, el("span", {}, "提醒音量"), el("span", { class: "volume-row" }, vol, volText)),
      el("div", { class: "setting-row" }, el("span", {}, "提示音"), sound),
      el("div", { class: "setting-row" }, el("span", {}, "自定义音频"), el("span", { class: "audio-actions" }, audioName, el("button", { class: "btn ghost sm", onclick: () => audioInput.click() }, "导入音频"), el("button", { class: "btn ghost sm", onclick: () => playReminderSound(true) }, "试听"))),
      audioInput,
      el("div", { class: "setting-row setting-col" }, el("span", {}, "默认提前预警"), defaultBox),
      el("div", { class: "setting-row" }, el("span", {}, "到点持续长鸣"), ringOn),
      el("div", { class: "setting-row" }, el("span", {}, "长鸣音效"),
        el("span", { class: "audio-actions" }, ringSound, el("button", { class: "btn ghost sm", onclick: () => previewRingSound() }, "试听"))),
      el("div", { class: "setting-row" }, el("span", {}, "最长响铃"), ringMax),
      el("p", { class: "set-hint" }, "只有「已到截止时间」这一档走长鸣，提前预警仍是一声短音。长鸣可用通知上的「停止响铃」或横幅上的同名按钮停掉，到最长响铃时长会自动停。"),
      ...nativeRows,
    );

  return reminderCard;
}
