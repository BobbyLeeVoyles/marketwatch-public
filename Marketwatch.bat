@echo off
title Marketwatch Trading Dashboard
cd /d "C:\Users\rovoi\Projects\Marketwatch"

echo.
echo ========================================
echo   MARKETWATCH - BTC Trading Terminal
echo ========================================
echo.

REM Kill any old servers on ports 3000-3004
echo Cleaning up old servers...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3002 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3003 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1

echo Starting server...
echo Dashboard will open at: http://localhost:3001
echo.
echo Press Ctrl+C to stop the server
echo ========================================
echo.

timeout /t 2 /nobreak >nul
start "" "http://localhost:3001"
call npm run dev
