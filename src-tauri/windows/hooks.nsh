; 0.26: the app used to be called P-Treasury and lived in $LOCALAPPDATA\P-Treasury.
; After installing Kazna, silently remove the old copy so there are not two apps.
; Silent mode (/S) keeps user data: the database stays in %APPDATA%\app.kazna.desktop.
; (ASCII only: makensis reads this file without a BOM.)
!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$LOCALAPPDATA\P-Treasury\uninstall.exe" 0 done_old
    ExecWait '"$LOCALAPPDATA\P-Treasury\uninstall.exe" /S _?=$LOCALAPPDATA\P-Treasury'
    ; With _?= the uninstaller does not delete itself: remove it and the empty folder.
    Delete "$LOCALAPPDATA\P-Treasury\uninstall.exe"
    RMDir "$LOCALAPPDATA\P-Treasury"
  done_old:
!macroend
