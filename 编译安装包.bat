@echo off
setlocal
cd /d "%~dp0"
title SquadCalc Build

echo ============================================================
echo   SquadCalc build - ONE step, ONE installer
echo   dir: %CD%
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :no_node
where npm >nul 2>nul
if errorlevel 1 goto :no_npm
where cargo >nul 2>nul
if errorlevel 1 goto :no_cargo

set "MAKENSIS="
if defined NSISDIR if exist "%NSISDIR%\makensis.exe" set "MAKENSIS=%NSISDIR%\makensis.exe"
if not defined MAKENSIS if exist "%~dp0..\.cache\tauri\NSIS\nsis-3.11\makensis.exe" set "MAKENSIS=%~dp0..\.cache\tauri\NSIS\nsis-3.11\makensis.exe"
if not defined MAKENSIS if exist "%ProgramFiles(x86)%\NSIS\makensis.exe" set "MAKENSIS=%ProgramFiles(x86)%\NSIS\makensis.exe"
if not defined MAKENSIS if exist "%ProgramFiles%\NSIS\makensis.exe" set "MAKENSIS=%ProgramFiles%\NSIS\makensis.exe"
if not defined MAKENSIS goto :no_nsis

if not exist "public\api\3d-manifest.json" echo [warn] public\api missing - run: node tools\export-offline.mjs

if exist "node_modules\@tauri-apps\api" (
    echo [1/3] frontend deps ok, skip install
) else (
    echo [1/3] npm install ...
    call npm install --no-audit --no-fund
    if errorlevel 1 goto :fail
)

echo [2/3] webpack build + cargo release build ...
call npm run build
if errorlevel 1 goto :fail
cargo build --release --manifest-path "src-tauri\Cargo.toml"
if errorlevel 1 goto :fail

echo [3/3] makensis (full installer: app + data) ...
"%MAKENSIS%" /V2 "src-tauri\installer\squadcalc-full.nsi"
if errorlevel 1 goto :fail

echo.
echo ============================================================
echo   DONE - installer:
for %%F in ("SquadCalc_46.1.1_x64-setup.exe") do (
    echo   %%~fF
    echo   %%~zF bytes
)
echo ============================================================
echo.
pause
exit /b 0

:no_node
echo [error] node not found in PATH. Install Node.js first.
goto :fail

:no_npm
echo [error] npm not found in PATH.
goto :fail

:no_cargo
echo [error] cargo not found in PATH. Install Rust via rustup first.
goto :fail

:no_nsis
echo [error] NSIS (makensis.exe) not found. Looked in:
echo         %%NSISDIR%%
echo         %~dp0..\.cache\tauri\NSIS\nsis-3.11
echo         %ProgramFiles(x86)%\NSIS
echo         %ProgramFiles%\NSIS
echo         Install NSIS 3.x, or set NSISDIR to its folder.
goto :fail

:fail
echo.
echo *** BUILD FAILED - send the messages above to the developer ***
pause
exit /b 1
