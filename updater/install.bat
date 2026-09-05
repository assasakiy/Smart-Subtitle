@echo off
setlocal enabledelayedexpansion

echo ========================================================
echo   Smart Subtitle - Native Updater Installer (Windows)
echo ========================================================
echo.

set "SCRIPT_DIR=%~dp0"
set "HOST_JSON=%SCRIPT_DIR%com.aisubtitle.updater.json"
set "BAT_PATH=%SCRIPT_DIR%host.bat"

:: Escape backslashes for JSON
set "ESCAPED_PATH=%BAT_PATH:\=\\%"

:: Buat manifest spesifik sistem dengan path absolut
(
echo {
echo   "name": "com.aisubtitle.updater",
echo   "description": "Smart Subtitle Native Updater Host",
echo   "path": "!ESCAPED_PATH!",
echo   "type": "stdio",
echo   "allowed_origins": [
echo     "chrome-extension://*/*"
echo   ]
echo }
) > "%HOST_JSON%"

echo Mendaftarkan ke Windows Registry (Chrome dan Edge)...
REG ADD "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.aisubtitle.updater" /ve /t REG_SZ /d "%HOST_JSON%" /f >nul
REG ADD "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.aisubtitle.updater" /ve /t REG_SZ /d "%HOST_JSON%" /f >nul

echo.
echo [SUKSES] Native Messaging Host berhasil didaftarkan!
echo Ekstensi sekarang dapat melakukan update otomatis langsung dari browser.
echo.
pause
