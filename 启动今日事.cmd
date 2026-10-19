@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0启动今日事.ps1" %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
    echo.
    echo ------------------------------------------------------------
    echo  启动没有成功，请把上面的信息截图发给开发者。
    echo ------------------------------------------------------------
    echo.
    pause
)
exit /b %RC%
