import { readProductSource } from "./lib/read-product-source.mjs";
// 系统托盘 + 「点关闭按钮」行为：设置页可开关，Rust 侧必须真的照做。
//
// 两件事分开管，但**互相约束**：
//   ① settings.trayEnabled  = 要不要创建托盘图标（默认 true，启动时生效）
//   ② settings.closeToTray  = 点关闭按钮时藏起来还是直接退出（默认 true）
//
// 🔴 这两者有一个致命的组合：托盘图标关掉了，但关闭行为还是「隐藏到托盘」
//    ⇒ 窗口一隐藏，托盘里没有图标，用户**再也叫不回来这个应用**，只能去任务管理器杀进程。
//    所以约束是：trayEnabled=false ⇒ closeToTray 必然为 false。
//    前端在开关的 onChange 里改写，Rust 侧在 CloseRequested 里再拦一道（双保险）。
//
// 真正的托盘图标长什么样、点一下窗口会不会出来，只能在装好的桌面版里看；
// 这里钉住的是**逻辑与接线**：设置键名、Rust 现读、默认值、以及上面那条致命组合。
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => readProductSource(new URL(p, import.meta.url), "utf8");
const libRs = read("../src-tauri/src/lib.rs");
const appearance = read("../src/views/settings/appearance.js");

/* ── 一、Rust：托盘图标是否创建，必须由设置里现读决定 ── */
// 从 `fn setup_tray(` 处切到 run() 之前（函数体内有独立的 `}` 行，不能用「第一个 \n} 截断」）
const setupTrayStart = libRs.indexOf("fn setup_tray(app: &mut tauri::App)");
const setupTrayEnd = libRs.indexOf('#[cfg_attr(mobile, tauri::mobile_entry_point)]');
assert.ok(setupTrayStart > -1 && setupTrayEnd > setupTrayStart, "lib.rs 必须还有 setup_tray");
const setupTray = libRs.slice(setupTrayStart, setupTrayEnd);

