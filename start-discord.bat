@echo off
cd /d "%~dp0"
echo ========================================================
echo   Starting Antigravity Discord Application...
echo ========================================================
echo.

:: Node is required; say so plainly instead of two windows flashing and closing.
where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js was not found. Install Node 22 LTS from https://nodejs.org and re-run.
  pause
  exit /b 1
)

:: First run on this machine: install dependencies.
if not exist "node_modules\" (
  echo [0/2] Installing dependencies ^(first run only^)...
  call npm ci
  if errorlevel 1 (
    echo [x] npm ci failed - see the output above.
    pause
    exit /b 1
  )
)

:: Start Backend Server. Note: "&" must be escaped as "^&" inside echo, or cmd
:: treats the rest of the line as a second command.
echo [1/2] Launching Backend API ^& WebSocket (Port 3001)...
start "Discord Backend" /min node server.js

:: Wait a brief moment for database & backend to initialize
ping -n 3 127.0.0.1 > nul

:: Start Frontend Vite Server
echo [2/2] Launching Frontend Interface (Port 5173)...
start "Discord Frontend" /min cmd /c npx vite --port 5173

:: Open default browser to the web app
ping -n 2 127.0.0.1 > nul
start http://localhost:5173

echo.
echo ========================================================
echo   Discord is now running!
echo.
echo   URL: http://localhost:5173
echo.
echo   Voice/video: browsers only allow the microphone on https:// or on
echo   localhost. Friends opening http://^<your-LAN-IP^>:5173 can chat but
echo   cannot join voice - use the Docker/Caddy setup in DEPLOYMENT.md for that.
echo.
echo   Demo Accounts:
echo     Username: AlexPro      (Email: user-me@example.dev)
echo     Username: CyberNinja   (Email: user-2@example.dev)
echo     Username: ChillBot     (Email: user-3@example.dev)
echo     Password: antigravity123
echo ========================================================
echo.
timeout /t 5 > nul
