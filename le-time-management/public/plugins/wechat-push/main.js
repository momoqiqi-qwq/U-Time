// 微信提醒推送 —— PushPlus 主通道，兼容旧 Server酱配置。
(function () {
  const PUSHPLUS_URL = "https://www.pushplus.plus/send";
  // pushplus 官方文档（经系统浏览器打开，不在应用内跳转）
  const PUSHPLUS_DOCS = [
    ["使用说明 / SDK", "https://www.pushplus.plus/doc/guide/sdk.html"],
    ["消息接口文档（参数与返回码）", "https://www.pushplus.plus/doc/guide/api.html"],
  ];
  const SCT = (key, title, desp) =>
    `https://sctapi.ftqq.com/${encodeURIComponent(key)}.send?title=${encodeURIComponent(title)}&desp=${encodeURIComponent(desp)}`;

  /* 插件消息攒批参数（对照 PushPlus 官方限制：相同内容 1 小时限 3 条、每分钟限 5 次、内容 ≤20000 字）：
     新消息先攒 2 分钟再合并成「一条」推送，一批带上队列里全部待发消息，把请求数压到最低。 */
  const PLUGIN_QUEUE_CAP = 60;                  // 队列上限（超出丢最旧的）
  const PLUGIN_BATCH_WINDOW_MS = 2 * 60 * 1000; // 攒批窗口：首条入队后等 2 分钟再发
  const PLUGIN_CONTENT_LIMIT = 18000;           // 单条推送正文字数上限（官方 20000，留余量）

  /* 可推送的插件消息源（都会广播 notice:new）。写死这一份是因为推送页要能「装好就能勾」，
     而不是等插件抓到东西才冒出来；用户插件广播时由 rememberSource 动态补进列表。
     name 只是兜底显示名（广播里带的 sourceName / 用户插件第一次广播的名字），
     内置插件优先显示 pluginCatalog 的正式名，与侧栏、插件中心一致。 */
  const SOURCE_SEED = [
    { id: "chaoxing-notify", name: "学习通" },
    { id: "cppu-notify", name: "警大门户" },
    { id: "gx-news", name: "竞赛消息" },
    { id: "rss-reader", name: "RSS 订阅" },
    { id: "school-notice", name: "学校通知" },
  ];

  const state = {
    enabled: false, provider: "pushplus", token: "", topic: "", oldKey: "",
    blockEnabled: true, taskEnabled: true, lead: 5,
    pushScope: ["block", "task"],   // 多选：block=时间块 / task=任务截止 / plugin=插件收集的新消息
    pluginPicks: null,              // 「插件消息」再细分：允许推送的插件 id 数组；null = 全部（老配置未细分时的行为）
    knownSources: [],               // 广播过 notice:new 的消息源 [{id,name}]，用户插件靠它出现在勾选列表里
    pluginQueue: [],                // 待推送的插件新消息（内存队列，攒批窗口到了合并发送）
    pluginTimer: null,              // 攒批窗口计时器（节流式：窗口内新消息只进队列，不重置窗口）
    timer: null, pushed: [], log: [], sid: null,
  };
  let ui = null;
  let prefsPromise = null;
  let srcKey = "";   // 上一次渲染的插件源清单（变了才重建勾格 DOM）

  async function loadPrefs() {
    const [enabled, provider, token, topic, oldKey, blockEnabled, taskEnabled, lead, pushed, log, pushScope, pluginPicks, pluginSources] = await Promise.all([
      tide.storage.get("enabled", false), tide.storage.get("provider", ""), tide.storage.get("pushplusToken", ""),
      tide.storage.get("pushplusTopic", ""), tide.storage.get("key", ""), tide.storage.get("blockEnabled", true),
      tide.storage.get("taskEnabled", true), tide.storage.get("lead", 5), tide.storage.get("pushed", []), tide.storage.get("log", []),
      tide.storage.get("pushScope", null), tide.storage.get("pluginPicks", null), tide.storage.get("pluginSources", []),
    ]);
    state.enabled = !!enabled;
    state.oldKey = oldKey || "";
    state.provider = provider || (state.oldKey && !token ? "serverchan" : "pushplus");
    state.token = token || "";
    state.topic = topic || "";
    state.blockEnabled = blockEnabled !== false;
    state.taskEnabled = taskEnabled !== false;
    state.lead = Math.max(1, Number(lead) || 5);
    state.pushed = Array.isArray(pushed) ? pushed : [];
    state.log = Array.isArray(log) ? log : [];
    // pushScope 是 v1.7.0 的多选存储；老配置没有它时从旧的两个开关反推（含旧「全关」→ 回默认两项），
    // 保证升级不丢用户选择。blockEnabled/taskEnabled 从此作为 pushScope 的镜像维护，tick 逻辑不变。
    const valid = (v) => Array.isArray(v) && (v = v.filter((k) => ["block", "task", "plugin"].includes(k))).length ? v : null;
    state.pushScope = valid(pushScope)
      || (state.blockEnabled && state.taskEnabled ? ["block", "task"] : state.blockEnabled ? ["block"] : state.taskEnabled ? ["task"] : ["block", "task"]);
    state.blockEnabled = state.pushScope.includes("block");
    state.taskEnabled = state.pushScope.includes("task");
    // pluginPicks 为 null = 未细分（所有消息源都推），与 v1.8.1 及以前的行为一致，升级不改变现有推送范围；
    // 用户一旦取消过某个插件的勾就落成显式数组，此后新出现的消息源不会被默认打开。
    state.pluginPicks = Array.isArray(pluginPicks) ? pluginPicks.map(String) : null;
    state.knownSources = (Array.isArray(pluginSources) ? pluginSources : [])
      .filter((s) => s && typeof s.id === "string").map((s) => ({ id: s.id, name: String(s.name || s.id) }));
  }
  const ensurePrefs = () => (prefsPromise ||= loadPrefs());

  const save = () => Promise.all([
    tide.storage.set("enabled", state.enabled), tide.storage.set("provider", state.provider),
    tide.storage.set("pushplusToken", state.token), tide.storage.set("pushplusTopic", state.topic),
    tide.storage.set("key", state.oldKey), tide.storage.set("blockEnabled", state.blockEnabled),
    tide.storage.set("taskEnabled", state.taskEnabled), tide.storage.set("lead", state.lead),
    tide.storage.set("pushed", state.pushed), tide.storage.set("log", state.log),
    tide.storage.set("pushScope", state.pushScope),
    tide.storage.set("pluginPicks", state.pluginPicks), tide.storage.set("pluginSources", state.knownSources),
  ]);

  /* ── 消息源清单与勾选判定 ── */
  // 插件清单里的正式名（tide.plugins.list 是内置 + 用户插件全量）；取不到时退回 sourceOptions 的兜底名。
  function pluginNames() {
    const map = new Map();
    try {
      for (const p of (tide.plugins && tide.plugins.list ? tide.plugins.list() : [])) {
        if (p && p.id) map.set(p.id, String(p.name || p.id));
      }
    } catch { return map; }   // 宿主未提供清单能力时退回种子名，推送页照常可用
    return map;
  }
  // 勾格里显示的插件图标：内置插件用随包 PNG（侧栏同一套），用户插件没有 PNG 时由 onerror 退回插头符号。
  function sourceIcon(id) { return `/icons/plugins/${encodeURIComponent(id)}.png`; }
  function sourceOptions() {
    const names = pluginNames();
    const byId = new Map(SOURCE_SEED.map((s) => [s.id, s.name]));
    for (const s of state.knownSources) if (!byId.has(s.id)) byId.set(s.id, s.name);
    return [...byId].map(([id, seedName]) => ({ id, name: names.get(id) || seedName }));
  }
  // 该消息源是否允许入队推送：「插件消息」总开关 + 插件级勾选两层都过才算。
  function allowedSource(id) {
    return state.pushScope.includes("plugin")
      && (state.pluginPicks === null || state.pluginPicks.includes(id));
  }
  // 记下来过消息的用户插件，让它出现在勾选列表里（下一次进推送页也能看到）。
  function rememberSource(id, name) {
    if (state.knownSources.some((s) => s.id === id)) return;
    state.knownSources.push({ id, name });
    save();
  }

  function configured() { return state.provider === "pushplus" ? !!state.token : !!state.oldKey; }
  function dueAt(task) {
    if (!task || !task.due) return null;
    const time = /^\d{2}:\d{2}$/.test(task.dueTime || "") ? task.dueTime : "23:59";
    const d = new Date(`${task.due}T${time}:00`);
    return Number.isFinite(d.getTime()) ? d.getTime() : null;
  }
  function offsetLabel(min) {
    if (min === 0) return "已到截止时间";
    if (min < 60) return `还有 ${min} 分钟截止`;
    if (min % 1440 === 0) return `还有 ${min / 1440} 天截止`;
    if (min % 60 === 0) return `还有 ${min / 60} 小时截止`;
    return `还有 ${Math.floor(min / 60)} 小时 ${min % 60} 分钟截止`;
  }
  const blockMessage = (b) => ({
    title: `⏰ ${b.start} ${b.title}`,
    content: `${b.start} – ${tide.util.hhmmOf(tide.util.mmOf(b.start) + b.durMin)} · ${b.durMin} 分钟\n\n来自 U-Time · 时间块提醒`,
  });
  const taskMessage = (task, offset) => ({
    title: `📌 ${task.title}`,
    content: `${offsetLabel(offset)}\n截止：${task.due} ${task.dueTime || "23:59"}\n\n来自 U-Time · 任务提醒`,
  });
  function pluginMessage(batch, now) {
    const srcs = [...new Set(batch.map((x) => x.source))];
    const from = srcs.length > 1 ? `${srcs.slice(0, 3).join("、")}${srcs.length > 3 ? " 等" : ""}` : srcs[0] || "";
    const title = `🔔 插件新消息 ${batch.length} 条（${now}）${from ? ` · ${from}` : ""}`;
    let body = batch.map((x) => `· [${x.source}${x.sender ? `·${x.sender}` : ""}] ${x.title}${x.time ? `（${x.time}）` : ""}`).join("\n");
    if (body.length > PLUGIN_CONTENT_LIMIT) body = `${body.slice(0, PLUGIN_CONTENT_LIMIT)}\n…（内容过长已截断）`;
    return { title, content: `${body}\n\n来自 U-Time · 插件消息推送` };
  }

  function startTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(tick, 60 * 1000);
  }

  async function tick() {
    if (!state.enabled || !configured()) return;
    const now = new Date(), nowMs = now.getTime(), d = tide.util.today();
    let dirty = false;
    const keepAfter = nowMs - 7 * 86400000;
    const kept = state.pushed.filter((k) => {
      const ts = Number(String(k).split("|").pop());
      return !Number.isFinite(ts) || ts >= keepAfter;
    });
    if (kept.length !== state.pushed.length) { state.pushed = kept; dirty = true; }

    if (state.blockEnabled) {
      const blocks = await tide.blocks.list(d);
      const nowMin = now.getHours() * 60 + now.getMinutes();
      for (const b of blocks) {
        const [h, m] = String(b.start || "00:00").split(":").map(Number);
        const delta = h * 60 + m - nowMin;
        const eventAt = new Date(`${d}T${b.start}:00`).getTime();
        const key = `block|${b.id}|${eventAt}`;
        if (delta >= 0 && delta <= state.lead && !state.pushed.includes(key)) {
          state.pushed.push(key); dirty = true;
          const msg = blockMessage(b); await push(msg.title, msg.content);
        }
      }
    }

    if (state.taskEnabled) {
      const tasks = await tide.tasks.list();
      for (const task of tasks) {
        if (!task || task.done || task.reminderEnabled === false) continue;
        const due = dueAt(task); if (!due) continue;
        const offsets = Array.isArray(task.reminderOffsets) ? task.reminderOffsets : [60, 10, 0];
        for (const raw of offsets) {
          const offset = Math.max(0, Math.round(Number(raw) || 0));
          const at = due - offset * 60000;
          const key = `task|${task.id}|${offset}|${at}`;
          if (nowMs >= at && nowMs - at <= 90000 && !state.pushed.includes(key)) {
            state.pushed.push(key); dirty = true;
            const msg = taskMessage(task, offset); await push(msg.title, msg.content);
          }
        }
      }
    }
    if (dirty) await save();
    // 攒批窗口没在倒计时才补发（失败重试 / 兜底走这里）；窗口倒计时中不动队列，等窗口到点一次性发
    if (!state.pluginTimer) await flushPluginNotices();
  }

  /* ── 插件消息通道：订阅 notice:new（学习通等插件抓到新通知时广播），攒批合并为一条推送 ──
     PushPlus 官方限制：相同内容 1 小时限 3 条、每分钟限 5 次、内容 ≤20000 字。
     策略：首条消息入队后开 2 分钟攒批窗口（节流式，窗口内新消息只进队列不重置窗口），
     到点把队列里「全部」待发消息合并成一条推送；失败留在队列里，下一分钟的 tick 重试。
     两层勾选：「插件消息」总开关 + 插件级勾（pluginPicks）；没勾的源直接不入队，不占频次额度。 */
  function queuePluginNotice(p) {
    if (!p || !Array.isArray(p.items) || !p.items.length) return;
    // 广播可能早于偏好读回（进应用就抓到新消息），先等 prefs 落地再判勾选 ——
    // 否则 state 还是默认值，用户明明勾了的插件会被当成没勾而丢掉。
    ensurePrefs().then(() => enqueuePluginNotice(p));
  }

  function enqueuePluginNotice(p) {
    const id = String(p.source || p.sourceName || "plugin").slice(0, 40);
    const name = String(p.sourceName || p.source || "插件").slice(0, 12);
    const unseen = !SOURCE_SEED.some((s) => s.id === id) && !state.knownSources.some((s) => s.id === id);
    rememberSource(id, name);
    if (unseen) paintSources();   // 用户插件第一次广播：立刻出现在勾格里，不用重开推送页
    if (!allowedSource(id)) return;
    for (const it of p.items.slice(0, 5)) {
      state.pluginQueue.push({
        id, source: name,
        title: String(it.title || "(无标题)").slice(0, 60),
        time: String(it.time || "").slice(0, 16),
        sender: String(it.sender || "").slice(0, 12),
      });
    }
    if (state.pluginQueue.length > PLUGIN_QUEUE_CAP) state.pluginQueue = state.pluginQueue.slice(-PLUGIN_QUEUE_CAP);
    paintQueue();
    if (!state.pluginTimer) {
      state.pluginTimer = setTimeout(async () => {
        state.pluginTimer = null;
        await flushPluginNotices();
      }, PLUGIN_BATCH_WINDOW_MS);
    }
  }

  // 刚取消勾选的插件可能已有消息在队列里等着发，一并清掉，否则「取消后还是收到了推送」。
  function pruneQueue() {
    const before = state.pluginQueue.length;
    state.pluginQueue = state.pluginQueue.filter((x) => allowedSource(x.id));
    if (before !== state.pluginQueue.length) paintQueue();
  }

  async function flushPluginNotices() {
    if (!state.pluginQueue.length) return;
    if (!state.enabled || !configured() || !state.pushScope.includes("plugin")) return;
    const batch = state.pluginQueue.slice(); // 一批带上队列里全部待发消息，把请求数压到最低
    const now = new Date().toTimeString().slice(0, 5);
    const msg = pluginMessage(batch, now);
    const ok = await push(msg.title, msg.content);
    if (ok) { state.pluginQueue.splice(0, batch.length); paintQueue(); }
  }

  async function pushPlus(title, content) {
    if (!state.token) throw new Error("请先填写 PushPlus Token");
    state.sid ||= await tide.http.session();
    const payload = { token: state.token, title, content, template: "txt", channel: "wechat" };
    if (state.topic) payload.topic = state.topic;
    const res = await tide.http.fetch(state.sid, "POST", PUSHPLUS_URL, {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    let data = null; try { data = JSON.parse(res.body); } catch {}
    if (res.status < 200 || res.status >= 300 || !data || Number(data.code) !== 200) {
      // PushPlus 返回码：999=服务端验证错误（常见于相同内容 1 小时超 3 条 / 每分钟超 5 次的频次拦截），
      // 903=token 不正确，905=未实名认证，900=当日请求超限。带上 code 方便对官方返回码表排查。
      throw new Error(`PushPlus[${data ? data.code : `HTTP ${res.status}`}]${data?.msg || "请求失败"}`);
    }
    return true;
  }

  async function serverChan(title, content) {
    if (!state.oldKey) throw new Error("请先填写 Server酱 SendKey");
    const res = await tide.http.get(SCT(state.oldKey, title, content));
    let data = null; try { data = JSON.parse(res.body); } catch {}
    if (res.status < 200 || res.status >= 300 || !data || Number(data.code) !== 0) throw new Error(data?.message || `HTTP ${res.status}`);
    return true;
  }

  async function push(title, content) {
    try {
      if (state.provider === "pushplus") await pushPlus(title, content); else await serverChan(title, content);
      state.log.unshift(`${new Date().toTimeString().slice(0, 5)} ✓ ${state.provider === "pushplus" ? "PushPlus" : "Server酱"}已提交：${title.slice(0, 26)}`);
      state.log = state.log.slice(0, 12); await save(); paintLog(); return true;
    } catch (e) {
      const msg = String(e.message || e);
      // 999=PushPlus 频次拦截（相同内容 1 小时限 3 条、每分钟限 5 次），给一句能自助解决的提示。
      const hint = /999|服务端验证/.test(msg) ? "（PushPlus 相同内容 1 小时只能发 3 条、每分钟最多 5 次；多为短时间重复测试所致，等一会或改下内容即可）" : "";
      state.log.unshift(`${new Date().toTimeString().slice(0, 5)} ✗ 推送「${title.slice(0, 20)}」：${msg}${hint}`);
      state.log = state.log.slice(0, 12); await save(); paintLog(); tide.notify(`推送失败：${msg}`); return false;
    }
  }

  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }
  // 多选面板里的待推送计数：攒批窗口倒计时中会标注，发完自动隐藏
  function paintQueue() {
    if (!ui?.msQueue) return;
    const n = state.pluginQueue.length;
    if (!n) { ui.msQueue.hidden = true; return; }
    ui.msQueue.hidden = false;
    ui.msQueue.textContent = `待推送：${n} 条${state.pluginTimer ? " · 攒批中，最多 2 分钟后合并发送" : ""}`;
  }
  /* 插件级勾格：一格一个消息源（图标 + 复选框 + 短名），在「推送内容」下拉里排成多列。
     只有源清单变化（用户插件第一次广播）才重建 DOM；平时勾选只同步勾态与总开关的灰置，
     重建会让刚点下的复选框丢焦点。 */
  function paintSources() {
    if (!ui?.msSrcs) return;
    const opts = sourceOptions();
    const key = opts.map((s) => s.id).join(",");
    if (key !== srcKey) {
      srcKey = key;
      ui.msSrcs.replaceChildren(...opts.map((s) => {
        const ico = document.createElement("span");
        ico.className = "wp-src-icon";
        const img = document.createElement("img");
        img.src = sourceIcon(s.id); img.alt = ""; img.decoding = "async";
        // 用户插件没有随包 PNG（那目录只放内置插件）→ 退成插头符号，别留裂图
        img.addEventListener("error", () => { ico.classList.add("no-img"); img.remove(); }, { once: true });
        ico.append(img);
        const cb = document.createElement("input");
        cb.type = "checkbox"; cb.dataset.src = s.id;
        const cell = document.createElement("label");
        cell.className = "wp-check wp-src";
        cell.append(ico, cb, document.createTextNode(s.name));
        return cell;
      }));
    }
    const all = state.pluginPicks === null;
    for (const cb of ui.msSrcs.querySelectorAll("[data-src]")) {
      cb.checked = all || state.pluginPicks.includes(cb.dataset.src);
    }
    ui.msSrcs.classList.toggle("off", !state.pushScope.includes("plugin"));
  }
  function ensureStyle() {
    if (document.getElementById("wp-push-style")) return;
    const st = document.createElement("style"); st.id = "wp-push-style";
    st.textContent = `.wp-wrap{max-width:680px;margin:0 auto}.wp-card{background:var(--panel,#fff);border:1px solid var(--line,#E4DFD6);border-radius:16px;padding:20px 22px}.wp-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}.wp-field{margin-top:12px}.wp-field label{display:block;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);margin-bottom:4px}.wp-field input:not(.switch),.wp-field select,.wp-row select{height:38px;border:1px solid var(--line,#E4DFD6);border-radius:9px;padding:0 10px;background:var(--panel,#fff);color:var(--ink,#22303A)}.wp-field input:not(.switch){width:100%}.wp-btn{font-size:calc(12px * var(--ui-text-scale));border:1px solid var(--line,#E4DFD6);border-radius:8px;padding:8px 13px;background:var(--panel,#fff);cursor:pointer;color:var(--ink,#22303A)}.wp-btn.pri{background:var(--deep,#0F4C5C);color:#fff;border-color:var(--deep,#0F4C5C)}.wp-check{display:inline-flex;gap:8px;align-items:center;font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#667780)}.wp-check .switch{margin-top:0}.wp-note{font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);line-height:1.75;margin-top:10px;background:var(--paper,#f6f7f7);padding:9px 10px;border-radius:9px}.wp-docs{margin-top:10px;font-size:calc(11.5px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)}.wp-link{color:var(--sea,#118AB2);cursor:pointer;text-decoration:underline;text-underline-offset:2px}.wp-log{margin-top:14px;border-top:1px dashed var(--line,#EFEAE1);padding-top:8px}.wp-provider{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.wp-provider button{padding:10px;border:1px solid var(--line,#ddd);border-radius:10px;background:var(--panel,#fff);cursor:pointer}.wp-provider button.on{border-color:var(--deep,#0F4C5C);box-shadow:inset 0 0 0 1px var(--deep,#0F4C5C)}.wp-multi{position:relative;display:inline-flex}.wp-multi b{font-weight:650;color:var(--ink,#22303A)}.wp-ms-panel{position:absolute;top:calc(100% + 6px);left:0;z-index:40;background:var(--panel,#fff);border:1px solid var(--line,#E4DFD6);border-radius:12px;padding:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(146px,1fr));gap:8px 10px;width:min(78vw,430px);max-height:min(56vh,420px);overflow:auto;box-shadow:0 10px 26px rgba(0,0,0,.14);opacity:0;transform:translateY(-6px);visibility:hidden;pointer-events:none;transition:opacity .18s ease,transform .18s ease,visibility 0s linear .18s}.wp-ms-panel.on{opacity:1;transform:translateY(0);visibility:visible;pointer-events:auto;transition:opacity .18s ease,transform .18s ease,visibility 0s}.wp-ms-caret{display:inline-block;transition:transform .18s ease}.wp-multi.open .wp-ms-caret{transform:rotate(180deg)}@media (prefers-reduced-motion:reduce){.wp-ms-panel,.wp-ms-caret{transition:none}}.wp-ms-cap{grid-column:1/-1;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#A9B2BA);letter-spacing:.06em;margin-top:2px}.wp-ms-ico{width:17px;flex:none;text-align:center;font-size:calc(13px * var(--ui-text-scale));line-height:1}.wp-ms-note{grid-column:1/-1;font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);line-height:1.6}.wp-srcs{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:4px 8px;border-top:1px dashed var(--line,#EFEAE1);padding-top:9px;margin-top:1px;transition:opacity .18s ease}.wp-srcs.off{opacity:.45;pointer-events:none;filter:grayscale(1)}.wp-src{min-height:32px;padding:4px 7px;border-radius:9px;transition:background .18s ease}.wp-src:hover{background:var(--paper,#f6f7f7)}@media (prefers-reduced-motion:reduce){.wp-srcs,.wp-src{transition:none}}.wp-src-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wp-src-icon{width:20px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:6px}.wp-src-icon img{width:20px;height:20px;object-fit:contain;display:block}.wp-src-icon.no-img{background:color-mix(in srgb,var(--deep,#0F4C5C) 12%,var(--panel,#fff))}.wp-src-icon.no-img::after{content:"🔌";font-size:calc(11px * var(--ui-text-scale))}@media(max-width:620px){.wp-provider{grid-template-columns:1fr}.wp-row>*{flex:1}.wp-row .wp-check{flex:auto}}`;
    st.textContent += `.wp-preview{margin-top:12px;padding:14px;background:#e6e5e3;border:1px solid #d3d2cf;border-radius:8px;color:#1b1b1b}.wp-preview-head{display:flex;align-items:center;gap:9px;margin-bottom:10px;font-size:calc(13px * var(--ui-text-scale))}.wp-preview-avatar{width:34px;height:34px;display:grid;place-items:center;border-radius:5px;background:#18a058;color:#fff;font-weight:750}.wp-preview-time{margin-left:auto;color:#888;font-size:calc(11px * var(--ui-text-scale))}.wp-preview-bubble{margin-left:42px;background:#fff;border:1px solid #ddd;border-radius:5px;padding:12px;max-width:520px;box-shadow:0 1px 2px rgba(0,0,0,.05)}.wp-preview-title{font-weight:700;overflow-wrap:anywhere}.wp-preview-content{margin-top:9px;white-space:pre-wrap;line-height:1.6;font-size:calc(12px * var(--ui-text-scale));overflow-wrap:anywhere}.wp-preview-note{font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);margin-top:7px}`;
    document.head.append(st);
  }

  function render(el) {
    ensureStyle(); el.innerHTML = "";
    const wrap = document.createElement("div"); wrap.className = "wp-wrap";
    wrap.innerHTML = `<div style="font-size:calc(11px * var(--ui-text-scale));letter-spacing:.3em;color:var(--ink-2,#7E8B94);margin:14px 0 12px">微 信 信 息 推 送 · PushPlus</div><div class="wp-card"><div style="font-size:calc(15px * var(--ui-text-scale));font-weight:750">微信推送通道</div><div class="wp-note">推荐使用 PushPlus：点「一键获取 Token」打开一对一消息页，微信扫码登录后复制页面上的 Token 粘贴回来。默认通过微信公众号渠道发送；如填写群组编码 Topic，则发到对应群组。旧版 Server酱配置继续保留兼容。</div><div class="wp-docs">官方文档：<span class="wp-link" data-doc="${PUSHPLUS_DOCS[0][1]}">${PUSHPLUS_DOCS[0][0]}</span> · <span class="wp-link" data-doc="${PUSHPLUS_DOCS[1][1]}">${PUSHPLUS_DOCS[1][0]}</span></div><div class="wp-provider"><button data-provider="pushplus">PushPlus（推荐）</button><button data-provider="serverchan">Server酱（兼容）</button></div><div data-pp><div class="wp-field"><label>PushPlus Token</label><input data-token type="password" autocomplete="off" placeholder="粘贴 Token"></div><div class="wp-row" style="margin-top:8px"><button class="wp-btn pri" data-gettoken>↗ 一键获取 Token</button><span style="font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)">打开「一对一消息」页（未登录会先跳登录），登录后即可复制 Token</span></div><div class="wp-field"><label>Topic（可选，群组编码）</label><input data-topic type="text" placeholder="不填则只推送给自己"></div></div><div data-sct><div class="wp-field"><label>Server酱 SendKey</label><input data-key type="password" autocomplete="off" placeholder="SCT…"></div></div><div class="wp-row"><label class="wp-check"><input class="switch" role="switch" data-en type="checkbox">启用微信推送</label><div class="wp-multi" data-ms><button type="button" class="wp-btn" data-ms-btn aria-haspopup="true" aria-expanded="false">推送内容：<b data-ms-label></b> <span class="wp-ms-caret" aria-hidden="true">▾</span></button><div class="wp-ms-panel" data-ms-panel><span class="wp-ms-cap">应用内提醒</span><label class="wp-check"><span class="wp-ms-ico" aria-hidden="true">⏰</span><input type="checkbox" data-ms="block">时间块提醒</label><label class="wp-check"><span class="wp-ms-ico" aria-hidden="true">📌</span><input type="checkbox" data-ms="task">任务截止提醒</label><span class="wp-ms-cap">插件收集的新消息</span><label class="wp-check"><span class="wp-ms-ico" aria-hidden="true">🔔</span><input type="checkbox" data-ms="plugin">总开关</label><div class="wp-srcs" data-ms-srcs></div><div class="wp-ms-note">先攒 2 分钟，再把队列里全部待发消息合并成一条推送，尽量少占 PushPlus 频次额度（相同内容 1 小时限 3 条、每分钟限 5 次）。只想收某几个插件的消息，在上面的格子里取消勾选即可。</div><div class="wp-ms-note" data-ms-queue hidden></div></div></div></div><div class="wp-row"><span style="font-size:calc(12px * var(--ui-text-scale));color:var(--ink-2,#7E8B94)">时间块提前</span><select data-lead><option value="3">3 分钟</option><option value="5">5 分钟</option><option value="10">10 分钟</option><option value="15">15 分钟</option><option value="30">30 分钟</option></select><span style="flex:1"></span><button class="wp-btn" data-show>显示/隐藏凭据</button><button class="wp-btn pri" data-test>发送测试消息</button></div><div class="wp-log" data-log></div><div class="wp-note">日志里 ✓ 表示消息已成功<b>提交</b>到推送服务（官方接口为异步，code=200 只代表已接收）；公众号实际送达以微信为准，受平台频控影响。收不到消息时先用「发送测试消息」验证，再对照上方官方文档排查。</div></div>`;
    el.append(wrap);
    const previewControls = document.createElement("div");
    previewControls.className = "wp-row";
    previewControls.innerHTML = `<label for="wp-preview-type">模拟消息</label><select id="wp-preview-type" aria-label="选择要模拟的消息类型"><option value="block">时间块提醒</option><option value="task">任务截止提醒</option><option value="plugin">插件新消息</option><option value="test">测试消息</option></select><button type="button" class="wp-btn" data-preview>查看微信消息预览</button>`;
    const preview = document.createElement("div");
    preview.className = "wp-preview";
    preview.hidden = true;
    wrap.querySelector(".wp-log").before(previewControls, preview);
    async function showPreview() {
      const type = previewControls.querySelector("select").value;
      const at = new Date().toTimeString().slice(0, 5);
      let msg, sample = false;
      if (type === "block") {
        const blocks = await tide.blocks.list(tide.util.today());
        const b = blocks.find((x) => x.start && x.title) || { start: "14:00", title: "复习课程", durMin: 50 };
        sample = !blocks.some((x) => x.start && x.title);
        msg = blockMessage(b);
      } else if (type === "task") {
        const tasks = await tide.tasks.list();
        const task = tasks.find((x) => !x.done && x.due) || { title: "完成报告", due: tide.util.today(), dueTime: "18:00" };
        sample = !tasks.some((x) => !x.done && x.due);
        msg = taskMessage(task, Array.isArray(task.reminderOffsets) ? Number(task.reminderOffsets[0]) || 0 : 60);
      } else if (type === "plugin") {
        sample = !state.pluginQueue.length;
        msg = pluginMessage(state.pluginQueue.length ? state.pluginQueue : [{ source: "学校通知", title: "新公告已发布", time: at }], at);
      } else {
        msg = { title: `U-Time测试推送 ${at}`, content: `如果你在微信里看到这条消息，说明推送通道正常 ✓（${at} 发出）` };
      }
      preview.innerHTML = `<div class="wp-preview-head"><span class="wp-preview-avatar">${state.provider === "pushplus" ? "P" : "S"}</span><b>${state.provider === "pushplus" ? "PushPlus" : "Server酱"}</b><span class="wp-preview-time">${esc(at)}</span></div><div class="wp-preview-bubble"><div class="wp-preview-title">${esc(msg.title)}</div><div class="wp-preview-content">${esc(msg.content)}</div></div><div class="wp-preview-note">${sample ? "当前没有对应数据，展示示例内容。" : "使用当前数据和实际发送的标题、正文。"}仅本地模拟，不发送消息；微信客户端的最终排版以服务商为准。</div>`;
      preview.hidden = false;
    }
    previewControls.querySelector("[data-preview]").addEventListener("click", () => showPreview().catch((e) => tide.notify(`预览失败：${e.message || e}`)));
    srcKey = "";   // 本次 render 的勾格容器是全新的，必须让它重建一次
    ui = { log: wrap.querySelector("[data-log]"), token: wrap.querySelector("[data-token]"), topic: wrap.querySelector("[data-topic]"), key: wrap.querySelector("[data-key]"), en: wrap.querySelector("[data-en]"), lead: wrap.querySelector("[data-lead]"), pp: wrap.querySelector("[data-pp]"), sct: wrap.querySelector("[data-sct]"), msQueue: wrap.querySelector("[data-ms-queue]"), msSrcs: wrap.querySelector("[data-ms-srcs]") };
    const msBtn = wrap.querySelector("[data-ms-btn]"), msPanel = wrap.querySelector("[data-ms-panel]"), msLabel = wrap.querySelector("[data-ms-label]");
    const msBoxes = [...wrap.querySelectorAll("[data-ms]")];
    const SCOPE_NAMES = { block: "时间块", task: "任务截止", plugin: "插件消息" };
    function paintScope() {
      msBoxes.forEach((b) => { b.checked = state.pushScope.includes(b.dataset.ms); });
      const srcs = sourceOptions();
      const picked = srcs.filter((s) => allowedSource(s.id)).length;
      // 插件级已细分时把「几 / 几」写进按钮文案，收起面板也看得出到底在收哪几个插件
      const labelOf = (k) => (k !== "plugin" || state.pluginPicks === null
        ? SCOPE_NAMES[k] : `${SCOPE_NAMES.plugin} ${picked}/${srcs.length}`);
      msLabel.textContent = state.pushScope.length ? state.pushScope.map(labelOf).join(" + ") : "未选择";
    }
    // v1.8.1：面板不再用 hidden 属性开关 —— .wp-ms-panel 的 display:grid 是作者样式，
    // 永远压过 UA 的 [hidden]{display:none}，hidden 切了也收不回去（正是「展开后无法收起」的根因）。
    // 改成 .on 类切换，顺带补上展开/收起过渡动画（不认 reduced-motion 时）与箭头旋转。
    function setMsOpen(open) {
      msPanel.classList.toggle("on", open);
      msPanel.closest("[data-ms]").classList.toggle("open", open);
      msBtn.setAttribute("aria-expanded", open ? "true" : "false");
      if (!open) { msPanel.style.left = ""; return; }
      /* 面板按按钮左缘往右下展开，而窄屏下那一行会换行、按钮被挤到右侧：
         实测 390px 宽时面板从 x=236 展开到 538，右半边 148px 掉到视口外（勾格看不见也点不到）。
         左、右哪个方向锚定都各有裁掉的时候，所以开的时候量一次、把整块推回视口内。
         面板宽是 min(78vw,430px)，推回来后的左缘 = vw-12-面板宽 ≥ 12px，不会再顶穿左边。
         ⚠️ 可视区的左右边不是视口的左右边：横屏时挖孔与侧边三键栏各占一段（fixed 与绝对
         定位的后代都以宿主 .view 的 padding box 为包含块，宿主的 padding 拦不住它们），
         所以夹取必须减掉原生注入的 --sar / --sal，变量取不到时 parseFloat 出 NaN → 0，桌面不变。 */
      const px = (v) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(v)) || 0;
      const [sal, sar] = [px("--sal"), px("--sar")];
      const over = msBtn.getBoundingClientRect().left + msPanel.offsetWidth - (innerWidth - sar - 12);
      msPanel.style.left = over > 0 ? `-${Math.min(Math.ceil(over), msBtn.getBoundingClientRect().left - sal - 12)}px` : "";
    }
    msBtn.addEventListener("click", () => { setMsOpen(!msPanel.classList.contains("on")); });
    msBoxes.forEach((b) => b.addEventListener("change", async () => { readFields(); await save(); paintScope(); paintSources(); pruneQueue(); }));
    // 插件级勾选：容器只绑一次（格子里的复选框会随消息源清单变化重建），委托到 data-src 上。
    ui.msSrcs.addEventListener("change", async (e) => {
      if (!e.target.closest("[data-src]")) return;
      readPicks(); await save(); paintScope(); paintSources(); pruneQueue();
    });
    function readPicks() {
      const boxes = [...ui.msSrcs.querySelectorAll("[data-src]")];
      const on = boxes.filter((b) => b.checked).map((b) => b.dataset.src);
      // 全勾 = 回到「未细分」，这样以后新接入的消息源仍会被默认推送
      state.pluginPicks = on.length === boxes.length ? null : on;
    }
    document.addEventListener("click", (e) => { if (!e.target.closest("[data-ms]")) setMsOpen(false); });

    ensurePrefs().then(() => {
      ui.token.value = state.token; ui.topic.value = state.topic; ui.key.value = state.oldKey; ui.en.checked = state.enabled;
      ui.lead.value = String(state.lead); paintScope(); paintSources();
      paintProvider(); paintLog(); paintQueue(); if (state.enabled && configured()) startTimer();
    });

    function readFields() {
      state.pushScope = msBoxes.filter((b) => b.checked).map((b) => b.dataset.ms);
      if (!state.pushScope.length) state.pushScope = ["block", "task"]; // 全不选没有意义，回默认
      state.blockEnabled = state.pushScope.includes("block");
      state.taskEnabled = state.pushScope.includes("task");
      state.token = ui.token.value.trim(); state.topic = ui.topic.value.trim(); state.oldKey = ui.key.value.trim(); state.lead = Number(ui.lead.value) || 5;
    }
    function paintProvider() {
      wrap.querySelectorAll("[data-provider]").forEach((b) => b.classList.toggle("on", b.dataset.provider === state.provider));
      ui.pp.style.display = state.provider === "pushplus" ? "block" : "none"; ui.sct.style.display = state.provider === "serverchan" ? "block" : "none";
    }
    wrap.querySelectorAll("[data-doc]").forEach((a) => a.addEventListener("click", () => {
      tide.util.openUrl(a.dataset.doc).catch((e) => tide.notify(`打开官方文档失败：${e.message || e}`));
    }));
    wrap.querySelector("[data-gettoken]")?.addEventListener("click", () => {
      tide.util.openUrl("https://www.pushplus.plus/push1.html").catch((e) => tide.notify(`打开 Token 页失败：${e.message || e}`));
    });
    wrap.querySelectorAll("[data-provider]").forEach((b) => b.addEventListener("click", async () => { readFields(); state.provider = b.dataset.provider; paintProvider(); await save(); }));
    ui.en.addEventListener("change", async () => { readFields(); state.enabled = ui.en.checked; if (state.enabled && !configured()) { state.enabled = false; ui.en.checked = false; tide.notify(state.provider === "pushplus" ? "请先填写 PushPlus Token" : "请先填写 Server酱 SendKey"); return; } await save(); if (state.enabled) { startTimer(); tick(); tide.notify("微信推送已开启"); } else { if (state.timer) clearInterval(state.timer); state.timer = null; tide.notify("微信推送已关闭"); } });
    [ui.lead].forEach((x) => x.addEventListener("change", async () => { readFields(); await save(); }));
    [ui.token, ui.topic, ui.key].forEach((x) => x.addEventListener("change", async () => { readFields(); await save(); }));
    wrap.querySelector("[data-show]").addEventListener("click", () => { const next = ui.token.type === "password" ? "text" : "password"; ui.token.type = next; ui.key.type = next; });
    // 测试推送：标题带时间戳（PushPlus 相同内容 1 小时限 3 条，重复内容会被 999 拒绝）+ 1 分钟防连点。
    let lastTestAt = 0;
    wrap.querySelector("[data-test]").addEventListener("click", async () => {
      readFields(); await save();
      if (Date.now() - lastTestAt < 65000) { tide.notify("1 分钟内刚发过测试推送（PushPlus 每分钟限 5 次、相同内容每小时限 3 条），稍后再试"); return; }
      lastTestAt = Date.now();
      const at = new Date().toTimeString().slice(0, 5);
      await push(`U-Time测试推送 ${at}`, `如果你在微信里看到这条消息，说明推送通道正常 ✓（${at} 发出）`);
    });
  }

  function paintLog() {
    if (!ui?.log) return;
    ui.log.innerHTML = state.log.length ? state.log.map((l) => `<div style="font-size:calc(11px * var(--ui-text-scale));color:var(--ink-2,#7E8B94);padding:3px 0">${esc(l)}</div>`).join("") : `<div style="font-size:calc(11px * var(--ui-text-scale));color:var(--ink-3,#A9B2BA)">还没有推送记录</div>`;
  }

  tide.ui.registerView({ id: "wechat-push", title: "微信推送", icon: "comment-dots", render });
  // 插件消息通道：学习通等插件抓到新通知时广播 notice:new，这里入队并按批推送
  try { tide.events.on("notice:new", queuePluginNotice); } catch {}
  ensurePrefs().then(() => { if (state.enabled && configured()) { startTimer(); tick(); } });
})();
