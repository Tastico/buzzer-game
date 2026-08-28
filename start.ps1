# Buzzer Game — PowerShell Launcher
# Right-click → "Run with PowerShell" OR just double-click

$ErrorActionPreference = "Continue"
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptPath

Write-Host "===================================" -ForegroundColor Cyan
Write-Host "     BUZZER GAME SERVER" -ForegroundColor Cyan
Write-Host "===================================" -ForegroundColor Cyan
Write-Host ""

# Check for node
$nodeFound = $false
try { node --version | Out-Null; $nodeFound = $true } catch {}
try { & ".\node\node.exe" --version | Out-Null; $env:PATH = ".\node;$env:PATH"; $nodeFound = $true } catch {}

if (-not $nodeFound) {
    Write-Host "Node.js not found." -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Download portable version now? (Y/N)" -ForegroundColor White
    $resp = Read-Host
    if ($resp -ne "Y" -and $resp -ne "y") {
        Write-Host ""
        Write-Host "Install Node.js from https://nodejs.org then run again." -ForegroundColor Yellow
        pause; exit
    }
    
    Write-Host "Downloading Node.js (40MB)..." -ForegroundColor Yellow
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $wc = New-Object Net.WebClient
    $wc.DownloadFile("https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip", "$env:TEMP\node.zip")
    
    Write-Host "Extracting..." -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path ".\node" | Out-Null
    Expand-Archive "$env:TEMP\node.zip" -DestinationPath "$env:TEMP\node-extract" -Force
    
    # Find and copy
    $src = Get-ChildItem "$env:TEMP\node-extract" -Recurse -Filter "node.exe" | Select-Object -First 1
    if ($src) {
        $nodeDir = $src.Directory.FullName
        Copy-Item "$nodeDir\*" ".\node\" -Recurse -Force
        $env:PATH = ".\node;$env:PATH"
        Write-Host "Portable Node.js ready!" -ForegroundColor Green
    } else {
        Write-Host "Extraction failed. Install Node.js from https://nodejs.org" -ForegroundColor Red
        pause; exit
    }
    Remove-Item "$env:TEMP\node-extract" -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item "$env:TEMP\node.zip" -Force -ErrorAction SilentlyContinue
}

# Install deps
if (-not (Test-Path ".\node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install --no-audit --no-fund
}

# Get IP
$ip = "localhost"
try { $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -notlike "127.*"}).IPAddress | Select-Object -First 1 } catch {}

Write-Host ""
Write-Host "====================================" -ForegroundColor Green
Write-Host "PLAYERS: http://$($ip):3000" -ForegroundColor Cyan
Write-Host "ADMIN:   http://$($ip):3000/admin" -ForegroundColor Cyan
Write-Host "====================================" -ForegroundColor Green
Write-Host ""

node server.js
pause
