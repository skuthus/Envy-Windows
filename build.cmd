@echo off
REM Build a real, standalone Envy you can run without a terminal or a dev
REM server. Slower than dev.cmd (a release compile, several minutes the first
REM time) but the result is the actual app.
REM
REM Produces:
REM   target\release\envy-windows.exe            <- run this directly
REM   target\release\bundle\nsis\*-setup.exe     <- installer
REM   target\release\bundle\msi\*.msi            <- MSI installer
REM
REM The installers are unsigned, so Windows SmartScreen will warn on them.
REM That is expected until code signing is set up; running the .exe above
REM directly avoids the warning entirely.

cd /d "%~dp0"
echo Building Envy (release). This takes a few minutes the first time.
echo.
call npm run tauri build
if errorlevel 1 (
  echo.
  echo Build failed. Scroll up for the cause.
  pause
  exit /b 1
)
echo.
echo Done. Standalone app:
echo   %~dp0target\release\envy-windows.exe
echo.
pause
