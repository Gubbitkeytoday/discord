@echo off
cd /d "%~dp0"
echo ========================================================
echo   Starting Antigravity Discord Application...
echo ========================================================
echo.

:: Start Backend Server
echo [1/2] Launching Backend API & WebSocket (Port 3001)...
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
echo   Demo Accounts:
echo     Username: AlexPro      (Email: user-me@example.dev)
echo     Username: CyberNinja   (Email: user-2@example.dev)
echo     Username: ChillBot     (Email: user-3@example.dev)
echo     Password: antigravity123
echo ========================================================
echo.
timeout /t 5 > nul
