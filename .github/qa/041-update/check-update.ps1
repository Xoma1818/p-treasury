# Run using PowerShell 7 in a disposable Windows 11 GitHub-hosted job only.
param([Parameter(Mandatory)][string]$Source)
$ErrorActionPreference = 'Stop'
function Write-Phase([string]$Name) {
    Write-Host "[$([DateTimeOffset]::UtcNow.ToString('HH:mm:ssZ'))] $Name"
}
function Start-Child([string]$Command, [string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($Command)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    foreach ($argValue in $Arguments) { $info.ArgumentList.Add($argValue) }
    return [Diagnostics.Process]::Start($info)
}
function Wait-Child([Diagnostics.Process]$Child, [int]$Seconds, [string]$Phase) {
    if (!$Child.WaitForExit($Seconds * 1000)) {
        try {
            $children = (Get-CimInstance Win32_Process -Filter "ParentProcessId=$($Child.Id)" -OperationTimeoutSec 4 -ErrorAction Stop) |
                ForEach-Object { "$($_.Name)($($_.ProcessId))" }
        } catch { $children = @('details unavailable') }
        Write-Warning "$Phase timed out in PID $($Child.Id); child processes: $($children -join ', ')"
        if (!$Child.HasExited) { $Child.Kill($true); $null = $Child.WaitForExit(5000) }
        throw "$Phase exceeded $Seconds seconds"
    }
    if ($Child.ExitCode -ne 0) { throw "$Phase failed, exit $($Child.ExitCode)" }
    Write-Phase "$Phase complete"
}
$repo = 'Xoma1818/p-treasury'
$expectedHead = '07141ebe647f9a8a60ea6a41f0fbc31f2c55c8ba'
$runId = 45082106249L
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_REPOSITORY -ne $repo -or
    $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Use the disposable GitHub-hosted Windows runner only.' }
$os = Get-CimInstance Win32_OperatingSystem
if ($os.Caption -notmatch 'Windows 11') { throw "Windows 11 required. Found $($os.Caption)." }
$sourceSha = (git -C $Source rev-parse HEAD).Trim()
if ($sourceSha -ne $expectedHead) { throw "Unexpected checkout $sourceSha." }
if (-not $env:GH_TOKEN) { throw 'A read-only job token with actions:read is required.' }
if (-not (Test-Path (Join-Path $Source 'node_modules/webdriverio'))) { throw 'Run npm ci in the pinned source checkout first.' }
if ([int](node -p 'process.versions.node.split(".")[0]') -lt 24) { throw 'Node.js 24 or later required.' }
$knownPaths = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Kazna',
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\P-Treasury',
    (Join-Path $env:APPDATA 'app.kazna.desktop'), (Join-Path $env:LOCALAPPDATA 'Kazna'),
    (Join-Path $env:LOCALAPPDATA 'P-Treasury'))
if ($knownPaths.Where({ Test-Path -LiteralPath $_ }) -or (Get-Process Kazna,P-Treasury -ErrorAction SilentlyContinue)) {
    throw 'This runner already contains Kazna or P-Treasury.'
}
$root = Join-Path $env:RUNNER_TEMP ('KaznaUpdate-' + [Guid]::NewGuid().ToString('N'))
if ($root -match '\s') { throw 'Use a temporary path without spaces for NSIS /D.' }
$feed = Join-Path $root 'feed'
$install = Join-Path $root 'installed'
New-Item -ItemType Directory -Path $feed | Out-Null
$base = "https://api.github.com/repos/$repo/actions/runs/$runId"
$headers = @{Authorization="Bearer $env:GH_TOKEN"; Accept='application/vnd.github+json'; 'X-GitHub-Api-Version'='2022-11-28'}
Write-Phase 'Checking workflow provenance'
$run = Invoke-RestMethod -Uri $base -Headers $headers -TimeoutSec 20 -OperationTimeoutSeconds 30
if ($run.id -ne $runId -or $run.head_sha -ne $expectedHead -or $run.head_repository.full_name -ne $repo -or
    $run.path -ne '.github/workflows/windows-installer.yml' -or $run.event -ne 'pull_request' -or
    $run.status -ne 'completed' -or $run.conclusion -ne 'success') { throw 'The pinned installer workflow is not a successful matching run.' }
$artifacts = @((Invoke-RestMethod -Uri "$base/artifacts" -Headers $headers -TimeoutSec 20 -OperationTimeoutSeconds 30).artifacts |
    Where-Object { $_.name -eq 'kazna-windows-installer' -and !$_.expired })
