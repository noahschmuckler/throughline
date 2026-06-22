@echo off
rem Throughline -- double-click start for the orange device.
rem
rem Requires Node 20.6+ on PATH (the server launches with --env-file, added in
rem Node 20.6). Config lives in .env beside server.js; on first run this script
rem creates one from .env.example and tells you what to edit.
cd /d "%~dp0"

rem Repo layout: start.bat is shipped at the zip ROOT (next to server.js) AND in
rem deploy\ for the git-clone path. Climb to wherever server.js actually is.
if not exist "server.js" (
  if exist "..\server.js" cd ..
)

rem Self-heal the common Extract-All nesting (throughline-x.y.z\throughline\...).
if not exist "server.js" (
  if exist "throughline\server.js" cd throughline
)

if not exist "server.js" (
  echo.
  echo Throughline's files were not found next to this script.
  echo.
  echo This usually means the zip was not fully extracted:
  echo   1. Close this window.
  echo   2. Right-click the throughline zip and choose "Extract All".
  echo   3. Open the extracted folder ^(it contains a "throughline" folder^).
  echo   4. Run start.bat from inside that folder.
  echo.
  echo Do NOT run start.bat from inside the zip preview window.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this machine.
  echo Install Node 20.6+ or contact your Throughline administrator.
  pause
  exit /b 1
)

rem First run on a fresh box: seed .env from the example so the server can boot.
rem An update (extract over an existing install) keeps your edited .env -- the
rem zip never contains one.
if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo.
    echo Created .env from .env.example. Before relying on it, edit .env and set:
    echo   THROUGHLINE_DB  = your OneDrive shared path, e.g.
    echo     C:\Users\%USERNAME%\OneDrive - ^<org^>\Throughline\state.json
    echo   LLM_PROVIDER    = cdsapi
    echo.
  )
)

echo Starting Throughline on http://127.0.0.1:8787 ...
start "" http://127.0.0.1:8787
node --env-file=.env server.js
if errorlevel 1 (
  echo.
  echo Throughline stopped with an error ^(see above^).
  echo If it mentions --env-file, your Node is older than 20.6 -- update Node.
)
pause
