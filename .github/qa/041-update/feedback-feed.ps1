param(
    [Parameter(Mandatory)][string]$Folder,
    [Parameter(Mandatory)][string]$Thumbprint
)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_REPOSITORY -ne 'Xoma1818/p-treasury') { throw 'Disposable project runner required.' }
$cert = Get-Item -LiteralPath "Cert:\CurrentUser\My\$Thumbprint"
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
try {
    $port = $listener.LocalEndpoint.Port
    $exe = 'Kazna_0.41.3_x64-setup.exe'
    $signed = @{
        url = "https://localhost:$port/$exe"
        signature = [IO.File]::ReadAllText((Join-Path $Folder "$exe.sig")).Trim()
    }
    $manifest = @{
        version = '0.41.3'
        notes = 'Isolated verification of the pull request installer'
        pub_date = [DateTimeOffset]::UtcNow.ToString('o')
        platforms = @{ 'windows-x86_64' = $signed; 'windows-x86_64-nsis' = $signed }
    }
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Folder 'latest.json') -Encoding utf8NoBOM
    # Only the local manifest changes. The downloaded installer and both published signatures stay byte-identical.
    # The deliberately higher offer is only for this negative test on loopback.
    $manifest.version = '0.41.4'
    $signed.signature = [IO.File]::ReadAllText((Join-Path $Folder 'previous-installer.sig')).Trim()
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Folder 'different-signature.json') -Encoding utf8NoBOM
    $modeFile = Join-Path $Folder 'scenario.txt'
    [IO.File]::WriteAllText($modeFile, 'normal')
    [IO.File]::WriteAllText((Join-Path $Folder 'endpoint.txt'), "https://localhost:$port/latest.json")
    $stop = Join-Path $Folder 'stop'
    while (!(Test-Path -LiteralPath $stop)) {
        if (!$listener.Pending()) { Start-Sleep -Milliseconds 100; continue }
        $client = $listener.AcceptTcpClient()
        $client.ReceiveTimeout = 10000
        $client.SendTimeout = 15000
        $ssl = [Net.Security.SslStream]::new($client.GetStream(), $false)
        try {
            $ssl.AuthenticateAsServer($cert, $false, [Security.Authentication.SslProtocols]::Tls12, $false)
            $reader = [IO.StreamReader]::new($ssl, [Text.Encoding]::ASCII, $false, 4096, $true)
            try {
                $request = $reader.ReadLine()
                for ($i = 0; $i -lt 100; $i++) {
                    if ([string]::IsNullOrEmpty($reader.ReadLine())) { break }
                }
                if ($request -notmatch '^GET /(latest\.json|Kazna_0\.41\.3_x64-setup\.exe) HTTP/1\.[01]$') {
                    $ssl.Write([Text.Encoding]::ASCII.GetBytes("HTTP/1.1 404 Not Found`r`nContent-Length: 0`r`nConnection: close`r`n`r`n"))
                    continue
                }
                $name = $Matches[1]
                $mode = [IO.File]::ReadAllText($modeFile).Trim()
                if ($mode -eq 'network' -and $name -eq 'latest.json') {
                    Add-Content -LiteralPath (Join-Path $Folder 'requests.txt') -Value 'network:latest.json'
                    # Close the established connection before sending an HTTP response.
                    continue
                }
                $payload = if ($mode -eq 'signature' -and $name -eq 'latest.json') { 'different-signature.json' } else { $name }
                $file = [IO.File]::OpenRead((Join-Path $Folder $payload))
                try {
                    $type = if ($name -eq 'latest.json') { 'application/json' } else { 'application/octet-stream' }
                    $header = "HTTP/1.1 200 OK`r`nContent-Type: $type`r`nContent-Length: $($file.Length)`r`nConnection: close`r`n`r`n"
                    $ssl.Write([Text.Encoding]::ASCII.GetBytes($header))
                    $file.CopyTo($ssl)
                    $ssl.Flush()
                    Add-Content -LiteralPath (Join-Path $Folder 'requests.txt') -Value $name
                    Add-Content -LiteralPath (Join-Path $Folder 'requests.txt') -Value "${mode}:$name"
                } finally { $file.Dispose() }
            } finally { $reader.Dispose() }
        } catch { Write-Warning $_.Exception.Message }
        finally { $ssl.Dispose(); $client.Dispose() }
    }
} finally { $listener.Stop() }
