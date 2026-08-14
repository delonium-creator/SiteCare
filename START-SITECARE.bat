@echo off
setlocal
chcp 65001 >nul
title SiteCare Setup
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 goto :need_node

where npm >nul 2>&1
if errorlevel 1 goto :need_node

where npx >nul 2>&1
if errorlevel 1 goto :need_node

if exist "node_modules\.bin\wrangler.cmd" goto :run
echo Installing SiteCare dependencies. This is needed only for a new folder.
call npm ci --no-audit --no-fund
if errorlevel 1 goto :dependency_error

:run
node deploy-windows.mjs
echo.
pause
exit /b

:dependency_error
echo SiteCare dependencies could not be installed.
echo Check the internet connection and run this file again.
echo.
pause
exit /b 1

:need_node
echo Node.js 22.19 LTS or newer with npm is required.
echo Install the LTS version, close this window, and run START-SITECARE.bat again.
start "" "https://nodejs.org/en/download"
echo.
pause
exit /b 1
