@echo off
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo Python not found.
  echo Install Python 3 from https://www.python.org/downloads/  ^(check "Add python.exe to PATH"^)
  echo or run: npm run dev
  echo.
  pause
  exit /b 1
)

echo Starting local server at http://127.0.0.1:8765 ...
start "xmx-goods-server" python -m http.server 8765 --bind 127.0.0.1
timeout /t 2 >nul

echo.
echo   本地预览（不需要 Supabase）: http://127.0.0.1:8765/?demo=1
echo   云端登录（需先配置）      : http://127.0.0.1:8765/
echo.
echo 本地预览数据只保存在当前浏览器，不会跨设备同步。
echo 配置 Supabase 的步骤见 docs/云端部署与迁移.md。
echo.
start "" "http://127.0.0.1:8765/?demo=1"

echo Keep the "xmx-goods-server" window running. Close it to stop the server.
pause
