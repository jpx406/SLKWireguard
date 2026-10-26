@echo off
rem Double-click launcher: runs start.ps1 without changing your execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
pause
