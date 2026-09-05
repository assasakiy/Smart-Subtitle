@echo off
setlocal
cd /d "%~dp0"

:: 1. Coba Python
where python >nul 2>nul
if %errorlevel% equ 0 (
    python "%~dp0host.py"
    exit /b %errorlevel%
)

:: 2. Coba Node.js
where node >nul 2>nul
if %errorlevel% equ 0 (
    node "%~dp0host.js"
    exit /b %errorlevel%
)

:: 3. Fallback PowerShell jika tidak ada Python/Node
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0host.ps1"
exit /b %errorlevel%
