; 0.26: the app used to be called P-Treasury. After installing Kazna, silently
; remove the old copy so there are not two apps. The old folder is taken from the
; old uninstall key (the user may have chosen any folder), with the default
; $LOCALAPPDATA\P-Treasury as a fallback.
; Silent mode (/S) keeps user data: the database stays in %APPDATA%\app.kazna.desktop.
; (ASCII only: makensis reads this file without a BOM.)
!define KAZNA_OLD_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\P-Treasury"

!macro NSIS_HOOK_POSTINSTALL
  Push $R8
  Push $R9
  ReadRegStr $R9 HKCU "${KAZNA_OLD_KEY}" "InstallLocation"
  ; The installer writes the location in quotes: "C:\path".
  StrCpy $R8 $R9 1
  StrCmp $R8 '"' 0 +2
    StrCpy $R9 $R9 -1 1
  StrCmp $R9 "" 0 +2
    StrCpy $R9 "$LOCALAPPDATA\P-Treasury"
  ; Never run the old uninstaller over the folder Kazna was just installed to.
  StrCmp $R9 $INSTDIR done_old
  IfFileExists "$R9\uninstall.exe" 0 done_old
    ExecWait '"$R9\uninstall.exe" /S _?=$R9'
    ; With _?= the uninstaller does not delete itself: remove it and the empty folder.
    Delete "$R9\uninstall.exe"
    RMDir "$R9"
  done_old:
  Pop $R9
  Pop $R8
!macroend
