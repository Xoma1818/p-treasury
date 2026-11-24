# Called by the E2E harness on the same desktop as its WebDriver session.
param(
    [Parameter(Mandatory)][int]$DriverId,
    [Parameter(Mandatory)][string]$AppPath,
    [int]$Width,
    [int]$Height,
    [switch]$CloseMain
)
$ErrorActionPreference = 'Stop'

# EdgeDriver launches the supplied executable. A title or executable name alone
# could also match a user's independently running copy of Kazna.
$tree = @{}
foreach ($proc in (Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath,CreationDate)) {
    $tree[[int]$proc.ProcessId] = $proc
}
$owner = @(foreach ($proc in $tree.Values) {
    if ($proc.ExecutablePath -ne $AppPath) { continue }
    $ancestor = $proc
    while ($parent = $tree[[int]$ancestor.ParentProcessId]) {
        if ($parent.CreationDate -gt $ancestor.CreationDate -or $parent.ProcessId -eq $ancestor.ProcessId) { break }
        if ($parent.ProcessId -eq $DriverId) { $proc; break }
        $ancestor = $parent
    }
})
if ($owner.Count -ne 1) {
    throw "Expected exactly one $AppPath owned by driver PID $DriverId, found $($owner.Count)."
}

Add-Type -Path (Join-Path $PSScriptRoot 'WindowsWebView.cs')
$app = Get-Process -Id $owner[0].ProcessId
try {
    # Keep the process object alive and check its identity across the CIM/Win32 boundary.
    $null = $app.Handle
    if ($app.HasExited -or $app.Path -ne $AppPath -or [Math]::Abs(($app.StartTime - $owner[0].CreationDate).TotalMilliseconds) -gt 1) {
        throw 'The test application process changed before measuring its window.'
    }
    if ($CloseMain) {
        [WindowsWebView]::CloseMain($app)
        'true'
        return
    }
    $size = [WindowsWebView]::MeasureOrResize($app, $Width, $Height)
    @{width=$size[0]; height=$size[1]} | ConvertTo-Json -Compress
} finally { $app.Dispose() }
