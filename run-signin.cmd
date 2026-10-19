@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "signin.ps1" -Interactive
echo.
echo Exit code: %ERRORLEVEL%
pause
