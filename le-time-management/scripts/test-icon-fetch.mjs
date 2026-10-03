import { readProductSource } from "./lib/read-product-source.mjs";
// 站点图标抓取的契约测试（school-notice 插件 + 原生侧）。
//
// 背景：Android 上 Tauri 用 WebViewAssetLoader（默认 scheme = https），页面来源是
// https://tauri.localhost；WebView 自 API 21 起默认 MIXED_CONTENT_NEVER_ALLOW，
// release 版还叠了 usesCleartextTraffic=false ⇒ 学校网站常见的 http://…/favicon.ico
// 用 <img src> 直连会被静默拦掉。桌面端页面来源是 http://tauri.localhost
// （明文页面加载明文图片不算混合内容），所以同一个站点在 Windows 上正常、在 APK 上消失
// —— 只看桌面端永远复现不了。修法是把图标搬到原生侧抓成 data URL。
//
// 本文件守三件事：
//   ① Rust icon_mime 不能把 HTML 当图标收进来（否则 data URL 里塞的是一段网页）；
//   ② 插件侧三层降级（data URL → 远程直连 → 首字母）不能塌；
//   ③ 接线（命令注册 / 插件 API / 调用点 / CSS 规则）不能断。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const read = (rel) => readProductSource(path.join(appRoot, rel), 'utf8');

const libSource = read('src-tauri/src/lib.rs');
const pluginSource = read('public/plugins/school-notice/main.js');
const apiSource = read('src/api.js');
const hostSource = read('src/pluginHost.js');

/* ══════════ 一、Rust icon_mime 真跑 ══════════
   切 lib.rs 里那份原文去编译，而不是在测试里抄一份 —— 抄一份会随源码漂移，等于没测。 */
function extractRustFn(source, name) {
  const start = source.indexOf('fn ' + name + '(');
  assert.ok(start >= 0, 'lib.rs 里找不到 ' + name + '()');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(name + ' 的括号不配平');
}

