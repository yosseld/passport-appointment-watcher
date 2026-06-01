@echo off
cd /d "%~dp0"
node watcher.js --test
pause
