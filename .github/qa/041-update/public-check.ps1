# Read-only public release acceptance on an ephemeral Windows 11 runner.
param([Parameter(Mandatory)][string]$Source)
$ErrorActionPreference = 'Stop'
$releaseRepo = 'Xoma1818/p-treasury-releases'
$sourceSha = '344ace11d0c6cb27f3f5ffa41c7bbd6dbaf5868b'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or $env:GITHUB_REPOSITORY -ne 'Xoma1818/p-treasury') { throw 'An isolated hosted Windows runner is required.' }
if ((git -C $Source rev-parse HEAD).Trim() -ne $sourceSha) { throw 'Unexpected source of the test helper.' }
$os = Get-CimInstance Win32_OperatingSystem
if ($os.Caption -notmatch 'Windows 11') { throw "Expected Windows 11, found $($os.Caption)" }
foreach ($setting in @('PTREASURY_UPDATE_URL','PTREASURY_UPDATE_ENDPOINT')) {
    foreach ($scope in @('Process','User','Machine')) {
        if ([Environment]::GetEnvironmentVariable($setting, $scope)) { throw "Unexpected override $setting in $scope scope" }
    }
}
$installedPaths = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Kazna', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\P-Treasury',
    (Join-Path $env:APPDATA 'app.kazna.desktop'), (Join-Path $env:LOCALAPPDATA 'Kazna'), (Join-Path $env:LOCALAPPDATA 'P-Treasury'))
if ($installedPaths.Where({Test-Path -LiteralPath $_}) -or (Get-Process Kazna,P-Treasury -ErrorAction SilentlyContinue)) { throw 'Expected a pristine installation.' }
$root = Join-Path $env:RUNNER_TEMP ('KaznaPublic-' + [guid]::NewGuid().ToString('N'))
if ($root -match '\s') { throw 'The silent NSIS path must not include spaces.' }
$null = New-Item -ItemType Directory -Path $root
$install = Join-Path $root 'installed'
$base = "https://github.com/$releaseRepo/releases/download/v0.41.2"
$feedUrl = "https://github.com/$releaseRepo/releases/latest/download/latest.json"
$release = Invoke-RestMethod -Uri "https://api.github.com/repos/$releaseRepo/releases/latest" -TimeoutSec 30
if ($release.tag_name -ne 'v0.41.2' -or $release.draft -or $release.prerelease) { throw '0.41.2 is not the public latest release.' }
$manifest = Invoke-RestMethod -Uri $feedUrl -TimeoutSec 30
if ($manifest.version -ne '0.41.2') { throw "Unexpected production channel version: $($manifest.version)" }
$entry = $manifest.platforms.'windows-x86_64'
$expectedUrl = "$base/Kazna_0.41.2_x64-setup.exe"
if (!$entry -or $entry.url -cne $expectedUrl -or !$entry.signature) { throw 'Unexpected Windows production manifest.' }
function Get-PublishedAsset([string]$Name) {
    $items = @($release.assets | Where-Object name -CEQ $Name)
    if ($items.Count -ne 1 -or $items[0].browser_download_url -cne "$base/$Name" -or $items[0].digest -notmatch '^sha256:[a-fA-F0-9]{64}$') { throw "Missing public artifact provenance: $Name" }
    $path = Join-Path $root $Name
    Invoke-WebRequest -Uri $items[0].browser_download_url -OutFile $path -TimeoutSec 20 -OperationTimeoutSeconds 90
    if ("sha256:$((Get-FileHash -LiteralPath $path).Hash)" -ne $items[0].digest) { throw "Wrong public artifact digest: $Name" }
    return $path
}
$signaturePath = Get-PublishedAsset 'Kazna_0.41.2_x64-setup.exe.sig'
if ($entry.signature.Trim() -cne [IO.File]::ReadAllText($signaturePath).Trim()) { throw 'The public manifest differs from the published signature.' }
$portablePath = Get-PublishedAsset 'Kazna_0.41.2_x64-portable.zip'
$archive = [IO.Compression.ZipFile]::OpenRead($portablePath)
try {
    $bins = @($archive.Entries | Where-Object Name -CEQ 'Kazna.exe')
    if ($bins.Count -ne 1 -or $bins[0].Length -le 0) { throw 'Missing unambiguous public Kazna.exe.' }
    $s = $bins[0].Open()
    try { $expectedExe = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($s)) } finally { $s.Dispose() }
} finally { $archive.Dispose() }
$old = Join-Path $root 'Kazna_0.37.2_x64-setup.exe'
Invoke-WebRequest -Uri "https://github.com/$releaseRepo/releases/download/v0.37.2/Kazna_0.37.2_x64-setup.exe" -OutFile $old -TimeoutSec 20 -OperationTimeoutSeconds 90
if ((Get-FileHash -LiteralPath $old).Hash -ne '6e31087e53ff29a4033caab937bd47c0558204914df0ef37108fcf37ededdfb7') { throw 'Unexpected original 0.37.2 installation file.' }
$proc = Start-Process -FilePath $old -ArgumentList @('/S',"/D=$install") -PassThru -WindowStyle Hidden
if (!$proc.WaitForExit(120000)) { $proc.Kill($true); throw 'Old installer timed out' }
$bin = Join-Path $install 'Kazna.exe'
if ($proc.ExitCode -ne 0 -or (Get-Item -LiteralPath $bin).VersionInfo.ProductVersion -ne '0.37.2') { throw 'Could not install official 0.37.2.' }
$env:KAZNA_TEST_BIN = $bin
$env:KAZNA_E2E_APP = Join-Path $Source 'e2e/app.mjs'
$env:KAZNA_UPDATE_EVIDENCE = Join-Path $root 'public-result.json'
Write-Host "Public channel=$feedUrl release=$($release.tag_name) expectedExeSHA256=$expectedExe OS=$($os.Caption) build=$($os.BuildNumber) arch=$env:RUNNER_ARCH"
& node (Join-Path $PSScriptRoot 'public-update.mjs')
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $env:KAZNA_UPDATE_EVIDENCE)) { throw 'The installed update and data verification failed.' }
$actualExe = (Get-FileHash -LiteralPath $bin -Algorithm SHA256).Hash
if ($actualExe -ne $expectedExe) { throw "The installed program differs from the published executable: $actualExe" }
Write-Host "Public installed exe SHA-256 $actualExe. Evidence: $([IO.File]::ReadAllText($env:KAZNA_UPDATE_EVIDENCE))"
