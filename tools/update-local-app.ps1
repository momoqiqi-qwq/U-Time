#Requires -Version 5.1
<#
.SYNOPSIS
    把刚构建好的 Windows 便携版换到本机「固定运行路径」。
    铁律十一的落地脚本：每次构建完 exe 就跑一次，不等发版。

.DESCRIPTION
    做的事，按顺序：
      1. 定位源：releases\UTime-portable.exe（固定名；版本默认取 package.json）
      2. 读源文件版本资源，必须等于目标版本 —— 防止把旧产物 / 半截产物放到运行路径
      3. 目标已是最新（SHA256 相同）→ 直接跳过，幂等
      4. 目标正在运行 → 先 CloseMainWindow，等不到再 Stop-Process（否则 Copy-Item 撞文件锁）
      5. 备份旧文件 → 覆盖 → Unblock-File（清 MOTW，双击不再弹「无法验证发布者」）
      6. 校验 SHA256 与版本资源；不一致立即从备份回滚，绝不留一个坏 exe 在运行路径
      7. -Restart 时拉起新版

.PARAMETER Version
    目标版本，默认读 le-time-management/package.json 的 version。

.PARAMETER Source
    源便携版路径，默认 releases\UTime-portable.exe（构建脚本固定写到那里）。
    只有单独跑 build-windows.sh、产物还在 target 目录时才显式传。

.PARAMETER Target
    固定运行路径。默认 E:\E-Apps\Time Manger\U-Time\UTime.exe ——
    任务栏 pin 指向的就是它，不要改。

.PARAMETER Restart
    覆盖完成后拉起新版。

.PARAMETER DryRun
    只报告将做什么，不关进程、不写文件。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/update-local-app.ps1 -Restart

.NOTES
    ⚠️ 本文件必须保存为 UTF-8 with BOM。write/edit 工具会剥掉 BOM，
       PowerShell 5.1 会按 GBK 解码这些中文注释并直接语法报错。
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Source,
    [string]$Target = 'E:\E-Apps\Time Manger\U-Time\UTime.exe',
    [switch]$Restart,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Fail([string]$msg, [int]$code = 2) {
    Write-Host "✗ $msg" -ForegroundColor Red
    exit $code
}

function Get-ExeVersion([string]$path) {
    try { return (Get-Item -LiteralPath $path).VersionInfo.ProductVersion } catch { return $null }
}

function Get-Sha256([string]$path) {
    return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
}

# ---------- 1. 解析版本与源 ----------
if (-not $Version) {
    $pkg = Join-Path $repoRoot 'le-time-management\package.json'
    if (-not (Test-Path -LiteralPath $pkg)) { Fail "找不到 $pkg，无法推导版本" }
    $Version = (Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json).version
}
if (-not $Version) { Fail '版本号为空' }

if (-not $Source) {
    $Source = Join-Path $repoRoot 'releases\UTime-portable.exe'
}
if (-not (Test-Path -LiteralPath $Source)) {
    Fail ("没有找到便携版：{0}`n  先构建：bash tools/build-and-archive.sh {1}" -f $Source, $Version)
}
if (-not (Test-Path -LiteralPath (Split-Path -Parent $Target))) {
    Fail ("运行目录不存在：{0}`n  目标路径由任务栏 pin 决定，不要另建一个" -f (Split-Path -Parent $Target))
}

$srcVer = Get-ExeVersion $Source
if ($srcVer -ne $Version) {
    Fail ("源文件版本是 v$srcVer，与目标 v$Version 不符 —— 拒绝覆盖（多半是拿错了产物目录）")
}

$srcHash = Get-Sha256 $Source
$oldVer = if (Test-Path -LiteralPath $Target) { Get-ExeVersion $Target } else { '无' }
if (-not $oldVer) { $oldVer = 'unknown' }   # 读不到版本资源（半截文件 / 非 Tauri 产物）时，别让备份名退化成 "bak-v"

Write-Host ("运行版：{0}  →  待更新：v{1}" -f $(if ($oldVer) { "v$oldVer" } else { '（尚无）' }), $Version)

# ---------- 2. 幂等：已经是最新 ----------
if ($oldVer -eq $Version -and (Test-Path -LiteralPath $Target) -and (Get-Sha256 $Target) -eq $srcHash) {
    Write-Host "✓ 已是最新 v$Version（SHA256 一致），无需覆盖" -ForegroundColor Green
    if ($Restart -and -not $DryRun) {
        $running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Target }
        if (-not $running) { Start-Process -FilePath $Target; Write-Host "  已拉起运行版" }
    }
    exit 0
}

if ($DryRun) {
    Write-Host "（DryRun）将执行："
    Write-Host "  关闭进程：$Target 的所有实例"
    Write-Host "  备份到：  $Target.bak-v$oldVer"
    Write-Host "  覆盖为：  $Source"
    Write-Host "  校验：    SHA256 + ProductVersion == $Version"
    if ($Restart) { Write-Host "  然后拉起新版" }
    exit 0
}

# ---------- 3. 先关掉正在跑的实例（文件锁）----------
$procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -eq $Target -or $_.ProcessName -eq ([IO.Path]::GetFileNameWithoutExtension($Target))
    })
foreach ($p in $procs) {
    Write-Host ("  关闭进程 {0} (PID {1})" -f $p.ProcessName, $p.Id)
    try {
        [void]$p.CloseMainWindow()
        if (-not $p.WaitForExit(3000)) { Stop-Process -Id $p.Id -Force; [void]$p.WaitForExit(3000) }
    } catch {
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
}
if ($procs.Count -gt 0) { Start-Sleep -Milliseconds 400 }

# ---------- 4. 备份 + 覆盖 ----------
$backup = "$Target.bak-v$oldVer"
try {
    if (Test-Path -LiteralPath $Target) {
        Copy-Item -LiteralPath $Target -Destination $backup -Force
        Write-Host "  已备份旧版：$backup"
    }
    Copy-Item -LiteralPath $Source -Destination $Target -Force
} catch {
    Fail ("覆盖失败：{0}`n  常见原因：应用没退干净（任务管理器里还有 UTime.exe），或目录被占用" -f $_.Exception.Message)
}

Unblock-File -LiteralPath $Target -ErrorAction SilentlyContinue

# ---------- 5. 校验，不符就回滚 ----------
$newHash = Get-Sha256 $Target
$newVer = Get-ExeVersion $Target
if ($newHash -ne $srcHash -or $newVer -ne $Version) {
    if (Test-Path -LiteralPath $backup) {
        Copy-Item -LiteralPath $backup -Destination $Target -Force
        Fail ("校验失败（hash {0} / 版本 v{1}），已回滚到 v{2}" -f `
                $(if ($newHash -eq $srcHash) { 'OK' } else { 'MISMATCH' }), $newVer, $oldVer)
    }
    Fail ("校验失败（hash {0} / 版本 v{1}），且没有备份可回滚" -f `
            $(if ($newHash -eq $srcHash) { 'OK' } else { 'MISMATCH' }), $newVer)
}

Write-Host ("✓ 运行版已更新：v{0} → v{1}  （SHA256 {2}…）" -f $oldVer, $Version, $newHash.Substring(0, 12)) -ForegroundColor Green
Write-Host "  下一步（发版收尾）：tools/pin-taskbar.ps1 钉任务栏，见 AGENTS.md 铁律九"

if ($Restart) {
    Start-Process -FilePath $Target
    Write-Host "  已拉起新版"
}
