# Только одноразовый GitHub-hosted runner. Установщик новой версии запускает сама Kazna.
param([Parameter(Mandatory)][ValidateSet('prepare','before','restart','after','verify','summary')][string]$Stage)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ARCH -ne 'ARM64' -or
    $env:GITHUB_REF_NAME -ne 'codex/verify-inapp-0428-0430') {
    throw 'Для проверки требуется отдельная ветка и одноразовая Windows 11 ARM64 GitHub.'
}
$repo = $env:GITHUB_WORKSPACE
$env:KAZNA_QA_SCRATCH = Join-Path $env:RUNNER_TEMP 'kazna-inapp-0428-0430'
$scratch = $env:KAZNA_QA_SCRATCH
$evidence = Join-Path $scratch 'evidence'
$env:KAZNA_QA_FIXTURE = Join-Path $PSScriptRoot 'fixture.py'
$fixture = $env:KAZNA_QA_FIXTURE
$windowScript = Join-Path $PSScriptRoot 'window.mjs'
$dataDir = Join-Path $env:APPDATA 'app.kazna.desktop'
$db = Join-Path $dataDir 'budget.db'
$releaseBase = 'https://github.com/Xoma1818/p-treasury-releases/releases'
$oldInstallerSha = '6aec9defa8e7279505265bcf4416ed557880ac30ced5473427295f1ba985368d'
$signedInstallerSha = '600bf54566d3288b55d248935d8eee58f4b0d3dae5b05b3ab94314240ee9adca'

