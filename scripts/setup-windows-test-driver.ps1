# Подбирает EdgeDriver к установленному WebView2 на одноразовой Windows GitHub Actions.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Драйвер устанавливается только на одноразовой Windows GitHub Actions.'
}
$product = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$roots = @('HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients')
$version = $roots | ForEach-Object {
    (Get-ItemProperty -LiteralPath (Join-Path $_ $product) -ErrorAction SilentlyContinue).pv
} | Where-Object { $_ } | Select-Object -First 1
if (!$version) {
    $binaries = foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($root) { Get-ChildItem -Path "$root\Microsoft\EdgeWebView\Application\*\msedgewebview2.exe" -File -ErrorAction SilentlyContinue }
    }
    $version = $binaries | ForEach-Object { [version]$_.VersionInfo.ProductVersion } | Sort-Object -Descending | Select-Object -First 1
}
if (!$version) { throw 'Не удалось найти установленный WebView2.' }
$zip = switch ($env:RUNNER_ARCH) {
    'ARM64' { 'edgedriver_arm64.zip' }
    'X64' { 'edgedriver_win64.zip' }
    default { throw "Драйвер для архитектуры $env:RUNNER_ARCH не выбран." }
}
$folder = New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP 'kazna-candidate-driver')
$archive = Join-Path $folder.FullName 'driver.zip'
Invoke-WebRequest -Uri "https://msedgedriver.microsoft.com/$version/$zip" -OutFile $archive -TimeoutSec 90
Expand-Archive -LiteralPath $archive -DestinationPath $folder.FullName
$reported = & (Join-Path $folder.FullName 'msedgedriver.exe') --version
if ($LASTEXITCODE -ne 0 -or $reported -notmatch [regex]::Escape([string]$version)) { throw "WebDriver '$reported' не совпадает с WebView2 $version." }
Write-Host $reported
Add-Content -LiteralPath $env:GITHUB_PATH -Value $folder.FullName
