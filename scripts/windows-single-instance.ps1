# Windows desktop regression using a fresh budget, vault and WebView2 directory.
# pwsh -File scripts/windows-single-instance.ps1 -AppPath C:\build\Kazna.exe
# -Python can point to a Python 3 installation with the standard sqlite3 module.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$AppPath,
    [string]$Python = 'python',
    [string]$OutputDirectory = [IO.Path]::GetTempPath()
)
$ErrorActionPreference = 'Stop'
$exe = (Get-Item -LiteralPath $AppPath).FullName
$pythonExe = (Get-Command $Python -CommandType Application | Select-Object -First 1).Source
& $pythonExe -c 'import sqlite3'
if ($LASTEXITCODE -ne 0) { throw 'Python 3 with sqlite3 is required.' }
$directory = Join-Path $OutputDirectory ('kazna-instance-' + [guid]::NewGuid().ToString('N'))
$root = [IO.Directory]::CreateDirectory($directory).FullName
$profiles = @((Join-Path $root 'budget A'), (Join-Path $root 'budget B'))
$owned = [Collections.Generic.List[Diagnostics.Process]]::new()
$results = [Collections.Generic.List[object]]::new()

if (-not ('KaznaTestWindow' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class KaznaTestWindow {
    private delegate bool EnumProc(IntPtr h, IntPtr state);
    [DllImport("user32")] private static extern bool EnumWindows(EnumProc cb, IntPtr state);
    [DllImport("user32", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
    [DllImport("user32")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint process);
    [DllImport("user32")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32")] public static extern bool ShowWindowAsync(IntPtr h, int action);
    [DllImport("user32", SetLastError=true)] public static extern bool PostMessage(IntPtr h, uint message, IntPtr w, IntPtr l);
    public static IntPtr[] MainWindows(int pid) {
        var found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr _) {
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (owner == pid) {
                var title = new StringBuilder(128);
                GetWindowText(h, title, title.Capacity);
                if (title.ToString() == "Kazna") found.Add(h);
            }
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }
    [DllImport("user32", CharSet=CharSet.Unicode)] private static extern IntPtr FindWindow(string cls, string name);
    [DllImport("user32", SetLastError=true)] private static extern IntPtr SendMessageTimeout(IntPtr handle, uint msg,
        IntPtr w, IntPtr l, uint flags, uint ms, out IntPtr value);
    public static bool Responds(IntPtr handle) {
        IntPtr value;
        return handle != IntPtr.Zero && SendMessageTimeout(handle, 0, IntPtr.Zero, IntPtr.Zero, 2, 400, out value) != IntPtr.Zero;
    }
    public static bool OwnsReceiver(int pid, string id) {
        uint owner;
        var handle = FindWindow(id+"-sic", id+"-siw");
        return handle != IntPtr.Zero && GetWindowThreadProcessId(handle, out owner) != 0 && owner == pid && Responds(handle);
    }
}
'@
}

function Wait-For([string]$description, [scriptblock]$condition) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt 30) {
        if (& $condition) { return }
        Start-Sleep -Milliseconds 100
    }
    throw "Timed out: $description"
}

function Test-InstanceLock([string]$identifier) {
    # The Windows single-instance plugin uses a session-local named mutex.
    # Only open an existing handle. Do not create a mutex on behalf of Kazna.
    $lock = $null
    if (-not [Threading.Mutex]::TryOpenExisting("$identifier-sim", [ref]$lock)) { return $false }
    $lock.Dispose()
    return $true
}

function Start-Kazna([string]$profile, [switch]$Argument, [string]$PortableExe) {
    $binary = if ($PortableExe) { $PortableExe } else { $exe }
    $info = [Diagnostics.ProcessStartInfo]::new($binary)
    $info.UseShellExecute = $false
    $info.WorkingDirectory = Split-Path -Parent $binary
    # No driver flags, mock window or application IPC. The first launch has no CLI arguments.
    if ($PortableExe) { $info.EnvironmentVariables.Remove('PTREASURY_DATA_DIR') }
    else { $info.EnvironmentVariables['PTREASURY_DATA_DIR'] = $profile }
    $info.EnvironmentVariables['PTREASURY_VAULT_DIR'] = Join-Path $profile 'vault'
    $info.EnvironmentVariables['WEBVIEW2_USER_DATA_FOLDER'] = Join-Path $profile 'webview'
    $info.EnvironmentVariables.Remove('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS')
    $info.EnvironmentVariables['PTREASURY_CBR_URL'] = 'http://127.0.0.1:9/scripts/XML_daily.asp'
    if ($Argument) { $info.Arguments = '"--data-dir=' + $profile + '"' }
    $process = [Diagnostics.Process]::Start($info)
    $owned.Add($process)
    return $process
}

function Get-Window([Diagnostics.Process]$process) {
    if ($process.HasExited) { throw "Primary process $($process.Id) exited with $($process.ExitCode)." }
    $handles = [KaznaTestWindow]::MainWindows($process.Id)
    if ($handles.Count -gt 1) { throw "Duplicate Kazna windows in process $($process.Id)." }
    if ($handles.Count -eq 1) { return $handles[0] }
    return [IntPtr]::Zero
}

function Set-TrayMode([string]$profile, [bool]$enabled) {
    $db = Join-Path $profile 'budget.db'
    if (-not (Test-Path -LiteralPath $db -PathType Leaf)) { throw "Missing test database: $db" }
    # Fixture setup only. WM_CLOSE below is handled by the actual application.
    $code = @'
import sqlite3, sys
from pathlib import Path
with sqlite3.connect(Path(sys.argv[1]).as_uri() + "?mode=rw", uri=True, timeout=10) as db:
    db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES ('close_to_tray',?)", (sys.argv[2],))
'@
    $code | & $pythonExe - $db ([int]$enabled)
    if ($LASTEXITCODE -ne 0) { throw "Could not set the tray fixture in $db." }
}

function Close-Window([Diagnostics.Process]$process, [IntPtr]$handle) {
    if ((Get-Window $process) -ne $handle -or $handle -eq [IntPtr]::Zero) {
        throw 'The original window is no longer owned by this test process.'
    }
    if (-not [KaznaTestWindow]::PostMessage($handle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)) {
        throw 'Posting WM_CLOSE failed.'
    }
}

function Minimize-Window([Diagnostics.Process]$process, [IntPtr]$handle, [switch]$External) {
    if ((Get-Window $process) -ne $handle -or $handle -eq [IntPtr]::Zero) {
        throw 'The minimize target is not the original test window.'
    }
    if ($External) {
        $null = [KaznaTestWindow]::ShowWindowAsync($handle, 6) # SW_MINIMIZE
    } else {
        # The caption and taskbar issue WM_SYSCOMMAND/SC_MINIMIZE.
        if (-not [KaznaTestWindow]::PostMessage($handle, 0x112, [IntPtr]0xF020, [IntPtr]::Zero)) {
            throw 'Could not send the minimize command to the test window.'
        }
    }
    Wait-For 'minimization' { [KaznaTestWindow]::IsIconic($handle) }
}

function Confirm-Owner([Diagnostics.Process]$primary, [IntPtr]$handle) {
    Wait-For 'the original window is restored' {
        (Get-Window $primary) -eq $handle -and [KaznaTestWindow]::IsWindowVisible($handle) -and
            -not [KaznaTestWindow]::IsIconic($handle)
    }
    if (Test-Path -LiteralPath (Join-Path $profiles[1] 'budget.db')) {
        throw 'A secondary launch opened its own budget before the owner exited.'
    }
}

function Confirm-Forwarded([Diagnostics.Process[]]$others) {
    Wait-For 'secondary processes to exit' { @($others | Where-Object { -not $_.HasExited }).Count -eq 0 }
    foreach ($other in $others) {
        if ($other.ExitCode -ne 0) { throw "Secondary PID $($other.Id) exited with $($other.ExitCode)." }
    }
}

function Record([string]$step, [Diagnostics.Process]$owner, [IntPtr]$handle, [string]$profile) {
    $results.Add([ordered]@{step=$step; pid=$owner.Id; hwnd=$handle.ToInt64(); budget=$profile})
    Write-Output "PASS $step (PID $($owner.Id), HWND $handle)"
}

function Test-StandardLaunch([Diagnostics.Process]$testOwner, [IntPtr]$testWindow) {
    $names = @('Kazna', 'budget-app', [IO.Path]::GetFileNameWithoutExtension($exe))
    $existing = @(Get-Process | Where-Object {
        $_.Id -ne $testOwner.Id -and $_.SessionId -eq $testOwner.SessionId -and
            ($_.ProcessName -in $names -or $_.MainWindowTitle -eq 'Kazna')
    })
    if ($existing.Count -or (Test-InstanceLock 'app.kazna.desktop')) {
        $results.Add([ordered]@{step='ordinary shortcut'; status='skipped'; reason='another Kazna is already running'})
        Write-Output 'SKIP ordinary shortcut: another Kazna is already running.'
        return
    }
    $folder = [IO.Directory]::CreateDirectory((Join-Path $root 'portable')).FullName
    $binary = Join-Path $folder 'Kazna.exe'
    Copy-Item -LiteralPath $exe -Destination $binary
    foreach ($name in 'budget_app_lib.dll','WebView2Loader.dll') {
        $sidecar = Join-Path (Split-Path -Parent $exe) $name
        if (Test-Path -LiteralPath $sidecar -PathType Leaf) { Copy-Item -LiteralPath $sidecar -Destination $folder }
    }
    [IO.File]::WriteAllText((Join-Path $folder 'portable'), '')
    $profile = Join-Path $folder 'data'
    $standard = Start-Kazna $profile -PortableExe $binary
    Wait-For 'ordinary portable window and its own database' {
        (Get-Window $standard) -ne [IntPtr]::Zero -and (Test-Path -LiteralPath (Join-Path $profile 'budget.db'))
    }
    $window = Get-Window $standard
    foreach ($method in 'ShowWindowAsync','WM_SYSCOMMAND') {
        # The first activation is sent as soon as the native window is usable.
        # Delaying it until the renderer is ready would miss the startup race.
        $early = $method -eq 'ShowWindowAsync'
        if (-not $early) {
            Wait-For 'ordinary window and activation receiver ready' {
                [KaznaTestWindow]::Responds($window) -and [KaznaTestWindow]::OwnsReceiver($standard.Id, 'app.kazna.desktop')
            }
        }
        Minimize-Window $standard $window -External:$early
        $forward = Start-Kazna $profile -PortableExe $binary
        Confirm-Forwarded @($forward)
        try {
            Wait-For "second shortcut restores the same ordinary window after $method" {
                (Get-Window $standard) -eq $window -and [KaznaTestWindow]::IsWindowVisible($window) -and
                    -not [KaznaTestWindow]::IsIconic($window)
            }
        } catch {
            $results.Add([ordered]@{status='diagnostic'; method=$method; owner=$standard.Id; hwnd=$window.ToInt64()
                minimized=[KaznaTestWindow]::IsIconic($window); visible=[KaznaTestWindow]::IsWindowVisible($window)
                responsive=[KaznaTestWindow]::Responds($window); secondary=$forward.Id; secondaryExit=$forward.ExitCode
                secondaryMs=($forward.ExitTime-$forward.StartTime).TotalMilliseconds})
            throw
        }
        Confirm-Owner $testOwner $testWindow
        Record "ordinary shortcut restores its own window after $method" $standard $window $profile
    }
    Set-TrayMode $profile $false
    Close-Window $standard $window
    Wait-For 'ordinary portable exit' { $standard.HasExited }
    if ($standard.ExitCode -ne 0) { throw "Portable exit code $($standard.ExitCode)." }
}

Write-Output "Test files: $root"
try {
    if (Test-InstanceLock 'app.kazna.desktop.qa') { throw 'Another test instance is running. Leave it untouched.' }
    $primary = Start-Kazna $profiles[0]
    Wait-For 'first main window and budget' {
        (Get-Window $primary) -ne [IntPtr]::Zero -and (Test-Path -LiteralPath (Join-Path $profiles[0] 'budget.db'))
    }
    $original = Get-Window $primary
    Confirm-Owner $primary $original
    Record 'ordinary window' $primary $original $profiles[0]
    Test-StandardLaunch $primary $original

    Minimize-Window $primary $original
    Confirm-Forwarded @(Start-Kazna $profiles[0] -Argument)
    Confirm-Owner $primary $original
    Record 'same folder restores minimized owner' $primary $original $profiles[0]

    Set-TrayMode $profiles[0] $true
    Close-Window $primary $original
    Wait-For 'close to tray' { (Get-Window $primary) -eq $original -and -not [KaznaTestWindow]::IsWindowVisible($original) }
    Confirm-Forwarded @(Start-Kazna $profiles[1] -Argument)
    Confirm-Owner $primary $original
    Record 'different folder restores owner from tray' $primary $original $profiles[0]

    $wave = @(foreach ($i in 0..5) { Start-Kazna $profiles[($i % 2)] -Argument })
    Confirm-Forwarded $wave
    Confirm-Owner $primary $original
    Record 'six launches share one live owner' $primary $original $profiles[0]

    Set-TrayMode $profiles[0] $false
    Close-Window $primary $original
    Wait-For 'full application exit' { $primary.HasExited }
    if ($primary.ExitCode -ne 0) { throw "Primary exit code $($primary.ExitCode)." }
    Record 'normal application exit' $primary $original $profiles[0]

    # Start a burst on a cold namespace. Do not assume which launch wins.
    $cold = @(foreach ($i in 1..4) { Start-Kazna $profiles[1] -Argument })
    Wait-For 'one surviving process and a new database' {
        $remaining = @($cold | Where-Object { -not $_.HasExited })
        $remaining.Count -eq 1 -and (Get-Window $remaining[0]) -ne [IntPtr]::Zero -and
            (Test-Path -LiteralPath (Join-Path $profiles[1] 'budget.db'))
    }
    $newOwner = @($cold | Where-Object { -not $_.HasExited })[0]
    Confirm-Forwarded @($cold | Where-Object { $_.Id -ne $newOwner.Id })
    $newWindow = Get-Window $newOwner
    Wait-For 'new window visible' { [KaznaTestWindow]::IsWindowVisible($newWindow) }
    Record 'cold burst creates one new owner and budget' $newOwner $newWindow $profiles[1]
    Set-TrayMode $profiles[1] $false
    Close-Window $newOwner $newWindow
    Wait-For 'final owner to exit' { $newOwner.HasExited }
    if ($newOwner.ExitCode -ne 0) { throw "Final exit code $($newOwner.ExitCode)." }
} catch {
    $results.Add([ordered]@{status='failed'; reason=$_.Exception.Message})
    throw
} finally {
    # Each retained Process object belongs to this invocation. Never kill by image name.
    foreach ($child in $owned) {
        try {
            if (-not $child.HasExited) { $child.Kill(); $null = $child.WaitForExit(5000) }
        } catch { Write-Warning "Cleanup of owned PID $($child.Id): $_" }
        finally { $child.Dispose() }
    }
    ConvertTo-Json -InputObject $results.ToArray() -Depth 3 | Set-Content -LiteralPath (Join-Path $root 'results.json') -Encoding UTF8
}
