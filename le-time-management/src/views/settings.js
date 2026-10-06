import { createLanCard } from "./settings/lan.js";
import { createShortcutCard } from "./settings/shortcuts.js";
import { createDataCard } from "./settings/data.js";
import { createReminderCard } from "./settings/reminders.js";
// 设置视图：数据、插件管理、关于
import { api } from "../api.js";
import * as S from "../store.js";
import { el } from "../ui.js";
import { onNavChanged, getRegistry } from "../pluginHost.js";
import { isAndroidRuntime } from "../androidNotify.js";
import { createAboutCard } from "./aboutCard.js";
import { createInterfaceCard, createThemeCard } from "./settings/appearance.js";
import { createSettingsNavigator } from "./settings/navigator.js";
import { getUiPreferences } from "../uiPreferences.js";
import { createPluginSettingsCard, isPluginBatchBusy } from "./settings/plugins.js";
import { createAiSettingsCard } from "./settings/ai.js";
import { createSyncCard } from "./settings/sync.js";
import { createKeywordHighlightsCard } from "./settings/highlights.js";
import { createTaskSettingsCard } from "./settings/tasks.js";
import { createCppuLoginCard } from "./settings/cppuLogin.js";
import { createTestingCard } from "./settings/testing.js";

let info = null;
let navUnsub = null;
// expanded 是窄屏（手机 / APK）手风琴里已展开的分区 id。它必须活在这里而不是 navigator 内部：
// 在设置里改任何一项都会重渲染整页，状态存在局部变量里会让刚展开的面板当场塌掉。
// 但每次「打开设置」都清空 —— 一进来先给一张分类目录，不预展开任何分区（v0.49.1）。
const settingsNavState = { query: "", filter: "all", expanded: [] };

function disposeContents(root) {
  for (const node of root.querySelectorAll(".update-panel")) node._dispose?.();
}

function revealSettingTarget(root, target) {
  const wanted = String(target || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!wanted) return;
  const candidates = [...root.querySelectorAll([
    ".setting-row", ".pref-presets", ".ai-field", ".sync-step", ".sync-field",
    ".data-section-title", ".plugin-title-row", ".about-section-title", ".update-panel",
    "h2", "h3", "label", "button", "input", "select", "[aria-label]",
  ].join(","))];
  const value = (node) => [node.textContent, node.getAttribute?.("aria-label"), node.getAttribute?.("placeholder"), node.getAttribute?.("title")]
    .filter(Boolean).join(" ").trim().replace(/\s+/g, " ").toLowerCase();
  const exact = candidates.find((node) => value(node) === wanted);
  const matched = exact || candidates.find((node) => value(node).includes(wanted));
  if (!matched) return;
  const anchor = matched.closest?.(".setting-row,.pref-presets,.ai-field,.sync-step,.sync-field,.data-section-title,.plugin-title-row,.about-section-title,.update-panel") || matched;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    anchor.scrollIntoView?.({ block: "center", behavior: "smooth" });
    anchor.classList.add("setting-search-target");
    setTimeout(() => anchor.classList.remove("setting-search-target"), 1800);
  }));
}

