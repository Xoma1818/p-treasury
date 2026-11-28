param([Parameter(Mandatory)][int]$OwnerPid,[Parameter(Mandatory)][string]$Path,[ValidateSet("accept","cancel")][string]$Mode="accept")
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Disposable runner required'}
$root=[IO.Path]::GetFullPath((Join-Path $env:RUNNER_TEMP 'kazna-file-output')) + [IO.Path]::DirectorySeparatorChar
if(![IO.Path]::GetFullPath($Path).StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'Outside synthetic fixture'}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PickerOwner {
 [DllImport("user32")] public static extern IntPtr GetAncestor(IntPtr hwnd,uint mode);
 [DllImport("user32")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 public static int Id(IntPtr hwnd) {uint pid;GetWindowThreadProcessId(GetAncestor(hwnd,3),out pid);return (int)pid;}
}
'@
$desktop=[Windows.Automation.AutomationElement]::RootElement
$desc=[Windows.Automation.TreeScope]::Descendants
$all=[Windows.Automation.Condition]::TrueCondition
function ById([string]$id){[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,$id)}
$until=[DateTime]::UtcNow.AddSeconds(35)
do{
 $dialog=$null
 foreach($w in $desktop.FindAll([Windows.Automation.TreeScope]::Children,$all)){
  if($w.Current.ClassName -eq '#32770' -and ($w.Current.ProcessId -eq $OwnerPid -or [PickerOwner]::Id([IntPtr]$w.Current.NativeWindowHandle) -eq $OwnerPid)){$dialog=$w;break}
 }
 if(!$dialog){Start-Sleep -Milliseconds 120}
}while(!$dialog -and [DateTime]::UtcNow -lt $until)
if(!$dialog){throw "Kazna PID $OwnerPid did not show a native file dialog"}
$title=$dialog.Current.Name
if($Mode -eq 'accept'){
 $editor=$dialog.FindFirst($desc,(ById '1001'))
 if(!$editor){$hostEl=$dialog.FindFirst($desc,(ById 'FileNameControlHost'));if($hostEl){$editor=$hostEl.FindFirst($desc,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit))}}
 if(!$editor){throw "File name box missing: $title"}
 $editor.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($Path)
}
$btnId=if($Mode -eq 'accept'){'1'}else{'2'}
$ok=$dialog.FindFirst($desc,(ById $btnId))
if(!$ok){throw "Native button missing: $btnId"}
$ok.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
[pscustomobject]@{window=$title;action=$Mode;file=[IO.Path]::GetFileName($Path)}|ConvertTo-Json -Compress
