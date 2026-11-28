param([string]$Evidence)
$ErrorActionPreference='Stop'
if($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_REF_NAME -ne 'codex/verify-inapp-0450-0451'){throw 'Disposable QA runner required'}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class KaznaSetupWindow {
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr w,IntPtr dc,uint flags);
}
'@
$end=[DateTime]::UtcNow.AddMinutes(4)
$previous=''
while([DateTime]::UtcNow -lt $end -and !(Test-Path -LiteralPath (Join-Path $Evidence 'observation-complete'))){
    foreach($proc in @(Get-Process -Name 'Kazna-0.45.1-installer' -ErrorAction SilentlyContinue)){
        $processInfo=Get-CimInstance Win32_Process -Filter "ProcessID=$($proc.Id)" -ErrorAction SilentlyContinue
        $cond=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$proc.Id)
        $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,$cond)
        $rows=@(foreach($win in $windows){
          $all=$win.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
          $names=@(foreach($el in $all){if($el.Current.Name){[ordered]@{role=$el.Current.ControlType.ProgrammaticName;name=$el.Current.Name}}})
          [ordered]@{pid=$proc.Id;title=$win.Current.Name;hwnd=$win.Current.NativeWindowHandle;contents=$names}
        })
        $json=[ordered]@{command=$processInfo.CommandLine;windows=$rows}|ConvertTo-Json -Compress -Depth 6
        if($json -ne $previous){
            $previous=$json
            [ordered]@{at=[DateTime]::UtcNow.ToString('o');observed=($json|ConvertFrom-Json)}|ConvertTo-Json -Compress -Depth 9|Add-Content -Encoding utf8 -LiteralPath (Join-Path $Evidence 'setup-UI.jsonl')
            foreach($win in $windows){$b=$win.Current.BoundingRectangle
             if($b.Width -lt 5 -or $b.Height -lt 5 -or $b.Width -gt 3000 -or $b.Height -gt 2000){continue}
             $bmp=[Drawing.Bitmap]::new([int]$b.Width,[int]$b.Height)
             try{$graphics=[Drawing.Graphics]::FromImage($bmp)
              try{$dc=$graphics.GetHdc();try{$ok=[KaznaSetupWindow]::PrintWindow([intptr]$win.Current.NativeWindowHandle,$dc,2)}finally{$graphics.ReleaseHdc($dc)}}finally{$graphics.Dispose()}
              if($ok){$bmp.Save((Join-Path $Evidence "setup-window-$($win.Current.NativeWindowHandle).png"),[Drawing.Imaging.ImageFormat]::Png)}
             }finally{$bmp.Dispose()}
            }
        }
    }
    Start-Sleep -Milliseconds 750
}
