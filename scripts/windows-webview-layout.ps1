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

function Test-OnboardingFrame([Drawing.Bitmap]$image) {
    # The fresh profile shows a centered card on a solid background in both themes.
    # A blank frame has no card. A displaced WebView exposes a different background at one edge.
    $background = $image.GetPixel(12, 12).ToArgb()
    foreach ($x in @(12, ($image.Width - 13))) {
        foreach ($y in @(12, ($image.Height - 13))) {
            if ($image.GetPixel($x, $y).ToArgb() -ne $background) { return $false }
        }
    }
    $colors = [Collections.Generic.HashSet[int]]::new()
    for ($y = 12; $y -lt $image.Height; $y += 9) {
        for ($x = 12; $x -lt $image.Width; $x += 9) {
            $null = $colors.Add($image.GetPixel($x, $y).ToArgb())
            if ($colors.Count -ge 8) { return $true }
        }
    }
    return $false
}

function Save-ClientImage($app, [string]$phase) {
    if (!$CaptureDirectory) { return }
    if ($app.HasExited) { throw "Kazna closed before capturing $phase." }
    $hwnd = [WindowsWebView]::GetMainWindow($app, $false)
    $bounds = [KaznaTest.WindowCapture+ClientBounds]::new()
    if (![KaznaTest.WindowCapture]::GetClientRect($hwnd, [ref]$bounds) -or $bounds.right -le 25 -or $bounds.bottom -le 25) {
        throw "Cannot capture client bounds for $phase."
    }
    $image = [Drawing.Bitmap]::new($bounds.right, $bounds.bottom)
    try {
        $timer = [Diagnostics.Stopwatch]::StartNew()
        do {
            $graphics = [Drawing.Graphics]::FromImage($image)
            try {
                $dc = $graphics.GetHdc()
                try { $captured = [KaznaTest.WindowCapture]::PrintWindow($hwnd, $dc, 3) }
                finally { $graphics.ReleaseHdc($dc) }
            } finally { $graphics.Dispose() }
            if ($captured -and ($phase -eq 'failure' -or (Test-OnboardingFrame $image))) {
                $image.Save((Join-Path $CaptureDirectory "$phase.png"), [Drawing.Imaging.ImageFormat]::Png)
                return
            }
            if ($phase -eq 'failure') { return }
            Start-Sleep -Milliseconds 200
        } while ($timer.Elapsed.TotalSeconds -lt 15)
        throw "No painted first-run screen with matching client edges at $phase."
    } finally { $image.Dispose() }
}

function Write-WebViewDiagnostics($app) {
    $clientKey = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $registered = foreach ($root in 'HKLM:\SOFTWARE\WOW6432Node', 'HKLM:\SOFTWARE', 'HKCU:\SOFTWARE') {
        Get-ItemPropertyValue -LiteralPath "$root\$clientKey" -Name pv -ErrorAction SilentlyContinue
    }
    if (!$registered) { $registered = 'unknown' }
    Write-Warning "Registered WebView2 version(s): $($registered -join ', ')."
    $tree = @{}
    foreach ($proc in (Get-CimInstance Win32_Process -Property Name,ProcessId,ParentProcessId,CreationDate)) {
        $tree[[int]$proc.ProcessId] = $proc
    }
    $children = foreach ($edge in $tree.Values) {
        if ($edge.Name -ne 'msedgewebview2.exe') { continue }
        $node = $edge
        while ($parent = $tree[[int]$node.ParentProcessId]) {
            if ($parent.ProcessId -eq $node.ProcessId -or $parent.CreationDate -gt $node.CreationDate) { break }
            if ($parent.ProcessId -eq $app.Id) {
                $version = (Get-Process -Id $edge.ProcessId -ErrorAction SilentlyContinue).ProductVersion
                if (!$version) { $version = 'unknown' }
                "PID $($edge.ProcessId) (version $version)"
                break
            }
            $node = $parent
        }
    }
    if (!$children) { $children = 'none' }
    Write-Warning "Live msedgewebview2 descendants: $($children -join ', ')."
}

$info = [Diagnostics.ProcessStartInfo]::new($exe)
$info.UseShellExecute = $false
$info.WorkingDirectory = Split-Path -Parent $exe
$info.EnvironmentVariables['PTREASURY_DATA_DIR'] = $profileDir
$info.EnvironmentVariables['PTREASURY_VAULT_DIR'] = Join-Path $profileDir 'vault'
$info.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER'] = Join-Path $profileDir 'webview'
$info.EnvironmentVariables.Remove('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS')
$process = [Diagnostics.Process]::Start($info)
$stage = 'initial geometry'
$layoutFailed = $false
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
    $stage = 'initial image'
    Save-ClientImage $process 'initial'
    $stage = 'resized geometry'
    $small = [WindowsWebView]::MeasureOrResize($process, 1120, 720)
    Write-Output "Resized client and WebView aligned: $($small[0]) x $($small[1]) DIPs."
    $stage = 'resized image'
    Save-ClientImage $process 'resized'
    $stage = 'restored geometry'
    $restored = [WindowsWebView]::MeasureOrResize($process, $initial[0], $initial[1])
    Write-Output "Restored client and WebView aligned: $($restored[0]) x $($restored[1]) DIPs."
    $stage = 'restored image'
    Save-ClientImage $process 'restored'
} catch {
    $layoutFailed = $true
    Write-Warning "Failed at $stage after $($deadline.ElapsedMilliseconds) ms (Kazna PID $($process.Id))."
    try { Write-WebViewDiagnostics $process } catch { Write-Warning 'WebView2 diagnostics unavailable.' }
    try { Save-ClientImage $process 'failure' } catch { Write-Warning "Could not capture failure: $_" }
    throw
} finally {
    try {
        if (!$process.HasExited) {
            try { [WindowsWebView]::CloseMain($process) } catch { Write-Warning "Could not close the main window: $_" }
            if (!$process.WaitForExit(5000)) {
                $process.Kill()
                $process.WaitForExit()
            }
        }
    } catch {
        if (!$layoutFailed) { throw }
        Write-Warning "Could not stop Kazna PID $($process.Id): $_"
    } finally { $process.Dispose() }
}
