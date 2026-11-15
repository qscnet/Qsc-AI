@echo off
cd /d "%~dp0"
echo.
echo   Starting command watcher (Windows PowerShell 5.1) ...
echo   Keep this window open. Close it to stop.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "_watcher.ps1"
pause
