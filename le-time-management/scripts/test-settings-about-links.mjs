import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const links = read("../src/projectLinks.js");
const about = read("../src/views/aboutCard.js");
const settings = read("../src/views/settings.js");
const shell = read("../src/shell.js");
const styles = read("../src/styles.css");

assert.match(links, /releases:\s*"https:\/\/github\.com\/momoqiqi-qwq\/U-Time\/releases"/);
assert.match(links, /pluginDevelopment:\s*"https:\/\/momoqiqi-qwq\.github\.io\/U-Time\/"/);

for (const expected of ["GitHub 发布页", "插件开发文档", "PROJECT_LINKS.releases", "PROJECT_LINKS.pluginDevelopment"]) {
  assert.ok(about.includes(expected), `关于页缺少：${expected}`);
}
assert.match(about, /onclick:\s*\(\)\s*=>\s*api\.openUrl\(url\)/, "外部入口应沿用统一网页打开策略");
assert.match(settings, /GitHub 发布 下载 Releases 插件开发 API 文档/, "关于页新入口应能被设置搜索命中");
assert.ok(shell.includes("界面、提醒、数据与扩展"), "设置弹窗缺少内容范围说明");

for (const selector of [".about-resource-grid", ".about-resource-card", ".settings-section > h2::before"]) {
  assert.ok(styles.includes(selector), `缺少统一视觉样式：${selector}`);
}

console.log("PASS: 设置中心视觉与关于页外部入口");
