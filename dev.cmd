@echo off
REM Launch Envy in development mode. Double-click this, or run it from a
REM terminal.
REM
REM Hot-reloads the frontend on save and rebuilds the Rust side automatically.
REM This console window is the app's parent process: closing the Envy window
REM ends the session, and closing this window kills the app. That is expected
REM for dev mode — use build.cmd if you want something that stands alone.

cd /d "%~dp0"
echo Starting Envy (dev)...
echo Close this window to stop.
echo.
call npm run tauri dev
if errorlevel 1 (
  echo.
  echo Envy exited with an error. Scroll up for the cause.
  pause
)
