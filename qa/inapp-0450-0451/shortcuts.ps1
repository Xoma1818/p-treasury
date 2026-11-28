param([Parameter(Mandatory)][string]$Exe,[Parameter(Mandatory)][ValidateSet('before','after')][string]$Phase,[Parameter(Mandatory)][string]$Evidence)
$ErrorActionPreference='Stop'
if($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or $env:GITHUB_REF_NAME -ne 'codex/verify-inapp-0450-0451'){throw 'Disposable Windows expected'}
& "$env:GITHUB_WORKSPACE/scripts/windows-brand-assets.ps1" -CheckExe $Exe
$w=New-Object -ComObject WScript.Shell
$shell=New-Object -ComObject Shell.Application
$source=Join-Path (Split-Path $Exe) 'kazna-fold.ico'
if($Phase -eq 'after' -and (Get-FileHash $source).Hash -ne (Get-FileHash "$env:GITHUB_WORKSPACE/src-tauri/icons/icon.ico").Hash){throw 'ICO differs from the released mark'}
$entries=[ordered]@{}
foreach($place in 'DesktopDirectory','Programs'){
    $dir=[Environment]::GetFolderPath($place)
    $path=(Get-Item -LiteralPath (Join-Path $dir 'Kazna.lnk')).FullName
    $link=$w.CreateShortcut($path)
    $appId=$shell.NameSpace($dir).ParseName('Kazna.lnk').ExtendedProperty('System.AppUserModel.ID')
    if($link.TargetPath -ne $Exe -or $link.Arguments -or ($place -eq 'Programs' -and $appId -ne 'app.kazna.desktop')){throw "Unexpected link properties $place"}
    if($Phase -eq 'after'){
        $before=Get-Content -Encoding utf8 -LiteralPath (Join-Path $Evidence 'before-shortcuts.json') -Raw|ConvertFrom-Json
        if([string]$before.$place.appId -ne [string]$appId){throw "Changed AppUserModel.ID $place"}
    }
    if($Phase -eq 'after' -and $link.IconLocation -ne "$source,0"){throw "Missing updated source $place"}
    $icon=[KaznaIconGroup]::FromShell($path)
    try{
        $image=[Windows.Interop.Imaging]::CreateBitmapSourceFromHIcon($icon,[Windows.Int32Rect]::Empty,[Windows.Media.Imaging.BitmapSizeOptions]::FromEmptyOptions())
        $bitmap=[Windows.Media.Imaging.FormatConvertedBitmap]::new($image,[Windows.Media.PixelFormats]::Bgra32,$null,0)
        $stride=4*$bitmap.PixelWidth
        $pixels=[byte[]]::new($stride*$bitmap.PixelHeight); $bitmap.CopyPixels($pixels,$stride,0)
        $coral=0;$lime=0
        for($i=0;$i -lt $pixels.Length;$i+=4){
            $b,$g,$r,$a=$pixels[$i..($i+3)]
            if($a -ge 245 -and $r -gt 230 -and $g -ge 125 -and $g -lt 185 -and $b -le 150){$coral++}
            if($a -ge 245 -and $g -gt 200 -and $r -lt 205 -and $b -lt 140){$lime++}
        }
        if($coral -le ($bitmap.PixelWidth*$bitmap.PixelHeight/5) -or $lime -gt 0){throw "Unexpected Shell bitmap $place coral=$coral lime=$lime"}
        $encoder=[Windows.Media.Imaging.PngBitmapEncoder]::new()
        $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
        $file=Join-Path $Evidence "$Phase-shell-$place.png"
        $stream=[IO.File]::Create($file)
        try{$encoder.Save($stream)}finally{$stream.Dispose()}
        $entries[$place]=[ordered]@{target=$link.TargetPath;iconLocation=$link.IconLocation;arguments=$link.Arguments;appId=$appId;coral=$coral;lime=$lime;imageSha256=(Get-FileHash $file).Hash}
    } finally{[void][KaznaIconGroup]::DestroyIcon($icon)}
}
$json=$entries|ConvertTo-Json -Depth 4
Set-Content -LiteralPath (Join-Path $Evidence "$Phase-shortcuts.json") -Encoding utf8 -Value $json
Write-Host $json
