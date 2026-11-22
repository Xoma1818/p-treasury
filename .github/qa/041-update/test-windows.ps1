param([Parameter(Mandatory)][string]$Source)
$ErrorActionPreference = 'Stop'
$Source = (Resolve-Path -LiteralPath $Source).Path
$repo = 'Xoma1818/p-treasury'
$sha = '07141ebe647f9a8a60ea6a41f0fbc31f2c55c8ba'
$runId = 45082106249L
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_REPOSITORY -ne $repo -or $env:RUNNER_OS -ne 'Windows') { throw 'Disposable project Windows runner required.' }
$os = Get-CimInstance Win32_OperatingSystem
if ($os.Caption -notmatch 'Windows 11' -or $env:RUNNER_ARCH -ne 'ARM64') { throw "Wrong runner: $($os.Caption), $env:RUNNER_ARCH" }
if ((git -C $Source rev-parse HEAD) -ne $sha) { throw 'Wrong test source commit' }
if (Get-Process Kazna,P-Treasury -ErrorAction SilentlyContinue) { throw 'The runner already has an open Kazna/P-Treasury process' }
$dir = Join-Path $env:RUNNER_TEMP 'kazna-041-scenarios'
if (Test-Path -LiteralPath $dir) { throw 'Fresh test output directory required.' }
$logs = Join-Path $dir 'logs'
New-Item -ItemType Directory -Path $logs | Out-Null
$headers = @{Authorization="Bearer $env:GH_TOKEN"; Accept='application/vnd.github+json'}
$url = "https://api.github.com/repos/$repo/actions/runs/$runId"
$run = Invoke-RestMethod $url -Headers $headers
if ($run.id -ne $runId -or $run.head_sha -ne $sha -or $run.head_repository.full_name -ne $repo -or $run.path -ne '.github/workflows/windows-installer.yml' -or $run.event -ne 'pull_request' -or $run.status -ne 'completed' -or $run.conclusion -ne 'success') { throw 'Wrong or unfinished installer build' }
$assets = @((Invoke-RestMethod "$url/artifacts" -Headers $headers).artifacts | Where-Object { $_.name -eq 'kazna-windows-portable' -and !$_.expired })
if ($assets.Count -ne 1 -or $assets[0].digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Missing unique portable artifact and digest on the pinned run' }
$expectedZip = $assets[0].digest.Substring(7)
$archive = Join-Path $dir 'candidate.zip'
Invoke-WebRequest "https://api.github.com/repos/$repo/actions/artifacts/$($assets[0].id)/zip" -Headers $headers -OutFile $archive
$headers.Clear()
$env:GH_TOKEN = $null
if ((Get-FileHash -LiteralPath $archive).Hash -ne $expectedZip) { throw 'Wrong archive SHA-256' }
$bin = Join-Path $dir 'Kazna.exe'
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    $names = @($zip.Entries.FullName | Sort-Object)
    if (($names -join ',') -cne 'Kazna.exe,portable' -or $zip.GetEntry('portable').Length -ne 0) { throw "Unexpected archive members: $names" }
    # The ordinary tests pass their own data directory. wave4 creates its own portable marker beside an identical copy.
    [IO.Compression.ZipFileExtensions]::ExtractToFile($zip.GetEntry('Kazna.exe'), $bin, $false)
} finally { $zip.Dispose() }
if ((Get-Item -LiteralPath $bin).VersionInfo.ProductVersion -ne '0.41.0') { throw 'Wrong executable version' }
$exeDigest = (Get-FileHash -LiteralPath $bin).Hash
$env:PTREASURY_BIN = $bin
Write-Host "Source $sha, run $runId, artifact $($assets[0].id), archive $expectedZip, executable $exeDigest; $($os.Caption) $($os.BuildNumber)"

