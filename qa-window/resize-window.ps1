param([Parameter(Mandatory=$true)][int]$TargetProcess)
$ErrorActionPreference = 'Stop'
$proc = Get-Process -Id $TargetProcess -ErrorAction Stop
if ($proc.ProcessName -ne 'Kazna' -or $proc.MainWindowHandle -eq [IntPtr]::Zero) {throw 'Test Kazna window unavailable'}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KaznaQaResize {
    [StructLayout(LayoutKind.Sequential)] public struct Rect {public int left,top,right,bottom;}
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window,out Rect rect);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out Rect rect);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int w, int h, uint flags);
}
'@
[void][KaznaQaResize]::SetThreadDpiAwarenessContext([IntPtr](-4))
$hwnd = $proc.MainWindowHandle
$scale = [KaznaQaResize]::GetDpiForWindow($hwnd) / 96.0
$outer = New-Object KaznaQaResize+Rect
$client = New-Object KaznaQaResize+Rect
if (-not [KaznaQaResize]::GetWindowRect($hwnd, [ref]$outer) -or -not [KaznaQaResize]::GetClientRect($hwnd,[ref]$client)) {throw 'Window dimensions unavailable'}
$width = [int][Math]::Ceiling(1024 * $scale) + $outer.right - $outer.left - $client.right
$height = [int][Math]::Ceiling(704 * $scale) + $outer.bottom - $outer.top - $client.bottom
if (-not [KaznaQaResize]::SetWindowPos($hwnd,[IntPtr]::Zero,0,0,$width,$height,22)) {throw 'Resize failed'}
