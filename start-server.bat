@echo off
chcp 65001 >nul
title Cream Memo SSE Server

echo.
echo ============================================
echo   Cream Memo (AI SSE) - Starting...
echo ============================================
echo.

cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
    echo [OK] Python found, starting SSE server...
    echo.
    echo Server: http://localhost:8001/index.html
    echo AI    : SSE streaming polish enabled
    echo Press Ctrl+C to stop
    echo.
    start http://localhost:8001/index.html
    python server\sse_server.py
    goto :eof
)

where py >nul 2>nul
if %errorlevel%==0 (
    echo [OK] Python found, starting SSE server...
    echo.
    echo Server: http://localhost:8001/index.html
    echo AI    : SSE streaming polish enabled
    echo Press Ctrl+C to stop
    echo.
    start http://localhost:8001/index.html
    py server\sse_server.py
    goto :eof
)

echo.
echo [X] Python not found - SSE AI service unavailable.
echo.
echo No problem - you can still use the app with local AI fallback:
echo   Just double-click "index.html" to open it in your browser.
echo.
start index.html
pause
