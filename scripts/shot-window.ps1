<#
  只截某个进程的顶层窗口，不截整个屏幕（避免把用户的桌面内容拍进去）。
  用法: pwsh -File scripts/shot-window.ps1 -ProcessName memory-card -Out .shot.png
  抓图本身在 win-shot.ps1 里（那里写了为什么不能用 CopyFromScreen）。
#>
param(
  [Parameter(Mandatory = $true)][string]$ProcessName,
  [string]$Out = '.shot.png'
)
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'win-shot.ps1')

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1

if (-not $proc) { throw "找不到带窗口的进程 $ProcessName" }

$h = $proc.MainWindowHandle
Start-Sleep -Milliseconds 300

"pid=$($proc.Id)"
Save-WindowShot $h $Out
