@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-windows-preview.ps1"
if errorlevel 1 (
  echo.
  echo The Windows viewer could not start. Check the message above.
  pause
)
