import { readProductSource } from "./lib/read-product-source.mjs";
/**
 * 端内扫一扫的回归守卫。
 *
 * 解码本身是 jsQR 的事（它有自己的测试），这一层要钉住的是我们写的那段接线：
 *  ① 电脑端二维码里的载荷，必须正好是手机端 parseLanTarget 认得的那串 —— 两端各自改
 *     格式时最容易只改一边，症状是「扫了说不是配对码」；
 *  ② 解码器必须留在核心 bundle 之外（252 KB，不扫码的人不该背）；
 *  ③ 相机一定被关掉、取景层一定挂成 backNav 认得的浮层（开着摄像头后台 = 最恶劣的漏）；
 *  ④ 扫码与粘贴两条入口要走同一个连接函数，否则「一键」是假的；
 *  ⑤ Android 清单里那两条相机声明（权限 + 非必需 feature）不能漏，漏了连授权弹窗都没有。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => readProductSource(new URL(rel, import.meta.url), 'utf8');
const scanSrc = read('../src/qrScan.js');
const cardSrc = read('../src/views/settings/sync.js');
const styles = read('../src/styles.css');

/* ── ① 二维码载荷两端对得上 ── */
// 电脑端那张码的内容：{base}/m?token={token}（同时是浏览器遥控页的地址，一码两用）
const lan = read('../src-tauri/src/lan.rs');
assert.match(lan, /qr_svg\(&format!\("\{base\}\/m\?token=\{token_in\}"\)\)/,
  '二维码内容一改，手机扫码这条入口就得跟着改解析');
assert.match(lan, /let url = format!\("\{base\}\/m\?token=\{token\}"\)/, '配对链接与二维码内容必须是同一个形状');

const { parseLanTarget } = await import('../src/lanSync.js');
// 拿扫码格式的一整串走一遍（地址用 TEST-NET 文档段，不是任何真实局域网）
const fromQr = parseLanTarget('http://192.0.2.10:27123/m?token=abcdef12');
assert.deepEqual(fromQr, { base: 'http://192.0.2.10:27123', token: 'abcdef12' }, '扫到的整条配对链接要能直接拆出地址与码');
// 扫到别的东西（付款码、普通网址）必须抛错，绝不能静默填进输入框
assert.throws(() => parseLanTarget('HTTPS://qr.alipay.com/bax034'), /配对码|读不出来/);

/* ── ② 解码器不进核心 bundle ── */
assert.match(scanSrc, /await import\("jsqr"\)/, 'jsQR 必须动态 import：252 KB 不该让每次启动都背');
const pkg = JSON.parse(read('../package.json'));
assert.ok(pkg.dependencies.jsqr, 'jsqr 要进 dependencies（Vite 构建期要解析它）');
const lock = JSON.parse(read('../package-lock.json'));
assert.ok(lock.packages['node_modules/jsqr'], 'package-lock 里必须有 jsqr，否则 CI / 别的机器装不出来');
assert.match(read('../public/OPEN_SOURCE_NOTICES.md'), /jsQR/, '第三方许可清单要补上解码库');

/* ── ③ 相机的开与关 ── */
assert.match(scanSrc, /stream\?\.getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/, '关掉取景层必须停掉所有轨道（相机不能开着）');
/* 拆干净这件事只能有一个出口：解到码 / 按取消 / 按 Esc / 相机打不开，四条路都要停轨道、
   摘监听、移 DOM。少摘一个监听，扫一次码就多挂一份 Esc 处理。 */
