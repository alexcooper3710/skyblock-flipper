@echo off
setlocal enabledelayedexpansion
title Publish SkyBlock Terminal to GitHub Pages
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Git is not installed. Install it from https://git-scm.com/download/win
  echo   then run this again. ^(Default options are fine.^)
  echo.
  pause & exit /b 1
)

echo.
echo   This publishes the browser build to GitHub Pages.
echo   Pages is FREE on a public repo - no subscription needed.
echo   Your data stays on this PC; GitHub only serves the static files.
echo.
set /p USER=  Your GitHub username: 
if "%USER%"=="" (echo   No username given. & pause & exit /b 1)

echo.
echo   Opening GitHub so you can create the empty repo.
echo   Name it: skyblock-flipper    Visibility: Public
echo   Do NOT tick "Add a README" - the folder already has one.
echo.
start "" "https://github.com/new?name=skyblock-flipper&visibility=public"
echo   Press any key here once you've clicked "Create repository"...
pause >nul

git remote remove origin >nul 2>nul
git remote add origin https://github.com/%USER%/skyblock-flipper.git
git branch -M main
echo.
echo   Pushing. A browser window may open to sign you in to GitHub.
echo.
git push -u origin main
if errorlevel 1 (
  echo.
  echo   Push failed. Most likely the repo name or username does not match,
  echo   or the repo was created with a README ^(then run: git pull --rebase origin main^)
  echo.
  pause & exit /b 1
)

echo.
echo   Pushed. One last step, in the browser window opening now:
echo     Settings  ^>  Pages  ^>  Source: Deploy from a branch
echo     Branch: main    Folder: /docs    then Save
echo.
echo   A minute later your terminal is live at:
echo     https://%USER%.github.io/skyblock-flipper/
echo.
start "" "https://github.com/%USER%/skyblock-flipper/settings/pages"
pause
