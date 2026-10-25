// 作者署名（v0.232.0，用户要求「在必要的地方添加作者署名。By lyl」）。
//
// 署名散落在**九个不同层的文件**里（产品内关于页、HTML head、npm / Cargo / Tauri 三份打包元数据、
// 小程序元数据与设置页、三份 README、开源说明、五个文档页脚）。这类「同一件事写很多遍」的改动
// 最容易改一处漏一处，而且漏了不会报错 —— 只会悄悄少一个署名位。
// 所以这里把「哪几处必须有」钉死：以后谁改署名，要么全改，要么这条红。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// v0.285.0：署名统一为 lyl（用户要求去掉真实姓名与拉丁名），不再分中/拉丁两列，
// 所以这里只留一个名字常量；别名照旧并入署名。
const CN = "lyl";
// v0.245.1：作者账号 / 昵称并入署名（用户原话「把 momoni / lele 两个昵称添加到作者上面去」）。
const ALIASES = ["momoni", "lele"];
const FULL = `${CN} (${ALIASES.join(" / ")})`;

const aboutData = read("../src/aboutData.js");
const aboutCard = read("../src/views/aboutCard.js");
const styles = read("../src/styles.css");
const indexHtml = read("../index.html");
const pkg = JSON.parse(read("../package.json"));
const cargo = read("../src-tauri/Cargo.toml");
const tauriConf = JSON.parse(read("../src-tauri/tauri.conf.json"));
const appMeta = read("../../miniprogram/core/appMeta.js");
const mpSettings = read("../../miniprogram/pages/settings/index.wxml");
const rootReadme = read("../../README.md");
const appReadme = read("../README.md");
const mpReadme = read("../../miniprogram/README.md");
const notices = read("../public/OPEN_SOURCE_NOTICES.md");
const docPages = ["index.html", "features.html", "plugins.html", "tech-stack.html", "upload.html"]
  .map((name) => [name, read(`../../docs/${name}`)]);

// 1) 产品内「关于」页：常量 → 渲染 → 样式，三段必须都在，否则页面上什么都不显示。
assert.match(aboutData, /export const AUTHOR = \{/, "aboutData.js 必须导出 AUTHOR 常量");
assert.ok(aboutData.includes(CN), `AUTHOR 常量里要有「${CN}」`);
for (const field of ["name", "latin", "role"]) {
  assert.match(aboutData, new RegExp(`${field}:\\s*"`), `AUTHOR 缺少 ${field} 字段`);
}
// 别名必须写在 AUTHOR 里、且三处渲染与样式都在，否则「关于」页会少名字。
for (const alias of ALIASES) {
  assert.ok(aboutData.includes(`"${alias}"`), `AUTHOR.aliases 缺少别名「${alias}」`);
}
assert.match(aboutData, /aliases:\s*\[/, "AUTHOR 必须有 aliases 数组");
assert.match(aboutCard, /AUTHOR\.aliases/, "关于页必须渲染 AUTHOR.aliases");
assert.match(aboutCard, /class:\s*"about-author-alias"/, "别名要用 .about-author-alias 渲染");
assert.ok(styles.includes(".about-author-alias"), "缺少别名样式：.about-author-alias");
assert.match(aboutCard, /import \{[^}]*\bAUTHOR\b[^}]*\} from "\.\.\/aboutData\.js"/, "aboutCard 必须导入 AUTHOR");
assert.match(aboutCard, /class:\s*"about-author"/, "关于页必须真的渲染作者行");
assert.ok(aboutCard.includes("AUTHOR.name") && aboutCard.includes("AUTHOR.latin"), "作者行要用常量而不是硬编码姓名");
for (const selector of [".about-author ", ".about-author b", ".about-author-role::before"]) {
  assert.ok(styles.includes(selector), `缺少作者行样式：${selector}`);
}
// 署名样式只许消费既有主题令牌：新写死十六进制色会让深色变体与主题切换失效。
const authorBlock = styles.slice(styles.indexOf(".about-author {"), styles.indexOf(".about-author-role::before"));
assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(authorBlock), "作者行样式里不许写死十六进制色值");
assert.ok(!/rgb\(|hsl\(/.test(authorBlock), "作者行样式里不许写死 rgb()/hsl() 色值");

// 2) 桌面壳与三份打包元数据。
assert.ok(indexHtml.includes(`<meta name="author" content="${FULL}"`), "index.html 缺少 meta author");
assert.equal(pkg.author, FULL, "package.json 的 author 与署名写法不一致");
assert.ok(cargo.includes(`authors = ["${FULL}"]`), "Cargo.toml 的 authors 与署名写法不一致");
assert.equal(tauriConf.bundle.publisher, FULL, "tauri.conf.json 缺少 bundle.publisher");
assert.ok(tauriConf.bundle.copyright.includes(CN), "tauri.conf.json 的 bundle.copyright 必须带作者名");
assert.ok(tauriConf.bundle.copyright.includes(ALIASES[0]), "tauri.conf.json 的 bundle.copyright 必须带别名");

// 3) 小程序：元数据 + 设置页「关于」区。
assert.equal(appMeta.match(/author:\s*"([^"]+)"/)?.[1], FULL, "appMeta.js 的 author 与署名写法不一致");
assert.match(mpSettings, /\{\{about\.author\}\}/, "小程序设置页关于区没有渲染 about.author");

// 4) 文档与说明：三份 README、开源说明、五个文档页脚。
for (const [label, text] of [["根 README", rootReadme], ["le-time-management/README", appReadme], ["miniprogram/README", mpReadme], ["OPEN_SOURCE_NOTICES", notices]]) {
  assert.ok(text.includes(CN), `${label} 缺少作者署名`);
  // v0.286.0：别名从三个减到两个，这里改成「每个别名都得在」，别再写死下标。
  assert.ok(ALIASES.every((alias) => text.includes(alias)), `${label} 的署名缺少作者别名`);
}
for (const [name, html] of docPages) {
  assert.ok(html.includes(CN), `docs/${name} 页脚缺少作者署名`);
  assert.ok(ALIASES.every((alias) => html.includes(alias)), `docs/${name} 页脚缺少作者别名`);
}

console.log("PASS: 作者署名（关于页含别名胶囊 / 三份打包元数据 / 小程序 / 三份 README / 开源说明 / 五个文档页脚）");
