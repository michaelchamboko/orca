@echo off
rem start-orca-ui.bat — double-click launcher for the ORCA localhost dashboard.
rem Opens a console window, runs `swarmctl ui`, and pauses on exit so the
rem user can read any error. Honors ORCA_OPENCODE_URL / ORCA_SERVER_URL
rem environment overrides; otherwise defaults to http://127.0.0.1:4096.

setlocal
cd /d "%~dp0"

if not exist "dist\cli.js" (
  echo [start-orca-ui] dist\cli.js not found. Building...
  call pnpm.cmd run build
  if errorlevel 1 (
    echo [start-orca-ui] build failed.
    pause
    exit /b 1
  )
)

if "%ORCA_SERVER_URL%"=="" set "ORCA_SERVER_URL=http://127.0.0.1:4096"

echo [start-orca-ui] launching swarmctl ui --server %ORCA_SERVER_URL%
node dist\cli.js ui --server "%ORCA_SERVER_URL%"
set "EXITCODE=%errorlevel%"

if not "%EXITCODE%"=="0" (
  echo [start-orca-ui] exited with code %EXITCODE%.
)

pause
endlocal
exit /b %EXITCODE%
