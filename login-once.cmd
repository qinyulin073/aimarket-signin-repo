@echo off
cd /d "%~dp0"
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do set "NODE=%%i"
if not defined NODE (
  echo Node.js 18+ is required. Install it from https://nodejs.org/ then re-run.
  pause
  exit /b 1
)
echo Opening the enterprise-WeChat login page in a Chrome window...
echo Scan the QR code with WeCom; this window finishes by itself afterwards.
"%NODE%" renew-token.js --visible --wait 1800
echo.
echo Exit code: %ERRORLEVEL%
pause
