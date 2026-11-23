@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
set "kit=%~dp0"
if not exist "%kit%app\Kazna.exe" goto :incomplete
if not exist "%kit%app\prepare_ux_pilot.exe" goto :incomplete
echo Kazna — учебная встреча
echo.
echo 1. Аренда
echo 2. Бюджет
choice /c 12 /n /m "Выберите задание (1 или 2): "
if errorlevel 255 goto :failed
if errorlevel 2 goto :budget
if not errorlevel 1 exit /b 1
set "scenario=rent"
goto :prepare
:budget
set "scenario=budget"
:prepare
set "visits=%kit%visits"
if not exist "%visits%\" mkdir "%visits%"
if not exist "%visits%\" goto :failed
:newvisit
set "profile=%visits%\%scenario%-%RANDOM%-%RANDOM%"
if exist "%profile%" goto :newvisit
"%kit%app\prepare_ux_pilot.exe" %scenario% "%profile%"
if errorlevel 1 goto :failed
set "WEBVIEW2_USER_DATA_FOLDER=%profile%\webview"
set "PTREASURY_VAULT_DIR=%profile%\Kazna"
set "PTREASURY_PERF_LOG="
if "%scenario%"=="rent" start "" explorer.exe /select,"%profile%\аренда.csv"
start "" "%kit%app\Kazna.exe" "--data-dir=%profile%"
if errorlevel 1 goto :failed
exit /b 0
:incomplete
echo Распакуйте весь учебный архив в отдельную папку и откройте этот файл снова.
pause
exit /b 1
:failed
echo Не удалось начать встречу. Проверьте сообщение выше и доступ на запись в папку набора.
pause
exit /b 1
