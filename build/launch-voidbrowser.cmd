@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "TARGET_DIR=%LocalAppData%\VoidBrowser"
set "PAYLOAD_ZIP=%SCRIPT_DIR%VoidBrowserPayload.zip"

if not exist "%TARGET_DIR%" mkdir "%TARGET_DIR%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%PAYLOAD_ZIP%' -DestinationPath '%TARGET_DIR%' -Force"
if errorlevel 1 exit /b 1

start "" "%TARGET_DIR%\VoidBrowser.exe"
exit /b 0