@echo off
title BUZZER Game — Diagnostic
cd /d "%~dp0"
cls
echo ===========================================
echo    BUZZER GAME — DIAGNOSTIC MODE
echo ===========================================
echo.
echo Testing each component...
echo.

:: 1. Check Node.js
echo [TEST 1] Node.js check...
where node 2>nul
echo Errorlevel: %errorlevel%
if %errorlevel%==0 (
    echo [OK] Node.js found
    node --version
) else (
    echo [FAIL] Node.js not in PATH
    if exist "node\node.exe" (
        echo [OK] Portable Node.js found at: node\node.exe
    ) else (
        echo [FAIL] No Node.js found anywhere
    )
)
echo.

:: 2. Check npm packages
echo [TEST 2] Dependencies check...
if exist "node_modules\express\package.json" (
    echo [OK] express found
) else (
    echo [FAIL] express not installed
)
if exist "node_modules\ws\package.json" (
    echo [OK] ws found
) else (
    echo [FAIL] ws not installed
)
echo.

:: 3. Check server files
echo [TEST 3] Core files check...
if exist "server.js" (echo [OK] server.js) else (echo [FAIL] server.js missing!)
if exist "public\index.html" (echo [OK] player page) else (echo [FAIL] player page missing!)
if exist "public\admin.html" (echo [OK] admin page) else (echo [FAIL] admin page missing!)
echo.

:: 4. Network info
echo [TEST 4] Network info...
echo.
ipconfig | findstr /i "IPv4"
echo.
echo Your IP should be one of the lines above ^(e.g., 192.168.x.x^)
echo.

:: 5. Check port 3000
echo [TEST 5] Port 3000 check...
netstat -ano | findstr ":3000 "
if %errorlevel%==0 (
    echo [WARN] Port 3000 is already in use!
    echo Another program is using it. Close the other Buzzer Game first.
) else (
    echo [OK] Port 3000 is free
)
echo.

echo ===========================================
echo  Diagnostics complete.
echo  Screenshot this window and send it.
echo ===========================================
echo.
pause
