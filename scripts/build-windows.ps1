# Сборка установщика «Казны» на компьютере с Windows.
#   1. Один раз установить: Node.js 22 (nodejs.org), Rust (rustup.rs),
#      «Средства сборки Visual Studio» с компонентом «Разработка классических приложений на C++».
#   2. В папке с кодом: powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
#      Ключ подписи обновлений (необязательно): -Key путь\к\kazna-updater.key
# Готовый установщик появится в папке installer\.
param([string]$Key = "")
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

foreach ($tool in "node", "npm", "cargo") {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "Не найден $tool. Установите его (см. начало этого файла) и откройте PowerShell заново."
  }
}

npm ci
if ($LASTEXITCODE) { throw "npm ci завершился с ошибкой" }

$extra = @()
if ($Key -and (Test-Path $Key)) {
  $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $Key -Raw
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
} else {
  # Без ключа установщик собирается, но без файла подписи для автообновления.
  $extra = @("--config", "src-tauri\tauri.nokey.conf.json")
}

npx tauri build --bundles nsis @extra
if ($LASTEXITCODE) { throw "Сборка завершилась с ошибкой" }

New-Item -ItemType Directory -Force installer | Out-Null
Copy-Item target\release\bundle\nsis\*.exe installer\ -Force
Get-ChildItem installer\*.exe | ForEach-Object { Write-Host "Готово: $($_.FullName)" }
