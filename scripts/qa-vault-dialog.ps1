# Operate the real Win32 Common Item Dialog on a dedicated test desktop.
param([ValidateSet('folder','open','save','cancel','explorer')][string]$Mode, [string]$PathValue)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Dedicated GitHub Windows runner required' }
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
$tree = [System.Windows.Automation.TreeScope]
$ae = [System.Windows.Automation.AutomationElement]
$root = $ae::RootElement
function Find-Id($item, $id) {
    $filter = [System.Windows.Automation.PropertyCondition]::new($ae::AutomationIdProperty, $id)
    $item.FindFirst($tree::Descendants,$filter)
}
if ($Mode -eq 'explorer') {
    $shell = New-Object -ComObject Shell.Application
    $deadline=(Get-Date).AddSeconds(18)
    do {
        foreach ($win in $shell.Windows()) {
            try {
                if ([IO.Path]::GetFullPath($win.Document.Folder.Self.Path) -eq [IO.Path]::GetFullPath($PathValue)) {
                    Write-Output "Explorer opened requested folder"
                    $win.Quit()
                    exit 0
                }
            } catch { }
        }
        Start-Sleep -Milliseconds 200
    } until ((Get-Date) -gt $deadline)
    throw 'Explorer did not show the requested vault'
}
Add-Type -Path (Join-Path $PSScriptRoot 'QaDialogWindows.cs')
$processIds = @(Get-Process Kazna -ErrorAction Stop | ForEach-Object Id)
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
} else {
    $end = (Get-Date).AddSeconds(4)
    do {
        $entry=[KaznaDialogWindows]::FileNameEntry($raw.Handle)
        if ($entry -ne [IntPtr]::Zero) {break}
        Start-Sleep -Milliseconds 120
    } until ((Get-Date) -gt $end)
    if ($entry -eq [IntPtr]::Zero -or ![KaznaDialogWindows]::TypeName($entry,$PathValue)) {
        [KaznaDialogWindows]::Controls($raw.Handle) | Select-Object ID,ClassName,Title | ConvertTo-Json -Compress | Write-Output
        throw 'Native filename textbox could not accept value'
    }
    Start-Sleep -Milliseconds 180
    [KaznaDialogWindows]::Action($raw.Handle,1,$false)
}
for ($attempt=0; $attempt -lt 4; $attempt++) {
    Start-Sleep -Milliseconds 550
    if (![KaznaDialogWindows]::IsWindowVisible($raw.Handle)) { Write-Output 'Dialog closed'; exit 0 }
    [KaznaDialogWindows]::Action($raw.Handle,$actionId,$true)
}
[KaznaDialogWindows]::Controls($raw.Handle) | Select-Object ID,ClassName,Title | ConvertTo-Json -Compress | Write-Output
throw 'Native Common Item Dialog remained open'
