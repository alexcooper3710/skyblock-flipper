@echo off
title Stop SkyBlock Terminal
set PORT=8787
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr ":%PORT% "') do (
  echo Stopping terminal on port %PORT% ^(pid %%a^)
  taskkill /PID %%a /F >nul 2>nul
  set FOUND=1
)
if "%FOUND%"=="0" echo Nothing was listening on port %PORT%.
echo Done.
timeout /t 2 >nul
