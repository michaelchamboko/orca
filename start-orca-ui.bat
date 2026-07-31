@echo off
rem start-orca-ui.bat — double-click launcher for the ORCA localhost dashboard.
rem Opens a console window, runs `swarmctl ui`, and pauses on exit so the
rem user can read any error.
rem
rem If OpenCode requires HTTP Basic Auth, set these environment variables
rem BEFORE launching (or copy .env.example to .env and edit):
rem   OPENCODE_SERVER_URL      e.g. http://127.0.0.1:4096
rem   OPENCODE_SERVER_USERNAME e.g. opencode
rem   OPENCODE_SERVER_PASSWORD <your password>
rem Without credentials, OpenCode returns 401 and the dashboard will show
rem OPENCODE_UNAVAILABLE with no role assignments available.
rem
rem Honors ORCA_SERVER_URL as a CLI override (passed through to swarmctl ui).
rem
rem PROXY NOTE: Node.js' fetch (used by the launcher) reads HTTP_PROXY /
rem HTTPS_PROXY env vars and will route loopback traffic through the
rem corporate proxy unless NO_PROXY includes 127.0.0.1 / localhost / ::1.
rem Most browsers bypass the proxy for 127.0.0.1 by default, which is why
rem the page loads but the launcher can't reach OpenCode. We force
rem NO_PROXY here so the adapter always uses the direct loopback path.

setlocal
cd /d "%~dp0"

rem Force loopback to bypass any HTTP/HTTPS proxy.
set "NO_PROXY=127.0.0.1,localhost,::1"
set "no_proxy=127.0.0.1,localhost,::1"

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
echo [start-orca-ui] NO_PROXY=%NO_PROXY%
echo [start-orca-ui] If OpenCode is on a different port, pass --server http://127.0.0.1:<port> or run 'node dist\cli.js ui --discover-port' to scan common ports.
node dist\cli.js ui --server "%ORCA_SERVER_URL%"
set "EXITCODE=%errorlevel%"

if not "%EXITCODE%"=="0" (
  echo [start-orca-ui] exited with code %EXITCODE%.
)

pause
endlocal
exit /b %EXITCODE%
