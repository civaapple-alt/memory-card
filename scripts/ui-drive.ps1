<#
  给 memory-card 窗口发点击 / 按键，用来在没有人手的情况下跑一遍真实流程。

  安全设计：每次发送前都断言"目标窗口就是当前前台窗口"。条件不满足就直接抛错退出，
  绝不盲发 —— 否则按键会落到用户正在用的编辑器里，那是最糟糕的失败方式。

  用法:
    pwsh -File scripts/ui-drive.ps1 -ProcessName memory-card -ClickAt "200,213"
    pwsh -File scripts/ui-drive.ps1 -ProcessName memory-card -Keys "handle"
    pwsh -File scripts/ui-drive.ps1 -ProcessName memory-card -Keys "^{ENTER}" -Wait 6000 -Out .shot.png
    坐标是相对窗口矩形左上角的（和截图坐标系一致）。
#>
param(
  [Parameter(Mandatory = $true)][string]$ProcessName,
  [string]$Keys = '',
  [string]$Paste = '',
  [string]$ClickAt = '',
  [int]$Wheel = 0,
  [int]$Wait = 600,
  [string]$Out = ''
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing, System.Windows.Forms

if (-not ('MC.Win' -as [type])) {
  Add-Type -Namespace MC -Name Win -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
'@
}

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { throw "找不到带窗口的进程 $ProcessName" }

$h = $proc.MainWindowHandle
[void][MC.Win]::ShowWindow($h, 5)
[void][MC.Win]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 500

$fg = [MC.Win]::GetForegroundWindow()
if ($fg -ne $h) {
  throw "目标窗口不是前台窗口（前台 hwnd=$fg，目标 hwnd=$h）。已放弃发按键，没有污染任何窗口。"
}

$r = New-Object MC.Win+RECT
[void][MC.Win]::GetWindowRect($h, [ref]$r)

if ($ClickAt) {
  $parts = $ClickAt.Split(',')
  $x = $r.Left + [int]$parts[0]
  $y = $r.Top + [int]$parts[1]
  [void][MC.Win]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 150
  [MC.Win]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  [MC.Win]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  "clicked window-relative $ClickAt  ->  screen $x,$y"
}

if ($Keys) {
  if ([MC.Win]::GetForegroundWindow() -ne $h) { throw "窗口在发按键前失去前台，放弃" }
  [System.Windows.Forms.SendKeys]::SendWait($Keys)
  "sent keys: $Keys"
}

if ($Paste) {
  # 走剪贴板而不是 SendKeys：中文输入法会把逐字键入的英文当成拼音缓冲吃掉。
  Set-Clipboard -Value $Paste
  Start-Sleep -Milliseconds 250
  if ([MC.Win]::GetForegroundWindow() -ne $h) { throw "窗口在粘贴前失去前台，放弃" }
  [System.Windows.Forms.SendKeys]::SendWait('^{v}')
  "pasted $($Paste.Length) chars"
}

if ($Wheel -ne 0) {
  # 负数 = 向下滚。0x0800 = MOUSEEVENTF_WHEEL
  # 低 16 位是带符号的滚动量，所以要先包成 DWORD 再传。
  $dw = [uint32]([int]$Wheel -band 0xFFFF)
  [MC.Win]::mouse_event(0x0800, 0, 0, $dw, [IntPtr]::Zero)
  "wheel $Wheel"
}

Start-Sleep -Milliseconds $Wait

if ($Out) {
  $w = $r.Right - $r.Left
  $hgt = $r.Bottom - $r.Top
  $bmp = New-Object System.Drawing.Bitmap $w, $hgt
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $hgt))
  $g.Dispose()
  $full = [System.IO.Path]::GetFullPath($Out)
  $bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  "saved $full (${w}x${hgt})"
}
