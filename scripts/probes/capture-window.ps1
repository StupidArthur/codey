param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$ProcessName = 'Temporal Workspace',
  [int]$Mode = 2
)
# Capture the Temporal Workspace window into a bitmap. Mode 2 uses PrintWindow
# with PW_RENDERFULLCONTENT, which is z-order independent; Mode 1 restores and
# foregrounds the window and copies the screen. Prints the method used.
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Error "window not found for process: $ProcessName"; exit 2 }
$handle = $proc.MainWindowHandle
[WinCap]::ShowWindow($handle, 9) | Out-Null
Start-Sleep -Milliseconds 400
$rect = New-Object WinCap+RECT
[WinCap]::GetWindowRect($handle, [ref]$rect) | Out-Null
$width = [Math]::Max($rect.Right - $rect.Left, 1)
$height = [Math]::Max($rect.Bottom - $rect.Top, 1)
$bitmap = New-Object System.Drawing.Bitmap $width, $height
if ($Mode -eq 2) {
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  $ok = [WinCap]::PrintWindow($handle, $hdc, 2)
  $graphics.ReleaseHdc($hdc)
  $graphics.Dispose()
  if (-not $ok) { Write-Error 'PrintWindow failed'; exit 3 }
} else {
  [WinCap]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 900
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
  $graphics.Dispose()
}
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Write-Output "ok mode=$Mode ${width}x${height}"
