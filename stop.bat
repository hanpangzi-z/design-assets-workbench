@echo off
echo ============================================
echo   Stopping Benlai Design Platform...
echo ============================================
echo.

set MYSQL_BIN=C:\Program Files\MySQL\MySQL Server 8.4\bin
set PROJECT_DIR=%~dp0
set MYSQL_DATA=%LOCALAPPDATA%\BenlaiGaoding\mysql-data

if exist "%MYSQL_DATA%\.benlai-ready" (
    "%MYSQL_BIN%\mysqladmin.exe" --protocol=tcp --host=127.0.0.1 --port=3306 -u root shutdown >nul 2>&1
    if errorlevel 1 (
        echo   MySQL was not running or could not be stopped.
    ) else (
        echo   MySQL stopped.
    )
)

taskkill /F /IM node.exe >nul 2>&1

if %errorlevel% equ 0 (
    echo   All Node processes stopped.
) else (
    echo   No running Node processes found.
)

echo.
echo ============================================
echo   Done.
echo ============================================
pause
