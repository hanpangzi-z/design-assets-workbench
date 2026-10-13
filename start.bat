@echo off
chcp 65001 >nul
echo ============================================
echo   Benlai Design Platform - Startup Script
echo ============================================
echo.

REM --- Config ---
set MYSQL_BIN=C:\Program Files\MySQL\MySQL Server 8.4\bin
set PROJECT_DIR=%~dp0
set MYSQL_DATA=%LOCALAPPDATA%\BenlaiGaoding\mysql-data
set MYSQL_READY_MARKER=%MYSQL_DATA%\.benlai-ready

REM --- Step 1: Start MySQL if not running ---
echo [1/5] Checking MySQL...
if not exist "%MYSQL_BIN%\mysqld.exe" (
    echo       ERROR: MySQL executable not found at %MYSQL_BIN%
    echo       Please install MySQL Server 8.x or update MYSQL_BIN in start.bat.
    pause
    exit /b 1
)

if not exist "%MYSQL_DATA%\mysql" (
    echo       Initializing local MySQL data directory...
    if not exist "%MYSQL_DATA%" mkdir "%MYSQL_DATA%"
    "%MYSQL_BIN%\mysqld.exe" --no-defaults --initialize-insecure --datadir="%MYSQL_DATA%" --console
    if errorlevel 1 (
        echo       ERROR: MySQL data initialization failed at %MYSQL_DATA%
        pause
        exit /b 1
    )
    REM MySQL 8.4 may leave bootstrap undo files that block the first normal start.
    if exist "%MYSQL_DATA%\undo_001" del /f /q "%MYSQL_DATA%\undo_001" >nul 2>&1
    if exist "%MYSQL_DATA%\undo_002" del /f /q "%MYSQL_DATA%\undo_002" >nul 2>&1
)

if not exist "%MYSQL_READY_MARKER%" (
    if exist "%MYSQL_DATA%\undo_001" del /f /q "%MYSQL_DATA%\undo_001" >nul 2>&1
    if exist "%MYSQL_DATA%\undo_002" del /f /q "%MYSQL_DATA%\undo_002" >nul 2>&1
)

"%MYSQL_BIN%\mysqladmin.exe" --protocol=tcp --host=127.0.0.1 --port=3306 -u root ping >nul 2>&1
if errorlevel 1 (
    echo       Starting MySQL server...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$mysql='%MYSQL_BIN%\mysqld.exe'; $data='%MYSQL_DATA%'; $mysqlArgs='--no-defaults --datadir=\"' + $data + '\" --port=3306 --bind-address=127.0.0.1 --console'; Start-Process -WindowStyle Hidden -FilePath $mysql -ArgumentList $mysqlArgs"
    for /L %%i in (1,1,30) do (
        timeout /t 1 /nobreak >nul
        "%MYSQL_BIN%\mysqladmin.exe" --protocol=tcp --host=127.0.0.1 --port=3306 -u root ping >nul 2>&1
        if not errorlevel 1 goto mysql_ready
    )
    echo       ERROR: MySQL failed to start on 127.0.0.1:3306
    echo       Data dir: %MYSQL_DATA%
    echo       If port 3306 is occupied, stop the other MySQL process and run start.bat again.
    pause
    exit /b 1
) else (
    echo       MySQL is already running.
)

:mysql_ready
echo       MySQL ready.

REM --- Step 2: Create database if needed ---
echo [2/5] Checking database...
"%MYSQL_BIN%\mysql.exe" --protocol=tcp --host=127.0.0.1 --port=3306 -u root -e "CREATE DATABASE IF NOT EXISTS benlai_gaoding CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" >nul 2>&1
if errorlevel 1 (
    echo       ERROR: Could not create/check database.
    pause
    exit /b 1
)
echo       Database ready.
type nul > "%MYSQL_READY_MARKER%"

REM --- Step 3: Sync database tables ---
echo [3/5] Syncing database tables...
cd /d "%PROJECT_DIR%"
call npm run db:sync
if errorlevel 1 (
    echo       ERROR: Database table sync failed.
    pause
    exit /b 1
)
echo       Database tables ready.

REM --- Step 4: Seed data ---
echo [4/5] Seeding data...
call npm run db:seed
if errorlevel 1 (
    echo       ERROR: Seed data failed.
    pause
    exit /b 1
)
echo       Seed data ready.

REM --- Step 5: Start app ---
echo [5/5] Starting application...
echo.
echo       Backend:  http://localhost:3088
echo       Frontend: http://localhost:3089
echo.
echo ============================================
echo   Press Ctrl+C to stop all services
echo ============================================
echo.

call npm run dev
