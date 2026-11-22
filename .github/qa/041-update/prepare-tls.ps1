param([Parameter(Mandatory)][string]$Folder)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or $env:GITHUB_REPOSITORY -ne 'Xoma1818/p-treasury') { throw 'Dedicated disposable Windows runner required' }
$admin = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (!$admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'The ephemeral machine trust store requires a hosted runner administrator.' }
Write-Host 'Creating one-job TLS certificates'
$ca = New-SelfSignedCertificate -Type Custom -Subject "CN=Kazna-QA-$([Guid]::NewGuid().ToString('N'))" -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -KeyUsage CertSign,CRLSign -TextExtension '2.5.29.19={critical}{text}ca=1&pathlength=0' -NotAfter (Get-Date).AddDays(1) -CertStoreLocation Cert:\CurrentUser\My
[IO.File]::WriteAllText((Join-Path $Folder 'ca-thumbprint.txt'), $ca.Thumbprint)
$leaf = New-SelfSignedCertificate -DnsName 'localhost' -Type SSLServerAuthentication -Signer $ca -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddHours(6) -CertStoreLocation Cert:\CurrentUser\My
[IO.File]::WriteAllText((Join-Path $Folder 'leaf-thumbprint.txt'), $leaf.Thumbprint)
# Import only the public CA in the disposable machine root store. CurrentUser Root can show a trust confirmation.
$publicCa = Join-Path $Folder 'public-ca.cer'
[IO.File]::WriteAllBytes($publicCa, $ca.RawData)
Write-Host 'Installing public CA in disposable LocalMachine Root'
& certutil.exe -f -addstore Root $publicCa
if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath "Cert:\LocalMachine\Root\$($ca.Thumbprint)")) { throw 'Cannot establish trust for the local TLS feed' }