// 关键：开关判断必须在**建图标之前**。建完再判断等于没判断（图标已经出来了）。
const guardAt = setupTray.indexOf("tray_enabled(");
const buildAt = setupTray.indexOf("builder.build(app)");
assert.ok(guardAt > -1, "setup_tray 必须查 tray_enabled —— 否则「关闭系统托盘」设置形同虚设");
assert.ok(buildAt > guardAt, "tray_enabled 判断必须在 builder.build(app) 之前，建完图标再判断等于没判断");
// 闸门必须包住整段建图标逻辑：`tray_enabled` 与 `return Ok(())` 要在 build 之前，
// 且**中间不能先出现 build**（`guardAt < buildAt` 正是这个意思）。
const guardEnd = setupTray.indexOf("return Ok(());");
assert.ok(guardEnd > guardAt, "托盘被关掉时必须提前 return Ok(())，不能继续往下建图标");
assert.ok(guardEnd < buildAt, "这个 return 必须在 builder.build(app) 之前，否则图标已经建出来了");
// 反面：别在「没打开」的分支里顺手把别的窗口/菜单也建出来
assert.doesNotMatch(setupTray.slice(0, buildAt), /unwrap_err\(\)|panic!\(|unimplemented!\(/,
  "setup_tray 是启动路径，任何 panic 都会让应用起不来");

/* ── 二、Rust：CloseRequested 必须同时看两个开关（防「应用藏没了」） ── */
const closeHandler = libRs.match(/on_window_event\(\|window, event\| \{([\s\S]*?)\n        \}\);/)?.[1] ?? "";
assert.ok(closeHandler, "必须存在 on_window_event 的关闭拦截");
assert.match(closeHandler, /tray_enabled\(window\.app_handle\(\)\)/,
  "🔴 关闭拦截必须同时检查托盘是否启用：托盘关掉还隐藏窗口 = 应用再也点不出来");
assert.match(closeHandler, /close_to_tray\(window\.app_handle\(\)\)/, "关闭拦截必须检查 closeToTray 设置");
assert.ok(closeHandler.indexOf("tray_enabled(") < closeHandler.indexOf("api.prevent_close()"),
  "托盘/关闭两个判断必须在 prevent_close 之前，否则窗口已经被拦下了");
assert.match(closeHandler, /window\.label\(\) == "main"/, "只拦主窗口，教务导入窗等子窗口要照常能关");

/* ── 三、Rust：两个设置键名与默认值落到同一处 ── */
assert.match(libRs, /fn close_to_tray\(app: &tauri::AppHandle\) -> bool \{\s*read_desktop_setting\(app, "\/settings\/closeToTray", true\)/,
  "closeToTray 的默认值必须是 true（隐藏到托盘），且只走 read_desktop_setting 一处");
assert.match(libRs, /fn tray_enabled\(app: &tauri::AppHandle\) -> bool \{\s*read_desktop_setting\(app, "\/settings\/trayEnabled", true\)/,
  "trayEnabled 的默认值必须是 true（与引入开关之前的行为一致）");
assert.match(libRs, /fn read_desktop_setting\(app: &tauri::AppHandle, pointer: &str, default: bool\) -> bool \{/,
  "必须收口到 read_desktop_setting(pointer, default)");
// 现读而非启动缓存 —— 设置改完要立刻生效，不能等重启
assert.match(libRs, /fs::read_to_string\(dir\.join\("data\.json"\)\)/,
  "必须现读 data.json：启动时缓存的话，设置改完要重启才生效");

/* ── 四、前端：两个选项都要在设置页里，且只在桌面端出现 ── */
assert.match(appearance, /settings\.trayEnabled \?\?= true;/, "设置页必须给 trayEnabled 一个默认值（老用户升级走这条）");
assert.match(appearance, /settings\.closeToTray \?\?= true;/, "设置页必须给 closeToTray 一个默认值");
assert.match(appearance, /ariaLabel: "启用系统托盘"/, "托盘开关要有无障碍名（它旁边只有文字标签，没有 <label> 关联）");
assert.match(appearance, /el\("option", \{ value: "tray" \}, "隐藏到系统托盘"\)/,
  "关闭行为下拉里必须有「隐藏到系统托盘」");
assert.match(appearance, /el\("option", \{ value: "exit" \}, "直接退出应用"\)/,
  "关闭行为下拉里必须有「直接退出应用」");
// 门控：桌面端才有托盘，非桌面环境不该出现这两个选项
assert.match(appearance, /desktopWindow \? trayRow : null/, "托盘开关必须按 desktopWindow 门控");
assert.match(appearance, /desktopWindow \? closeRow : null/, "关闭行为必须按 desktopWindow 门控");
assert.match(appearance, /const desktopWindow = isDesktopRuntime\(\)/, "门控依据必须是 isDesktopRuntime()");

/* ── 五、前端：致命组合在 UI 层就被拆掉 ── */
// 关掉托盘 ⇒ 关闭行为同步改回「直接退出」，并且下拉控件本身要跟着变
const trayOnChange = appearance.match(/ariaLabel: "启用系统托盘",\s*onChange: \(on\) => \{([\s\S]*?)\n      \},/)?.[1] ?? "";
assert.ok(trayOnChange, "托盘开关必须有 onChange");
assert.match(trayOnChange, /settings\.trayEnabled = on;/, "onChange 必须把开关值写进 settings");
assert.match(trayOnChange, /if \(!on\) \{\s*settings\.closeToTray = false;/,
  "🔴 关掉托盘时必须同时把 closeToTray 置 false —— 否则「隐藏到托盘」会变成一个点了应用就消失的死开关");
assert.match(trayOnChange, /closeBox\.value = "exit";/,
  "🔴 光改 settings 不够：下拉控件不同步的话，界面还显示「隐藏到系统托盘」，用户看到的是假状态");
assert.match(trayOnChange, /S\.saveNow\(\)/,
  "必须立刻存盘：Rust 是现读 data.json 的，走 350ms 防抖会在「改完马上点关闭」时读到旧值");
assert.match(trayOnChange, /closeRow\.style\.display = on \? "" : "none";/,
  "托盘关掉时「点关闭按钮时」整行要跟着隐藏（否则一个已失效的选项还摆在界面上）");
// 反过来：托盘关掉时不应把 closeToTray 又打开（单向约束）
assert.doesNotMatch(trayOnChange, /settings\.closeToTray = true/,
  "托盘开关只能把关闭行为往「直接退出」推，不能反向把它设回「隐藏到托盘」");

/* ── 六、初始渲染：别等用户拨一下开关才发现细项该藏起来 ── */
assert.match(appearance, /closeRow\.style\.display = settings\.trayEnabled !== false \? "" : "none";/,
  "首次渲染就要按 trayEnabled 决定「点关闭按钮时」这一行是否显示（否则重启后先亮着一行假选项）");
assert.match(appearance, /closeBox\.value = settings\.closeToTray !== false \? "tray" : "exit";/,
  "下拉初值必须与 closeToTray 对齐（默认 true ⇒ 显示「隐藏到系统托盘」）");
// 校验用 `!== false` 而不是真值判断：脏数据（字符串 "false" 等）不该让默认值塌掉
assert.doesNotMatch(appearance, /checked: settings\.trayEnabled(?!\s*!==\s*false)/,
  "托盘开关初值必须写 `!== false`：脏数据下也要保持默认开启");

/* ── 七、声明顺序：closeBox 被托盘开关的 onChange 引用，不能是 TDZ ── */
const closeDeclAt = appearance.indexOf("const closeBox = el(");
const trayDeclAt = appearance.indexOf("const trayRow = el(");
const closeBoxUseAt = appearance.indexOf("const closeRow = el(");
assert.ok(closeDeclAt > -1 && trayDeclAt > -1 && closeBoxUseAt > -1, "三个节点都要存在");
assert.ok(closeDeclAt < trayDeclAt,
  "🔴 closeBox 必须在托盘开关之前声明：onChange 里要写 closeBox.value，声明在后就是 TDZ 报错（页面白屏）");
assert.ok(trayDeclAt < appearance.indexOf("closeRow.style.display = settings.trayEnabled"),
  "初始显隐逻辑要放在 trayRow 之后，读的才是已经归一过的 settings");

/* ── 八、Rust：托盘「退出」必须等前端存盘回执，不能盲等事后掐进程 ── */
// 背景：`app.exit(0)` 直接掐掉进程。如果前端 `saveNow()` 的 IPC 还没跑完，
// 用户最后的改动就静默丢了。固定 sleep 是在赌「IPC 一定比它快」—— 赌输就丢数据。
const quitBranch = libRs.match(/"quit" => \{([\s\S]*?)\n            \}/)?.[1] ?? "";
assert.ok(quitBranch, "托盘菜单必须有 quit 分支");
assert.match(quitBranch, /app\.emit\("app-quit", \(\)\)/,
  "退出前必须先广播 app-quit，否则前端根本不知道要赶紧存盘");
assert.match(quitBranch, /wait_quit_ack\(&gate, 2000\)/,
  "🔴 必须等前端回执（带超时兜底），不能盲等固定时长");
assert.ok(quitBranch.indexOf('app.emit("app-quit"') < quitBranch.indexOf("wait_quit_ack("),
  "广播必须在等待之前：反过来的话前端永远收不到通知，只能每次等满超时");
assert.ok(quitBranch.indexOf("wait_quit_ack(") < quitBranch.indexOf("app.exit(0)"),
  "等待必须在 app.exit(0) 之前，否则进程已经没了，回执照样收不到");
// 反面：固定 sleep 必须消失。留着它等于「等 800ms 再退出」和「等回执」两条路并存，
// 实际生效的是先到的那条 —— 也就是 sleep 仍然会在慢机器上抢跑。
assert.doesNotMatch(quitBranch, /thread::sleep/,
  "🔴 不能再有固定 sleep：它会在慢机器上抢跑于存盘完成，把回执机制整个架空");
assert.doesNotMatch(quitBranch, /from_millis\(800\)/, "800ms 的拍脑袋超时必须换掉");

/* ── 九、Rust：回执机制本身要「成功失败都能放行、且超时必退」 ── */
assert.match(libRs, /struct QuitGate \{/, "必须有 QuitGate 承载回执状态");
assert.match(libRs, /acked: Mutex<bool>/, "回执状态要能被退出线程与命令线程共享");
// wait_timeout_while 而非 wait：没有超时的话，前端一旦崩了（或压根没加载完）
// 退出线程会永久挂住 —— 用户点了「退出」却退不掉，只能去任务管理器。
assert.match(libRs, /wait_timeout_while\(acked, std::time::Duration::from_millis\(timeout_ms\), \|a\| !\*a\)/,
  "🔴 必须用 wait_timeout_while + 谓词：无超时会让「点了退出退不掉」变成真 bug");
assert.match(libRs, /if \*acked \{\s*return true;\s*\}/,
  "进 wait 前要先看一次已回执的情况，否则会白等满超时");
// 命令必须注册进 invoke_handler，否则前端调 quit_ack 会「命令不存在」，
// 而前端那边是 .catch(() => {}) —— 失败被吞掉，症状是「偶尔退出慢 2 秒」，极难查。
assert.match(libRs, /generate_handler!\[[\s\S]*?\bquit_ack\b/,
  "🔴 quit_ack 必须注册进 generate_handler：漏了的话前端调用报「命令不存在」，且被 catch 静默吞掉");

/* ── 十、前端：存盘回执必须成功、失败都发 ── */
const mainJs = read("../src/main.js");
const apiJs = read("../src/api.js");
assert.match(mainJs, /listen\("app-quit"/, "前端必须监听 app-quit");
assert.match(mainJs, /S\.saveNow\(\)/, "收到 app-quit 后必须立刻存盘（saveNow 会跳过防抖）");
// `.then(ack, ack)` —— 两个槽位都挂 ack。只挂成功槽的话，写盘报错时 Rust 白等满 2s。
assert.match(mainJs, /\.then\(ack, ack\)/,
  "🔴 回执必须成功、失败两条路都发：只发成功的话写盘报错时 Rust 会白等满超时");
assert.match(mainJs, /api\.quitAck\(\)/, "回执要真的调用 quitAck");
assert.match(apiJs, /async quitAck\(\) \{\s*if \(isTauri\) return invoke\("quit_ack"\);/,
  "api.quitAck 必须按 isTauri 降级：浏览器里要退化成空操作，不能抛错");
// 反面：回执不能挂在「存盘成功」的独木桥上
assert.doesNotMatch(mainJs, /\.then\(ack\)\s*;/, "别写成只挂成功槽的 .then(ack)");

console.log("PASS: desktop tray toggle + close-button behavior (settings wired end to end, no \"app hidden forever\" combination)");
