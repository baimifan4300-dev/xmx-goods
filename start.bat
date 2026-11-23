@echo off
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo Python not found.
  echo Install Python 3 from https://www.python.org/downloads/  ^(check "Add python.exe to PATH"^)
  echo or open this folder in VS Code and use "Live Server".
  echo.
  pause
  exit /b 1
)

echo Starting local server at http://127.0.0.1:8765 ...
start "xmx-goods-server" python -m http.server 8765 --bind 127.0.0.1
timeout /t 2 >nul
start "" "http://127.0.0.1:8765/"

echo.
echo The site is open in your browser. Keep the "xmx-goods-server" window running.
echo To stop the server, close that window or press Ctrl+C in it.
echo.
pause
