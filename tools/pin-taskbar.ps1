#Requires -Version 5.1
<#
.SYNOPSIS
  纯键盘把应用固定到 Windows 11 任务栏 / 取消固定（不移动鼠标、不弹开始菜单）。

.DESCRIPTION
  Win11 没有可用的代码接口来固定任务栏，三条“纯代码”路线实测全部不通：
    * 往 %APPDATA%\...\User Pinned\TaskBar 放 .lnk —— 只成为候选，不产生任务栏按钮；
    * 改 HKCU\...\Explorer\Taskband\Favorites —— 是未公开的 shell 序列化 BLOB
      （lnk 名 + 目标路径 + AUMID + PIDL 二进制），构造极易打坏既有固定项；
    * 调 Shell verb —— Win11 已移除标准「固定到任务栏」verb（只剩第三方注入的扩展）。

  所以本脚本走**键盘**而不是鼠标：
      1. Win+T            → 焦点交给任务栏（前台变 Shell_TrayWnd）
      2. UIA RawViewWalker → 从当前焦点元素的父节点遍历兄弟，按名字找到目标按钮
      3. SetFocus()        → 精确把焦点移到该按钮（不用方向键盲走）
      4. 应用菜单键(VK_APPS 0x5D) → 弹出该应用的**跳转列表**
      5. 按 AutomationId 精确命中：
             TaskbarPin    = 固定到任务栏
             TaskbarUnpin  = 从任务栏取消固定
         用 ID 而不是中文名，天然免疫系统语言与编码差异。
      6. InvokePattern.Invoke()

  全程**不移动光标、不点击鼠标、不打开开始菜单**，结束后焦点状态由系统自行归还。

.PARAMETER AppName
  任务栏按钮名里要匹配的子串（任务栏按钮名 = 窗口标题/应用名 + 状态后缀），例如 U-Time。

.PARAMETER AppPath
  可选。任务栏上还没有它的按钮时（应用没在运行），用这个路径启动它再固定。
  便携版场景直接给 exe 路径即可。

.PARAMETER Action
  Pin（默认）或 Unpin。**幂等**：已经固定时再 Pin 只会报告“已固定”，不会误取消。

.PARAMETER DryRun
  只探测并打印将要执行的动作，不调用 Invoke。

.PARAMETER LaunchTimeoutSec
  -AppPath 启动后等待任务栏按钮出现的秒数，默认 30。

.EXAMPLE
  # 固定（应用已在运行）
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/pin-taskbar.ps1 -AppName 'U-Time'