export function renderSettings(container, opts = {}) {
  settingsNavState.expanded = [];
  settingsNavState.page = "";
  let initialTarget = true;
  // 插件是异步加载的：注册表变化（导航变化）时重渲染，避免卡片缺位。
  // 批量启停插件时先跳过 —— 每关一个插件都会 emitNavChanged()，不挡就会整页重建 N 次。
  navUnsub?.();
  navUnsub = onNavChanged(() => { if (container.isConnected && !isPluginBatchBusy()) render(); });

  const wrap = el("div", { class: "set-wrap" });
  container.append(wrap);

  let entries = null, navigatorController = null, disposed = false;
  const render = async () => {
    if (disposed) return;
    if (entries) {
      for (const entry of entries.filter(entry => ["plugins", "about", "shortcuts"].includes(entry.id))) {
        if (entry.node.classList.contains("settings-section-active") || entry.id === settingsNavState.page) { entry.invalidate(); await entry.ensure(); }
        else entry.invalidate();
      }
      return;
    }
    if (!info) info = await api.appInfo().catch(() => null);
    if (disposed || entries) return;


    const settingEntries = [
      { id: "tasks", create: ({ render }) => createTaskSettingsCard(), label: "任务与排程", icon: "sliders", hint: "新建默认值 / 自动排程", keywords: "任务 象限 预估 时长 截止 提醒 自动排程 起始时间 空白时间块 分类 默认" },
      { id: "ui", create: ({ render }) => createInterfaceCard({ rerender: render }), label: "界面与交互", icon: "sliders", hint: "密度 / 字号 / 缩放 / 动效 / 窗口", keywords: "密度 文字 字号 缩放 界面大小 整体缩放 放大 缩小 太大 太小 看不清 动效 手势 滑动 启动页 窗口 大小 尺寸 最大化 分辨率 顶部统计 副标题 托盘 关闭 退出 最小化" },
      { id: "theme", create: ({ render }) => createThemeCard(), label: "主题", icon: "palette", hint: "配色与阅读模式", keywords: "颜色 夜间 深海 樱花 松林 暮光 极简" },
      { id: "highlights", create: ({ render }) => createKeywordHighlightsCard(), label: "关键词标注", icon: "highlighter", hint: "时间标红 / 字体 / 背景", keywords: "关键词 重点 标注 高亮 时间 日期 红色 字体 背景 颜色" },
      { id: "reminders", create: ({ render }) => createReminderCard({ settings: S.getState().settings, info, render }), label: "任务提醒", icon: "bell", hint: "预警时间与提示音", keywords: "提醒 预警 音量 提示音 音频 截止" },
      { id: "data", create: ({ render }) => createDataCard({ settings: S.getState().settings, info, render }), label: "数据中心", icon: "database", hint: "备份 / 恢复 / 交换", keywords: "备份 恢复 JSON CSV Excel ICS 自动恢复点 导入 导出" },
      { id: "sync", create: ({ render }) => createSyncCard({ appVersion: info?.version || "", os: info?.os || "" }), label: "可选同步", icon: "cloud-arrow-up", hint: "网盘快照 / 一键配置引导", keywords: "同步 网盘 WebDAV 上传 下载 备份 恢复 坚果云 Nextcloud 应用密码 换手机 换电脑 一键配置" },
      { id: "ai", create: ({ render }) => createAiSettingsCard(), label: "AI 与自动任务", icon: "wand-magic-sparkles", hint: "Base / API Key / 安全边界", keywords: "AI Base API Key 模型 自动任务 加密 定时" },
      { id: "shortcuts", create: ({ render }) => createShortcutCard({ settings: S.getState().settings, info, render }), label: "全局快捷键", icon: "keyboard", hint: "命令面板 / 快速捕获 / 插件快捷键", keywords: "快捷键 命令面板 快速捕获 Ctrl Alt 插件快捷键 字母" },
      { id: "lan", create: ({ render }) => createLanCard({ settings: S.getState().settings, info, render }), label: "局域网联动", icon: "network-wired", hint: "手机联动与二维码", keywords: "手机 WiFi 二维码 端口 配对" },
      { id: "plugins", create: ({ render }) => createPluginSettingsCard({ rerender: render }).card, label: "插件管理", icon: "puzzle-piece", hint: "启用 / 导入 / 导出", keywords: "插件 权限 导入 ZIP 启用 停用 开发文档" },
      { id: "cppu-login", create: ({ render }) => createCppuLoginCard(), label: "警大登录设置", icon: "gear", hint: "登录重试 / 自动登录", keywords: "警大 门户 账号 登录 自动登录 密码 验证码 重试" },
      { id: "testing", create: ({ render }) => createTestingCard(), label: "测试", icon: "mobile-screen-button", hint: "手机预览 / 尺寸 / 横竖屏", keywords: "测试 手机版 预览 模拟 手机 内置浏览器 横屏 竖屏" },
      // 更新入口在「关于」里（软件更新）：关键词挂这儿，搜「更新 / 升级」也能落到关于。
      { id: "about", create: ({ render }) => createAboutCard(info, getRegistry()), label: "关于", icon: "circle-info", hint: "版本 / 软件更新 / 免责声明 / 开源信息", keywords: "免责声明 使用说明 隐私 数据 官方 权限 版本 更新 更新历史 更新记录 历史版本 升级 检查更新 自动更新 弹窗提示 忽略此版本 卸载 卸载应用 清除数据 删除数据 卸载 U-Time 开源 框架 GitHub 发布 下载 Releases 插件开发 API 文档 项目仓库" },
    ];
    entries = settingEntries;
    for (const entry of settingEntries) {
      entry.node = el("div");
      let generation = 0, ready = false, pending = null;
      entry.invalidate = () => { generation++; ready = false; pending = null; };
      entry.ensure = () => {
        if (ready || disposed) return Promise.resolve();
        if (pending) return pending;
        const request = generation;
        pending = Promise.resolve().then(() => entry.create({ render: () => { entry.invalidate(); return entry.ensure(); } })).then((card) => {
          if (disposed || request !== generation) { disposeContents(card); return; }
          disposeContents(entry.node); entry.node.replaceChildren(card); ready = true;
        }).catch((error) => {
          if (disposed || request !== generation) return;
          entry.node.replaceChildren(el("p", { role: "alert" }, `加载失败：${error.message || error}`),
            el("button", { class: "btn ghost sm", onclick: () => { entry.invalidate(); entry.ensure(); } }, "重试"));
        }).finally(() => { if (request === generation) pending = null; });
        return pending;
      };
      entry.node.classList.add("settings-section");
      entry.node.id = `settings-${entry.id}`;
    }
    const settingsNavigator = createSettingsNavigator(settingEntries, settingsNavState, {
      pages: isAndroidRuntime(),
      tabs: getUiPreferences().nepheleSettings,
      onPageChange: opts.onPageChange,
    });
    navigatorController = settingsNavigator;
    opts.onNavigator?.(settingsNavigator);
    // 窄屏走手风琴：分区由 navigator 包成「标题行 + 可收放内容」，这里按它给的顺序渲染
    const content = el("div", { class: "settings-content" }, ...settingsNavigator.panels);
    const layout = el("div", { class: `settings-layout${isAndroidRuntime() ? " settings-pages" : ""}` }, settingsNavigator.node, content);
    // 设置中心头卡已移除：纯展示内容占掉首屏空间，左侧分类导航本身已承担引导职责。
    wrap.replaceChildren(layout);
    settingsNavigator.apply();
    // 外部（如更新提示条的「立即更新」）可以点名要停在哪一节。
    // 放在 apply() 之后：select() 会校验 visibleIds，而那正是 apply() 填的。
    if (initialTarget && opts.section) settingsNavigator.select(opts.section, { animate: false });
    if (initialTarget && opts.target) {
      const targetEntry = entries.find(entry => entry.id === opts.section);
      if (targetEntry) await targetEntry.ensure();
      if (!disposed) revealSettingTarget(content, opts.target);
    }
    initialTarget = false;
  };
  let settingsIdentity = S.getState().settings;
  const onUiPreferences = (event) => navigatorController?.setTabs(event.detail?.nepheleSettings === true);
  window.addEventListener("tide:ui-preferences-changed", onUiPreferences);
  const storeUnsub = S.subscribe(() => {
    if (settingsIdentity === S.getState().settings || !entries) return;
    settingsIdentity = S.getState().settings;
    for (const entry of entries) {
      entry.invalidate();
      if (entry.node.classList.contains("settings-section-active") || entry.id === settingsNavState.page) entry.ensure();
    }
  });
  container._unsub = () => { disposed = true; window.removeEventListener("tide:ui-preferences-changed", onUiPreferences); storeUnsub(); disposeContents(wrap); navUnsub?.(); navUnsub = null; navigatorController?.dispose(); };
  render();
}
