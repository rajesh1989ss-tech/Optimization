@echo off
REM Crew Chat — start the local Wi-Fi messaging hub on Windows.
REM Requires Node.js (https://nodejs.org). Everything else is built in.
title Crew Chat hub
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this machine.
  echo   Install it once from https://nodejs.org while you still have internet,
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)
node server.js %*
echo.
echo   The hub has stopped. Close this window or run it again.
pause
