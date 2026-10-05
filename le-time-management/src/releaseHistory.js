// Vite 在构建时收集版本说明；整个模块仅在打开更新历史时加载，离线可用。
const changelogs = import.meta.glob("../../docs/CHANGELOG-v*.md", { query: "?raw", import: "default", eager: true });
export const releaseHistory = Object.entries(changelogs).map(([path, body]) => {
  const version = path.match(/CHANGELOG-v(.+)\.md$/)[1];
  let inCode = false;
  const lines = [];
  for (const raw of body.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) { inCode = !inCode; continue; }
    if (inCode || !raw.trim() || /^#\s|^\s*\||^\s*---/.test(raw)) continue;
    const heading = /^#{2,6}\s/.test(raw);
    const text = raw.trim().replace(/^#{2,6}\s+|^[-*+]\s+|^\d+\.\s+|^>\s*/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*|`/g, "");
    if (text) lines.push({ heading, text });
  }
  return { version, preview: version.includes("-"), lines };
}).sort((a, b) => {
  const av = a.version.split(/[.-]/), bv = b.version.split(/[.-]/);
  for (let i = 0; i < 3; i++) { const diff = Number(bv[i]) - Number(av[i]); if (diff) return diff; }
  return Number(a.preview) - Number(b.preview);
});
