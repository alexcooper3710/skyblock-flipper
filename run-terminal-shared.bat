@echo off
setlocal
title SkyBlock Terminal (shared on your network)
cd /d "%~dp0"
where npm >nul 2>nul || (echo Node.js not found - install Node 20+ from https://nodejs.org & pause & exit /b 1)
if not exist node_modules ( echo Installing dependencies... & call npm install --no-audit --no-fund )
echo.
echo   Starting shared - anyone on your network can open the URLs below.
echo   They need no API key and no install; they just open the link.
echo   Windows may ask you to allow Node through the firewall - say yes for Private networks.
echo.
set HOST=0.0.0.0
start "" http://127.0.0.1:8787
node src/server/index.js
echo.
echo Terminal stopped.
pause
