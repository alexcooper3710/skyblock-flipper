@echo off
setlocal
title SkyBlock Terminal
cd /d "%~dp0"
where npm >nul 2>nul || (echo Node.js not found on PATH - install Node 20+ from https://nodejs.org & pause & exit /b 1)
if not exist node_modules ( echo Installing dependencies... & call npm install --no-audit --no-fund )
echo.
REM An older copy still holding the port is why "restart it" can look like it
REM did nothing: the new process dies on EADDRINUSE and the old one keeps
REM serving. Clear the port before starting.
set PORT=8787
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:"LISTENING" ^| findstr ":%PORT% "') do (
  echo   Stopping the old terminal ^(pid %%a^)...
  taskkill /PID %%a /F >nul 2>nul
)

echo   Starting SkyBlock Terminal on http://127.0.0.1:8787
echo   Storage is SQLite via node:sqlite - nothing else to install.
echo.
start "" http://127.0.0.1:8787
node src/server/index.js
echo.
echo Terminal stopped.
pause
