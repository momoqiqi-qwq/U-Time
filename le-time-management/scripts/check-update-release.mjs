#!/usr/bin/env node
/*
 * 在线检查 GitHub 最新 Release 是否满足应用内更新契约。
 *
 * 不放进 npm test：测试套件必须离线可跑。发版后或排查更新问题时手动执行
 * `npm run check:update-release`，同时核对 API 元数据与两个真实下载端点。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const API = "https://api.github.com/repos/momoqiqi-qwq/U-Time/releases/latest";
const FULL_DOWNLOAD = process.argv.includes("--download");
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60_000);

async function fetchWithRetry(url, options, label) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw new Error(`${label} 连续 3 次请求失败：${lastError?.message || lastError}`);
}

function probeDownload(url, label) {
  const probe = spawnSync("curl", [
    "-sS", "-I", "-L", "--max-redirs", "5",
    "--connect-timeout", "10", "--max-time", "30",
    "-H", "User-Agent: U-Time-update-healthcheck",
    url,
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (probe.error) throw new Error(`${label} 无法启动 curl：${probe.error.message}`);
  assert.equal(probe.status, 0, `${label} 下载端点不可达：${(probe.stderr || "").trim()}`);
  const headers = String(probe.stdout || "");
  const statuses = [...headers.matchAll(/^HTTP\/\S+\s+(\d+)/gmi)].map((m) => Number(m[1]));
  assert.equal(statuses.at(-1), 200, `${label} 重定向后的最终 HTTP 状态不是 200：${statuses.join(" → ")}`);
  const lengths = [...headers.matchAll(/^content-length:\s*(\d+)/gmi)].map((m) => Number(m[1])).filter(Boolean);
  return lengths.at(-1) || 0;
}

function downloadAndHash(url, expectedSize, expectedDigest, label) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "utime-update-audit-"));
  const file = path.join(workDir, "asset.bin");
  try {
    const result = spawnSync("curl", [
      "-sS", "-L", "--fail", "--max-redirs", "5",
      "--connect-timeout", "10", "--max-time", "120",
      "-H", "User-Agent: U-Time-update-healthcheck",
      "-o", file, url,
    ], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    if (result.error) throw new Error(`${label} 无法启动 curl：${result.error.message}`);
    assert.equal(result.status, 0, `${label} 完整下载失败：${(result.stderr || "").trim()}`);
    assert.equal(fs.statSync(file).size, expectedSize, `${label} 完整下载后的文件大小不一致`);
    const actual = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    assert.equal(`sha256:${actual}`, expectedDigest.toLowerCase(), `${label} 完整下载后的 SHA-256 不一致`);
    console.log(`  ↳ 完整下载与 SHA-256 对账通过`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

try {
  const response = await fetchWithRetry(API, {
    headers: {
      Accept: "application/vnd.github+json",
      "Cache-Control": "no-cache",
      "User-Agent": "U-Time-update-healthcheck",
    },
    signal: controller.signal,
  }, "GitHub latest API");
  assert.equal(response.ok, true, `GitHub latest API 返回 HTTP ${response.status}`);
  const release = await response.json();
  assert.equal(release.draft, false, "latest release 不能是草稿");
  assert.equal(release.prerelease, false, "latest release 不能是预发布版");

  const version = String(release.tag_name || "").replace(/^[vV]/, "");
  assert.match(version, /^\d+\.\d+\.\d+$/, `tag_name 不是三段式版本号：${release.tag_name}`);
  const assets = Array.isArray(release.assets) ? release.assets : [];

  const wanted = [
    { label: "Windows NSIS", match: (name) => name.endsWith(".exe") && name.includes("setup") },
    { label: "Android universal APK", match: (name) => name.endsWith(".apk") && name.includes("universal") },
  ];

  for (const rule of wanted) {
    const candidates = assets.filter((asset) => {
      const name = String(asset.name || "").toLowerCase();
      return name.includes(version.toLowerCase()) && rule.match(name);
    });
    assert.equal(candidates.length, 1, `${rule.label} 应恰好有一个匹配产物，实际 ${candidates.length} 个`);
    const asset = candidates[0];
    assert.ok(Number(asset.size) > 0, `${asset.name} 的 size 无效`);
    assert.match(String(asset.digest || ""), /^sha256:[0-9a-f]{64}$/i, `${asset.name} 缺少合法 SHA-256`);
    assert.match(String(asset.browser_download_url || ""), /^https:\/\/github\.com\//, `${asset.name} 下载地址不是 GitHub HTTPS`);

    const length = probeDownload(asset.browser_download_url, asset.name);
    assert.equal(length, Number(asset.size), `${asset.name} 下载长度 ${length} 与 API size ${asset.size} 不一致`);
    console.log(`✓ ${rule.label}: ${asset.name} (${asset.size} bytes, ${asset.digest})`);
    if (FULL_DOWNLOAD) downloadAndHash(asset.browser_download_url, Number(asset.size), String(asset.digest), asset.name);
  }

  console.log(`PASS: GitHub Release v${version} 满足 Windows + Android 应用内更新契约`);
} finally {
  clearTimeout(timeout);
}