function findRustc() {
  const candidates = [
    process.env.RUSTC,
    path.join(os.homedir(), '.rustup', 'toolchains', 'stable-x86_64-pc-windows-msvc', 'bin', 'rustc.exe'),
    path.join(os.homedir(), '.cargo', 'bin', 'rustc'),
    'rustc',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const rustc = findRustc();
if (rustc) {
  const rustTests = `
#[cfg(test)]
mod tests {
    use super::*;

    fn png() -> Vec<u8> { vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3] }
    fn jpeg() -> Vec<u8> { vec![0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3] }
    fn gif() -> Vec<u8> { b"GIF89a0123456".to_vec() }
    fn bmp() -> Vec<u8> { b"BM0123456".to_vec() }
    fn ico() -> Vec<u8> { vec![0x00, 0x00, 0x01, 0x00, 1, 2, 3, 4] }
    fn webp() -> Vec<u8> {
        let mut v = b"RIFF".to_vec();
        v.extend_from_slice(&[0, 0, 0, 0]);
        v.extend_from_slice(b"WEBP");
        v.extend_from_slice(&[1, 2, 3]);
        v
    }
    fn html() -> Vec<u8> { b"<!DOCTYPE html><html><body>404</body></html>".to_vec() }

    #[test]
    fn magic_beats_header() {
        // 高校站点的图标常由老 IIS 提供，Content-Type 是 text/plain 或干脆没有。
        // 只信头会把好图标判死，所以魔数优先。
        assert_eq!(icon_mime("text/plain", &png()).as_deref(), Some("image/png"));
        assert_eq!(icon_mime("application/octet-stream", &ico()).as_deref(), Some("image/x-icon"));
        assert_eq!(icon_mime("", &jpeg()).as_deref(), Some("image/jpeg"));
        assert_eq!(icon_mime("", &gif()).as_deref(), Some("image/gif"));
        assert_eq!(icon_mime("", &bmp()).as_deref(), Some("image/bmp"));
        assert_eq!(icon_mime("", &webp()).as_deref(), Some("image/webp"));
    }

    #[test]
    fn html_404_is_rejected() {
        // 站点把 /favicon.ico 回落到首页是最常见的坑：收进来等于把一段网页内联成图片
        assert_eq!(icon_mime("text/html", &html()), None);
        assert_eq!(icon_mime("", &html()), None);
        assert_eq!(icon_mime("text/plain", b"not an image at all"), None);
    }

    #[test]
    fn svg_is_rejected() {
        // svg 是文档不是位图，内联等于把第三方文档塞进应用
        assert_eq!(icon_mime("image/svg+xml", b"<svg xmlns=\\"http://www.w3.org/2000/svg\\"></svg>"), None);
    }

    #[test]
    fn header_fallback_strips_params() {
        // 魔数认不出时才退到响应头，且要剥掉 ;charset=... 这类参数
        assert_eq!(icon_mime("image/png; charset=binary", b"\\x01\\x02\\x03\\x04").as_deref(), Some("image/png"));
        assert_eq!(icon_mime("image/vnd.microsoft.icon", b"\\x01\\x02\\x03\\x04").as_deref(), Some("image/vnd.microsoft.icon"));
        // 头自称 image/* 但其实是 svg，仍要拒
        assert_eq!(icon_mime("image/svg+xml", b"\\x01\\x02\\x03\\x04"), None);
    }
}
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'letime-icon-mime-'));
  try {
    const srcFile = path.join(dir, 'icon_mime.rs');
    const binFile = path.join(dir, process.platform === 'win32' ? 'icon_mime_test.exe' : 'icon_mime_test');
    fs.writeFileSync(srcFile, extractRustFn(libSource, 'icon_mime') + '\n' + rustTests);
    const compiled = spawnSync(rustc, ['--test', '--edition', '2021', srcFile, '-o', binFile], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, 'icon_mime 测试编译失败：\n' + (compiled.stderr || ''));
    const ran = spawnSync(binFile, [], { encoding: 'utf8' });
    assert.equal(ran.status, 0, 'icon_mime 断言失败：\n' + (ran.stdout || '') + (ran.stderr || ''));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
} else {
  console.log('SKIP: 未找到 rustc，跳过 icon_mime 实跑（装了 Rust 会自动生效）');
}

/* ══════════ 二、插件 favHtml 三层降级真跑 ══════════ */
function extractJsFn(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, 'main.js 里找不到 ' + name + '()');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(name + ' 的括号不配平');
}

// 测试用的 esc 必须与插件里那份语义一致，否则断言里的 &quot; 会对不上。
// 下面这条断言就是防漂移：插件改了转义集合，这里会先失败提醒同步。
assert.match(pluginSource, /const esc = \(s\) => String\(s \?\? ""\)\.replace\(\/\[&<>"'\]\/g/, '插件 esc 实现变了，本测试的 mock 要同步');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const favCode = ['iconDataOf', 'iconStyleAttr', 'favHtml'].map((name) => extractJsFn(pluginSource, name)).join('\n');
const { favHtml, iconDataOf } = new Function('esc', favCode + '\nreturn { iconDataOf, iconStyleAttr, favHtml };')(esc);

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const site = (patch) => Object.assign({ name: '中国人民警察大学', iconUrl: 'http://www.cppu.edu.cn/favicon.ico' }, patch || {});

// ① 有 data URL ⇒ 走 CSS 变量，不再输出远程 <img>（那正是 APK 上必挂的路径）
const withData = favHtml(site({ iconData: PNG }));
assert.match(withData, /class="sn-fav has-icon"/, '有 data URL 时要打 has-icon');
assert.doesNotMatch(withData, /<img/, '有 data URL 时不该再输出远程 <img>');
assert.ok(withData.includes('--sn-icon:url(&quot;' + PNG + '&quot;)'), 'data URL 要写进 --sn-icon');
assert.match(withData, /data-initial="中"/, '首字母兜底属性要保留');

// ② inline=false ⇒ 不内联 base64（公告列表上百条，靠容器继承同一份变量）
const noInline = favHtml(site({ iconData: PNG }), '', false);
assert.match(noInline, /has-icon/, 'inline=false 仍要打 has-icon');
assert.doesNotMatch(noInline, /--sn-icon/, 'inline=false 不能内联 base64');

// ③ 脏值不能当图标用。只查 data:image/ 前缀是不够的 ——
//    脏值里塞个引号就能突破 style 属性，所以真正的约束是 base64 段只含 base64 字符。
assert.equal(iconDataOf({ iconData: 'data:text/html,<script>alert(1)</script>' }), '', '非 image 的 data URL 要拒');
assert.equal(iconDataOf({ iconData: 'https://evil.example/x.png' }), '', '非 data: 前缀要拒');
assert.equal(iconDataOf({ iconData: 123 }), '', '非字符串要拒');
assert.equal(iconDataOf({ iconData: 'data:image/svg+xml;base64,PHN2Zz4=' }), '', 'svg 要拒（纵深防御）');
assert.equal(iconDataOf({ iconData: 'data:image/png;base64,AAAA!' }), '', 'base64 段有非法字符要拒');
assert.doesNotMatch(favHtml(site({ iconData: 'data:image/png;base64,x" onload="alert(1)' })), /onload/, '含引号的脏值不能突破 style 属性');

// ④ 只有远程地址 ⇒ 保留 <img> 直连（桌面端照常显示），失败时靠 .no-img 退回首字母
const remote = favHtml(site());
assert.match(remote, /<img src="http:\/\/www\.cppu\.edu\.cn\/favicon\.ico"/, '无 data URL 时要退回远程 <img>');
assert.doesNotMatch(remote, /has-icon/, '远程直连模式不该打 has-icon');

// ⑤ 都没有 ⇒ 空串，不占位
assert.equal(favHtml({ name: 'x' }), '', '没有图标来源时不该输出占位元素');

// ⑥ 类名要传下去
assert.match(favHtml(site({ iconData: PNG }), ' big'), /class="sn-fav big has-icon"/, 'data 模式的 big 类名要保留');
assert.match(favHtml(site(), ' big'), /class="sn-fav big"/, '远程模式的 big 类名要保留');

/* ══════════ 二之二、web-collector 的图标降级 ══════════
   同一个根因的第二个受害者：它的**内置预置条目**「大学名录」写的就是
   http://daxue.qiyemulu.cn/favicon.ico —— 在 APK 上必然退化成字形图标。 */
const wcSource = read('public/plugins/web-collector/main.js');

// fa() 是插件里生成字形兜底的函数，测试里用等价 mock（同样吃 name 参数）。
const fa = (name) => '<svg data-fa="' + String(name || 'globe') + '"></svg>';
const wcCode = ['iconDataOf', 'favicon'].map((name) => extractJsFn(wcSource, name)).join('\n');
const wc = new Function('esc', 'fa', wcCode + '\nreturn { iconDataOf, favicon };')(esc, fa);

const wcItem = (patch) => Object.assign({ title: '大学名录', iconUrl: 'http://daxue.qiyemulu.cn/favicon.ico', iconName: 'school' }, patch || {});

// ① 有 data URL ⇒ 用它，不再直连远程
const wcWithData = wc.favicon(wcItem({ iconData: PNG }));
assert.ok(wcWithData.includes('src="' + PNG + '"'), 'web-collector 有 data URL 时要优先用它');
assert.ok(!wcWithData.includes('daxue.qiyemulu.cn'), 'web-collector 有 data URL 时不该再出现远程地址');
// ② 只有远程地址 ⇒ 保留直连（桌面端照常显示，失败由 onerror 兜字形）
assert.ok(wc.favicon(wcItem()).includes('src="http://daxue.qiyemulu.cn/favicon.ico"'), 'web-collector 无 data URL 时要退回远程直连');
// ③ 都没有 ⇒ 字形兜底
assert.ok(wc.favicon({ iconName: 'globe' }).includes('data-fa="globe"'), 'web-collector 无图标来源时要退回字形');
// ④ 脏值不能当图标用
assert.equal(wc.iconDataOf({ iconData: 'data:image/svg+xml;base64,PHN2Zz4=' }), '', 'web-collector 也要拒 svg');
assert.equal(wc.iconDataOf({ iconData: 'data:image/png;base64,AAAA!' }), '', 'web-collector 也要拒非法 base64');
assert.equal(wc.iconDataOf({ iconData: 'data:image/png;base64,x" onload="alert(1)' }), '', 'web-collector 也不能让脏值突破 src 属性');

/* ══════════ 三、接线契约 ══════════
   这一段全部用 ok(/re/.test(src)) 而不是 assert.match —— 失败时 match 会把整份源码
   打进报错信息（33 KB），根本读不出是哪条挂了。 */
const hit = (src, re, msg) => assert.ok(re.test(src), msg);

// Rust 命令必须注册，否则前端 invoke 直接报错（编译过、运行才炸）
hit(libSource, /#\[tauri::command\]\s*\n\s*async fn http_get_icon\(/, 'lib.rs 要有 http_get_icon 命令');
hit(libSource, /invoke_handler[\s\S]{0,4000}?http_get_icon,/, 'http_get_icon 要注册进 invoke_handler');
// 两端都要有：加了 #[cfg(desktop)] 会让 Android 编不过
assert.ok(!/#\[cfg\(desktop\)\][\s\S]{0,80}?async fn http_get_icon/.test(libSource), 'http_get_icon 不能加 cfg(desktop) 门控');
// 大小封顶：不封顶的话一个指向大文件的 URL 能把几十 MB 灌进 data.json
hit(libSource, /MAX_ICON_BYTES/, '图标抓取必须有大小上限');

// 插件 API：走 http 权限组，且要真的转发到原生命令
hit(hostSource, /getIcon: \(url\) => \{ requirePermission\(man, pid, "http"\); return api\.httpGetIcon\(url\); \}/, 'pluginHost 要暴露 tide.http.getIcon 并校验 http 权限');
hit(apiSource, /async httpGetIcon\(url\) \{[\s\S]{0,200}?invoke\("http_get_icon", \{ url \}\)/, 'api.js 的 httpGetIcon 要转发到 http_get_icon');

// 调用点：新增 / 刷新 / 存量补抓三处都要接上，漏一处就有一批站点永远没有图标
hit(pluginSource, /tmp\.iconUrl = ad\?\.icon \|\| meta\.iconUrl \|\| "";[\s\S]{0,2000}?await ensureIconData\(tmp, false\);/, 'addSite 要补抓图标');
hit(pluginSource, /await save\(\);[\s\S]{0,200}?\/\/ 刷新顺带补图标[\s\S]{0,300}?await ensureIconData\(site, false\);/, '刷新要补抓图标');
hit(pluginSource, /if \(sites\.some\(\(x\) => x\.iconUrl && !x\.iconData\)\)/, 'render 要对存量站点后台补抓');
hit(pluginSource, /sites\.map\(\(\{ id, name, url, loginUrl, cms, lastFetchedAt, iconUrl, iconData, spaHint \}\)/, 'iconData 要落盘，否则重启就丢');

// CSS：has-icon 必须用容器可继承的变量，且列表项不能自己内联
hit(pluginSource, /\.sn-fav\.has-icon\{background-image:var\(--sn-icon\)/, 'CSS 要有 .sn-fav.has-icon 规则');
hit(pluginSource, /<div class="sn-list"\$\{iconStyleAttr\(site\)\}>/, '公告列表容器要设 --sn-icon，让列表项继承同一份');
hit(pluginSource, /\$\{favHtml\(site, "", false\)\}/, '公告列表项要 inline=false，避免上百条各内联一份 base64');

// web-collector：两条抓取链路（整体识别 / 只取图标）都要带上 iconData，
// 否则存量条目与预置条目在 APK 上永远只有字形图标
hit(wcSource, /return \{ url: finalUrl, \.\.\.meta, iconData: await fetchIconData\(meta\.iconUrl\) \};/, 'web-collector 的 inspect 要带 iconData');
hit(wcSource, /return \{ iconUrl, iconName: iconName \|\| "globe", iconData: await fetchIconData\(iconUrl\) \};/, 'web-collector 的 fetchIcon 要带 iconData');
hit(wcSource, /if \(items\.some\(\(x\) => x\.iconUrl && !iconDataOf\(x\)\)\)/, 'web-collector 要对存量条目后台补抓');

console.log('PASS: 站点图标抓取（icon_mime 拒 HTML/svg、三层降级、接线与 CSS 契约）');
