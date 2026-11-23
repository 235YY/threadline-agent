@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 26.8 or newer from https://nodejs.org/ and try again.
  pause
  exit /b 1
)
node scripts/local-demo.mjs --open
if errorlevel 1 pause
