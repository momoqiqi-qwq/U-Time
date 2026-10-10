# v0.179.1 · 启动看门狗：窗口建不出来时不再静默卡死

## 用户报障原文

> 「为什么每次都无法双击打开？打开后界面没有显示，而且会出现这个。」
> （配图是 Windows 的「无法验证发布者。你确定要运行此软件吗？」对话框，
> 指向 `releases\v0.179.0\UTime-0.179.0-x64-portable.exe`。）

这里其实是**两件不相干的事**，一件是 Windows 的、一件是应用自己的。

### 一、「无法验证发布者」不是应用报错

那是 Windows 对**未签名 exe** 的「打开文件 - 安全警告」。实测本机产物：

```
Get-AuthenticodeSignature UTime-0.179.0-x64-portable.exe → Status = NotSigned
```

打包配置里没有代码签名证书（`tauri.conf.json` 的 `bundle.windows` 只有 nsis/wix 配置），
所以「发行商：未知发布者」必然出现；文件带着「来自 Internet」的标记时**每次运行都会问一遍**。

- 一次性消除：右键 exe → 属性 → 勾「解除锁定」（或 `Unblock-File`）；
  用 `UTime-*.x64-setup.exe` 安装一次、以后从开始菜单启动也不会再问。
- 根治：给 Windows 产物加代码签名（需要代码签名证书，跟本次代码改动无关）。

### 二、「界面没有显示 / 双击没反应」是应用自己的静默卡死 —— 这一版修的就是它

**根因（已在本机复现出来）**：

1. WebView2 环境创建被卡住时（父进程上下文受限、安全软件拦子进程、WebView2 运行时损坏），
   `Builder::build()` 里的**配置窗口创建会一直不返回** —— 进程活着、没有任何窗口，
   连 `msedgewebview2` 子进程都不会出现。实测这样一个进程的顶层窗口只剩：
   单实例插件的隐藏窗口（`com.yile.letime-siw`）、tao 的消息窗口、以及 global-shortcut 的隐藏窗口，
   **没有 `Tauri Window`**。
2. 这个「没有窗口的进程」把**单实例锁**一直占着，于是之后每次双击都被单实例插件
   直接吞掉（退出码 0，什么也不显示）—— 用户看到的就是「双击没反应、界面永远不出来」，
   而且**每次**都这样（第二次之后的启动全部是「退出码 0 的静默退出」，实测）。

## 改了什么

`src-tauri/src/lib.rs` 新增**启动看门狗**（只挂桌面 Windows，`#[cfg(all(desktop, windows))]`）：

- 在 `builder` **之前**起一个线程（必须早于 `build()`，否则抓不到「build 卡住」）：
  - **阶段一**：20 秒内没等到主窗口 → `fatal_startup_dialog()`：用 user32 的 `MessageBoxW`
    弹一句中文提示（点名 WebView2 运行时）并 `exit(1)` ——
    **把单实例锁让出来**，用户下一次双击就能正常起来。
  - **阶段二**：窗口建出来之后（`setup_tray` 里填 `WATCHDOG_APP`，且放在 `tray_enabled`
    判断**之前** —— 关掉托盘的机器一样要能被认出来）再盯 30 秒：前端始终没把窗口显示出来
    （页面 JS 没跑起来）就强行 `show()`，免得用户对着一个「什么都没有」的进程干等。
- **不引新依赖**：`MessageBoxW` 直接 `#[link(name = "user32")] unsafe extern "system"`。
  走到这一步窗口根本没建出来，Tauri 的对话框插件用不上，也不该为此加依赖。

## 验证

- `scripts/test-desktop-tray.mjs` 新增第十一节（源码断言）：看门狗必须存在且只在桌面 Windows 上、
  调用必须在 `let mut builder` 之前、`WATCHDOG_APP` 必须在 `tray_enabled` 判断之前、
  必须 `exit(1)`（不退等于锁还占着）、两个超时都要在、阶段二必须 `show()`。
  **变异测试**：把 `start_startup_watchdog()` 挪到 `builder` 之后 → 立刻红
  「🔴 看门狗必须在 builder 之前起来」，改回即绿。
- 真机对照：修复前的构建在受限上下文里启动会留下「没有窗口的进程」，此后每次启动都是退出码 0；
  清掉残留进程后连续 3 轮（干净启动 / 留 WebView2 孤儿后启动 ×2）都能正常开出窗口
  （`Tauri Window` 1606×1003、`msedgewebview2` 子进程 6 个）。

## 影响哪端

- **只有 Windows 桌面端**。Android / 小程序 / Linux 不受影响。
- **无数据迁移**：不碰任何存储字段，只在启动路径上加了一道兜底。

## 打不开时的急救（不用等新版本也能用）

```powershell
Get-Process UTime*, letime* -ErrorAction SilentlyContinue | Stop-Process -Force
```

再双击即可 —— 卡住的那个「没有窗口的进程」被清掉，单实例锁就放出来了。
