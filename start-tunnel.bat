@echo off
title BlackHole Public Internet Tunnel
echo ========================================================
echo   Starting BlackHole Cloudflare Internet Tunnel
echo ========================================================
echo.
.\cloudflared.exe tunnel --url http://localhost:5173
pause
