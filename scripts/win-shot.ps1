<#
  截窗口的公共实现，给 shot-window.ps1 / ui-drive.ps1 dot-source 用（不单独执行）。

  为什么不能用 GetWindowRect + CopyFromScreen：
  本机屏幕是 150% 缩放，而 pwsh 是 DPI-unaware 进程 —— GetWindowRect 返回的是**被虚拟化过的**
  坐标（664×977 物理的窗口报成 455×657），拿它去 CopyFromScreen 就会截偏、截少一块。
  DpiAwareness 不是这个脚本该改的全局状态，所以改用两个不吃虚拟化的调用：
    1. DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS=9) —— 实测给物理像素（含边框，不含阴影）
    2. PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT=2) —— 让窗口自己画到 DC 上。
       flag 必须带 2：不带的话 WebView2 的内容画不出来，截出来是空白。
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not ('MC.Shot' -as [type])) {
  Add-Type -Namespace MC -Name Shot -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
[DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT r, int cb);
'@
}

function Get-WindowShotRect([IntPtr]$Hwnd) {
  $DWMWA_EXTENDED_FRAME_BOUNDS = 9
  $r = New-Object MC.Shot+RECT
  $usedDwm = $false
  $hr = [MC.Shot]::DwmGetWindowAttribute($Hwnd, $DWMWA_EXTENDED_FRAME_BOUNDS, [ref]$r, 16)
  if ($hr -eq 0 -and ($r.Right - $r.Left) -gt 0 -and ($r.Bottom - $r.Top) -gt 0) {
    $usedDwm = $true
  } else {
    [void][MC.Shot]::GetWindowRect($Hwnd, [ref]$r)
  }
  $dpi = [int][MC.Shot]::GetDpiForWindow($Hwnd)
  if ($dpi -le 0) { $dpi = 96 }
  $w = $r.Right - $r.Left
  $h = $r.Bottom - $r.Top
  [pscustomobject]@{
    Hwnd     = $Hwnd
    Left     = $r.Left
    Top      = $r.Top
    Width    = $w
    Height   = $h
    Dpi      = $dpi
    Scale    = $dpi / 96.0
    Logical  = "{0}x{1}" -f [int][math]::Round($w * 96.0 / $dpi), [int][math]::Round($h * 96.0 / $dpi)
    UsedDwm  = $usedDwm
  }
}

# 把窗口画进 PNG。返回说明字符串（调用方直接打印）。
function Save-WindowShot([IntPtr]$Hwnd, [string]$Path) {
  # 最小化的窗口 PrintWindow 只会画出一张废图。这里不替调用方恢复窗口（那会抢焦点），直接报错。
  if ([MC.Shot]::IsIconic($Hwnd)) { throw "窗口已最小化，先恢复再截（脚本不替你动窗口）" }

  $i = Get-WindowShotRect $Hwnd
  if ($i.Width -le 0 -or $i.Height -le 0) { throw "窗口尺寸异常 $($i.Width)x$($i.Height)" }

  $bmp = New-Object System.Drawing.Bitmap $i.Width, $i.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc()
  $PW_RENDERFULLCONTENT = 2
  $painted = [MC.Shot]::PrintWindow($Hwnd, $dc, $PW_RENDERFULLCONTENT)
  $g.ReleaseHdc($dc)
  if (-not $painted) {
    # PrintWindow 失败才退回落屏截图；注意这个分支在 DPI-unaware 进程里坐标是虚拟化的，可能偏。
    $g.CopyFromScreen($i.Left, $i.Top, 0, 0, (New-Object System.Drawing.Size $i.Width, $i.Height))
  }
  $g.Dispose()

  $full = [System.IO.Path]::GetFullPath($Path)
  $bmp.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)

  # 抽样统计颜色数：整张一个颜色 = 没画出来（白窗 / 全黑）。这种事不能静默通过。
  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  for ($y = 0; $y -lt $i.Height; $y += 8) {
    for ($x = 0; $x -lt $i.Width; $x += 8) { [void]$seen.Add($bmp.GetPixel($x, $y).ToArgb()) }
  }
  $bmp.Dispose()

  $how = if ($painted) { 'printwindow' } else { 'copyfromscreen(降级)' }
  $rect = if ($i.UsedDwm) { 'dwm-frame' } else { 'windowrect(降级)' }
  "saved $full  ($($i.Width)x$($i.Height) 物理 / $($i.Logical) 逻辑 / $($i.Dpi)dpi)  $how  $rect"
  "sampled colors: $($seen.Count)$(if ($seen.Count -le 1) { '  <-- 警告：整张图一个颜色，很可能没画出来' } else { '' })"
}
