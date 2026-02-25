@echo off
title Marketwatch - Starting Development Server
cd /d "C:\Users\rovoi\Projects\Marketwatch"
echo Starting Marketwatch...
echo.
start "" "http://localhost:3000"
npm run dev
