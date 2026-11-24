# Проверка настоящих NSIS-установщиков в отдельном одноразовом профиле GitHub.
param(
    [Parameter(Mandatory)][ValidateSet('clean','upgrade')][string]$Mode,
    [Parameter(Mandatory)][string]$CandidateInstaller,
    [Parameter(Mandatory)][string]$EvidenceDirectory,
    [string]$OldInstaller
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or !$IsWindows) {
    throw 'Для сценария требуется одноразовая виртуальная машина Windows от GitHub.'
}
$dataDir = Join-Path $env:APPDATA 'app.kazna.desktop'
$runnerTemp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path.TrimEnd('\')
$evidence = [IO.Path]::GetFullPath($EvidenceDirectory)
if (!$evidence.StartsWith($runnerTemp + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Результаты проверки должны находиться в RUNNER_TEMP.'
}
$scratch = Join-Path $runnerTemp ('kazna-installer-' + [guid]::NewGuid().ToString('N'))
$repo = Split-Path $PSScriptRoot -Parent

function Get-Registration([string]$name) {
    foreach ($view in [Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32) {
        $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
        try {
            $key = $root.OpenSubKey("Software\Microsoft\Windows\CurrentVersion\Uninstall\$name")
            if ($null -ne $key) {
                try {
                    return [pscustomobject]@{
                        Version = [string]$key.GetValue('DisplayVersion')
                        Folder = ([string]$key.GetValue('InstallLocation')).Trim('"')
                    }
                } finally { $key.Dispose() }
            }
        } finally { $root.Dispose() }
    }
}

function Install-Kazna([string]$setup, [string]$version) {
    $file = (Resolve-Path -LiteralPath $setup).Path
    $installer = Start-Process -FilePath $file -ArgumentList '/S' -WindowStyle Hidden -PassThru -Wait
    if ($installer.ExitCode -ne 0) { throw "Установщик $version завершился с кодом $($installer.ExitCode)." }
    $registration = Get-Registration 'Kazna'
    if ($null -eq $registration -or $registration.Version -ne $version -or !$registration.Folder) {
        throw "После установки версия $version не зарегистрирована для текущего пользователя."
    }
    $installed = (Get-Item -LiteralPath (Join-Path $registration.Folder 'Kazna.exe') -ErrorAction Stop).FullName
    return $installed
}

function Read-Window([string]$phase, [string]$exe) {
    $resultPath = Join-Path $scratch "$phase.json"
    & node (Join-Path $repo 'e2e/installed-candidate.mjs') $phase $exe $scratch $resultPath | Out-Host
    if ($LASTEXITCODE) { throw "Оконный сценарий $phase завершился с ошибкой." }
    $result = Get-Content -LiteralPath $resultPath -Encoding utf8 -Raw | ConvertFrom-Json
    if (!$result.dbPath -or [IO.Path]::GetFullPath($result.dbPath) -ne (Join-Path $dataDir 'budget.db')) {
        throw 'Установленная программа открыла другую базу.'
    }
    if (Get-Process -Name Kazna -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) {
        throw 'Проверяемое приложение осталось открытым.'
    }
    return $result
}

if ((Test-Path -LiteralPath $dataDir) -or (Get-Registration 'Kazna') -or (Get-Registration 'P-Treasury')) {
    throw 'В профиле уже есть данные или установленное приложение. Нужна чистая машина.'
}
foreach ($variable in 'PTREASURY_DATA_DIR','PTREASURY_DB','PTREASURY_BIN') {
    if ([Environment]::GetEnvironmentVariable($variable)) { throw "Для штатного запуска сбросьте $variable." }
}
if ($Mode -eq 'upgrade' -and (!$OldInstaller -or (Get-FileHash -LiteralPath $OldInstaller).Hash -ne 'e546c60af79e121677d10536aec1f7ca371a3bb5d8bf956f233c97cccf7d62bf')) {
    throw 'Нужен официальный установщик Kazna 0.42.1 с ожидаемой контрольной суммой.'
}
[void][IO.Directory]::CreateDirectory($scratch)
[void][IO.Directory]::CreateDirectory($evidence)
$env:KAZNA_INSTALLER_QA = '1'
$report = [ordered]@{
    mode = $Mode
    windowsBuild = [Environment]::OSVersion.Version.ToString()
    osArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    installerSHA256 = (Get-FileHash -LiteralPath $CandidateInstaller).Hash
}
if ($Mode -eq 'upgrade') {
    $oldExe = Install-Kazna $OldInstaller '0.42.1'
    $old = Read-Window 'seed-old' $oldExe
    $baseline = Join-Path $scratch 'before.db'
    # SQLite backup учитывает оставшийся WAL и создаёт самостоятельный снимок.
    & python -c 'import pathlib,sqlite3,sys; s=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+"?mode=ro",uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()' $old.dbPath $baseline
    if ($LASTEXITCODE) { throw 'Не удалось зафиксировать исходную базу.' }
    $report.oldVersion = $old.version
}
$exe = Install-Kazna $CandidateInstaller '0.42.8'
if ($Mode -eq 'clean') {
    $current = Read-Window 'verify-clean' $exe
} else {
    if ($exe -ne $oldExe) { throw 'Обновление установилось в другую папку.' }
    $current = Read-Window 'verify-upgrade' $exe
    if (!$current.preMigrationBackup) { throw 'Программа не сообщила путь предмиграционной копии.' }
    & python (Join-Path $PSScriptRoot 'compare-installed-upgrade.py') $baseline $current.dbPath $current.preMigrationBackup
    if ($LASTEXITCODE) { throw 'Сверка данных после обновления не прошла.' }
    $report.preserved = $true
}
$report.version = $current.version
$report.installedSHA256 = (Get-FileHash -LiteralPath $exe).Hash
$report | ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath (Join-Path $evidence "$Mode.json")
# База, профиль WebView2 и установленное приложение удаляются вместе с одноразовой машиной.
