@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required: https://nodejs.org/
  pause
  exit /b 1
)
if not exist "node_modules\socket.io\package.json" (
  call npm.cmd ci --no-fund --no-audit
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node server.js
pause
