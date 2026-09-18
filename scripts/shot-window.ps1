<#
  只截某个进程的顶层窗口，不截整个屏幕（避免把用户的桌面内容拍进去）。
  用法: pwsh -File scripts/shot-window.ps1 -ProcessName memory-card -Out .shot.png
#>
param(
  [Parameter(Mandatory = $true)][string]$ProcessName,
  [string]$Out = '.shot.png'
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

if (-not ('MC.Win' -as [type])) {
  Add-Type -Namespace MC -Name Win -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@
}

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1

if (-not $proc) { throw "找不到带窗口的进程 $ProcessName" }

$h = $proc.MainWindowHandle
[void][MC.Win]::ShowWindow($h, 5)
[void][MC.Win]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 700

$r = New-Object MC.Win+RECT
[void][MC.Win]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$hgt = $r.Bottom - $r.Top
if ($w -le 0 -or $hgt -le 0) { throw "窗口尺寸异常 ${w}x${hgt}" }

$bmp = New-Object System.Drawing.Bitmap $w, $hgt
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $hgt))
$g.Dispose()

$full = [System.IO.Path]::GetFullPath($Out)
$bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

"saved $full  (${w}x${hgt}) pid=$($proc.Id)"
