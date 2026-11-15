#!/usr/bin/env node
// 以 le-time-management/package.json 为发布版本单一事实源，同步/校验桌面端、Android 与小程序版本。
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const APP = path.join(ROOT, "le-time-management");
const DESKTOP = path.join(APP, "src-tauri");
const CHECK = process.argv.includes("--check");
const pkgPath = path.join(APP, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const version = pkg.version;
const failures = [];

// package.json 的 name 必须指向本应用（防止带着上游名字发布）
if (pkg.name !== "le-time-management") failures.push(`package.json name: ${pkg.name} != le-time-management`);

function syncJson(file, label) {
  if (!fs.existsSync(file)) { failures.push(`${label}: 文件不存在`); return; }
  const obj = JSON.parse(fs.readFileSync(file, "utf8"));
  if (obj.version === version) return;
  if (CHECK) failures.push(`${label}: ${obj.version || "<missing>"} != ${version}`);
  else {
    obj.version = version;
    fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  }
}

syncJson(path.join(DESKTOP, "tauri.conf.json"), "tauri.conf.json");

const cargo = path.join(DESKTOP, "Cargo.toml");
const cargoText = fs.readFileSync(cargo, "utf8");
const cargoVersion = cargoText.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (cargoVersion !== version) {
  if (CHECK) failures.push(`Cargo.toml: ${cargoVersion || "<missing>"} != ${version}`);
  else fs.writeFileSync(cargo, cargoText.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`));
}

const cargoLock = path.join(DESKTOP, "Cargo.lock");
const lockText = fs.readFileSync(cargoLock, "utf8");
// 换行要容忍 CRLF：Windows 上 core.autocrlf=true 时 checkout 出来的 Cargo.lock 是 CRLF，
// 只认 \n 会让 --check 报 "<missing> != x.y.z"，然后构建脚本直接拒绝开工。
const lockMatch = lockText.match(/(\[\[package\]\]\r?\nname = "letime"\r?\nversion = ")([^"]+)(")/);
const lockVersion = lockMatch?.[2];
if (lockVersion !== version) {
  if (CHECK) failures.push(`Cargo.lock: ${lockVersion || "<missing>"} != ${version}`);
  else if (lockMatch) fs.writeFileSync(cargoLock, lockText.replace(lockMatch[0], lockMatch[1] + version + lockMatch[3]));
  else failures.push("Cargo.lock: 未找到 le-time-management 包版本");
}

// Android 生成目录的版本号：本仓库的 APK 流水线绕开了 tauri CLI，
// 所以 gen/android 里的 tauri.properties 不会自动刷新，必须一并同步。
const androidProps = path.join(DESKTOP, "gen", "android", "app", "tauri.properties");
if (fs.existsSync(androidProps)) {
  const [maj, min, pat] = version.split(".").map(Number);
  const code = maj * 10000 + min * 100 + pat;
  let text = fs.readFileSync(androidProps, "utf8");
  const curName = text.match(/tauri\.android\.versionName=([^\r\n]*)/)?.[1];
  const curCode = text.match(/tauri\.android\.versionCode=([^\r\n]*)/)?.[1];
  if (curName !== version || curCode !== String(code)) {
    if (CHECK) failures.push(`android tauri.properties: ${curName || "<missing>"}/${curCode || "<missing>"} != ${version}/${code}`);
    else {
      text = text
        .replace(/tauri\.android\.versionName=[^\r\n]*/, `tauri.android.versionName=${version}`)
        .replace(/tauri\.android\.versionCode=[^\r\n]*/, `tauri.android.versionCode=${code}`);
      fs.writeFileSync(androidProps, text);
    }
  }
}

// Android 生成目录里的 app_name / 标题（品牌串，与 tauri.conf.json 的 productName 保持一致）
const stringsXml = path.join(DESKTOP, "gen", "android", "app", "src", "main", "res", "values", "strings.xml");
if (fs.existsSync(stringsXml)) {
  const productName = JSON.parse(fs.readFileSync(path.join(DESKTOP, "tauri.conf.json"), "utf8")).productName;
  let xml = fs.readFileSync(stringsXml, "utf8");
  const wanted = xml
    .replace(/<string name="app_name">.*?<\/string>/, `<string name="app_name">"${productName}"</string>`)
    .replace(/<string name="main_activity_title">.*?<\/string>/, `<string name="main_activity_title">"${productName} · 时间块与四象限"</string>`);
  if (wanted !== xml) {
    if (CHECK) failures.push(`android strings.xml: app_name 与 tauri.conf.json productName(${productName}) 不一致`);
    else fs.writeFileSync(stringsXml, wanted);
  }
}

const miniMeta = path.join(ROOT, "miniprogram", "core", "appMeta.js");const miniText = fs.readFileSync(miniMeta, "utf8");
const miniVersion = miniText.match(/version:\s*"([^"]+)"/)?.[1];
if (miniVersion !== version) {
  if (CHECK) failures.push(`miniprogram appMeta: ${miniVersion || "<missing>"} != ${version}`);
  else fs.writeFileSync(miniMeta, miniText.replace(/version:\s*"[^"]+"/, `version: "${version}"`));
}

// 仓库根 README 若带「版本：vX.Y.Z」行则一并校验；没有这行就跳过，不算失败。
const readme = path.join(ROOT, "README.md");
const readmeText = fs.readFileSync(readme, "utf8");
const readmeVersion = readmeText.match(/版本：v(\d+\.\d+\.\d+)/)?.[1];
if (readmeVersion && readmeVersion !== version) {
  if (CHECK) failures.push(`README.md: ${readmeVersion} != ${version}`);
  else fs.writeFileSync(readme, readmeText.replace(/版本：v\d+\.\d+\.\d+/, `版本：v${version}`));
}

if (failures.length) {
  console.error(CHECK ? "版本一致性检查失败：" : "版本同步出现问题：");
  failures.forEach((x) => console.error("- " + x));
  process.exit(1);
}
console.log(CHECK ? `✓ 三端版本一致：v${version}` : `✓ 已同步三端版本：v${version}`);
