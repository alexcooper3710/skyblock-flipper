@echo off
setlocal enabledelayedexpansion
title SkyBlock Flipper
cd /d "%~dp0"

set "LOG=%~dp0flipper-run.log"
echo SkyBlock Flipper launcher - %DATE% %TIME% > "%LOG%"

where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js / npm was not found on PATH.
  echo Install Node 20+ from https://nodejs.org then run this again.
  echo npm not on PATH >> "%LOG%"
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set "NODEV=%%v"
for /f "delims=" %%v in ('npm -v') do set "NPMV=%%v"
echo node !NODEV!  npm !NPMV! >> "%LOG%"
echo node !NODEV!  npm !NPMV!

if not exist node_modules (
  echo Installing dependencies - this downloads Electron and takes a few minutes...
  call :RUN "npm install --no-audit --no-fund"
)

REM Electron writes path.txt only after its ~100MB binary finishes downloading.
REM No path.txt means the download failed, and npm start will refuse to run.
if not exist "node_modules\electron\path.txt" (
  echo.
  echo Electron binary is missing or incomplete. Repairing...
  echo repairing electron >> "%LOG%"
  call :CLEANELECTRON
  call :RUN "npm install --no-audit --no-fund"
)

if not exist "node_modules\electron\path.txt" (
  echo.
  echo GitHub download failed. Retrying through the npmmirror CDN...
  echo trying npmmirror >> "%LOG%"
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  call :CLEANELECTRON
  call :RUN "npm install --no-audit --no-fund"
  set "ELECTRON_MIRROR="
)

if not exist "node_modules\electron\path.txt" (
  echo.
  echo Could not download the Electron binary.
  echo Copying the npm log next to this script so it can be diagnosed.
  call :GRABNPMLOG
  echo.
  echo   Give Claude:  flipper-run.log  and  npm-last.log
  echo.
  pause
  exit /b 1
)

echo Electron OK. Starting SkyBlock Flipper...
echo electron ok, starting >> "%LOG%"
call :RUN "npm start"

echo.
echo App exited. Log: flipper-run.log
call :GRABNPMLOG
pause
exit /b 0

REM --- run a command, showing output live AND appending it to the log --------
:RUN
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "& { cmd /c %1 2>&1 | Tee-Object -FilePath '%LOG%' -Append }"
exit /b %errorlevel%

REM --- a half-downloaded zip in Electron's cache fails exactly the same way ---
:CLEANELECTRON
if exist "node_modules\electron" rmdir /s /q "node_modules\electron"
if exist "%LocalAppData%\electron\Cache" rmdir /s /q "%LocalAppData%\electron\Cache"
if exist "%LocalAppData%\electron-builder\Cache" rmdir /s /q "%LocalAppData%\electron-builder\Cache"
exit /b 0

REM --- npm keeps its real error detail in a cache folder we can't reach ------
:GRABNPMLOG
for /f "delims=" %%f in ('dir /b /o-d "%LocalAppData%\npm-cache\_logs\*.log" 2^>nul') do (
  copy /y "%LocalAppData%\npm-cache\_logs\%%f" "%~dp0npm-last.log" >nul 2>nul
  goto :grabbed
)
:grabbed
exit /b 0
