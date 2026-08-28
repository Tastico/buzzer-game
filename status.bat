@echo off
cd /d "%~dp0"
echo ===========================================
echo  BUZZER GAME — Last Run Status
echo ===========================================
echo.
if not exist "start.log" (
    echo No log found. You haven't run start.bat yet.
    goto EOF
)
type start.log
echo.
echo.
echo  App files check:
if exist "node_modules\express" (echo  [OK] express installed) else (echo  [!!] Missing: express)
if exist "node_modules\ws" (echo  [OK] ws installed) else (echo  [!!] Missing: ws)
if exist "server.js" (echo  [OK] server.js present) else (echo  [!!] Missing: server.js)
if exist "public\admin.html" (echo  [OK] admin.html present)
echo.
:EOF
pause
