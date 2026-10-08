import { api } from "../../api.js";
import { el, toast } from "../../ui.js";
import { createAiModelPicker } from "./aiModelPicker.js";

const AI_PROVIDERS = [
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "qwen", name: "阿里云百炼（北京）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3-vl-plus" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "" },
];

function modelEndpoint(base) {
  try {
    const url = new URL(base.trim());
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(chat\/completions|models)$/, "") + "/models";
    return url.href;
  } catch { return base.trim(); }
}

export async function createAiSettingsCard() {
  let status = await api.aiVaultStatus().catch(() => ({ configured: false, baseUrl: "", model: "", keyMasked: "" }));
  const base = el("input", {
    type: "url",
    value: status.baseUrl || "",
    placeholder: "例如：https://api.openai.com/v1",
    autocomplete: "off",
    spellcheck: "false",
  });
  const model = el("input", {
    type: "text",
    value: status.model || "",
    placeholder: "例如：gpt-4o-mini / qwen-plus / deepseek-chat",
    autocomplete: "off",
    spellcheck: "false",
  });
  const provider = el("select", { "aria-label": "选择 AI 供应商" },
    el("option", { value: "custom" }, "自定义"),
    ...AI_PROVIDERS.map((p) => el("option", { value: p.id }, p.name)),
  );
  const matchProvider = () => AI_PROVIDERS.find((p) => p.baseUrl === base.value.trim().replace(/\/+$/, ""));
  provider.value = matchProvider()?.id || "custom";
  provider.addEventListener("change", () => {
    const selected = AI_PROVIDERS.find((p) => p.id === provider.value);
    if (!selected) return;
    base.value = selected.baseUrl;
    model.value = selected.model;
    if (lastEndpoint !== modelEndpoint(base.value)) key.value = "";
    lastEndpoint = modelEndpoint(base.value);
    picker.close();
    configurationChanged();
  });
  let lastEndpoint = modelEndpoint(base.value);
  base.addEventListener("input", () => {
    provider.value = matchProvider()?.id || "custom";
    if (lastEndpoint !== modelEndpoint(base.value)) key.value = "";
    lastEndpoint = modelEndpoint(base.value);
    configurationChanged();
  });
  const key = el("input", {
    type: "password",
    value: "",
    placeholder: status.configured ? `${status.keyMasked || "已加密保存"}（留空保持不变）` : "API Key",
    autocomplete: "new-password",
    spellcheck: "false",
  });
  const state = el("span", { class: `ai-vault-state${status.configured ? " ok" : ""}` }, status.configured ? "已加密保存" : "未配置");
  // 初始留空：这是「测试连接」的结果回显区，不再预置说明文字（v0.37.19）。
  const testOut = el("p", { class: "desc ai-test-result" });
  const picker = createAiModelPicker(model);
  const catalogState = el("p", { class: "ai-model-status", role: "status", "aria-live": "polite" }, "填写 API Key 后自动获取模型，也可手动填写 ID。");
  const refresh = el("button", { type: "button", class: "btn ghost sm", onclick: () => refreshModels(true) }, "刷新模型");
  let generation = 0, pendingTimer, disposed = false;
  function configurationChanged() {
    generation++;
    clearTimeout(pendingTimer);
    picker.setModels([]);
    picker.close();
    refresh.disabled = false;
    refresh.textContent = "刷新模型";
    key.placeholder = status.configured && modelEndpoint(status.baseUrl) === modelEndpoint(base.value)
      ? `${status.keyMasked || "已加密保存"}（留空保持不变）` : "此供应商的 API Key";
    catalogState.textContent = "等待获取此接口的模型列表…";
    pendingTimer = setTimeout(() => refreshModels(), 650);
  }
  async function refreshModels(force = false) {
    clearTimeout(pendingTimer);
    const current = ++generation;
    const baseUrl = base.value.trim();
    const apiKey = key.value.trim();
    if (!baseUrl) { catalogState.textContent = "请选择供应商或填写 Base URL。"; return; }
    if (!apiKey && (!status.configured || modelEndpoint(status.baseUrl) !== modelEndpoint(baseUrl))) {
      catalogState.textContent = "请填写此供应商的 API Key，模型 ID 仍可手动输入。";
      return;
    }
    refresh.disabled = true;
    refresh.textContent = "获取中…";
    catalogState.textContent = "正在获取可用模型…";
    try {
      const catalog = await api.aiListModels(baseUrl, apiKey, force);
      if (disposed || current !== generation) return;
      picker.setModels(catalog.models);
      const time = new Date(catalog.fetchedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      catalogState.textContent = catalog.warning
        ? `${catalog.warning}；保留 ${catalog.models.length} 个缓存模型（${time}）。`
        : `${catalog.models.length} 个可用模型 · ${catalog.cached ? "缓存" : "更新于"} ${time} · 可手动填写 ID`;
    } catch (error) {
      if (disposed || current !== generation) return;
      catalogState.textContent = `获取失败：${error.message || error}。可继续手动填写模型 ID。`;
    } finally {
      if (!disposed && current === generation) { refresh.disabled = false; refresh.textContent = "刷新模型"; }
    }
  }
  key.addEventListener("input", configurationChanged);

  const card = el("div", { class: "card set-card ai-settings-card" },
    el("div", { class: "ai-card-title-row" },
      el("div", {}, el("h2", {}, "AI 与自动任务")),
      state,
    ),
    el("div", { class: "ai-settings-grid" },
      el("label", { class: "ai-field" }, el("span", {}, "供应商"), provider),
      el("label", { class: "ai-field" }, el("span", {}, "Base URL"), base),
      el("div", { class: "ai-field ai-model-field" }, el("span", {}, "模型"), picker.node,
        el("div", { class: "ai-model-tools" }, refresh, catalogState)),
      el("label", { class: "ai-field ai-key-field" }, el("span", {}, "API Key"), key),
    ),
    el("p", { class: "desc" },
      "配置后把截图 / 图片 / 文本文件拖进窗口，AI 会读图识别其中的时间安排，结果先逐条列出确认，再写入任务、时间块、收件箱或课程表。",
      el("br"),
      "粘贴纯文本与「快速捕获」仍走本地规则解析（免费、离线可用），只有本地认不出日期时才回落到 AI；识别课表类图片需要模型支持视觉输入。",
    ),
    el("div", { class: "data-actions ai-settings-actions" },
      el("button", { class: "btn pri sm", onclick: async () => {
        const old = state.textContent;
        state.textContent = "保存中…";
        try {
          const next = await api.aiVaultSave(base.value.trim(), key.value.trim(), model.value.trim());
          status = next;
          key.value = "";
          key.placeholder = `${next.keyMasked || "已加密保存"}（留空保持不变）`;
          state.textContent = "已加密保存";
          state.classList.add("ok");
          toast("AI 凭据已加密保存");
          configurationChanged();
        } catch (e) {
          state.textContent = old;
          toast(`保存失败：${e.message || e}`);
        }
      } }, "加密保存"),
      el("button", { class: "btn ghost sm", onclick: async () => {
        testOut.textContent = "正在测试 AI 连接…";
        try {
          const reply = await api.aiChat([
            { role: "system", content: "你正在进行连接测试。只回复：连接成功" },
            { role: "user", content: "测试" },
          ], 0);
          testOut.textContent = `连接正常：${String(reply).trim().slice(0, 120)}`;
          toast("AI 连接测试成功");
        } catch (e) {
          testOut.textContent = `连接失败：${e.message || e}`;
          toast("AI 连接测试失败");
        }
      } }, "测试连接"),
      el("button", { class: "btn ghost sm", onclick: async () => {
        if (!confirm("清除已加密保存的 AI Base URL / API Key / 模型配置？")) return;
        await api.aiVaultClear();
        status = { configured: false, baseUrl: "", model: "", keyMasked: "" };
        base.value = "";
        model.value = "";
        provider.value = "custom";
        key.value = "";
        key.placeholder = "API Key";
        state.textContent = "未配置";
        state.classList.remove("ok");
        testOut.textContent = "AI 凭据已清除。";
        configurationChanged();
        toast("AI 凭据已清除");
      } }, "清除凭据"),
    ),
    testOut,
  );
  // 设置打开时获取；持续停留时每 30 分钟刷新，退出设置后停止。
  const interval = setInterval(() => { if (card.isConnected && !refresh.disabled) refreshModels(); }, 30 * 60 * 1000);
  card._dispose = () => {
    disposed = true; generation++; clearTimeout(pendingTimer); clearInterval(interval); picker.dispose();
  };
  pendingTimer = setTimeout(() => refreshModels(), 0);
  return card;
}
