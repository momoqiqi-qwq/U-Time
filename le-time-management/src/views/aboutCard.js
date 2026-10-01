import { el } from "../ui.js";
import { api } from "../api.js";
import { PROJECT_LINKS } from "../projectLinks.js";
import { ABOUT_DOCS, FRAMEWORKS, OPEN_SOURCE_PROJECTS, RELEASE_NOTES } from "../aboutData.js";
import { createUpdateSettingsPanel } from "./settings/update.js";
import { createUninstallPanel } from "./settings/uninstall.js";
import { createDisclaimerContent } from "../disclaimer.js";

function sectionTitle(text) {
  return el("h3", { class: "about-section-title" }, text);
}

function docLink(href, label) {
  return el("a", { class: "btn ghost sm about-link-btn", href, target: "_blank", rel: "noreferrer" }, label);
}

function faIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "fa-ic");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `/icons/fontawesome/solid.svg#${name}`);
  svg.append(use);
  return svg;
}

function resourceCard({ icon, title, description, url }) {
  return el("button", {
    class: "about-resource-card",
    type: "button",
    title: `打开${title}`,
    onclick: () => api.openUrl(url),
  },
    el("span", { class: "about-resource-icon", "aria-hidden": "true" }, faIcon(icon)),
    el("span", { class: "about-resource-copy" },
      el("b", {}, title),
      el("small", {}, description),
    ),
    el("span", { class: "about-resource-arrow", "aria-hidden": "true" }, faIcon("arrow-up-right-from-square")),
  );
}

export function createAboutCard(info, registry = []) {
  const currentVersion = info?.version || "?";
  const platform = [info?.os || "?", info?.arch].filter(Boolean).join(" / ");
  const builtinCount = registry.filter((item) => item.source === "builtin").length;
  const adapted = registry
    .filter((item) => item.source === "builtin" && /基于|数据源/.test(item.manifest?.author || ""))
    .map((item) => `${item.manifest?.name || item.id}（${item.manifest?.author}）`);

  const card = el("div", { class: "card set-card about-card" },
    el("div", { class: "about-head" },
      el("div", {}, el("h2", {}, "关于 U-Time")),
      el("span", { class: "about-version" }, `v${currentVersion}`),
    ),
    el("div", { class: "about-meta-grid" },
      el("div", { class: "about-meta" }, el("span", {}, "运行平台"), el("b", {}, platform || "?")),
      el("div", { class: "about-meta" }, el("span", {}, "内置插件"), el("b", {}, `${builtinCount} 个`)),
      el("div", { class: "about-meta" }, el("span", {}, "数据策略"), el("b", {}, "本地保存")),
      el("div", { class: "about-meta" }, el("span", {}, "设备联动"), el("b", {}, "由用户主动开启")),
    ),
  );

  card.append(
    sectionTitle("项目与开发"),
    el("div", { class: "about-resource-grid" },
      resourceCard({
        icon: "rocket",
        title: "GitHub 发布页",
        description: "下载正式版本，查看每次发布说明",
        url: PROJECT_LINKS.releases,
      }),
      resourceCard({
        icon: "code",
        title: "插件开发文档",
        description: "阅读插件 API、调试与发布指南",
        url: PROJECT_LINKS.pluginDevelopment,
      }),
    ),
  );

  // 软件更新紧跟在版本信息后面：关于页本来就写着版本号，检查 / 升级 / 两个提示开关都放这儿。
  // 细节见 views/settings/update.js；逻辑见 src/updateChecker.js。
  card.append(sectionTitle("软件更新"), createUpdateSettingsPanel({ currentVersion }));

  // 卸载与更新对称：Android 把卸载交给系统卸载程序，桌面端这一整段（含标题）不出现。
  // 面板为什么在浏览器调试里也画 —— 手机 UI 的预览与录屏都跑在 :1420，隐藏了就截不到图。
  const uninstallPanel = createUninstallPanel({ version: currentVersion });
  if (uninstallPanel) card.append(sectionTitle("卸载应用"), uninstallPanel);

  card.append(sectionTitle("使用说明与免责声明"), createDisclaimerContent());

  const releaseList = el("ul", { class: "about-bullets" });
  RELEASE_NOTES.forEach((text) => releaseList.append(el("li", {}, text)));
  card.append(sectionTitle("本版本说明"), releaseList);

  const frameworkList = el("div", { class: "about-list" });
  FRAMEWORKS.forEach((item) => frameworkList.append(
    el("div", { class: "about-list-row" },
      el("div", { class: "about-list-main" }, el("b", {}, item.name), el("span", {}, item.role)),
      el("span", { class: "about-tag" }, item.version),
    ),
  ));
  card.append(sectionTitle("技术框架"), frameworkList);

  const ossList = el("div", { class: "about-list" });
  OPEN_SOURCE_PROJECTS.forEach((item) => ossList.append(
    el("button", {
      class: "about-list-row about-oss-row",
      title: `打开 ${item.name} 上游项目`,
      onclick: () => api.openUrl(item.url),
    },
      el("div", { class: "about-list-main" }, el("b", {}, item.name), el("span", {}, item.role)),
      el("span", { class: "about-tag" }, item.license),
    ),
  ));
  card.append(sectionTitle("开源项目"), ossList);

  if (adapted.length) {
    card.append(el("p", { class: "about-source-note" },
      "插件适配来源：", adapted.join("；"), "。完整许可证与修改说明以随包文件和各上游项目为准。",
    ));
  }

  card.append(
    el("div", { class: "about-actions" },
      docLink(ABOUT_DOCS.changelog, "查看更新记录"),
      docLink(ABOUT_DOCS.openSource, "完整开源说明"),
      el("button", { class: "btn ghost sm", onclick: () => api.openUrl(PROJECT_LINKS.repository) }, "项目仓库"),
    ),
  );
  return card;
}
