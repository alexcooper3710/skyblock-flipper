@echo off
cd /d "%~dp0"
echo Pushing SkyBlock Terminal to GitHub...
git push origin main
echo.
if errorlevel 1 (echo PUSH FAILED - see the message above.) else (echo Pushed. GitHub Pages will rebuild in about a minute.)
pause
