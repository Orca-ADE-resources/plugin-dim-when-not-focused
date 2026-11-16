@echo off
rem Push the current source into the running Orca (no plugin reinstall, no Orca restart).
rem   scripts\run-local.bat            -> reapply (replace the running version)
rem   scripts\run-local.bat toggle     -> any command of scripts\dim.mjs
setlocal
set "CMD=%~1"
if "%CMD%"=="" set "CMD=reapply"
where node >nul 2>nul
if %errorlevel%==0 (
  node "%~dp0dim.mjs" %CMD% %2 %3 %4 %5 %6
) else (
  rem No Node on PATH: use the Node inside Orca.
  set "ELECTRON_RUN_AS_NODE=1"
  "%LOCALAPPDATA%\Programs\orca\Orca.exe" "%~dp0dim.mjs" %CMD% %2 %3 %4 %5 %6
)
