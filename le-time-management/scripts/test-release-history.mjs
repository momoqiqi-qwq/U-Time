import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const source = readFileSync(new URL("../src/releaseHistory.js", import.meta.url), "utf8");
const load = new Function("changelogs", source.replace(/^const changelogs = .*;$/m, "")
  .replace("export const releaseHistory", "const releaseHistory") + ";return releaseHistory;");
const docs = new URL("../../docs/", import.meta.url);
const files = readdirSync(docs).filter(name => /^CHANGELOG-v.+\.md$/.test(name));
const history = load(Object.fromEntries(files.map(name => [name, readFileSync(new URL(name, docs), "utf8")])));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(history.length, files.length, "所有本地版本说明都可离线查看");
assert.equal(history[0].version, pkg.version, "新版本记录必须位于首条");
assert.ok(history[0].lines.some(line => line.text.trim().length > 0), "最新版本说明必须能解析出可读正文");
assert.ok(history.find(item => item.version === "0.150.1").lines.some(line => line.text.includes("附件")), "保留真实历史修复内容");
const fixture = load({
  "CHANGELOG-v0.9.0.md": "# v0.9.0\n- 旧版",
  "CHANGELOG-v0.100.0.md": "# v0.100.0\n## 功能\n- **新功能**与 [说明](https://example.com)\n```js\nalert('code')\n```",
  "CHANGELOG-v0.100.0-beta.1.md": "# 预览\n- 预览内容",
});
assert.deepEqual(fixture.map(item => item.version), ["0.100.0", "0.100.0-beta.1", "0.9.0"], "按数字排序，正式版本在同版本预发布之前");
assert.equal(fixture[1].preview, true);
assert.deepEqual(fixture[0].lines, [{ heading: true, text: "功能" }, { heading: false, text: "新功能与 说明" }], "隐藏代码块并清理 Markdown 格式");
console.log("PASS: release history packages all real changelogs, sorts numeric versions, marks previews and preserves readable notes");