# Exercise the Tauri adapter on this exact exe before running the native test harness.
# Windows e2e/app.mjs normally speaks WebDriver directly to the same Edge driver.
$driver = (Get-Command tauri-driver.exe).Source
$edge = (Get-Command msedgedriver.exe).Source
$probeDir = Join-Path $dir 'driver-probe'
New-Item -ItemType Directory -Path $probeDir | Out-Null
$bridge = Start-Process -FilePath $driver -ArgumentList @('--port','4438','--native-port','4439','--native-driver',('"{0}"' -f $edge)) -WindowStyle Hidden -PassThru -RedirectStandardOutput "$logs/driver.out" -RedirectStandardError "$logs/driver.err"
$session = $null
$bad = [Collections.Generic.List[string]]::new()
try {
    $ready = $false
    for ($i=0; $i -lt 40; $i++) {
        if ($bridge.HasExited) { break }
        try { $status = Invoke-RestMethod 'http://127.0.0.1:4438/status' -TimeoutSec 2; if ($status.value.ready) { $ready=$true; break } } catch { Start-Sleep -Milliseconds 250 }
        Start-Sleep -Milliseconds 100
    }
    if (!$ready) { throw 'tauri-driver did not become ready.' }
    $request = @{ capabilities=@{alwaysMatch=@{'tauri:options'=@{application=$bin; args=@("--data-dir=$probeDir")}}} } | ConvertTo-Json -Depth 8
    $created = Invoke-RestMethod 'http://127.0.0.1:4438/session' -Method Post -Body $request -ContentType 'application/json' -TimeoutSec 55
    $session = $created.value.sessionId
    if (!$session) { throw 'Missing WebDriver session id' }
    $title=''
    for ($i=0; $i -lt 30 -and $title -ne 'Kazna'; $i++) {
        $title=(Invoke-RestMethod "http://127.0.0.1:4438/session/$session/title" -TimeoutSec 8).value
        if ($title -ne 'Kazna') { Start-Sleep -Milliseconds 300 }
    }
    if ($title -ne 'Kazna') { throw "Unexpected window title: $title" }
    Write-Host 'tauri-driver opened the official Windows application.'
} catch {
    $bad.Add('tauri-driver')
    Write-Warning $_.Exception.Message
} finally {
    if ($session) { try { Invoke-RestMethod "http://127.0.0.1:4438/session/$session" -Method Delete -TimeoutSec 10 | Out-Null } catch { Write-Warning $_.Exception.Message } }
    if (!$bridge.HasExited) { $bridge.Kill($true); $bridge.WaitForExit(10000) | Out-Null }
    # A Tauri window may minimize to tray. Only the just-opened app for the probe directory is eligible.
    Get-CimInstance Win32_Process -Filter "Name='Kazna.exe'" | Where-Object { $_.ExecutablePath -eq $bin -and $_.CommandLine.Contains($probeDir) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}
$cases = [ordered]@{'compare'=5; 'loans'=11; 'loans-flex'=5; 'reminders-ahead'=6; 'stage1'=13; 'stage4'=9; 'stage5'=8; 'wave3'=20; 'wave4'=4; 'final'=2}
$node = (Get-Command node.exe).Source
$passed = 0
$groupReport = [ordered]@{}
foreach ($name in $cases.Keys) {
    $stdout = Join-Path $logs "$name.tap"
    $stderr = Join-Path $logs "$name.stderr.txt"
    Write-Host "::group::$name"
    try {
        # final reads the actual XLSX member with Info-ZIP. Git for Windows may keep it off PATH.
        if ($name -eq 'final' -and !(Get-Command unzip.exe -ErrorAction SilentlyContinue)) {
            $gitRoot = Split-Path (Split-Path (Get-Command git.exe).Source -Parent) -Parent
            $zipTools = Join-Path $gitRoot 'usr/bin'
            if (!(Test-Path -LiteralPath (Join-Path $zipTools 'unzip.exe'))) { throw 'Missing unzip.exe required to read the saved Excel workbook' }
            $env:Path += ";$zipTools"
        }
        $proc=Start-Process -FilePath $node -WorkingDirectory $Source -ArgumentList @('--test','--test-reporter=tap','--test-concurrency=1',"e2e/$name.test.mjs") -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        if (!$proc.WaitForExit(240000)) {
            $proc.Kill($true)
            $proc.WaitForExit(10000) | Out-Null
            throw "Timeout in $name; see its log"
        }
        $report = Get-Content -Raw -Encoding utf8 -LiteralPath $stdout
        $wanted = $cases[$name]
        foreach ($measure in @('tests','pass','fail','skipped','todo','cancelled')) {
            $expected = if ($measure -in @('tests','pass')) { $wanted } else { 0 }
            if ($report -notmatch "(?m)^# $measure $expected\s*$") { throw "Expected '$measure $expected' in $name" }
        }
        if ($proc.ExitCode -ne 0) { throw "Exit $($proc.ExitCode) in $name" }
        $parsed = [regex]::Match($report,'(?m)^# pass (\d+)\s*$')
        $passed += [int]$parsed.Groups[1].Value
        $groupReport[$name] = [int]$parsed.Groups[1].Value
        Write-Host "$name passed $wanted/$wanted"
    } catch {
        $groupReport[$name] = 'incomplete'
        $bad.Add($name)
        Write-Warning $_.Exception.Message
        Get-Content -LiteralPath $stdout,$stderr -Tail 18 -ErrorAction SilentlyContinue
    } finally { Write-Host '::endgroup::' }
}
$summary = [ordered]@{ source=$sha; installerRun=$runId; exeSha256=$exeDigest; groups=$groupReport; totalPassed=$passed; expected=83; failedOrIncomplete=@($bad.ToArray()) }
$summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $logs 'summary.json') -Encoding utf8NoBOM
if ($bad.Count -or $passed -ne 83 -or $groupReport.Count -ne 10) { throw "Passed $passed/83; failed or incomplete: $($bad -join ', '). See the per-file logs." }
Write-Host "Ten test files, $passed passed, no skipped tests."