function Get-Registration([string]$Name = 'Kazna') {
    foreach ($view in [Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32) {
        $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
        try {
            $key = $baseKey.OpenSubKey("Software\Microsoft\Windows\CurrentVersion\Uninstall\$Name")
            if ($null -ne $key) {
                try {
                    return [ordered]@{
                        registryView = $view.ToString()
                        version = [string]$key.GetValue('DisplayVersion')
                        folder = ([string]$key.GetValue('InstallLocation')).Trim('"')
                    }
                } finally { $key.Dispose() }
            }
        } finally { $baseKey.Dispose() }
    }
}
function Write-Report([string]$Name, $Data) {
    $json = $Data | ConvertTo-Json -Depth 12
    Set-Content -LiteralPath (Join-Path $evidence "$Name.json") -Value $json -Encoding utf8
    Write-Host $json
}
function Read-Report([string]$Name) {
    Get-Content -LiteralPath (Join-Path $evidence "$Name.json") -Raw -Encoding utf8 | ConvertFrom-Json
}
function Db-Fixture {
    & python $fixture @args
    if ($LASTEXITCODE -ne 0) { throw "Ошибка Python при выполнении $($args[0])." }
}
function Get-Executable($Registration, [string]$Version) {
    if (!$Registration -or $Registration.version -ne $Version -or !$Registration.folder) {
        throw "В профиле отсутствует регистрация Kazna $Version."
    }
    $file = Get-Item -LiteralPath (Join-Path $Registration.folder 'Kazna.exe')
    if ($file.VersionInfo.ProductVersion -notmatch ('^' + [regex]::Escape($Version) + '(?:\.0)?$')) {
        throw "Версия файла $($file.VersionInfo.ProductVersion) отличается от $Version."
    }
    $file.FullName
}
function Find-OneBackup([string]$Pattern) {
    $files = @(Get-ChildItem -LiteralPath (Join-Path $dataDir 'backups') -Filter $Pattern -File)
    if ($files.Count -ne 1) { throw "Нужна одна новая копия $Pattern. Найдено: $($files.Count)." }
    $files[0].FullName
}

if ($Stage -eq 'summary') {
    $lines = [Collections.Generic.List[string]]::new()
    $lines.Add('## Обновление Kazna из установленной 0.42.8')
    foreach ($phase in 'prepared','before','restart','after','comparison') {
        $path = Join-Path $evidence "$phase.json"
        if (Test-Path -LiteralPath $path) {
            $content = Get-Content -LiteralPath $path -Raw -Encoding utf8
            Write-Host "$phase $content"
            $lines.Add("### $phase")
            $lines.Add('```json')
            $lines.Add($content)
            $lines.Add('```')
        } else {
            $lines.Add("- $phase — отчёт отсутствует")
        }
    }
    $lines | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Encoding utf8
    return
}
foreach ($overridden in 'PTREASURY_DATA_DIR','PTREASURY_DB','PTREASURY_BIN','PTREASURY_UPDATE_URL') {
    if ([Environment]::GetEnvironmentVariable($overridden)) { throw "Переопределена переменная $overridden." }
}
if ($Stage -eq 'prepare') {
    if ((Test-Path -LiteralPath $dataDir) -or (Test-Path -LiteralPath $scratch) -or
        (Get-Registration) -or (Get-Registration 'P-Treasury')) { throw 'Нужен чистый профиль.' }
    $os = Get-CimInstance Win32_OperatingSystem
    if ($os.Caption -notmatch 'Windows 11' -or [int]$os.BuildNumber -lt 22000) { throw $os.Caption }
    [void][IO.Directory]::CreateDirectory($evidence)
    foreach ($setting in @{WEBVIEW2_USER_DATA_FOLDER='webview'; PTREASURY_VAULT_DIR='vault'}.GetEnumerator()) {
        $folder = [IO.Directory]::CreateDirectory((Join-Path $scratch $setting.Value)).FullName
        "$($setting.Key)=$folder" | Add-Content -Encoding utf8 -LiteralPath $env:GITHUB_ENV
    }
    $channel = "$releaseBase/latest/download/latest.json"
    $manifestFile = Join-Path $evidence 'latest.json'
    Invoke-WebRequest -Uri $channel -OutFile $manifestFile -TimeoutSec 60
    $manifest = Get-Content -Raw -Encoding utf8 -LiteralPath $manifestFile | ConvertFrom-Json
    $manifestSha = (Get-FileHash -LiteralPath $manifestFile).Hash
    $target = "$releaseBase/download/v0.43.0/Kazna_0.43.0_x64-setup.exe"
    if ($manifest.version -ne '0.43.0') { throw "Канал предлагает $($manifest.version)." }
    foreach ($platform in 'windows-x86_64','windows-x86_64-nsis') {
        if ($manifest.platforms.$platform.url -cne $target -or !$manifest.platforms.$platform.signature) {
            throw "Отсутствует ожидаемая цель или подпись $platform."
        }
    }
    if ($manifestSha -ne '04ccb2c71c5d325ead142ac715cd2d71eb613fe6f4e954ca804e6082c6ab4744') {
        throw "Общедоступный манифест отличается от проверенного выпуска 0.43.0: $manifestSha."
    }
    $signedPackage = Join-Path $scratch 'official-0.43.0.nsis'
    Invoke-WebRequest -Uri $target -OutFile $signedPackage -TimeoutSec 120
    $downloadedPackageSha = (Get-FileHash -LiteralPath $signedPackage).Hash
    if ($downloadedPackageSha -ne $signedInstallerSha) { throw "SHA-256 подписанного установщика 0.43.0: $downloadedPackageSha." }
    # Этот файл используется только как эталон. Само обновление выполняет приложение.
    $unpacked = Join-Path $scratch 'reference-payload'
    & 7z.exe e -y "-o$unpacked" $signedPackage Kazna.exe
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось прочитать Kazna.exe из опубликованного NSIS.' }
    $nsisPayloadSha = (Get-FileHash -LiteralPath (Join-Path $unpacked 'Kazna.exe')).Hash
    $setup = Join-Path $scratch 'Kazna_0.42.8_x64-setup.exe'
    Invoke-WebRequest -Uri "$releaseBase/download/v0.42.8/Kazna_0.42.8_x64-setup.exe" -OutFile $setup -TimeoutSec 120
    if ((Get-FileHash -LiteralPath $setup).Hash -ne $oldInstallerSha) { throw 'SHA-256 установщика 0.42.8.' }
    $install = Start-Process -FilePath $setup -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
    if ($install.ExitCode -ne 0) { throw "Старая версия не установилась. Код $($install.ExitCode)." }
    $reg = Get-Registration
    $exe = Get-Executable $reg '0.42.8'
    Db-Fixture seed $repo $db
    Write-Report 'prepared' ([ordered]@{
        windows = $os.Caption; build = $os.BuildNumber; osArchitecture = $env:RUNNER_ARCH
        workflowCommit = $env:GITHUB_SHA; registration = $reg; exe = $exe; officialInstallerSha256 = $oldInstallerSha
        oldExeSha256 = (Get-FileHash -LiteralPath $exe).Hash; endpoint = $channel
        offeredByChannel = $manifest.version; targetUrl = $target; manifestSha256 = $manifestSha
        signedTargetInstallerSha256 = $downloadedPackageSha; expectedNsisPayloadSha256 = $nsisPayloadSha
    })
    return
}
$prepared = Read-Report 'prepared'
$exe = $prepared.exe
if ($Stage -in 'before','after') {
    if ($Stage -eq 'before') {
        # Наблюдатель фиксирует процессы. Ни установщик, ни новое окно он не запускает.
        $trace = Start-Job -ArgumentList $evidence, $env:TEMP -ScriptBlock {
            param($evidence, $tempPath)
            $log = Join-Path $evidence 'process-trace.jsonl'
            foreach ($kind in 'Start','Stop') {
                $query = "SELECT * FROM Win32_Process${kind}Trace WHERE ProcessName LIKE '%Kazna%' OR ProcessName LIKE '%installer%' OR ProcessName LIKE '%.tmp'"
                Register-CimIndicationEvent -Query $query -SourceIdentifier $kind | Out-Null
            }
            $hashed = $false
            do {
                foreach ($evt in @(Get-Event)) {
                    $p = $evt.SourceEventArgs.NewEvent
                    [ordered]@{time=$evt.TimeGenerated.ToUniversalTime().ToString('o');event=$evt.SourceIdentifier;name=$p.ProcessName;pid=$p.ProcessID;parent=$p.ParentProcessID;exitStatus=$p.ExitStatus} |
                        ConvertTo-Json -Compress | Add-Content -LiteralPath $log
                    Remove-Event -EventIdentifier $evt.EventIdentifier
                }
                if (!$hashed) {
                    $package = Get-ChildItem -Path "$tempPath/Kazna-0.43.0-updater-*/Kazna-0.43.0-installer.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1
                    if ($package -and $package.Length -eq 8351821) {
                        try {
                            [ordered]@{time=[DateTime]::UtcNow.ToString('o');file=$package.Name;bytes=$package.Length;sha256=(Get-FileHash -LiteralPath $package.FullName -ErrorAction Stop).Hash} |
                                ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'downloaded-by-app.json')
                            $hashed = $true
                        } catch {}
                    }
                }
                Start-Sleep -Milliseconds 300
            } while (!(Test-Path -LiteralPath (Join-Path $evidence 'observation-complete')))
        }
    }
    try {
        & node $windowScript $Stage $exe $evidence
        if ($LASTEXITCODE -ne 0) { throw "Оконная проверка $Stage завершилась с кодом $LASTEXITCODE." }
    } finally {
        if ($Stage -eq 'before') {
            [IO.File]::WriteAllText((Join-Path $evidence 'observation-complete'),'')
            $null = Wait-Job $trace -Timeout 5
            Receive-Job $trace -ErrorAction Continue
        }
    }
    $result = Read-Report $Stage
    Write-Host ($result | ConvertTo-Json -Depth 12)
    return
}
if ($Stage -eq 'restart') {
    $oldPid = (Read-Report 'before').oldPid
    if (!$oldPid) { throw 'Неизвестен PID исходного окна.' }
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        $registration = Get-Registration
        $running = @(Get-Process -Name Kazna -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })
        $fresh = @($running | Where-Object { $_.Id -ne $oldPid -and $_.MainWindowHandle -ne 0 })
        if ($running.Count -eq 1 -and $fresh.Count -eq 1 -and $registration.version -eq '0.43.0') { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    $file = Get-Item -LiteralPath $exe -ErrorAction SilentlyContinue
    Write-Report 'restart-inspection' ([ordered]@{
        registration=$registration; diskVersion=$file.VersionInfo.ProductVersion
        diskSha256=if ($file){(Get-FileHash -LiteralPath $exe).Hash}
        visible=@(Get-Process | Where-Object { $_.ProcessName -like '*Kazna*' -or $_.ProcessName -like '*installer*' } | Select-Object ProcessName,Id,Path,MainWindowTitle)
        crashes=@(Get-WinEvent -FilterHashtable @{LogName='Application';Id=1000,1001;StartTime=(Get-Date).AddMinutes(-6)} -ErrorAction SilentlyContinue | Where-Object Message -match 'Kazna' | Select-Object TimeCreated,Id,Message)
    })
    if ($running.Count -ne 1 -or $fresh.Count -ne 1) {
        if ((Get-Executable $registration '0.43.0') -ne $exe -or (Get-FileHash $exe).Hash -ne $prepared.expectedNsisPayloadSha256) {
            throw 'Обновлённый файл или путь установки не подтверждены.'
        }
        if ($running.Count) { throw 'Есть процесс без подтверждённого нового окна. Второй экземпляр не открываем.' }
        Write-Report 'restart' ([ordered]@{automaticRelaunch=$false;oldPid=$oldPid;registeredVersion=$registration.version;installedExe=$exe;installedExeSha256=(Get-FileHash $exe).Hash})
        return
    }
    $restarted = $fresh[0]
    if ((Get-Executable $registration '0.43.0') -ne $exe) { throw 'Поменялся путь установки.' }
    $hash = (Get-FileHash -LiteralPath $exe).Hash
    if ($hash -ne $prepared.expectedNsisPayloadSha256) { throw "SHA-256 перезапущенного файла $hash отличается от Kazna.exe из NSIS." }
    Db-Fixture snapshot $db (Join-Path $scratch 'restarted.sqlite')
    Write-Report 'restart' ([ordered]@{
        automaticRelaunch = $true; oldPid = $oldPid; newPid = $restarted.Id; registeredVersion = $registration.version
        installedExe = $exe; installedExeSha256 = $hash; windowTitle = $restarted.MainWindowTitle
        windowHandle = $restarted.MainWindowHandle.ToInt64(); processStartUtc = $restarted.StartTime.ToUniversalTime().ToString('o')
    })
    # У учебной базы close_to_tray=0. Закрываем уже обнаруженное новое окно, затем открываем его для WebDriver.
    if (!$restarted.CloseMainWindow() -or !$restarted.WaitForExit(30000)) { throw 'Не удалось штатно закрыть новое окно.' }
    return
}
$preInstall = Find-OneBackup 'before-app-update-*.db'
$beforeSnapshot = Join-Path $scratch 'before.sqlite'
$restartSnapshot = Join-Path $scratch 'restarted.sqlite'
$afterSnapshot = Join-Path $scratch 'after.sqlite'
Db-Fixture snapshot $db $afterSnapshot
$snapshots = [IO.Directory]::CreateDirectory((Join-Path $evidence 'snapshots')).FullName
$automatic = (Read-Report 'restart').automaticRelaunch
$copies = @($beforeSnapshot, $afterSnapshot, $preInstall)
if ($automatic) { $copies += $restartSnapshot }
foreach ($file in $copies) {
    Copy-Item -LiteralPath $file -Destination $snapshots
}
if ($automatic) { Db-Fixture verify $repo $beforeSnapshot $restartSnapshot $preInstall (Join-Path $evidence 'restart-verification.json') }
Db-Fixture verify $repo $beforeSnapshot $afterSnapshot $preInstall (Join-Path $evidence 'app-verification.json')
$checked = Read-Report 'app-verification'
Write-Report 'comparison' ([ordered]@{
    schemaBefore = $checked.before.schema; schemaAfter = $checked.after.schema; tables = $checked.after.tablesCompared
    settings = @($checked.after.allSettings.PSObject.Properties).Count; transactions = $checked.after.transactionCount
    accounts = $checked.after.accounts; totalBalanceRubMinor = $checked.after.totalBalanceRubMinor
    incomeRubMinor = $checked.after.incomeRubMinor; expenseRubMinor = $checked.after.expenseRubMinor
    appBackup = $preInstall; appBackupRowsMatch = $true; automaticRestartRowsMatch = $automatic
})
if (!$automatic) { throw 'Данные после открытия обновлённой программы совпали, самостоятельный перезапуск не подтверждён.' }
