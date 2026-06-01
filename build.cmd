@echo off
REM Build a single-file passport-watcher.exe (bundles Node + dependencies).
REM Recipients only need Google Chrome or Microsoft Edge installed.
cd /d "%~dp0"
call npm install
call npm run build
echo.
echo Built passport-watcher.exe  (share this one file; ~40 MB)
pause
