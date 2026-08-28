@echo off
cd /d "%~dp0"
title Buzzer Game — Network Diagnostic

echo ===========================================
echo    BUZZER GAME — NETWORK DIAGNOSTIC
echo ===========================================
echo.

:: Step 1: Check Node.js
echo [TEST 1] Node.js
where node >nul 2>&1
if %errorlevel%==0 (
    node -v
) else (
    echo [FAIL] Node.js not found
)

echo.

:: Step 2: Check modules
echo [TEST 2] Dependencies
if exist "node_modules\express\package.json" (echo [OK] express) else (echo [FAIL] express missing)
if exist "node_modules\ws\package.json" (echo [OK] ws) else (echo [FAIL] ws missing)
if exist "node_modules\uuid\package.json" (echo [OK] uuid) else (echo [FAIL] uuid missing)

echo.

:: Step 3: Check if port is in use
echo [TEST 3] Port check
netstat -an | findstr ":3000" | findstr "LISTENING"
if %errorlevel%==0 (
    echo [OK] Port 3000 is already in use (server running?)
) else (
    echo [OK] Port 3000 is free
)

echo.

:: Step 4: Check firewall rules
echo [TEST 4] Windows Firewall
echo Checking for Node.js firewall rules...
netsh advfirewall firewall show rule name=all dir=in | findstr /i "node.js nodejs" >nul 2>&1
if %errorlevel%==0 (
    echo [OK] Node.js has inbound firewall rules
) else (
    echo [WARN] No specific Node.js firewall rules found
    echo        You may need to allow Node.js through Windows Firewall
    echo        when Windows Defender prompts you on first server start.
)

echo.

:: Step 5: Start temp server and test WebSocket
echo [TEST 5] WebSocket connectivity test
echo.
echo Starting a temporary server on port 3458...

start /B cmd /c "node -e ^
var h=require('http'),W=require('ws'),s=h.createServer(),w=new W.Server({server:s});^
w.on('connection',function(ws){console.log('[SERVER] WebSocket connected!');ws.close();});^
s.listen(3458,function(){console.log('[OK] Test server on port 3458');});" 2>&1

:: Wait for server to start
timeout /t 2 /nobreak >nul

:: Test WebSocket from Node.js
echo Testing WebSocket connection from this machine...
node -e "
var W = require('ws');
var ws = new W('ws://localhost:3458');
ws.on('open', function() { console.log('[PASS] WebSocket works on localhost!'); ws.close(); process.exit(0); });
ws.on('error', function(e) { console.log('[FAIL] WebSocket error: ' + e.message); process.exit(1); });
setTimeout(function() { console.log('[FAIL] WebSocket timed out'); process.exit(1); }, 3000);
"

:: Also test with IP 127.0.0.1
echo.
node -e "
var W = require('ws');
var ws = new W('ws://127.0.0.1:3458');
ws.on('open', function() { console.log('[PASS] WebSocket works on 127.0.0.1!'); ws.close(); process.exit(0); });
ws.on('error', function(e) { console.log('[FAIL] WebSocket error on 127.0.0.1: ' + e.message); process.exit(1); });
setTimeout(function() { console.log('[FAIL] WebSocket timed out on 127.0.0.1'); process.exit(1); }, 3000);
"

:: Test with detected IP
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig 2^>nul ^| findstr /i "IPv4"') do (
    set "IP=%%a"
    goto IP_FOUND
)
:IP_FOUND
set IP=%IP: =%
echo Testing WebSocket on detected IP: %IP%:3458...
if not "%IP%"=="" (
    node -e "
    var W = require('ws');
    var ws = new W('ws://%IP%:3458');
    ws.on('open', function() { console.log('[PASS] WebSocket works on %IP%!'); ws.close(); process.exit(0); });
    ws.on('error', function(e) { console.log('[FAIL] WebSocket error on %IP%: ' + e.message); process.exit(1); });
    setTimeout(function() { console.log('[FAIL] WebSocket timed out on %IP%'); process.exit(1); }, 3000);
    "
) else (
    echo [SKIP] Could not determine IP
)

echo.

:: Cleanup
echo Killing test server...
taskkill /f /im node.exe 2>nul

echo.
echo ===========================================
echo  Diagnostic complete.
echo  If WebSocket tests on 127.0.0.1 or localhost
echo  pass but the game doesn't work in the browser,
echo  the issue is likely:
echo   1. Windows Firewall blocking WebSocket upgrade
echo   2. Browser extension interfering
echo   3. IPv6 vs IPv4 resolution (try 127.0.0.1 in URL)
echo ===========================================
pause
