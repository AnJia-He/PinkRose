@echo off
title RuiXing - let your phone connect
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo A Windows window will pop up asking for permission.
  echo Please click "Yes" there, then this file runs again by itself.
  echo.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo.
echo Opening ONE port: TCP 5173 (the RuiXing preview page).
echo The backend port 8787 stays closed - the phone reaches the backend
echo through the preview page, so nothing that costs money is exposed.
echo.
netsh advfirewall firewall add rule name="RuiXing dev 5173" dir=in action=allow protocol=TCP localport=5173
echo.
echo Done.  On your phone (same wifi) open:   http://192.168.1.6:5173
echo.
echo To close it again later, run this file:
echo   手机调试-关防火墙.cmd
echo.
pause
