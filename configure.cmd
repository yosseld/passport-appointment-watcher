@echo off
REM Re-open the agency picker to switch which agency you're watching.
cd /d "%~dp0"
node watcher.js --configure
pause
