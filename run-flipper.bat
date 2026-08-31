@echo off
title SkyBlock Flipper
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo(
  echo Node.js / npm was not found on PATH.
  echo Install Node 20+ from https://nodejs.org then run this again.
  echo(
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies - this downloads Electron and takes a few minutes...
  call npm install
  if errorlevel 1 (
    echo(
    echo npm install failed. Scroll up for the reason.
    pause
    exit /b 1
  )
)
echo Starting SkyBlock Flipper...
call npm start
echo(
echo App exited.
pause
