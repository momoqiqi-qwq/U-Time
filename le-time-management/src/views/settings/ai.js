import { api } from "../../api.js";
import { el, toast } from "../../ui.js";

const AI_PROVIDERS = [
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { id: "qwen", name: "阿里云百炼（北京）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3-vl-plus" },
];

export async function createAiSettingsCard() {
  const status = await api.aiVaultStatus().catch(() => ({ configured: false, baseUrl: "", model: "", keyMasked: "" }));
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
  const matchProvider = () => AI_PROVIDERS.find((p) => p.baseUrl === base.value.trim().replace(/\/$/, "") && p.model === model.value.trim());
  provider.value = matchProvider()?.id || "custom";
  provider.addEventListener("change", () => {
    const selected = AI_PROVIDERS.find((p) => p.id === provider.value);
    if (!selected) return;
    base.value = selected.baseUrl;
    model.value = selected.model;
  });
  for (const input of [base, model]) input.addEventListener("input", () => { provider.value = matchProvider()?.id || "custom"; });
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

  const card = el("div", { class: "card set-card ai-settings-card" },
    el("div", { class: "ai-card-title-row" },
      el("div", {}, el("h2", {}, "AI 与自动任务")),
      state,
    ),
    el("div", { class: "ai-settings-grid" },
      el("label", { class: "ai-field" }, el("span", {}, "供应商"), provider),
      el("label", { class: "ai-field" }, el("span", {}, "Base URL"), base),
      el("label", { class: "ai-field" }, el("span", {}, "模型"), model),
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
          key.value = "";
          key.placeholder = `${next.keyMasked || "已加密保存"}（留空保持不变）`;
          state.textContent = "已加密保存";
          state.classList.add("ok");
          toast("AI 凭据已加密保存");
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
        base.value = "";
        model.value = "";
        provider.value = "custom";
        key.value = "";
        key.placeholder = "API Key";
        state.textContent = "未配置";
        state.classList.remove("ok");
        testOut.textContent = "AI 凭据已清除。";
        toast("AI 凭据已清除");
      } }, "清除凭据"),
    ),
    testOut,
  );
  return card;
}