if ($artifacts.Count -ne 1 -or $artifacts[0].digest -notmatch '^sha256:[a-fA-F0-9]{64}$') { throw 'Missing unique installer archive and its SHA-256.' }
$candidate = $artifacts[0]
$zip = Join-Path $root 'candidate.zip'
$archiveUrl = "https://api.github.com/repos/$repo/actions/artifacts/$($candidate.id)/zip"
Invoke-WebRequest -Uri $archiveUrl -Headers $headers -OutFile $zip -TimeoutSec 20 -OperationTimeoutSeconds 60
$headers.Clear()
$env:GH_TOKEN = $null
if ("sha256:$((Get-FileHash -LiteralPath $zip).Hash)" -ne $candidate.digest) { throw 'Artifact digest mismatch.' }
$exe = 'Kazna_0.41.0_x64-setup.exe'
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
    foreach ($name in @($exe,"$exe.sig")) {
        $matchesInZip = @($archive.Entries | Where-Object { $_.Name -ceq $name })
        if ($matchesInZip.Count -ne 1 -or $matchesInZip[0].Length -le 0) { throw "Missing or ambiguous $name in signed artifact." }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($matchesInZip[0], (Join-Path $feed $name), $false)
    }
} finally { $archive.Dispose() }
$old = Join-Path $root 'Kazna_0.37.2_x64-setup.exe'
Invoke-WebRequest -Uri 'https://github.com/Xoma1818/p-treasury-releases/releases/download/v0.37.2/Kazna_0.37.2_x64-setup.exe' -OutFile $old -TimeoutSec 20 -OperationTimeoutSeconds 60
if ((Get-FileHash -LiteralPath $old).Hash -ne '6e31087e53ff29a4033caab937bd47c0558204914df0ef37108fcf37ededdfb7') {
    throw 'The previous installer digest differs from the published release.'
}
$driver = Get-Command msedgedriver.exe -ErrorAction Stop
Write-Host "Windows $($os.Caption) build $($os.BuildNumber), $($os.OSArchitecture); driver $($driver.Source)"
Write-Host "Candidate $expectedHead run $runId, artifact $($candidate.id), installer SHA-256 $((Get-FileHash (Join-Path $feed $exe)).Hash)"
Write-Phase 'Installing previous version 0.37.2'
$p = Start-Child $old @('/S',"/D=$install")
Wait-Child $p 120 'Installer 0.37.2'
$bin = Join-Path $install 'Kazna.exe'
if ($p.ExitCode -ne 0 -or (Get-Item -LiteralPath $bin).VersionInfo.ProductVersion -ne '0.37.2') { throw 'Previous installation failed.' }

$server = $null
$shell = (Get-Command pwsh.exe).Source
try {
    Write-Phase 'Preparing certificate and local trust'
    $prepare = Start-Child $shell @('-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'prepare-tls.ps1'),'-Folder',$feed)
    Wait-Child $prepare 45 'TLS setup'
    $leafId = [IO.File]::ReadAllText((Join-Path $feed 'leaf-thumbprint.txt'))
    Write-Phase 'Starting local HTTPS server'
    $server = Start-Child $shell @('-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'serve-feed.ps1'),'-Folder',$feed,'-Thumbprint',$leafId)
    $addressFile = Join-Path $feed 'endpoint.txt'
    $until = (Get-Date).AddSeconds(20)
    while (!(Test-Path -LiteralPath $addressFile) -and (Get-Date) -lt $until -and !$server.HasExited) { Start-Sleep -Milliseconds 200 }
    if (!(Test-Path -LiteralPath $addressFile)) { throw 'The local HTTPS listener did not report readiness.' }
    $env:PTREASURY_UPDATE_URL = [IO.File]::ReadAllText($addressFile)
    $manifest = Invoke-RestMethod -Uri $env:PTREASURY_UPDATE_URL -TimeoutSec 12 -OperationTimeoutSeconds 15 -NoProxy
    if ($manifest.version -ne '0.41.0') { throw 'The normal Windows TLS client did not receive the expected candidate manifest.' }
    $env:NO_PROXY = 'localhost,127.0.0.1'
    $env:KAZNA_TEST_BIN = $bin
    $env:KAZNA_E2E_APP = Join-Path $Source 'e2e/app.mjs'
    $env:KAZNA_UPDATE_EVIDENCE = Join-Path $root 'verified-update.json'
    Write-Phase 'Starting the installed app and checking the update'
    $test = Start-Child (Get-Command node.exe).Source @((Join-Path $PSScriptRoot 'verify-update.mjs'))
    Wait-Child $test 360 'Window and data verification'
    if ((Get-Content -LiteralPath (Join-Path $feed 'requests.txt')) -cnotcontains $exe) { throw 'The updater did not request the pinned installer.' }
    $evidence = Get-Content -LiteralPath $env:KAZNA_UPDATE_EVIDENCE -Raw
    Write-Host "Window/SQLite evidence: $evidence"
} finally {
    Write-Phase 'Closing the local feed'
    if ($server -and !$server.HasExited) {
        [IO.File]::WriteAllText((Join-Path $feed 'stop'), '')
        if (!$server.WaitForExit(5000) -and !$server.HasExited) { $server.Kill($true); $null = $server.WaitForExit(4000) }
    }
    foreach ($kind in @('leaf','ca')) {
        $idFile = Join-Path $feed "$kind-thumbprint.txt"
        if (!(Test-Path -LiteralPath $idFile)) { continue }
        $id = [IO.File]::ReadAllText($idFile)
        if ($id -notmatch '^[0-9a-f]{40}$') { throw 'Unexpected TLS certificate identifier in the disposable directory.' }
        if ($kind -eq 'ca') { Remove-Item -LiteralPath "Cert:\LocalMachine\Root\$id" -Force -Confirm:$false -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$id" -DeleteKey -Force -Confirm:$false -ErrorAction Continue
    }
    Write-Phase 'Isolated resources cleaned up'
}
