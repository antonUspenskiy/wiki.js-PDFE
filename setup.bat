@echo off
echo Wiki PDF Exporter Setup
echo ======================
echo.
echo This will install all necessary components...
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: Node.js is not installed!
    echo Please download and install Node.js from https://nodejs.org/
    echo Then run this setup again.
    pause
    exit /b 1
)

:: Install dependencies
echo Installing dependencies...
call npm install

if %errorlevel% neq 0 (
    echo Error: Failed to install dependencies!
    pause
    exit /b 1
)

echo.
echo Setup completed successfully!
echo You can now run the program by double-clicking start.bat
echo.
pause 