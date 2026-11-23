# Run on a Windows test desktop. Launch the release build with its own data and WebView profile.
param([Parameter(Mandatory)][string]$AppPath, [string]$CaptureDirectory)
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $AppPath).Path
$profileDir = Join-Path ([IO.Path]::GetTempPath()) ('kazna-layout-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $profileDir
Add-Type -Path (Join-Path $PSScriptRoot '../e2e/WindowsWebView.cs')
if ($CaptureDirectory) {
    $null = New-Item -ItemType Directory -Path $CaptureDirectory -Force
    Add-Type -AssemblyName System.Drawing
    Add-Type -Namespace KaznaTest -Name WindowCapture -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool PrintWindow(System.IntPtr hwnd, System.IntPtr dc, uint flags);
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct ClientBounds { public int left, top, right, bottom; }
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetClientRect(System.IntPtr hwnd, out ClientBounds rect);
'@
}

function Save-ClientImage($app, [string]$phase) {
    if (!$CaptureDirectory -or $app.HasExited) { return }
    $hwnd = $app.MainWindowHandle
    $bounds = [KaznaTest.WindowCapture+ClientBounds]::new()
    if (![KaznaTest.WindowCapture]::GetClientRect($hwnd, [ref]$bounds) -or $bounds.right -le 0 -or $bounds.bottom -le 0) { return }
    $image = [Drawing.Bitmap]::new($bounds.right, $bounds.bottom)
    try {
        $graphics = [Drawing.Graphics]::FromImage($image)
        try {
            $dc = $graphics.GetHdc()
            try { $captured = [KaznaTest.WindowCapture]::PrintWindow($hwnd, $dc, 3) }
            finally { $graphics.ReleaseHdc($dc) }
        } finally { $graphics.Dispose() }
        if ($captured) { $image.Save((Join-Path $CaptureDirectory "$phase.png"), [Drawing.Imaging.ImageFormat]::Png) }
        else { Write-Warning "PrintWindow could not capture $phase. Geometry was measured separately." }
    } finally { $image.Dispose() }
}

$info = [Diagnostics.ProcessStartInfo]::new($exe)
$info.UseShellExecute = $false
$info.WorkingDirectory = Split-Path -Parent $exe
$info.EnvironmentVariables['PTREASURY_DATA_DIR'] = $profileDir
$info.EnvironmentVariables['PTREASURY_VAULT_DIR'] = Join-Path $profileDir 'vault'
$info.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER'] = Join-Path $profileDir 'webview'
$info.EnvironmentVariables.Remove('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS')
$process = [Diagnostics.Process]::Start($info)
try {
    # The Chromium child can appear after the native window, especially on a fresh runner.
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ($process.HasExited) { throw "Kazna exited during startup (code $($process.ExitCode))." }
        try {
            $initial = [WindowsWebView]::MeasureOrResize($process, 0, 0)
            break
        } catch {
            if ($deadline.Elapsed.TotalSeconds -ge 30) { throw }
            Start-Sleep -Milliseconds 250
        }
    } while ($true)
    Write-Output "Initial client and WebView aligned: $($initial[0]) x $($initial[1]) DIPs."
    Save-ClientImage $process 'initial'
    $small = [WindowsWebView]::MeasureOrResize($process, 1120, 720)
    Write-Output "Resized client and WebView aligned: $($small[0]) x $($small[1]) DIPs."
    Save-ClientImage $process 'resized'
    $restored = [WindowsWebView]::MeasureOrResize($process, $initial[0], $initial[1])
    Write-Output "Restored client and WebView aligned: $($restored[0]) x $($restored[1]) DIPs."
    Save-ClientImage $process 'restored'
} catch {
    try { Save-ClientImage $process 'failure' } catch { Write-Warning "Could not capture failure: $_" }
    throw
} finally {
    if (!$process.HasExited) {
        $null = $process.CloseMainWindow()
        if (!$process.WaitForExit(5000)) {
            $process.Kill()
            $process.WaitForExit()
        }
    }
    $process.Dispose()
}
