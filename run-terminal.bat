@echo off
setlocal
title SkyBlock Terminal
cd /d "%~dp0"
where npm >nul 2>nul || (echo Node.js not found on PATH - install Node 20+ from https://nodejs.org & pause & exit /b 1)
if not exist node_modules ( echo Installing dependencies... & call npm install --no-audit --no-fund )
echo.
echo   Starting SkyBlock Terminal on http://127.0.0.1:8787
echo   Storage is SQLite via node:sqlite - nothing else to install.
echo.
start "" http://127.0.0.1:8787
node src/server/index.js
echo.
echo Terminal stopped.
pause
