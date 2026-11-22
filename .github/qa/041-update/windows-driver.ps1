$ErrorActionPreference='Stop'
$keys=@('HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}')
$v=$keys | ForEach-Object { (Get-ItemProperty -LiteralPath $_ -ErrorAction SilentlyContinue).pv } | Where-Object { $_ } | Select-Object -First 1
if (!$v) {
    $binaries = foreach ($programRoot in @(${env:ProgramFiles(x86)},$env:ProgramFiles)) {
        if ($programRoot) {
            Get-ChildItem -Path (Join-Path $programRoot 'Microsoft/EdgeWebView/Application/*/msedgewebview2.exe') -File -ErrorAction SilentlyContinue
        }
    }
    $v = $binaries | ForEach-Object { [version]$_.VersionInfo.ProductVersion } | Sort-Object -Descending | Select-Object -First 1
}
if (!$v) { throw 'Cannot identify the WebView2 version.' }
$name=if ($env:RUNNER_ARCH -eq 'ARM64') { 'edgedriver_arm64.zip' } else { 'edgedriver_win64.zip' }
$dir=Join-Path $env:RUNNER_TEMP 'qa-041-driver'
New-Item -ItemType Directory -Path $dir | Out-Null
Invoke-WebRequest -Uri "https://msedgedriver.microsoft.com/$v/$name" -OutFile "$dir/driver.zip" -TimeoutSec 80
Expand-Archive -LiteralPath "$dir/driver.zip" -DestinationPath $dir
$reported = & "$dir/msedgedriver.exe" --version
if ($LASTEXITCODE -ne 0 -or $reported -notmatch [regex]::Escape([string]$v)) { throw "WebDriver '$reported' does not match WebView2 $v." }
Write-Host $reported
Add-Content $env:GITHUB_PATH $dir