.EXAMPLE
  # 应用没在跑：让它自己启动便携版再固定（发布流程用这个）
  powershell -NoProfile -ExecutionPolicy Bypass -File tools/pin-taskbar.ps1 `
      -AppName 'U-Time' -AppPath 'E:\E-Apps\Time Manger\U-Time\UTime.exe'

.NOTES
  * 需要 Windows 11 + 交互式桌面会话。
  * 会短暂接管键盘焦点（约 3-6 秒），但**不动鼠标**。
  * 本文件必须保存为 UTF-8 with BOM，否则 PowerShell 5.1 按 GBK 解码中文会乱码。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$AppName,

    [string]$AppPath,

    [ValidateSet('Pin', 'Unpin')]
    [string]$Action = 'Pin',

    [switch]$DryRun,

    [int]$LaunchTimeoutSec = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
if (-not ('TaskbarKeyNative' -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public class TaskbarKeyNative {
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
    public const uint KEYUP = 0x0002;
    public const byte VK_ESC = 0x1B, VK_TAB = 0x09, VK_RETURN = 0x0D;
    public const byte VK_LWIN = 0x5B, VK_T = 0x54, VK_APPS = 0x5D;
    public const byte VK_UP = 0x26, VK_DOWN = 0x28;
}
"@
}
[void][TaskbarKeyNative]::SetThreadDpiAwarenessContext([IntPtr](-4))

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$TASKBAR_BUTTON_CLASS = 'Taskbar.TaskListButtonAutomationPeer'
$JUMPLIST_MARKER = '跳转列表'

function Invoke-VirtualKey {
    param([byte]$VirtualKey, [int]$SettleMs = 90)
    [TaskbarKeyNative]::keybd_event($VirtualKey, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [TaskbarKeyNative]::keybd_event($VirtualKey, 0, [TaskbarKeyNative]::KEYUP, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds $SettleMs
}

function Get-Props {
    param($Element)
    if (-not $Element) { return '(none)' }
    return ("name=[{0}] class=[{1}] id=[{2}] type={3}" -f $Element.Current.Name,
        $Element.Current.ClassName, $Element.Current.AutomationId,
        $Element.Current.ControlType.ProgrammaticName)
}

# Win+T 把焦点交给任务栏；返回该按钮节点的父节点（任务栏按钮容器的兄弟链起点）。
function Enter-Taskbar {
    param([int]$Attempts = 3)

    for ($i = 1; $i -le $Attempts; $i++) {
        Invoke-VirtualKey ([TaskbarKeyNative]::VK_ESC) 400
        [TaskbarKeyNative]::keybd_event([TaskbarKeyNative]::VK_LWIN, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 80
        Invoke-VirtualKey ([TaskbarKeyNative]::VK_T) 0
        [TaskbarKeyNative]::keybd_event([TaskbarKeyNative]::VK_LWIN, 0, [TaskbarKeyNative]::KEYUP, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 1300

        $focused = $AE::FocusedElement
        if ($focused -and $focused.Current.ClassName -eq $TASKBAR_BUTTON_CLASS) {
            $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
            $parent = $walker.GetParent($focused)
            if ($parent) { return $parent }
        }
        Write-Warning "第 $i 次 Win+T 未把焦点交给任务栏（当前焦点 $($focused.Current.ClassName)），重试…"
    }
    throw 'Win+T 没能聚焦任务栏。请确认当前是交互式桌面会话，且没有全屏程序独占键盘焦点。'
}

# 遍历任务栏按钮容器里的兄弟节点，返回全部 TaskListButton（含视觉顺序）
function Get-TaskbarButton {
    param($Container)
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $list = New-Object System.Collections.ArrayList
    $i = 0
    $child = $walker.GetFirstChild($Container)
    while ($child) {
        $i++
        if ($child.Current.ClassName -eq $TASKBAR_BUTTON_CLASS) {
            [void]$list.Add([pscustomobject]@{ Order = $i; Element = $child; Name = $child.Current.Name })
        }
        $child = $walker.GetNextSibling($child)
    }
    return , $list
}

# 弹出跳转列表并返回其中的可交互项
function Get-JumpListItem {
    param($ButtonElement, [int]$TimeoutMs = 4000)

    $ButtonElement.SetFocus()
    Start-Sleep -Milliseconds 600
    Invoke-VirtualKey ([TaskbarKeyNative]::VK_APPS) 1600

    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    $jump = $null
    while ((Get-Date) -lt $deadline) {
        $fg = $AE::FromHandle([TaskbarKeyNative]::GetForegroundWindow())
        if ($fg -and $fg.Current.Name -like "*$JUMPLIST_MARKER*") { $jump = $fg; break }
        Start-Sleep -Milliseconds 200
    }
    if (-not $jump) {
        throw "没弹出跳转列表（前台：$(Get-Props $AE::FromHandle([TaskbarKeyNative]::GetForegroundWindow())))"
    }

    $items = New-Object System.Collections.ArrayList
    foreach ($type in @([System.Windows.Automation.ControlType]::MenuItem,
            [System.Windows.Automation.ControlType]::ListItem)) {
        $found = $jump.FindAll($TS::Descendants,
            (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $type)))
        foreach ($e in $found) { [void]$items.Add($e) }
    }
    return , $items
}

function Find-TargetButton {
    param([string]$Name)
    $container = Enter-Taskbar
    $buttons = Get-TaskbarButton -Container $container
    return @($buttons | Where-Object { $_.Name -like "*$Name*" } | Select-Object -First 1)
}

try {
    if ($Action -eq 'Unpin') { Invoke-VirtualKey ([TaskbarKeyNative]::VK_ESC) 300 }

    # ── 1. 找任务栏上的按钮 ──────────────────────────────────────────────
    $target = Find-TargetButton -Name $AppName

    if (-not $target -and $AppPath) {
        Write-Host "任务栏上没有「$AppName」，启动 $AppPath …"
        Start-Process -FilePath $AppPath | Out-Null
        $deadline = (Get-Date).AddSeconds($LaunchTimeoutSec)
        while ((Get-Date) -lt $deadline -and -not $target) {
            Start-Sleep -Seconds 2
            $target = Find-TargetButton -Name $AppName
        }
    }
    if (-not $target) {
        throw "任务栏上找不到含「$AppName」的按钮。应用必须先运行（或传 -AppPath 让脚本启动它）。"
    }
    Write-Host ("任务栏按钮：{0}" -f $target.Name)

    # ── 2. 弹跳转列表，用 AutomationId 判定当前状态 ─────────────────────
    $items = Get-JumpListItem -ButtonElement $target.Element
    $pinItem = @($items | Where-Object { $_.Current.AutomationId -eq 'TaskbarPin' } | Select-Object -First 1)
    $unpinItem = @($items | Where-Object { $_.Current.AutomationId -eq 'TaskbarUnpin' } | Select-Object -First 1)

    if ($Action -eq 'Pin' -and -not $pinItem -and $unpinItem) {
        Write-Host '✓ 已经是「固定到任务栏」状态，无需操作。'
        Invoke-VirtualKey ([TaskbarKeyNative]::VK_ESC) 200
        return
    }
    if ($Action -eq 'Unpin' -and -not $unpinItem -and $pinItem) {
        Write-Host '✓ 当前未固定到任务栏，无需操作。'
        Invoke-VirtualKey ([TaskbarKeyNative]::VK_ESC) 200
        return
    }

    $todo = if ($Action -eq 'Pin') { $pinItem } else { $unpinItem }
    if (-not $todo) {
        $names = ($items | ForEach-Object { $_.Current.Name }) -join ' / '
        throw "跳转列表里没有 $Action 对应项（现有：$names）"
    }
    Write-Host ("将执行：{0}" -f $todo.Current.Name)

    if ($DryRun) {
        Write-Host '(DryRun：不执行，按 Esc 关闭跳转列表)'
        Invoke-VirtualKey ([TaskbarKeyNative]::VK_ESC) 200
        return
    }

    # ── 3. 执行 ─────────────────────────────────────────────────────────
    $done = $false
    try {
        $todo.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $done = $true
    } catch {
        Write-Warning "InvokePattern 不可用（$($_.Exception.Message)），改用方向键 + Enter。"
    }
    if (-not $done) {
        $all = $items.ToArray()
        $cur = $AE::FocusedElement
        $idx = [array]::IndexOf($all, $todo)
        $curIdx = [array]::IndexOf($all, $cur)
        if ($curIdx -ge 0 -and $idx -ge 0) {
            $key = if ($idx -ge $curIdx) { [TaskbarKeyNative]::VK_DOWN } else { [TaskbarKeyNative]::VK_UP }
            for ($k = 0; $k -lt [math]::Abs($idx - $curIdx); $k++) { Invoke-VirtualKey $key 150 }
            Invoke-VirtualKey ([TaskbarKeyNative]::VK_RETURN) 400
        }
    }
    Start-Sleep -Milliseconds 2500

    # ── 4. 复验：重新进任务栏，确认按钮名状态 ───────────────────────────
    $after = Find-TargetButton -Name $AppName
    if ($after) {
        Write-Host ("已执行。任务栏按钮现在的名字：{0}" -f $after.Name)
        if ($after.Name -like '*已固定*') { Write-Host '✓ 已是固定状态。' }
    } else {
        Write-Warning "复验时任务栏上找不到「$AppName」按钮。"
    }
} finally {
    # 交回焦点：轻按 Esc 关掉可能还开着的跳转列表
    Invoke-VirtualKey ([TaskbarKeyNative]::VK_ESC) 200
}
