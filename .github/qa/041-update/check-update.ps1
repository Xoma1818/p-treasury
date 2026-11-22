# Run using PowerShell 7 in a disposable Windows 11 GitHub-hosted job only.
param([Parameter(Mandatory)][string]$Source)
$ErrorActionPreference = 'Stop'
$repo = 'Xoma1818/p-treasury'
$expectedHead = '1f7d9df8d958dbb36b26490fe98626268a239151'
$runId = 45075226749L
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
$run = Invoke-RestMethod -Uri $base -Headers $headers
if ($run.id -ne $runId -or $run.head_sha -ne $expectedHead -or $run.head_repository.full_name -ne $repo -or
    $run.path -ne '.github/workflows/windows-installer.yml' -or $run.event -ne 'pull_request' -or
    $run.status -ne 'completed' -or $run.conclusion -ne 'success') { throw 'The pinned installer workflow is not a successful matching run.' }
$artifacts = @((Invoke-RestMethod -Uri "$base/artifacts" -Headers $headers).artifacts |
    Where-Object { $_.name -eq 'kazna-windows-installer' -and !$_.expired })
if ($artifacts.Count -ne 1 -or $artifacts[0].digest -notmatch '^sha256:[a-fA-F0-9]{64}$') { throw 'Missing unique installer archive and its SHA-256.' }
$candidate = $artifacts[0]
$zip = Join-Path $root 'candidate.zip'
$archiveUrl = "https://api.github.com/repos/$repo/actions/artifacts/$($candidate.id)/zip"
Invoke-WebRequest -Uri $archiveUrl -Headers $headers -OutFile $zip
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
Invoke-WebRequest -Uri 'https://github.com/Xoma1818/p-treasury-releases/releases/download/v0.37.2/Kazna_0.37.2_x64-setup.exe' -OutFile $old
if ((Get-FileHash -LiteralPath $old).Hash -ne '6e31087e53ff29a4033caab937bd47c0558204914df0ef37108fcf37ededdfb7') {
    throw 'The previous installer digest differs from the published release.'
}
$driver = Get-Command msedgedriver.exe -ErrorAction Stop
Write-Host "Windows $($os.Caption) build $($os.BuildNumber), $($os.OSArchitecture); driver $($driver.Source)"
Write-Host "Candidate $expectedHead run $runId, artifact $($candidate.id), installer SHA-256 $((Get-FileHash (Join-Path $feed $exe)).Hash)"
$p = Start-Process -FilePath $old -ArgumentList @('/S',"/D=$install") -WindowStyle Hidden -Wait -PassThru
$bin = Join-Path $install 'Kazna.exe'
if ($p.ExitCode -ne 0 -or (Get-Item -LiteralPath $bin).VersionInfo.ProductVersion -ne '0.37.2') { throw 'Previous installation failed.' }

$ca = $null
$leaf = $null
$server = $null
try {
    # A one-job local trust anchor. Private keys stay non-exportable in the temporary Windows profile.
    $ca = New-SelfSignedCertificate -Type Custom -Subject "CN=Kazna-QA-$([Guid]::NewGuid().ToString('N'))" -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -KeyUsage CertSign,CRLSign -TextExtension '2.5.29.19={critical}{text}ca=1&pathlength=0' -NotAfter (Get-Date).AddDays(1) -CertStoreLocation Cert:\CurrentUser\My
    $leaf = New-SelfSignedCertificate -DnsName 'localhost' -Type SSLServerAuthentication -Signer $ca -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddHours(6) -CertStoreLocation Cert:\CurrentUser\My
    $trust = [Security.Cryptography.X509Certificates.X509Store]::new('Root','CurrentUser')
    $trust.Open('ReadWrite')
    try {
        $publicCert = [Security.Cryptography.X509Certificates.X509Certificate2]::new($ca.RawData)
        $trust.Add($publicCert)
    } finally { $trust.Close() }
    $server = Start-Job -FilePath (Join-Path $PSScriptRoot 'serve-feed.ps1') -ArgumentList $feed,$leaf.Thumbprint
    $addressFile = Join-Path $feed 'endpoint.txt'
    $until = (Get-Date).AddSeconds(20)
    while (!(Test-Path -LiteralPath $addressFile) -and (Get-Date) -lt $until -and $server.State -eq 'Running') { Start-Sleep -Milliseconds 200 }
    $env:PTREASURY_UPDATE_URL = [IO.File]::ReadAllText($addressFile)
    $manifest = Invoke-RestMethod -Uri $env:PTREASURY_UPDATE_URL -TimeoutSec 12 -NoProxy
    if ($manifest.version -ne '0.41.0') { throw 'The normal Windows TLS client did not receive the expected candidate manifest.' }
    $env:NO_PROXY = 'localhost,127.0.0.1'
    $env:KAZNA_TEST_BIN = $bin
    $env:KAZNA_E2E_APP = Join-Path $Source 'e2e/app.mjs'
    node (Join-Path $PSScriptRoot 'verify-update.mjs')
    if ($LASTEXITCODE -ne 0) { throw "The UI test failed ($LASTEXITCODE)." }
    if ((Get-Content -LiteralPath (Join-Path $feed 'requests.txt')) -cnotcontains $exe) { throw 'The updater did not request the pinned installer.' }
} finally {
    if ($server) { Stop-Job $server; Receive-Job $server; Remove-Job $server }
    if ($leaf) { Remove-Item -LiteralPath ("Cert:\CurrentUser\My\"+$leaf.Thumbprint) -DeleteKey -ErrorAction Continue }
    if ($ca) {
        Remove-Item -LiteralPath ("Cert:\CurrentUser\Root\"+$ca.Thumbprint) -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath ("Cert:\CurrentUser\My\"+$ca.Thumbprint) -DeleteKey -ErrorAction Continue
    }
}
