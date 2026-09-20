@echo off
setlocal
cd /d "%~dp0"

:: QVAC SDK membutuhkan Node.js >= 22.17
where node >nul 2>nul
if %errorlevel% equ 0 (
    node "%~dp0host.js"
    exit /b %errorlevel%
)

:: Fallback updater-only jika Node belum tersedia
where python >nul 2>nul
if %errorlevel% equ 0 (
    python "%~dp0host.py"
    exit /b %errorlevel%
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0host.ps1"
exit /b %errorlevel%
