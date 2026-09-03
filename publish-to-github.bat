@echo off
setlocal enabledelayedexpansion
title Publish SkyBlock Terminal
cd /d "%~dp0"

set "LOG=%~dp0publish.log"
echo publish attempt %DATE% %TIME% > "%LOG%"

where git >nul 2>nul
if errorlevel 1 (
  echo git not on PATH >> "%LOG%"
  echo.
  echo   Git is not installed on this PC.
  echo   Either install it:  https://git-scm.com/download/win
  echo   or use the no-git route - see UPLOAD-WITHOUT-GIT.txt in this folder.
  echo.
  pause & exit /b 1
)
for /f "delims=" %%v in ('git --version') do echo %%v >> "%LOG%"

REM If a remote is already set we go straight to pushing - re-running this after
REM a failed push should not send you back through creating the repo again.
for /f "delims=" %%r in ('git remote get-url origin 2^>nul') do set ORIGIN=%%r

if not defined ORIGIN (
  set /p USER=  Your GitHub username: 
  if "!USER!"=="" (echo   No username given. & pause & exit /b 1)
  echo.
  echo   If you have not made the repo yet, create it now: name skyblock-flipper,
  echo   Public, and do NOT tick "Add a README".
  start "" "https://github.com/new?name=skyblock-flipper&visibility=public"
  echo   Press any key once the repo exists ^(or if it already did^)...
  pause >nul
  git remote add origin https://github.com/!USER!/skyblock-flipper.git
  for /f "delims=" %%r in ('git remote get-url origin 2^>nul') do set ORIGIN=%%r
)

echo.
echo   Pushing to !ORIGIN!
echo   A browser window may open to sign you in. There is no token to paste.
echo.
git add -A
git diff --cached --quiet || git commit -q -m "Local changes"
git branch -M main
git push -u origin main 2>&1 | powershell -NoProfile -Command "$input | Tee-Object -FilePath '%LOG%' -Append"
if errorlevel 1 (
  echo.
  echo   Push failed. Common causes:
  echo     - the repo was created WITH a README:  git pull --rebase origin main   then run this again
  echo     - wrong username in the remote:        git remote remove origin        then run this again
  echo   The exact error is in publish.log next to this file - send me that.
  echo.
  pause & exit /b 1
)

for /f "tokens=4 delims=/" %%u in ("!ORIGIN!") do set GHUSER=%%u
echo.
echo   Pushed. Last step, in the window opening now:
echo     Source: "Deploy from a branch"   Branch: main   Folder: /docs   then Save
echo   ^(If it shows workflow templates instead, the Source dropdown is set to
echo    "GitHub Actions" - change it to "Deploy from a branch".^)
echo.
echo   Then it is live at:  https://!GHUSER!.github.io/skyblock-flipper/
echo   Open that in Chrome and click Install to get it as a real app.
echo.
start "" "https://github.com/!GHUSER!/skyblock-flipper/settings/pages"
pause