assert.match(scanSrc, /const close = \(value\) => \{[\s\S]{0,260}removeEventListener\("keydown"[\s\S]{0,60}box\.remove\(\)/,
  'close 里要一次停掉轨道、摘掉键盘监听、移除取景层');
assert.equal([...scanSrc.matchAll(/box\.remove\(\)/g)].length, 1, '移除取景层只许出现在 close 里（自己另写一条就绕过了幂等保护）');
assert.match(scanSrc, /catch \(e\) \{\s*\n\s*close\(null\);\s*\n\s*throw new Error\(describeCameraError\(e\)\)/, '相机打不开也要走 close');
assert.match(scanSrc, /class: "drawer-mask qrscan"/, '根元素要带 drawer-mask，Android 返回键才会把它当最上层浮层关掉');
assert.doesNotMatch(scanSrc, /box\.addEventListener\("click"/, '取景层故意不绑「点空白处关闭」—— 取景时误触不该放弃这次扫码');
assert.match(scanSrc, /if \(settled\) return;/, 'close 要幂等：取消与解到码可能同时到');
assert.match(scanSrc, /e\.key === "Escape"/, '桌面 / 键盘环境要能用 Esc 退出');
assert.match(scanSrc, /export function canScanQr\(\)[\s\S]{0,120}navigator\.mediaDevices\?\.getUserMedia/,
  '没有相机 API 的地方（桌面端非安全上下文）要能判出来，按钮直接藏掉');
/* 相机错误一律翻成人话：浏览器抛的 NotAllowedError / NotReadableError 没人看得懂，
   而「被别的程序占着」这种恰恰是最常见的实际状况。 */
assert.match(scanSrc, /NotAllowedError/, '权限被拒要有单独一句');
assert.match(scanSrc, /NotReadableError/, '相机被占用要单独说一句，并点名微信 / 扫码类应用');
assert.match(scanSrc, /系统设置|权限 里放出来/, '拒过一次之后要告诉用户去哪补救');
assert.match(scanSrc, /overconstrainedError|OverconstrainedError/i, '没有后置相机的设备要能落到「没有可用相机」而不是卡住');
assert.doesNotMatch(scanSrc, /alert\(|confirm\(/, '扫码层不许弹原生对话框');

/* ── ④ 两条入口共用同一个连接函数 ── */
assert.match(cardSrc, /async function connectTo\(next\)/, '连接逻辑要能复用');
assert.match(cardSrc, /await connectTo\(parseLanTarget\(text\)\)/, '扫码成功后立刻连接：扫完还要再点一下就不叫一键');
assert.match(cardSrc, /await pullToLocal\(\{ fromScan: true \}\)/, '扫码连接成功后必须直接进入自动拉取，不再要求用户点第二个按钮');
assert.match(cardSrc, /const isBlank = localTasks === 0 && localBlocks === 0/, '空白手机扫码可以直接初始化');
assert.match(cardSrc, /扫码自动同步前/, '扫码覆盖已有数据前必须创建独立命名的恢复点');
assert.match(cardSrc, /已有数据时会先确认/, '界面必须明确说明扫码自动同步的覆盖边界');
assert.match(cardSrc, /const connectBtn[\s\S]{0,220}await connectTo\(parseLanTarget\(linkInput\.value, tokenInput\.value\)\)/,
  '粘贴那条走的必须是同一个函数');
assert.match(cardSrc, /const scanBtn = !isDesktop && canScanQr\(\)/, '扫码按钮只在有相机的端上出现');
assert.match(cardSrc, /if \(!text\) return;/, '用户自己按取消不是错误，别报红字');
assert.match(cardSrc, /那不是本程序的配对二维码/, '扫到别处的码要说清是「不是配对码」，而不是「连不上」');
assert.match(cardSrc, /scanBtn, connectBtn/, '扫码按钮要排在连接按钮前面（它是推荐路径）');
assert.match(cardSrc, /linkInput\.value = text;\s*\n\s*tokenInput\.value = ""/, '连上之后把链接回填输入框、配对码留空（框里能看到自己连的是哪台）');

/* ── 取景层样式：安全区与缩放两个坑 ── */
for (const cls of ['qrscan', 'qrscan-video', 'qrscan-frame', 'qrscan-hint', 'qrscan-cancel']) {
  assert.match(styles, new RegExp(`\\.${cls}[\\s,{:.]`), `styles.css 里没有 .${cls} 这条规则`);
}
const qrRules = [...styles.matchAll(/^\.qrscan[^{]*\{[^}]*\}/gm)].map((m) => m[0]).join('\n');
/* position:fixed 不吃宿主 .view 的安全区 padding（AGENTS.md 铁律四），必须自己让开四边；
   而且一律写 var(--sat, env(...)) —— Android WebView 里裸 env() 恒为 0。 */
const envUses = [...qrRules.matchAll(/env\(safe-area-inset-(\w+)/g)];
assert.ok(envUses.length >= 4, '取景层四边都要避让：状态栏、导航栏、横屏挖孔与侧边三键栏');
for (const m of envUses) {
  const head = qrRules.slice(0, m.index);
  assert.match(head, new RegExp(`var\\(--sa${m[1][0]},\\s*$`), `这条 env() 前面没有 var(--sa${m[1][0]}) 兜底，手机上等于 0：${m[0]}`);
}
assert.match(qrRules, /--ui-vw/, '宽度用 --ui-vw 而不是裸 vw（zoom 下 vw 会超屏）');
assert.match(qrRules, /\.qrscan\s*\{[^}]*background: #0B1014/, '取景层必须不透明：半透明透出底下设置页像卡死了');

/* ── ⑤ Android 清单：两条相机声明 ── */
const syncTool = read("../../tools/sync-android-native.js");
assert.match(syncTool, /const CAMERA_PERMISSION = "android\.permission\.CAMERA"/, '补丁脚本要管相机权限');
assert.match(syncTool, /android:required="false"/, '相机要显式声明非必需，否则没相机的设备装不上');
assert.match(syncTool, /ensureCameraDeclarations\(xml\)/, '补丁要接进 patchManifest，否则只是段没人调的代码');
const mirror = read('../android/gradle/app/src/main/AndroidManifest.xml');
assert.match(mirror, /<uses-permission android:name="android\.permission\.CAMERA" \/>/, '镜像清单要带相机权限');
assert.match(mirror, /<uses-feature android:name="android\.hardware\.camera" android:required="false" \/>/, '镜像清单要带非必需相机 feature');

console.log('PASS: 端内扫一扫（二维码载荷两端对齐 / 解码器不进核心包 / 相机必定停掉 / 扫码与粘贴共用连接入口 / 取景层四边安全区 / Android 相机两条声明）');
