@echo off
REM One-time setup for Passport Appointment Watcher (no tech knowledge needed).
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Installing it now via winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo ============================================================
  echo  Node.js was just installed. Please CLOSE this window and
  echo  run setup.cmd again so it can finish.
  echo ============================================================
  pause
  exit /b
)

echo Installing dependencies...
call npm install
echo.
echo ============================================================
echo  Setup complete! Double-click  start.cmd  to run the watcher.
echo ============================================================
pause
