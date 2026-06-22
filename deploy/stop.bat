@echo off
rem Throughline -- stop the running app.
rem
rem Closing the browser tab does NOT stop Throughline; the Node server keeps
rem running and holds the app's files open. While it runs you can't delete or
rem replace an install -- Windows reports it as needing "administrator
rem permission" (really the files are just in use). Run this first, then extract
rem the new zip over the install freely.
rem
rem Note: this ends every Node process you own. On an orange device that's only
rem Throughline; if you run other Node tools, close those first.

echo Stopping Throughline...
taskkill /F /IM node.exe >nul 2>nul
if errorlevel 1 (
  echo No running Throughline was found ^(nothing to stop^).
) else (
  echo Throughline stopped. You can now extract the new zip over the install.
)
timeout /t 2 >nul
