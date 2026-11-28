; 0.26: the app used to be called P-Treasury. After installing Kazna, silently
; remove the old copy so there are not two apps. The old folder is taken from the
; old uninstall key (the user may have chosen any folder), with the default
; $LOCALAPPDATA\P-Treasury as a fallback.
; Silent mode (/S) keeps user data: the database stays in %APPDATA%\app.kazna.desktop.
; (ASCII only: makensis reads this file without a BOM.)
!define KAZNA_OLD_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\P-Treasury"

; An in-app update replaces the EXE at the same path. Explorer can keep the
; previous artwork for links using the EXE's default icon. Move those links
; to a distinct icon path; keep their arguments, AppUserModelID and user icon.
; $R8 is the installed EXE; $R9 is a candidate .lnk in the install scope.
Function KaznaRefreshShortcut
  IfFileExists "$R9" 0 done_icon
  !insertmacro ComHlpr_CreateInProcInstance ${CLSID_ShellLink} ${IID_IShellLink} r0 ""
  ${If} $0 P= 0
    Return
  ${EndIf}
  ${IUnknown::QueryInterface} $0 '("${IID_IPersistFile}", .r1)'
  ${If} $1 P= 0
    Goto release_link
  ${EndIf}

  ${IPersistFile::Load} $1 '("$R9", ${STGM_READWRITE}).r4'
  StrCmp $4 0 0 release_file
  ${IShellLink::GetPath} $0 '(.r2, ${NSIS_MAX_STRLEN}, 0, ${SLGP_RAWPATH}).r4'
  StrCmp $4 0 0 release_file
  StrCmp $2 $R8 0 release_file

  ${IShellLink::GetIconLocation} $0 '(.r2, ${NSIS_MAX_STRLEN}, .r3).r4'
  ${If} $4 < 0
  ${OrIf} $3 != 0
    Goto release_file
  ${EndIf}
  ${If} $2 == ""
  ${OrIf} $2 == $R8
    ${IShellLink::SetIconLocation} $0 '("$INSTDIR\kazna-fold.ico", 0).r4'
    StrCmp $4 0 0 release_file
    ${IPersistFile::Save} $1 '("$R9", 1).r4'
    StrCmp $4 0 0 release_file
    System::Call 'shell32::SHChangeNotify(i 0x2000, i 5, w "$R9", p 0)'
  ${EndIf}
  release_file:
    ${IUnknown::Release} $1 ""
  release_link:
    ${IUnknown::Release} $0 ""
  done_icon:
FunctionEnd

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
  System::Store "S"
  StrCpy $R8 "$INSTDIR\${MAINBINARYNAME}.exe"
  ; A new desktop link made later on the interactive Finish page uses the EXE.
  System::Call 'shell32::SHChangeNotify(i 0x2000, i 5, w "$R8", p 0)'
  StrCpy $R9 "$DESKTOP\${PRODUCTNAME}.lnk"
  Call KaznaRefreshShortcut
  StrCpy $R9 "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  Call KaznaRefreshShortcut
  System::Store "L"
!macroend
