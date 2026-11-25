@echo off
setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"
set "NODE_BIN="
if exist "%~dp0runtime\node\node.exe" set "NODE_BIN=%~dp0runtime\node\node.exe"
if defined NODE_BIN goto :run
where node >nul 2>&1
if not errorlevel 1 set "NODE_BIN=node"
if defined NODE_BIN goto :run
echo [Threadline Studio] Node.js was not found on this PC.
echo Please install Node.js 26.8+ or use the portable release.
echo Mirror: https://npmmirror.com/mirrors/node/latest-v26.x/
pause
exit /b 1
:run
"%NODE_BIN%" scripts\launch.mjs --open
if errorlevel 1 pause
endlocal
