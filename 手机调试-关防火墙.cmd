@echo off
title RuiXing - close the port again
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo A Windows window will pop up asking for permission.
  echo Please click "Yes" there, then this file runs again by itself.
  echo.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo Closing the port that was opened for phone testing...
echo.
netsh advfirewall firewall delete rule name="RuiXing dev 5173"
echo.
echo Done. Your phone can no longer reach this computer's preview page.
echo.
pause
