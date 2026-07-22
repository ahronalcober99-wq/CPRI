@echo off
title CPRI Server
set PATH=C:\Program Files\nodejs;%PATH%
cd /d "%~dp0"

echo ============================================
echo  CPRI — Center for Policy and Research
echo  Innovations Public Website
echo ============================================
echo.

REM Check if server is already running
netstat -an 2>nul | find ":3000 " >nul
if not errorlevel 1 (
    echo [OK] Server is already running at http://localhost:3000
    echo.
    echo Open http://localhost:3000 in your browser.
    echo Admin login: admin / admin12345
    echo.
    pause
    exit /b 0
)

echo Starting CPRI server...
echo.
echo Web: http://localhost:3000
echo Admin: admin / admin12345
echo.
echo Press Ctrl+C to stop the server.
echo ============================================
echo.

node server/server.js

pause