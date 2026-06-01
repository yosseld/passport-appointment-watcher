@echo off
cd /d "%~dp0"
echo Starting passport-watcher...  (close this window or press Ctrl+C to stop)
echo First run? Watch for the "PHONE ALERTS" link below and subscribe to it in the free ntfy app.
echo.
node watcher.js
pause
