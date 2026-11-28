param([Parameter(Mandatory)][int]$OwnerPid,[Parameter(Mandatory)][string]$Path,[ValidateSet("accept","cancel","proposed")][string]$Mode="accept")
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Disposable runner required'}
$rootFolder=[IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP 'kazna-file-output')) + [IO.Path]::DirectorySeparatorChar
$PathValue=[IO.Path]::GetFullPath($Path)
if(!$PathValue.StartsWith($rootFolder,[StringComparison]::OrdinalIgnoreCase)){throw 'Outside synthetic fixture'}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$ae=[System.Windows.Automation.AutomationElement]
$tree=[System.Windows.Automation.TreeScope]
$root=$ae::RootElement
Add-Type -Path (Join-Path $PSScriptRoot 'QaDialogWindows.cs')
$exe=[IO.Path]::GetFullPath($env:PTREASURY_BIN)
$processIds=@(Get-CimInstance Win32_Process -Filter "Name='Kazna.exe'" | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath,$exe,[StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine.Contains('files-budget') } | ForEach-Object ProcessId)
if($processIds.Count -ne 1){throw "Expected a single fixture Kazna.exe; got $($processIds.Count), initial PID $OwnerPid"}
$deadline=(Get-Date).AddSeconds(22)
do {
    $windows = @([KaznaDialogWindows]::All())
    $raw = $windows | Where-Object {
        $_.ClassName -eq '#32770' -and ($_.ProcessId -in $processIds -or $_.OwnerId -in $processIds -or $_.Title -match 'Open|Save|Folder|Select|Browse')
    } | Select-Object -First 1
    if ($raw) {
        $dlg=$ae::FromHandle($raw.Handle)
        Write-Output ("Win32 dialog PID {0}, owner {1}, title {2}" -f $raw.ProcessId,$raw.OwnerId,$raw.Title)
        break
    }
    Start-Sleep -Milliseconds 130
} until ((Get-Date) -gt $deadline)
if (!$dlg) {
    $windows | Select-Object ProcessId,OwnerId,ClassName,Title | ConvertTo-Json -Compress | Write-Output
    $root.FindAll($tree::Children,[System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current | Select-Object ProcessId,ClassName,Name } | ConvertTo-Json -Compress | Write-Output
    throw 'No File Dialog belonging to Kazna on the desktop'
}
Write-Output ("Native {0}: {1}" -f $Mode,$dlg.Current.Name)
if ($raw.ProcessId -notin $processIds -and $raw.OwnerId -notin $processIds) {throw 'Dialog not owned by the test executable'}
[void][KaznaDialogWindows]::SetForegroundWindow($raw.Handle)
$actionId = if ($Mode -eq 'cancel') {2} else {1}
if ($Mode -eq 'cancel') {
    [KaznaDialogWindows]::Action($raw.Handle,2,$false)
} elseif ($Mode -eq 'proposed') {
    Start-Sleep -Milliseconds 550
    [KaznaDialogWindows]::Action($raw.Handle,1,$false)
} else {
    $end = (Get-Date).AddSeconds(4)
    do {
        $entry=[KaznaDialogWindows]::FileNameEntry($raw.Handle)
        if ($entry -ne [IntPtr]::Zero) {break}
        Start-Sleep -Milliseconds 120
    } until ((Get-Date) -gt $end)
    Start-Sleep -Milliseconds 620
    if ($entry -eq [IntPtr]::Zero -or ![KaznaDialogWindows]::TypeName($entry,$PathValue,($Mode -eq 'save'))) {
        [KaznaDialogWindows]::Controls($raw.Handle) | Select-Object ID,ClassName,Title | ConvertTo-Json -Compress | Write-Output
        throw 'Native filename textbox could not accept value'
    }
    Start-Sleep -Milliseconds 250
    if ([KaznaDialogWindows]::Value($entry) -ne $PathValue) {
        throw 'The dialog replaced the typed filename before confirmation'
    }
    Write-Output ('Filename in visible Edit: ' + [KaznaDialogWindows]::Value($entry))
    [KaznaDialogWindows]::Action($raw.Handle,1,$false)
}
for ($attempt=0; $attempt -lt 4; $attempt++) {
    Start-Sleep -Milliseconds 550
    if (![KaznaDialogWindows]::IsWindowVisible($raw.Handle)) { Write-Output 'Dialog closed'; exit 0 }
    [KaznaDialogWindows]::Action($raw.Handle,$actionId,$true)
}
[KaznaDialogWindows]::Controls($raw.Handle) | Select-Object ID,ClassName,Title | ConvertTo-Json -Compress | Write-Output
throw 'Native Common Item Dialog remained open'
