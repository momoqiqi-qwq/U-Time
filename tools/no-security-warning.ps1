<#
  no-security-warning.ps1 —— 关掉 Windows 的「打开文件 - 安全警告」弹窗
  （正文：无法验证发布者。你确定要运行此软件吗？）

  背景
  ----
  从浏览器 / 网盘 / GitHub Release 拿到的 .exe 会被打上「网络来源」标记
  （NTFS 附加数据流 Zone.Identifier，俗称 MOTW）。双击这种文件时，Windows 的
  附件管理器会弹「打开文件 - 安全警告」。本地编译出来的 U-Time 产物本身没有这个
  标记，但只要中途经过一次下载/网盘同步就会带上，于是每次双击都弹。

  两层修法（本脚本一起做）
  ------------------------
  1) 全局策略（HKCU，不需要管理员）：把 .exe/.msi 等列入「低风险文件类型」，
     并把 Internet 区域的「启动应用程序和不安全文件」设为「启用」。
     以后任何来源的安装包双击都不再弹这个框。
  2) 就地清标记：对指定目录递归 Unblock-File，去掉已有的 Zone.Identifier。
     只删数据流，不改文件内容，SHA256 不变。

  用法
  ----
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\no-security-warning.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\no-security-warning.ps1 -UnblockPath "E:\E-Develop-Project\时间管理软件\releases"
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\no-security-warning.ps1 -Revert

  还原
  ----
  -Revert 会按备份文件把注册表改回应用前的状态（备份写在
  %LOCALAPPDATA%\UTime\zone-policy-backup.json）。
#>
[CmdletBinding()]
param(
  [switch]$Revert,
  [string[]]$UnblockPath = @()
)

$ErrorActionPreference = 'Stop'

$AssocKey  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Associations'
$AttachKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Policies\Attachments'
$Zone3Key  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings\Zones\3'
$BackupDir = Join-Path $env:LOCALAPPDATA 'UTime'
$BackupFile = Join-Path $BackupDir 'zone-policy-backup.json'

$LowRiskValue = '.exe;.msi;.msp;.bat;.cmd;.com;.ps1;.vbs;.js;.jar;.zip;.7z;.rar;.apk;.msix;.appx;.dll'

function Get-RegValue {
  param([string]$Path, [string]$Name)
  if (-not (Test-Path $Path)) { return $null }
  $item = Get-ItemProperty -Path $Path -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $item) { return $null }
  return $item.$Name
}

function Set-RegValue {
  param([string]$Path, [string]$Name, $Value, [string]$Type)
  if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
  New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType $Type -Force | Out-Null
}

if ($Revert) {
  if (-not (Test-Path $BackupFile)) {
    Write-Host "没有找到备份文件：$BackupFile —— 无事可还原。" -ForegroundColor Yellow
    exit 0
  }
  $b = Get-Content -LiteralPath $BackupFile -Raw | ConvertFrom-Json
  foreach ($rec in $b.values) {
    if ($null -eq $rec.old) {
      Remove-ItemProperty -Path $rec.path -Name $rec.name -ErrorAction SilentlyContinue
      Write-Host "  移除 $($rec.path)\$($rec.name)"
    } else {
      Set-RegValue -Path $rec.path -Name $rec.name -Value $rec.old -Type $rec.type
      Write-Host "  还原 $($rec.path)\$($rec.name) = $($rec.old)"
    }
  }
  Write-Host "已还原。重新登录或重启 explorer 后生效。" -ForegroundColor Green
  exit 0
}

# ---------- 备份当前值 ----------
$targets = @(
  @{ path = $AssocKey;  name = 'LowRiskFileTypes';    type = 'String'; new = $LowRiskValue },
  @{ path = $AttachKey; name = 'SaveZoneInformation'; type = 'DWord';  new = 1 },
  @{ path = $Zone3Key;  name = '1806';                type = 'DWord';  new = 0 }
)

if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }
# 备份只在第一次写。重复运行时若覆盖，会把「已经改过的值」当成原值，-Revert 就还原不回去了。
if (-not (Test-Path $BackupFile)) {
  $records = foreach ($t in $targets) {
    @{ path = $t.path; name = $t.name; type = $t.type; old = (Get-RegValue -Path $t.path -Name $t.name) }
  }
  (@{ appliedAt = (Get-Date).ToString('s'); values = $records } | ConvertTo-Json -Depth 5) |
    Set-Content -LiteralPath $BackupFile -Encoding UTF8
  Write-Host "已备份原值 → $BackupFile"
} else {
  Write-Host "备份已存在，保留不动 → $BackupFile"
}

# ---------- 写入策略 ----------
foreach ($t in $targets) {
  Set-RegValue -Path $t.path -Name $t.name -Value $t.new -Type $t.type
  Write-Host ("  {0}\{1} = {2}" -f $t.path, $t.name, $t.new)
}

# ---------- 就地清 MOTW ----------
if ($UnblockPath.Count -eq 0) {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  $candidate = Join-Path $repoRoot 'releases'
  if (Test-Path $candidate) { $UnblockPath = @($candidate) }
}
foreach ($p in $UnblockPath) {
  if (-not (Test-Path -LiteralPath $p)) {
    Write-Host "跳过（不存在）：$p" -ForegroundColor Yellow
    continue
  }
  $n = 0
  Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
    Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue
    $n++
  }
  $left = @(Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
    Get-Item -LiteralPath $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue
  })
  Write-Host ("Unblock：{0} 个文件，残留 MOTW {1} 个  ← {2}" -f $n, $left.Count, $p)
}

Write-Host ""
Write-Host "完成。策略对新启动的进程立即生效；若仍见到弹窗，注销重登一次即可。" -ForegroundColor Green
